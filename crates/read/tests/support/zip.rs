//! Builds small archives with local headers and entry data for tests. Each
//! field can be set to a false value, to make hostile archives.
#![allow(dead_code, reason = "Each test uses a different part of the builder.")]

use std::io::Write;

/// One entry of a test archive. The `None` fields take the true value.
#[derive(Debug, Clone)]
pub struct Entry {
    pub name: Vec<u8>,
    pub method: u16,
    pub flags: u16,
    /// The uncompressed data.
    pub body: Vec<u8>,
    /// The bytes after the local header. `None` compresses `body`.
    pub data: Option<Vec<u8>>,
    pub crc: Option<u32>,
    pub uncompressed: Option<u64>,
    pub compressed: Option<u64>,
    pub local_name: Option<Vec<u8>>,
    pub local_method: Option<u16>,
    pub local_crc: Option<u32>,
    pub local_uncompressed: Option<u32>,
    pub local_compressed: Option<u32>,
    /// The local header offset in the central directory.
    pub offset: Option<u64>,
}

impl Entry {
    pub fn new(name: impl Into<Vec<u8>>, method: u16, body: impl Into<Vec<u8>>) -> Self {
        Entry {
            name: name.into(),
            method,
            flags: 0,
            body: body.into(),
            data: None,
            crc: None,
            uncompressed: None,
            compressed: None,
            local_name: None,
            local_method: None,
            local_crc: None,
            local_uncompressed: None,
            local_compressed: None,
            offset: None,
        }
    }

    pub fn stored(name: impl Into<Vec<u8>>, body: impl Into<Vec<u8>>) -> Self {
        Entry::new(name, 0, body)
    }

    pub fn deflated(name: impl Into<Vec<u8>>, body: impl Into<Vec<u8>>) -> Self {
        Entry::new(name, 8, body)
    }

    pub fn zstd(name: impl Into<Vec<u8>>, body: impl Into<Vec<u8>>) -> Self {
        Entry::new(name, 93, body)
    }

    fn compressed_data(&self) -> Vec<u8> {
        if let Some(data) = &self.data {
            return data.clone();
        }
        match self.method {
            8 => {
                let mut encoder =
                    flate2::write::DeflateEncoder::new(Vec::new(), flate2::Compression::default());
                encoder.write_all(&self.body).unwrap();
                encoder.finish().unwrap()
            }
            93 => zstd::bulk::compress(&self.body, 3).unwrap(),
            _ => self.body.clone(),
        }
    }
}

fn u16_of(value: usize) -> [u8; 2] {
    u16::try_from(value).unwrap().to_le_bytes()
}

/// Returns an archive with the entries in order.
pub fn build(entries: &[Entry]) -> Vec<u8> {
    let mut out = Vec::new();
    let mut directory = Vec::new();
    for entry in entries {
        let offset = out.len() as u64;
        let data = entry.compressed_data();
        let crc = entry.crc.unwrap_or_else(|| rawzip::crc32(&entry.body));
        let uncompressed = entry.uncompressed.unwrap_or(entry.body.len() as u64);
        let compressed = entry.compressed.unwrap_or(data.len() as u64);
        let local_name = entry.local_name.as_ref().unwrap_or(&entry.name);

        out.extend_from_slice(&0x0403_4b50u32.to_le_bytes());
        out.extend_from_slice(&20u16.to_le_bytes());
        out.extend_from_slice(&entry.flags.to_le_bytes());
        out.extend_from_slice(&entry.local_method.unwrap_or(entry.method).to_le_bytes());
        out.extend_from_slice(&0u16.to_le_bytes());
        out.extend_from_slice(&0x5b5cu16.to_le_bytes());
        out.extend_from_slice(&entry.local_crc.unwrap_or(crc).to_le_bytes());
        let local_compressed = entry
            .local_compressed
            .unwrap_or_else(|| u32::try_from(compressed).unwrap_or(u32::MAX));
        let local_uncompressed = entry
            .local_uncompressed
            .unwrap_or_else(|| u32::try_from(uncompressed).unwrap_or(u32::MAX));
        out.extend_from_slice(&local_compressed.to_le_bytes());
        out.extend_from_slice(&local_uncompressed.to_le_bytes());
        out.extend_from_slice(&u16_of(local_name.len()));
        out.extend_from_slice(&0u16.to_le_bytes());
        out.extend_from_slice(local_name);
        out.extend_from_slice(&data);

        // Sizes that do not fit 32 bits go in a zip64 extra field.
        let zip64 = uncompressed >= u64::from(u32::MAX) || compressed >= u64::from(u32::MAX);
        let mut extra = Vec::new();
        if zip64 {
            extra.extend_from_slice(&1u16.to_le_bytes());
            extra.extend_from_slice(&16u16.to_le_bytes());
            extra.extend_from_slice(&uncompressed.to_le_bytes());
            extra.extend_from_slice(&compressed.to_le_bytes());
        }
        let small = |value: u64| {
            if zip64 {
                u32::MAX
            } else {
                u32::try_from(value).unwrap()
            }
        };
        directory.extend_from_slice(&0x0201_4b50u32.to_le_bytes());
        directory.extend_from_slice(&0x0314u16.to_le_bytes());
        directory.extend_from_slice(&(if zip64 { 45u16 } else { 20u16 }).to_le_bytes());
        directory.extend_from_slice(&entry.flags.to_le_bytes());
        directory.extend_from_slice(&entry.method.to_le_bytes());
        directory.extend_from_slice(&0u16.to_le_bytes());
        directory.extend_from_slice(&0x5b5cu16.to_le_bytes());
        directory.extend_from_slice(&crc.to_le_bytes());
        directory.extend_from_slice(&small(compressed).to_le_bytes());
        directory.extend_from_slice(&small(uncompressed).to_le_bytes());
        directory.extend_from_slice(&u16_of(entry.name.len()));
        directory.extend_from_slice(&u16_of(extra.len()));
        directory.extend_from_slice(&0u16.to_le_bytes());
        directory.extend_from_slice(&0u16.to_le_bytes());
        directory.extend_from_slice(&0u16.to_le_bytes());
        directory.extend_from_slice(&0u32.to_le_bytes());
        let offset = entry.offset.unwrap_or(offset);
        directory.extend_from_slice(&u32::try_from(offset).unwrap().to_le_bytes());
        directory.extend_from_slice(&entry.name);
        directory.extend_from_slice(&extra);
    }
    let start = u32::try_from(out.len()).unwrap();
    let size = u32::try_from(directory.len()).unwrap();
    out.extend_from_slice(&directory);
    out.extend_from_slice(&0x0605_4b50u32.to_le_bytes());
    out.extend_from_slice(&0u16.to_le_bytes());
    out.extend_from_slice(&0u16.to_le_bytes());
    // A count above 65,535 needs zip64. The count is only a hint, so the
    // test archives give the largest value.
    let count = entries.len().min(usize::from(u16::MAX));
    out.extend_from_slice(&u16_of(count));
    out.extend_from_slice(&u16_of(count));
    out.extend_from_slice(&size.to_le_bytes());
    out.extend_from_slice(&start.to_le_bytes());
    out.extend_from_slice(&0u16.to_le_bytes());
    out
}

/// Returns the offsets of the central-directory records of an archive from
/// `build`.
pub fn record_offsets(data: &[u8]) -> Vec<u64> {
    let end = data.len() - 22;
    let start = u32::from_le_bytes(data[end + 16..end + 20].try_into().unwrap()) as usize;
    let mut offsets = Vec::new();
    let mut at = start;
    while at < end {
        offsets.push(at as u64);
        let length = |field: usize| {
            usize::from(u16::from_le_bytes([data[at + field], data[at + field + 1]]))
        };
        at += 46 + length(28) + length(30) + length(32);
    }
    offsets
}
