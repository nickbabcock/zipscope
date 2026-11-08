//! The zip of a folder, for a browser that cannot write a folder
//! (no `showDirectoryPicker`).
//!
//! The read worker writes the entries of the folder in steps with rawzip's
//! writer and gives each step's bytes to the download stream, so the zip
//! never sits in memory. Stored and deflate entries pass through
//! unchanged: their compressed bytes are copied, with the CRC-32 and the
//! size of the central directory. Zstandard entries are decoded and
//! stored uncompressed, because many unzip tools cannot read Zstandard.
//! The read worker verifies each entry with the verifying reader before
//! it adds the entry, so the zip has only entries whose data verified.
//!
//! An entry of rawzip's writer borrows the archive writer. A step ends
//! while an entry is open, so [`ZipOut`] keeps the archive writer on the
//! heap and the entry writer next to it (see the safety comments).
//!
//! Memory: the archive writer keeps one record and the name of each
//! entry until the central directory. The output of a step goes to a
//! buffer with fallible reservations, and the read worker takes it after
//! each step. [`ZipOut::estimate`] gives the most heap of a zip, so that
//! the read worker can grow the heap before it starts, in steps.

use std::cell::RefCell;
use std::io::{Read, Write};
use std::ptr::NonNull;
use std::rc::Rc;

use rawzip::time::UtcDateTime;
use rawzip::{CompressionMethod, DataDescriptorOutput, ZipArchiveWriter};

use crate::stream::{Status, Stream};

/// The most heap bytes that rawzip's writer keeps for each entry.
///
/// They stay until the central directory: the record (about 100 bytes)
/// and the zip64 extra field that `finish` can add, without the name. The
/// test `an_estimate_holds` in `tests/zip_heap.rs` measures it.
pub const RECORD_BYTES: u64 = 256;
/// The central-directory record of one entry, without the name: 46 bytes
/// and a zip64 extra field of at most 28 bytes.
const DIRECTORY_RECORD_BYTES: u64 = 46 + 28;
/// The end records: zip64 end record, locator and end record.
const END_BYTES: u64 = 56 + 20 + 22;
/// The buffer of one copy step.
const SCRATCH_BYTES: usize = 1 << 20;
/// Room for the small allocations of one step.
const STEP_SLACK_BYTES: u64 = 64 * 1024;

/// The output buffer. A write that does not fit below the memory cap
/// fails with an I/O error.
#[derive(Debug, Default, Clone)]
struct Sink(Rc<RefCell<Vec<u8>>>);

impl Write for Sink {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        let mut out = self.0.borrow_mut();
        out.try_reserve(buf.len())
            .map_err(|_full| crate::heap::limit_error())?;
        out.extend_from_slice(buf);
        Ok(buf.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

/// Where the bytes of the open entry come from.
enum Source {
    /// The compressed bytes, copied unchanged. `left` counts the bytes of
    /// the central directory that did not come yet.
    Raw { reader: Box<dyn Read>, left: u64 },
    /// The decoded bytes, stored.
    Decoded(Stream),
}

/// The open entry.
struct Open {
    entry: rawzip::ZipEntryWriter<'static, Sink>,
    source: Source,
    crc32: u32,
    size: u64,
}

/// The state after a step.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Step {
    /// The entry has more bytes.
    More,
    /// The entry is complete.
    Done,
}

/// How to add an entry.
pub enum Data {
    /// Copy the compressed bytes with their method.
    Raw {
        reader: Box<dyn Read>,
        method: u16,
        compressed: u64,
    },
    /// Store the decoded bytes of a stream.
    Decoded(Stream),
}

impl std::fmt::Debug for Data {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Data::Raw { method, .. } => write!(f, "Data::Raw({method})"),
            Data::Decoded(stream) => write!(f, "Data::Decoded({stream:?})"),
        }
    }
}

/// A zip that the read worker writes in steps.
pub struct ZipOut {
    // SAFETY invariant: `writer` comes from `Box::into_raw` and is freed
    // only in `finish` or `drop`. While `open` is `Some`, its entry writer
    // holds the only reference to `*writer`, and no other code makes a
    // reference to it. `open` is always cleared first.
    writer: Option<NonNull<ZipArchiveWriter<Sink>>>,
    open: Option<Open>,
    sink: Sink,
    /// The bytes of the sink that `take` gave.
    taken: usize,
    scratch: Vec<u8>,
    /// The bytes of all names so far, for the room of the name buffer.
    name_bytes: u64,
    entries: u64,
}

impl std::fmt::Debug for ZipOut {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ZipOut")
            .field("entries", &self.entries)
            .field("open", &self.open.is_some())
            .finish_non_exhaustive()
    }
}

/// The error of a step.
fn failed(err: impl std::fmt::Display) -> String {
    format!("The zip could not be written: {err}")
}

fn room(bytes: u64) -> Result<(), String> {
    crate::heap::probe(usize::try_from(bytes).unwrap_or(usize::MAX)).map_err(failed)
}

impl ZipOut {
    /// The most heap bytes of a zip with `entries` entries and
    /// `name_bytes` bytes of names: the records of the writer, the name
    /// buffer (it grows by doubling, so up to four times the names while
    /// it moves), the central directory in the sink and the buffers of a
    /// step.
    #[must_use]
    pub fn estimate(entries: u64, name_bytes: u64) -> u64 {
        entries.saturating_mul(RECORD_BYTES + DIRECTORY_RECORD_BYTES)
            + name_bytes.saturating_mul(5)
            + END_BYTES
            + 2 * SCRATCH_BYTES as u64
            + 4 * STEP_SLACK_BYTES
    }

    /// Starts a zip with room for the records of `capacity` entries.
    ///
    /// # Errors
    ///
    /// Returns an error when the memory limit leaves no room.
    pub fn new(capacity: u64) -> Result<ZipOut, String> {
        Self::with_offset(capacity, 0)
    }

    /// As [`ZipOut::new`], for a zip whose first byte is at `offset` of
    /// the output (only for tests of zip64 output).
    ///
    /// # Errors
    ///
    /// Returns an error when the memory limit leaves no room.
    pub fn with_offset(capacity: u64, offset: u64) -> Result<ZipOut, String> {
        room(capacity.saturating_mul(RECORD_BYTES) + STEP_SLACK_BYTES)?;
        let scratch = crate::heap::try_buffer(SCRATCH_BYTES).map_err(failed)?;
        let sink = Sink::default();
        let writer = ZipArchiveWriter::builder()
            .with_capacity(usize::try_from(capacity).unwrap_or(0))
            .with_offset(offset)
            .build(sink.clone());
        Ok(ZipOut {
            writer: Some(NonNull::from(Box::leak(Box::new(writer)))),
            open: None,
            sink,
            taken: 0,
            scratch,
            name_bytes: 0,
            entries: 0,
        })
    }

    /// The archive writer, when no entry is open.
    fn writer(&mut self) -> Result<&mut ZipArchiveWriter<Sink>, String> {
        if self.open.is_some() {
            return Err(failed("an entry is open"));
        }
        let mut writer = self.writer.ok_or_else(|| failed("the zip is finished"))?;
        // SAFETY: no entry is open, so no other reference to the writer
        // exists (see the invariant on `ZipOut`), and the borrow of `self`
        // keeps it unique for its lifetime.
        Ok(unsafe { writer.as_mut() })
    }

    /// Makes sure of room for one more name in the name buffer of the
    /// writer, which grows by doubling.
    fn name_room(&mut self, path: &str) -> Result<(), String> {
        self.name_bytes += path.len() as u64;
        self.entries += 1;
        room(4 * self.name_bytes + RECORD_BYTES + STEP_SLACK_BYTES)
    }

    /// Adds a folder. `path` ends with `/`.
    ///
    /// # Errors
    ///
    /// Returns an error when an entry is open, when the writer rejects the
    /// path or when the memory limit leaves no room.
    pub fn add_folder(&mut self, path: &str, modified: Option<UtcDateTime>) -> Result<(), String> {
        self.name_room(path)?;
        let writer = self.writer()?;
        let mut builder = writer.new_dir(path);
        if let Some(time) = modified {
            builder = builder.last_modified(time);
        }
        builder.create().map(|_| ()).map_err(failed)
    }

    /// Opens a file entry with its verified CRC-32 and size. The data
    /// comes in later steps.
    ///
    /// # Errors
    ///
    /// Returns an error when an entry is open, when the writer rejects the
    /// path or when the memory limit leaves no room.
    pub fn add_file(
        &mut self,
        path: &str,
        data: Data,
        crc32: u32,
        size: u64,
        modified: Option<UtcDateTime>,
    ) -> Result<(), String> {
        self.name_room(path)?;
        if self.open.is_some() {
            return Err(failed("an entry is open"));
        }
        let mut pointer = self.writer.ok_or_else(|| failed("the zip is finished"))?;
        // SAFETY: no entry is open, so this is the only reference to the
        // writer. The entry writer keeps it until `open` is cleared, and
        // the box is freed only after that (see the invariant on
        // `ZipOut`). The `'static` lifetime does not escape this struct.
        let writer: &'static mut ZipArchiveWriter<Sink> = unsafe { pointer.as_mut() };
        let (method, source) = match data {
            Data::Raw {
                reader,
                method,
                compressed,
            } => (
                CompressionMethod::from(method),
                Source::Raw {
                    reader,
                    left: compressed,
                },
            ),
            Data::Decoded(stream) => (CompressionMethod::STORE, Source::Decoded(stream)),
        };
        let mut builder = writer.new_file(path).compression_method(method);
        if let Some(time) = modified {
            builder = builder.last_modified(time);
        }
        let (entry, _config) = builder.start().map_err(failed)?;
        self.open = Some(Open {
            entry,
            source,
            crc32,
            size,
        });
        Ok(())
    }

    /// Writes up to `max` more bytes of the open entry. A Zstandard frame
    /// that starts in this step can have a window of at most `window`
    /// bytes. Ends the entry when its data ends.
    ///
    /// # Errors
    ///
    /// Returns an error when no entry is open, when the data does not end
    /// as the central directory gives, when the decoder fails or when the
    /// memory limit leaves no room. The zip is then not usable.
    pub fn step(&mut self, max: usize, window: u64) -> Result<Step, String> {
        room(STEP_SLACK_BYTES)?;
        let open = self
            .open
            .as_mut()
            .ok_or_else(|| failed("no entry is open"))?;
        self.sink
            .0
            .borrow_mut()
            .try_reserve(max.min(SCRATCH_BYTES * 16) + 1024)
            .map_err(|_full| failed(crate::heap::limit_error()))?;
        let mut moved = 0;
        let ended = loop {
            if moved >= max {
                break false;
            }
            let want = (max - moved).min(SCRATCH_BYTES);
            let read = match &mut open.source {
                Source::Raw { reader, left } => {
                    if *left == 0 {
                        break true;
                    }
                    let want = want.min(usize::try_from(*left).unwrap_or(want));
                    let read = reader.read(&mut self.scratch[..want]).map_err(failed)?;
                    if read == 0 {
                        return Err(failed(format!(
                            "the compressed data ended {} bytes early",
                            *left
                        )));
                    }
                    *left -= read as u64;
                    read
                }
                Source::Decoded(stream) => {
                    stream.set_window_limit(window);
                    self.scratch.clear();
                    let read = stream.read(&mut self.scratch, want);
                    match stream.status() {
                        Status::Failed(message) => return Err(failed(message)),
                        Status::Verified if read == 0 => break true,
                        _ => {}
                    }
                    if read == 0 {
                        // A Zstandard frame waits for the next step.
                        break false;
                    }
                    read
                }
            };
            open.entry
                .write_all(&self.scratch[..read])
                .map_err(failed)?;
            moved += read;
        };
        if self.scratch.len() < SCRATCH_BYTES {
            self.scratch.resize(SCRATCH_BYTES, 0);
        }
        if !ended {
            return Ok(Step::More);
        }
        let Some(open) = self.open.take() else {
            return Err(failed("no entry is open"));
        };
        open.entry
            .finish(DataDescriptorOutput::new(open.crc32, open.size))
            .map_err(failed)?;
        Ok(Step::Done)
    }

    /// Writes the central directory and the end records. Take the output
    /// before: the sink then gets the central directory in one
    /// reservation.
    ///
    /// # Errors
    ///
    /// Returns an error when an entry is open or when the memory limit
    /// leaves no room.
    pub fn finish(&mut self) -> Result<(), String> {
        if self.open.is_some() {
            return Err(failed("an entry is open"));
        }
        let pointer = self
            .writer
            .take()
            .ok_or_else(|| failed("the zip is finished"))?;
        // SAFETY: the pointer comes from `Box::into_raw` (`Box::leak`), no
        // entry is open, and `writer` is now `None`, so the box is freed
        // only here.
        let writer = unsafe { Box::from_raw(pointer.as_ptr()) };
        let directory =
            self.entries * DIRECTORY_RECORD_BYTES + self.name_bytes + END_BYTES + STEP_SLACK_BYTES;
        room(self.entries * 64 + STEP_SLACK_BYTES)?;
        self.reserve_output(directory)?;
        (*writer).finish().map(|_| ()).map_err(failed)
    }

    /// Drops the output that `take` gave and reserves room for `bytes`
    /// more.
    fn reserve_output(&mut self, bytes: u64) -> Result<(), String> {
        let mut out = self.sink.0.borrow_mut();
        out.drain(..self.taken);
        self.taken = 0;
        out.try_reserve(usize::try_from(bytes).unwrap_or(usize::MAX))
            .map_err(|_full| failed(crate::heap::limit_error()))
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
    pub fn entries(&self) -> u64 {
        self.entries
    }
}

impl Drop for ZipOut {
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

/// The modified time of the mirrors (milliseconds since 1970, `NaN` when
/// none) as a time for the writer.
#[must_use]
#[expect(
    clippy::cast_possible_truncation,
    reason = "A time in seconds is far below the i64 range; rawzip saturates it."
)]
pub fn modified_time(milliseconds: f64) -> Option<UtcDateTime> {
    milliseconds
        .is_finite()
        .then(|| UtcDateTime::from_unix((milliseconds / 1000.0).floor() as i64))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::directory::Directory;
    use crate::local::read_record;
    use crate::testzip::{Entry, build};

    fn body(length: usize) -> Vec<u8> {
        (0..length).map(|i| b"zip out test\n"[i % 13]).collect()
    }

    /// Copies all entries of `data` into a new zip (raw or decoded) and
    /// returns its bytes.
    fn copy(data: Vec<u8>, decode: bool, step: usize) -> Vec<u8> {
        let size = data.len() as u64;
        let mut directory = Directory::open(data, size).unwrap();
        directory.scan(u32::MAX);
        let rows = directory.rows();
        let mut out = ZipOut::new(rows as u64).unwrap();
        let mut bytes = Vec::new();
        for row in 0..rows {
            let located = directory.locate(row).unwrap();
            let record = read_record(directory.archive(), located).unwrap();
            let name = String::from_utf8(record.name.clone()).unwrap();
            let wayfinder = located.wayfinder;
            let data = if decode {
                Data::Decoded(Stream::open(directory.archive(), row, located, &record).unwrap())
            } else {
                let entry = directory.archive().get_entry(wayfinder).unwrap();
                Data::Raw {
                    reader: Box::new(entry.reader()),
                    method: record.method,
                    compressed: wayfinder.compressed_size_hint(),
                }
            };
            out.add_file(
                &name,
                data,
                record.crc32,
                wayfinder.uncompressed_size_hint(),
                modified_time(1_700_000_000_000.0),
            )
            .unwrap();
            while out.step(step, 1 << 25).unwrap() == Step::More {
                bytes.extend(out.take(usize::MAX));
            }
            bytes.extend(out.take(usize::MAX));
        }
        out.add_folder("empty/", None).unwrap();
        out.finish().unwrap();
        while out.pending() > 0 {
            bytes.extend(out.take(7));
        }
        bytes
    }

    /// Reads each entry of a zip with rawzip's verifying reader.
    fn read_back(zip: &[u8]) -> Vec<(String, u16, Vec<u8>)> {
        let archive = rawzip::ZipArchive::from_slice(zip).unwrap();
        let mut entries = archive.entries();
        let mut found = Vec::new();
        while let Some(record) = entries.next_entry().unwrap() {
            let name = String::from_utf8(record.file_path().as_ref().to_vec()).unwrap();
            let method = record.compression_method().as_u16();
            let entry = archive.get_entry(record.wayfinder()).unwrap();
            let mut data = Vec::new();
            match method {
                0 => {
                    entry
                        .verifying_reader(entry.data())
                        .read_to_end(&mut data)
                        .unwrap();
                }
                8 => {
                    let inflate = flate2::read::DeflateDecoder::new(entry.data());
                    entry
                        .verifying_reader(inflate)
                        .read_to_end(&mut data)
                        .unwrap();
                }
                _ => panic!("unexpected method {method}"),
            }
            found.push((name, method, data));
        }
        found
    }

    fn source() -> Vec<u8> {
        build(&[
            Entry::stored("s.txt", body(70_000)),
            Entry::deflated("d/e.txt", body(300_000)),
            Entry::zstd("z.txt", body(5000)),
            Entry::stored("empty.txt", Vec::new()),
        ])
    }

    #[test]
    fn passes_stored_and_deflate_through_and_verifies() {
        // Zstandard is not copied raw here: rawzip's test reader cannot
        // decode it, so this test copies only the first two entries.
        let data = build(&[
            Entry::stored("s.txt", body(70_000)),
            Entry::deflated("d/e.txt", body(300_000)),
        ]);
        let zip = copy(data, false, 4096);
        let found = read_back(&zip);
        assert_eq!(found[0], ("s.txt".into(), 0, body(70_000)));
        assert_eq!(found[1], ("d/e.txt".into(), 8, body(300_000)));
        assert_eq!(found[2].0, "empty/");
    }

    #[test]
    fn stores_decoded_entries() {
        let found = read_back(&copy(source(), true, 10_000));
        assert_eq!(found.len(), 5);
        assert_eq!(found[2], ("z.txt".into(), 0, body(5000)));
        assert_eq!(found[3], ("empty.txt".into(), 0, Vec::new()));
        assert!(found.iter().take(4).all(|(_, method, _)| *method == 0));
    }

    #[test]
    fn a_short_raw_entry_fails() {
        let data = build(&[Entry::stored("s.txt", body(1000))]);
        let size = data.len() as u64;
        let mut directory = Directory::open(data, size).unwrap();
        let located = directory.locate(0).unwrap();
        let mut out = ZipOut::new(1).unwrap();
        out.add_file(
            "s.txt",
            Data::Raw {
                reader: Box::new(std::io::Cursor::new(vec![0u8; 10])),
                method: 0,
                compressed: located.wayfinder.compressed_size_hint(),
            },
            0,
            1000,
            None,
        )
        .unwrap();
        let err = out.step(1 << 20, 0).unwrap_err();
        assert!(err.contains("ended"), "{err}");
    }

    #[test]
    fn writes_zip64_records_past_4_gib() {
        let mut out = ZipOut::with_offset(1, 5 << 30).unwrap();
        out.add_file(
            "a.txt",
            Data::Raw {
                reader: Box::new(std::io::Cursor::new(b"hello".to_vec())),
                method: 0,
                compressed: 5,
            },
            rawzip::crc32(b"hello"),
            5,
            None,
        )
        .unwrap();
        assert_eq!(out.step(100, 0).unwrap(), Step::Done);
        out.finish().unwrap();
        let tail = out.take(usize::MAX);
        // The zip64 end record and its locator come before the end record.
        let find = |signature: u32| {
            tail.windows(4)
                .any(|window| window == signature.to_le_bytes())
        };
        assert!(find(0x0606_4b50) && find(0x0706_4b50) && find(0x0605_4b50));
    }

    #[test]
    fn dropping_an_open_zip_frees_it() {
        let mut out = ZipOut::new(4).unwrap();
        out.add_file(
            "a",
            Data::Raw {
                reader: Box::new(std::io::Cursor::new(vec![1, 2, 3])),
                method: 0,
                compressed: 3,
            },
            0,
            3,
            None,
        )
        .unwrap();
        drop(out);
    }
}
