//! The local header check.
//!
//! The central directory is the source of truth. A local header that does not
//! agree with it gives a second name, size, CRC-32 or method for one entry. This
//! is a sign of a hostile archive.

use rawzip::{ReaderAt, ZipArchive};

use crate::directory::Located;

/// Bits of `LocalCheck::mismatches`.
pub mod mismatch {
    /// The local name is not the central-directory name.
    pub const NAME: u32 = 1;
    /// The local sizes are not the central-directory sizes. Not checked when
    /// a data descriptor holds the sizes.
    pub const SIZES: u32 = 1 << 1;
    /// The local CRC-32 is not the central-directory CRC-32. Not checked
    /// when a data descriptor holds it.
    pub const CRC: u32 = 1 << 2;
    /// The local method is not the central-directory method.
    pub const METHOD: u32 = 1 << 3;
}

/// The fixed part of a central-directory record.
const RECORD_BYTES: usize = 46;
const RECORD_SIGNATURE: u32 = 0x0201_4b50;
/// The bytes that one read of a record asks for: the fixed part and a name
/// of at most 256 bytes. Thus a record with a usual name costs one read.
const RECORD_READ_BYTES: usize = RECORD_BYTES + 256;
/// A local name and extra field are at most 65,535 bytes each.
const LOCAL_VARIABLE_BYTES: usize = 2 * u16::MAX as usize;

/// Fields of the central-directory record of a row, read again at preview
/// time.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Record {
    pub flags: u16,
    pub method: u16,
    pub crc32: u32,
    pub name: Vec<u8>,
}

impl Record {
    /// True when the entry is encrypted (`ZipCrypto`, AES or strong
    /// encryption).
    #[must_use]
    pub fn encrypted(&self) -> bool {
        self.flags & 1 != 0 || self.method == 99
    }

    /// True when a data descriptor after the data holds the CRC-32 and the
    /// sizes.
    #[must_use]
    pub fn has_data_descriptor(&self) -> bool {
        self.flags & 0x08 != 0
    }
}

/// The result of the local header check.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LocalCheck {
    /// `mismatch` bits. 0 when the local header agrees.
    pub mismatches: u32,
    /// The raw name in the local header.
    pub local_name: Vec<u8>,
    pub record: Record,
}

fn le16(bytes: &[u8], at: usize) -> u16 {
    u16::from_le_bytes([bytes[at], bytes[at + 1]])
}

fn le32(bytes: &[u8], at: usize) -> u32 {
    u32::from_le_bytes([bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]])
}

/// Reads the central-directory record of a row again, through the reader of
/// the archive.
///
/// # Errors
///
/// Returns an error if the read fails or the record has no signature.
pub fn read_record<R: ReaderAt>(
    archive: &ZipArchive<R>,
    located: Located,
) -> Result<Record, rawzip::Error> {
    read_record_from(archive.get_ref(), located)
}

/// Reads the central-directory record of a row again: its flags, method and
/// raw name. The table keeps only the record offset, to keep the table
/// small.
///
/// `reader` can be a reader that is not the reader of the archive: the read
/// worker keeps its window for the local headers and the data.
///
/// # Errors
///
/// Returns an error if the read fails or the record has no signature.
pub fn read_record_from<R: ReaderAt>(
    reader: &R,
    located: Located,
) -> Result<Record, rawzip::Error> {
    let mut head = [0u8; RECORD_READ_BYTES];
    let mut filled = 0;
    // A read can stop early, at the end of a window or of the file.
    while filled < RECORD_BYTES {
        let read = reader.read_at(&mut head[filled..], located.record_offset + filled as u64)?;
        if read == 0 {
            return Err(rawzip::Error::from(std::io::Error::from(
                std::io::ErrorKind::UnexpectedEof,
            )));
        }
        filled += read;
    }
    if le32(&head, 0) != RECORD_SIGNATURE {
        return Err(rawzip::Error::from(rawzip::ErrorKind::InvalidSignature {
            expected: RECORD_SIGNATURE,
            actual: le32(&head, 0),
        }));
    }
    let mut name = vec![0u8; usize::from(le16(&head, 28))];
    let copied = name.len().min(filled - RECORD_BYTES);
    name[..copied].copy_from_slice(&head[RECORD_BYTES..RECORD_BYTES + copied]);
    reader.read_exact_at(
        &mut name[copied..],
        located.record_offset + (RECORD_BYTES + copied) as u64,
    )?;
    Ok(Record {
        flags: le16(&head, 8),
        method: le16(&head, 10),
        crc32: le32(&head, 16),
        name,
    })
}

/// Compares the local header of a row with its central-directory record.
///
/// # Errors
///
/// Returns an error if a read fails or the local header has no signature.
pub fn check<R: ReaderAt>(
    archive: &ZipArchive<R>,
    located: Located,
) -> Result<LocalCheck, rawzip::Error> {
    let record = read_record(archive, located)?;
    check_record(archive, located, record)
}

/// As [`check`], for a record that the caller read.
///
/// # Errors
///
/// Returns an error if a read fails or the local header has no signature.
pub fn check_record<R: ReaderAt>(
    archive: &ZipArchive<R>,
    located: Located,
    record: Record,
) -> Result<LocalCheck, rawzip::Error> {
    let entry = archive.get_entry(located.wayfinder)?;
    let mut buffer = vec![0u8; LOCAL_VARIABLE_BYTES];
    let local = entry.local_header(&mut buffer)?;
    let mut mismatches = 0;
    let local_name = local.file_path().as_ref().to_vec();
    if local_name != record.name {
        mismatches |= mismatch::NAME;
    }
    if local.compression_method().as_u16() != record.method {
        mismatches |= mismatch::METHOD;
    }
    // With a data descriptor, the local header can hold zeros. The
    // descriptor and the central directory then give the values.
    if !record.has_data_descriptor() {
        let wayfinder = located.wayfinder;
        if local.compressed_size_hint() != wayfinder.compressed_size_hint()
            || local.uncompressed_size_hint() != wayfinder.uncompressed_size_hint()
        {
            mismatches |= mismatch::SIZES;
        }
        if local.crc32() != record.crc32 {
            mismatches |= mismatch::CRC;
        }
    }
    Ok(LocalCheck {
        mismatches,
        local_name,
        record,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::directory::Directory;
    use crate::testzip::{Entry, build};

    fn check_first(entry: Entry) -> Result<LocalCheck, rawzip::Error> {
        let data = build(&[entry]);
        let size = data.len() as u64;
        let mut directory = Directory::open(data, size).unwrap();
        let located = directory.locate(0).unwrap();
        check(directory.archive(), located)
    }

    #[test]
    fn agrees_for_a_true_archive() {
        let result =
            check_first(Entry::deflated("a/b.txt", b"hello hello hello".to_vec())).unwrap();
        assert_eq!(result.mismatches, 0);
        assert_eq!(result.local_name, b"a/b.txt");
        assert_eq!(result.record.method, 8);
    }

    #[test]
    fn flags_a_different_local_name() {
        let mut entry = Entry::stored("report.pdf", b"data".to_vec());
        entry.local_name = Some(b"payload.exe".to_vec());
        let result = check_first(entry).unwrap();
        assert_eq!(result.mismatches, mismatch::NAME);
        assert_eq!(result.local_name, b"payload.exe");
        assert_eq!(result.record.name, b"report.pdf");
    }

    #[test]
    fn flags_different_local_sizes_crc_and_method() {
        let mut entry = Entry::stored("a.txt", b"abcdef".to_vec());
        entry.local_uncompressed = Some(1);
        entry.local_crc = Some(7);
        entry.local_method = Some(8);
        let result = check_first(entry).unwrap();
        assert_eq!(
            result.mismatches,
            mismatch::SIZES | mismatch::CRC | mismatch::METHOD
        );
    }

    #[test]
    fn skips_sizes_and_crc_with_a_data_descriptor() {
        let mut entry = Entry::stored("a.txt", b"abcdef".to_vec());
        entry.flags = 0x08;
        entry.local_uncompressed = Some(0);
        entry.local_compressed = Some(0);
        entry.local_crc = Some(0);
        assert_eq!(check_first(entry).unwrap().mismatches, 0);
    }

    #[test]
    fn rejects_a_local_header_without_a_signature() {
        let mut entry = Entry::stored("a.txt", b"abcdef".to_vec());
        // The central directory points into the data of nothing.
        entry.offset = Some(10);
        check_first(entry).unwrap_err();
    }

    /// A reader that gives at most `step` bytes for each read, and counts the
    /// reads.
    struct Short {
        data: Vec<u8>,
        step: usize,
        reads: std::cell::Cell<usize>,
    }

    impl ReaderAt for Short {
        fn read_at(&self, buf: &mut [u8], offset: u64) -> std::io::Result<usize> {
            self.reads.set(self.reads.get() + 1);
            let at = usize::try_from(offset).unwrap().min(self.data.len());
            let count = buf.len().min(self.step).min(self.data.len() - at);
            buf[..count].copy_from_slice(&self.data[at..at + count]);
            Ok(count)
        }
    }

    fn record_of(name: &str) -> (Vec<u8>, Located) {
        let data = build(&[Entry::stored(name, b"abcdef".to_vec())]);
        let size = data.len() as u64;
        let mut directory = Directory::open(data.clone(), size).unwrap();
        directory.scan(1);
        let located = directory.locate(0).unwrap();
        (data, located)
    }

    #[test]
    fn a_record_with_a_usual_name_costs_one_read() {
        let (data, located) = record_of("a/b.txt");
        let reader = Short {
            data,
            step: usize::MAX,
            reads: std::cell::Cell::new(0),
        };
        let record = read_record_from(&reader, located).unwrap();
        assert_eq!(record.name, b"a/b.txt");
        assert_eq!(reader.reads.get(), 1);
    }

    #[test]
    fn a_long_name_reads_its_last_bytes_from_the_file() {
        for length in [255, 256, 257, 1000, 65_535] {
            let name = "n".repeat(length);
            let (data, located) = record_of(&name);
            let reader = Short {
                data,
                step: usize::MAX,
                reads: std::cell::Cell::new(0),
            };
            let record = read_record_from(&reader, located).unwrap();
            assert_eq!(record.name, name.as_bytes());
            assert_eq!(reader.reads.get(), if length <= 256 { 1 } else { 2 });
        }
    }

    #[test]
    fn a_read_that_stops_early_gives_the_same_record() {
        for step in [1, 7, 46, 47] {
            let (data, located) = record_of("a/b.txt");
            let reader = Short {
                data,
                step,
                reads: std::cell::Cell::new(0),
            };
            assert_eq!(read_record_from(&reader, located).unwrap().name, b"a/b.txt");
        }
    }

    #[test]
    fn a_file_that_ends_in_a_record_gives_an_error() {
        let (mut data, located) = record_of("a/b.txt");
        let offset = usize::try_from(located.record_offset).unwrap();
        for keep in [offset, offset + 45, offset + 46, offset + 52] {
            data.truncate(keep);
            let reader = Short {
                data: data.clone(),
                step: usize::MAX,
                reads: std::cell::Cell::new(0),
            };
            read_record_from(&reader, located).unwrap_err();
        }
    }

    #[test]
    fn rejects_an_offset_past_the_end() {
        let mut entry = Entry::stored("a.txt", b"abcdef".to_vec());
        entry.offset = Some(u64::from(u32::MAX - 1));
        check_first(entry).unwrap_err();
    }
}
