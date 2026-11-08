//! Decodes the data of one entry in steps, through rawzip's verifying
//! reader.
//!
//! A step decodes only the bytes that the caller asks for, so a
//! preview of a multi-GB entry reads only its start. No buffer is sized from
//! a size in the archive.

use std::cell::Cell;
use std::io::Read;
use std::rc::Rc;

use rawzip::{ErrorKind, ReaderAt, ZipArchive};

use crate::directory::Located;
use crate::local::Record;

/// The methods that the read module decodes.
pub mod method {
    pub const STORED: u16 = 0;
    pub const DEFLATE: u16 = 8;
    /// The old id of Zstandard, from before APPNOTE 6.3.7.
    pub const ZSTD_OLD: u16 = 20;
    pub const ZSTD: u16 = 93;
}

/// True when the read module decodes the method.
#[must_use]
pub fn supported(method: u16) -> bool {
    matches!(
        method,
        method::STORED | method::DEFLATE | method::ZSTD | method::ZSTD_OLD
    )
}

/// Why a stream cannot start.
#[derive(Debug)]
pub enum OpenError {
    /// The entry is encrypted. Decryption comes later.
    Encrypted,
    /// The read module does not decode this method.
    Unsupported(u16),
    /// The local header or the data cannot be found.
    Archive(rawzip::Error),
    /// The decoder rejected the start of the data.
    Decode(String),
}

impl std::fmt::Display for OpenError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            OpenError::Encrypted => write!(f, "This entry is encrypted"),
            OpenError::Unsupported(method) => {
                write!(f, "Zipscope cannot decode compression method {method}")
            }
            OpenError::Archive(err) => write!(f, "The entry data cannot be found: {err}"),
            OpenError::Decode(message) => write!(f, "The entry data is not valid: {message}"),
        }
    }
}

impl std::error::Error for OpenError {}

/// Counts the bytes that a decoder gives to the verifying reader.
///
/// The verifying reader returns an error, not the count, on the read that
/// finds a wrong CRC-32. The decoded bytes of that read are in the buffer
/// all the same, so the stream uses this count to keep them. They show as
/// bytes that are not verified.
struct Counted<D> {
    inner: D,
    total: Rc<Cell<u64>>,
}

impl<D: Read> Read for Counted<D> {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        let read = self.inner.read(buf)?;
        self.total.set(self.total.get() + read as u64);
        Ok(read)
    }
}

/// The state of a stream.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Status {
    /// More bytes can follow.
    Reading,
    /// All bytes are decoded, and the size and the CRC-32 agree with the
    /// central directory.
    Verified,
    /// Decoding stopped with an error. The bytes before it stay valid as
    /// decoded bytes, but they are not verified.
    Failed(String),
}

/// The decoded data of one entry.
pub struct Stream {
    row: usize,
    produced: u64,
    declared: u64,
    status: Status,
    decoder: Box<dyn Read>,
    /// The bytes that the decoder gave to the verifying reader.
    counted: Rc<Cell<u64>>,
    /// The window limit of a Zstandard stream.
    window: Option<crate::zstd::WindowLimit>,
}

impl std::fmt::Debug for Stream {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Stream")
            .field("row", &self.row)
            .field("produced", &self.produced)
            .field("declared", &self.declared)
            .field("status", &self.status)
            .finish_non_exhaustive()
    }
}

/// Explains a decode error. The verifying reader puts a rawzip error in the
/// I/O error when the size or the CRC-32 is wrong.
fn explain(err: &std::io::Error, produced: u64) -> String {
    if let Some(inner) = err
        .get_ref()
        .and_then(|e| e.downcast_ref::<rawzip::Error>())
    {
        match inner.kind() {
            ErrorKind::InvalidSize { expected, actual } if actual < expected => {
                return format!(
                    "The data ended after {actual} bytes, but the central directory gives {expected} bytes"
                );
            }
            ErrorKind::InvalidSize { expected, .. } => {
                return format!(
                    "The data is longer than the {expected} bytes that the central directory gives"
                );
            }
            ErrorKind::InvalidChecksum { expected, actual } => {
                return format!(
                    "The CRC-32 of the data is {actual:08X}, but the central directory gives {expected:08X}"
                );
            }
            _ => {}
        }
    }
    format!("Decoding stopped after {produced} bytes: {err}")
}

impl Stream {
    /// Starts to decode a row.
    ///
    /// # Errors
    ///
    /// Returns an error for an encrypted entry, a method that the module does
    /// not decode, a local header that cannot be found or a bad start of
    /// the data.
    pub fn open<R: ReaderAt + 'static>(
        archive: &'static ZipArchive<R>,
        row: usize,
        located: Located,
        record: &Record,
    ) -> Result<Stream, OpenError> {
        Self::open_with_window(archive, row, located, record, crate::zstd::MAX_WINDOW_BYTES)
    }

    /// Starts to decode a row, with a Zstandard window of at most `window`
    /// bytes.
    ///
    /// # Errors
    ///
    /// As [`Stream::open`]. Also returns an error for a Zstandard entry when
    /// `window` is less than 1 KiB.
    pub fn open_with_window<R: ReaderAt + 'static>(
        archive: &'static ZipArchive<R>,
        row: usize,
        located: Located,
        record: &Record,
        window: u64,
    ) -> Result<Stream, OpenError> {
        if record.encrypted() {
            return Err(OpenError::Encrypted);
        }
        if !supported(record.method) {
            return Err(OpenError::Unsupported(record.method));
        }
        let entry = archive
            .get_entry(located.wayfinder)
            .map_err(OpenError::Archive)?;
        let raw = entry.reader();
        let mut zstd_limit = None;
        let counted = Rc::new(Cell::new(0));
        let total = Rc::clone(&counted);
        let decoder: Box<dyn Read> = match record.method {
            method::STORED => Box::new(entry.verifying_reader(Counted { inner: raw, total })),
            method::DEFLATE => Box::new(entry.verifying_reader(Counted {
                inner: flate2::read::DeflateDecoder::new(raw),
                total,
            })),
            _ => {
                let declared = located.wayfinder.uncompressed_size_hint();
                let limit = crate::zstd::WindowLimit::new(window);
                zstd_limit = Some(limit.clone());
                let zstd = crate::zstd::Decoder::with_limit(raw, declared, limit)
                    .map_err(|err| OpenError::Decode(err.to_string()))?;
                Box::new(entry.verifying_reader(Counted { inner: zstd, total }))
            }
        };
        Ok(Stream {
            row,
            produced: 0,
            declared: located.wayfinder.uncompressed_size_hint(),
            status: Status::Reading,
            decoder,
            counted,
            window: zstd_limit,
        })
    }

    /// Stops the stream because a buffer does not fit below the memory
    /// limit. The bytes before stay valid as decoded bytes.
    pub fn fail_for_memory(&mut self) {
        if self.status == Status::Reading {
            self.status = Status::Failed(crate::heap::limit_error().to_string());
        }
    }

    /// Starts a new call with the same window limit. A Zstandard stream
    /// allocates at most one new window in one call (see
    /// [`crate::zstd::WindowLimit`]).
    pub fn begin_call(&self) {
        if let Some(limit) = &self.window {
            limit.next_call();
        }
    }

    /// Sets the Zstandard window limit for the frames that start from now
    /// on. The read worker calls it before each read and skip, because the
    /// memory limit changes. A frame that started keeps its window.
    pub fn set_window_limit(&self, bytes: u64) {
        if let Some(limit) = &self.window {
            limit.set(bytes);
        }
    }

    /// The row of the stream.
    #[must_use]
    pub fn row(&self) -> usize {
        self.row
    }

    /// The bytes decoded so far.
    #[must_use]
    pub fn produced(&self) -> u64 {
        self.produced
    }

    #[must_use]
    pub fn status(&self) -> &Status {
        &self.status
    }

    /// Decodes up to `max` more bytes and adds them to `out`. Returns the
    /// bytes it added. The stream ends at the end of the data, or at an
    /// error.
    pub fn read(&mut self, out: &mut Vec<u8>, max: usize) -> usize {
        // Ask for no more than the declared rest, so that the buffer fits
        // the data and is not made smaller later, which copies it.
        let rest = usize::try_from(self.declared.saturating_sub(self.produced)).unwrap_or(max);
        let max = max.min(rest);
        let start = out.len();
        if out.try_reserve_exact(max).is_err() {
            self.fail_for_memory();
            return 0;
        }
        out.resize(start + max, 0);
        let mut filled = start;
        while self.status == Status::Reading {
            if self.produced >= self.declared {
                // Check the end at once, so that the caller knows that the
                // entry is complete.
                self.finish();
                break;
            }
            if filled == out.len() {
                break;
            }
            match self.decoder.read(&mut out[filled..]) {
                Ok(0) => {
                    // The verifier accepts an early end only when the size
                    // agrees, which it cannot here.
                    self.status = Status::Failed(format!(
                        "The data ended after {} bytes, but the central directory gives {} bytes",
                        self.produced, self.declared
                    ));
                }
                Ok(read) => {
                    filled += read;
                    self.produced += read as u64;
                }
                Err(err) if err.kind() == std::io::ErrorKind::Interrupted => {}
                // A frame waits for the next call (one new window per call).
                Err(err) if crate::zstd::is_pause(&err) => break,
                Err(err) => {
                    // A wrong size or CRC-32 at the end: the decoder put the
                    // bytes of this read in the buffer before the verifier
                    // found it. Keep them; the status says that they are
                    // not verified.
                    let room = out.len() - filled;
                    let kept = usize::try_from(self.counted.get().saturating_sub(self.produced))
                        .map_or(room, |kept| kept.min(room));
                    filled += kept;
                    self.produced += kept as u64;
                    self.status = Status::Failed(explain(&err, self.produced));
                }
            }
        }
        out.truncate(filled);
        filled - start
    }

    /// All declared bytes are decoded, and the verifier checked the CRC-32
    /// when it got to the declared size. One more read must find the end;
    /// more data is an error.
    fn finish(&mut self) {
        let mut probe = [0u8; 1];
        self.status = match self.decoder.read(&mut probe) {
            Ok(0) => Status::Verified,
            Ok(_) => Status::Failed(format!(
                "The data is longer than the {} bytes that the central directory gives",
                self.declared
            )),
            // A frame after the declared size waits for the next call.
            Err(err) if crate::zstd::is_pause(&err) => Status::Reading,
            Err(err) => Status::Failed(explain(&err, self.produced)),
        };
    }

    /// Decodes and drops `count` bytes. Returns the bytes it dropped.
    pub fn skip(&mut self, count: u64) -> u64 {
        let mut scratch = Vec::new();
        if scratch.try_reserve_exact(64 * 1024).is_err() {
            self.fail_for_memory();
            return 0;
        }
        let mut skipped = 0;
        while skipped < count && self.status == Status::Reading {
            scratch.clear();
            let step = usize::try_from((count - skipped).min(64 * 1024)).unwrap_or(64 * 1024);
            let read = self.read(&mut scratch, step);
            if read == 0 {
                break;
            }
            skipped += read as u64;
        }
        skipped
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::directory::Directory;
    use crate::local::read_record;
    use crate::testzip::{Entry, build};

    fn stream_of(entries: &[Entry], row: usize) -> Result<Stream, OpenError> {
        let data = build(entries);
        let size = data.len() as u64;
        let mut directory = Directory::open(data, size).unwrap();
        let located = directory.locate(row).unwrap();
        let record = read_record(directory.archive(), located).unwrap();
        Stream::open(directory.archive(), row, located, &record)
    }

    fn read_all(stream: &mut Stream) -> Vec<u8> {
        let mut out = Vec::new();
        while stream.read(&mut out, 1000) > 0 {}
        out
    }

    fn body(length: usize) -> Vec<u8> {
        (0..length).map(|i| b"abcdefghij\n"[i % 11]).collect()
    }

    #[test]
    fn decodes_each_method_and_verifies() {
        for entry in [
            Entry::stored("s.txt", body(5000)),
            Entry::deflated("d.txt", body(5000)),
            Entry::zstd("z.txt", body(5000)),
        ] {
            let mut stream = stream_of(&[entry], 0).unwrap();
            assert_eq!(read_all(&mut stream), body(5000));
            assert_eq!(stream.status(), &Status::Verified);
        }
    }

    #[test]
    fn reads_only_the_bytes_asked_for() {
        let mut stream = stream_of(&[Entry::deflated("d.txt", body(100_000))], 0).unwrap();
        let mut out = Vec::new();
        assert_eq!(stream.read(&mut out, 1024), 1024);
        assert_eq!(stream.status(), &Status::Reading);
        assert_eq!(out, body(1024));
        assert_eq!(stream.skip(1024), 1024);
        out.clear();
        stream.read(&mut out, 10);
        assert_eq!(out, body(2058)[2048..]);
    }

    #[test]
    fn marks_an_empty_entry_verified_at_once() {
        let mut stream = stream_of(&[Entry::stored("e.txt", Vec::new())], 0).unwrap();
        let mut out = Vec::new();
        assert_eq!(stream.read(&mut out, 100), 0);
        assert_eq!(stream.status(), &Status::Verified);
    }

    #[test]
    fn keeps_the_bytes_of_an_entry_with_a_wrong_crc() {
        // The verifier finds the wrong CRC-32 on the read that gets the
        // last bytes. The bytes stay, as bytes that are not verified.
        for make in [Entry::stored, Entry::deflated, Entry::zstd] {
            for length in [1, 1500, 5000] {
                let mut entry = make("bad.txt", body(length));
                entry.crc = Some(rawzip::crc32(&body(length)) ^ 1);
                let mut stream = stream_of(&[entry], 0).unwrap();
                let mut out = Vec::new();
                stream.read(&mut out, 1 << 20);
                assert_eq!(out, body(length));
                assert_eq!(stream.produced(), length as u64);
                assert!(
                    matches!(stream.status(), Status::Failed(message) if message.starts_with("The CRC-32 of the data is")),
                    "{:?}",
                    stream.status()
                );
                assert_eq!(stream.read(&mut out, 100), 0);
            }
        }
    }

    #[test]
    fn rejects_encrypted_and_unknown_methods() {
        let mut encrypted = Entry::stored("e.bin", body(10));
        encrypted.flags = 1;
        assert!(matches!(
            stream_of(&[encrypted], 0),
            Err(OpenError::Encrypted)
        ));
        let bzip = Entry::new("b.bin", 12, body(10));
        assert!(matches!(
            stream_of(&[bzip], 0),
            Err(OpenError::Unsupported(12))
        ));
    }
}
