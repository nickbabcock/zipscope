//! Builds small archives with exact header fields for tests. The archive has
//! only the central directory and the end record, because the ingest reads
//! nothing else.

/// One central-directory record.
#[derive(Debug, Clone)]
pub struct Record {
    pub name: Vec<u8>,
    pub version_made_by: u16,
    pub flags: u16,
    pub method: u16,
    pub dos_time: u16,
    pub dos_date: u16,
    pub crc32: u32,
    pub compressed_size: u32,
    pub uncompressed_size: u32,
    pub extra: Vec<u8>,
    pub comment: Vec<u8>,
    pub external_attributes: u32,
    pub local_header_offset: u32,
}

impl Record {
    pub fn new(name: impl Into<Vec<u8>>) -> Self {
        Record {
            name: name.into(),
            version_made_by: 0x0314,
            flags: 0,
            method: 8,
            // 2026-10-28 09:13:06
            dos_time: (0x09 << 11) | (0x0d << 5) | 0x03,
            dos_date: (0x2e << 9) | (0x0a << 5) | 0x1c,
            crc32: 0,
            compressed_size: 0,
            uncompressed_size: 0,
            extra: Vec::new(),
            comment: Vec::new(),
            external_attributes: 0,
            local_header_offset: 0,
        }
    }

    /// Adds one extra field.
    pub fn field(mut self, id: u16, data: &[u8]) -> Self {
        self.extra.extend_from_slice(&id.to_le_bytes());
        self.extra
            .extend_from_slice(&(u16::try_from(data.len()).unwrap()).to_le_bytes());
        self.extra.extend_from_slice(data);
        self
    }
}

/// Returns an archive with the records in order.
pub fn archive(records: &[Record]) -> Vec<u8> {
    let mut out = Vec::new();
    for record in records {
        out.extend_from_slice(&0x0201_4b50u32.to_le_bytes());
        out.extend_from_slice(&record.version_made_by.to_le_bytes());
        out.extend_from_slice(&20u16.to_le_bytes());
        out.extend_from_slice(&record.flags.to_le_bytes());
        out.extend_from_slice(&record.method.to_le_bytes());
        out.extend_from_slice(&record.dos_time.to_le_bytes());
        out.extend_from_slice(&record.dos_date.to_le_bytes());
        out.extend_from_slice(&record.crc32.to_le_bytes());
        out.extend_from_slice(&record.compressed_size.to_le_bytes());
        out.extend_from_slice(&record.uncompressed_size.to_le_bytes());
        out.extend_from_slice(&(u16::try_from(record.name.len()).unwrap()).to_le_bytes());
        out.extend_from_slice(&(u16::try_from(record.extra.len()).unwrap()).to_le_bytes());
        out.extend_from_slice(&(u16::try_from(record.comment.len()).unwrap()).to_le_bytes());
        out.extend_from_slice(&0u16.to_le_bytes());
        out.extend_from_slice(&0u16.to_le_bytes());
        out.extend_from_slice(&record.external_attributes.to_le_bytes());
        out.extend_from_slice(&record.local_header_offset.to_le_bytes());
        out.extend_from_slice(&record.name);
        out.extend_from_slice(&record.extra);
        out.extend_from_slice(&record.comment);
    }
    let size = u32::try_from(out.len()).unwrap();
    out.extend_from_slice(&0x0605_4b50u32.to_le_bytes());
    out.extend_from_slice(&0u16.to_le_bytes());
    out.extend_from_slice(&0u16.to_le_bytes());
    out.extend_from_slice(&(u16::try_from(records.len()).unwrap()).to_le_bytes());
    out.extend_from_slice(&(u16::try_from(records.len()).unwrap()).to_le_bytes());
    out.extend_from_slice(&size.to_le_bytes());
    out.extend_from_slice(&0u32.to_le_bytes());
    out.extend_from_slice(&0u16.to_le_bytes());
    out
}
