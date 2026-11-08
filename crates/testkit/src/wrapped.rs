//! Archives with no Zip64 at exact places in a sparse buffer.
//!
//! The tests of offsets that wrap at 4 GiB use them. A row has a small body
//! and a declared compressed size that can be large, so a fixture of many
//! GiB keeps only some kilobytes.

use std::io::Write;

use crate::sparse::SparseBytes;

pub const GIB: u64 = 1 << 30;
pub const WRAP: u64 = 1 << 32;

/// One row: its central-directory record and its local header.
#[derive(Debug, Clone)]
pub struct Row {
    pub name: Vec<u8>,
    /// The true place of the local header and the low 32 bits for the
    /// offset field.
    pub place: u64,
    /// False when the file has no local header for this record.
    pub header: bool,
    /// The name in the local header, when it is not `name`.
    pub local_name: Option<Vec<u8>>,
    pub body: Vec<u8>,
    /// The declared sizes. The default is the length of the body.
    pub compressed: Option<u32>,
    pub uncompressed: Option<u32>,
    /// The offset field, when it is not the low 32 bits of `place`.
    pub offset_field: Option<u32>,
    pub extra: Vec<u8>,
}

impl Row {
    #[must_use]
    pub fn new(name: &str, place: u64) -> Row {
        Row {
            name: name.as_bytes().to_vec(),
            place,
            header: true,
            local_name: None,
            body: Vec::new(),
            compressed: None,
            uncompressed: None,
            offset_field: None,
            extra: Vec::new(),
        }
    }

    /// Sets the declared compressed and uncompressed size.
    #[must_use]
    pub fn sized(mut self, bytes: u32) -> Row {
        self.compressed = Some(bytes);
        self.uncompressed = Some(bytes);
        self
    }

    #[must_use]
    pub fn body(mut self, body: &[u8]) -> Row {
        self.body = body.to_vec();
        self
    }

    /// Removes the local header. The record stays.
    #[must_use]
    pub fn no_header(mut self) -> Row {
        self.header = false;
        self
    }

    #[expect(
        clippy::cast_possible_truncation,
        reason = "Keeps the low 32 bits, as a writer with no Zip64 does."
    )]
    fn low_bits(&self) -> u32 {
        self.place as u32
    }

    fn sizes(&self) -> (u32, u32) {
        let length = u32::try_from(self.body.len()).unwrap();
        (
            self.compressed.unwrap_or(length),
            self.uncompressed.unwrap_or(length),
        )
    }

    /// Returns the local header and the body of the row.
    ///
    /// # Panics
    ///
    /// Panics if the name does not fit its field.
    #[must_use]
    pub fn local_bytes(&self) -> Vec<u8> {
        let (compressed, uncompressed) = self.sizes();
        let name = self.local_name.as_ref().unwrap_or(&self.name);
        let mut out = Vec::new();
        out.extend_from_slice(&0x0403_4b50u32.to_le_bytes());
        out.extend_from_slice(&20u16.to_le_bytes());
        out.extend_from_slice(&[0; 8]);
        out.extend_from_slice(&rawzip::crc32(&self.body).to_le_bytes());
        out.extend_from_slice(&compressed.to_le_bytes());
        out.extend_from_slice(&uncompressed.to_le_bytes());
        out.extend_from_slice(&u16::try_from(name.len()).unwrap().to_le_bytes());
        out.extend_from_slice(&0u16.to_le_bytes());
        out.extend_from_slice(name);
        out.extend_from_slice(&self.body);
        out
    }

    /// Returns the central-directory record of the row.
    ///
    /// # Panics
    ///
    /// Panics if the name does not fit its field.
    #[must_use]
    pub fn record_bytes(&self) -> Vec<u8> {
        let (compressed, uncompressed) = self.sizes();
        let mut out = Vec::new();
        out.extend_from_slice(&0x0201_4b50u32.to_le_bytes());
        out.extend_from_slice(&0x0314u16.to_le_bytes());
        out.extend_from_slice(&20u16.to_le_bytes());
        out.extend_from_slice(&[0; 8]);
        out.extend_from_slice(&rawzip::crc32(&self.body).to_le_bytes());
        out.extend_from_slice(&compressed.to_le_bytes());
        out.extend_from_slice(&uncompressed.to_le_bytes());
        out.extend_from_slice(&u16::try_from(self.name.len()).unwrap().to_le_bytes());
        out.extend_from_slice(&u16::try_from(self.extra.len()).unwrap().to_le_bytes());
        out.extend_from_slice(&[0; 10]);
        out.extend_from_slice(&self.offset_field.unwrap_or(self.low_bits()).to_le_bytes());
        out.extend_from_slice(&self.name);
        out.extend_from_slice(&self.extra);
        out
    }
}

/// An archive at exact places.
#[derive(Debug, Clone, Default)]
pub struct Archive {
    /// The rows in central-directory order.
    pub rows: Vec<Row>,
    /// More local headers that no record names as its own.
    pub headers: Vec<Row>,
    /// Bytes at offset 0, before all rows.
    pub prefix: Vec<u8>,
    /// The true place of the central directory.
    pub directory: u64,
    /// The offset field of the end record, when it is not the low 32 bits
    /// of `directory`.
    pub declared: Option<u32>,
    /// A Zip64 locator before the end record. The directory size then
    /// counts it, so rawzip still finds the records from the end record.
    pub locator: bool,
    /// The disk field of the end record.
    pub disk: u16,
    pub comment: Vec<u8>,
    /// The comment length field, when it is not the length of `comment`.
    pub comment_length: Option<u16>,
    /// Bytes after the archive comment.
    pub tail: Vec<u8>,
}

impl Archive {
    /// Writes the archive.
    ///
    /// # Panics
    ///
    /// Panics when two parts overlap: a test gives parts in free space.
    #[must_use]
    pub fn build(&self) -> SparseBytes {
        let mut output = SparseBytes::new();
        output.write_all(&self.prefix).unwrap();
        let mut parts: Vec<(u64, Vec<u8>)> = self
            .rows
            .iter()
            .chain(&self.headers)
            .filter(|row| row.header)
            .map(|row| (row.place, row.local_bytes()))
            .collect();
        parts.sort_by_key(|part| part.0);
        parts.dedup_by_key(|part| part.0);
        for (place, bytes) in parts {
            output.hole(place - output.len());
            output.write_all(&bytes).unwrap();
        }
        output.hole(self.directory - output.len());
        let mut records = Vec::new();
        for row in &self.rows {
            records.extend_from_slice(&row.record_bytes());
        }
        if self.locator {
            records.extend_from_slice(&0x0706_4b50u32.to_le_bytes());
            records.extend_from_slice(&0u32.to_le_bytes());
            records.extend_from_slice(&self.directory.to_le_bytes());
            records.extend_from_slice(&1u32.to_le_bytes());
        }
        output.write_all(&records).unwrap();
        let count = u16::try_from(self.rows.len()).unwrap();
        let mut end = Vec::new();
        end.extend_from_slice(&0x0605_4b50u32.to_le_bytes());
        end.extend_from_slice(&self.disk.to_le_bytes());
        end.extend_from_slice(&0u16.to_le_bytes());
        end.extend_from_slice(&count.to_le_bytes());
        end.extend_from_slice(&count.to_le_bytes());
        end.extend_from_slice(&u32::try_from(records.len()).unwrap().to_le_bytes());
        #[expect(
            clippy::cast_possible_truncation,
            reason = "Keeps the low 32 bits, as a writer with no Zip64 does."
        )]
        let low_bits = self.directory as u32;
        end.extend_from_slice(&self.declared.unwrap_or(low_bits).to_le_bytes());
        let comment_length = self
            .comment_length
            .unwrap_or(u16::try_from(self.comment.len()).unwrap());
        end.extend_from_slice(&comment_length.to_le_bytes());
        end.extend_from_slice(&self.comment);
        end.extend_from_slice(&self.tail);
        output.write_all(&end).unwrap();
        output
    }
}

/// The base shape: rows `a` and `b` before 4 GiB, and `c` past it,
/// with a body that a reader can verify. The rows touch, so the file has no
/// gap. It is about 4.5 GiB.
#[must_use]
pub fn three_rows() -> Archive {
    const HEADER: u64 = 30 + 5;
    const A: u32 = 1 << 31;
    const B: u32 = 5 << 29;
    let (a, b) = (u64::from(A), u64::from(B));
    let body = b"The row past 4 GiB can be read.\n";
    let second = HEADER + a;
    let third = second + HEADER + b;
    Archive {
        rows: vec![
            Row::new("a.bin", 0).sized(A),
            Row::new("b.bin", second).sized(B),
            Row::new("c.txt", third).body(body),
        ],
        directory: third + HEADER + body.len() as u64,
        ..Archive::default()
    }
}

/// A hostile archive that uses all reads of the parse.
///
/// Its `rows` rows have no local header, and each moves to one low local
/// header of 0 bytes. Then `docs/a.txt` and `docs/b.txt` come at
/// `WRAP + 100,000`. The data of `a.txt` holds the local header and the data
/// of `b.txt`, and each CRC-32 is true.
///
/// # Panics
///
/// Panics if a generated size does not fit its field.
#[must_use]
pub fn after_the_limit(rows: usize) -> Archive {
    const AT: u64 = WRAP + 100_000;
    const PADDING: usize = 40;
    const NAME_A: &str = "docs/a.txt";
    let inner_data = vec![b'b'; 5_000];
    let b_place = AT + 30 + NAME_A.len() as u64 + PADDING as u64;
    let inner = Row::new("docs/b.txt", b_place).body(&inner_data);
    let mut body = vec![b'.'; PADDING];
    body.extend_from_slice(&inner.local_bytes());
    let mut all: Vec<Row> = (0..rows)
        .map(|index| Row::new(&format!("low/row-{index:04}"), 500).no_header())
        .collect();
    all.push(Row::new(NAME_A, AT).body(&body));
    all.push(inner.no_header());
    Archive {
        rows: all,
        headers: vec![Row::new("low.bin", 500)],
        directory: AT + 100_000,
        ..Archive::default()
    }
}
