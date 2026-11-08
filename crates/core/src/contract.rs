//! The shared-memory layout and the values that the web code must repeat.
//! `web/src/contracts.ts` has the same values and describes the protocols.
//! `values` lists them for the test that compares the two sides.

/// The version of the shared-memory layout.
pub const LAYOUT_VERSION: u32 = 3;

/// Rows in one column page.
pub const PAGE_ROWS: usize = 1 << 16;

/// The number of bits for the position in an arena chunk.
pub const CHUNK_BITS: u32 = 22;

/// Bytes in one arena chunk (4 MiB).
pub const CHUNK_BYTES: usize = 1 << CHUNK_BITS;

/// The maximum number of chunks in one arena. A `u32` offset holds the chunk
/// index in its high 10 bits.
pub const MAX_CHUNKS: usize = 1 << (32 - CHUNK_BITS);

/// The size of the buffer for central-directory records. One record can be
/// 46 + 3 × 65,535 bytes, which is more than the 64 KiB rawzip default.
pub const ENTRIES_BUFFER_BYTES: usize = 256 * 1024;
const _: () = assert!(ENTRIES_BUFFER_BYTES >= rawzip::MAX_CENTRAL_DIRECTORY_RECORD_SIZE);

/// An absent folder id or row in the folder table: the parent of the root
/// and the explicit row of an implied folder.
pub const NONE: u32 = u32::MAX;

/// The value of `TREE_ORDER_n` for a tree in the order that the parser first
/// saw the folders.
pub const TREE_ORDER_ARCHIVE: u32 = 0;
/// The value of `TREE_ORDER_n` for a tree in name order.
pub const TREE_ORDER_NAME: u32 = 1;

/// The bit of `LISTING_SORT_n` for a descending sort.
pub const SORT_DESCENDING: u32 = 0x100;

/// Bit 31 of a tagged index. When it is set, bits 0 to 30 are a folder id.
/// If not, the value is an entry row.
pub const FOLDER_TAG: u32 = 1 << 31;

/// Bytes in one folder table record.
pub const FOLDER_RECORD_BYTES: usize = 16;

/// Bytes in one rollup record.
pub const ROLLUP_RECORD_BYTES: usize = 24;

/// `u32` words in one flattened tree record.
pub const TREE_RECORD_WORDS: usize = 4;

/// The most largest files below a folder in one view set.
pub const LARGEST_FILES: usize = 10;

/// Values of the header `STATE` field.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u32)]
pub enum State {
    Opening = 0,
    Parsing = 1,
    Complete = 2,
    Cancelled = 3,
    Failed = 4,
    Paused = 5,
}

/// The columns of a page, in page order. The values are column ids.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u32)]
pub enum Column {
    UncompressedSize = 0,
    CompressedSize = 1,
    LocalHeaderOffset = 2,
    Modified = 3,
    NameOffset = 4,
    NameLength = 5,
    CommentOffset = 6,
    CommentLength = 7,
    Crc32 = 8,
    ExternalAttributes = 9,
    Method = 10,
    Flags = 11,
    VersionMadeBy = 12,
    AesMethod = 13,
    NameSource = 14,
    TimeKind = 15,
    Encryption = 16,
    Marks = 17,
}

impl Column {
    pub const ALL: [Column; 18] = [
        Column::UncompressedSize,
        Column::CompressedSize,
        Column::LocalHeaderOffset,
        Column::Modified,
        Column::NameOffset,
        Column::NameLength,
        Column::CommentOffset,
        Column::CommentLength,
        Column::Crc32,
        Column::ExternalAttributes,
        Column::Method,
        Column::Flags,
        Column::VersionMadeBy,
        Column::AesMethod,
        Column::NameSource,
        Column::TimeKind,
        Column::Encryption,
        Column::Marks,
    ];

    /// Returns the column for an id.
    #[must_use]
    pub fn from_id(id: u32) -> Option<Column> {
        Column::ALL.get(id as usize).copied()
    }

    /// Returns the bytes of one value.
    #[must_use]
    pub const fn width(self) -> usize {
        match self {
            Column::UncompressedSize
            | Column::CompressedSize
            | Column::LocalHeaderOffset
            | Column::Modified => 8,
            Column::NameOffset
            | Column::NameLength
            | Column::CommentOffset
            | Column::CommentLength
            | Column::Crc32
            | Column::ExternalAttributes => 4,
            Column::Method | Column::Flags | Column::VersionMadeBy | Column::AesMethod => 2,
            Column::NameSource | Column::TimeKind | Column::Encryption | Column::Marks => 1,
        }
    }
}

/// Values of the `nameSource` column.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum NameSource {
    /// The general-purpose UTF-8 flag is set and the bytes are UTF-8.
    Utf8Flag = 0,
    /// The flag is not set, but the bytes are UTF-8.
    Utf8 = 1,
    /// The Info-ZIP Unicode Path extra field (`0x7075`).
    UnicodePath = 2,
    /// The bytes are not UTF-8 and the flag is not set.
    Cp437 = 3,
    /// The flag is set, but the bytes are not UTF-8. U+FFFD replaced the bad
    /// bytes, and the store keeps the raw bytes.
    Lossy = 4,
}

/// Values of the `timeKind` column.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum TimeKind {
    /// No time. `modified` is `NaN`.
    None = 0,
    /// DOS time: no time zone, 2-second precision, stored as if UTC.
    Dos = 1,
    /// Extended timestamp extra field (`0x5455`, UT), UTC.
    Extended = 2,
    /// NTFS extra field (`0x000a`), UTC.
    Ntfs = 3,
    /// Old Info-ZIP Unix extra field (`0x5855`), UTC.
    Unix = 4,
}

/// Values of the `encryption` column. The low 7 bits are the kind.
pub mod encryption {
    pub const NONE: u8 = 0;
    pub const ZIP_CRYPTO: u8 = 1;
    pub const AES_128: u8 = 2;
    pub const AES_192: u8 = 3;
    pub const AES_256: u8 = 4;
    /// The strong encryption flag is set.
    pub const OTHER: u8 = 5;
    /// The method is AES (99), but the AES extra field is missing or bad.
    pub const AES_UNKNOWN: u8 = 6;
    /// Set with an AES kind for AE-2.
    pub const AE2: u8 = 0x80;
}

/// Bits of the `marks` column.
pub mod marks {
    pub const DUPLICATE_NAME: u8 = 1 << 0;
    pub const DEPTH_CAP: u8 = 1 << 1;
    pub const BOMB_RATIO: u8 = 1 << 2;
    /// The local header of 30 bytes and the data of the row overlap another
    /// row.
    pub const OVERLAP: u8 = 1 << 3;
    pub const RAW_NAME_KEPT: u8 = 1 << 4;
    pub const FOLDER_CAP: u8 = 1 << 5;
    pub const CONTROL_NAME: u8 = 1 << 6;
    /// The offset of the row wrapped at 4 GiB, so the row cannot be read.
    pub const WRAPPED_OFFSET: u8 = 1 << 7;
}

/// Indexes of the health vector (`parser.health()`). Each value is an
/// `f64`. An example is the first row with the finding, or -1.
pub mod health {
    /// The entry count from the end of central directory record.
    pub const DECLARED_ENTRIES: usize = 0;
    /// 1 when parsing is complete, the declared count is not the rows, and
    /// `COUNT_WRAPPED` is 0.
    pub const COUNT_MISMATCH: usize = 1;
    pub const DUPLICATE_ROWS: usize = 2;
    pub const DUPLICATE_EXAMPLE: usize = 3;
    pub const BOMB_ROWS: usize = 4;
    pub const BOMB_EXAMPLE: usize = 5;
    pub const OVERLAP_ROWS: usize = 6;
    pub const OVERLAP_EXAMPLE: usize = 7;
    pub const DEPTH_CAP_ROWS: usize = 8;
    pub const DEPTH_CAP_EXAMPLE: usize = 9;
    pub const FOLDER_CAP_ROWS: usize = 10;
    pub const FOLDER_CAP_EXAMPLE: usize = 11;
    /// Bytes before the first local header.
    pub const PRELUDE_BYTES: usize = 12;
    /// Bytes after the end of central directory record and its comment.
    pub const EPILOGUE_BYTES: usize = 13;
    /// 1 when the overlap check covers all rows.
    pub const OVERLAPS_CHECKED: usize = 14;
    /// Rows for each encryption kind 1 to 6, at `ENCRYPTED + kind - 1`.
    pub const ENCRYPTED: usize = 15;
    /// 1 when the duplicate check covers all rows.
    pub const DUPLICATES_CHECKED: usize = 21;
    /// Rows whose name has a character that shows as a mark.
    pub const CONTROL_NAME_ROWS: usize = 22;
    pub const CONTROL_NAME_EXAMPLE: usize = 23;
    /// Rows whose offset wrapped at 4 GiB.
    pub const WRAPPED_ROWS: usize = 24;
    pub const WRAPPED_EXAMPLE: usize = 25;
    /// The length that the end record declares for its comment, when the end
    /// of the file cut it. Else 0.
    pub const COMMENT_DECLARED: usize = 26;
    /// The bytes of a cut comment that are in the file.
    pub const COMMENT_PRESENT: usize = 27;
    /// The end signatures after the chosen end record with no other directory at
    /// a place that they give.
    pub const END_SKIPPED: usize = 28;
    /// The other end records with a central directory at a place that they give:
    /// after the chosen record, before it with the chosen record in their comment,
    /// or before a chosen record with no entries.
    pub const END_OTHERS: usize = 29;
    /// The other end records of that shape that were not checked.
    pub const END_UNCHECKED: usize = 30;
    /// 1 when the chosen end record also gives a place with another directory.
    pub const END_SECOND_DIRECTORY: usize = 31;
    /// 1 when parsing is complete, the archive has no Zip64 locator, and the
    /// declared count is the rows in 16 bits, but not the rows.
    pub const COUNT_WRAPPED: usize = 32;
    /// Rows that start before the central directory, and whose local header
    /// of 30 bytes and data end after its start.
    pub const INTO_DIRECTORY_ROWS: usize = 33;
    pub const INTO_DIRECTORY_EXAMPLE: usize = 34;
    /// Rows with data whose range overlaps the range of another row with data.
    pub const OVERLAP_DATA_ROWS: usize = 35;
    pub const OVERLAP_DATA_EXAMPLE: usize = 36;
    /// The directory offset that the end record declares, when it is after the
    /// central directory. Else 0.
    pub const END_DECLARED_DIRECTORY: usize = 37;
    /// The place of the central directory, when `END_DECLARED_DIRECTORY` is set.
    pub const END_FOUND_DIRECTORY: usize = 38;
    /// The end records before the chosen record with a central directory, when no
    /// row covers them.
    pub const END_EARLIER_RECORDS: usize = 39;
    /// The place of the first of them, the nearest to the chosen record.
    pub const END_EARLIER_RECORD: usize = 40;
    /// The place of the central directory of that record.
    pub const END_EARLIER_DIRECTORY: usize = 41;
    /// The number of values.
    pub const FIELDS: usize = 42;
}

/// Bytes in one page: all columns for `PAGE_ROWS` rows.
pub const PAGE_BYTES: usize = {
    let mut total = 0;
    let mut i = 0;
    while i < Column::ALL.len() {
        total += Column::ALL[i].width() * PAGE_ROWS;
        i += 1;
    }
    total
};

/// The health vector indexes, by the names of `HealthField` in
/// `web/src/contracts.ts`. `ENCRYPTED` starts the six counts of the
/// encryption kinds.
const HEALTH_NAMES: [(&str, usize); health::FIELDS - 5] = [
    ("DECLARED_ENTRIES", health::DECLARED_ENTRIES),
    ("COUNT_MISMATCH", health::COUNT_MISMATCH),
    ("DUPLICATE_ROWS", health::DUPLICATE_ROWS),
    ("DUPLICATE_EXAMPLE", health::DUPLICATE_EXAMPLE),
    ("BOMB_ROWS", health::BOMB_ROWS),
    ("BOMB_EXAMPLE", health::BOMB_EXAMPLE),
    ("OVERLAP_ROWS", health::OVERLAP_ROWS),
    ("OVERLAP_EXAMPLE", health::OVERLAP_EXAMPLE),
    ("DEPTH_CAP_ROWS", health::DEPTH_CAP_ROWS),
    ("DEPTH_CAP_EXAMPLE", health::DEPTH_CAP_EXAMPLE),
    ("FOLDER_CAP_ROWS", health::FOLDER_CAP_ROWS),
    ("FOLDER_CAP_EXAMPLE", health::FOLDER_CAP_EXAMPLE),
    ("PRELUDE_BYTES", health::PRELUDE_BYTES),
    ("EPILOGUE_BYTES", health::EPILOGUE_BYTES),
    ("OVERLAPS_CHECKED", health::OVERLAPS_CHECKED),
    ("ENCRYPTED", health::ENCRYPTED),
    ("DUPLICATES_CHECKED", health::DUPLICATES_CHECKED),
    ("CONTROL_NAME_ROWS", health::CONTROL_NAME_ROWS),
    ("CONTROL_NAME_EXAMPLE", health::CONTROL_NAME_EXAMPLE),
    ("WRAPPED_ROWS", health::WRAPPED_ROWS),
    ("WRAPPED_EXAMPLE", health::WRAPPED_EXAMPLE),
    ("COMMENT_DECLARED", health::COMMENT_DECLARED),
    ("COMMENT_PRESENT", health::COMMENT_PRESENT),
    ("END_SKIPPED", health::END_SKIPPED),
    ("END_OTHERS", health::END_OTHERS),
    ("END_UNCHECKED", health::END_UNCHECKED),
    ("END_SECOND_DIRECTORY", health::END_SECOND_DIRECTORY),
    ("COUNT_WRAPPED", health::COUNT_WRAPPED),
    ("INTO_DIRECTORY_ROWS", health::INTO_DIRECTORY_ROWS),
    ("INTO_DIRECTORY_EXAMPLE", health::INTO_DIRECTORY_EXAMPLE),
    ("OVERLAP_DATA_ROWS", health::OVERLAP_DATA_ROWS),
    ("OVERLAP_DATA_EXAMPLE", health::OVERLAP_DATA_EXAMPLE),
    ("END_DECLARED_DIRECTORY", health::END_DECLARED_DIRECTORY),
    ("END_FOUND_DIRECTORY", health::END_FOUND_DIRECTORY),
    ("END_EARLIER_RECORDS", health::END_EARLIER_RECORDS),
    ("END_EARLIER_RECORD", health::END_EARLIER_RECORD),
    ("END_EARLIER_DIRECTORY", health::END_EARLIER_DIRECTORY),
];

/// Returns the ranges of the code points that match `test`, as
/// `first-last` in hexadecimal, separated by commas.
fn code_ranges(test: fn(u32) -> bool) -> String {
    let mut ranges: Vec<(u32, u32)> = Vec::new();
    for code in 0..=0x10_ffff {
        if !test(code) {
            continue;
        }
        match ranges.last_mut() {
            Some(last) if last.1 + 1 == code => last.1 = code,
            _ => ranges.push((code, code)),
        }
    }
    let parts: Vec<String> = ranges
        .iter()
        .map(|(first, last)| format!("{first:x}-{last:x}"))
        .collect();
    parts.join(",")
}

/// Returns the values that `web/src/contracts.ts` must repeat, one
/// `NAME=VALUE` line each.
#[must_use]
pub fn values() -> String {
    use crate::query::SortColumn;
    use std::fmt::Write;

    let mut out = String::new();
    let mut line = |name: &str, value: &dyn std::fmt::Display| {
        let _ = writeln!(out, "{name}={value}");
    };
    line("LAYOUT_VERSION", &LAYOUT_VERSION);
    line("PAGE_ROWS", &PAGE_ROWS);
    line("PAGE_BYTES", &PAGE_BYTES);
    line("CHUNK_BITS", &CHUNK_BITS);
    line("CHUNK_BYTES", &CHUNK_BYTES);
    line("NONE", &NONE);
    line("FOLDER_TAG", &FOLDER_TAG);
    line("FOLDER_RECORD_BYTES", &FOLDER_RECORD_BYTES);
    line("ROLLUP_RECORD_BYTES", &ROLLUP_RECORD_BYTES);
    line("TREE_RECORD_WORDS", &TREE_RECORD_WORDS);
    line("TREE_ORDER_ARCHIVE", &TREE_ORDER_ARCHIVE);
    line("TREE_ORDER_NAME", &TREE_ORDER_NAME);
    line("SORT_DESCENDING", &SORT_DESCENDING);
    line("LARGEST_FILES", &LARGEST_FILES);
    for column in Column::ALL {
        let name = format!("{column:?}");
        let camel = name[..1].to_lowercase() + &name[1..];
        line(
            &format!("column.{}", column as u32),
            &format!("{camel}:{}", column.width()),
        );
    }
    for state in [
        State::Opening,
        State::Parsing,
        State::Complete,
        State::Cancelled,
        State::Failed,
        State::Paused,
    ] {
        line(
            &format!("state.{}", format!("{state:?}").to_uppercase()),
            &(state as u32),
        );
    }
    for (name, index) in HEALTH_NAMES {
        line(&format!("health.{name}"), &index);
    }
    line("health.FIELDS", &health::FIELDS);
    for sort in [
        SortColumn::Archive,
        SortColumn::Name,
        SortColumn::Size,
        SortColumn::Compressed,
        SortColumn::Ratio,
        SortColumn::Method,
        SortColumn::Modified,
    ] {
        line(
            &format!("sort.{}", format!("{sort:?}").to_uppercase()),
            &(sort as u32),
        );
    }
    line("marks.control", &code_ranges(zipscope_marks::always_marked));
    line(
        "marks.attached",
        &code_ranges(|code| zipscope_marks::is_joiner(code) || zipscope_marks::is_variation(code)),
    );
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn page_is_68_bytes_per_row() {
        assert_eq!(PAGE_BYTES, 68 * PAGE_ROWS);
    }

    #[test]
    fn columns_are_in_id_order_and_aligned() {
        let mut offset = 0;
        for (index, column) in Column::ALL.iter().enumerate() {
            assert_eq!(*column as usize, index);
            assert_eq!(
                Column::from_id(u32::try_from(index).unwrap()),
                Some(*column)
            );
            assert_eq!(offset % column.width(), 0);
            offset += column.width() * PAGE_ROWS;
        }
        assert_eq!(
            Column::from_id(u32::try_from(Column::ALL.len()).unwrap()),
            None
        );
    }

    #[test]
    fn the_health_names_cover_each_index_one_time() {
        let mut seen = [false; health::FIELDS];
        for (name, index) in HEALTH_NAMES {
            let width = if index == health::ENCRYPTED { 6 } else { 1 };
            for slot in &mut seen[index..index + width] {
                assert!(!*slot, "{name}");
                *slot = true;
            }
        }
        assert!(seen.iter().all(|slot| *slot));
        assert_eq!(health::DUPLICATES_CHECKED, health::ENCRYPTED + 6);
        assert_eq!(health::FIELDS, health::END_EARLIER_DIRECTORY + 1);
    }

    #[test]
    fn values_have_one_line_for_each_name() {
        let text = values();
        let mut names: Vec<&str> = text
            .lines()
            .map(|line| line.split('=').next().unwrap())
            .collect();
        let count = names.len();
        names.sort_unstable();
        names.dedup();
        assert_eq!(names.len(), count);
        assert!(text.contains("\ncolumn.2=localHeaderOffset:8\n"));
        assert!(text.contains("\nmarks.control=0-1f,"));
    }
}
