//! The byte map of an archive. It puts each byte of the file in
//! one region: the prelude, entry data, gaps, the central directory, the
//! zip64 end record and its locator, the end of central directory record
//! with the archive comment, and the epilogue.
//!
//! All values in the archive are untrusted. The map uses only `u64` math
//! that saturates or is checked, and it clamps each boundary to the
//! boundary before it. Thus the regions never overlap and always cover the
//! file from 0 to its size, also for a hostile archive.
//!
//! The end record, the zip64 records and the central directory come from
//! the archive end that rawzip found. The entry data comes from the local
//! header offset and the compressed size of each listed row, and from its
//! local header: the name and extra field lengths and a data descriptor
//! are only in the local part of the entry.
//!
//! The module `end` has the rule that chooses the end record for each worker,
//! because the map and the workers must use one record.

pub mod end;

use std::cmp::Reverse;
use std::collections::BinaryHeap;
use std::collections::TryReserveError;

use rawzip::{ReaderAt, ZipArchive};

const LOCAL_SIGNATURE: u32 = 0x0403_4b50;
const DESCRIPTOR_SIGNATURE: u32 = 0x0807_4b50;
const LOCATOR_SIGNATURE: u32 = 0x0706_4b50;
const ZIP64_SIGNATURE: u32 = 0x0606_4b50;
const END_SIGNATURE: u32 = 0x0605_4b50;
/// The fixed part of a local header.
pub const LOCAL_HEADER_BYTES: usize = 30;
/// The fixed part of the end of central directory record.
pub const END_RECORD_BYTES: usize = 22;
/// The zip64 end of central directory locator.
pub const LOCATOR_BYTES: usize = 20;
/// The fixed part of the zip64 end of central directory record.
const ZIP64_RECORD_BYTES: usize = 56;
/// The size field of the zip64 record does not count its first 12 bytes.
const ZIP64_SIZE_PREFIX: u64 = 12;
/// The most bytes of a data descriptor: signature, CRC-32 and two 8-byte
/// sizes.
const DESCRIPTOR_BYTES: usize = 24;
/// The most gaps that the map lists one by one. The map folds the other
/// gaps into the entry data regions round them and counts them there.
pub const MAX_LISTED_GAPS: usize = 256;
/// The bytes that the sniffer reads at the start of a region.
pub const SNIFF_BYTES: usize = 64;
/// The magic at the end of an APK signing block.
const APK_MAGIC: &[u8; 16] = b"APK Sig Block 42";

fn le16(bytes: &[u8], at: usize) -> u16 {
    u16::from_le_bytes([bytes[at], bytes[at + 1]])
}

fn le32(bytes: &[u8], at: usize) -> u32 {
    u32::from_le_bytes([bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]])
}

fn le64(bytes: &[u8], at: usize) -> u64 {
    let mut word = [0u8; 8];
    word.copy_from_slice(&bytes[at..at + 8]);
    u64::from_le_bytes(word)
}

/// Reads as many bytes as the file has at `offset`, up to `buffer.len()`.
/// Returns the count. A read error gives 0, because a short read and an
/// error have the same result for the map: the bytes are not known.
fn read_some<R: ReaderAt>(reader: &R, offset: u64, buffer: &mut [u8]) -> usize {
    let mut filled = 0;
    while filled < buffer.len() {
        let Some(at) = offset.checked_add(filled as u64) else {
            break;
        };
        match reader.read_at(&mut buffer[filled..], at) {
            Ok(0) | Err(_) => break,
            Ok(read) => filled += read,
        }
    }
    filled
}

/// The kind of a region. `RegionKind` in `web/src/contracts.ts` has the same codes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum Kind {
    /// Bytes before the first local header.
    Prelude = 0,
    /// Local headers, entry data and data descriptors of listed rows. Gaps
    /// that the map does not list one by one are in these regions and
    /// counted there.
    Entries = 1,
    /// Bytes after the first local header and before the central directory
    /// that no listed row uses.
    Gap = 2,
    /// The central directory, from its offset to the first end record.
    Directory = 3,
    Zip64Record = 4,
    Zip64Locator = 5,
    /// The end of central directory record and the archive comment.
    EndRecord = 6,
    /// Bytes after the archive comment.
    Epilogue = 7,
}

/// What the sniffer found at the start or the end of a region. `RegionLabel`
/// in `web/src/contracts.ts` has the same codes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum Label {
    None = 0,
    /// A Windows program (`MZ`), as in a self-extractor stub.
    WindowsProgram = 1,
    /// A Linux program (ELF), as in a self-extractor stub.
    LinuxProgram = 2,
    /// A macOS program (Mach-O), as in a self-extractor stub.
    MacProgram = 3,
    /// A shell script (`#!`), as in a self-extracting script.
    ShellScript = 4,
    /// An APK signing block before the central directory.
    ApkSigningBlock = 5,
    /// Only zero bytes in the sniffed part.
    Zeros = 6,
    /// A local header that no listed row points to.
    LocalHeader = 7,
    /// A central-directory record.
    DirectoryRecord = 8,
    /// An end of central directory record, as of another archive.
    EndRecord = 9,
}

/// Returns the label of a region from its first bytes, and from the last
/// 24 bytes when the region ends at the central directory.
#[must_use]
pub fn sniff(prefix: &[u8], apk_suffix: Option<&[u8]>) -> Label {
    if let Some(suffix) = apk_suffix
        && suffix.len() >= 24
        && &suffix[suffix.len() - 16..] == APK_MAGIC
    {
        return Label::ApkSigningBlock;
    }
    let starts = |magic: &[u8]| prefix.starts_with(magic);
    if starts(b"MZ") {
        Label::WindowsProgram
    } else if starts(b"\x7fELF") {
        Label::LinuxProgram
    } else if starts(&[0xcf, 0xfa, 0xed, 0xfe])
        || starts(&[0xce, 0xfa, 0xed, 0xfe])
        || starts(&[0xca, 0xfe, 0xba, 0xbe])
    {
        Label::MacProgram
    } else if starts(b"#!") {
        Label::ShellScript
    } else if starts(&LOCAL_SIGNATURE.to_le_bytes()) {
        Label::LocalHeader
    } else if starts(&0x0201_4b50u32.to_le_bytes()) {
        Label::DirectoryRecord
    } else if starts(&END_SIGNATURE.to_le_bytes()) {
        Label::EndRecord
    } else if !prefix.is_empty() && prefix.iter().all(|&byte| byte == 0) {
        Label::Zeros
    } else {
        Label::None
    }
}

/// The fields of the end of central directory record, as written.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct EndRecord {
    pub disk: u16,
    pub directory_disk: u16,
    pub disk_entries: u16,
    pub total_entries: u16,
    pub directory_size: u32,
    pub directory_offset: u32,
    pub comment_length: u16,
}

/// The zip64 end of central directory locator, as written.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Locator {
    /// Where the locator is in the file.
    pub offset: u64,
    pub disk: u32,
    pub record_offset: u64,
    pub total_disks: u32,
}

/// The fixed fields of the zip64 end of central directory record.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Zip64Record {
    /// Where the record is in the file.
    pub offset: u64,
    /// The size field: the record bytes after its first 12 bytes.
    pub size: u64,
    pub version_made_by: u16,
    pub version_needed: u16,
    pub disk: u32,
    pub directory_disk: u32,
    pub disk_entries: u64,
    pub total_entries: u64,
    pub directory_size: u64,
    pub directory_offset: u64,
}

/// How the archive uses zip64 at its end. `Zip64Use` in
/// `web/src/contracts.ts` has the same codes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum Zip64 {
    /// No zip64 locator before the end record.
    None = 0,
    /// The zip64 end record gives the central directory, as rawzip reads it.
    Used = 1,
    /// A zip64 locator is there, but rawzip does not use its record: the
    /// record is missing, has no signature or does not agree with the end
    /// record.
    Ignored = 2,
}

/// The facts of the archive end. They do not depend on the rows.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Facts {
    /// The file size.
    pub size: u64,
    /// The offset of the end of central directory record.
    pub end_record_offset: u64,
    /// The offset after the archive comment.
    pub end_offset: u64,
    /// The central-directory offset that rawzip uses.
    pub directory_offset: u64,
    /// The entry count that rawzip uses (a hint only).
    pub declared_entries: u64,
    pub end_record: EndRecord,
    pub zip64: Zip64,
    pub locator: Option<Locator>,
    pub record: Option<Zip64Record>,
    /// The raw bytes of the archive comment.
    pub comment: Vec<u8>,
}

impl Facts {
    /// Reads the records at the end of the archive that rawzip found.
    ///
    /// # Errors
    ///
    /// Returns an error when the allocator refuses the room for the comment.
    pub fn read<R: ReaderAt>(archive: &ZipArchive<R>, size: u64) -> Result<Facts, TryReserveError> {
        let reader = archive.get_ref();
        let end_record_offset = archive.eocd_offset();
        let mut fixed = [0u8; END_RECORD_BYTES];
        let end_record = if read_some(reader, end_record_offset, &mut fixed) == fixed.len()
            && le32(&fixed, 0) == END_SIGNATURE
        {
            EndRecord {
                disk: le16(&fixed, 4),
                directory_disk: le16(&fixed, 6),
                disk_entries: le16(&fixed, 8),
                total_entries: le16(&fixed, 10),
                directory_size: le32(&fixed, 12),
                directory_offset: le32(&fixed, 16),
                comment_length: le16(&fixed, 20),
            }
        } else {
            EndRecord::default()
        };
        // The end of a cut comment is past the end of the file (see `end`), so
        // the end offset stops at the end of the file.
        let end_offset = archive.end_offset().min(size).max(end_record_offset);
        let comment_start = end_record_offset
            .saturating_add(END_RECORD_BYTES as u64)
            .min(end_offset);
        // A comment is at most 65,535 bytes.
        let length = usize::try_from(end_offset - comment_start).unwrap_or(0);
        let mut comment = Vec::new();
        comment.try_reserve_exact(length)?;
        comment.resize(length, 0);
        let read = read_some(reader, comment_start, &mut comment);
        comment.truncate(read);

        let locator = read_locator(reader, end_record_offset);
        let record = locator.and_then(|locator| read_zip64_record(reader, locator.record_offset));
        let used = match (locator, record) {
            (Some(locator), Some(record)) => {
                consistent(&end_record, locator, &record)
                    && archive.directory_offset() == record.directory_offset
            }
            _ => false,
        };
        let zip64 = match (locator, used) {
            (None, _) => Zip64::None,
            (Some(_), true) => Zip64::Used,
            (Some(_), false) => Zip64::Ignored,
        };
        Ok(Facts {
            size,
            end_record_offset,
            end_offset,
            directory_offset: archive.directory_offset(),
            declared_entries: archive.entries_hint(),
            end_record,
            zip64,
            locator,
            record,
            comment,
        })
    }

    /// True when a disk field says that the archive has more than one
    /// disk (a spanned or split archive).
    #[must_use]
    pub fn spans_disks(&self) -> bool {
        let end = &self.end_record;
        let classic = end.disk != 0
            || end.directory_disk != 0
            || (end.disk_entries != end.total_entries
                && end.disk_entries != u16::MAX
                && end.total_entries != u16::MAX);
        let locator = self
            .locator
            .is_some_and(|locator| locator.disk != 0 || locator.total_disks > 1);
        let record = self.zip64 == Zip64::Used
            && self.record.is_some_and(|record| {
                record.disk != 0
                    || record.directory_disk != 0
                    || record.disk_entries != record.total_entries
            });
        classic || locator || record
    }

    /// The central-directory size that the archive declares, from the
    /// record that rawzip uses.
    #[must_use]
    pub fn declared_directory_size(&self) -> u64 {
        match (self.zip64, self.record) {
            (Zip64::Used, Some(record)) => record.directory_size,
            _ => u64::from(self.end_record.directory_size),
        }
    }

    /// The boundaries of the regions at the end of the file, in order:
    /// the central-directory start, the zip64 record start, the locator
    /// start and the end record start. Each one is clamped to the one after
    /// it, so they never go back.
    #[must_use]
    pub fn tail(&self) -> [u64; 4] {
        let end = self.end_record_offset;
        let (record, locator) = match (self.zip64, self.locator, self.record) {
            (Zip64::Used, Some(locator), Some(record)) => {
                let locator = locator.offset.min(end);
                (record.offset.min(locator), locator)
            }
            _ => (end, end),
        };
        [self.directory_offset.min(record), record, locator, end]
    }
}

fn read_locator<R: ReaderAt>(reader: &R, end_record_offset: u64) -> Option<Locator> {
    let offset = end_record_offset.checked_sub(LOCATOR_BYTES as u64)?;
    let mut bytes = [0u8; LOCATOR_BYTES];
    if read_some(reader, offset, &mut bytes) != bytes.len() || le32(&bytes, 0) != LOCATOR_SIGNATURE
    {
        return None;
    }
    Some(Locator {
        offset,
        disk: le32(&bytes, 4),
        record_offset: le64(&bytes, 8),
        total_disks: le32(&bytes, 16),
    })
}

fn read_zip64_record<R: ReaderAt>(reader: &R, offset: u64) -> Option<Zip64Record> {
    let mut bytes = [0u8; ZIP64_RECORD_BYTES];
    if read_some(reader, offset, &mut bytes) != bytes.len() || le32(&bytes, 0) != ZIP64_SIGNATURE {
        return None;
    }
    Some(Zip64Record {
        offset,
        size: le64(&bytes, 4),
        version_made_by: le16(&bytes, 12),
        version_needed: le16(&bytes, 14),
        disk: le32(&bytes, 16),
        directory_disk: le32(&bytes, 20),
        disk_entries: le64(&bytes, 24),
        total_entries: le64(&bytes, 32),
        directory_size: le64(&bytes, 40),
        directory_offset: le64(&bytes, 48),
    })
}

/// The rules of rawzip 0.5 for a zip64 record that it uses: the record
/// ends at the locator, and each field of the end record holds its
/// "see zip64" marker or the same value.
fn consistent(end: &EndRecord, locator: Locator, record: &Zip64Record) -> bool {
    let min_size = ZIP64_RECORD_BYTES as u64 - ZIP64_SIZE_PREFIX;
    let ends_at_locator = locator
        .record_offset
        .checked_add(ZIP64_SIZE_PREFIX)
        .and_then(|at| at.checked_add(record.size))
        == Some(locator.offset);
    record.size >= min_size
        && ends_at_locator
        && (end.disk_entries == u16::MAX || u64::from(end.disk_entries) == record.disk_entries)
        && (end.total_entries == u16::MAX || u64::from(end.total_entries) == record.total_entries)
        && (end.directory_size == u32::MAX
            || u64::from(end.directory_size) == record.directory_size)
        && (end.directory_offset == u32::MAX
            || u64::from(end.directory_offset) == record.directory_offset)
}

/// The values of one listed row that the map uses, from the central
/// directory.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct EntrySpan {
    pub local_header_offset: u64,
    pub compressed_size: u64,
    pub uncompressed_size: u64,
    pub crc32: u32,
    pub flags: u16,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
struct Extent {
    start: u64,
    end: u64,
}

/// One region of the map.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Region {
    pub kind: Kind,
    pub start: u64,
    pub end: u64,
    pub label: Label,
    /// For an entry data region: the gaps in it that the map does not list.
    pub folded_gaps: u64,
    pub folded_bytes: u64,
}

impl Region {
    fn new(kind: Kind, start: u64, end: u64) -> Region {
        Region {
            kind,
            start,
            end,
            label: Label::None,
            folded_gaps: 0,
            folded_bytes: 0,
        }
    }
}

/// Counts of the rows of the map.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Counts {
    /// Rows given to the map.
    pub rows: u64,
    /// Rows whose local header is missing, cut or has no signature. They
    /// use no bytes in the map.
    pub bad_headers: u64,
    /// Rows whose local header offset is at or after the start of the
    /// central directory. They use no bytes in the map.
    pub past_directory: u64,
    /// Rows whose data runs into the central directory. The map cuts them
    /// at its start.
    pub into_directory: u64,
    /// Rows that start before the end of an earlier row (in offset order).
    pub overlapping: u64,
    /// Rows with flag bit 3 whose data descriptor was not found.
    pub missing_descriptors: u64,
    /// All gaps, listed or not, and their bytes.
    pub gaps: u64,
    pub gap_bytes: u64,
    /// Rows whose central-directory record gives a start disk that is not
    /// 0 (a spanned archive). 0xffff, the zip64 marker, does not count.
    pub other_disk_rows: u64,
    /// Rows with a size or a local header offset of 0xffffffff or more:
    /// only a zip64 extra field can give such a value.
    pub zip64_rows: u64,
}

/// The finished map.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Layout {
    /// The regions in file order. They cover the file from 0 to its size,
    /// without overlap. Regions with no bytes are not in the list.
    pub regions: Vec<Region>,
    pub counts: Counts,
}

/// Makes the map from the rows, one row at a time.
#[derive(Debug)]
pub struct Builder {
    /// The start of the central directory, clamped (see `Facts::tail`).
    directory: u64,
    /// The offset of the next central-directory record, or `None` after a
    /// record that cannot be read. Rows are in record order.
    record: Option<u64>,
    extents: Vec<Extent>,
    sorted: bool,
    /// The smallest local header offset below the central directory, also
    /// of a row with a bad header. The prelude ends there, as in the health
    /// report.
    first: u64,
    counts: Counts,
    /// What rawzip adds to the local header offset of each row: the true
    /// offset of the central directory less its declared offset.
    added: u64,
}

impl Builder {
    #[must_use]
    pub fn new(facts: &Facts) -> Builder {
        let directory = facts.tail()[0];
        Builder {
            directory,
            record: Some(facts.directory_offset),
            extents: Vec::new(),
            sorted: true,
            first: directory,
            counts: Counts::default(),
            added: match facts.zip64 {
                Zip64::Used => 0,
                Zip64::None | Zip64::Ignored => facts
                    .directory_offset
                    .saturating_sub(u64::from(facts.end_record.directory_offset)),
            },
        }
    }

    /// Reserves room for `rows` more rows, so that `add` does not grow by
    /// doubling. Each row takes 16 bytes.
    ///
    /// # Errors
    ///
    /// Returns an error when the allocator refuses the room.
    pub fn reserve(&mut self, rows: usize) -> Result<(), TryReserveError> {
        self.extents.try_reserve_exact(rows)
    }

    /// The bytes that the rows take.
    #[must_use]
    pub fn allocated_bytes(&self) -> usize {
        self.extents.capacity() * size_of::<Extent>()
    }

    /// Adds one row. It reads the local header of the row with `reader`,
    /// its data descriptor when flag bit 3 is set, and the start disk of
    /// its central-directory record with `records`. Two readers keep the
    /// windows of the two parts of the file apart.
    ///
    /// # Errors
    ///
    /// Returns an error when the allocator refuses the room for the row.
    pub fn add<R: ReaderAt, D: ReaderAt>(
        &mut self,
        reader: &R,
        records: &D,
        span: EntrySpan,
    ) -> Result<(), TryReserveError> {
        self.counts.rows += 1;
        let record = self.next_record(records);
        // Rule (b): see `ZIP64_RULE`. A value of 0xffffffff or more can come
        // only from a zip64 field. rawzip adds `added` to the offset field,
        // and a row of an archive whose offsets wrap can be past 4 GiB with
        // no zip64 field.
        let marker = u64::from(u32::MAX);
        let mut zip64 = record.zip64
            || span.compressed_size >= marker
            || span.uncompressed_size >= marker
            || span.local_header_offset.saturating_sub(self.added) >= marker;
        let result = self.add_extent(reader, span, record, &mut zip64);
        if zip64 {
            self.counts.zip64_rows += 1;
        }
        result
    }

    /// Reads the local header of a row and adds its extent. Sets `zip64`
    /// when the local header shows zip64.
    fn add_extent<R: ReaderAt>(
        &mut self,
        reader: &R,
        span: EntrySpan,
        record: RecordFacts,
        zip64: &mut bool,
    ) -> Result<(), TryReserveError> {
        let start = span.local_header_offset;
        if start >= self.directory {
            self.counts.past_directory += 1;
            return Ok(());
        }
        self.first = self.first.min(start);
        let mut header = [0u8; LOCAL_HEADER_BYTES];
        if read_some(reader, start, &mut header) != header.len()
            || le32(&header, 0) != LOCAL_SIGNATURE
        {
            self.counts.bad_headers += 1;
            return Ok(());
        }
        let name = u64::from(le16(&header, 26));
        let extra = u64::from(le16(&header, 28));
        let local_markers = le32(&header, 18) == u32::MAX || le32(&header, 22) == u32::MAX;
        let local_field = find_field(
            reader,
            start.saturating_add(LOCAL_HEADER_BYTES as u64 + name),
            extra,
            ZIP64_FIELD,
        )
        .is_some();
        *zip64 |= local_markers || local_field;
        let data_end = start
            .saturating_add(LOCAL_HEADER_BYTES as u64 + name + extra)
            .saturating_add(span.compressed_size);
        let mut end = data_end;
        // Rule (a): see `DESCRIPTOR_RULE`.
        let wide = local_field || local_markers || record.size_markers;
        if span.flags & 0x08 != 0 && data_end < self.directory {
            match descriptor_length(reader, data_end, &span, wide) {
                Some(length) => end = data_end.saturating_add(length),
                None => self.counts.missing_descriptors += 1,
            }
        }
        if end > self.directory {
            self.counts.into_directory += 1;
        }
        let extent = Extent { start, end };
        if self.extents.last().is_some_and(|last| *last > extent) {
            self.sorted = false;
        }
        self.extents.try_reserve(1)?;
        self.extents.push(extent);
        Ok(())
    }

    /// Reads the fixed part of the next central-directory record: its start
    /// disk, its zip64 markers and fields, and its length.
    fn next_record<D: ReaderAt>(&mut self, records: &D) -> RecordFacts {
        let none = RecordFacts::default();
        let Some(at) = self.record else { return none };
        let mut fixed = [0u8; 46];
        if read_some(records, at, &mut fixed) != fixed.len() || le32(&fixed, 0) != 0x0201_4b50 {
            self.record = None;
            return none;
        }
        let name = u64::from(le16(&fixed, 28));
        let extra = u64::from(le16(&fixed, 30));
        let marker = |at: usize| le32(&fixed, at) == u32::MAX;
        let field = find_field(records, at.saturating_add(46 + name), extra, ZIP64_FIELD);
        let disk_marker = le16(&fixed, 34) == u16::MAX;
        let disk = if disk_marker {
            // The zip64 extra field holds the disk, after the 8-byte values
            // whose fields hold the marker: uncompressed size, compressed
            // size and local header offset, in that order. Without the field,
            // the disk stays 0xffff, as rawzip reads it.
            let skip = [24, 20, 42].iter().filter(|&&at| marker(at)).count() as u64 * 8;
            field
                .filter(|&(_, size)| skip + 4 <= size)
                .and_then(|(body, _)| {
                    let mut value = [0u8; 4];
                    (read_some(records, body + skip, &mut value) == value.len())
                        .then(|| u32::from_le_bytes(value))
                })
                .unwrap_or(u32::from(u16::MAX))
        } else {
            u32::from(le16(&fixed, 34))
        };
        if disk != 0 {
            self.counts.other_disk_rows += 1;
        }
        let variable = name + extra + u64::from(le16(&fixed, 32));
        self.record = at.checked_add(46 + variable);
        let size_markers = marker(20) || marker(24);
        RecordFacts {
            size_markers,
            zip64: size_markers || marker(42) || disk_marker || field.is_some(),
        }
    }

    /// Ends the map. `reader` reads the bytes for the sniffer.
    ///
    /// # Errors
    ///
    /// Returns an error when the allocator refuses the room for the regions.
    pub fn finish<R: ReaderAt>(
        mut self,
        reader: &R,
        facts: &Facts,
    ) -> Result<Layout, TryReserveError> {
        if !self.sorted {
            // In place: no allocation.
            self.extents.sort_unstable();
        }
        let directory = self.directory;
        let prelude_end = self.first.min(directory);
        // Pass 1: count all gaps, and keep the largest ones. The gap that
        // ends at the central directory is always listed: an APK signing
        // block is there.
        let mut largest: BinaryHeap<Reverse<(u64, Reverse<u64>)>> = BinaryHeap::new();
        largest.try_reserve_exact(MAX_LISTED_GAPS + 1)?;
        let mut last_gap = None;
        self.sweep(prelude_end, |gap_start, gap_end| {
            if gap_end == directory {
                last_gap = Some(gap_start);
                return;
            }
            largest.push(Reverse((gap_end - gap_start, Reverse(gap_start))));
            if largest.len() > MAX_LISTED_GAPS {
                largest.pop();
            }
        });
        let mut listed: Vec<u64> = Vec::new();
        listed.try_reserve_exact(largest.len() + 1)?;
        listed.extend(
            largest
                .into_iter()
                .map(|Reverse((_, Reverse(start)))| start),
        );
        listed.extend(last_gap);
        listed.sort_unstable();

        let mut regions: Vec<Region> = Vec::new();
        regions.try_reserve_exact(2 * listed.len() + 8)?;
        let push = |regions: &mut Vec<Region>, region: Region| {
            if region.end > region.start {
                regions.push(region);
            }
        };
        push(&mut regions, Region::new(Kind::Prelude, 0, prelude_end));
        // Pass 2: the listed gaps, and the entry data regions between them
        // with the gaps that are not listed.
        let mut counts = self.counts;
        let mut at = prelude_end;
        let mut folded = (0_u64, 0_u64);
        let mut next = listed.iter().copied().peekable();
        self.sweep(prelude_end, |gap_start, gap_end| {
            counts.gaps += 1;
            counts.gap_bytes += gap_end - gap_start;
            if next.peek() == Some(&gap_start) {
                next.next();
                let mut entries = Region::new(Kind::Entries, at, gap_start);
                (entries.folded_gaps, entries.folded_bytes) = folded;
                push(&mut regions, entries);
                push(&mut regions, Region::new(Kind::Gap, gap_start, gap_end));
                at = gap_end;
                folded = (0, 0);
            } else {
                folded.0 += 1;
                folded.1 += gap_end - gap_start;
            }
        });
        let mut entries = Region::new(Kind::Entries, at, directory);
        (entries.folded_gaps, entries.folded_bytes) = folded;
        push(&mut regions, entries);
        counts.overlapping = self.overlapping(prelude_end);

        let [directory_start, record, locator, end_record] = facts.tail();
        let end_offset = facts
            .end_offset
            .clamp(end_record, facts.size.max(end_record));
        push(
            &mut regions,
            Region::new(Kind::Directory, directory_start, record),
        );
        push(
            &mut regions,
            Region::new(Kind::Zip64Record, record, locator),
        );
        push(
            &mut regions,
            Region::new(Kind::Zip64Locator, locator, end_record),
        );
        push(
            &mut regions,
            Region::new(Kind::EndRecord, end_record, end_offset),
        );
        push(
            &mut regions,
            Region::new(Kind::Epilogue, end_offset, facts.size.max(end_offset)),
        );
        for region in &mut regions {
            if matches!(region.kind, Kind::Prelude | Kind::Gap | Kind::Epilogue) {
                region.label = sniff_region(reader, region, directory);
            }
        }
        Ok(Layout { regions, counts })
    }

    /// Calls `gap` with each gap in offset order: each part of
    /// `[prelude_end, directory)` that no row uses. Rows are cut at the
    /// central directory.
    fn sweep(&self, prelude_end: u64, mut gap: impl FnMut(u64, u64)) {
        let mut covered = prelude_end;
        for extent in &self.extents {
            if extent.start > covered {
                gap(covered, extent.start);
            }
            covered = covered.max(extent.end.min(self.directory));
        }
        if covered < self.directory {
            gap(covered, self.directory);
        }
    }

    /// Counts the rows that start before the end of an earlier row.
    fn overlapping(&self, prelude_end: u64) -> u64 {
        let mut covered = prelude_end;
        let mut count = 0;
        for extent in &self.extents {
            if extent.start < covered {
                count += 1;
            }
            covered = covered.max(extent.end.min(self.directory));
        }
        count
    }
}

/// Makes the map of an archive from its rows. `reader` reads the local
/// headers. Tools and tests use it; the read worker calls the steps
/// itself, with yields between them.
///
/// # Errors
///
/// Returns an error when the allocator refuses the room for the map.
pub fn map<A: ReaderAt, R: ReaderAt>(
    archive: &ZipArchive<A>,
    size: u64,
    reader: &R,
    rows: impl IntoIterator<Item = EntrySpan>,
) -> Result<(Facts, Layout), TryReserveError> {
    let facts = Facts::read(archive, size)?;
    let mut builder = Builder::new(&facts);
    for span in rows {
        builder.add(reader, reader, span)?;
    }
    let layout = builder.finish(reader, &facts)?;
    Ok((facts, layout))
}

impl Layout {
    /// Checks the rules of the map: the regions are in order, have bytes,
    /// do not overlap and cover the file from 0 to `size` without a gap;
    /// each kind is in its place; and the gap counts agree with the regions.
    ///
    /// # Errors
    ///
    /// Returns the first rule that the map breaks.
    pub fn validate(&self, size: u64) -> Result<(), String> {
        let mut at = 0_u64;
        let mut last = None;
        let mut gap_bytes = 0_u64;
        let mut gaps = 0_u64;
        for (index, region) in self.regions.iter().enumerate() {
            if region.start != at {
                return Err(format!(
                    "region {index} starts at {} after {at}",
                    region.start
                ));
            }
            if region.end <= region.start {
                return Err(format!("region {index} has no bytes"));
            }
            let order = |kind: Kind| match kind {
                Kind::Prelude => 0,
                Kind::Entries | Kind::Gap => 1,
                Kind::Directory => 2,
                Kind::Zip64Record => 3,
                Kind::Zip64Locator => 4,
                Kind::EndRecord => 5,
                Kind::Epilogue => 6,
            };
            if let Some(previous) = last {
                let (a, b) = (order(previous), order(region.kind));
                if b < a || (a == b && a != 1) {
                    return Err(format!(
                        "region {index} ({:?}) after {previous:?}",
                        region.kind
                    ));
                }
            }
            if region.kind == Kind::Gap {
                gaps += 1;
                gap_bytes += region.end - region.start;
            } else if region.folded_gaps > 0 || region.folded_bytes > 0 {
                if region.kind != Kind::Entries || region.folded_bytes >= region.end - region.start
                {
                    return Err(format!("region {index} folds gaps that do not fit"));
                }
                gaps += region.folded_gaps;
                gap_bytes += region.folded_bytes;
            }
            last = Some(region.kind);
            at = region.end;
        }
        if at != size {
            return Err(format!("the regions end at {at}, not at {size}"));
        }
        if gaps != self.counts.gaps || gap_bytes != self.counts.gap_bytes {
            return Err(format!(
                "{gaps} gaps of {gap_bytes} bytes in the regions, {} of {} counted",
                self.counts.gaps, self.counts.gap_bytes
            ));
        }
        let listed = self.regions.iter().filter(|r| r.kind == Kind::Gap).count();
        if listed > MAX_LISTED_GAPS + 1 {
            return Err(format!("{listed} gaps listed"));
        }
        Ok(())
    }
}

/// Entries, compressed bytes and uncompressed bytes of a group of rows.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Group {
    pub entries: u64,
    pub compressed: u64,
    pub uncompressed: u64,
}

impl Group {
    fn add(&mut self, compressed: u64, uncompressed: u64) {
        self.entries += 1;
        self.compressed = self.compressed.saturating_add(compressed);
        self.uncompressed = self.uncompressed.saturating_add(uncompressed);
    }
}

/// The totals of the rows, with three breakdowns.
///
/// The breakdowns are by the method of the central directory, by
/// encryption kind (the low 7 bits of the contract code) and by the
/// creating system (the high byte of "version made by"). The sums are
/// `u64` and saturate.
///
/// Each breakdown is a table with one slot for each code, so a hostile
/// archive with many codes needs no more memory than the first call
/// reserves.
#[derive(Debug, Default)]
pub struct Totals {
    pub all: Group,
    methods: Vec<Group>,
    encryption: Vec<Group>,
    systems: Vec<Group>,
}

impl Totals {
    /// Reserves the tables (about 1.5 MiB).
    ///
    /// # Errors
    ///
    /// Returns an error when the allocator refuses the room.
    pub fn new() -> Result<Totals, TryReserveError> {
        let table = |slots: usize| -> Result<Vec<Group>, TryReserveError> {
            let mut groups = Vec::new();
            groups.try_reserve_exact(slots)?;
            groups.resize(slots, Group::default());
            Ok(groups)
        };
        Ok(Totals {
            all: Group::default(),
            methods: table(1 << 16)?,
            encryption: table(1 << 7)?,
            systems: table(1 << 8)?,
        })
    }

    pub fn add(
        &mut self,
        compressed: u64,
        uncompressed: u64,
        method: u16,
        encryption: u8,
        version_made_by: u16,
    ) {
        self.all.add(compressed, uncompressed);
        self.methods[usize::from(method)].add(compressed, uncompressed);
        self.encryption[usize::from(encryption & 0x7f)].add(compressed, uncompressed);
        self.systems[usize::from(version_made_by >> 8)].add(compressed, uncompressed);
    }

    fn groups(table: &[Group]) -> impl Iterator<Item = (u16, Group)> + '_ {
        table
            .iter()
            .enumerate()
            .filter(|(_, group)| group.entries > 0)
            .map(|(key, group)| (u16::try_from(key).unwrap_or(u16::MAX), *group))
    }

    /// The groups by method that have rows, by code.
    pub fn methods(&self) -> impl Iterator<Item = (u16, Group)> + '_ {
        Self::groups(&self.methods)
    }

    /// The groups by encryption kind that have rows, by code.
    pub fn encryption(&self) -> impl Iterator<Item = (u16, Group)> + '_ {
        Self::groups(&self.encryption)
    }

    /// The groups by creating system that have rows, by code.
    pub fn systems(&self) -> impl Iterator<Item = (u16, Group)> + '_ {
        Self::groups(&self.systems)
    }
}

/// The id of the zip64 extended information extra field.
const ZIP64_FIELD: u16 = 1;

/// What the central-directory record of a row says about zip64.
#[derive(Debug, Clone, Copy, Default)]
struct RecordFacts {
    /// A size field holds the marker 0xffffffff.
    size_markers: bool,
    /// The record uses zip64: a size, offset or disk marker, or a zip64
    /// extra field.
    zip64: bool,
}

/// Rule (a): the width and the signature of a data descriptor.
///
/// APPNOTE 4.3.9: a descriptor has an optional signature 0x08074b50, the CRC-32
/// and the compressed and uncompressed sizes, 4 bytes each, or 8 bytes each
/// for a zip64 entry (4.3.9.2). There are four forms: 12, 16, 20 or 24
/// bytes. The map takes the first form in this order of tests:
///
/// 1. A form whose CRC-32 and both sizes agree with the central directory.
/// 2. A form whose CRC-32 agrees (a writer can write false sizes).
/// 3. With the signature bytes at the start, the signed form (a writer can
///    write a false CRC-32).
/// 4. Else no descriptor: its bytes, if any, show as a gap.
///
/// In each test, the forms come in this order: the width of the entry
/// first (8-byte sizes when the entry is "wide", see below, else 4-byte),
/// then the other width; for each width, signed then unsigned. Thus a CRC-32
/// that is the same as the signature cannot hide an unsigned descriptor:
/// the signed reading must also agree. Both readings can agree only for
/// bytes that are the same in both forms; then the order chooses.
///
/// An entry is wide when its local header has a zip64 extra field (4.3.9.2:
/// "if the zip64 extended information extra field is present for the
/// file"), or a size marker 0xffffffff in its local header or its
/// central-directory record.
pub const DESCRIPTOR_RULE: () = ();

/// Rule (b): "is this entry zip64".
///
/// APPNOTE 4.5.3. An entry uses zip64 when one of these is true:
///
/// - its central-directory record has the marker in a size field, in the
///   local header offset (0xffffffff) or in the start disk (0xffff);
/// - its central-directory record has a zip64 extra field (id 1), also
///   without a marker;
/// - its local header has the marker in a size field, or a zip64 extra
///   field (as Python `zipfile` writes with `force_zip64=True`);
/// - a resolved size or offset is 0xffffffff or more.
///
/// The archive uses zip64 when rawzip uses its zip64 end record, or when
/// an entry uses zip64 (`Counts::zip64_rows`).
pub const ZIP64_RULE: () = ();

/// Finds an extra field by id in the extra fields at `start` (`length`
/// bytes). Returns the offset and the size of its body, or `None` when it
/// is not there or does not fit in the extra fields.
fn find_field<R: ReaderAt>(reader: &R, start: u64, length: u64, id: u16) -> Option<(u64, u64)> {
    let end = start.checked_add(length)?;
    let mut at = start;
    while at.checked_add(4)? <= end {
        let mut head = [0u8; 4];
        if read_some(reader, at, &mut head) != head.len() {
            return None;
        }
        let size = u64::from(le16(&head, 2));
        let body = at + 4;
        if body + size > end {
            return None;
        }
        if le16(&head, 0) == id {
            return Some((body, size));
        }
        at = body + size;
    }
    None
}

/// Returns the length of the data descriptor at `offset`, or `None` when
/// it is not there, by `DESCRIPTOR_RULE`. `wide` is true for a zip64
/// entry.
fn descriptor_length<R: ReaderAt>(
    reader: &R,
    offset: u64,
    span: &EntrySpan,
    wide: bool,
) -> Option<u64> {
    let mut buffer = [0u8; DESCRIPTOR_BYTES];
    let read = read_some(reader, offset, &mut buffer);
    let bytes = &buffer[..read];
    let signature = bytes.len() >= 4 && le32(bytes, 0) == DESCRIPTOR_SIGNATURE;
    let widths = if wide { [true, false] } else { [false, true] };
    // The forms in the order of the rule: (signed, 8-byte sizes, length).
    let forms = widths.into_iter().flat_map(|large| {
        [true, false].map(|signed| {
            let base = if signed { 4 } else { 0 };
            (signed, large, base + if large { 20 } else { 12 })
        })
    });
    let crc = |signed: bool| {
        let at = if signed { 4 } else { 0 };
        le32(bytes, at) == span.crc32
    };
    let sizes = |signed: bool, large: bool| {
        let at = if signed { 8 } else { 4 };
        if large {
            le64(bytes, at) == span.compressed_size && le64(bytes, at + 8) == span.uncompressed_size
        } else {
            u64::from(le32(bytes, at)) == span.compressed_size
                && u64::from(le32(bytes, at + 4)) == span.uncompressed_size
        }
    };
    // A form needs all its bytes, and the signature when it is signed.
    let possible = |signed: bool, length: usize| bytes.len() >= length && (signature || !signed);
    let mut agree = forms
        .clone()
        .filter(|&(signed, _, length)| possible(signed, length));
    if let Some((_, _, length)) = agree
        .clone()
        .find(|&(signed, large, _)| crc(signed) && sizes(signed, large))
    {
        return Some(length as u64);
    }
    if let Some((_, _, length)) = agree.find(|&(signed, _, _)| crc(signed)) {
        return Some(length as u64);
    }
    let signed = if wide { 24 } else { 16 };
    (signature && bytes.len() >= signed).then_some(signed as u64)
}

fn sniff_region<R: ReaderAt>(reader: &R, region: &Region, directory: u64) -> Label {
    let length = region.end - region.start;
    let mut prefix = [0u8; SNIFF_BYTES];
    let take = usize::try_from(length.min(SNIFF_BYTES as u64)).unwrap_or(SNIFF_BYTES);
    let read = read_some(reader, region.start, &mut prefix[..take]);
    let mut suffix = [0u8; 24];
    let apk = if region.end == directory && length >= 32 {
        let read = read_some(reader, region.end - 24, &mut suffix);
        (read == suffix.len() && apk_block_fits(reader, &suffix, region)).then_some(&suffix[..])
    } else {
        None
    };
    sniff(&prefix[..read], apk)
}

/// True when the size field of an APK signing block before its magic gives
/// a block that starts in the region, and the size field at that start is
/// the same.
fn apk_block_fits<R: ReaderAt>(reader: &R, suffix: &[u8; 24], region: &Region) -> bool {
    let size = le64(suffix, 0);
    // The block is its size field (8 bytes) and `size` more bytes.
    let Some(start) = size
        .checked_add(8)
        .and_then(|bytes| region.end.checked_sub(bytes))
        .filter(|&start| start >= region.start)
    else {
        return false;
    };
    let mut head = [0u8; 8];
    read_some(reader, start, &mut head) == head.len() && u64::from_le_bytes(head) == size
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sniffs_the_common_prefixes() {
        assert_eq!(sniff(b"MZ\x90\0", None), Label::WindowsProgram);
        assert_eq!(sniff(b"\x7fELF\x02", None), Label::LinuxProgram);
        assert_eq!(sniff(&[0xcf, 0xfa, 0xed, 0xfe, 7], None), Label::MacProgram);
        assert_eq!(sniff(b"#!/bin/sh\n", None), Label::ShellScript);
        assert_eq!(sniff(b"PK\x03\x04", None), Label::LocalHeader);
        assert_eq!(sniff(b"PK\x01\x02", None), Label::DirectoryRecord);
        assert_eq!(sniff(b"PK\x05\x06", None), Label::EndRecord);
        assert_eq!(sniff(&[0; 12], None), Label::Zeros);
        assert_eq!(sniff(b"hello", None), Label::None);
        assert_eq!(sniff(b"", None), Label::None);
        let mut block = vec![0u8; 8];
        block.extend_from_slice(APK_MAGIC);
        assert_eq!(sniff(b"x", Some(&block)), Label::ApkSigningBlock);
    }

    #[test]
    fn extra_fields_are_found_only_inside_their_length() {
        let mut extra = Vec::new();
        extra.extend_from_slice(&0xcafe_u16.to_le_bytes());
        extra.extend_from_slice(&2u16.to_le_bytes());
        extra.extend_from_slice(b"xx");
        extra.extend_from_slice(&1u16.to_le_bytes());
        extra.extend_from_slice(&20u16.to_le_bytes());
        extra.extend_from_slice(&[0; 20]);
        let length = extra.len() as u64;
        assert_eq!(find_field(&extra, 0, length, 1), Some((10, 20)));
        assert_eq!(find_field(&extra, 0, length, 0xcafe), Some((4, 2)));
        assert_eq!(find_field(&extra, 0, length, 7), None);
        // A field that runs past the extra fields is not there.
        assert_eq!(find_field(&extra, 0, length - 1, 1), None);
        assert_eq!(find_field(&extra, 0, 0, 1), None);
    }

    #[test]
    fn a_descriptor_takes_the_form_that_agrees() {
        let span = EntrySpan {
            local_header_offset: 0,
            compressed_size: 5,
            uncompressed_size: 7,
            crc32: 0xdead_beef,
            flags: 8,
        };
        let mut signed = Vec::new();
        signed.extend_from_slice(&DESCRIPTOR_SIGNATURE.to_le_bytes());
        signed.extend_from_slice(&0xdead_beef_u32.to_le_bytes());
        signed.extend_from_slice(&5u32.to_le_bytes());
        signed.extend_from_slice(&7u32.to_le_bytes());
        signed.extend_from_slice(b"PK\x03\x04");
        assert_eq!(descriptor_length(&signed, 0, &span, false), Some(16));
        let mut large = Vec::new();
        large.extend_from_slice(&0xdead_beef_u32.to_le_bytes());
        large.extend_from_slice(&5u64.to_le_bytes());
        large.extend_from_slice(&7u64.to_le_bytes());
        // The 4-byte sizes read as 5 and 0, so only the 8-byte form agrees.
        assert_eq!(descriptor_length(&large, 0, &span, false), Some(20));
        assert_eq!(
            descriptor_length(&b"nothing here"[..].to_vec(), 0, &span, false),
            None
        );
        assert_eq!(descriptor_length(&Vec::new(), 0, &span, false), None);
        // An empty entry: both widths agree, and the zip64 markers choose.
        let empty = EntrySpan {
            compressed_size: 0,
            uncompressed_size: 0,
            ..span
        };
        let mut zeros = Vec::new();
        zeros.extend_from_slice(&DESCRIPTOR_SIGNATURE.to_le_bytes());
        zeros.extend_from_slice(&0xdead_beef_u32.to_le_bytes());
        zeros.extend_from_slice(&[0; 16]);
        assert_eq!(descriptor_length(&zeros, 0, &empty, true), Some(24));
        assert_eq!(descriptor_length(&zeros, 0, &empty, false), Some(16));
        // A false CRC-32 or false sizes: the zip64 markers choose too.
        let other = EntrySpan { crc32: 1, ..empty };
        assert_eq!(descriptor_length(&zeros, 0, &other, true), Some(24));
        assert_eq!(descriptor_length(&zeros, 0, &other, false), Some(16));
        let sizes = EntrySpan {
            compressed_size: 9,
            ..empty
        };
        assert_eq!(descriptor_length(&zeros, 0, &sizes, true), Some(24));
        assert_eq!(descriptor_length(&zeros, 0, &sizes, false), Some(16));
    }
}
