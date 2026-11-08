//! The output of the remux, with rawzip's writer.
//!
//! The lead worker adds the entries in central-directory order. The data
//! of a file comes in parts from the pool, already compressed (or stored),
//! and the output goes out in parts, so the copy never sits in memory.
//!
//! The copy keeps the fields of each entry:
//!
//! - The name: its raw bytes (`EntryPath::verbatim`), and the UTF-8 flag
//!   (bit 11) of the archive.
//! - The comment, and the extra fields of the local header and of the
//!   central directory, each in its place, but the zip64 field: the
//!   writer makes it again for the new sizes and offsets.
//! - The DOS time and date, the version made by, and the internal and
//!   external attributes.
//!
//! rawzip's writer has no setting for the raw DOS time, the flags or the
//! attributes, and its time setting adds an extended timestamp field. Thus
//! the writer gets no time, and [`RemuxOut`] puts the fields of the
//! archive in the headers that the writer wrote: in the local header at
//! once, while it is still in the output buffer, and in the central
//! directory after `finish`. Each patch has a fixed place in a header of
//! the writer, which has a fixed layout.
//!
//! An entry of rawzip's writer borrows the archive writer. A file entry
//! stays open between parts, so [`RemuxOut`] keeps the archive writer on
//! the heap and the entry writer next to it, as `zipscope_read::zipout`
//! does (see the safety comments).

use std::cell::RefCell;
use std::io::Write;
use std::ptr::NonNull;
use std::rc::Rc;

use rawzip::extra_fields::ExtraFieldId;
use rawzip::path::EntryPath;
use rawzip::{CompressionMethod, DataDescriptorOutput, Header, ZipArchiveWriter};
use zipscope_heap::Room;

use crate::record::{
    LOCAL_FIXED_BYTES, RECORD_FIXED_BYTES, RawRecord, UTF8_FLAG, kept_bytes, kept_fields,
};

/// The most heap bytes that rawzip's writer keeps for each entry until the
/// central directory, without its name, comment and extra fields (see
/// `zipscope_read::zipout::RECORD_BYTES`).
const RECORD_BYTES: u64 = 256;
/// One patch for each entry.
const PATCH_BYTES: u64 = std::mem::size_of::<Patch>() as u64;
/// The central-directory record of one entry, without the variable part:
/// 46 bytes and a zip64 extra field of at most 28 bytes.
const DIRECTORY_RECORD_BYTES: u64 = RECORD_FIXED_BYTES as u64 + 28;
/// The end records: zip64 end record, locator and end record with the
/// archive comment.
const END_BYTES: u64 = 56 + 20 + 22 + u16::MAX as u64;
/// Room for the small allocations of one step.
const STEP_SLACK_BYTES: u64 = 64 * 1024;
/// The version needed for Zstandard (APPNOTE 4.4.3.2).
const ZSTD_VERSION: u16 = 63;

/// The output buffer. A write that does not fit below the memory cap
/// fails with an I/O error.
#[derive(Debug, Default, Clone)]
struct Sink(Rc<RefCell<Vec<u8>>>);

impl Write for Sink {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        let mut out = self.0.borrow_mut();
        out.try_reserve(buf.len())
            .map_err(|_full| zipscope_heap::limit_error())?;
        out.extend_from_slice(buf);
        Ok(buf.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

/// The fields of the archive that the patches put in the headers.
#[derive(Debug, Clone, Copy)]
struct Patch {
    made_by: u16,
    /// The least version needed, or 0 to keep the value of the writer.
    needed: u16,
    utf8: bool,
    time: u16,
    date: u16,
    internal: u16,
    external: u32,
}

impl Patch {
    fn of(record: &RawRecord<'_>, method: u16) -> Self {
        Patch {
            made_by: record.version_made_by(),
            needed: if method == crate::encode::ZSTD {
                ZSTD_VERSION
            } else {
                0
            },
            utf8: record.flags() & UTF8_FLAG != 0,
            time: record.dos_time(),
            date: record.dos_date(),
            internal: record.internal_attributes(),
            external: record.external_attributes(),
        }
    }
}

fn put16(bytes: &mut [u8], at: usize, value: u16) {
    bytes[at..at + 2].copy_from_slice(&value.to_le_bytes());
}

fn get16(bytes: &[u8], at: usize) -> u16 {
    u16::from_le_bytes([bytes[at], bytes[at + 1]])
}

fn flags(current: u16, utf8: bool) -> u16 {
    if utf8 {
        current | UTF8_FLAG
    } else {
        current & !UTF8_FLAG
    }
}

/// The error of a step.
fn failed(err: impl std::fmt::Display) -> String {
    format!("The copy could not be written: {err}")
}

fn room(bytes: u64) -> Result<(), String> {
    zipscope_heap::probe(usize::try_from(bytes).unwrap_or(usize::MAX)).map_err(failed)
}

/// The open file entry.
struct Open {
    entry: rawzip::ZipEntryWriter<'static, Sink>,
    crc32: u32,
    size: u64,
}

/// The copy that the lead worker writes in parts.
pub struct RemuxOut {
    // SAFETY invariant: `writer` comes from `Box::into_raw` and is freed
    // only in `finish` or `drop`. While `open` is `Some`, its entry writer
    // holds the only reference to `*writer`, and no other code makes a
    // reference to it. `open` is always cleared first.
    writer: Option<NonNull<ZipArchiveWriter<Sink>>>,
    open: Option<Open>,
    sink: Sink,
    /// The bytes of the sink that `take` gave.
    taken: usize,
    /// The output bytes that are not in the sink any more: the offset of
    /// the first byte of the sink.
    drained: u64,
    patches: Vec<Patch>,
    /// The bytes of all names, comments and extra fields so far.
    variable_bytes: u64,
}

impl std::fmt::Debug for RemuxOut {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("RemuxOut")
            .field("entries", &self.patches.len())
            .field("open", &self.open.is_some())
            .finish_non_exhaustive()
    }
}

impl RemuxOut {
    /// The most heap bytes of a copy with `entries` entries whose
    /// central-directory records have `directory_bytes` bytes in all: the
    /// records and the variable parts that the writer keeps (its buffers
    /// grow by doubling), the patches, and the central directory and the
    /// end records in the output buffer.
    #[must_use]
    pub fn estimate(entries: u64, directory_bytes: u64) -> u64 {
        entries
            .saturating_mul(RECORD_BYTES + PATCH_BYTES + DIRECTORY_RECORD_BYTES)
            .saturating_add(directory_bytes.saturating_mul(5))
            .saturating_add(END_BYTES + 4 * STEP_SLACK_BYTES)
    }

    /// Starts a copy.
    ///
    /// # Errors
    ///
    /// Returns an error when the memory limit leaves no room.
    pub fn new() -> Result<RemuxOut, String> {
        Self::with_offset(0)
    }

    /// As [`RemuxOut::new`], for a copy whose first byte is at `offset`
    /// of the output (only for tests of zip64 output).
    ///
    /// # Errors
    ///
    /// Returns an error when the memory limit leaves no room.
    pub fn with_offset(offset: u64) -> Result<RemuxOut, String> {
        room(STEP_SLACK_BYTES)?;
        let sink = Sink::default();
        let writer = ZipArchiveWriter::builder()
            .with_offset(offset)
            .build(sink.clone());
        Ok(RemuxOut {
            writer: Some(NonNull::from(Box::leak(Box::new(writer)))),
            open: None,
            sink,
            taken: 0,
            drained: offset,
            patches: Vec::new(),
            variable_bytes: 0,
        })
    }

    /// The archive writer, when no entry is open. The `'static` lifetime
    /// does not escape this struct: an entry writer that borrows it goes
    /// to `open`, which is cleared before the writer is freed.
    fn writer(&mut self) -> Result<&'static mut ZipArchiveWriter<Sink>, String> {
        if self.open.is_some() {
            return Err(failed("an entry is open"));
        }
        let mut pointer = self.writer.ok_or_else(|| failed("the copy is finished"))?;
        // SAFETY: no entry is open, so no other reference to the writer
        // exists (see the invariant on `RemuxOut`). The caller keeps the
        // reference only for one call, or in `open`.
        Ok(unsafe { pointer.as_mut() })
    }

    /// Makes sure of room for one more entry: its record and variable
    /// part in the writer, whose buffers grow by doubling, and its patch.
    fn entry_room(&mut self, record: &RawRecord<'_>, local_extra: &[u8]) -> Result<(), String> {
        let variable = (record.length() - RECORD_FIXED_BYTES + local_extra.len()) as u64;
        self.variable_bytes += variable;
        self.patches.room(1).map_err(failed)?;
        room(2 * self.variable_bytes.min(1 << 30) + 4 * variable + RECORD_BYTES + STEP_SLACK_BYTES)
    }

    /// The offset of the next byte of the output.
    fn offset(&self) -> u64 {
        self.drained + self.sink.0.borrow().len() as u64
    }

    /// True when the central extra fields of `record` have room for the
    /// zip64 field that the writer adds in `finish` for an entry at the
    /// next offset with `uncompressed` bytes and at most `compressed`
    /// bytes. Check before the entry starts: the writer fails only in
    /// `finish`, after all data.
    #[must_use]
    pub fn zip64_fits(&self, record: &RawRecord<'_>, uncompressed: u64, compressed: u64) -> bool {
        let limit = u64::from(u32::MAX);
        let values = [self.offset(), uncompressed, compressed]
            .iter()
            .filter(|value| **value >= limit)
            .count();
        let field = if values == 0 { 0 } else { 4 + 8 * values };
        u16::try_from(kept_bytes(record.extra()) + field).is_ok()
    }

    /// Puts the fields of the archive in the local header that starts at
    /// `offset` of the output.
    fn patch_local(&mut self, offset: u64, patch: Patch) -> Result<(), String> {
        let mut out = self.sink.0.borrow_mut();
        let at = usize::try_from(offset - self.drained).map_err(failed)?;
        let header = out
            .get_mut(at..at + LOCAL_FIXED_BYTES)
            .ok_or_else(|| failed("the local header is not in the buffer"))?;
        if patch.needed != 0 {
            let needed = get16(header, 4).max(patch.needed);
            put16(header, 4, needed);
        }
        let current = get16(header, 6);
        put16(header, 6, flags(current, patch.utf8));
        put16(header, 10, patch.time);
        put16(header, 12, patch.date);
        Ok(())
    }

    /// Adds a folder from its raw record and the extra fields of its local
    /// header.
    ///
    /// # Errors
    ///
    /// Returns an error when an entry is open, when the writer rejects the
    /// entry or when the memory limit leaves no room.
    pub fn add_folder(&mut self, record: &RawRecord<'_>, local_extra: &[u8]) -> Result<(), String> {
        self.entry_room(record, local_extra)?;
        let writer = self.writer()?;
        let offset = writer.stream_offset();
        let mut builder = writer
            .new_dir(EntryPath::verbatim(record.name()))
            .comment(record.comment());
        for (id, data) in kept_fields(local_extra) {
            builder = builder
                .extra_field(ExtraFieldId::new(id), data, Header::LOCAL)
                .map_err(failed)?;
        }
        for (id, data) in kept_fields(record.extra()) {
            builder = builder
                .extra_field(ExtraFieldId::new(id), data, Header::CENTRAL)
                .map_err(failed)?;
        }
        builder.create().map_err(failed)?;
        let patch = Patch::of(record, crate::encode::STORED);
        self.patch_local(offset, patch)?;
        self.patches.push(patch);
        Ok(())
    }

    /// Opens a file entry with the output method `method` (stored or
    /// Zstandard). Its data comes in [`RemuxOut::write`].
    ///
    /// # Errors
    ///
    /// Returns an error when an entry is open, when the writer rejects the
    /// entry or when the memory limit leaves no room.
    pub fn start_file(
        &mut self,
        record: &RawRecord<'_>,
        local_extra: &[u8],
        method: u16,
        crc32: u32,
        size: u64,
    ) -> Result<(), String> {
        self.entry_room(record, local_extra)?;
        let writer = self.writer()?;
        let offset = writer.stream_offset();
        let mut builder = writer
            .new_file(EntryPath::verbatim(record.name()))
            .compression_method(CompressionMethod::from(method))
            .comment(record.comment());
        for (id, data) in kept_fields(local_extra) {
            builder = builder
                .extra_field(ExtraFieldId::new(id), data, Header::LOCAL)
                .map_err(failed)?;
        }
        for (id, data) in kept_fields(record.extra()) {
            builder = builder
                .extra_field(ExtraFieldId::new(id), data, Header::CENTRAL)
                .map_err(failed)?;
        }
        let (entry, _config) = builder.start().map_err(failed)?;
        self.open = Some(Open { entry, crc32, size });
        let patch = Patch::of(record, method);
        self.patch_local(offset, patch)?;
        self.patches.push(patch);
        Ok(())
    }

    /// Writes a part of the data of the open file.
    ///
    /// # Errors
    ///
    /// Returns an error when no file is open or when the memory limit
    /// leaves no room. The copy is then not usable.
    pub fn write(&mut self, bytes: &[u8]) -> Result<(), String> {
        room(STEP_SLACK_BYTES)?;
        let open = self
            .open
            .as_mut()
            .ok_or_else(|| failed("no entry is open"))?;
        open.entry.write_all(bytes).map_err(failed)
    }

    /// Ends the open file with its verified CRC-32 and size.
    ///
    /// # Errors
    ///
    /// Returns an error when no file is open or when the memory limit
    /// leaves no room.
    pub fn end_file(&mut self) -> Result<(), String> {
        room(STEP_SLACK_BYTES)?;
        let open = self.open.take().ok_or_else(|| failed("no entry is open"))?;
        open.entry
            .finish(DataDescriptorOutput::new(open.crc32, open.size))
            .map(|_| ())
            .map_err(failed)
    }

    /// Writes the central directory with the archive comment, puts the
    /// fields of the archive in its records, and writes the end records.
    /// Take the output before: the sink then gets the central directory in
    /// one reservation.
    ///
    /// # Errors
    ///
    /// Returns an error when an entry is open or when the memory limit
    /// leaves no room.
    pub fn finish(&mut self, comment: &[u8]) -> Result<(), String> {
        if self.open.is_some() {
            return Err(failed("an entry is open"));
        }
        let entries = self.patches.len() as u64;
        let directory =
            entries * DIRECTORY_RECORD_BYTES + self.variable_bytes + END_BYTES + STEP_SLACK_BYTES;
        room(entries * 64 + STEP_SLACK_BYTES)?;
        self.reserve_output(directory)?;
        let pointer = self
            .writer
            .take()
            .ok_or_else(|| failed("the copy is finished"))?;
        // SAFETY: the pointer comes from `Box::into_raw` (`Box::leak`), no
        // entry is open, and `writer` is now `None`, so the box is freed
        // only here.
        let mut writer = unsafe { Box::from_raw(pointer.as_ptr()) };
        let start = writer.stream_offset();
        writer.set_comment(comment);
        (*writer).finish().map_err(failed)?;
        self.patch_directory(start)
    }

    /// Puts the fields of the archive in the records of the central
    /// directory that starts at `start` of the output.
    fn patch_directory(&mut self, start: u64) -> Result<(), String> {
        let mut out = self.sink.0.borrow_mut();
        let mut at = usize::try_from(start - self.drained).map_err(failed)?;
        for patch in &self.patches {
            let record = out
                .get_mut(at..at + RECORD_FIXED_BYTES)
                .ok_or_else(|| failed("a record is not in the buffer"))?;
            if record[..4] != crate::record::RECORD_SIGNATURE.to_le_bytes() {
                return Err(failed(
                    "the central directory is not as the writer writes it",
                ));
            }
            put16(record, 4, patch.made_by);
            if patch.needed != 0 {
                let needed = get16(record, 6).max(patch.needed);
                put16(record, 6, needed);
            }
            let current = get16(record, 8);
            put16(record, 8, flags(current, patch.utf8));
            put16(record, 12, patch.time);
            put16(record, 14, patch.date);
            put16(record, 36, patch.internal);
            record[38..42].copy_from_slice(&patch.external.to_le_bytes());
            at += RECORD_FIXED_BYTES
                + usize::from(get16(record, 28))
                + usize::from(get16(record, 30))
                + usize::from(get16(record, 32));
        }
        Ok(())
    }

    /// Drops the output that `take` gave and reserves room for `bytes`
    /// more.
    fn reserve_output(&mut self, bytes: u64) -> Result<(), String> {
        let mut out = self.sink.0.borrow_mut();
        out.drain(..self.taken);
        self.drained += self.taken as u64;
        self.taken = 0;
        out.try_reserve(usize::try_from(bytes).unwrap_or(usize::MAX))
            .map_err(|_full| failed(zipscope_heap::limit_error()))
    }

    /// Takes up to `max` bytes of the output.
    #[must_use]
    pub fn take(&mut self, max: usize) -> Vec<u8> {
        let mut out = self.sink.0.borrow_mut();
        let end = out.len().min(self.taken.saturating_add(max));
        let mut part = Vec::new();
        if part.try_reserve_exact(end - self.taken).is_err() {
            return part;
        }
        part.extend_from_slice(&out[self.taken..end]);
        self.taken = end;
        if self.taken == out.len() {
            self.drained += out.len() as u64;
            out.clear();
            self.taken = 0;
        }
        part
    }

    /// The output bytes that `take` did not give yet.
    #[must_use]
    pub fn pending(&self) -> usize {
        self.sink.0.borrow().len() - self.taken
    }

    /// The entries added so far.
    #[must_use]
    pub fn entries(&self) -> usize {
        self.patches.len()
    }
}

impl Drop for RemuxOut {
    fn drop(&mut self) {
        // The entry writer goes first: it borrows the archive writer.
        self.open = None;
        if let Some(pointer) = self.writer.take() {
            // SAFETY: the pointer comes from `Box::into_raw` (`Box::leak`),
            // and no entry is open, so no reference to it remains.
            drop(unsafe { Box::from_raw(pointer.as_ptr()) });
        }
    }
}
