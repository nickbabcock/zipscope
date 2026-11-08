use zipscope_core::contract::{Column, PAGE_ROWS};
use zipscope_core::ingest::{Ingest, Status};
use zipscope_core::store::Store;

#[derive(Clone)]
pub struct Entry {
    pub name: Vec<u8>,
    pub extra: Vec<u8>,
    pub comment: Vec<u8>,
    pub flags: u16,
    pub method: u16,
    pub size: u32,
    pub compressed: u32,
    pub crc: u32,
    pub date: u16,
    pub time: u16,
    pub attributes: u32,
    pub made_by: u16,
    pub offset: Option<u32>,
}

impl Entry {
    pub fn new(name: impl AsRef<[u8]>) -> Self {
        Self {
            name: name.as_ref().to_vec(),
            extra: Vec::new(),
            comment: Vec::new(),
            flags: 0,
            method: 0,
            size: 0,
            compressed: 0,
            crc: 0,
            date: 0,
            time: 0,
            attributes: 0,
            made_by: 0x031e,
            offset: None,
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

pub fn crc32(bytes: &[u8]) -> u32 {
    let mut crc = !0u32;
    for byte in bytes {
        crc ^= u32::from(*byte);
        for _ in 0..8 {
            crc = (crc >> 1) ^ (0xedb8_8320 & (0u32.wrapping_sub(crc & 1)));
        }
    }
    !crc
}

pub fn unicode_path(version: u8, crc: u32, text: &[u8]) -> Vec<u8> {
    let mut body = vec![version];
    u32le(&mut body, crc);
    body.extend_from_slice(text);
    field(0x7075, &body)
}

pub fn ut(seconds: u32) -> Vec<u8> {
    let mut body = vec![1];
    u32le(&mut body, seconds);
    field(0x5455, &body)
}

pub fn ntfs(unix_ms: u64) -> Vec<u8> {
    let mut body = vec![0; 4];
    u16le(&mut body, 1);
    u16le(&mut body, 24);
    u64le(&mut body, (unix_ms + 11_644_473_600_000) * 10_000);
    u64le(&mut body, 0);
    u64le(&mut body, 0);
    field(0x000a, &body)
}

pub fn aes(version: u16, strength: u8, method: u16) -> Vec<u8> {
    let mut body = Vec::new();
    u16le(&mut body, version);
    body.extend_from_slice(b"AE");
    body.push(strength);
    u16le(&mut body, method);
    field(0x9901, &body)
}

pub struct Archive {
    pub bytes: Vec<u8>,
    pub records: Vec<usize>,
    pub eocd: usize,
    pub directory: usize,
}

// Local headers have no data. The central directory can claim other values.
pub fn archive(entries: &[Entry], hint: u16, zip64_hint: Option<u64>) -> Archive {
    let mut out = Vec::new();
    let mut offsets = Vec::new();
    for entry in entries {
        offsets.push(u32::try_from(out.len()).unwrap());
        u32le(&mut out, 0x0403_4b50);
        u16le(&mut out, 20);
        u16le(&mut out, 0);
        u16le(&mut out, 0);
        u16le(&mut out, 0);
        u16le(&mut out, 0);
        u32le(&mut out, 0);
        u32le(&mut out, 0);
        u32le(&mut out, 0);
        u16le(&mut out, entry.name.len().try_into().unwrap());
        u16le(&mut out, 0);
        out.extend_from_slice(&entry.name);
    }
    let directory = out.len();
    let mut records = Vec::new();
    for (entry, offset) in entries.iter().zip(offsets) {
        records.push(out.len());
        u32le(&mut out, 0x0201_4b50);
        u16le(&mut out, entry.made_by);
        u16le(&mut out, 45);
        u16le(&mut out, entry.flags);
        u16le(&mut out, entry.method);
        u16le(&mut out, entry.time);
        u16le(&mut out, entry.date);
        u32le(&mut out, entry.crc);
        u32le(&mut out, entry.compressed);
        u32le(&mut out, entry.size);
        u16le(&mut out, entry.name.len().try_into().unwrap());
        u16le(&mut out, entry.extra.len().try_into().unwrap());
        u16le(&mut out, entry.comment.len().try_into().unwrap());
        u16le(&mut out, 0);
        u16le(&mut out, 0);
        u32le(&mut out, entry.attributes);
        u32le(&mut out, entry.offset.unwrap_or(offset));
        out.extend_from_slice(&entry.name);
        out.extend_from_slice(&entry.extra);
        out.extend_from_slice(&entry.comment);
    }
    let directory_size = out.len() - directory;
    if let Some(count) = zip64_hint {
        let zip64_offset = out.len();
        u32le(&mut out, 0x0606_4b50);
        u64le(&mut out, 44);
        u16le(&mut out, 45);
        u16le(&mut out, 45);
        u32le(&mut out, 0);
        u32le(&mut out, 0);
        u64le(&mut out, count);
        u64le(&mut out, count);
        u64le(&mut out, directory_size as u64);
        u64le(&mut out, directory as u64);
        u32le(&mut out, 0x0706_4b50);
        u32le(&mut out, 0);
        u64le(&mut out, zip64_offset as u64);
        u32le(&mut out, 1);
    }
    let eocd = out.len();
    u32le(&mut out, 0x0605_4b50);
    u16le(&mut out, 0);
    u16le(&mut out, 0);
    u16le(&mut out, hint);
    u16le(&mut out, hint);
    u32le(&mut out, u32::try_from(directory_size).unwrap());
    u32le(&mut out, u32::try_from(directory).unwrap());
    u16le(&mut out, 0);
    Archive {
        bytes: out,
        records,
        eocd,
        directory,
    }
}

pub fn open(bytes: Vec<u8>) -> Ingest<Vec<u8>> {
    let size = bytes.len() as u64;
    Ingest::open(bytes, size).unwrap()
}

pub fn parsed(entries: &[Entry]) -> Ingest<Vec<u8>> {
    let mut ingest = open(
        archive(
            entries,
            u16::try_from(entries.len().min(65_534)).unwrap(),
            None,
        )
        .bytes,
    );
    assert_eq!(
        ingest.parse(u32::MAX),
        u32::try_from(entries.len()).unwrap()
    );
    assert_eq!(ingest.status(), &Status::Complete);
    ingest
}

#[expect(
    clippy::cast_ptr_alignment,
    reason = "Each column has its declared type; unaligned reads do not require alignment."
)]
pub fn cell(store: &Store, row: usize, column: Column) -> f64 {
    assert!(row < store.rows());
    let pointer = store.column_ptr(row / PAGE_ROWS, column);
    assert!(!pointer.is_null(), "missing column {column:?}");
    let index = row % PAGE_ROWS;
    // SAFETY: The row exists. Each column has PAGE_ROWS slots of its
    // declared type. The store stays borrowed while the value is read.
    unsafe {
        match column.width() {
            8 => pointer.cast::<f64>().add(index).read_unaligned(),
            4 => f64::from(pointer.cast::<u32>().add(index).read_unaligned()),
            2 => f64::from(pointer.cast::<u16>().add(index).read_unaligned()),
            1 => f64::from(pointer.add(index).read()),
            _ => unreachable!(),
        }
    }
}

pub fn cell_u32(store: &Store, row: usize, column: Column) -> u32 {
    let value = cell(store, row, column);
    assert!((0.0..=f64::from(u32::MAX)).contains(&value));
    assert_eq!(value.fract(), 0.0);
    #[expect(
        clippy::cast_possible_truncation,
        clippy::cast_sign_loss,
        reason = "The assertions check that the value is an exact u32."
    )]
    let integer = value as u32;
    integer
}
