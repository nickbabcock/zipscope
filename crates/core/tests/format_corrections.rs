//! Two format rules: an entry count that wrapped at 65,536, and the ranges
//! of the overlap check and of the check of data that runs into the central
//! directory.
//!
//! These tests guard hostile input, so they test each boundary from the two
//! sides, and in the two paths of the overlap check: while rows arrive, and in
//! the sort after parsing.

#[path = "support/zip.rs"]
#[allow(dead_code, reason = "These tests use part of the archive helpers.")]
mod zip;

use zip::{Entry, archive, open, u16le, u32le};
use zipscope_core::contract::{health, marks};
use zipscope_core::ingest::{Ingest, Status};

/// The fixed part of a local header.
const HEADER: u32 = 30;

fn names(count: usize) -> Vec<Entry> {
    (0..count).map(|row| Entry::new(format!("{row}"))).collect()
}

fn finished(bytes: Vec<u8>) -> Ingest<Vec<u8>> {
    let mut ingest = open(bytes);
    ingest.parse(u32::MAX);
    ingest.finish_checks();
    ingest
}

/// Returns (`COUNT_MISMATCH`, `COUNT_WRAPPED`).
fn count_fields(ingest: &Ingest<Vec<u8>>) -> (f64, f64) {
    let fields = ingest.health_vector();
    (
        fields[health::COUNT_MISMATCH],
        fields[health::COUNT_WRAPPED],
    )
}

fn row(name: &str, offset: u32, compressed: u32) -> Entry {
    Entry {
        offset: Some(offset),
        compressed,
        size: compressed,
        ..Entry::new(name)
    }
}

fn overlaps(ingest: &Ingest<Vec<u8>>) -> Vec<bool> {
    (0..ingest.store().rows())
        .map(|row| ingest.store().marks(row) & marks::OVERLAP != 0)
        .collect()
}

/// Checks the marks of rows in their order, and in the reverse order, which
/// takes the sort after parsing.
fn assert_overlaps(rows: &[Entry], expected: &[bool]) {
    let hint = u16::try_from(rows.len()).unwrap();
    let ingest = finished(archive(rows, hint, None).bytes);
    assert_eq!(overlaps(&ingest), expected, "while rows arrive");
    let reversed: Vec<Entry> = rows.iter().rev().cloned().collect();
    let ingest = finished(archive(&reversed, hint, None).bytes);
    let mut marked = overlaps(&ingest);
    marked.reverse();
    assert_eq!(marked, expected, "in the sort");
}

/// An archive of `prefix` bytes, `body` bytes in the base of the rows, and then
/// the central directory. The end record gives the offset in the base of the
/// rows, so rawzip repairs a prefix. The bytes have no local headers, because
/// the checks read none.
fn with_directory_at(rows: &[Entry], body: u32, prefix: u32) -> Vec<u8> {
    let mut out = vec![0u8; prefix as usize];
    let start = out.len();
    out.resize(start + body as usize, 0);
    let mut records = Vec::new();
    for entry in rows {
        u32le(&mut records, 0x0201_4b50);
        u16le(&mut records, 0x031e);
        u16le(&mut records, 20);
        records.extend_from_slice(&[0; 12]);
        u32le(&mut records, entry.compressed);
        u32le(&mut records, entry.size);
        u16le(&mut records, u16::try_from(entry.name.len()).unwrap());
        records.extend_from_slice(&[0; 12]);
        u32le(&mut records, entry.offset.unwrap());
        records.extend_from_slice(&entry.name);
    }
    let size = u32::try_from(records.len()).unwrap();
    out.extend_from_slice(&records);
    u32le(&mut out, 0x0605_4b50);
    u16le(&mut out, 0);
    u16le(&mut out, 0);
    u16le(&mut out, u16::try_from(rows.len()).unwrap());
    u16le(&mut out, u16::try_from(rows.len()).unwrap());
    u32le(&mut out, size);
    u32le(&mut out, body);
    u16le(&mut out, 0);
    out
}

fn into_directory(ingest: &Ingest<Vec<u8>>) -> (f64, f64) {
    let fields = ingest.health_vector();
    (
        fields[health::INTO_DIRECTORY_ROWS],
        fields[health::INTO_DIRECTORY_EXAMPLE],
    )
}

// The count ---------------------------------------------------------------

#[test]
fn a_count_that_wrapped_at_65_536_is_not_a_mismatch() {
    for (rows, declared) in [
        (65_539, 3),
        // Only the low 16 bits are 0, and an end record of 0 entries is not an
        // empty archive when the directory has records.
        (65_536, 0),
        // The largest value of the field, one time past the wrap.
        (131_071, u16::MAX),
        // Two wraps.
        (131_072 + 4, 4),
    ] {
        let ingest = finished(archive(&names(rows), declared, None).bytes);
        assert_eq!(ingest.status(), &Status::Complete);
        assert_eq!(ingest.store().rows(), rows);
        assert_eq!(count_fields(&ingest), (0.0, 1.0), "{rows} rows");
        let summary = ingest.health();
        assert_eq!(summary.count_mismatch, None);
        assert!(summary.count_wrapped);
        let fields = ingest.health_vector();
        assert_eq!(fields[health::DECLARED_ENTRIES], f64::from(declared));
    }
}

#[test]
fn a_count_that_does_not_wrap_to_the_rows_stays_a_mismatch() {
    for (rows, declared) in [
        // One more and one less than the true value in 16 bits.
        (65_539, 4),
        (65_539, 2),
        // A count below the rows with no wrap.
        (10, 3),
        // A count above the rows.
        (3, 5),
        // The wrap needs a count of the low bits of the rows.
        (65_536, 1),
        (65_535, 0),
    ] {
        let ingest = finished(archive(&names(rows), declared, None).bytes);
        assert_eq!(ingest.status(), &Status::Complete);
        assert_eq!(count_fields(&ingest), (1.0, 0.0), "{rows} {declared}");
        assert_eq!(
            ingest.health().count_mismatch,
            Some((u64::from(declared), rows as u64))
        );
        assert!(!ingest.health().count_wrapped);
    }
}

#[test]
fn a_true_count_has_no_count_finding() {
    for rows in [0, 1, 65_535] {
        let declared = u16::try_from(rows).unwrap();
        let ingest = finished(archive(&names(rows), declared, None).bytes);
        assert_eq!(count_fields(&ingest), (0.0, 0.0), "{rows}");
    }
}

#[test]
fn a_zip64_count_does_not_get_the_rule() {
    let entries = names(65_539);
    // The two records agree on 3. The classic record is what a writer with no
    // Zip64 has, but the locator tells that this writer knew Zip64.
    let ingest = finished(archive(&entries, 3, Some(3)).bytes);
    assert_eq!(ingest.status(), &Status::Complete);
    assert_eq!(ingest.entries_hint(), 3);
    assert_eq!(count_fields(&ingest), (1.0, 0.0));
    // The classic record has the Zip64 marker.
    let ingest = finished(archive(&entries, u16::MAX, Some(3)).bytes);
    assert_eq!(ingest.entries_hint(), 3);
    assert_eq!(count_fields(&ingest), (1.0, 0.0));
    // The true count in Zip64 has no finding.
    let ingest = finished(archive(&entries, u16::MAX, Some(65_539)).bytes);
    assert_eq!(count_fields(&ingest), (0.0, 0.0));
}

#[test]
fn the_count_is_compared_only_when_parsing_is_complete() {
    // The rows are 3, and then 65,539, so the two values agree in 16 bits. The
    // parse sees the end of the directory only in its next call.
    let mut ingest = open(archive(&names(65_539), 3, None).bytes);
    ingest.parse(3);
    assert_eq!(ingest.status(), &Status::Parsing);
    assert_eq!(count_fields(&ingest), (0.0, 0.0));
    ingest.parse(65_536);
    assert_eq!(ingest.status(), &Status::Parsing);
    assert_eq!(ingest.store().rows(), 65_539);
    assert_eq!(count_fields(&ingest), (0.0, 0.0));
    ingest.parse(1);
    assert_eq!(ingest.status(), &Status::Complete);
    assert_eq!(count_fields(&ingest), (0.0, 1.0));
    // After a terminal error, the rows are not the count of the directory.
    let mut fixture = archive(&names(65_540), 3, None);
    let last = *fixture.records.last().unwrap();
    fixture.bytes[last] = b'X';
    let ingest = finished(fixture.bytes);
    assert!(matches!(ingest.status(), Status::Failed(_)));
    assert_eq!(ingest.store().rows(), 65_539);
    assert_eq!(count_fields(&ingest), (0.0, 0.0));
}

// The overlap check -------------------------------------------------------

#[test]
fn the_local_header_counts_at_the_two_sides_of_its_boundary() {
    let touch = HEADER + 40;
    // A runs past the header of B, but A + csize only touches B.
    assert_overlaps(&[row("a", 0, 40), row("b", 40, 10)], &[true, true]);
    assert_overlaps(&[row("a", 0, 40), row("b", touch - 1, 10)], &[true, true]);
    assert_overlaps(&[row("a", 0, 40), row("b", touch, 10)], &[false, false]);
    assert_overlaps(&[row("a", 0, 40), row("b", touch + 1, 10)], &[false, false]);
}

#[test]
fn an_empty_entry_has_its_local_header() {
    // Two and three empty entries at one header.
    assert_overlaps(&[row("a", 0, 0), row("b", 0, 0)], &[true, true]);
    assert_overlaps(
        &[row("a", 5, 0), row("b", 5, 0), row("c", 5, 0)],
        &[true, true, true],
    );
    // Then the boundary of an empty entry.
    assert_overlaps(&[row("a", 0, 0), row("b", HEADER - 1, 0)], &[true, true]);
    assert_overlaps(&[row("a", 0, 0), row("b", HEADER, 0)], &[false, false]);
    // An empty row in the data of a row, and after it.
    assert_overlaps(&[row("a", 0, 100), row("b", 50, 0)], &[true, true]);
    assert_overlaps(&[row("a", 0, 100), row("b", HEADER + 99, 0)], &[true, true]);
    assert_overlaps(
        &[row("a", 0, 100), row("b", HEADER + 100, 0)],
        &[false, false],
    );
    // A row at the header of an empty row.
    assert_overlaps(&[row("a", 0, 0), row("b", 0, 100)], &[true, true]);
}

#[test]
fn only_the_rows_of_an_overlap_get_the_mark() {
    assert_overlaps(
        &[
            row("a", 0, 0),
            row("b", 30, 0),
            row("c", 60, 10),
            row("d", 99, 0),
            row("e", 130, 0),
        ],
        &[false, false, true, true, false],
    );
}

#[test]
fn a_late_empty_row_with_a_lower_offset_takes_the_sort() {
    // The offsets go back only at an empty row. The rows before it have no
    // overlap, and the sort finds the overlap of the empty row with the first.
    let rows = [row("a", 0, 100), row("b", 500, 0), row("c", 10, 0)];
    let ingest = finished(archive(&rows, 3, None).bytes);
    assert_eq!(overlaps(&ingest), [true, false, true]);
    assert_eq!(ingest.health_vector()[health::OVERLAPS_CHECKED], 1.0);
    let rows = [row("a", 0, 0), row("b", 500, 0), row("c", 30, 0)];
    let ingest = finished(archive(&rows, 3, None).bytes);
    assert_eq!(overlaps(&ingest), [false, false, false]);
}

#[test]
fn sizes_near_the_largest_value_do_not_wrap_the_range() {
    let entry = |name: &str, offset: u64, compressed: u64| {
        let mut body = Vec::new();
        zip::u64le(&mut body, compressed);
        zip::u64le(&mut body, compressed);
        zip::u64le(&mut body, offset);
        Entry {
            compressed: u32::MAX,
            size: u32::MAX,
            offset: Some(u32::MAX),
            extra: zip::field(1, &body),
            ..Entry::new(name)
        }
    };
    // Without a saturating sum, the end of A would be before B.
    let rows = [entry("a", 0, u64::MAX - 10), entry("b", 1000, 5)];
    let ingest = finished(archive(&rows, 2, None).bytes);
    assert_eq!(overlaps(&ingest), [true, true]);
    assert_eq!(ingest.health().into_directory_rows, 1);
    // The largest offset: the check must not panic.
    let rows = [entry("a", u64::MAX - 1, 100), entry("b", u64::MAX - 1, 0)];
    let ingest = finished(archive(&rows, 2, None).bytes);
    assert_eq!(overlaps(&ingest), [true, true]);
}

#[test]
fn what_a_writer_makes_has_no_mark() {
    // Empty entries and folders with short names and no gap, data with a
    // descriptor, and a last row with no gap to the directory.
    let mut out = Vec::new();
    let mut archive = rawzip::ZipArchiveWriter::new(&mut out);
    for name in ["a", "b", "folder-empty.txt"] {
        let (mut entry, config) = archive.new_file(name).start().unwrap();
        let writer = config.wrap(&mut entry);
        let (_, descriptor) = writer.finish().unwrap();
        entry.finish(descriptor).unwrap();
    }
    archive.new_dir("folder/").create().unwrap();
    let (mut entry, config) = archive.new_file("data.bin").start().unwrap();
    let mut writer = config.wrap(&mut entry);
    std::io::Write::write_all(&mut writer, &[7; 1000]).unwrap();
    let (_, descriptor) = writer.finish().unwrap();
    entry.finish(descriptor).unwrap();
    archive.finish().unwrap();
    let ingest = finished(out);
    assert_eq!(ingest.status(), &Status::Complete);
    assert_eq!(ingest.store().rows(), 5);
    assert_eq!(overlaps(&ingest), [false; 5]);
    assert_eq!(into_directory(&ingest), (0.0, -1.0));
    assert_eq!(count_fields(&ingest), (0.0, 0.0));
}

// An overlap of rows with data --------------------------------------------

/// Returns (`OVERLAP_ROWS`, `OVERLAP_DATA_ROWS`, `OVERLAP_DATA_EXAMPLE`).
fn overlap_fields(ingest: &Ingest<Vec<u8>>) -> (f64, f64, f64) {
    let fields = ingest.health_vector();
    (
        fields[health::OVERLAP_ROWS],
        fields[health::OVERLAP_DATA_ROWS],
        fields[health::OVERLAP_DATA_EXAMPLE],
    )
}

/// Checks the two counts of rows while rows arrive and in the sort. The example
/// is the first row in each order, so the sort checks only the counts.
fn assert_data_overlaps(rows: &[Entry], overlap: f64, with_data: f64, example: f64) {
    let hint = u16::try_from(rows.len()).unwrap();
    let ingest = finished(archive(rows, hint, None).bytes);
    assert_eq!(
        overlap_fields(&ingest),
        (overlap, with_data, example),
        "while rows arrive"
    );
    let reversed: Vec<Entry> = rows.iter().rev().cloned().collect();
    let ingest = finished(archive(&reversed, hint, None).bytes);
    let (sorted_overlap, sorted_data, _) = overlap_fields(&ingest);
    assert_eq!(
        (sorted_overlap, sorted_data),
        (overlap, with_data),
        "in the sort"
    );
}

fn corpus(name: &str) -> Vec<u8> {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../fuzz/corpus/ingest")
        .join(name);
    std::fs::read(path).unwrap()
}

#[test]
fn the_real_output_of_a_writer_with_an_alias_of_an_empty_file_has_no_data_overlap() {
    // The Rust `zip` crate 9.4.0: `shallow_copy_file` adds a central record that
    // points to the same local header. The file has `empty.txt`, its alias
    // `alias.txt`, and `real.txt`.
    let ingest = finished(corpus("regression-zip-crate-alias-empty.zip"));
    assert_eq!(ingest.status(), &Status::Complete);
    assert_eq!(ingest.store().rows(), 3);
    assert_eq!(overlaps(&ingest), [true, true, false]);
    assert_eq!(overlap_fields(&ingest), (2.0, 0.0, -1.0));
    let summary = ingest.health();
    assert_eq!(summary.overlap_data_rows, 0);
    assert_eq!(summary.into_directory_rows, 0);
    assert_eq!(summary.bomb_rows, 0);
    // An alias of a file with data has two rows that read the same bytes.
    let ingest = finished(corpus("regression-zip-crate-alias-data.zip"));
    assert_eq!(ingest.store().rows(), 2);
    assert_eq!(overlap_fields(&ingest), (2.0, 2.0, 0.0));
}

#[test]
fn rows_that_both_have_data_are_the_data_overlap_at_the_boundary() {
    let touch = HEADER + 40;
    assert_data_overlaps(&[row("a", 0, 40), row("b", 0, 40)], 2.0, 2.0, 0.0);
    assert_data_overlaps(&[row("a", 0, 40), row("b", touch - 1, 1)], 2.0, 2.0, 0.0);
    assert_data_overlaps(&[row("a", 0, 40), row("b", touch, 1)], 0.0, 0.0, -1.0);
}

#[test]
fn an_overlap_with_a_row_with_no_data_is_not_a_data_overlap() {
    // Two empty rows.
    assert_data_overlaps(&[row("a", 0, 0), row("b", 0, 0)], 2.0, 0.0, -1.0);
    // An empty row in the data of a row, also past its header of 30 bytes.
    assert_data_overlaps(&[row("a", 0, 100), row("b", 50, 0)], 2.0, 0.0, -1.0);
    // A row with data at the header of an empty row.
    assert_data_overlaps(&[row("a", 0, 0), row("b", 0, 100)], 2.0, 0.0, -1.0);
    // Each overlap has the empty row. The two rows with data do not overlap, also
    // when the empty row has the largest end between them.
    assert_data_overlaps(
        &[row("a", 0, 1), row("empty", 20, 0), row("b", 40, 1)],
        3.0,
        0.0,
        -1.0,
    );
}

#[test]
fn an_empty_row_between_rows_with_data_does_not_hide_their_overlap() {
    // The empty row ends before `a`, so `a` keeps the largest end.
    assert_data_overlaps(
        &[row("a", 0, 100), row("empty", 10, 0), row("b", 120, 1)],
        3.0,
        2.0,
        0.0,
    );
    // The empty row has the largest end of all rows, and `b` overlaps only `a`
    // among the rows with data.
    assert_data_overlaps(
        &[row("a", 0, 10), row("empty", 30, 0), row("b", 39, 1)],
        3.0,
        2.0,
        0.0,
    );
}

#[test]
fn each_row_with_data_counts_one_time() {
    // Many rows in one row.
    assert_data_overlaps(
        &[
            row("a", 0, 1000),
            row("b", 10, 1),
            row("c", 20, 1),
            row("d", 30, 1),
        ],
        4.0,
        4.0,
        0.0,
    );
    // A short row in a long row does not end the long row.
    assert_data_overlaps(
        &[row("a", 0, 1000), row("b", 10, 1), row("c", 500, 1)],
        3.0,
        3.0,
        0.0,
    );
    // Each row has a new largest end, and each overlaps the one before.
    assert_data_overlaps(
        &[
            row("a", 0, 50),
            row("b", 40, 50),
            row("c", 80, 50),
            row("d", 120, 50),
        ],
        4.0,
        4.0,
        0.0,
    );
    // Two groups, and rows with the same end.
    assert_data_overlaps(
        &[
            row("a", 0, 40),
            row("b", 10, 30),
            row("c", 1000, 1),
            row("d", 2000, 40),
            row("e", 2000, 40),
        ],
        4.0,
        4.0,
        0.0,
    );
}

#[test]
fn the_sort_after_parsing_does_not_count_a_row_two_times() {
    // The first two rows count while rows arrive. The third row sends the check
    // to the sort, which starts again from the first row.
    let rows = [row("a", 100, 100), row("b", 150, 10), row("c", 90, 20)];
    let ingest = finished(archive(&rows, 3, None).bytes);
    assert_eq!(overlap_fields(&ingest), (3.0, 3.0, 0.0));
    assert_eq!(ingest.health().overlap_data_rows, 3);
}

#[test]
fn the_count_of_data_overlaps_does_not_go_down_in_the_steps_of_the_sort() {
    // A stop at the memory limit can end the sort at any step. The count that
    // the first rows gave must stay until the sort finds more.
    // The list is longer than the part of the checks that the last parse call
    // runs.
    let mut rows = vec![row("a", 10_000_000, 100), row("b", 10_000_010, 100)];
    rows.extend((0..20_000).map(|at| row(&format!("r{at}"), (20_000 - at) * 100, 1)));
    let mut ingest = open(archive(&rows, 20_002, None).bytes);
    ingest.parse(u32::MAX);
    let mut last = ingest.health_vector()[health::OVERLAP_DATA_ROWS];
    assert_eq!(last, 2.0);
    let mut steps = 0;
    while !ingest.finish_checks_step(16) {
        let now = ingest.health_vector()[health::OVERLAP_DATA_ROWS];
        assert!(now >= last, "{now} after {last}");
        assert!(now <= 2.0);
        last = now;
        steps += 1;
    }
    assert!(steps > 10, "{steps} steps");
    assert_eq!(ingest.health_vector()[health::OVERLAP_DATA_ROWS], 2.0);
}

// Data into the central directory -----------------------------------------

#[test]
fn data_into_the_directory_has_a_finding_at_its_boundary() {
    let body = 200;
    let last = body - HEADER;
    for (offset, compressed, want) in [
        // Empty rows: the 30 bytes count.
        (last, 0, (0.0, -1.0)),
        (last + 1, 0, (1.0, 0.0)),
        (body - 1, 0, (1.0, 0.0)),
        // Rows with data.
        (0, last, (0.0, -1.0)),
        (0, last + 1, (1.0, 0.0)),
        (100, last - 100, (0.0, -1.0)),
        (100, last - 99, (1.0, 0.0)),
        // A row at the directory or after it has its place in that part of the
        // file, as in an optimized jar.
        (body, 0, (0.0, -1.0)),
        (body, 10_000, (0.0, -1.0)),
        (body + 1, 10_000, (0.0, -1.0)),
    ] {
        let ingest = finished(with_directory_at(&[row("a", offset, compressed)], body, 0));
        assert_eq!(ingest.status(), &Status::Complete);
        assert_eq!(
            into_directory(&ingest),
            want,
            "offset {offset}, size {compressed}"
        );
        assert_eq!(ingest.health().into_directory_rows != 0, want.0 != 0.0);
        // It does not make an overlap of one row.
        assert_eq!(overlaps(&ingest), [false]);
    }
}

#[test]
fn the_finding_counts_each_row_once_and_names_the_first() {
    // In the order of the records, also when the offsets go back.
    let rows = [
        row("ok", 0, 0),
        row("a", 200, 1000),
        row("b", 100, 1000),
        row("c", 50, 5),
    ];
    let ingest = finished(with_directory_at(&rows, 300, 0));
    assert_eq!(into_directory(&ingest), (2.0, 1.0));
    assert_eq!(ingest.into_directory_from(0), 2);
    assert_eq!(ingest.into_directory_from(1), 2);
    assert_eq!(ingest.into_directory_from(2), 1);
    assert_eq!(ingest.into_directory_from(3), 0);
    assert_eq!(ingest.into_directory_from(4), 0);
}

#[test]
fn a_prefix_repair_compares_the_directory_in_the_base_of_the_rows() {
    let prefix = 1000;
    // rawzip adds the prefix to the rows and to the directory. With the
    // directory in the other base, this row runs past it by 1,000 bytes.
    let touch = finished(with_directory_at(&[row("a", 0, 170)], 200, prefix));
    assert_eq!(touch.directory_offset(), 1200);
    assert_eq!(touch.store().rows(), 1);
    assert_eq!(touch.health().prelude_bytes, 1000);
    assert_eq!(into_directory(&touch), (0.0, -1.0));
    // With the row in the other base, this row has no finding.
    let past = finished(with_directory_at(&[row("a", 0, 171)], 200, prefix));
    assert_eq!(into_directory(&past), (1.0, 0.0));
}

#[test]
fn the_rows_of_a_part_of_a_spanned_archive_are_not_compared_with_the_directory() {
    // The rows of other parts have offsets in those parts.
    for (at, value) in [(4, 3u16), (6, 2u16)] {
        let mut bytes = with_directory_at(&[row("a", 0, 1000)], 200, 0);
        let end = bytes.len() - 22;
        bytes[end + at..end + at + 2].copy_from_slice(&value.to_le_bytes());
        let ingest = finished(bytes);
        assert_eq!(ingest.status(), &Status::Complete);
        assert_eq!(into_directory(&ingest), (0.0, -1.0));
    }
}

#[test]
fn a_directory_at_the_start_of_the_file_has_no_finding_for_the_rows_after_it() {
    // The shape of an optimized jar: the directory, and then the entries. The
    // record does not end the directory. rawzip stops after the directory.
    let mut records = Vec::new();
    let mut local = Vec::new();
    let directory_size = 46 + 1;
    let data = 2000u32;
    u32le(&mut records, 0x0201_4b50);
    u16le(&mut records, 0x031e);
    u16le(&mut records, 20);
    records.extend_from_slice(&[0; 12]);
    u32le(&mut records, data);
    u32le(&mut records, data);
    u16le(&mut records, 1);
    records.extend_from_slice(&[0; 12]);
    u32le(&mut records, directory_size);
    records.push(b'a');
    u32le(&mut local, 0x0403_4b50);
    local.extend_from_slice(&[0; 22]);
    u16le(&mut local, 1);
    u16le(&mut local, 0);
    local.push(b'a');
    local.resize(local.len() + data as usize, 0);
    let mut out = records;
    out.extend_from_slice(&local);
    u32le(&mut out, 0x0605_4b50);
    u16le(&mut out, 0);
    u16le(&mut out, 0);
    u16le(&mut out, 1);
    u16le(&mut out, 1);
    u32le(&mut out, directory_size);
    u32le(&mut out, 0);
    u16le(&mut out, 0);
    let ingest = finished(out);
    assert_eq!(ingest.store().rows(), 1);
    assert_eq!(into_directory(&ingest), (0.0, -1.0));
    assert_eq!(overlaps(&ingest), [false]);
}

#[test]
fn only_the_chosen_directory_counts_with_a_second_place() {
    // The offset and the size of the end record give two directories, and
    // the chosen one is at the offset. A row that runs over the other place
    // has no finding. The other place is after the row and after the chosen
    // directory, so the chosen directory must be the value of the check.
    let row_bytes = |name: &[u8], offset: u32, compressed: u32| {
        let mut out = Vec::new();
        u32le(&mut out, 0x0201_4b50);
        u16le(&mut out, 0x031e);
        u16le(&mut out, 20);
        out.extend_from_slice(&[0; 12]);
        u32le(&mut out, compressed);
        u32le(&mut out, compressed);
        u16le(&mut out, u16::try_from(name.len()).unwrap());
        out.extend_from_slice(&[0; 12]);
        u32le(&mut out, offset);
        out.extend_from_slice(name);
        out
    };
    let chosen_place = 100_usize;
    let build = |compressed: u32| {
        let mut out = vec![0u8; chosen_place];
        out.extend_from_slice(&row_bytes(b"a", 0, compressed));
        let other = out.len();
        out.extend_from_slice(&row_bytes(b"b", 0, 0));
        let size = u32::try_from(out.len() - other).unwrap();
        u32le(&mut out, 0x0605_4b50);
        u16le(&mut out, 0);
        u16le(&mut out, 0);
        u16le(&mut out, 1);
        u16le(&mut out, 1);
        u32le(&mut out, size);
        u32le(&mut out, u32::try_from(chosen_place).unwrap());
        u16le(&mut out, 0);
        out
    };
    let touch = finished(build(70));
    assert_eq!(touch.directory_offset(), chosen_place as u64);
    assert_eq!(touch.health_vector()[health::END_SECOND_DIRECTORY], 1.0);
    assert_eq!(into_directory(&touch), (0.0, -1.0));
    let past = finished(build(71));
    assert_eq!(into_directory(&past).0, 1.0);
}
