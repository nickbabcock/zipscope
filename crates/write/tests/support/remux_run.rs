//! Runs the assumed remux API (see the ASSUMED API block in
//! `hostile_remux.rs`) and checks an output with the existing core and read
//! crates.
#![allow(dead_code, reason = "Each test binary uses a different part.")]

use zipscope_core::contract::Column;
use zipscope_core::health::Summary;
use zipscope_core::ingest::{Ingest, Status as IngestStatus};
use zipscope_read::directory::Directory;
use zipscope_read::local;
use zipscope_read::stream::{Status, Stream};
use zipscope_write::remux::{Encoded, Remux, Report, encode};

use crate::zip::{Built, Source};

/// The output of a whole remux.
#[derive(Debug)]
pub struct Output {
    pub bytes: Vec<u8>,
    pub report: Report,
}

/// Runs the job of one row as a pool worker does.
pub fn run_job(
    remux: &mut Remux<Source>,
    source: &Source,
    row: usize,
) -> Result<(Encoded, Vec<u8>), String> {
    let job = remux.job(row)?;
    let mut data = Vec::new();
    let encoded = encode(source.clone(), source.size(), &job, &mut data)?;
    Ok((encoded, data))
}

/// Remuxes all rows in order, one at a time.
///
/// # Panics
///
/// Panics when the remux cannot open the source or cannot finish.
pub fn remux(built: &Built) -> Output {
    try_remux(built).expect("The remux did not finish")
}

pub fn try_remux(built: &Built) -> Result<Output, String> {
    let source = built.source.clone();
    let mut remux = Remux::open(source.clone(), source.size())?;
    let mut bytes = Vec::new();
    for row in 0..remux.rows() {
        let result = run_job(&mut remux, &source, row);
        remux.add(row, result)?;
        bytes.extend(remux.take(usize::MAX));
    }
    let report = remux.finish()?;
    bytes.extend(remux.take(usize::MAX));
    Ok(Output { bytes, report })
}

/// True when the report lists the row as left out of the output.
pub fn left_out(report: &Report, row: usize) -> bool {
    report.left_out.iter().any(|(at, _)| *at == row)
}

/// The output, parsed by the existing core.
pub fn ingest(bytes: &[u8]) -> Ingest<Source> {
    let source = Source::new(0, bytes.to_vec());
    let size = source.size();
    let mut ingest = Ingest::open(source, size).expect("The core cannot open the output");
    ingest.parse(u32::MAX);
    assert_eq!(
        ingest.status(),
        &IngestStatus::Complete,
        "The core did not parse all of the output"
    );
    ingest.finish_checks();
    ingest
}

/// The core health of an output must have no finding that a good copy
/// cannot have.
pub fn assert_healthy(health: &Summary) {
    assert_eq!(health.terminal_error, None);
    assert_eq!(health.count_mismatch, None);
    assert_eq!(health.prelude_bytes, 0, "Bytes before the first entry");
    assert_eq!(health.epilogue_bytes, 0, "Bytes after the end record");
    assert_eq!(health.overlap_rows, 0, "Entries that overlap");
}

/// Facts of one row, as the core shows them.
#[derive(Debug, Clone, PartialEq)]
pub struct Shown {
    pub name: Vec<u8>,
    pub comment: Vec<u8>,
    /// The bits of the modified time, so that `NaN` compares equal.
    pub modified: u64,
    pub time_kind: u64,
    pub name_source: u64,
    pub size: u64,
    pub crc: u64,
}

#[expect(
    clippy::cast_possible_truncation,
    clippy::cast_sign_loss,
    reason = "The columns hold small integers."
)]
pub fn shown<R: rawzip::ReaderAt + 'static>(ingest: &Ingest<R>, row: usize) -> Shown {
    let store = ingest.store();
    Shown {
        name: store.name(row).to_vec(),
        comment: store.comment(row).to_vec(),
        modified: store.value(row, Column::Modified).to_bits(),
        time_kind: store.value(row, Column::TimeKind) as u64,
        name_source: store.value(row, Column::NameSource) as u64,
        size: store.value(row, Column::UncompressedSize) as u64,
        crc: store.value(row, Column::Crc32) as u64,
    }
}

/// The source, parsed by the existing core.
pub fn ingest_source(built: &Built) -> Ingest<Source> {
    let mut ingest = Ingest::open(built.source.clone(), built.source.size()).unwrap();
    ingest.parse(u32::MAX);
    assert_eq!(ingest.status(), &IngestStatus::Complete);
    ingest
}

/// Decodes each row of the output with the read module and its verifying
/// reader. Each local header must agree with its record. Returns the data
/// of each row, or `None` for a method that the read module does not decode
/// or an encrypted row.
pub fn verify_with_read_module(bytes: &[u8]) -> Vec<Option<Vec<u8>>> {
    let source = Source::new(0, bytes.to_vec());
    let size = source.size();
    let mut directory =
        Directory::open(source, size).expect("The read module cannot open the output");
    directory.scan(u32::MAX);
    let mut found = Vec::new();
    for row in 0..directory.rows() {
        let located = directory.locate(row).unwrap();
        let check = local::check(directory.archive(), located).unwrap();
        assert_eq!(check.mismatches, 0, "Row {row}: the local header disagrees");
        let record = local::read_record(directory.archive(), located).unwrap();
        if record.encrypted() || !zipscope_read::stream::supported(record.method) {
            found.push(None);
            continue;
        }
        let mut stream = Stream::open(directory.archive(), row, located, &record)
            .unwrap_or_else(|err| panic!("Row {row}: {err}"));
        let mut data = Vec::new();
        for _ in 0..100_000 {
            stream.begin_call();
            if stream.read(&mut data, 1 << 20) == 0 && stream.status() != &Status::Reading {
                break;
            }
            if stream.status() != &Status::Reading {
                break;
            }
        }
        assert_eq!(
            stream.status(),
            &Status::Verified,
            "Row {row} did not verify"
        );
        found.push(Some(data));
    }
    found
}
