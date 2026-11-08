//! The lead of the remux: it reads the central directory in order, gives
//! each file to the pool, and writes the copy in order.
//!
//! The lead keeps the entries that it read and did not write yet in a
//! queue. The front of the queue is the next entry of the copy.

use std::collections::VecDeque;
use std::io::Read;

use rawzip::{ReaderAt, ZipArchive, ZipEntries};
use zipscope_layout::end::{EndReader, open_end};
use zipscope_read::directory::ENTRIES_BUFFER_BYTES;
use zipscope_read::stream::supported;

use crate::encode::skip;
use crate::out::RemuxOut;
use crate::record::{LOCAL_FIXED_BYTES, RECORD_FIXED_BYTES, RawRecord, local_lengths};

/// What the copy does with an entry.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    /// A file: the pool decodes and compresses it.
    File,
    /// A folder entry: the lead writes it.
    Folder,
    /// The copy leaves it out. The value is a skip code.
    Skip(u8),
}

/// An entry that the lead read and did not write yet.
#[derive(Debug)]
pub struct Pending {
    pub kind: Kind,
    /// The raw central-directory record.
    pub record: Vec<u8>,
    /// The extra fields of the local header. Empty when the local header
    /// cannot be read; the pool then leaves the entry out.
    pub local_extra: Vec<u8>,
    /// The offset that rawzip adds to the local header offsets.
    pub base: u64,
    /// The local header offset, with `base`.
    pub offset: u64,
    pub crc32: u32,
    pub uncompressed: u64,
    pub compressed: u64,
}

/// Interim until rawzip has a resumable cursor, as in the core
/// and the read module: the iterator borrows the archive and its buffer,
/// so both are leaked. The worker stops after the remux, and the wasm
/// instance gives the memory back.
fn leak_entries<R: ReaderAt + 'static>(
    archive: ZipArchive<R>,
    buffer: Vec<u8>,
) -> (&'static ZipArchive<R>, ZipEntries<'static, 'static, R>) {
    let archive: &'static ZipArchive<R> = Box::leak(Box::new(archive));
    let buffer: &'static mut [u8] = Box::leak(buffer.into_boxed_slice());
    (archive, archive.entries(buffer))
}

fn read_error(err: impl std::fmt::Display) -> String {
    format!("The archive cannot be read: {err}")
}

/// The lead of one remux.
pub struct Lead<R: 'static> {
    /// The archive on the reader of the central directory.
    archive: &'static ZipArchive<EndReader<R>>,
    entries: ZipEntries<'static, 'static, EndReader<R>>,
    /// The reader of the local headers. The browser lead gives a reader with
    /// a window of its own here, so that the reads of the records and of the
    /// local headers do not replace one window for each row.
    locals: R,
    queue: VecDeque<Pending>,
    out: RemuxOut,
    records: u64,
    ended: bool,
}

impl<R> std::fmt::Debug for Lead<R> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Lead")
            .field("records", &self.records)
            .field("queue", &self.queue.len())
            .finish_non_exhaustive()
    }
}

impl<R: ReaderAt + 'static> Lead<R> {
    /// Finds the end of the central directory of the file and starts the
    /// copy.
    ///
    /// # Errors
    ///
    /// Returns an error when the file is not a zip archive or when the
    /// memory limit leaves no room.
    pub fn open(reader: R, size: u64) -> Result<Self, String>
    where
        R: Clone,
    {
        Self::with_out(reader, size, RemuxOut::new()?)
    }

    /// As [`Lead::open`], with one reader for the central directory
    /// (`records`) and one for the local headers (`locals`).
    ///
    /// # Errors
    ///
    /// As [`Lead::open`].
    pub fn open_split(records: R, locals: R, size: u64) -> Result<Self, String> {
        Self::build(records, locals, size, RemuxOut::new()?)
    }

    /// As [`Lead::open`], with the output `out` (only for tests).
    ///
    /// # Errors
    ///
    /// As [`Lead::open`].
    pub fn with_out(reader: R, size: u64, out: RemuxOut) -> Result<Self, String>
    where
        R: Clone,
    {
        Self::build(reader.clone(), reader, size, out)
    }

    fn build(records: R, locals: R, size: u64, out: RemuxOut) -> Result<Self, String> {
        let buffer =
            zipscope_heap::try_buffer(ENTRIES_BUFFER_BYTES).map_err(|err| err.to_string())?;
        let archive = open_end(records, size).map_err(read_error)?.archive;
        let (archive, entries) = leak_entries(archive, buffer);
        Ok(Lead {
            archive,
            entries,
            locals,
            queue: VecDeque::new(),
            out,
            records: 0,
            ended: false,
        })
    }

    /// The end record and the central directory that the walk chose. Tests
    /// compare them with the other workers.
    #[doc(hidden)]
    #[must_use]
    pub fn end_offsets(&self) -> (u64, u64) {
        (self.archive.eocd_offset(), self.archive.directory_offset())
    }

    /// The bytes of the central directory: from its start to the end
    /// records.
    #[must_use]
    pub fn directory_bytes(&self) -> u64 {
        self.archive
            .eocd_offset()
            .saturating_sub(self.archive.directory_offset())
    }

    /// Counts the records of the central directory, with a pass of its
    /// own.
    ///
    /// # Errors
    ///
    /// Returns an error when a record cannot be read or the memory limit
    /// leaves no room.
    pub fn count(&self) -> Result<usize, String> {
        let mut buffer =
            zipscope_heap::try_buffer(ENTRIES_BUFFER_BYTES).map_err(|err| err.to_string())?;
        let mut entries = self.archive.entries(&mut buffer);
        let mut count = 0;
        while entries.next_entry().map_err(read_error)?.is_some() {
            count += 1;
        }
        Ok(count)
    }

    /// The entry at `index` of the queue (0 is the next entry of the
    /// copy). Reads more records when the queue is shorter.
    ///
    /// # Errors
    ///
    /// Returns an error when the central directory has no such entry,
    /// when a record cannot be read or when the memory limit leaves no
    /// room.
    pub fn pending(&mut self, index: usize) -> Result<&Pending, String> {
        while self.queue.len() <= index {
            if !self.read_next()? {
                return Err("The central directory has fewer rows than the listing".to_string());
            }
        }
        Ok(&self.queue[index])
    }

    /// Reads the next record of the central directory and adds it to the
    /// queue. Returns false at the end of the central directory.
    fn read_next(&mut self) -> Result<bool, String> {
        if self.ended {
            return Ok(false);
        }
        self.queue.try_reserve(1).map_err(|_full| memory())?;
        let (at, offset, crc32, uncompressed, compressed) = match self.entries.next_entry() {
            Ok(Some(found)) => (
                found.central_directory_offset(),
                found.local_header_offset(),
                found.crc32(),
                found.uncompressed_size_hint(),
                found.compressed_size_hint(),
            ),
            Ok(None) => {
                self.ended = true;
                return Ok(false);
            }
            Err(err) => {
                self.ended = true;
                return Err(read_error(err));
            }
        };
        let reader = self.archive.get_ref();
        let mut fixed = [0u8; RECORD_FIXED_BYTES];
        reader.read_exact_at(&mut fixed, at).map_err(read_error)?;
        let mut record =
            zipscope_heap::try_buffer(RawRecord::length_of(&fixed)).map_err(read_error)?;
        reader.read_exact_at(&mut record, at).map_err(read_error)?;
        let parsed = RawRecord::parse(&record).map_err(read_error)?;
        let base = parsed
            .local_offset()
            .and_then(|raw| offset.checked_sub(raw));
        let flags = parsed.flags();
        let method = parsed.method();
        let kind = if base.is_none() {
            Kind::Skip(skip::LOCAL_HEADER)
        } else if parsed.name().last() == Some(&b'/') && uncompressed == 0 && crc32 == 0 {
            Kind::Folder
        } else if flags & 1 != 0 || method == 99 {
            Kind::Skip(skip::ENCRYPTED)
        } else if !supported(method) {
            Kind::Skip(skip::METHOD)
        } else {
            Kind::File
        };
        let local_extra = if kind == Kind::Skip(skip::LOCAL_HEADER) {
            Vec::new()
        } else {
            self.local_extra(offset)
        };
        self.records += 1;
        self.queue.push_back(Pending {
            kind,
            record,
            local_extra,
            base: base.unwrap_or(0),
            offset,
            crc32,
            uncompressed,
            compressed,
        });
        Ok(true)
    }

    /// The extra fields of the local header at `offset`, or nothing when
    /// it cannot be read.
    fn local_extra(&self, offset: u64) -> Vec<u8> {
        let reader = &self.locals;
        let mut fixed = [0u8; LOCAL_FIXED_BYTES];
        if reader.read_exact_at(&mut fixed, offset).is_err() {
            return Vec::new();
        }
        let Some((name, extra)) = local_lengths(&fixed) else {
            return Vec::new();
        };
        let Ok(mut bytes) = zipscope_heap::try_buffer(extra) else {
            return Vec::new();
        };
        let at = offset + (LOCAL_FIXED_BYTES + name) as u64;
        if reader.read_exact_at(&mut bytes, at).is_err() {
            return Vec::new();
        }
        bytes
    }

    /// The records read so far.
    #[must_use]
    pub fn records(&self) -> u64 {
        self.records
    }

    fn take_front(&mut self, kind: Kind) -> Result<Pending, String> {
        match self.queue.front() {
            Some(pending) if pending.kind == kind => {}
            _ => return Err("The next entry of the copy is not of this kind".to_string()),
        }
        self.queue
            .pop_front()
            .ok_or_else(|| "No entry is next".to_string())
    }

    /// Writes the next entry, a folder. False when its extra fields leave
    /// no room for the zip64 field of the copy; then nothing is written.
    ///
    /// # Errors
    ///
    /// Returns an error when the next entry is not a folder or the copy
    /// cannot write it.
    pub fn folder(&mut self) -> Result<bool, String> {
        let Some(pending) = self.queue.front() else {
            return Err("No entry is next".to_string());
        };
        if pending.kind != Kind::Folder {
            return Err("The next entry of the copy is not a folder".to_string());
        }
        let record = RawRecord::parse(&pending.record).map_err(read_error)?;
        if !self.out.zip64_fits(&record, 0, 0) {
            return Ok(false);
        }
        self.out.add_folder(&record, &pending.local_extra)?;
        self.queue.pop_front();
        Ok(true)
    }

    /// Opens the next entry, a file, with the output method `method`.
    /// False when its extra fields leave no room for the zip64 field of the
    /// copy; then nothing is written.
    ///
    /// # Errors
    ///
    /// Returns an error when the next entry is not a file or the copy
    /// cannot write it.
    pub fn begin_file(&mut self, method: u16) -> Result<bool, String> {
        let Some(pending) = self.queue.front() else {
            return Err("No entry is next".to_string());
        };
        if pending.kind != Kind::File {
            return Err("The next entry of the copy is not a file".to_string());
        }
        let record = RawRecord::parse(&pending.record).map_err(read_error)?;
        // The most compressed bytes of the copy: the bytes of the archive
        // for a raw copy, else the bound of Zstandard or the data stored.
        let largest = pending
            .compressed
            .max(pending.uncompressed + pending.uncompressed / 128 + (1 << 20));
        if !self.out.zip64_fits(&record, pending.uncompressed, largest) {
            return Ok(false);
        }
        self.out.start_file(
            &record,
            &pending.local_extra,
            method,
            pending.crc32,
            pending.uncompressed,
        )?;
        Ok(true)
    }

    /// Writes a part of the open file.
    ///
    /// # Errors
    ///
    /// Returns an error when the copy cannot write it.
    pub fn write(&mut self, bytes: &[u8]) -> Result<(), String> {
        self.out.write(bytes)
    }

    /// Ends the open file, the next entry, with the CRC-32 and the size of
    /// the central directory. The pool verified the data.
    ///
    /// # Errors
    ///
    /// Returns an error when no file is open.
    pub fn end_file(&mut self) -> Result<(), String> {
        self.out.end_file()?;
        self.take_front(Kind::File).map(drop)
    }

    /// Leaves the next entry out of the copy.
    pub fn skip(&mut self) {
        self.queue.pop_front();
    }

    /// Writes the central directory and the end records, with the archive
    /// comment.
    ///
    /// # Errors
    ///
    /// Returns an error when entries are not written yet or when the copy
    /// cannot write it.
    pub fn finish(&mut self) -> Result<(), String> {
        if !self.queue.is_empty() {
            return Err("Entries of the archive are not in the copy yet".to_string());
        }
        if self.read_next()? {
            self.queue.clear();
            return Err("The central directory has more rows than the listing".to_string());
        }
        let mut comment = Vec::new();
        self.archive
            .comment()
            .read_to_end(&mut comment)
            .map_err(read_error)?;
        self.out.finish(&comment)
    }

    /// Takes up to `max` bytes of the output.
    #[must_use]
    pub fn take(&mut self, max: usize) -> Vec<u8> {
        self.out.take(max)
    }

    /// The output bytes that `take` did not give yet.
    #[must_use]
    pub fn output_pending(&self) -> usize {
        self.out.pending()
    }

    /// The entries in the copy.
    #[must_use]
    pub fn written(&self) -> usize {
        self.out.entries()
    }
}

fn memory() -> String {
    zipscope_heap::limit_error().to_string()
}
