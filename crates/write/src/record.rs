//! The raw central-directory record of an entry and its local extra
//! fields.
//!
//! The remux keeps the fields of each entry as the archive has them. The
//! write module reads the raw bytes of each record, because rawzip's
//! parsed record does not give all fields (the internal attributes and the
//! raw local header offset).

/// The fixed part of a central-directory record.
pub const RECORD_FIXED_BYTES: usize = 46;
/// The fixed part of a local header.
pub const LOCAL_FIXED_BYTES: usize = 30;
/// The largest central-directory record: the fixed part and three
/// variable parts of at most 65,535 bytes each.
pub const MAX_RECORD_BYTES: usize = RECORD_FIXED_BYTES + 3 * u16::MAX as usize;
/// The signature of a central-directory record.
pub const RECORD_SIGNATURE: u32 = 0x0201_4b50;
/// The id of the zip64 extra field. The writer makes this field again.
pub const ZIP64_FIELD: u16 = 0x0001;
/// Bit 11 of the flags: the name and the comment are UTF-8.
pub const UTF8_FLAG: u16 = 1 << 11;

fn le16(bytes: &[u8], at: usize) -> u16 {
    u16::from_le_bytes([bytes[at], bytes[at + 1]])
}

fn le32(bytes: &[u8], at: usize) -> u32 {
    u32::from_le_bytes([bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]])
}

fn le64(bytes: &[u8], at: usize) -> u64 {
    let mut value = [0u8; 8];
    value.copy_from_slice(&bytes[at..at + 8]);
    u64::from_le_bytes(value)
}

/// A central-directory record from its raw bytes.
#[derive(Debug, Clone, Copy)]
pub struct RawRecord<'a> {
    bytes: &'a [u8],
}

/// Why the raw bytes are not a record.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct NotARecord;

impl std::fmt::Display for NotARecord {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("The bytes are not a central-directory record")
    }
}

impl std::error::Error for NotARecord {}

impl<'a> RawRecord<'a> {
    /// Reads a record from `bytes`, which start with the record and hold
    /// all of its variable part.
    ///
    /// # Errors
    ///
    /// Returns [`NotARecord`] when the signature is not there or the bytes
    /// are shorter than the record.
    pub fn parse(bytes: &'a [u8]) -> Result<Self, NotARecord> {
        if bytes.len() < RECORD_FIXED_BYTES || le32(bytes, 0) != RECORD_SIGNATURE {
            return Err(NotARecord);
        }
        let record = RawRecord { bytes };
        if bytes.len() < record.length() {
            return Err(NotARecord);
        }
        Ok(RawRecord {
            bytes: &bytes[..record.length()],
        })
    }

    /// The length of a record whose fixed part is `fixed`.
    #[must_use]
    pub fn length_of(fixed: &[u8; RECORD_FIXED_BYTES]) -> usize {
        RECORD_FIXED_BYTES
            + usize::from(le16(fixed, 28))
            + usize::from(le16(fixed, 30))
            + usize::from(le16(fixed, 32))
    }

    /// The bytes of the record.
    #[must_use]
    pub fn bytes(&self) -> &'a [u8] {
        self.bytes
    }

    /// The length of the record.
    #[must_use]
    pub fn length(&self) -> usize {
        RECORD_FIXED_BYTES
            + usize::from(le16(self.bytes, 28))
            + usize::from(le16(self.bytes, 30))
            + usize::from(le16(self.bytes, 32))
    }

    #[must_use]
    pub fn version_made_by(&self) -> u16 {
        le16(self.bytes, 4)
    }

    #[must_use]
    pub fn flags(&self) -> u16 {
        le16(self.bytes, 8)
    }

    #[must_use]
    pub fn method(&self) -> u16 {
        le16(self.bytes, 10)
    }

    /// The DOS time, as the record has it.
    #[must_use]
    pub fn dos_time(&self) -> u16 {
        le16(self.bytes, 12)
    }

    /// The DOS date, as the record has it.
    #[must_use]
    pub fn dos_date(&self) -> u16 {
        le16(self.bytes, 14)
    }

    #[must_use]
    pub fn crc32(&self) -> u32 {
        le32(self.bytes, 16)
    }

    #[must_use]
    pub fn internal_attributes(&self) -> u16 {
        le16(self.bytes, 36)
    }

    #[must_use]
    pub fn external_attributes(&self) -> u32 {
        le32(self.bytes, 38)
    }

    fn name_end(&self) -> usize {
        RECORD_FIXED_BYTES + usize::from(le16(self.bytes, 28))
    }

    fn extra_end(&self) -> usize {
        self.name_end() + usize::from(le16(self.bytes, 30))
    }

    /// The raw name bytes.
    #[must_use]
    pub fn name(&self) -> &'a [u8] {
        &self.bytes[RECORD_FIXED_BYTES..self.name_end()]
    }

    /// The raw extra field bytes of the central directory.
    #[must_use]
    pub fn extra(&self) -> &'a [u8] {
        &self.bytes[self.name_end()..self.extra_end()]
    }

    /// The raw comment bytes.
    #[must_use]
    pub fn comment(&self) -> &'a [u8] {
        &self.bytes[self.extra_end()..self.length()]
    }

    /// The local header offset as the record has it, with the zip64 extra
    /// field applied as rawzip applies it: when the 32-bit field holds
    /// 0xffffffff, the value comes from the zip64 extra field, after the
    /// sizes whose 32-bit fields hold 0xffffffff. `None` when the zip64
    /// field does not hold the value.
    #[must_use]
    pub fn local_offset(&self) -> Option<u64> {
        let offset = le32(self.bytes, 42);
        if offset != u32::MAX {
            return Some(u64::from(offset));
        }
        let (_, data) = fields(self.extra()).find(|(id, _)| *id == ZIP64_FIELD)?;
        let mut at = 0;
        for field in [24, 20] {
            if le32(self.bytes, field) == u32::MAX {
                at += 8;
            }
        }
        (data.len() >= at + 8).then(|| le64(data, at))
    }
}

/// The extra fields of `extra`, as (id, data). Bytes at the end that are
/// not a whole field are not given.
pub fn fields(extra: &[u8]) -> impl Iterator<Item = (u16, &[u8])> {
    let mut at = 0;
    std::iter::from_fn(move || {
        if at + 4 > extra.len() {
            return None;
        }
        let id = le16(extra, at);
        let length = usize::from(le16(extra, at + 2));
        let start = at + 4;
        let end = start
            .checked_add(length)
            .filter(|end| *end <= extra.len())?;
        at = end;
        Some((id, &extra[start..end]))
    })
}

/// The extra fields that the copy keeps: all of them, but the zip64
/// field, which the writer makes again for the new offsets and sizes.
pub fn kept_fields(extra: &[u8]) -> impl Iterator<Item = (u16, &[u8])> {
    fields(extra).filter(|(id, _)| *id != ZIP64_FIELD)
}

/// The bytes that [`kept_fields`] keeps, with their headers.
#[must_use]
pub fn kept_bytes(extra: &[u8]) -> usize {
    kept_fields(extra).map(|(_, data)| 4 + data.len()).sum()
}

/// The extra field bytes of a local header from its fixed part and the
/// bytes after it: `(name length, extra length)`.
#[must_use]
pub fn local_lengths(fixed: &[u8; LOCAL_FIXED_BYTES]) -> Option<(usize, usize)> {
    (le32(fixed, 0) == 0x0403_4b50)
        .then(|| (usize::from(le16(fixed, 26)), usize::from(le16(fixed, 28))))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn record(offset: u32, sizes: [u32; 2], extra: &[u8]) -> Vec<u8> {
        let mut bytes = vec![0u8; RECORD_FIXED_BYTES];
        bytes[..4].copy_from_slice(&RECORD_SIGNATURE.to_le_bytes());
        bytes[20..24].copy_from_slice(&sizes[0].to_le_bytes());
        bytes[24..28].copy_from_slice(&sizes[1].to_le_bytes());
        bytes[28..30].copy_from_slice(&1u16.to_le_bytes());
        bytes[30..32].copy_from_slice(&u16::try_from(extra.len()).unwrap().to_le_bytes());
        bytes[32..34].copy_from_slice(&2u16.to_le_bytes());
        bytes[42..46].copy_from_slice(&offset.to_le_bytes());
        bytes.push(b'a');
        bytes.extend_from_slice(extra);
        bytes.extend_from_slice(b"hi");
        bytes
    }

    fn field(id: u16, data: &[u8]) -> Vec<u8> {
        let mut out = id.to_le_bytes().to_vec();
        out.extend_from_slice(&u16::try_from(data.len()).unwrap().to_le_bytes());
        out.extend_from_slice(data);
        out
    }

    #[test]
    fn reads_the_parts_of_a_record() {
        let extra = field(0x5455, &[1, 2, 3, 4, 5]);
        let bytes = record(77, [1, 2], &extra);
        let parsed = RawRecord::parse(&bytes).unwrap();
        assert_eq!(parsed.name(), b"a");
        assert_eq!(parsed.extra(), extra.as_slice());
        assert_eq!(parsed.comment(), b"hi");
        assert_eq!(parsed.local_offset(), Some(77));
        assert_eq!(parsed.length(), bytes.len());
        RawRecord::parse(&bytes[..bytes.len() - 1]).unwrap_err();
    }

    #[test]
    fn takes_the_offset_after_the_sizes_in_the_zip64_field() {
        let mut data = 5u64.to_le_bytes().to_vec();
        data.extend_from_slice(&(6u64 << 32).to_le_bytes());
        let bytes = record(u32::MAX, [7, u32::MAX], &field(1, &data));
        let parsed = RawRecord::parse(&bytes).unwrap();
        assert_eq!(parsed.local_offset(), Some(6 << 32));
        // No offset in the field.
        let bytes = record(u32::MAX, [u32::MAX, u32::MAX], &field(1, &data));
        assert_eq!(RawRecord::parse(&bytes).unwrap().local_offset(), None);
    }

    #[test]
    fn keeps_all_fields_but_zip64() {
        let mut extra = field(1, &[0; 8]);
        extra.extend(field(0x7075, b"\x01abcdname"));
        extra.extend(field(0xcafe, b""));
        // A part of a field at the end.
        extra.extend([0x01, 0x02, 0x09]);
        let kept: Vec<(u16, &[u8])> = kept_fields(&extra).collect();
        assert_eq!(
            kept,
            vec![
                (0x7075, b"\x01abcdname".as_slice()),
                (0xcafe, b"".as_slice())
            ]
        );
        assert_eq!(kept_bytes(&extra), 4 + 9 + 4);
    }
}
