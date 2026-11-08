//! A row with a wrapped offset near an end record before the chosen record. The
//! row and the record have places in one base, the file.

#![expect(
    clippy::cast_precision_loss,
    reason = "The places in these files are exact in f64."
)]

use zipscope_core::contract::health;
use zipscope_core::ingest::{Ingest, Status};
use zipscope_testkit::end_shapes::two_rows;
use zipscope_testkit::wrapped::{Archive, Row};

const GIB: u64 = 1 << 30;

fn inner() -> (Vec<u8>, u64, u64) {
    let body = two_rows();
    (body.end(b"", 0), body.eocd(), body.directory)
}

fn fields(archive: &Archive) -> (Vec<f64>, Status, Vec<f64>) {
    let bytes = archive.build();
    let size = bytes.len();
    let mut ingest = Ingest::open(bytes, size).unwrap();
    ingest.parse(u32::MAX);
    ingest.finish_checks();
    let offsets = (0..ingest.store().rows())
        .map(|row| {
            ingest
                .store()
                .value(row, zipscope_core::contract::Column::LocalHeaderOffset)
        })
        .collect();
    (
        ingest.health_vector().to_vec(),
        ingest.status().clone(),
        offsets,
    )
}

/// A row of 3.5 GiB that starts at 5 GiB, so its offset wrapped, and its data ends at
/// the directory. The stored zip is in the last bytes of the data.
fn covered() -> Archive {
    let (bytes, _, _) = inner();
    let start = 5 * GIB;
    let data = 7 * (GIB / 2);
    let end = start + 30 + 5 + data;
    let holder = end - 30 - 1 - bytes.len() as u64;
    let row = Row::new("b.zip", start).sized(u32::try_from(data).unwrap());
    let a = Row::new("a.bin", 0).sized(1 << 31);
    Archive {
        rows: vec![a, row],
        headers: vec![Row::new("h", holder).body(&bytes)],
        directory: end,
        ..Archive::default()
    }
}

/// The row is small and it ends before the stored zip, so no row covers the record.
fn uncovered() -> Archive {
    let (bytes, _, _) = inner();
    let start = 5 * GIB;
    let end = start + 7 * (GIB / 2);
    let holder = end - 30 - 1 - bytes.len() as u64;
    let row = Row::new("b.zip", start).body(b"small");
    let a = Row::new("a.bin", 0).sized(1 << 31);
    Archive {
        rows: vec![a, row],
        headers: vec![Row::new("h", holder).body(&bytes)],
        directory: end,
        ..Archive::default()
    }
}

#[test]
fn a_wrapped_row_covers_the_record_at_its_true_place() {
    let (f, status, offsets) = fields(&covered());
    assert_eq!(status, Status::Complete);
    assert_eq!(offsets[1], (5 * GIB) as f64, "the row moved");
    assert_eq!(f[health::END_EARLIER_RECORDS], 0.0);
    assert_eq!(f[health::END_UNCHECKED], 0.0);
}

#[test]
fn a_wrapped_row_that_does_not_cover_gives_true_places() {
    let archive = uncovered();
    let (f, status, offsets) = fields(&archive);
    assert_eq!(status, Status::Complete);
    assert_eq!(offsets[1], (5 * GIB) as f64, "the row moved");
    assert_eq!(f[health::END_EARLIER_RECORDS], 1.0);
    let (bytes, eocd, directory) = inner();
    let holder = archive.directory - 30 - 1 - bytes.len() as u64;
    let start = holder + 30 + 1;
    assert_eq!(f[health::END_EARLIER_RECORD], (start + eocd) as f64);
    assert_eq!(f[health::END_EARLIER_DIRECTORY], (start + directory) as f64);
}
