//! The hostile tests assumed one Rust call,
//! `zipscope_read::archive::inspect`, that makes the whole report. The
//! real report comes from three parts, and this adapter joins them with
//! no logic of its own:
//!
//! - the rows: the core ingest (`zipscope_core::ingest::Ingest`), whose
//!   store columns are the mirrors that the read worker reads;
//! - the facts, the byte map and the totals: `zipscope_layout`, which the
//!   read wasm runs (`Facts::read`, `Builder`, `Totals`);
//! - the names of the test API: the region kinds and sniffer labels below.
//!
//! The comment decoding and the region reads are in TypeScript
//! (`web/src/archive/strings.ts`: `decodeComment`, `regionRange`), so their
//! tests moved to `web/src/archive/hostile-strings.test.ts`.
#![allow(dead_code, reason = "Each test uses a different part of the report.")]

use std::collections::BTreeMap;

use rawzip::{ReaderAt, ZipLocator};
use zipscope_core::contract::Column;
use zipscope_core::ingest::{Ingest, Status};
use zipscope_layout::{Builder, EntrySpan, Facts, Group, Kind, Label, Totals as Counter, Zip64};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RegionKind {
    Prelude,
    Entry,
    Gap,
    CentralDirectory,
    /// The zip64 end record, its locator, the end record and the comment.
    Eocd,
    Epilogue,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Sniff {
    /// A Windows, Linux or macOS program.
    SelfExtractor,
    ShellScript,
    ApkSigningBlock,
    /// Another label of the sniffer (zero bytes, or a zip signature).
    Other(Label),
}

#[derive(Clone, Copy, Debug)]
pub struct Region {
    pub offset: u64,
    pub size: u64,
    pub kind: RegionKind,
    pub sniff: Option<Sniff>,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Totals {
    pub entries: u64,
    pub compressed: u64,
    pub uncompressed: u64,
}

#[derive(Clone, Copy, Debug)]
pub struct Disks {
    pub current: u32,
    pub directory: u32,
    pub entries_here: u64,
    pub total: u32,
    pub unsupported: bool,
}

#[derive(Debug)]
pub struct Report {
    /// The raw bytes of the archive comment.
    pub comment: Vec<u8>,
    pub regions: Vec<Region>,
    pub zip64: bool,
    pub declared_entries: u64,
    pub found_entries: u64,
    pub complete: bool,
    pub disks: Disks,
    pub totals: Totals,
    pub by_method: BTreeMap<u16, Totals>,
    pub by_encryption: BTreeMap<u8, Totals>,
    pub by_os: BTreeMap<u8, Totals>,
    pub warnings: Vec<String>,
}

fn totals(group: Group) -> Totals {
    Totals {
        entries: group.entries,
        compressed: group.compressed,
        uncompressed: group.uncompressed,
    }
}

#[expect(
    clippy::cast_possible_truncation,
    clippy::cast_sign_loss,
    reason = "Store values are exact to 2^53. A larger value saturates, as in the read worker."
)]
fn whole(value: f64) -> u64 {
    value.max(0.0) as u64
}

/// Makes the report of an archive as the app does: the ingest lists the
/// rows, then the read worker maps them and counts the totals.
#[expect(
    clippy::too_many_lines,
    reason = "One function fills the report of the assumed test API."
)]
pub fn inspect<R: ReaderAt + Clone + 'static>(reader: &R, size: u64) -> Result<Report, String> {
    let mut ingest = Ingest::open(reader.clone(), size).map_err(|err| err.to_string())?;
    while *ingest.status() == Status::Parsing {
        ingest.parse(4096);
    }
    ingest.finish_checks();
    let mut buffer = vec![0u8; zipscope_core::contract::ENTRIES_BUFFER_BYTES];
    let archive = ZipLocator::new()
        .locate_in_reader(reader.clone(), &mut buffer, size)
        .map_err(|(_, err)| err.to_string())?;
    let facts = Facts::read(&archive, size).map_err(|err| err.to_string())?;
    let store = ingest.store();
    let mut builder = Builder::new(&facts);
    let mut counter = Counter::new().map_err(|err| err.to_string())?;
    for row in 0..store.rows() {
        let value = |column| store.value(row, column);
        let span = EntrySpan {
            local_header_offset: whole(value(Column::LocalHeaderOffset)),
            compressed_size: whole(value(Column::CompressedSize)),
            uncompressed_size: whole(value(Column::UncompressedSize)),
            crc32: u32::try_from(whole(value(Column::Crc32))).unwrap(),
            flags: u16::try_from(whole(value(Column::Flags))).unwrap(),
        };
        counter.add(
            span.compressed_size,
            span.uncompressed_size,
            u16::try_from(whole(value(Column::Method))).unwrap(),
            u8::try_from(whole(value(Column::Encryption))).unwrap(),
            u16::try_from(whole(value(Column::VersionMadeBy))).unwrap(),
        );
        builder
            .add(reader, reader, span)
            .map_err(|err| err.to_string())?;
    }
    let layout = builder
        .finish(reader, &facts)
        .map_err(|err| err.to_string())?;
    let counts = layout.counts;

    let regions = layout
        .regions
        .iter()
        .map(|region| Region {
            offset: region.start,
            size: region.end - region.start,
            kind: match region.kind {
                Kind::Prelude => RegionKind::Prelude,
                Kind::Entries => RegionKind::Entry,
                Kind::Gap => RegionKind::Gap,
                Kind::Directory => RegionKind::CentralDirectory,
                Kind::Zip64Record | Kind::Zip64Locator | Kind::EndRecord => RegionKind::Eocd,
                Kind::Epilogue => RegionKind::Epilogue,
            },
            sniff: match region.label {
                Label::None => None,
                Label::WindowsProgram | Label::LinuxProgram | Label::MacProgram => {
                    Some(Sniff::SelfExtractor)
                }
                Label::ShellScript => Some(Sniff::ShellScript),
                Label::ApkSigningBlock => Some(Sniff::ApkSigningBlock),
                other => Some(Sniff::Other(other)),
            },
        })
        .collect();

    let mut warnings = Vec::new();
    if let Status::Failed(message) = ingest.status() {
        warnings.push(format!("parse error: {message}"));
    }
    for (count, text) in [
        (counts.bad_headers, "bad local headers"),
        (counts.past_directory, "rows past the central directory"),
        (counts.into_directory, "rows into the central directory"),
        (counts.overlapping, "overlapping rows"),
        (counts.missing_descriptors, "missing data descriptors"),
    ] {
        if count > 0 {
            warnings.push(format!("{count} {text}"));
        }
    }

    let used = facts.zip64 == Zip64::Used;
    let end = facts.end_record;
    let record = facts.record.filter(|_| used);
    let disks = Disks {
        current: record.map_or(u32::from(end.disk), |record| record.disk),
        directory: record.map_or(u32::from(end.directory_disk), |record| {
            record.directory_disk
        }),
        entries_here: record.map_or(u64::from(end.disk_entries), |record| record.disk_entries),
        total: facts.locator.map_or(1, |locator| locator.total_disks),
        unsupported: facts.spans_disks() || counts.other_disk_rows > 0,
    };
    let breakdown = |groups: &mut dyn Iterator<Item = (u16, Group)>| {
        groups
            .map(|(key, group)| (key, totals(group)))
            .collect::<BTreeMap<u16, Totals>>()
    };
    let narrow = |map: BTreeMap<u16, Totals>| {
        map.into_iter()
            .map(|(key, value)| (u8::try_from(key).unwrap(), value))
            .collect::<BTreeMap<u8, Totals>>()
    };
    Ok(Report {
        comment: facts.comment.clone(),
        regions,
        zip64: used || counts.zip64_rows > 0,
        declared_entries: facts.declared_entries,
        found_entries: store.rows() as u64,
        complete: *ingest.status() == Status::Complete,
        disks,
        totals: totals(counter.all),
        by_method: breakdown(&mut counter.methods()),
        by_encryption: narrow(breakdown(&mut counter.encryption())),
        by_os: narrow(breakdown(&mut counter.systems())),
        warnings,
    })
}
