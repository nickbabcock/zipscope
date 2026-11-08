//! The interim wayfinder table.
//!
//! rawzip gives a wayfinder only from a parsed
//! central-directory record. Thus the read worker iterates the central
//! directory one time and keeps one wayfinder for each row. Replace this
//! pass when rawzip can make a wayfinder from stored fields.

use rawzip::{ReaderAt, ZipArchive, ZipArchiveEntryWayfinder, ZipEntries};
use zipscope_layout::end::{EndReader, open_end};

/// The rawzip buffer for central-directory records. It is the same as
/// `ENTRIES_BUFFER_BYTES` of the core, so that both passes find the same
/// records and stop at the same error.
pub const ENTRIES_BUFFER_BYTES: usize = 256 * 1024;
const _: () = assert!(ENTRIES_BUFFER_BYTES >= rawzip::MAX_CENTRAL_DIRECTORY_RECORD_SIZE);

/// Where the data and the central-directory record of one row are.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Located {
    pub wayfinder: ZipArchiveEntryWayfinder,
    /// The offset of the central-directory record of the row.
    pub record_offset: u64,
}

/// The state of the pass over the central directory.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Scan {
    /// More records can follow.
    Scanning,
    /// The central directory ended.
    Complete,
    /// The pass stopped with an error. The rows before it stay.
    Failed(String),
}

/// The rows in one chunk of the wayfinder table. A chunk is 2.5 MiB (a row
/// is 40 bytes).
pub const CHUNK_ROWS: usize = 1 << 16;

/// The bytes of one chunk of the wayfinder table.
pub const CHUNK_BYTES: usize = CHUNK_ROWS * size_of::<Located>();

/// The archive and its wayfinder table.
///
/// The table is in chunks of [`CHUNK_ROWS`] rows, which are allocated one
/// at a time, never by doubling. Thus one scan step grows the memory by at
/// most one chunk and the index of chunks, whatever the row count is.
#[derive(Debug)]
pub struct Directory<R: 'static> {
    archive: &'static ZipArchive<EndReader<R>>,
    entries: ZipEntries<'static, 'static, EndReader<R>>,
    chunks: Vec<Vec<Located>>,
    rows: usize,
    scan: Scan,
    size: u64,
}

/// Interim until rawzip has a resumable cursor, as in the core:
/// the iterator borrows the archive and its buffer, so both are leaked. The
/// read worker stops when the archive closes, and the wasm instance gives the
/// memory back.
fn leak_entries<R: ReaderAt + 'static>(
    archive: ZipArchive<R>,
    buffer: Vec<u8>,
) -> (&'static ZipArchive<R>, ZipEntries<'static, 'static, R>) {
    let archive: &'static ZipArchive<R> = Box::leak(Box::new(archive));
    let buffer: &'static mut [u8] = Box::leak(buffer.into_boxed_slice());
    (archive, archive.entries(buffer))
}

impl<R: ReaderAt + 'static> Directory<R> {
    /// Finds the end of the central directory.
    ///
    /// # Errors
    ///
    /// Returns an error if the reader fails or the end of the central
    /// directory is not found.
    pub fn open(reader: R, size: u64) -> Result<Self, rawzip::Error> {
        let buffer = crate::heap::try_buffer(ENTRIES_BUFFER_BYTES)
            .map_err(|err| rawzip::Error::from(rawzip::ErrorKind::IO(err)))?;
        let archive = open_end(reader, size)?.archive;
        let (archive, entries) = leak_entries(archive, buffer);
        // The table grows only with records that are read. The entry count
        // of the archive is not trusted.
        Ok(Directory {
            archive,
            entries,
            chunks: Vec::new(),
            rows: 0,
            scan: Scan::Scanning,
            size,
        })
    }

    /// Reads up to `max_records` records into the table. Returns how many it
    /// added. One call makes at most one allocation of the table, of at
    /// most one chunk ([`Directory::growth`] gives its size): it stops when
    /// the table is full again. It returns 0 and reads nothing when the
    /// allocation does not fit below the memory limit.
    pub fn scan(&mut self, max_records: u32) -> u32 {
        let mut added = 0;
        let mut grew = false;
        while added < max_records && self.scan == Scan::Scanning {
            if self.rows == self.capacity() {
                let wanted = (max_records - added) as usize;
                if grew || !self.grow(wanted) {
                    break;
                }
                grew = true;
            }
            match self.entries.next_entry() {
                Ok(Some(record)) => {
                    let located = Located {
                        wayfinder: record.wayfinder(),
                        record_offset: record.central_directory_offset(),
                    };
                    if let Some(chunk) = self.chunks.last_mut() {
                        chunk.push(located);
                    }
                    self.rows += 1;
                    added += 1;
                }
                Ok(None) => self.scan = Scan::Complete,
                Err(err) => self.scan = Scan::Failed(err.to_string()),
            }
        }
        added
    }

    /// The rows that the next growth of the table gives, for a scan of
    /// `wanted` records: the last chunk grows by doubling up to
    /// [`CHUNK_ROWS`], and a full chunk starts a new one.
    fn next_rows(&self, wanted: usize) -> (bool, usize) {
        match self.chunks.last() {
            Some(chunk) if chunk.capacity() < CHUNK_ROWS => {
                let target = (chunk.capacity() * 2)
                    .max(chunk.len() + wanted)
                    .min(CHUNK_ROWS);
                (false, target - chunk.len())
            }
            _ => (true, wanted.clamp(1024, CHUNK_ROWS)),
        }
    }

    /// The most bytes that the next scan of `wanted` records allocates: 0
    /// when the table has room, else one growth of at most one chunk (a
    /// new block of the last chunk, or a new chunk and the index of chunks).
    #[must_use]
    pub fn growth(&self, wanted: usize) -> usize {
        let spare = self.capacity() - self.rows;
        if wanted <= spare {
            return 0;
        }
        let rest = wanted - spare;
        match self.chunks.last() {
            Some(chunk) if chunk.capacity() < CHUNK_ROWS => {
                let target = (chunk.capacity() * 2)
                    .max(chunk.capacity() + rest)
                    .min(CHUNK_ROWS);
                target * size_of::<Located>()
            }
            _ => {
                // The index can double, to at least 4 entries.
                let index = (self.chunks.capacity() * 2).max(4);
                rest.clamp(1024, CHUNK_ROWS) * size_of::<Located>()
                    + index * size_of::<Vec<Located>>()
            }
        }
    }

    /// Makes room for at least one more row. False when it does not fit
    /// below the memory limit.
    fn grow(&mut self, wanted: usize) -> bool {
        let (new_chunk, rows) = self.next_rows(wanted);
        if new_chunk {
            let mut chunk = Vec::new();
            if chunk.try_reserve_exact(rows).is_err() || self.chunks.try_reserve(1).is_err() {
                return false;
            }
            self.chunks.push(chunk);
            true
        } else {
            self.chunks
                .last_mut()
                .is_some_and(|chunk| chunk.try_reserve_exact(rows).is_ok())
        }
    }

    /// Returns where a row is. Reads more records when the pass has not come
    /// to the row yet. `None` when the central directory has no such row.
    pub fn locate(&mut self, row: usize) -> Option<Located> {
        while self.rows <= row && self.scan == Scan::Scanning {
            if self.scan(4096) == 0 {
                break;
            }
        }
        if row >= self.rows {
            return None;
        }
        self.chunks
            .get(row / CHUNK_ROWS)
            .and_then(|chunk| chunk.get(row % CHUNK_ROWS))
            .copied()
    }

    /// The rows in the table.
    #[must_use]
    pub fn rows(&self) -> usize {
        self.rows
    }

    /// The rows that the table holds without growth.
    #[must_use]
    pub fn capacity(&self) -> usize {
        let full = self.chunks.len().saturating_sub(1) * CHUNK_ROWS;
        full + self.chunks.last().map_or(0, Vec::capacity)
    }

    /// The state of the pass.
    #[must_use]
    pub fn status(&self) -> &Scan {
        &self.scan
    }

    /// The archive. It lives until the worker stops.
    #[must_use]
    pub fn archive(&self) -> &'static ZipArchive<EndReader<R>> {
        self.archive
    }

    /// The size of the file.
    #[must_use]
    pub fn size(&self) -> u64 {
        self.size
    }

    /// The bytes that the table holds.
    #[must_use]
    pub fn table_bytes(&self) -> usize {
        self.capacity() * size_of::<Located>() + self.chunks.capacity() * size_of::<Vec<Located>>()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testzip::{Entry, build};

    #[test]
    fn locates_each_row_in_order() {
        let entries: Vec<Entry> = (0..100)
            .map(|i| Entry::stored(format!("file-{i:03}.txt"), format!("body {i}").into_bytes()))
            .collect();
        let data = build(&entries);
        let size = data.len() as u64;
        let mut directory = Directory::open(data, size).unwrap();
        // A request for a row that the pass has not read yet reads to it.
        let row = directory.locate(42).unwrap();
        assert!(directory.rows() > 42);
        assert_eq!(row.wayfinder.uncompressed_size_hint(), 7);
        while directory.scan(10) > 0 {}
        assert_eq!(directory.status(), &Scan::Complete);
        assert_eq!(directory.rows(), 100);
        assert_eq!(directory.locate(100), None);
        // Record offsets increase in central-directory order.
        let offsets: Vec<u64> = (0..100)
            .map(|row| directory.locate(row).unwrap().record_offset)
            .collect();
        assert!(offsets.windows(2).all(|pair| pair[0] < pair[1]));
    }

    #[test]
    fn grows_the_table_one_chunk_at_a_time() {
        let entries: Vec<Entry> = (0..(2 * CHUNK_ROWS + 10))
            .map(|i| Entry::stored(format!("{i}"), Vec::new()))
            .collect();
        let data = build(&entries);
        let size = data.len() as u64;
        let mut directory = Directory::open(data, size).unwrap();
        let mut largest = 0;
        loop {
            let before = directory.table_bytes();
            let expected = directory.growth(usize::MAX);
            // A large request still allocates at most one chunk.
            let added = directory.scan(u32::MAX);
            let grown = directory.table_bytes() - before;
            assert!(grown <= CHUNK_BYTES + 1024, "{grown}");
            assert!(grown <= expected, "{grown} > {expected}");
            largest = largest.max(grown);
            if added == 0 {
                break;
            }
        }
        assert!(largest > CHUNK_BYTES / 2);
        assert_eq!(directory.capacity(), 3 * CHUNK_ROWS);
        assert_eq!(directory.rows(), 2 * CHUNK_ROWS + 10);
        assert_eq!(directory.status(), &Scan::Complete);
        let last = directory.locate(2 * CHUNK_ROWS + 9).unwrap();
        let first = directory.locate(0).unwrap();
        assert!(last.record_offset > first.record_offset);
        assert_eq!(directory.locate(2 * CHUNK_ROWS + 10), None);
    }

    #[test]
    fn rejects_a_file_that_is_not_a_zip() {
        let data = b"This is not a zip archive".to_vec();
        let size = data.len() as u64;
        Directory::open(data, size).unwrap_err();
    }

    #[test]
    fn keeps_the_rows_before_a_bad_record() {
        let entries: Vec<Entry> = (0..3)
            .map(|i| Entry::stored(format!("{i}.txt"), vec![b'a'; 4]))
            .collect();
        let mut data = build(&entries);
        // Break the signature of the third central-directory record.
        let record = crate::testzip::record_offsets(&data)[2];
        data[usize::try_from(record).unwrap()] = 0;
        let size = data.len() as u64;
        let mut directory = Directory::open(data, size).unwrap();
        while directory.scan(1) > 0 {}
        assert_eq!(directory.rows(), 2);
        assert!(matches!(directory.status(), Scan::Failed(_)));
        assert_eq!(directory.locate(2), None);
    }
}
