//! A sparse byte buffer. It keeps only the written bytes, so an archive with
//! entries past 4 GiB uses only some kilobytes of memory and disk.

use std::cell::Cell;
use std::fs::File;
use std::io::{self, Seek, SeekFrom, Write};
use std::path::Path;
use std::rc::Rc;

use rawzip::ReaderAt;

/// Bytes at known offsets. All other bytes up to `len` are zero.
///
/// Writes append at the end. When the hole switch is on, a write only moves
/// the end: the writer must give zero bytes in that mode.
#[derive(Debug, Default, Clone)]
pub struct SparseBytes {
    segments: Vec<(u64, Vec<u8>)>,
    len: u64,
    hole: Rc<Cell<bool>>,
}

impl SparseBytes {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Returns the switch for hole mode. It stays usable while a writer
    /// borrows the buffer.
    #[must_use]
    pub fn hole_switch(&self) -> Rc<Cell<bool>> {
        Rc::clone(&self.hole)
    }

    /// Returns the length, holes included.
    #[must_use]
    pub fn len(&self) -> u64 {
        self.len
    }

    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.len == 0
    }

    /// Writes `bytes` over the last kept bytes.
    ///
    /// # Panics
    ///
    /// Panics if the last segment is shorter than `bytes`, or if a hole is
    /// after it.
    pub fn overwrite_end(&mut self, bytes: &[u8]) {
        let (offset, last) = self.segments.last_mut().expect("a kept segment");
        assert_eq!(*offset + last.len() as u64, self.len);
        let start = last.len() - bytes.len();
        last[start..].copy_from_slice(bytes);
    }

    /// Moves the end by `bytes` zero bytes that are not kept.
    pub fn hole(&mut self, bytes: u64) {
        self.len += bytes;
    }

    /// Returns the number of bytes that are kept.
    #[must_use]
    pub fn stored_bytes(&self) -> usize {
        self.segments.iter().map(|(_, bytes)| bytes.len()).sum()
    }

    /// Writes the buffer to a file. The holes become file holes, so the file
    /// uses almost no disk on file systems with sparse files (APFS, ext4).
    ///
    /// # Errors
    ///
    /// Returns an error if the file cannot be written or synchronized.
    pub fn write_to_file(&self, path: &Path) -> io::Result<()> {
        let mut file = File::create(path)?;
        for (offset, bytes) in &self.segments {
            file.seek(SeekFrom::Start(*offset))?;
            file.write_all(bytes)?;
        }
        file.set_len(self.len)?;
        file.sync_all()
    }
}

impl Write for SparseBytes {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        if !self.hole.get() && !buf.is_empty() {
            match self.segments.last_mut() {
                Some((offset, bytes)) if *offset + bytes.len() as u64 == self.len => {
                    bytes.extend_from_slice(buf);
                }
                _ => self.segments.push((self.len, buf.to_vec())),
            }
        }
        self.len += buf.len() as u64;
        Ok(buf.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

impl ReaderAt for SparseBytes {
    fn read_at(&self, buf: &mut [u8], offset: u64) -> io::Result<usize> {
        if offset >= self.len {
            return Ok(0);
        }
        let read = buf
            .len()
            .min(usize::try_from(self.len - offset).unwrap_or(usize::MAX));
        let buf = &mut buf[..read];
        buf.fill(0);
        let end = offset + read as u64;
        // The first segment that ends after `offset`.
        let first = self
            .segments
            .partition_point(|(start, bytes)| start + bytes.len() as u64 <= offset);
        for (start, bytes) in &self.segments[first..] {
            if *start >= end {
                break;
            }
            let from = offset.max(*start);
            let to = end.min(start + bytes.len() as u64);
            buf[usize::try_from(from - offset).unwrap()..usize::try_from(to - offset).unwrap()]
                .copy_from_slice(
                    &bytes[usize::try_from(from - start).unwrap()
                        ..usize::try_from(to - start).unwrap()],
                );
        }
        Ok(read)
    }
}

/// Returns the CRC-32 of `len` zero bytes, without reading them.
///
/// Each zero byte is a linear operation on the CRC register in GF(2). The
/// function raises the matrix of that operation to the power `len`.
#[must_use]
pub fn zero_crc32(len: u64) -> u32 {
    type Matrix = [u32; 32];

    fn times(matrix: &Matrix, mut vector: u32) -> u32 {
        let mut sum = 0;
        let mut row = 0;
        while vector != 0 {
            if vector & 1 != 0 {
                sum ^= matrix[row];
            }
            vector >>= 1;
            row += 1;
        }
        sum
    }

    fn square(matrix: &Matrix) -> Matrix {
        let mut result = [0; 32];
        for (row, value) in result.iter_mut().enumerate() {
            *value = times(matrix, matrix[row]);
        }
        result
    }

    // The operation for one zero bit (reflected polynomial 0xEDB88320).
    let mut operation: Matrix = [0; 32];
    operation[0] = 0xEDB8_8320;
    for (row, value) in operation.iter_mut().enumerate().skip(1) {
        *value = 1 << (row - 1);
    }
    // One zero byte is eight zero bits.
    for _ in 0..3 {
        operation = square(&operation);
    }

    let mut register = 0xFFFF_FFFF;
    let mut remaining = len;
    while remaining != 0 {
        if remaining & 1 != 0 {
            register = times(&operation, register);
        }
        operation = square(&operation);
        remaining >>= 1;
    }
    register ^ 0xFFFF_FFFF
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn zero_crc_is_the_crc_of_zeros() {
        for len in [0, 1, 2, 7, 100, 4096, 65_537] {
            assert_eq!(
                zero_crc32(len),
                rawzip::crc32(&vec![0; usize::try_from(len).unwrap()]),
                "{len}"
            );
        }
    }

    #[test]
    fn reads_a_hole_with_more_than_four_gib_remaining() {
        let mut sparse = SparseBytes::new();
        let hole = sparse.hole_switch();
        hole.set(true);
        let zeros = vec![0; 1 << 20];
        for _ in 0..4096 {
            sparse.write_all(&zeros).unwrap();
        }
        hole.set(false);
        sparse.write_all(b"tail").unwrap();

        let mut buf = [9; 8];
        assert_eq!(sparse.read_at(&mut buf, 0).unwrap(), 8);
        assert_eq!(buf, [0; 8]);
        assert_eq!(sparse.read_at(&mut buf, (1 << 32) - 4).unwrap(), 8);
        assert_eq!(&buf, b"\0\0\0\0tail");
    }

    #[test]
    fn reads_holes_as_zeros() {
        let mut sparse = SparseBytes::new();
        sparse.write_all(b"abc").unwrap();
        let hole = sparse.hole_switch();
        hole.set(true);
        sparse.write_all(&[0; 5]).unwrap();
        hole.set(false);
        sparse.write_all(b"de").unwrap();
        assert_eq!(sparse.len(), 10);
        assert_eq!(sparse.stored_bytes(), 5);

        let mut buf = [9; 12];
        assert_eq!(sparse.read_at(&mut buf, 0).unwrap(), 10);
        assert_eq!(&buf[..10], b"abc\0\0\0\0\0de");
        let mut buf = [9; 4];
        assert_eq!(sparse.read_at(&mut buf, 2).unwrap(), 4);
        assert_eq!(&buf, b"c\0\0\0");
        assert_eq!(sparse.read_at(&mut buf, 10).unwrap(), 0);
    }
}
