//! The checks of the fuzz targets. The targets in `fuzz_targets/` call
//! them. The tests in this file run them on the corpus without libFuzzer.

use std::cell::Cell;

use rawzip::ReaderAt;
use zipscope_core::contract::{CHUNK_BYTES, Column, NONE, PAGE_BYTES, health, marks};
use zipscope_core::ingest::{Ingest, Status};
use zipscope_core::text;
use zipscope_core::tree::{MAX_DEPTH, MAX_FOLDERS, ROOT};
use zipscope_core::wrap::{WRAP_BYTES, Wrap};
use zipscope_layout::end::{MAX_OPEN_BYTES, MAX_OPEN_READS, open_end};

/// The fixed part of a central-directory record.
const RECORD_BYTES: usize = 46;
/// A name is at most 65,535 bytes. Lossy decoding makes each byte at most
/// 3 bytes (U+FFFD).
const MAX_NAME_BYTES: usize = 3 * u16::MAX as usize;

/// Allocated bytes that do not depend on the input: the entries buffer,
/// the first page and the first chunks of the two arenas, and slack.
const FIXED_BYTES: usize = 256 * 1024 + PAGE_BYTES + 2 * CHUNK_BYTES + (1 << 20);

/// Allocated bytes for each input byte. A depth bomb makes up to 256
/// folders from a 46 + 512 byte record; one folder costs about 100 bytes
/// in wasm, and vectors can have twice their length.
const BYTES_PER_INPUT_BYTE: usize = 128;

/// Parses archive bytes into the store, the tree and the health checks.
///
/// Checks that nothing panics, that parsing ends, that the rows, the name
/// arena and all allocated memory stay proportional to the input, that the
/// tree shows each row one time within the depth and folder caps, and that
/// the health vector agrees with the `marks` column.
///
/// # Panics
///
/// Panics if parsing exceeds its input bounds or the progress is not valid.
pub fn ingest(data: &[u8]) {
    // One `Ingest` for each input, because `Ingest::open` keeps a buffer until
    // the process ends.
    if !ingest_past_4_gib(data) {
        ingest_bytes(data);
    }
}

/// A file of two parts: the first part at offset 0, and the second part at
/// 4 GiB. All other bytes are zero. It takes the path of the offsets that
/// wrap at 4 GiB, with no 4 GiB of memory.
#[derive(Debug)]
struct TwoParts {
    head: Vec<u8>,
    tail: Vec<u8>,
}

impl TwoParts {
    /// The first 2 bytes of the input give the length of the first part.
    fn new(data: &[u8]) -> Option<TwoParts> {
        let (length, rest) = data.split_first_chunk::<2>()?;
        let split = usize::from(u16::from_le_bytes(*length)).min(rest.len());
        let (head, tail) = rest.split_at(split);
        Some(TwoParts {
            head: head.to_vec(),
            tail: tail.to_vec(),
        })
    }

    fn size(&self) -> u64 {
        WRAP_BYTES + self.tail.len() as u64
    }
}

impl ReaderAt for TwoParts {
    fn read_at(&self, buf: &mut [u8], offset: u64) -> std::io::Result<usize> {
        if offset >= self.size() {
            return Ok(0);
        }
        // At most up to the start of the next part.
        let (part, skip, room) = if offset >= WRAP_BYTES {
            let skip = usize::try_from(offset - WRAP_BYTES).expect("the tail is small");
            (&self.tail[..], skip, self.tail.len() - skip)
        } else {
            let skip = usize::try_from(offset.min(self.head.len() as u64)).expect("small");
            let room = usize::try_from(WRAP_BYTES - offset)
                .unwrap_or(usize::MAX)
                .min(buf.len());
            (&self.head[..], skip, room)
        };
        let count = buf.len().min(room);
        let from_part = count.min(part.len() - skip);
        buf[..from_part].copy_from_slice(&part[skip..skip + from_part]);
        buf[from_part..count].fill(0);
        Ok(count)
    }
}

/// True when the two parts have the shape of offsets that wrap. The check
/// keeps no memory, and `Ingest::open` keeps a buffer until the process ends.
/// Most inputs do not have the shape, so most inputs do not pay for the path.
fn has_wrapped_shape(parts: &TwoParts) -> bool {
    // With no end signature in the second part, rawzip looks through 1 MiB of
    // zero bytes for it, and this is most of the time of such an input.
    if !parts.tail.windows(4).any(|bytes| bytes == b"PK\x05\x06") {
        return false;
    }
    open_end(parts, parts.size()).is_ok_and(|opened| Wrap::detect(&opened.archive).is_some())
}

/// Parses `TwoParts` of an input with the shape. Checks that nothing panics,
/// that the health vector agrees with the `marks` column, that a row that
/// moved has a local header at its place, that the byte map keeps its rules,
/// and the rule of the two workers: a row with no mark reads at its listed
/// offset. The read worker refuses a row with the mark. Returns false when
/// the input does not have the shape.
fn ingest_past_4_gib(data: &[u8]) -> bool {
    let Some(parts) = TwoParts::new(data) else {
        return false;
    };
    if !has_wrapped_shape(&parts) {
        return false;
    }
    let size = parts.size();
    // `Ingest` keeps its buffer until the process ends. A buffer for the size
    // of the input holds each record of the input, and its small size keeps
    // many inputs of this path below the memory limit of libFuzzer.
    let buffer = data.len().max(1 << 12);
    let Ok(mut ingest) = Ingest::with_buffer(parts, size, buffer) else {
        return false;
    };
    while *ingest.status() == Status::Parsing {
        ingest.parse(16);
    }
    ingest.finish_checks();
    check_health(&ingest);
    let Some(parts) = TwoParts::new(data) else {
        return true;
    };
    let store = ingest.store();
    // A row costs at most 2 reads here, because this file has one window. All
    // places of an archive of at most 1,024 rows come from the reads, and each
    // of them holds a local header.
    let rows_with_reads = if store.rows() <= 1 << 10 {
        store.rows()
    } else {
        0
    };
    for row in 0..rows_with_reads {
        if store.marks(row) & marks::WRAPPED_OFFSET == 0 {
            continue;
        }
        let place = to_u64(store.value(row, Column::LocalHeaderOffset));
        assert!(place + 30 <= ingest.directory_offset(), "row {row}");
        let mut signature = [0u8; 4];
        assert_eq!(parts.read_at(&mut signature, place).unwrap(), 4);
        assert_eq!(u32::from_le_bytes(signature), 0x0403_4b50, "row {row}");
    }
    check_layout(&ingest, &parts, size);
    check_reads_at_listed_places(&ingest, &parts, size);
    true
}

/// The rule of the two workers: each row with no mark that rawzip can open has
/// its data after the local header at its listed offset. Thus a row that reads
/// is at the place that the listing, the byte map and the overlap check use.
/// `crates/read/tests/wrapped_offset.rs` has the same check with `Directory`
/// of the read worker. This one calls the helper as `Directory` does, because
/// `Directory::open` keeps a buffer until the process ends, and this harness
/// keeps its memory small for each input.
fn check_reads_at_listed_places(ingest: &Ingest<TwoParts>, parts: &TwoParts, size: u64) {
    let Ok(opened) = open_end(parts, size) else {
        panic!("the ingest opened an archive that the helper cannot open");
    };
    let archive = opened.archive;
    let store = ingest.store();
    let mut records = vec![0u8; 256 * 1024];
    let mut entries = archive.entries(&mut records);
    for row in 0..store.rows() {
        let Ok(Some(record)) = entries.next_entry() else {
            panic!("rawzip has no row {row}");
        };
        if store.marks(row) & marks::WRAPPED_OFFSET != 0 {
            continue;
        }
        let Ok(entry) = archive.get_entry(record.wayfinder()) else {
            continue;
        };
        let listed = to_u64(store.value(row, Column::LocalHeaderOffset));
        let mut head = [0u8; 30];
        parts
            .read_exact_at(&mut head, listed)
            .expect("rawzip read this header");
        let name = u64::from(u16::from_le_bytes([head[26], head[27]]));
        let extra = u64::from(u16::from_le_bytes([head[28], head[29]]));
        assert_eq!(
            entry.compressed_data_range().0,
            listed + 30 + name + extra,
            "row {row} reads at another place than its listed offset"
        );
    }
}

/// A reader that counts its reads and their bytes.
#[derive(Debug)]
struct Counted<'a> {
    data: &'a [u8],
    reads: Cell<u64>,
    bytes: Cell<u64>,
}

impl ReaderAt for Counted<'_> {
    fn read_at(&self, buf: &mut [u8], offset: u64) -> std::io::Result<usize> {
        self.reads.set(self.reads.get() + 1);
        let count = self.data.read_at(buf, offset)?;
        self.bytes.set(self.bytes.get() + count as u64);
        Ok(count)
    }
}

/// One open makes at most the reads and the bytes that the docs give, for each
/// file.
fn check_open_budget(data: &[u8]) {
    let counted = Counted {
        data,
        reads: Cell::new(0),
        bytes: Cell::new(0),
    };
    let _ = open_end(&counted, data.len() as u64);
    assert!(counted.reads.get() <= MAX_OPEN_READS, "{:?}", counted.reads);
    assert!(counted.bytes.get() <= MAX_OPEN_BYTES, "{:?}", counted.bytes);
}

/// The checks of `ingest` on the bytes of one plain file.
fn ingest_bytes(data: &[u8]) {
    check_open_budget(data);
    // The first byte sets the batch size, so batch edges move.
    let batch = data.first().map_or(1, |byte| u32::from(*byte % 64) + 1);
    // `Ingest` keeps its buffer until the process ends. A buffer for the size of
    // the input holds each record of the input, and its small size keeps the
    // seed test and libFuzzer below their memory limits.
    let buffer = data.len().max(1 << 12);
    let Ok(mut ingest) = Ingest::with_buffer(data.to_vec(), data.len() as u64, buffer) else {
        return;
    };

    let max_rows = data.len() / RECORD_BYTES;
    let max_batches = max_rows / batch as usize + 2;
    let mut batches = 0;
    let mut progress = ingest.progress();
    while *ingest.status() == Status::Parsing {
        let added = ingest.parse(batch);
        ingest.refresh_views();
        batches += 1;
        assert!(added <= batch);
        assert!(batches <= max_batches, "parsing does not end");
        let next = ingest.progress();
        assert!((0.0..=1.0).contains(&next), "progress {next}");
        assert!(next >= progress, "progress goes back: {progress} to {next}");
        progress = next;
    }

    let store = ingest.store();
    assert!(
        store.rows() <= max_rows,
        "{} rows from {} bytes",
        store.rows(),
        data.len()
    );
    let name_bytes: usize = (0..store.rows()).map(|row| store.name(row).len()).sum();
    assert!(name_bytes <= 3 * data.len());
    // Each chunk before the last is full to within one name.
    let chunks = store.names().chunk_count();
    assert!(chunks <= 1 + name_bytes / (CHUNK_BYTES - MAX_NAME_BYTES));
    for row in 0..store.rows() {
        assert!(
            std::str::from_utf8(store.name(row)).is_ok(),
            "row {row} is not UTF-8"
        );
    }
    check_tree(&ingest);
    ingest.finish_checks();
    check_health(&ingest);
    check_layout(&ingest, &data, data.len() as u64);
    let allocated = ingest.allocated_bytes();
    // Arena chunks are 4 MiB each, so count the names as full chunks.
    let limit = FIXED_BYTES + BYTES_PER_INPUT_BYTE * data.len() + chunks * CHUNK_BYTES;
    assert!(
        allocated <= limit,
        "{allocated} bytes allocated for {} input bytes",
        data.len()
    );
}

/// Checks the facts about the place of a directory against the rows and the end
/// record.
#[expect(
    clippy::cast_precision_loss,
    reason = "The values of the fuzz inputs are small."
)]
fn check_places<R: ReaderAt>(ingest: &Ingest<R>) {
    let store = ingest.store();
    let fields = ingest.health_vector();
    let declared = fields[health::END_DECLARED_DIRECTORY];
    if declared != 0.0 {
        assert!(declared > fields[health::END_FOUND_DIRECTORY]);
    } else {
        assert_eq!(fields[health::END_FOUND_DIRECTORY], 0.0);
    }
    if fields[health::END_EARLIER_RECORDS] == 0.0 {
        assert_eq!(fields[health::END_EARLIER_RECORD], 0.0);
        assert_eq!(fields[health::END_EARLIER_DIRECTORY], 0.0);
        return;
    }
    assert_eq!(*ingest.status(), Status::Complete);
    let record = fields[health::END_EARLIER_RECORD];
    assert!(record < ingest.eocd_offset() as f64);
    assert!(fields[health::END_EARLIER_DIRECTORY] < record);
    for row in 0..store.rows() {
        let start = store.value(row, Column::LocalHeaderOffset);
        let end = start + 30.0 + store.value(row, Column::CompressedSize);
        assert!(record < start || record >= end, "row {row} covers {record}");
    }
}

/// Checks that each count in the health vector is the number of rows with
/// its mark, that each example has the mark, and that the overlap and
/// duplicate checks are complete.
fn check_health<R: ReaderAt>(ingest: &Ingest<R>) {
    let store = ingest.store();
    let fields = ingest.health_vector();
    assert_eq!(fields[health::OVERLAPS_CHECKED], 1.0);
    assert_eq!(fields[health::DUPLICATES_CHECKED], 1.0);
    for (rows, bit) in [
        (health::DUPLICATE_ROWS, marks::DUPLICATE_NAME),
        (health::BOMB_ROWS, marks::BOMB_RATIO),
        (health::OVERLAP_ROWS, marks::OVERLAP),
        (health::DEPTH_CAP_ROWS, marks::DEPTH_CAP),
        (health::FOLDER_CAP_ROWS, marks::FOLDER_CAP),
        (health::CONTROL_NAME_ROWS, marks::CONTROL_NAME),
        (health::WRAPPED_ROWS, marks::WRAPPED_OFFSET),
    ] {
        let marked: Vec<usize> = (0..store.rows())
            .filter(|&row| store.marks(row) & bit != 0)
            .collect();
        let count = u32::try_from(marked.len()).expect("rows fit in u32");
        assert_eq!(fields[rows], f64::from(count), "field {rows}");
        let example = marked
            .first()
            .map_or(-1.0, |&row| f64::from(u32::try_from(row).expect("u32")));
        assert_eq!(fields[rows + 1], example, "field {}", rows + 1);
    }
    check_ranges(ingest);
    check_places(ingest);
    // A declared count that is not the row count gets one of the two findings.
    let counts = fields[health::COUNT_MISMATCH] + fields[health::COUNT_WRAPPED];
    if *ingest.status() == Status::Complete {
        let rows = store.rows() as u64;
        let differ = ingest.entries_hint() != rows;
        assert_eq!(counts, f64::from(u8::from(differ)));
        if fields[health::COUNT_WRAPPED] != 0.0 {
            assert_eq!(ingest.entries_hint(), rows % (1 << 16));
        }
    } else {
        assert_eq!(counts, 0.0);
    }
    // The stored name decides the mark of a control character.
    for row in 0..store.rows() {
        let name = std::str::from_utf8(store.name(row)).expect("the arena has UTF-8");
        assert_eq!(
            store.marks(row) & marks::CONTROL_NAME != 0,
            text::counts_as_control(name),
            "row {row}"
        );
    }
}

/// Checks the marks of the overlap check against a simple rule that uses all
/// rows, and the count of data that runs into the central directory against the
/// `Ingest` count. Each row has the range `[offset, offset + 30 + compressed)`.
fn check_ranges<R: ReaderAt>(ingest: &Ingest<R>) {
    let store = ingest.store();
    let fields = ingest.health_vector();
    let into_directory = ingest.into_directory_from(0);
    assert_eq!(
        fields[health::INTO_DIRECTORY_ROWS],
        f64::from(u32::try_from(into_directory).expect("rows fit in u32"))
    );
    assert_eq!(
        fields[health::INTO_DIRECTORY_EXAMPLE] >= 0.0,
        into_directory != 0
    );
    let mut ranges: Vec<(u64, u64, usize)> = Vec::with_capacity(store.rows());
    let mut with_data: Vec<(u64, u64, usize)> = Vec::new();
    for row in 0..store.rows() {
        let start = store.value(row, Column::LocalHeaderOffset);
        let compressed = store.value(row, Column::CompressedSize);
        // The live check uses the exact values, and the store is exact to 2^53.
        if start + compressed >= 9_007_199_254_740_000.0 {
            return;
        }
        let start = to_u64(start);
        let range = (start, start + 30 + to_u64(compressed), row);
        ranges.push(range);
        if compressed != 0.0 {
            with_data.push(range);
        }
    }
    let marked: Vec<usize> = (0..store.rows())
        .filter(|&row| store.marks(row) & marks::OVERLAP != 0)
        .collect();
    assert_eq!(overlapping_rows(&mut ranges), marked);
    let data = overlapping_rows(&mut with_data);
    assert_eq!(
        fields[health::OVERLAP_DATA_ROWS],
        f64::from(u32::try_from(data.len()).expect("rows fit in u32"))
    );
    let example = data
        .first()
        .map_or(-1.0, |&row| f64::from(u32::try_from(row).expect("u32")));
    assert_eq!(fields[health::OVERLAP_DATA_EXAMPLE], example);
    assert!(data.iter().all(|row| marked.binary_search(row).is_ok()));
}

/// Returns the rows, in order, whose range overlaps another of these ranges.
fn overlapping_rows(ranges: &mut [(u64, u64, usize)]) -> Vec<usize> {
    ranges.sort_unstable();
    let mut rows = Vec::new();
    let mut max_end = 0;
    for (at, &(start, end, row)) in ranges.iter().enumerate() {
        let after_it = ranges.get(at + 1).is_some_and(|next| next.0 < end);
        if (at > 0 && start < max_end) || after_it {
            rows.push(row);
        }
        max_end = max_end.max(end);
    }
    rows.sort_unstable();
    rows
}

#[expect(
    clippy::cast_possible_truncation,
    clippy::cast_sign_loss,
    reason = "Store values are exact to 2^53. A larger value saturates, as in the read worker."
)]
fn to_u64(value: f64) -> u64 {
    value as u64
}

/// Makes the byte map from the rows of the store, as the read worker does,
/// and checks that its regions cover the file without overlap, that each
/// gap is counted, and that the list of regions stays small.
fn check_layout<A: ReaderAt, R: ReaderAt>(ingest: &Ingest<A>, reader: &R, size: u64) {
    let Ok(opened) = open_end(reader, size) else {
        panic!("the ingest opened an archive that the map cannot open");
    };
    let archive = opened.archive;
    let store = ingest.store();
    let rows = (0..store.rows()).map(|row| zipscope_layout::EntrySpan {
        local_header_offset: to_u64(store.value(row, Column::LocalHeaderOffset)),
        compressed_size: to_u64(store.value(row, Column::CompressedSize)),
        uncompressed_size: to_u64(store.value(row, Column::UncompressedSize)),
        crc32: u32::try_from(to_u64(store.value(row, Column::Crc32))).expect("CRC-32 is u32"),
        flags: u16::try_from(to_u64(store.value(row, Column::Flags))).expect("flags are u16"),
    });
    let (facts, layout) =
        zipscope_layout::map(&archive, size, reader, rows).expect("the map fits in memory");
    if let Err(rule) = layout.validate(size) {
        panic!("the byte map breaks a rule: {rule}\n{:?}", layout.regions);
    }
    assert_eq!(layout.counts.rows, store.rows() as u64);
    assert!(layout.regions.len() <= 2 * (zipscope_layout::MAX_LISTED_GAPS + 1) + 8);
    assert!(
        facts.comment.len() < 1 << 16,
        "the comment is longer than 65,535 bytes"
    );
    assert_eq!(facts.directory_offset, ingest.directory_offset());
    assert_eq!(facts.end_record_offset, ingest.eocd_offset());
}

/// Checks that every row shows one time in the tree, as an entry of one
/// folder or as the explicit row of one folder, and that no path is deeper
/// than `MAX_DEPTH`.
fn check_tree(ingest: &Ingest<Vec<u8>>) {
    let tree = ingest.tree();
    let rows = ingest.store().rows();
    assert!(tree.folder_count() <= MAX_FOLDERS);
    let mut seen = vec![0u8; rows];
    let mut depths = vec![0usize; tree.folder_count()];
    for (index, folder) in tree.folders().iter().enumerate().skip(1) {
        let parent = folder.parent as usize;
        assert!(parent < index, "folder {index} has a later parent");
        depths[index] = depths[parent] + 1;
        assert!(depths[index] <= MAX_DEPTH, "folder {index} is too deep");
    }
    for (index, folder) in tree.folders().iter().enumerate() {
        if folder.explicit_row != NONE {
            seen[folder.explicit_row as usize] += 1;
        }
        let id = u32::try_from(index).expect("folder ids fit in u32");
        for row in tree.entries(id) {
            seen[row as usize] += 1;
        }
    }
    assert!(
        seen.iter().all(|&count| count == 1),
        "a row is lost or repeated"
    );
    let root = tree.rollup(ROOT).entry_count;
    assert!((root - f64::from(u32::try_from(rows).expect("rows fit in u32"))).abs() < 0.5);
    let listing = ingest.views().listing().len();
    assert!(listing <= rows + tree.folder_count());
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    /// Runs the check on each file in `corpus/ingest/`: the regression
    /// inputs, and the inputs that `mise run fuzz` keeps.
    #[test]
    fn ingest_accepts_the_regression_corpus() {
        let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("corpus/ingest");
        let mut files = 0;
        for entry in std::fs::read_dir(&dir).expect("fuzz/corpus/ingest") {
            let path = entry.unwrap().path();
            if path.is_file() {
                super::ingest(&std::fs::read(&path).unwrap());
                files += 1;
            }
        }
        assert!(files >= 3, "only {files} regression files");
    }

    /// The regression inputs of the path past 4 GiB reach that path: each has
    /// rows with their local headers in the first part, and the central
    /// directory in the second.
    #[test]
    fn the_regression_inputs_move_rows() {
        for (file, moved, overlaps) in [
            ("regression-wrapped-offsets.zip", 1, 0),
            ("regression-wrapped-rows.zip", 6, 0),
            ("regression-wrapped-aliases.zip", 5, 5),
            ("regression-wrapped-overlap.zip", 2, 2),
            ("regression-wrapped-same-name.zip", 0, 0),
            ("regression-end-wrapped-stray.zip", 1, 0),
        ] {
            let path = Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("corpus/ingest")
                .join(file);
            let data = std::fs::read(path).unwrap();
            let parts = super::TwoParts::new(&data).unwrap();
            assert!(super::has_wrapped_shape(&parts), "{file}");
            let size = parts.size();
            let mut ingest = super::Ingest::open(parts, size).unwrap();
            while *ingest.status() == super::Status::Parsing {
                ingest.parse(16);
            }
            ingest.finish_checks();
            let health = ingest.health();
            assert_eq!(health.wrapped_rows, moved, "{file}");
            assert_eq!(health.overlap_rows, overlaps, "{file}");
        }
    }

    /// The regression inputs of the two facts about the place of a directory.
    #[test]
    fn the_regression_inputs_of_the_places_have_their_findings() {
        for (file, declared, earlier) in [
            ("regression-place-declared-after.zip", 150.0, 0.0),
            ("regression-place-fake-appended.zip", 0.0, 1.0),
            ("regression-place-update.zip", 0.0, 1.0),
            ("regression-place-stored-zip.zip", 0.0, 0.0),
            ("regression-place-zip64-then-fake.zip", 0.0, 1.0),
        ] {
            let path = Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("corpus/ingest")
                .join(file);
            let data = std::fs::read(path).unwrap();
            let size = data.len() as u64;
            let mut ingest = super::Ingest::open(data, size).unwrap();
            ingest.parse(u32::MAX);
            let fields = ingest.health_vector();
            assert_eq!(fields[super::health::END_DECLARED_DIRECTORY], declared, "{file}");
            assert_eq!(fields[super::health::END_EARLIER_RECORDS], earlier, "{file}");
        }
    }

    /// The regression inputs of the range of a row: the 30 bytes of a local
    /// header count at each side of a boundary.
    #[test]
    fn the_regression_inputs_of_the_ranges_have_their_findings() {
        for (file, overlaps, with_data, into_directory) in [
            ("regression-ranges-touch.zip", 0, 0, 0),
            ("regression-ranges-empty-share.zip", 3, 0, 0),
            ("regression-ranges-into-directory.zip", 0, 0, 1),
            ("regression-zip-crate-alias-empty.zip", 2, 0, 0),
            ("regression-zip-crate-alias-data.zip", 2, 2, 0),
        ] {
            let path = Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("corpus/ingest")
                .join(file);
            let data = std::fs::read(path).unwrap();
            let size = data.len() as u64;
            let mut ingest = super::Ingest::open(data, size).unwrap();
            ingest.parse(u32::MAX);
            ingest.finish_checks();
            let health = ingest.health();
            assert_eq!(health.overlap_rows, overlaps, "{file}");
            assert_eq!(health.overlap_data_rows, with_data, "{file}");
            assert_eq!(health.into_directory_rows, into_directory, "{file}");
        }
    }

    /// A plain archive does not have the shape.
    #[test]
    fn a_plain_input_does_not_take_the_path() {
        let parts = super::TwoParts::new(b"\x00\x00not an archive").unwrap();
        assert!(!super::has_wrapped_shape(&parts));
    }

    /// Runs the check on each seed file, and on each prefix and each
    /// one-byte change of it. `mise run gen:corpus` writes the seeds.
    #[test]
    fn ingest_accepts_the_seeds_and_their_changes() {
        let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("../target/corpus/rawzip");
        let mut files = 0;
        for entry in std::fs::read_dir(&dir).expect("run `mise run gen:corpus`") {
            let data = std::fs::read(entry.unwrap().path()).unwrap();
            for end in 0..=data.len() {
                super::ingest(&data[..end]);
            }
            for index in 0..data.len() {
                let mut changed = data.clone();
                changed[index] ^= 0xff;
                super::ingest(&changed);
            }
            files += 1;
        }
        assert!(files >= 30, "only {files} seed files");
    }
}
