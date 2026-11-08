#![allow(dead_code, reason = "Each test uses a different part of the builder.")]

use std::cell::Cell;
use std::io;
use std::rc::Rc;

use rawzip::ReaderAt;

#[derive(Clone, Copy, Debug)]
pub enum Descriptor {
    None,
    Plain,
    Signed,
    Zip64Plain,
    Zip64Signed,
}

#[derive(Clone, Debug)]
pub struct Entry {
    pub name: Vec<u8>,
    pub local_name: Option<Vec<u8>>,
    pub extra: Vec<u8>,
    pub comment: Vec<u8>,
    pub local_extra: Vec<u8>,
    pub body: Vec<u8>,
    pub gap: Vec<u8>,
    pub compressed: Option<u64>,
    pub uncompressed: Option<u64>,
    pub offset: Option<u64>,
    pub flags: u16,
    pub method: u16,
    pub made_by: u16,
    pub disk: u16,
    pub descriptor: Descriptor,
}

impl Entry {
    pub fn new(name: impl AsRef<[u8]>, body: impl AsRef<[u8]>) -> Self {
        Self {
            name: name.as_ref().to_vec(),
            local_name: None,
            extra: Vec::new(),
            comment: Vec::new(),
            local_extra: Vec::new(),
            body: body.as_ref().to_vec(),
            gap: Vec::new(),
            compressed: None,
            uncompressed: None,
            offset: None,
            flags: 0,
            method: 0,
            made_by: 0x031e,
            disk: 0,
            descriptor: Descriptor::None,
        }
    }
}

#[derive(Default, Debug)]
pub struct Options {
    pub prelude: Vec<u8>,
    pub before_directory: Vec<u8>,
    pub after_directory: Vec<u8>,
    pub comment: Vec<u8>,
    pub epilogue: Vec<u8>,
    pub order: Option<Vec<usize>>,
    pub declared: Option<u64>,
    pub zip64: bool,
    pub zip64_extension: Vec<u8>,
    pub disk: u32,
    pub directory_disk: u32,
    pub disk_entries: Option<u64>,
    pub total_disks: u32,
    pub base: u64,
    pub relative_offsets: bool,
}

#[derive(Debug)]
pub struct Fixture {
    pub bytes: Vec<u8>,
    pub base: u64,
    pub locals: Vec<(u64, u64)>,
    pub records: Vec<u64>,
    pub directory: u64,
    pub directory_size: u64,
    pub end_start: u64,
    pub eocd: u64,
    pub end: u64,
}

impl Fixture {
    pub fn size(&self) -> u64 {
        self.base + self.bytes.len() as u64
    }

    pub fn index(&self, offset: u64) -> usize {
        usize::try_from(offset - self.base).unwrap()
    }

    pub fn patch16(&mut self, offset: u64, value: u16) {
        let at = self.index(offset);
        self.bytes[at..at + 2].copy_from_slice(&value.to_le_bytes());
    }

    pub fn patch32(&mut self, offset: u64, value: u32) {
        let at = self.index(offset);
        self.bytes[at..at + 4].copy_from_slice(&value.to_le_bytes());
    }

    pub fn reader(&self) -> Metered {
        Metered {
            bytes: Rc::new(self.bytes.clone()),
            base: self.base,
            calls: Rc::new(Cell::new(0)),
            requested: Rc::new(Cell::new(0)),
            maximum: Rc::new(Cell::new(0)),
        }
    }
}

pub fn u16le(out: &mut Vec<u8>, value: u16) {
    out.extend_from_slice(&value.to_le_bytes());
}

pub fn u32le(out: &mut Vec<u8>, value: u32) {
    out.extend_from_slice(&value.to_le_bytes());
}

pub fn u64le(out: &mut Vec<u8>, value: u64) {
    out.extend_from_slice(&value.to_le_bytes());
}

pub fn field(id: u16, body: &[u8]) -> Vec<u8> {
    let mut out = Vec::new();
    u16le(&mut out, id);
    u16le(&mut out, body.len().try_into().unwrap());
    out.extend_from_slice(body);
    out
}

pub fn aes(version: u16, strength: u8, method: u16) -> Vec<u8> {
    let mut body = Vec::new();
    u16le(&mut body, version);
    body.extend_from_slice(b"AE");
    body.push(strength);
    u16le(&mut body, method);
    field(0x9901, &body)
}

pub fn apk_block() -> Vec<u8> {
    let mut pairs = Vec::new();
    u64le(&mut pairs, 7);
    u32le(&mut pairs, 0x7109_871a);
    pairs.extend_from_slice(b"abc");
    let size = 24 + pairs.len() as u64;
    let mut out = Vec::new();
    u64le(&mut out, size);
    out.extend_from_slice(&pairs);
    u64le(&mut out, size);
    out.extend_from_slice(b"APK Sig Block 42");
    out
}

// The bytes of entry bodies are stored without a decoder.
#[expect(
    clippy::too_many_lines,
    reason = "Keep the fields in ZIP header order."
)]
pub fn build(entries: &[Entry], options: &Options) -> Fixture {
    let mut out = options.prelude.clone();
    let mut locals = Vec::new();
    let adjustment = if options.relative_offsets {
        options.prelude.len() as u64
    } else {
        0
    };
    for entry in entries {
        let start = options.base + out.len() as u64;
        let name = entry.local_name.as_ref().unwrap_or(&entry.name);
        let compressed = entry.compressed.unwrap_or(entry.body.len() as u64);
        let uncompressed = entry.uncompressed.unwrap_or(entry.body.len() as u64);
        let descriptor = !matches!(entry.descriptor, Descriptor::None);
        let wide = matches!(
            entry.descriptor,
            Descriptor::Zip64Plain | Descriptor::Zip64Signed
        );
        let mut local_extra = entry.local_extra.clone();
        if wide {
            local_extra.extend_from_slice(&field(1, &[0; 16]));
        }
        u32le(&mut out, 0x0403_4b50);
        u16le(&mut out, 45);
        u16le(&mut out, entry.flags | if descriptor { 8 } else { 0 });
        u16le(&mut out, entry.method);
        u32le(&mut out, 0);
        u32le(
            &mut out,
            if descriptor {
                0
            } else {
                rawzip::crc32(&entry.body)
            },
        );
        for value in [compressed, uncompressed] {
            u32le(
                &mut out,
                if wide {
                    u32::MAX
                } else if descriptor {
                    0
                } else {
                    value.try_into().unwrap_or(u32::MAX)
                },
            );
        }
        u16le(&mut out, name.len().try_into().unwrap());
        u16le(&mut out, local_extra.len().try_into().unwrap());
        out.extend_from_slice(name);
        out.extend_from_slice(&local_extra);
        out.extend_from_slice(&entry.body);
        if descriptor {
            if matches!(
                entry.descriptor,
                Descriptor::Signed | Descriptor::Zip64Signed
            ) {
                u32le(&mut out, 0x0807_4b50);
            }
            u32le(&mut out, rawzip::crc32(&entry.body));
            for value in [compressed, uncompressed] {
                if matches!(
                    entry.descriptor,
                    Descriptor::Zip64Plain | Descriptor::Zip64Signed
                ) {
                    u64le(&mut out, value);
                } else {
                    u32le(&mut out, value.try_into().unwrap());
                }
            }
        }
        locals.push((start, options.base + out.len() as u64));
        out.extend_from_slice(&entry.gap);
    }
    out.extend_from_slice(&options.before_directory);
    let directory = options.base + out.len() as u64;
    let order = options
        .order
        .clone()
        .unwrap_or_else(|| (0..entries.len()).collect());
    let mut records = Vec::new();
    for &row in &order {
        let entry = &entries[row];
        let compressed = entry.compressed.unwrap_or(entry.body.len() as u64);
        let uncompressed = entry.uncompressed.unwrap_or(entry.body.len() as u64);
        let offset = entry.offset.unwrap_or(locals[row].0 - adjustment);
        let wide = matches!(
            entry.descriptor,
            Descriptor::Zip64Plain | Descriptor::Zip64Signed
        );
        let mut zip64 = Vec::new();
        for (index, value) in [uncompressed, compressed, offset].into_iter().enumerate() {
            if value >= u64::from(u32::MAX) || (wide && index < 2) {
                u64le(&mut zip64, value);
            }
        }
        let mut extra = entry.extra.clone();
        if !zip64.is_empty() {
            extra.extend_from_slice(&field(1, &zip64));
        }
        records.push(options.base + out.len() as u64);
        u32le(&mut out, 0x0201_4b50);
        u16le(&mut out, entry.made_by);
        u16le(&mut out, 45);
        let descriptor = !matches!(entry.descriptor, Descriptor::None);
        u16le(&mut out, entry.flags | if descriptor { 8 } else { 0 });
        u16le(&mut out, entry.method);
        u32le(&mut out, 0);
        u32le(&mut out, rawzip::crc32(&entry.body));
        u32le(
            &mut out,
            if wide {
                u32::MAX
            } else {
                compressed.try_into().unwrap_or(u32::MAX)
            },
        );
        u32le(
            &mut out,
            if wide {
                u32::MAX
            } else {
                uncompressed.try_into().unwrap_or(u32::MAX)
            },
        );
        u16le(&mut out, entry.name.len().try_into().unwrap());
        u16le(&mut out, extra.len().try_into().unwrap());
        u16le(&mut out, entry.comment.len().try_into().unwrap());
        u16le(&mut out, entry.disk);
        u16le(&mut out, 0);
        u32le(&mut out, 0);
        u32le(&mut out, offset.try_into().unwrap_or(u32::MAX));
        out.extend_from_slice(&entry.name);
        out.extend_from_slice(&extra);
        out.extend_from_slice(&entry.comment);
    }
    let directory_size = options.base + out.len() as u64 - directory;
    out.extend_from_slice(&options.after_directory);
    let end_start = options.base + out.len() as u64;
    let declared = options.declared.unwrap_or(order.len() as u64);
    let disk_entries = options.disk_entries.unwrap_or(declared);
    if options.zip64 {
        u32le(&mut out, 0x0606_4b50);
        u64le(&mut out, 44 + options.zip64_extension.len() as u64);
        u16le(&mut out, 45);
        u16le(&mut out, 45);
        u32le(&mut out, options.disk);
        u32le(&mut out, options.directory_disk);
        u64le(&mut out, disk_entries);
        u64le(&mut out, declared);
        u64le(&mut out, directory_size);
        u64le(&mut out, directory - adjustment);
        out.extend_from_slice(&options.zip64_extension);
        u32le(&mut out, 0x0706_4b50);
        u32le(&mut out, options.disk);
        u64le(&mut out, end_start - adjustment);
        u32le(&mut out, options.total_disks.max(1));
    }
    let eocd = options.base + out.len() as u64;
    u32le(&mut out, 0x0605_4b50);
    u16le(&mut out, options.disk.try_into().unwrap_or(u16::MAX));
    u16le(
        &mut out,
        options.directory_disk.try_into().unwrap_or(u16::MAX),
    );
    u16le(
        &mut out,
        if options.zip64 {
            u16::MAX
        } else {
            disk_entries.try_into().unwrap()
        },
    );
    u16le(
        &mut out,
        if options.zip64 {
            u16::MAX
        } else {
            declared.try_into().unwrap()
        },
    );
    u32le(
        &mut out,
        if options.zip64 {
            u32::MAX
        } else {
            directory_size.try_into().unwrap()
        },
    );
    u32le(
        &mut out,
        if options.zip64 {
            u32::MAX
        } else {
            (directory - adjustment).try_into().unwrap()
        },
    );
    u16le(&mut out, options.comment.len().try_into().unwrap());
    out.extend_from_slice(&options.comment);
    let end = options.base + out.len() as u64;
    out.extend_from_slice(&options.epilogue);
    Fixture {
        bytes: out,
        base: options.base,
        locals,
        records,
        directory,
        directory_size,
        end_start,
        eocd,
        end,
    }
}

#[derive(Clone, Debug)]
pub struct Metered {
    pub bytes: Rc<Vec<u8>>,
    pub base: u64,
    pub calls: Rc<Cell<usize>>,
    pub requested: Rc<Cell<usize>>,
    pub maximum: Rc<Cell<usize>>,
}

impl Metered {
    pub fn reset(&self) {
        self.calls.set(0);
        self.requested.set(0);
        self.maximum.set(0);
    }
}

impl ReaderAt for Metered {
    fn read_at(&self, buf: &mut [u8], offset: u64) -> io::Result<usize> {
        self.calls.set(self.calls.get() + 1);
        self.requested.set(self.requested.get() + buf.len());
        self.maximum.set(self.maximum.get().max(buf.len()));
        // Stop a scan of a sparse hole before it can loop for hours.
        assert!(self.calls.get() <= 512, "too many archive reads");
        assert!(self.requested.get() <= 8 << 20, "too many requested bytes");
        let size = self.base + self.bytes.len() as u64;
        let len = usize::try_from((size.saturating_sub(offset)).min(buf.len() as u64)).unwrap();
        buf[..len].fill(0);
        let start = offset.max(self.base);
        let end = offset + len as u64;
        if start < end {
            let dest = usize::try_from(start - offset).unwrap();
            let source = usize::try_from(start - self.base).unwrap();
            let count = usize::try_from(end - start).unwrap();
            buf[dest..dest + count].copy_from_slice(&self.bytes[source..source + count]);
        }
        Ok(len)
    }
}
