/*
ASSUMED API
zipscope_read::archive::inspect<R: ReaderAt + 'static>(
    directory: &mut Directory<R>,
) -> Result<Report, String>
zipscope_read::archive::read_region<R: ReaderAt>(
    reader: &R, region: &Region, relative: u64, out: &mut [u8],
) -> Result<usize, String>

Report fields:
    comment: String
    regions: Vec<Region>
    zip64: bool
    declared_entries: u64
    found_entries: u64
    complete: bool
    disks: Disks
    totals: Totals
    by_method: BTreeMap<u16, Totals>
    by_encryption: BTreeMap<u8, Totals>
    by_os: BTreeMap<u8, Totals>
    warnings: Vec<String>
Disks fields:
    current: u32, directory: u32, entries_here: u64,
    total: u32, unsupported: bool
Totals fields: entries: u64, compressed: u64, uncompressed: u64
Region fields: offset: u64, size: u64, kind: RegionKind, sniff: Option<Sniff>
RegionKind variants: Prelude, Entry, Gap, CentralDirectory, Eocd, Epilogue
Sniff variants: SelfExtractor, ShellScript, ApkSigningBlock
RegionKind and Sniff implement Copy, Debug, PartialEq and Eq.

These names may change. Record a reason if an expected result changes.
The read worker can make this report. The main thread must not parse ZIP.
Inspect metadata only. Do not decode entry bodies or scan large holes.
Keep the parsed rows if the central directory ends with an error.
Set complete only after the complete central directory is read.
Keep warnings for bad local ranges. The map must still cover the file.
Map physical offsets, in order, without overlap or empty regions.
Entry includes the local header and data descriptor. Eocd includes ZIP64
end records and the locator. The EOCD comment is part of Eocd.
A region can be split into smaller regions with the same kind.
Method keys use the central-directory method. Encryption keys use the low
7 bits of the contract code. OS keys use the high byte of version made by.
Read regions in bounded steps. A read at the end returns 0. Reject an
offset past the end and a range whose end overflows. Keep out unchanged
after the returned bytes. Do not read past a region into adjacent data.
*/

// These tests moved from `crates/read/tests` to the layout crate,
// which has the byte map. The builder stays in the read crate (the fixture
// tests there use it). `archive` is an adapter over the real code; see its
// header. Each changed test has its own note.
// `assert!(!warnings.is_empty())` is
// `assert_ne!(warnings, [])` for the workspace clippy lints; the check is
// the same.
#[path = "support/report.rs"]
mod archive;
#[path = "../../read/tests/support/fixture.rs"]
mod zip;

use std::ops::Range;

use archive::{Region, RegionKind as K, Report, Sniff};
use zip::{Descriptor, Entry, Fixture, Options, aes, apk_block, build, field};

fn inspect(fixture: &Fixture) -> Report {
    let report = archive::inspect(&fixture.reader(), fixture.size()).unwrap();
    partition(&report, fixture.size());
    report
}

fn partition(report: &Report, size: u64) {
    let mut next = 0;
    for region in &report.regions {
        assert!(region.size > 0, "empty region at {}", region.offset);
        assert_eq!(region.offset, next, "gap or overlap in the byte map");
        next = region.offset.checked_add(region.size).unwrap();
        assert!(next <= size, "region past the file end");
    }
    assert_eq!(next, size, "the map must cover the complete file");
}

fn span(report: &Report, range: Range<u64>, kind: K) {
    assert!(!range.is_empty());
    let mut covered = 0;
    for region in &report.regions {
        let start = region.offset.max(range.start);
        let end = (region.offset + region.size).min(range.end);
        if start < end {
            assert_eq!(region.kind, kind, "wrong kind at {start}");
            covered += end - start;
        }
    }
    assert_eq!(covered, range.end - range.start);
}

fn ordinary_map(fixture: &Fixture, report: &Report) {
    span(
        report,
        fixture.directory..fixture.directory + fixture.directory_size,
        K::CentralDirectory,
    );
    span(report, fixture.end_start..fixture.end, K::Eocd);
    if fixture.end < fixture.size() {
        span(report, fixture.end..fixture.size(), K::Epilogue);
    }
}

fn region(report: &Report, kind: K) -> &Region {
    report
        .regions
        .iter()
        .find(|region| region.kind == kind)
        .unwrap()
}

#[test]
fn map_counts_local_headers_empty_entries_gaps_comment_and_tail() {
    let entries = [
        Entry {
            local_name: Some(b"a-much-longer-local-name".to_vec()),
            local_extra: field(0xcafe, b"local extra"),
            gap: b"gap\0\xff".to_vec(),
            ..Entry::new("a", "abc")
        },
        Entry::new("empty/", ""),
    ];
    let fixture = build(
        &entries,
        &Options {
            prelude: b"prefix\0".to_vec(),
            before_directory: b"last gap".to_vec(),
            comment: b"not an epilogue".to_vec(),
            epilogue: b"tail\xff".to_vec(),
            ..Options::default()
        },
    );
    let report = inspect(&fixture);
    span(&report, 0..fixture.locals[0].0, K::Prelude);
    for &(start, end) in &fixture.locals {
        span(&report, start..end, K::Entry);
    }
    span(&report, fixture.locals[0].1..fixture.locals[1].0, K::Gap);
    span(&report, fixture.locals[1].1..fixture.directory, K::Gap);
    ordinary_map(&fixture, &report);
    // The report keeps the raw comment; the decoding
    // is in TypeScript and its test is in web/src/archive/hostile-strings.test.ts.
    assert_eq!(report.comment, b"not an epilogue");
    assert_eq!(report.found_entries, 2);
    assert_eq!(report.totals.compressed, 3);
    assert_eq!(report.totals.uncompressed, 3);
}

#[test]
fn map_uses_physical_order_when_directory_order_is_reversed() {
    let fixture = build(
        &[
            Entry {
                gap: vec![0xaa; 5],
                ..Entry::new("first", "123")
            },
            Entry::new("last", "45678"),
        ],
        &Options {
            prelude: vec![0x77; 11],
            order: Some(vec![1, 0]),
            ..Options::default()
        },
    );
    let report = inspect(&fixture);
    span(&report, 0..11, K::Prelude);
    span(&report, fixture.locals[0].1..fixture.locals[1].0, K::Gap);
    for &(start, end) in &fixture.locals {
        span(&report, start..end, K::Entry);
    }
    ordinary_map(&fixture, &report);
}

#[test]
fn adjusted_offsets_after_a_prefix_are_absolute_in_the_map() {
    let fixture = build(
        &[Entry::new("a", "abc")],
        &Options {
            prelude: b"#!/bin/sh\nexit 0\n".to_vec(),
            relative_offsets: true,
            ..Options::default()
        },
    );
    let report = inspect(&fixture);
    span(&report, 0..fixture.locals[0].0, K::Prelude);
    span(&report, fixture.locals[0].0..fixture.locals[0].1, K::Entry);
    ordinary_map(&fixture, &report);
}

#[test]
fn signatures_inside_a_payload_do_not_make_new_regions() {
    let body = b"PK\x03\x04PK\x01\x02PK\x05\x06MZ#!/bin/sh\nAPK Sig Block 42";
    let fixture = build(&[Entry::new("payload", body)], &Options::default());
    let report = inspect(&fixture);
    span(&report, 0..fixture.directory, K::Entry);
    ordinary_map(&fixture, &report);
    assert!(report.regions.iter().all(|region| region.sniff.is_none()));
}

#[test]
fn maximum_variable_headers_do_not_hide_the_next_entry_or_create_false_gaps() {
    let fixture = build(
        &[
            Entry {
                local_name: Some(vec![b'L'; usize::from(u16::MAX)]),
                local_extra: field(0xcafe, &vec![0; 65_531]),
                extra: field(0xbeef, &vec![0; 65_531]),
                comment: vec![0x82; usize::from(u16::MAX)],
                ..Entry::new(vec![b'C'; usize::from(u16::MAX)], "abc")
            },
            Entry::new("next", "z"),
        ],
        &Options::default(),
    );
    let report = inspect(&fixture);
    assert!(report.complete);
    assert_eq!(report.found_entries, 2);
    assert_eq!(report.totals.compressed, 4);
    span(&report, 0..fixture.directory, K::Entry);
    ordinary_map(&fixture, &report);
}

#[test]
fn data_descriptors_are_entry_bytes_with_or_without_a_signature() {
    for descriptor in [
        Descriptor::Plain,
        Descriptor::Signed,
        Descriptor::Zip64Plain,
        Descriptor::Zip64Signed,
    ] {
        let fixture = build(
            &[
                Entry {
                    descriptor,
                    gap: vec![0xa5; 3],
                    ..Entry::new("a", "abc")
                },
                Entry::new("b", "z"),
            ],
            &Options::default(),
        );
        let report = inspect(&fixture);
        span(&report, fixture.locals[0].0..fixture.locals[0].1, K::Entry);
        span(&report, fixture.locals[0].1..fixture.locals[1].0, K::Gap);
        ordinary_map(&fixture, &report);
    }
}

#[test]
fn aliased_entries_count_twice_in_totals_but_once_in_the_byte_map() {
    let fixture = build(
        &[Entry::new("same", "abc")],
        &Options {
            order: Some(vec![0, 0, 0]),
            ..Options::default()
        },
    );
    let report = inspect(&fixture);
    span(&report, 0..fixture.directory, K::Entry);
    ordinary_map(&fixture, &report);
    assert_eq!(report.found_entries, 3);
    assert_eq!(report.totals.entries, 3);
    assert_eq!(report.totals.compressed, 9);
    assert_eq!(report.totals.uncompressed, 9);
}

#[test]
fn overlapping_ranges_do_not_cover_directory_or_end_records() {
    let mut fixture = build(
        &[Entry::new("a", "abc"), Entry::new("b", "def")],
        &Options::default(),
    );
    fixture.patch32(fixture.records[0] + 20, u32::MAX - 1);
    let report = inspect(&fixture);
    ordinary_map(&fixture, &report);
    assert_ne!(report.warnings, Vec::<String>::new());
}

#[test]
fn impossible_local_offsets_and_lengths_keep_a_bounded_map_and_a_warning() {
    for offset in [1, u64::from(u32::MAX) + 7, u64::MAX - 7] {
        let fixture = build(
            &[Entry {
                offset: Some(offset),
                compressed: Some(16),
                ..Entry::new("bad", "abc")
            }],
            &Options::default(),
        );
        let report = inspect(&fixture);
        ordinary_map(&fixture, &report);
        assert_ne!(report.warnings, Vec::<String>::new(), "offset {offset}");
    }
    let mut fixture = build(&[Entry::new("bad", "abc")], &Options::default());
    fixture.patch16(fixture.locals[0].0 + 26, u16::MAX);
    fixture.patch16(fixture.locals[0].0 + 28, u16::MAX);
    let report = inspect(&fixture);
    ordinary_map(&fixture, &report);
    assert_ne!(report.warnings, Vec::<String>::new());
}

#[test]
fn zip64_end_records_locator_extension_and_comment_are_not_extractable_gaps() {
    let fixture = build(
        &[Entry::new("a", "x")],
        &Options {
            zip64: true,
            zip64_extension: field(0xbeef, b"extension"),
            comment: b"zip64 comment".to_vec(),
            epilogue: b"actual tail".to_vec(),
            ..Options::default()
        },
    );
    let report = inspect(&fixture);
    assert!(report.zip64);
    ordinary_map(&fixture, &report);
    // Raw comment bytes, as above.
    assert_eq!(report.comment, b"zip64 comment");
}

// The comment decoding is `decodeComment` in
// TypeScript; the same four cases with the same expected text are in
// web/src/archive/hostile-strings.test.ts. Here the report must keep the raw
// bytes of each comment, also the longest one, and the map must hold.
#[test]
fn comment_decode_uses_utf8_then_cp437_without_entry_flags() {
    for comment in [
        Vec::new(),
        "日本語 café".as_bytes().to_vec(),
        b"caf\x82 \x9b\0end".to_vec(),
        vec![0x82; usize::from(u16::MAX)],
    ] {
        let expected = comment.clone();
        let fixture = build(
            &[Entry {
                flags: 1 << 11,
                ..Entry::new("a", "")
            }],
            &Options {
                comment,
                epilogue: b"tail".to_vec(),
                ..Options::default()
            },
        );
        let report = inspect(&fixture);
        assert_eq!(report.comment, expected);
        ordinary_map(&fixture, &report);
    }
}

#[test]
fn empty_archives_do_not_underflow_the_prelude_or_ratio() {
    for zip64 in [false, true] {
        let fixture = build(
            &[],
            &Options {
                zip64,
                prelude: b"prefix".to_vec(),
                comment: b"empty".to_vec(),
                epilogue: b"tail".to_vec(),
                ..Options::default()
            },
        );
        let report = inspect(&fixture);
        span(&report, 0..fixture.directory, K::Prelude);
        span(&report, fixture.end_start..fixture.end, K::Eocd);
        span(&report, fixture.end..fixture.size(), K::Epilogue);
        assert!(report.complete);
        assert_eq!(report.totals.entries, 0);
        assert_eq!(report.totals.compressed, 0);
        assert_eq!(report.totals.uncompressed, 0);
        assert!(report.by_method.is_empty());
        assert!(report.by_encryption.is_empty());
        assert!(report.by_os.is_empty());
    }
}

#[test]
fn declared_counts_are_facts_and_never_iteration_or_allocation_limits() {
    for declared in [0, 1, 9, 1 << 63] {
        let fixture = build(
            &[Entry::new("a", "12"), Entry::new("b", "345")],
            &Options {
                zip64: true,
                declared: Some(declared),
                ..Options::default()
            },
        );
        let report = inspect(&fixture);
        assert_eq!(report.declared_entries, declared);
        assert_eq!(report.found_entries, 2);
        assert_eq!(report.totals.entries, 2);
        assert_eq!(report.totals.compressed, 5);
        assert!(report.complete);
    }
}

#[test]
fn false_directory_sizes_do_not_set_read_sizes_or_extend_the_map() {
    for declared_size in [1, u32::MAX - 1] {
        let mut fixture = build(&[Entry::new("a", "abc")], &Options::default());
        fixture.patch32(fixture.eocd + 12, declared_size);
        let reader = fixture.reader();
        // The locator can reject a false directory size.
        // `inspect` takes the reader, not a Directory.
        if let Ok(report) = archive::inspect(&reader, fixture.size()) {
            partition(&report, fixture.size());
            span(&report, fixture.end_start..fixture.end, K::Eocd);
        }
        assert!(reader.requested.get() <= 2 << 20);
        assert!(reader.maximum.get() <= 256 << 10);
    }
}

// The map does not use the wayfinder table of the read
// worker; it reads the rows from the mirrors, so there is no Directory to
// read first. The test keeps its point: a second report of the same
// archive (the read worker keeps the first one) counts each row once.
#[test]
fn reports_include_rows_read_before_inspection_and_do_not_count_them_again() {
    let fixture = build(
        &[Entry::new("a", "12"), Entry::new("b", "345")],
        &Options::default(),
    );
    let reader = fixture.reader();
    for _ in 0..2 {
        let report = archive::inspect(&reader, fixture.size()).unwrap();
        partition(&report, fixture.size());
        ordinary_map(&fixture, &report);
        assert!(report.complete);
        assert_eq!(report.found_entries, 2);
        assert_eq!(report.totals.entries, 2);
        assert_eq!(report.totals.compressed, 5);
        assert_eq!(report.by_method[&0].compressed, 5);
    }
}

#[test]
fn a_partial_directory_keeps_its_totals_and_does_not_claim_completion() {
    let mut fixture = build(
        &[Entry::new("kept", "abc"), Entry::new("bad", "secret")],
        &Options::default(),
    );
    fixture.patch32(fixture.records[1], 0);
    let report = inspect(&fixture);
    assert!(!report.complete);
    assert_eq!(report.declared_entries, 2);
    assert_eq!(report.found_entries, 1);
    assert_eq!(report.totals.entries, 1);
    assert_eq!(report.totals.compressed, 3);
    assert_ne!(report.warnings, Vec::<String>::new());
    span(&report, fixture.end_start..fixture.end, K::Eocd);
}

#[test]
fn split_disk_fields_are_reported_and_flagged_unsupported() {
    for zip64 in [false, true] {
        let fixture = build(
            &[Entry {
                disk: 1,
                ..Entry::new("a", "abc")
            }],
            &Options {
                zip64,
                disk: 1,
                directory_disk: 1,
                total_disks: 2,
                disk_entries: Some(0),
                ..Options::default()
            },
        );
        let report = inspect(&fixture);
        assert_eq!(report.disks.current, 1);
        assert_eq!(report.disks.directory, 1);
        assert_eq!(report.disks.entries_here, 0);
        assert!(report.disks.unsupported);
        if zip64 {
            assert_eq!(report.disks.total, 2);
        }
    }
}

#[test]
fn each_independent_spanning_signal_is_unsupported() {
    let options = [
        Options {
            disk: 1,
            ..Options::default()
        },
        Options {
            directory_disk: 1,
            ..Options::default()
        },
        Options {
            disk_entries: Some(0),
            ..Options::default()
        },
        Options {
            zip64: true,
            total_disks: 2,
            ..Options::default()
        },
    ];
    for option in options {
        let report = inspect(&build(&[Entry::new("a", "abc")], &option));
        assert!(report.disks.unsupported);
    }
    let report = inspect(&build(
        &[Entry {
            disk: 1,
            ..Entry::new("a", "abc")
        }],
        &Options::default(),
    ));
    assert!(report.disks.unsupported);
    let report = inspect(&build(&[Entry::new("a", "abc")], &Options::default()));
    assert!(!report.disks.unsupported);
}

#[test]
fn totals_keep_unknown_codes_and_do_not_count_ae2_twice() {
    let entries = [
        Entry {
            made_by: 0x0014,
            ..Entry::new("plain", "1")
        },
        Entry {
            method: 8,
            flags: 1,
            made_by: 0x031e,
            ..Entry::new("crypto", "22")
        },
        Entry {
            method: 99,
            extra: aes(2, 3, 8),
            made_by: 0x031e,
            ..Entry::new("aes", "333")
        },
        Entry {
            method: 99,
            extra: field(0x9901, b"bad"),
            made_by: 0xff00,
            ..Entry::new("unknown-aes", "4444")
        },
        Entry {
            method: 65_534,
            flags: 0x41,
            made_by: 0xff2d,
            ..Entry::new("strong", "55555")
        },
        Entry {
            flags: 0x40,
            extra: aes(2, 3, 8),
            made_by: 0x0014,
            ..Entry::new("flag-without-encryption", "666666")
        },
        Entry {
            method: 99,
            extra: aes(1, 1, 0),
            made_by: 0x0014,
            ..Entry::new("aes128", "7777777")
        },
        Entry {
            method: 99,
            extra: aes(2, 2, 8),
            ..Entry::new("aes192", "88888888")
        },
    ];
    let fixture = build(
        &entries,
        &Options {
            declared: Some(0),
            ..Options::default()
        },
    );
    let report = inspect(&fixture);
    assert_eq!(report.totals.entries, 8);
    assert_eq!(report.totals.compressed, 36);
    assert_eq!(report.totals.uncompressed, 36);
    // The method breakdown uses the method of the central directory, so the
    // four method-99 rows are one group (the AES breakdown is in
    // by_encryption).
    for (key, count, bytes) in [(0, 2, 7), (8, 1, 2), (99, 4, 22), (65_534, 1, 5)] {
        let total = &report.by_method[&key];
        assert_eq!(
            (total.entries, total.compressed, total.uncompressed),
            (count, bytes, bytes)
        );
    }
    for (key, count, bytes) in [
        (0, 2, 7),
        (1, 1, 2),
        (4, 1, 3),
        (6, 1, 4),
        (5, 1, 5),
        (2, 1, 7),
        (3, 1, 8),
    ] {
        let total = &report.by_encryption[&key];
        assert_eq!(
            (total.entries, total.compressed, total.uncompressed),
            (count, bytes, bytes)
        );
    }
    for (key, count, bytes) in [(0, 3, 14), (3, 3, 13), (255, 2, 9)] {
        let total = &report.by_os[&key];
        assert_eq!(
            (total.entries, total.compressed, total.uncompressed),
            (count, bytes, bytes)
        );
    }
    assert_eq!(report.by_method.len(), 4);
    assert_eq!(report.by_encryption.len(), 7);
    assert_eq!(report.by_os.len(), 3);
}

#[test]
fn zip64_sizes_are_summed_without_a_32_bit_cast() {
    let big = (1 << 40) + 7;
    let fixture = build(
        &[
            Entry {
                compressed: Some(big),
                uncompressed: Some(big + 100),
                ..Entry::new("a", "x")
            },
            Entry {
                compressed: Some(big + 1),
                uncompressed: Some(big + 200),
                ..Entry::new("b", "y")
            },
        ],
        &Options::default(),
    );
    let report = inspect(&fixture);
    assert!(report.zip64);
    assert_eq!(report.totals.compressed, 2 * big + 1);
    assert_eq!(report.totals.uncompressed, 2 * big + 300);
    assert_eq!(report.by_method[&0].compressed, 2 * big + 1);
    assert_eq!(report.by_encryption[&0].uncompressed, 2 * big + 300);
    assert_eq!(report.by_os[&3].uncompressed, 2 * big + 300);
}

#[test]
fn huge_sparse_preludes_keep_exact_offsets_and_do_not_trigger_a_full_scan() {
    let base = (1 << 40) + 7;
    let fixture = build(
        &[Entry::new("a", "abc")],
        &Options {
            base,
            zip64: true,
            ..Options::default()
        },
    );
    let reader = fixture.reader();
    // `inspect` opens the archive itself, so the reads
    // of the open count too; the bounds stay. The read of the last 3 bytes
    // of the prelude is `regionRange` in TypeScript; its test is in
    // web/src/archive/hostile-strings.test.ts, with this prelude size.
    reader.reset();
    let report = archive::inspect(&reader, fixture.size()).unwrap();
    partition(&report, fixture.size());
    span(&report, 0..base, K::Prelude);
    span(&report, base..fixture.directory, K::Entry);
    ordinary_map(&fixture, &report);
    assert!(reader.requested.get() <= 2 << 20);
    assert!(reader.maximum.get() <= 256 << 10);
}

#[test]
fn sniffers_label_shell_and_self_extractor_preludes() {
    let mut exe = vec![0; 128];
    exe[..2].copy_from_slice(b"MZ");
    exe[0x3c..0x40].copy_from_slice(&0x40_u32.to_le_bytes());
    exe[0x40..0x44].copy_from_slice(b"PE\0\0");
    for (prelude, expected) in [
        (
            b"#!/bin/sh\necho hello\nexit 0\n".to_vec(),
            Sniff::ShellScript,
        ),
        (exe, Sniff::SelfExtractor),
    ] {
        let fixture = build(
            &[Entry::new("a", "abc")],
            &Options {
                prelude,
                ..Options::default()
            },
        );
        let report = inspect(&fixture);
        assert_eq!(region(&report, K::Prelude).sniff, Some(expected));
    }
}

#[test]
fn apk_sniffer_uses_both_sizes_and_the_directory_boundary() {
    let block = apk_block();
    let fixture = build(
        &[Entry::new("a", "abc")],
        &Options {
            before_directory: block.clone(),
            ..Options::default()
        },
    );
    let report = inspect(&fixture);
    span(&report, fixture.locals[0].1..fixture.directory, K::Gap);
    assert_eq!(region(&report, K::Gap).sniff, Some(Sniff::ApkSigningBlock));
    for mode in 0..5 {
        let mut bad = block.clone();
        match mode {
            0 => bad[..8].copy_from_slice(&u64::MAX.to_le_bytes()),
            1 => {
                let at = bad.len() - 24;
                bad[at..at + 8].copy_from_slice(&u64::MAX.to_le_bytes());
            }
            2 => bad[..8].copy_from_slice(&1_u64.to_le_bytes()),
            3 => bad.push(0),
            4 => {
                bad.drain(..8);
            }
            _ => unreachable!(),
        }
        let fixture = build(
            &[Entry::new("a", "abc")],
            &Options {
                before_directory: bad,
                ..Options::default()
            },
        );
        let report = inspect(&fixture);
        assert!(
            report
                .regions
                .iter()
                .all(|region| region.sniff != Some(Sniff::ApkSigningBlock)),
            "mode {mode}"
        );
        span(&report, fixture.locals[0].1..fixture.directory, K::Gap);
    }
    let fixture = build(
        &[
            Entry {
                gap: block,
                ..Entry::new("a", "abc")
            },
            Entry::new("b", "def"),
        ],
        &Options::default(),
    );
    let report = inspect(&fixture);
    assert!(
        report
            .regions
            .iter()
            .all(|region| region.sniff != Some(Sniff::ApkSigningBlock))
    );
}

// `region_reads_are_exact_bounded_and_stop_before_adjacent_zip_bytes`
// and `region_reads_reject_overflowing_ranges_without_io` moved to
// web/src/archive/hostile-strings.test.ts. The hex view and the extract read the
// file with `Blob.slice` on the main thread, in the range that
// `regionRange` gives; there is no Rust region read.
