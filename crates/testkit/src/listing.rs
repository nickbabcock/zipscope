//! Reference listings: rawzip iteration and `zipinfo`.

use std::path::Path;
use std::process::Command;

use codepage_437::{CP437_CONTROL, FromCp437};
use rawzip::extra_fields::ExtraFieldId;
use rawzip::{RECOMMENDED_BUFFER_SIZE, ReaderAt, ZipArchive, ZipFileHeaderRecord, ZipLocator};

/// How a listing ended.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Outcome {
    /// The central directory ended.
    Complete,
    /// An entry error stopped the listing. The entries before it stay.
    Failed(String),
    /// No end of central directory record was found.
    NotZip(String),
}

impl Outcome {
    /// Returns the outcome name that `expected.json` uses.
    #[must_use]
    pub fn kind(&self) -> &'static str {
        match self {
            Outcome::Complete => "complete",
            Outcome::Failed(_) => "failed",
            Outcome::NotZip(_) => "not-zip",
        }
    }
}

/// The columns of one entry that the differential test compares.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Entry {
    /// The name bytes in the record.
    pub raw_name: Vec<u8>,
    /// The name that Zipscope shows.
    pub name: String,
    /// Sizes and offset with zip64 applied.
    pub uncompressed_size: u64,
    pub compressed_size: u64,
    pub local_header_offset: u64,
    pub crc32: u32,
    /// The compression method in the record (99 for AES).
    pub method: u16,
}

/// The entries of an archive, in central-directory order.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Listing {
    pub entries: Vec<Entry>,
    pub outcome: Outcome,
}

/// Returns the text of a Unicode Path field (`0x7075`): version 1, a
/// CRC-32 of the raw name that matches, and UTF-8 text that is not empty.
fn unicode_path<'a>(field: &'a [u8], raw: &[u8]) -> Option<&'a str> {
    let [1, c0, c1, c2, c3, text @ ..] = field else {
        return None;
    };
    if u32::from_le_bytes([*c0, *c1, *c2, *c3]) != rawzip::crc32(raw) {
        return None;
    }
    std::str::from_utf8(text)
        .ok()
        .filter(|text| !text.is_empty())
}

/// Returns the name that Zipscope shows.
///
/// The rules: the first Unicode Path field when its CRC matches, then
/// the raw bytes when the UTF-8 flag is set or they are UTF-8, then CP437.
/// Bytes that are not UTF-8 with the UTF-8 flag become U+FFFD.
///
/// This is a separate implementation from `zipscope_core::text`, with
/// CP437 from the `codepage-437` crate, so that the test compares two
/// implementations.
#[must_use]
pub fn display_name(record: &ZipFileHeaderRecord<'_>) -> String {
    let raw = record.file_path().as_bytes();
    let unicode = record
        .extra_fields()
        .find(|(id, _)| *id == ExtraFieldId::new(0x7075))
        .and_then(|(_, field)| unicode_path(field, raw));
    if let Some(text) = unicode {
        return text.to_string();
    }
    match std::str::from_utf8(raw) {
        Ok(text) => text.to_string(),
        Err(_) if record.flags().is_utf8() => String::from_utf8_lossy(raw).into_owned(),
        Err(_) => String::from_cp437(raw.to_vec(), &CP437_CONTROL),
    }
}

fn entry(record: &ZipFileHeaderRecord<'_>) -> Entry {
    Entry {
        raw_name: record.file_path().as_bytes().to_vec(),
        name: display_name(record),
        uncompressed_size: record.uncompressed_size_hint(),
        compressed_size: record.compressed_size_hint(),
        local_header_offset: record.local_header_offset(),
        crc32: record.crc32(),
        method: record.compression_method().as_u16(),
    }
}

/// Lists an archive in memory with the rawzip slice API. The core ingest uses
/// the reader API, so this is a different path through rawzip.
#[must_use]
pub fn rawzip_slice(data: &[u8]) -> Listing {
    let archive = match ZipArchive::from_slice(data) {
        Ok(archive) => archive,
        Err(err) => {
            return Listing {
                entries: Vec::new(),
                outcome: Outcome::NotZip(err.to_string()),
            };
        }
    };
    let mut entries = Vec::new();
    let mut records = archive.entries();
    let outcome = loop {
        match records.next_entry() {
            Ok(Some(record)) => entries.push(entry(&record)),
            Ok(None) => break Outcome::Complete,
            Err(err) => break Outcome::Failed(err.to_string()),
        }
    };
    Listing { entries, outcome }
}

/// Lists an archive with the rawzip reader API. Use it when the archive is
/// too large for memory, for example a sparse archive.
pub fn rawzip_reader<R: ReaderAt>(reader: R, size: u64) -> Listing {
    let mut buffer = vec![0; RECOMMENDED_BUFFER_SIZE];
    let archive = match ZipLocator::new().locate_in_reader(reader, &mut buffer, size) {
        Ok(archive) => archive,
        Err((_, err)) => {
            return Listing {
                entries: Vec::new(),
                outcome: Outcome::NotZip(err.to_string()),
            };
        }
    };
    let mut entries = Vec::new();
    let mut records = archive.entries(&mut buffer);
    let outcome = loop {
        match records.next_entry() {
            Ok(Some(record)) => entries.push(entry(&record)),
            Ok(None) => break Outcome::Complete,
            Err(err) => break Outcome::Failed(err.to_string()),
        }
    };
    Listing { entries, outcome }
}

/// The columns of one entry in `zipinfo -v`. A value is `None` when
/// `zipinfo` does not show it in a form that the parser knows.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ZipinfoEntry {
    pub uncompressed_size: Option<u64>,
    pub compressed_size: Option<u64>,
    pub local_header_offset: Option<u64>,
    pub crc32: Option<u32>,
    pub method: Option<u16>,
}

/// The result of `zipinfo -1` and `zipinfo -v`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ZipinfoListing {
    /// The exit status of `zipinfo -1`. 0 is no error, 1 is a warning, 2
    /// and more are errors.
    pub status: i32,
    /// The names from `zipinfo -1`, as bytes.
    pub names: Vec<Vec<u8>>,
    /// The entries from `zipinfo -v`.
    pub entries: Vec<ZipinfoEntry>,
}

/// Returns the method id for a `zipinfo -v` method text.
fn method_id(text: &str) -> Option<u16> {
    if let Some(id) = text
        .strip_prefix("unknown (")
        .and_then(|rest| rest.strip_suffix(')'))
    {
        return id.parse().ok();
    }
    match text {
        "none (stored)" => Some(0),
        "deflated" => Some(8),
        _ => None,
    }
}

/// Parses the entries of `zipinfo -v` output.
fn parse_verbose(text: &str) -> Vec<ZipinfoEntry> {
    let mut entries: Vec<ZipinfoEntry> = Vec::new();
    for line in text.lines() {
        if line.starts_with("Central directory entry #") {
            entries.push(ZipinfoEntry::default());
            continue;
        }
        let Some(entry) = entries.last_mut() else {
            continue;
        };
        let Some((key, value)) = line.trim().split_once(':') else {
            continue;
        };
        let value = value.trim();
        let number = || value.split_whitespace().next()?.parse::<u64>().ok();
        match key {
            "offset of local header from start of archive" => entry.local_header_offset = number(),
            "compression method" => entry.method = method_id(value),
            "32-bit CRC value (hex)" => entry.crc32 = u32::from_str_radix(value, 16).ok(),
            "compressed size" => entry.compressed_size = number(),
            "uncompressed size" => entry.uncompressed_size = number(),
            _ => {}
        }
    }
    entries
}

/// Runs `zipinfo -1` and `zipinfo -v` on a file. Returns `None` when
/// `zipinfo` is not installed.
pub fn zipinfo(path: &Path) -> Option<ZipinfoListing> {
    let short = Command::new("zipinfo").arg("-1").arg(path).output().ok()?;
    let mut names: Vec<Vec<u8>> = short
        .stdout
        .split(|byte| *byte == b'\n')
        .map(<[u8]>::to_vec)
        .collect();
    if names.last().is_some_and(Vec::is_empty) {
        names.pop();
    }
    let verbose = Command::new("zipinfo").arg("-v").arg(path).output().ok()?;
    Some(ZipinfoListing {
        status: short.status.code().unwrap_or(-1),
        names,
        entries: parse_verbose(&String::from_utf8_lossy(&verbose.stdout)),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_zipinfo_verbose_entries() {
        let text = "Central directory entry #1:\n\
            ---------------------------\n\n  a.txt\n\n\
            \x20 offset of local header from start of archive:   88\n\
            \x20                                                 (0000000000000058h) bytes\n\
            \x20 compression method:                             unknown (99)\n\
            \x20 32-bit CRC value (hex):                         193838c3\n\
            \x20 compressed size:                                5368709120 bytes\n\
            \x20 uncompressed size:                              32 bytes\n";
        assert_eq!(
            parse_verbose(text),
            [ZipinfoEntry {
                uncompressed_size: Some(32),
                compressed_size: Some(5_368_709_120),
                local_header_offset: Some(88),
                crc32: Some(0x1938_38c3),
                method: Some(99),
            }]
        );
    }
}
