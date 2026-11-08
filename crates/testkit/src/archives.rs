//! Archive generators for tests. Each generator gives the same bytes on
//! each run.

use std::io::{self, Write};

use rawzip::extra_fields::ExtraFieldId;
use rawzip::path::EntryPath;
use rawzip::{Crc32Option, Header, ZipArchiveWriter};

use crate::sparse::{SparseBytes, zero_crc32};

/// Size of the large entry in the zip64 archive: 5 GiB of zeros.
pub const LARGE_ENTRY_BYTES: u64 = 5 << 30;

fn add_file<W: Write>(
    archive: &mut ZipArchiveWriter<W>,
    path: EntryPath<'_>,
    body: &[u8],
    comment: &[u8],
) -> Result<(), rawzip::Error> {
    let (mut entry, config) = archive.new_file(path).comment(comment.to_vec()).start()?;
    let mut writer = config.wrap(&mut entry);
    writer.write_all(body)?;
    let (_, descriptor) = writer.finish()?;
    entry.finish(descriptor)?;
    Ok(())
}

/// An archive with `entries` entries (at least 40) of many kinds.
///
/// The entries include directories, deep paths, and UTF-8 names with and
/// without the UTF-8 flag. Other entries have a CP437 name, Unicode Path
/// fields, a duplicate name, or a backslash name. The archive also has
/// entry comments, an archive comment, and small file bodies.
///
/// # Errors
///
/// Returns an error if an archive record cannot be written.
pub fn mixed(entries: usize) -> Result<Vec<u8>, rawzip::Error> {
    let mut output = Vec::new();
    let mut archive = ZipArchiveWriter::new(&mut output);
    let mut count = 0;

    for dir in ["docs/", "src/", "spaces in name/"] {
        archive.new_dir(dir).create()?;
        count += 1;
    }
    let mut deep = String::new();
    for level in 0..16 {
        use std::fmt::Write as _;
        write!(deep, "level-{level:02}/").unwrap();
    }
    archive.new_dir(deep.as_str()).create()?;
    add_file(
        &mut archive,
        EntryPath::conformant(format!("{deep}leaf.txt")),
        b"deep\n",
        b"",
    )?;
    count += 2;

    let utf8 = [
        "docs/résumé.txt",
        "docs/日本語/ファイル.txt",
        "emoji/🦀 crab.rs",
        "spaces in name/file name.txt",
        "docs/ÅÄÖ/über.md",
    ];
    for name in utf8 {
        add_file(
            &mut archive,
            EntryPath::conformant(name),
            name.as_bytes(),
            b"",
        )?;
        count += 1;
    }
    // UTF-8 bytes without the UTF-8 flag.
    add_file(
        &mut archive,
        EntryPath::verbatim("noflag/naïve.txt".as_bytes()),
        b"x",
        b"",
    )?;
    // CP437 bytes: 0x82 is "é" and 0x94 is "ö". They are not UTF-8.
    add_file(
        &mut archive,
        EntryPath::verbatim(&b"legacy/caf\x82 r\x94sti.txt"[..]),
        b"cp437",
        b"",
    )?;
    // A Unicode Path field with a CRC that matches the raw name: Zipscope
    // shows the field text. With a CRC that does not match: CP437.
    for (raw, crc) in [
        (
            &b"unicode/na\x8bve.txt"[..],
            rawzip::crc32(b"unicode/na\x8bve.txt"),
        ),
        (&b"unicode/stale\x8b.txt"[..], 0),
    ] {
        let mut field = vec![1];
        field.extend_from_slice(&crc.to_le_bytes());
        field.extend_from_slice("unicode/naïve-from-field.txt".as_bytes());
        let (mut entry, config) = archive
            .new_file(EntryPath::verbatim(raw))
            .extra_field(ExtraFieldId::new(0x7075), &field, Header::CENTRAL)?
            .start()?;
        let writer = config.wrap(&mut entry);
        let (_, descriptor) = writer.finish()?;
        entry.finish(descriptor)?;
    }
    // A Windows separator, written as it is.
    add_file(
        &mut archive,
        EntryPath::verbatim(&b"windows\\path\\file.txt"[..]),
        b"",
        b"",
    )?;
    for _ in 0..2 {
        add_file(
            &mut archive,
            EntryPath::verbatim(&b"dup.txt"[..]),
            b"twice",
            b"",
        )?;
    }
    add_file(
        &mut archive,
        EntryPath::conformant("docs/commented.txt"),
        b"body",
        "An entry comment".as_bytes(),
    )?;
    count += 8;

    let mut index = 0_i32;
    while count < entries {
        let name = format!("data/group-{:02}/item-{index:05}.bin", index % 23);
        let body: Vec<u8> = (0..index % 300)
            .map(|byte| (byte % 256).to_le_bytes()[0])
            .collect();
        add_file(&mut archive, EntryPath::conformant(name), &body, b"")?;
        index += 1;
        count += 1;
    }
    archive.set_comment("Zipscope mixed test archive");
    archive.finish()?;
    Ok(output)
}

/// An archive of 5 GiB with a large stored entry of zeros, so that the
/// entries after it start past 4 GiB. The zeros are holes: the result keeps
/// only some kilobytes.
///
/// # Errors
///
/// Returns an error if an archive record cannot be written.
pub fn zip64_sparse() -> Result<SparseBytes, rawzip::Error> {
    let mut output = SparseBytes::new();
    let hole = output.hole_switch();
    let mut archive = ZipArchiveWriter::new(&mut output);
    add_file(
        &mut archive,
        EntryPath::conformant("before.txt"),
        b"An entry before the large entry\n",
        b"",
    )?;

    let (mut entry, config) = archive
        .new_file("large/zeros.bin")
        .crc32(Crc32Option::Custom(zero_crc32(LARGE_ENTRY_BYTES)))
        .start()?;
    let mut writer = config.wrap(&mut entry);
    let zeros = vec![0u8; 1 << 20];
    hole.set(true);
    for _ in 0..LARGE_ENTRY_BYTES / zeros.len() as u64 {
        writer.write_all(&zeros)?;
    }
    hole.set(false);
    let (_, descriptor) = writer.finish()?;
    entry.finish(descriptor)?;

    archive.new_dir("after/").create()?;
    add_file(
        &mut archive,
        EntryPath::conformant("after/past-4gib.txt"),
        b"This entry starts past 4 GiB\n",
        b"",
    )?;
    add_file(
        &mut archive,
        EntryPath::conformant("after/empty.txt"),
        b"",
        b"",
    )?;
    archive.finish()?;
    Ok(output)
}

/// One central-directory record of `hostile`.
struct Record<'a> {
    name: &'a [u8],
    flags: u16,
    method: u16,
    compressed: u32,
    size: u32,
    /// An index into the local headers that the record points at.
    header: usize,
}

impl Record<'_> {
    /// Writes the fields that the local header and the central-directory
    /// record share, from the flags to the name length. Times and CRC are 0.
    fn write_common(&self, out: &mut Vec<u8>) {
        out.extend_from_slice(&self.flags.to_le_bytes());
        out.extend_from_slice(&self.method.to_le_bytes());
        out.extend_from_slice(&[0; 8]);
        out.extend_from_slice(&self.compressed.to_le_bytes());
        out.extend_from_slice(&self.size.to_le_bytes());
        out.extend_from_slice(&u16::try_from(self.name.len()).unwrap().to_le_bytes());
    }
}

/// The records of `hostile`.
fn hostile_records(deep: &str) -> [Record<'_>; 7] {
    [
        Record {
            name: b"readme.txt",
            flags: 0,
            method: 0,
            compressed: 5,
            size: 5,
            header: 0,
        },
        Record {
            name: b"readme.txt",
            flags: 0,
            method: 0,
            compressed: 5,
            size: 5,
            header: 1,
        },
        Record {
            name: deep.as_bytes(),
            flags: 0,
            method: 0,
            compressed: 0,
            size: 0,
            header: 2,
        },
        Record {
            name: b"bomb/zeros.bin",
            flags: 0,
            method: 8,
            compressed: 1000,
            size: 1 << 30,
            header: 3,
        },
        Record {
            name: b"bomb/alias-1.bin",
            flags: 0,
            method: 8,
            compressed: 1000,
            size: 1 << 30,
            header: 3,
        },
        Record {
            name: b"bomb/alias-2.bin",
            flags: 0,
            method: 8,
            compressed: 1000,
            size: 1 << 30,
            header: 3,
        },
        Record {
            name: b"secret.txt",
            flags: 1,
            method: 0,
            compressed: 17,
            size: 5,
            header: 4,
        },
    ]
}

/// A hostile archive for the health panel.
///
/// A shell script is before it and junk is after it. It has duplicate
/// names, a depth bomb, a bomb-like ratio, records that share one local
/// header (overlapping data), a `ZipCrypto` entry and an end record that
/// declares too many entries.
///
/// # Panics
///
/// Panics if a generated size does not fit its field.
#[must_use]
pub fn hostile() -> Vec<u8> {
    let prelude = b"#!/bin/sh\nexec unzip \"$0\"\n";
    let deep = "deep/".repeat(300) + "leaf.txt";
    let records = hostile_records(&deep);
    let mut out = prelude.to_vec();
    let mut offsets = Vec::new();
    // Local headers with data: 5, 5, 0, 1000 and 17 bytes.
    for (index, record) in records.iter().enumerate() {
        if offsets.len() > record.header
            || index
                != records
                    .iter()
                    .position(|r| r.header == record.header)
                    .unwrap()
        {
            continue;
        }
        offsets.push(u32::try_from(out.len()).unwrap());
        out.extend_from_slice(&0x0403_4b50u32.to_le_bytes());
        out.extend_from_slice(&20u16.to_le_bytes());
        record.write_common(&mut out);
        out.extend_from_slice(&0u16.to_le_bytes());
        out.extend_from_slice(record.name);
        out.resize(out.len() + record.compressed as usize, 0);
    }
    let directory = out.len();
    for record in &records {
        out.extend_from_slice(&0x0201_4b50u32.to_le_bytes());
        out.extend_from_slice(&0x031eu16.to_le_bytes());
        out.extend_from_slice(&20u16.to_le_bytes());
        record.write_common(&mut out);
        out.extend_from_slice(&[0; 8]);
        out.extend_from_slice(&0o100_644u32.wrapping_shl(16).to_le_bytes());
        out.extend_from_slice(&offsets[record.header].to_le_bytes());
        out.extend_from_slice(record.name);
    }
    let size = out.len() - directory;
    out.extend_from_slice(&0x0605_4b50u32.to_le_bytes());
    out.extend_from_slice(&[0; 4]);
    // The end record declares 9 entries; the directory has 7.
    out.extend_from_slice(&9u16.to_le_bytes());
    out.extend_from_slice(&9u16.to_le_bytes());
    out.extend_from_slice(&u32::try_from(size).unwrap().to_le_bytes());
    out.extend_from_slice(&u32::try_from(directory).unwrap().to_le_bytes());
    out.extend_from_slice(&0u16.to_le_bytes());
    out.extend_from_slice(b"junk after the end");
    out
}

/// Writes `data` to `path` and makes the parent directories.
///
/// # Errors
///
/// Returns an error if a directory or file cannot be written.
pub fn write(path: &std::path::Path, data: &[u8]) -> io::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(path, data)
}
