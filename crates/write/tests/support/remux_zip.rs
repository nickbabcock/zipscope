//! Test support for the zstd remux.
//!
//! - `Entry` and `build` make source archives byte for byte, so each
//!   header field can have a false value.
//! - `Source` is a `ReaderAt` that is `Clone + Send + Sync`. It can put the
//!   archive at a large offset, with zero bytes before it (sparse).
//! - `parse` reads an output archive with its own small parser, so that
//!   the tests do not trust the code that they test.
//! - `remux` and `remux_with` run the assumed API (see `hostile_remux.rs`).
#![allow(dead_code, reason = "Each test binary uses a different part.")]

use std::io::Write;
use std::sync::Arc;

use rawzip::ReaderAt;

pub const LOCAL: u32 = 0x0403_4b50;
pub const CENTRAL: u32 = 0x0201_4b50;
pub const END: u32 = 0x0605_4b50;
pub const END64: u32 = 0x0606_4b50;
pub const LOCATOR64: u32 = 0x0706_4b50;
pub const DESCRIPTOR: u32 = 0x0807_4b50;

/// How the source entry gives its CRC-32 and sizes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Descriptor {
    /// In the local header.
    None,
    /// In a data descriptor with its signature.
    Signed,
    /// In a data descriptor without a signature.
    Unsigned,
}

/// One source entry. The `Option` fields take the true value when `None`.
#[derive(Debug, Clone)]
pub struct Entry {
    pub name: Vec<u8>,
    pub method: u16,
    pub flags: u16,
    pub body: Vec<u8>,
    /// The bytes after the local header. `None` compresses `body`.
    pub data: Option<Vec<u8>>,
    pub crc: Option<u32>,
    pub uncompressed: Option<u64>,
    pub compressed: Option<u64>,
    pub local_name: Option<Vec<u8>>,
    pub local_method: Option<u16>,
    /// The extra field of the central-directory record, without zip64.
    pub extra: Vec<u8>,
    /// The extra field of the local header, without zip64.
    pub local_extra: Vec<u8>,
    pub comment: Vec<u8>,
    pub time: u16,
    pub date: u16,
    pub made_by: u16,
    pub attributes: u32,
    pub descriptor: Descriptor,
    /// Point the record at the local header of an earlier entry.
    pub share: Option<usize>,
    /// Always write a zip64 extra field.
    pub force_zip64: bool,
}

impl Entry {
    pub fn new(name: impl AsRef<[u8]>, method: u16, body: impl Into<Vec<u8>>) -> Self {
        Entry {
            name: name.as_ref().to_vec(),
            method,
            flags: 0,
            body: body.into(),
            data: None,
            crc: None,
            uncompressed: None,
            compressed: None,
            local_name: None,
            local_method: None,
            extra: Vec::new(),
            local_extra: Vec::new(),
            comment: Vec::new(),
            // 2021-06-15 13:45:30 (DOS).
            time: (13 << 11) | (45 << 5) | 15,
            date: ((2021 - 1980) << 9) | (6 << 5) | 15,
            made_by: 0x031e,
            attributes: 0o100_644 << 16,
            descriptor: Descriptor::None,
            share: None,
            force_zip64: false,
        }
    }

    pub fn stored(name: impl AsRef<[u8]>, body: impl Into<Vec<u8>>) -> Self {
        Entry::new(name, 0, body)
    }

    pub fn deflated(name: impl AsRef<[u8]>, body: impl Into<Vec<u8>>) -> Self {
        Entry::new(name, 8, body)
    }

    pub fn zstd(name: impl AsRef<[u8]>, body: impl Into<Vec<u8>>) -> Self {
        Entry::new(name, 93, body)
    }

    pub fn folder(name: impl AsRef<[u8]>) -> Self {
        let mut entry = Entry::new(name, 0, Vec::new());
        entry.attributes = (0o040_755 << 16) | 0x10;
        entry
    }

    pub fn compressed_data(&self) -> Vec<u8> {
        if let Some(data) = &self.data {
            return data.clone();
        }
        deflate_or_zstd(self.method, &self.body)
    }

    pub fn true_crc(&self) -> u32 {
        rawzip::crc32(&self.body)
    }
}

pub fn deflate_or_zstd(method: u16, body: &[u8]) -> Vec<u8> {
    match method {
        8 => {
            let mut encoder =
                flate2::write::DeflateEncoder::new(Vec::new(), flate2::Compression::fast());
            encoder.write_all(body).unwrap();
            encoder.finish().unwrap()
        }
        20 | 93 => zstd::bulk::compress(body, 3).unwrap(),
        _ => body.to_vec(),
    }
}

pub fn field(id: u16, body: &[u8]) -> Vec<u8> {
    let mut out = Vec::new();
    out.extend_from_slice(&id.to_le_bytes());
    out.extend_from_slice(&u16::try_from(body.len()).unwrap().to_le_bytes());
    out.extend_from_slice(body);
    out
}

/// An extended timestamp (UT) field with the modified time only.
pub fn ut(seconds: u32) -> Vec<u8> {
    let mut body = vec![1];
    body.extend_from_slice(&seconds.to_le_bytes());
    field(0x5455, &body)
}

/// An NTFS field with the modified time in milliseconds since 1970.
pub fn ntfs(unix_ms: u64) -> Vec<u8> {
    let mut body = vec![0; 4];
    body.extend_from_slice(&1u16.to_le_bytes());
    body.extend_from_slice(&24u16.to_le_bytes());
    let ticks = (unix_ms + 11_644_473_600_000) * 10_000;
    body.extend_from_slice(&ticks.to_le_bytes());
    body.extend_from_slice(&ticks.to_le_bytes());
    body.extend_from_slice(&ticks.to_le_bytes());
    field(0x000a, &body)
}

/// An Info-ZIP Unicode Path field (`0x7075`).
pub fn unicode_path(name: &[u8], text: &str) -> Vec<u8> {
    let mut body = vec![1];
    body.extend_from_slice(&rawzip::crc32(name).to_le_bytes());
    body.extend_from_slice(text.as_bytes());
    field(0x7075, &body)
}

/// A `WinZip` AES field (`0x9901`).
pub fn aes(version: u16, strength: u8, method: u16) -> Vec<u8> {
    let mut body = Vec::new();
    body.extend_from_slice(&version.to_le_bytes());
    body.extend_from_slice(b"AE");
    body.push(strength);
    body.extend_from_slice(&method.to_le_bytes());
    field(0x9901, &body)
}

/// Bytes that no compressor makes smaller (xorshift).
pub fn noise(length: usize, seed: u64) -> Vec<u8> {
    let mut state = seed | 1;
    (0..length)
        .map(|_| {
            state ^= state << 13;
            state ^= state >> 7;
            state ^= state << 17;
            state.to_le_bytes()[3]
        })
        .collect()
}

/// Text that compresses well, different for each seed.
pub fn text(length: usize, seed: u64) -> Vec<u8> {
    let line = format!("line of entry {seed}: the quick brown fox jumps over the lazy dog\n");
    line.bytes().cycle().take(length).collect()
}

/// Options of a whole source archive.
#[derive(Debug, Clone, Default)]
pub struct Options {
    /// Bytes before the first local header (a self-extracting stub).
    pub prelude: Vec<u8>,
    /// The offset of the first byte of the archive in the source. The
    /// bytes before it read as zero.
    pub base: u64,
    pub comment: Vec<u8>,
    /// Always write the zip64 end records.
    pub zip64: bool,
}

/// A source archive and the facts that the tests compare.
#[derive(Debug, Clone)]
pub struct Built {
    pub source: Source,
    /// The absolute local header offset of each entry.
    pub offsets: Vec<u64>,
}

pub fn build(entries: &[Entry]) -> Built {
    build_with(entries, &Options::default())
}

#[expect(clippy::too_many_lines, reason = "One function writes all records.")]
pub fn build_with(entries: &[Entry], options: &Options) -> Built {
    let base = options.base;
    let mut out = options.prelude.clone();
    let mut offsets = Vec::new();
    let mut directory = Vec::new();
    for entry in entries {
        let data = entry.compressed_data();
        let crc = entry.crc.unwrap_or_else(|| entry.true_crc());
        let uncompressed = entry.uncompressed.unwrap_or(entry.body.len() as u64);
        let compressed = entry.compressed.unwrap_or(data.len() as u64);
        let offset = if let Some(index) = entry.share {
            offsets[index]
        } else {
            {
                let offset = base + out.len() as u64;
                let local_name = entry.local_name.as_ref().unwrap_or(&entry.name);
                let mut flags = entry.flags;
                if entry.descriptor != Descriptor::None {
                    flags |= 0x08;
                }
                let local_zip64 = entry.force_zip64
                    || uncompressed >= u64::from(u32::MAX)
                    || compressed >= u64::from(u32::MAX);
                let mut extra = Vec::new();
                if local_zip64 {
                    let mut body = Vec::new();
                    body.extend_from_slice(&uncompressed.to_le_bytes());
                    body.extend_from_slice(&compressed.to_le_bytes());
                    extra.extend(field(0x0001, &body));
                }
                extra.extend_from_slice(&entry.local_extra);
                let in_header = entry.descriptor == Descriptor::None;
                put32(&mut out, LOCAL);
                put16(&mut out, if local_zip64 { 45 } else { 20 });
                put16(&mut out, flags);
                put16(&mut out, entry.local_method.unwrap_or(entry.method));
                put16(&mut out, entry.time);
                put16(&mut out, entry.date);
                put32(&mut out, if in_header { crc } else { 0 });
                let small = |value: u64| {
                    if !in_header {
                        0
                    } else if local_zip64 {
                        u32::MAX
                    } else {
                        u32::try_from(value).unwrap()
                    }
                };
                put32(&mut out, small(compressed));
                put32(&mut out, small(uncompressed));
                put16(&mut out, u16::try_from(local_name.len()).unwrap());
                put16(&mut out, u16::try_from(extra.len()).unwrap());
                out.extend_from_slice(local_name);
                out.extend_from_slice(&extra);
                out.extend_from_slice(&data);
                match entry.descriptor {
                    Descriptor::None => {}
                    Descriptor::Signed | Descriptor::Unsigned => {
                        if entry.descriptor == Descriptor::Signed {
                            put32(&mut out, DESCRIPTOR);
                        }
                        put32(&mut out, crc);
                        if local_zip64 {
                            put64(&mut out, compressed);
                            put64(&mut out, uncompressed);
                        } else {
                            put32(&mut out, u32::try_from(compressed).unwrap());
                            put32(&mut out, u32::try_from(uncompressed).unwrap());
                        }
                    }
                }
                offset
            }
        };
        offsets.push(offset);

        let big_offset = offset >= u64::from(u32::MAX);
        let zip64 = entry.force_zip64
            || uncompressed >= u64::from(u32::MAX)
            || compressed >= u64::from(u32::MAX)
            || big_offset;
        let mut extra = Vec::new();
        if zip64 {
            let mut body = Vec::new();
            body.extend_from_slice(&uncompressed.to_le_bytes());
            body.extend_from_slice(&compressed.to_le_bytes());
            body.extend_from_slice(&offset.to_le_bytes());
            extra.extend(field(0x0001, &body));
        }
        extra.extend_from_slice(&entry.extra);
        let mut flags = entry.flags;
        if entry.descriptor != Descriptor::None {
            flags |= 0x08;
        }
        put32(&mut directory, CENTRAL);
        put16(&mut directory, entry.made_by);
        put16(&mut directory, if zip64 { 45 } else { 20 });
        put16(&mut directory, flags);
        put16(&mut directory, entry.method);
        put16(&mut directory, entry.time);
        put16(&mut directory, entry.date);
        put32(&mut directory, crc);
        let small = |value: u64| {
            if zip64 {
                u32::MAX
            } else {
                u32::try_from(value).unwrap()
            }
        };
        put32(&mut directory, small(compressed));
        put32(&mut directory, small(uncompressed));
        put16(&mut directory, u16::try_from(entry.name.len()).unwrap());
        put16(&mut directory, u16::try_from(extra.len()).unwrap());
        put16(&mut directory, u16::try_from(entry.comment.len()).unwrap());
        put16(&mut directory, 0);
        put16(&mut directory, 0);
        put32(&mut directory, entry.attributes);
        put32(&mut directory, small(offset));
        directory.extend_from_slice(&entry.name);
        directory.extend_from_slice(&extra);
        directory.extend_from_slice(&entry.comment);
    }
    let start = base + out.len() as u64;
    let size = directory.len() as u64;
    out.extend_from_slice(&directory);
    let count = entries.len() as u64;
    let zip64 = options.zip64
        || count >= u64::from(u16::MAX)
        || start >= u64::from(u32::MAX)
        || size >= u64::from(u32::MAX);
    if zip64 {
        let record = base + out.len() as u64;
        put32(&mut out, END64);
        put64(&mut out, 44);
        put16(&mut out, 45);
        put16(&mut out, 45);
        put32(&mut out, 0);
        put32(&mut out, 0);
        put64(&mut out, count);
        put64(&mut out, count);
        put64(&mut out, size);
        put64(&mut out, start);
        put32(&mut out, LOCATOR64);
        put32(&mut out, 0);
        put64(&mut out, record);
        put32(&mut out, 1);
    }
    put32(&mut out, END);
    put16(&mut out, 0);
    put16(&mut out, 0);
    let short = if zip64 {
        u16::MAX
    } else {
        u16::try_from(count).unwrap()
    };
    put16(&mut out, short);
    put16(&mut out, short);
    put32(
        &mut out,
        if zip64 {
            u32::MAX
        } else {
            u32::try_from(size).unwrap()
        },
    );
    put32(
        &mut out,
        if zip64 {
            u32::MAX
        } else {
            u32::try_from(start).unwrap()
        },
    );
    put16(&mut out, u16::try_from(options.comment.len()).unwrap());
    out.extend_from_slice(&options.comment);
    Built {
        source: Source::new(base, out),
        offsets,
    }
}

fn put16(out: &mut Vec<u8>, value: u16) {
    out.extend_from_slice(&value.to_le_bytes());
}

fn put32(out: &mut Vec<u8>, value: u32) {
    out.extend_from_slice(&value.to_le_bytes());
}

fn put64(out: &mut Vec<u8>, value: u64) {
    out.extend_from_slice(&value.to_le_bytes());
}

/// A source archive. The bytes before `base` read as zero.
#[derive(Debug, Clone)]
pub struct Source {
    base: u64,
    bytes: Arc<Vec<u8>>,
}

impl Source {
    pub fn new(base: u64, bytes: Vec<u8>) -> Self {
        Source {
            base,
            bytes: Arc::new(bytes),
        }
    }

    pub fn size(&self) -> u64 {
        self.base + self.bytes.len() as u64
    }

    /// The bytes after `base`.
    pub fn tail(&self) -> &[u8] {
        &self.bytes
    }

    /// A copy with one byte changed, at an offset from `base`.
    pub fn with_byte(&self, at: usize, value: u8) -> Source {
        let mut bytes = self.bytes.as_ref().clone();
        bytes[at] = value;
        Source::new(self.base, bytes)
    }
}

impl ReaderAt for Source {
    fn read_at(&self, buf: &mut [u8], offset: u64) -> std::io::Result<usize> {
        let size = self.size();
        if offset >= size {
            return Ok(0);
        }
        let length = buf
            .len()
            .min(usize::try_from(size - offset).unwrap_or(usize::MAX));
        let buf = &mut buf[..length];
        let mut at = 0;
        if offset < self.base {
            let zeros = length.min(usize::try_from(self.base - offset).unwrap_or(usize::MAX));
            buf[..zeros].fill(0);
            at = zeros;
        }
        if at < length {
            let from = usize::try_from(offset + at as u64 - self.base).unwrap();
            buf[at..].copy_from_slice(&self.bytes[from..from + (length - at)]);
        }
        Ok(length)
    }
}

/// One central-directory record of an output archive, read by the parser
/// of this file.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Record {
    pub made_by: u16,
    pub needed: u16,
    pub flags: u16,
    pub method: u16,
    pub time: u16,
    pub date: u16,
    pub crc: u32,
    pub compressed: u64,
    pub uncompressed: u64,
    pub name: Vec<u8>,
    /// The extra field, as written.
    pub extra: Vec<u8>,
    pub comment: Vec<u8>,
    pub attributes: u32,
    pub offset: u64,
    /// The compressed data, found from the local header.
    pub data: Vec<u8>,
    /// The local name and extra field.
    pub local_name: Vec<u8>,
    pub local_extra: Vec<u8>,
}

/// An output archive, read by the parser of this file.
#[derive(Debug, Clone)]
pub struct Parsed {
    pub records: Vec<Record>,
    pub comment: Vec<u8>,
    pub zip64: bool,
    /// The offset of the first central-directory record.
    pub directory: u64,
}

fn get16(bytes: &[u8], at: usize) -> u16 {
    u16::from_le_bytes(bytes[at..at + 2].try_into().unwrap())
}

fn get32(bytes: &[u8], at: usize) -> u32 {
    u32::from_le_bytes(bytes[at..at + 4].try_into().unwrap())
}

fn get64(bytes: &[u8], at: usize) -> u64 {
    u64::from_le_bytes(bytes[at..at + 8].try_into().unwrap())
}

/// The fields of an extra field as (id, body), in order.
pub fn fields(extra: &[u8]) -> Vec<(u16, Vec<u8>)> {
    let mut found = Vec::new();
    let mut at = 0;
    while at + 4 <= extra.len() {
        let id = get16(extra, at);
        let length = usize::from(get16(extra, at + 2));
        let end = (at + 4 + length).min(extra.len());
        found.push((id, extra[at + 4..end].to_vec()));
        at = end;
    }
    found
}

/// The fields without the zip64 field (`0x0001`).
pub fn fields_without_zip64(extra: &[u8]) -> Vec<(u16, Vec<u8>)> {
    fields(extra)
        .into_iter()
        .filter(|(id, _)| *id != 0x0001)
        .collect()
}

/// Reads an output archive strictly: it must start with a local header at
/// offset 0, end with the end record, and have no bytes between the parts.
///
/// # Panics
///
/// Panics when the archive is not well formed.
#[expect(clippy::too_many_lines, reason = "One strict parser.")]
pub fn parse(zip: &[u8]) -> Parsed {
    assert!(zip.len() >= 22, "The output is too short for an end record");
    // The comment length of the end record must reach the end.
    let end = (0..=zip.len() - 22)
        .rev()
        .find(|&at| {
            get32(zip, at) == END && at + 22 + usize::from(get16(zip, at + 20)) == zip.len()
        })
        .expect("No end record");
    assert_eq!(get32(zip, end), END, "No end record");
    let comment = zip[end + 22..].to_vec();
    let mut count = u64::from(get16(zip, end + 10));
    let mut size = u64::from(get32(zip, end + 12));
    let mut start = u64::from(get32(zip, end + 16));
    let mut directory_end = end;
    let mut zip64 = false;
    if end >= 20 && get32(zip, end - 20) == LOCATOR64 {
        zip64 = true;
        let record = usize::try_from(get64(zip, end - 20 + 8)).unwrap();
        assert_eq!(get32(zip, record), END64, "The zip64 locator is false");
        assert_eq!(record + 56, end - 20, "Bytes between the zip64 records");
        count = get64(zip, record + 32);
        size = get64(zip, record + 40);
        start = get64(zip, record + 48);
        directory_end = record;
    }
    let start_at = usize::try_from(start).unwrap();
    assert_eq!(
        start_at + usize::try_from(size).unwrap(),
        directory_end,
        "The directory size does not end at the end records"
    );
    let mut records = Vec::new();
    let mut at = start_at;
    while at < directory_end {
        assert_eq!(get32(zip, at), CENTRAL, "Bad central record at {at}");
        let name_length = usize::from(get16(zip, at + 28));
        let extra_length = usize::from(get16(zip, at + 30));
        let comment_length = usize::from(get16(zip, at + 32));
        let name = zip[at + 46..at + 46 + name_length].to_vec();
        let extra = zip[at + 46 + name_length..at + 46 + name_length + extra_length].to_vec();
        let entry_comment = zip[at + 46 + name_length + extra_length
            ..at + 46 + name_length + extra_length + comment_length]
            .to_vec();
        let mut compressed = u64::from(get32(zip, at + 20));
        let mut uncompressed = u64::from(get32(zip, at + 24));
        let mut offset = u64::from(get32(zip, at + 42));
        if let Some((_, body)) = fields(&extra).into_iter().find(|(id, _)| *id == 1) {
            let mut cursor = 0;
            for value in [&mut uncompressed, &mut compressed, &mut offset] {
                if *value == u64::from(u32::MAX) {
                    *value = get64(&body, cursor);
                    cursor += 8;
                }
            }
        }
        let local = usize::try_from(offset).unwrap();
        assert_eq!(get32(zip, local), LOCAL, "No local header at {local}");
        let local_name_length = usize::from(get16(zip, local + 26));
        let local_extra_length = usize::from(get16(zip, local + 28));
        let data_at = local + 30 + local_name_length + local_extra_length;
        let data = zip[data_at..data_at + usize::try_from(compressed).unwrap()].to_vec();
        records.push(Record {
            made_by: get16(zip, at + 4),
            needed: get16(zip, at + 6),
            flags: get16(zip, at + 8),
            method: get16(zip, at + 10),
            time: get16(zip, at + 12),
            date: get16(zip, at + 14),
            crc: get32(zip, at + 16),
            compressed,
            uncompressed,
            name,
            extra,
            comment: entry_comment,
            attributes: get32(zip, at + 38),
            offset,
            data,
            local_name: zip[local + 30..local + 30 + local_name_length].to_vec(),
            local_extra: zip[local + 30 + local_name_length
                ..local + 30 + local_name_length + local_extra_length]
                .to_vec(),
        });
        at += 46 + name_length + extra_length + comment_length;
    }
    assert_eq!(records.len() as u64, count, "The end record count is false");
    // Each entry starts where the one before ends, from offset 0.
    let mut expected = 0u64;
    let mut sorted: Vec<&Record> = records.iter().collect();
    sorted.sort_by_key(|record| record.offset);
    for record in sorted {
        assert_eq!(record.offset, expected, "A gap or an overlap in the output");
        let local = usize::try_from(record.offset).unwrap();
        let mut next = local + 30 + record.local_name.len() + record.local_extra.len();
        next += usize::try_from(record.compressed).unwrap();
        if get16(zip, local + 6) & 0x08 != 0 {
            if get32(zip, next) == DESCRIPTOR {
                next += 4;
            }
            next += 4;
            let local_zip64 = fields(&record.local_extra).iter().any(|(id, _)| *id == 1);
            next += if local_zip64 { 16 } else { 8 };
        }
        expected = next as u64;
    }
    assert_eq!(
        expected, start,
        "Bytes between the last entry and the directory"
    );
    Parsed {
        records,
        comment,
        zip64,
        directory: start,
    }
}

/// Decodes the data of a record (stored, deflate or Zstandard). Returns
/// `None` for other methods.
pub fn decode(record: &Record) -> Option<Vec<u8>> {
    use std::io::Read;
    let mut out = Vec::new();
    match record.method {
        0 => out.clone_from(&record.data),
        8 => {
            flate2::read::DeflateDecoder::new(record.data.as_slice())
                .read_to_end(&mut out)
                .unwrap();
        }
        20 | 93 => {
            zstd::stream::read::Decoder::new(record.data.as_slice())
                .unwrap()
                .read_to_end(&mut out)
                .unwrap();
        }
        _ => return None,
    }
    Some(out)
}

/// The start offsets of the Zstandard frames in `data`. Each frame header
/// gives a window. It stops at bytes that are not a frame.
pub fn zstd_frames(data: &[u8]) -> Vec<usize> {
    let mut starts = Vec::new();
    let mut at = 0;
    while at < data.len() {
        let Ok(size) = zstd::zstd_safe::find_frame_compressed_size(&data[at..]) else {
            break;
        };
        if size == 0 {
            break;
        }
        starts.push(at);
        at += size;
    }
    starts
}
