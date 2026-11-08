//! The one rule of an archive over 4 GiB with no Zip64: the parse decides the
//! place of a row, and the read worker refuses a row with its mark. This test
//! sees both crates: each row with no mark must read at its listed offset.
//! The refusal of a marked row is in the web code, and its tests are in
//! `web/src/read` and `web/e2e/wrapped-offset.spec.ts`.

use zipscope_core::contract::{Column, marks};
use zipscope_core::ingest::Ingest;
use zipscope_read::directory::Directory;
use zipscope_read::local;
use zipscope_read::stream::{Status, Stream};
use zipscope_testkit::sparse::SparseBytes;
use zipscope_testkit::wrapped::{Archive, GIB, Row, WRAP, after_the_limit, three_rows};

use rawzip::ReaderAt;

#[expect(
    clippy::cast_possible_truncation,
    clippy::cast_sign_loss,
    reason = "Store values are exact to 2^53."
)]
fn whole(value: f64) -> u64 {
    value as u64
}

/// Checks the rule, and returns the rows with no mark that read.
fn rows_that_read(bytes: &SparseBytes, reads: Option<u32>) -> Vec<String> {
    let size = bytes.len();
    let mut ingest = Ingest::open(bytes.clone(), size).unwrap();
    if let Some(reads) = reads {
        ingest.set_place_reads(reads);
    }
    ingest.parse(u32::MAX);
    let store = ingest.store();
    let mut directory = Directory::open(bytes.clone(), size).unwrap();
    while directory.scan(1024) > 0 {}
    assert_eq!(directory.rows(), store.rows());
    let archive = directory.archive();
    let mut readable = Vec::new();
    for row in 0..store.rows() {
        if store.marks(row) & marks::WRAPPED_OFFSET != 0 {
            continue;
        }
        let located = directory.locate(row).unwrap();
        let Ok(entry) = archive.get_entry(located.wayfinder) else {
            continue;
        };
        // The read module reads the data after the local header at the
        // listed offset.
        let listed = whole(store.value(row, Column::LocalHeaderOffset));
        let mut head = [0u8; 30];
        bytes.read_exact_at(&mut head, listed).unwrap();
        let name = u64::from(u16::from_le_bytes([head[26], head[27]]));
        let extra = u64::from(u16::from_le_bytes([head[28], head[29]]));
        assert_eq!(
            entry.compressed_data_range().0,
            listed + 30 + name + extra,
            "row {row} reads at another place than its listed offset"
        );
        readable.push(String::from_utf8(store.name(row).to_vec()).unwrap());
    }
    readable
}

fn read_all(spec: &Archive, row: usize) -> (Vec<u8>, Status) {
    let bytes = spec.build();
    let size = bytes.len();
    let mut directory = Directory::open(bytes, size).unwrap();
    let located = directory.locate(row).unwrap();
    let archive = directory.archive();
    let record = local::read_record(archive, located).unwrap();
    assert_eq!(local::check(archive, located).unwrap().mismatches, 0);
    let mut stream = Stream::open_with_window(archive, row, located, &record, u64::MAX).unwrap();
    let mut out = Vec::new();
    while stream.read(&mut out, 1 << 16) > 0 {}
    (out, stream.status().clone())
}

#[test]
fn only_the_last_row_of_the_shape_reads_and_it_verifies() {
    let spec = three_rows();
    assert_eq!(rows_that_read(&spec.build(), None), ["c.txt"]);
    let (body, status) = read_all(&spec, 2);
    assert_eq!(body, b"The row past 4 GiB can be read.\n");
    assert_eq!(status, Status::Verified);
}

#[test]
fn each_row_after_a_true_prefix_of_4_gib_reads() {
    let mut one = Row::new("one", WRAP).body(b"first");
    one.offset_field = Some(0);
    let mut two = Row::new("two", WRAP + 100).body(b"second");
    two.offset_field = Some(100);
    let spec = Archive {
        rows: vec![one, two],
        // The prefix has a header of the same name at the lower place.
        headers: vec![Row::new("one", 0).body(b"old")],
        directory: WRAP + 200,
        declared: Some(200),
        ..Archive::default()
    };
    assert_eq!(rows_that_read(&spec.build(), None), ["one", "two"]);
    assert_eq!(read_all(&spec, 0).0, b"first");
    assert_eq!(read_all(&spec, 1).0, b"second");
}

#[test]
fn a_hostile_archive_after_the_limit_reads_only_at_listed_places() {
    let spec = after_the_limit(2_048);
    assert_eq!(rows_that_read(&spec.build(), None), ["docs/b.txt"]);
    let (body, status) = read_all(&spec, 2_049);
    assert_eq!(body, vec![b'b'; 5_000]);
    assert_eq!(status, Status::Verified);
}

#[test]
fn a_row_that_the_order_moves_too_low_does_not_read() {
    // A row of 5 GiB, then a row in the last window.
    // After the limit, the order gives `after` a place that is too low, so
    // the row has the mark and is refused. The text is then true.
    let spec = Archive {
        rows: vec![
            Row::new("first", 100).sized(16),
            Row::new("large", 200).sized(1 << 30),
            Row::new("after", 5 * GIB + 400).body(b"after"),
        ],
        directory: 5 * GIB + 500,
        ..Archive::default()
    };
    assert_eq!(rows_that_read(&spec.build(), Some(2)), Vec::<String>::new());
    assert_eq!(rows_that_read(&spec.build(), None), ["after"]);
}

#[test]
fn a_true_overlap_at_listed_places_reads_at_those_places() {
    let spec = after_the_limit(0);
    assert_eq!(
        rows_that_read(&spec.build(), None),
        ["docs/a.txt", "docs/b.txt"]
    );
}

#[test]
fn each_limit_of_reads_keeps_the_rule() {
    // The parse gives one answer for each limit, and the rule holds for all.
    for spec in [three_rows(), after_the_limit(8), after_the_limit(0)] {
        for reads in 1..40 {
            rows_that_read(&spec.build(), Some(reads));
        }
    }
}
