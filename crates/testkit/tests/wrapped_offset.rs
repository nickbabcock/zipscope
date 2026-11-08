//! An archive over 4 GiB with no Zip64: its offsets wrap, and rawzip adds the
//! difference to all rows. These tests give the shape, each neighbour of it,
//! and hostile archives that try to use the path to hide a true finding. The
//! files are sparse buffers: they keep only some kilobytes.

use std::cell::Cell;
use std::io::Write;
use std::rc::Rc;

use rawzip::ReaderAt;
use zipscope_core::contract::{Column, marks};
use zipscope_core::health::Summary;
use zipscope_core::ingest::{Ingest, Status};
use zipscope_layout::end::CutComment;
use zipscope_layout::{EntrySpan, Kind, Label, Layout};
use zipscope_testkit::archives::zip64_sparse;
use zipscope_testkit::sparse::SparseBytes;
use zipscope_testkit::wrapped::{Archive, GIB, Row, WRAP, after_the_limit, three_rows};

/// A reader that counts its reads.
#[derive(Debug)]
struct Counted {
    bytes: SparseBytes,
    reads: Rc<Cell<u64>>,
}

impl ReaderAt for Counted {
    fn read_at(&self, buf: &mut [u8], offset: u64) -> std::io::Result<usize> {
        self.reads.set(self.reads.get() + 1);
        self.bytes.read_at(buf, offset)
    }
}

fn counted(bytes: SparseBytes) -> (Counted, Rc<Cell<u64>>) {
    let reads = Rc::new(Cell::new(0));
    (
        Counted {
            bytes,
            reads: Rc::clone(&reads),
        },
        reads,
    )
}

#[expect(
    clippy::cast_possible_truncation,
    clippy::cast_sign_loss,
    reason = "Store values are exact to 2^53."
)]
fn whole(value: f64) -> u64 {
    value as u64
}

/// One row of the store.
#[derive(Debug, PartialEq)]
struct Listed {
    name: String,
    offset: u64,
    wrapped: bool,
    overlap: bool,
    bomb: bool,
}

struct Parsed {
    summary: Summary,
    rows: Vec<Listed>,
    layout: Layout,
    status: Status,
}

fn parse(bytes: SparseBytes) -> Parsed {
    let size = bytes.len();
    let again = Rc::new(bytes.clone());
    let mut ingest = Ingest::open(bytes, size).unwrap();
    ingest.parse(u32::MAX);
    ingest.finish_checks();
    finish(&ingest, &again, size)
}

fn finish<R: ReaderAt + 'static>(ingest: &Ingest<R>, bytes: &Rc<SparseBytes>, size: u64) -> Parsed {
    let store = ingest.store();
    let rows = (0..store.rows())
        .map(|row| Listed {
            name: String::from_utf8(store.name(row).to_vec()).unwrap(),
            offset: whole(store.value(row, Column::LocalHeaderOffset)),
            wrapped: store.marks(row) & marks::WRAPPED_OFFSET != 0,
            overlap: store.marks(row) & marks::OVERLAP != 0,
            bomb: store.marks(row) & marks::BOMB_RATIO != 0,
        })
        .collect();
    let spans = (0..store.rows()).map(|row| EntrySpan {
        local_header_offset: whole(store.value(row, Column::LocalHeaderOffset)),
        compressed_size: whole(store.value(row, Column::CompressedSize)),
        uncompressed_size: whole(store.value(row, Column::UncompressedSize)),
        crc32: 0,
        flags: 0,
    });
    let archive = zipscope_layout::end::open_end(Rc::clone(bytes), size)
        .unwrap()
        .archive;
    let (_, layout) = zipscope_layout::map(&archive, size, &*Rc::clone(bytes), spans).unwrap();
    layout.validate(size).unwrap();
    Parsed {
        summary: ingest.health(),
        rows,
        layout,
        status: ingest.status().clone(),
    }
}

fn offsets(parsed: &Parsed) -> Vec<u64> {
    parsed.rows.iter().map(|row| row.offset).collect()
}

fn wrapped(parsed: &Parsed) -> Vec<&str> {
    parsed
        .rows
        .iter()
        .filter(|row| row.wrapped)
        .map(|row| row.name.as_str())
        .collect()
}

fn kinds(parsed: &Parsed) -> Vec<Kind> {
    parsed.layout.regions.iter().map(|r| r.kind).collect()
}

/// Puts a small archive of named rows after `prefix` bytes of zeros, as
/// `cat stub app.zip` does: all offset fields count from the end of the stub.
fn after_prefix(prefix: u64, names: &[&str]) -> Archive {
    let rows: Vec<Row> = (0..)
        .zip(names)
        .map(|(index, name): (u32, _)| {
            let mut row = Row::new(name, prefix + 100 * u64::from(index)).body(b"data");
            row.offset_field = Some(100 * index);
            row
        })
        .collect();
    let count = u32::try_from(names.len()).unwrap();
    Archive {
        directory: prefix + 100 * u64::from(count),
        declared: Some(100 * count),
        rows,
        ..Archive::default()
    }
}

#[test]
fn the_shape_gets_one_true_finding_and_true_places() {
    let spec = three_rows();
    let parsed = parse(spec.build());
    assert_eq!(parsed.status, Status::Complete);
    let summary = &parsed.summary;
    assert_eq!(summary.prelude_bytes, 0, "no false prelude");
    assert_eq!(summary.overlap_rows, 0, "no false overlap");
    assert_eq!(summary.bomb_rows, 0);
    assert_eq!(summary.wrapped_rows, 2);
    assert_eq!(wrapped(&parsed), ["a.bin", "b.bin"]);
    let expected: Vec<u64> = spec.rows.iter().map(|row| row.place).collect();
    assert_eq!(offsets(&parsed), expected);
    // The byte map shows the true places too.
    assert_eq!(
        kinds(&parsed),
        [Kind::Entries, Kind::Directory, Kind::EndRecord]
    );
    let counts = &parsed.layout.counts;
    assert_eq!(counts.bad_headers, 0);
    assert_eq!(counts.overlapping, 0);
    assert_eq!(counts.gaps, 0);
    assert_eq!(counts.zip64_rows, 0, "these rows have no Zip64 fields");
}

#[test]
fn offsets_that_wrap_two_times_get_their_windows() {
    let spec = Archive {
        rows: vec![
            Row::new("one", 100).sized(1 << 31),
            Row::new("two", 4 * GIB + 200).sized(1 << 31),
            Row::new("three", 8 * GIB + 300).sized(1 << 20),
        ],
        directory: 8 * GIB + (1 << 21),
        ..Archive::default()
    };
    let parsed = parse(spec.build());
    assert_eq!(offsets(&parsed), [100, 4 * GIB + 200, 8 * GIB + 300]);
    assert_eq!(wrapped(&parsed), ["one", "two"]);
    assert_eq!(parsed.summary.prelude_bytes, 100);
    assert_eq!(parsed.summary.overlap_rows, 0);
}

#[test]
fn a_row_past_the_size_field_does_not_move_the_rows_after_it() {
    // A writer with no Zip64 also cuts a size of 5 GiB to its low 32 bits.
    // The row after it is 4 GiB past the end that the fields give.
    let spec = Archive {
        rows: vec![
            Row::new("large", 0).sized(u32::try_from(GIB).unwrap()),
            Row::new("after", 5 * GIB + 40).body(b"after"),
        ],
        directory: 5 * GIB + 100,
        ..Archive::default()
    };
    let parsed = parse(spec.build());
    assert_eq!(offsets(&parsed), [0, 5 * GIB + 40]);
    assert_eq!(wrapped(&parsed), ["large"]);
    assert_eq!(parsed.summary.overlap_rows, 0);
}

#[test]
fn a_central_directory_in_another_order_gets_the_same_places() {
    let mut spec = three_rows();
    spec.rows.reverse();
    let parsed = parse(spec.build());
    assert_eq!(wrapped(&parsed), ["b.bin", "a.bin"]);
    assert_eq!(parsed.summary.prelude_bytes, 0);
    assert_eq!(parsed.summary.overlap_rows, 0);
}

#[test]
fn the_same_name_in_two_windows_is_not_an_overlap() {
    let spec = Archive {
        rows: vec![
            Row::new("same", 100).sized(1 << 20),
            Row::new("same", 4 * GIB + 100).sized(1 << 20),
            Row::new("last", 8 * GIB + 100).body(b"x"),
        ],
        directory: 8 * GIB + 200,
        ..Archive::default()
    };
    let parsed = parse(spec.build());
    assert_eq!(offsets(&parsed), [100, 4 * GIB + 100, 8 * GIB + 100]);
    assert_eq!(parsed.summary.overlap_rows, 0);
}

// The neighbours -----------------------------------------------------------

#[test]
fn a_small_prefix_stays_a_prelude() {
    let mut spec = after_prefix(100, &["in.txt"]);
    spec.prefix = b"#!/bin/sh\nexit 0\n".to_vec();
    let parsed = parse(spec.build());
    assert_eq!(parsed.summary.prelude_bytes, 100);
    assert_eq!(parsed.summary.wrapped_rows, 0);
}

#[test]
fn a_prefix_past_4_gib_that_is_no_multiple_stays_a_prelude() {
    let spec = after_prefix(WRAP + 100, &["one", "two"]);
    let parsed = parse(spec.build());
    assert_eq!(parsed.summary.prelude_bytes, WRAP + 100);
    assert_eq!(parsed.summary.wrapped_rows, 0);
    assert_eq!(parsed.summary.overlap_rows, 0);
    assert_eq!(parsed.layout.counts.zip64_rows, 0);
}

#[test]
fn a_prefix_of_a_multiple_of_4_gib_stays_a_prelude() {
    for prefix in [WRAP, 2 * WRAP, 3 * WRAP] {
        let spec = after_prefix(prefix, &["one", "two", "three"]);
        let parsed = parse(spec.build());
        assert_eq!(parsed.summary.prelude_bytes, prefix);
        assert_eq!(parsed.summary.wrapped_rows, 0);
        assert_eq!(parsed.summary.overlap_rows, 0);
        assert_eq!(offsets(&parsed), [prefix, prefix + 100, prefix + 200]);
        assert_eq!(parsed.layout.regions[0].kind, Kind::Prelude);
        assert_eq!(parsed.layout.regions[0].end, prefix);
        assert_eq!(parsed.layout.counts.zip64_rows, 0);
    }
}

#[test]
fn a_prefix_with_headers_of_the_same_names_stays_a_prelude() {
    // Two archives, one after the other, the first of exactly 4 GiB. The
    // first has a local header of the same name at the same low offset.
    let mut spec = after_prefix(WRAP, &["same", "name"]);
    spec.headers = vec![Row::new("same", 0).body(b"old"), Row::new("name", 100)];
    let parsed = parse(spec.build());
    assert_eq!(parsed.summary.prelude_bytes, WRAP);
    assert_eq!(parsed.summary.wrapped_rows, 0);
    assert_eq!(offsets(&parsed), [WRAP, WRAP + 100]);
}

/// A comment with a stray end signature that the walk must skip.
const STRAY: &[u8] = b"note PK\x05\x06 and more text than an end record needs";

#[test]
fn a_stray_signature_does_not_change_the_shape() {
    let plain = parse(three_rows().build());
    let mut spec = three_rows();
    spec.comment = STRAY.to_vec();
    let parsed = parse(spec.build());
    assert_eq!(parsed.status, Status::Complete);
    assert_eq!(parsed.summary.wrapped_rows, plain.summary.wrapped_rows);
    assert_eq!(wrapped(&parsed), wrapped(&plain));
    assert_eq!(offsets(&parsed), offsets(&plain));
    assert_eq!(parsed.summary.prelude_bytes, 0);
    assert_eq!(parsed.summary.end_notes.skipped, 1);
}

#[test]
fn a_stray_signature_does_not_turn_a_prefix_into_the_shape() {
    let mut spec = after_prefix(WRAP, &["one", "two", "three"]);
    spec.comment = STRAY.to_vec();
    let parsed = parse(spec.build());
    assert_eq!(parsed.summary.wrapped_rows, 0);
    assert_eq!(parsed.summary.prelude_bytes, WRAP);
    assert_eq!(offsets(&parsed), [WRAP, WRAP + 100, WRAP + 200]);
    assert_eq!(parsed.summary.end_notes.skipped, 1);
}

#[test]
fn a_stray_signature_does_not_turn_the_locator_path_on() {
    let mut spec = three_rows();
    spec.locator = true;
    spec.comment = STRAY.to_vec();
    let parsed = parse(spec.build());
    assert_eq!(parsed.summary.wrapped_rows, 0);
    assert_eq!(parsed.summary.prelude_bytes, WRAP);
}

#[test]
fn a_cut_comment_keeps_the_shape() {
    let plain = parse(three_rows().build());
    let mut spec = three_rows();
    spec.comment = b"cut comment".to_vec();
    spec.comment_length = Some(500);
    let size = spec.build().len();
    let parsed = parse(spec.build());
    assert_eq!(wrapped(&parsed), wrapped(&plain));
    assert_eq!(offsets(&parsed), offsets(&plain));
    assert_eq!(
        parsed.summary.end_notes.cut_comment,
        Some(CutComment {
            declared: 500,
            present: 11
        })
    );
    assert_eq!(parsed.summary.epilogue_bytes, 0);
    assert_eq!(parsed.layout.regions.last().unwrap().kind, Kind::EndRecord);
    assert_eq!(parsed.layout.regions.last().unwrap().end, size);
}

#[test]
fn a_fake_record_of_the_shape_in_a_comment_gets_the_warning() {
    // The fake record is nearest the end, so it wins, and the shape is for its
    // rows. The warning tells of the true record.
    let mut spec = three_rows();
    let record = Row::new("fake.bin", 0).record_bytes();
    let true_records: u64 = spec
        .rows
        .iter()
        .map(|row| row.record_bytes().len() as u64)
        .sum();
    let fake_directory = spec.directory + true_records + 22;
    let mut comment = record.clone();
    comment.extend_from_slice(b"PK\x05\x06\0\0\0\0\x01\0\x01\0");
    comment.extend_from_slice(&u32::try_from(record.len()).unwrap().to_le_bytes());
    comment.extend_from_slice(&u32::try_from(fake_directory % WRAP).unwrap().to_le_bytes());
    comment.extend_from_slice(&[0, 0]);
    spec.comment = comment;
    let parsed = parse(spec.build());
    assert_eq!(parsed.rows.len(), 1);
    assert_eq!(parsed.rows[0].name, "fake.bin");
    assert_eq!(parsed.summary.end_notes.other_records, 1);
}

#[test]
fn zip64_with_a_stray_signature_is_not_the_shape() {
    let plain = parse(zip64_sparse().unwrap());
    // The last two bytes of the file are its comment length of 0.
    let mut stray = zip64_sparse().unwrap();
    stray.overwrite_end(&u16::try_from(STRAY.len()).unwrap().to_le_bytes());
    stray.write_all(STRAY).unwrap();
    let parsed = parse(stray);
    assert_eq!(parsed.status, Status::Complete);
    assert_eq!(parsed.summary.wrapped_rows, 0);
    assert_eq!(parsed.summary.end_notes.skipped, 1);
    assert_eq!(parsed.rows.len(), plain.rows.len());
    assert!(parsed.layout.counts.zip64_rows > 0);
}

#[test]
fn zip64_is_not_the_shape() {
    let parsed = parse(zip64_sparse().unwrap());
    assert_eq!(parsed.status, Status::Complete);
    assert_eq!(parsed.summary.wrapped_rows, 0);
    assert_eq!(parsed.summary.prelude_bytes, 0);
    assert_eq!(parsed.summary.overlap_rows, 0);
    assert!(parsed.layout.counts.zip64_rows > 0);
}

#[test]
fn a_locator_turns_the_path_off() {
    // rawzip does not use the locator of this file, and it adds the
    // difference. The false findings stay: the text "without Zip64" would
    // not be true.
    let mut spec = three_rows();
    spec.locator = true;
    let parsed = parse(spec.build());
    assert_eq!(parsed.summary.wrapped_rows, 0);
    assert_eq!(parsed.summary.prelude_bytes, WRAP);
    assert!(parsed.summary.overlap_rows > 0);
}

#[test]
fn a_zip64_marker_or_a_second_disk_turns_the_path_off() {
    let mut spec = three_rows();
    spec.directory = 2 * WRAP - 1;
    spec.declared = Some(u32::MAX);
    assert_eq!(parse(spec.build()).summary.wrapped_rows, 0);
    let mut spec = three_rows();
    spec.disk = 1;
    assert_eq!(parse(spec.build()).summary.wrapped_rows, 0);
}

#[test]
fn a_difference_that_is_no_multiple_is_not_the_shape() {
    let mut spec = three_rows();
    spec.declared = Some(1000);
    let parsed = parse(spec.build());
    assert_eq!(parsed.summary.wrapped_rows, 0);
}

/// The first `size` bytes of a file.
#[derive(Debug)]
struct Cut {
    bytes: SparseBytes,
    size: u64,
}

impl ReaderAt for Cut {
    fn read_at(&self, buf: &mut [u8], offset: u64) -> std::io::Result<usize> {
        let left = self.size.saturating_sub(offset);
        let wanted = buf.len().min(usize::try_from(left).unwrap_or(usize::MAX));
        self.bytes.read_at(&mut buf[..wanted], offset)
    }
}

#[test]
fn a_file_cut_at_the_end_does_not_open() {
    let spec = three_rows();
    let full = spec.build().len();
    // In the end record, in the central directory, in the data of a row.
    for size in [
        full - 1,
        full - 22,
        spec.directory + 10,
        spec.directory - 50,
    ] {
        let cut = Cut {
            bytes: spec.build(),
            size,
        };
        Ingest::open(cut, size).unwrap_err();
    }
}

#[test]
fn a_file_cut_at_the_start_moves_only_rows_with_a_header() {
    // The first 4 GiB of a file with two wraps are gone. Row `lost` has no
    // header anywhere, so it stays and it gets no finding. The file has the
    // shape, and row `kept` has its header at the lower place.
    let spec = Archive {
        rows: vec![
            Row::new("lost", 0).no_header(),
            Row::new("kept", GIB / 2).sized(1 << 20),
            Row::new("last", 4 * GIB + GIB).body(b"x"),
        ],
        directory: 5 * GIB + 100,
        ..Archive::default()
    };
    let parsed = parse(spec.build());
    assert_eq!(wrapped(&parsed), ["kept"]);
    assert_eq!(offsets(&parsed), [WRAP, GIB / 2, 5 * GIB]);
    assert_eq!(parsed.summary.prelude_bytes, GIB / 2);
}

#[test]
fn a_stray_end_signature_is_not_the_shape() {
    // A stray end record in the bytes after a true prefix of 4 GiB: it gives
    // a difference of 4 GiB, and the rows are at the offsets that it gives.
    let mut spec = after_prefix(WRAP, &["one", "two"]);
    let size_of_records: usize = spec.rows.iter().map(|row| 46 + row.name.len()).sum();
    let records = u32::try_from(size_of_records + 22).unwrap();
    let mut stray = Vec::new();
    stray.extend_from_slice(&0x0605_4b50u32.to_le_bytes());
    stray.extend_from_slice(&[0; 4]);
    stray.extend_from_slice(&2u16.to_le_bytes());
    stray.extend_from_slice(&2u16.to_le_bytes());
    stray.extend_from_slice(&records.to_le_bytes());
    stray.extend_from_slice(&u32::try_from(spec.directory - WRAP).unwrap().to_le_bytes());
    stray.extend_from_slice(&[0; 2]);
    spec.tail = stray;
    let parsed = parse(spec.build());
    assert_eq!(parsed.summary.wrapped_rows, 0);
    assert_eq!(parsed.summary.prelude_bytes, WRAP);
    // The real end record ends the records with an error, as before.
    assert!(matches!(parsed.status, Status::Failed(_)));
    assert_eq!(parsed.rows.len(), 2);
    // The walk skips a stray signature with junk fields, and it gets the shape
    // of the file.
    let mut spec = three_rows();
    spec.comment = b"PK\x05\x06 not an end record at all".to_vec();
    let parsed = parse(spec.build());
    assert_eq!(parsed.status, Status::Complete);
    assert_eq!(parsed.summary.wrapped_rows, 2);
    assert_eq!(parsed.summary.end_notes.skipped, 1);
}

// Hostile archives ---------------------------------------------------------

#[test]
fn records_with_one_name_at_one_low_place_keep_the_overlap() {
    let spec = Archive {
        rows: vec![
            Row::new("twin", 100).sized(1 << 20),
            Row::new("twin", 100).sized(1 << 20),
            Row::new("last", 4 * GIB + GIB).body(b"x"),
        ],
        directory: 5 * GIB + 100,
        ..Archive::default()
    };
    let parsed = parse(spec.build());
    assert_eq!(wrapped(&parsed), ["twin", "twin"]);
    assert_eq!(offsets(&parsed), [100, 100, 5 * GIB]);
    assert_eq!(parsed.summary.overlap_rows, 2);
}

#[test]
fn empty_records_at_one_low_header_overlap_with_their_marks() {
    // The records have no data, and the check counts their local header.
    let spec = Archive {
        rows: vec![
            Row::new("first", 100),
            Row::new("alias", 100),
            Row::new("last", 5 * GIB).body(b"x"),
        ],
        directory: 5 * GIB + 100,
        ..Archive::default()
    };
    let parsed = parse(spec.build());
    assert_eq!(offsets(&parsed), [100, 100, 5 * GIB]);
    assert_eq!(wrapped(&parsed), ["first", "alias"]);
    assert_eq!(parsed.summary.overlap_rows, 2);
    assert_eq!(parsed.summary.into_directory_rows, 0);
}

#[test]
fn rows_at_true_low_places_with_no_gap_do_not_overlap() {
    // The range of `a` touches `b`, also at a low place. The name of `b` is the
    // gap of 1 byte before `c`, as in each file of a writer.
    let spec = Archive {
        rows: vec![
            Row::new("a", 100).sized(1000),
            Row::new("b", 100 + 30 + 1000),
            Row::new("c", 100 + 30 + 1000 + 31),
            Row::new("last", 5 * GIB).body(b"x"),
        ],
        directory: 5 * GIB + 100,
        ..Archive::default()
    };
    let parsed = parse(spec.build());
    assert_eq!(wrapped(&parsed), ["a", "b", "c"]);
    assert_eq!(parsed.summary.overlap_rows, 0);
    assert_eq!(parsed.summary.into_directory_rows, 0);
}

#[test]
fn the_directory_check_uses_the_true_place_of_the_directory() {
    // The low 32 bits of the directory are in the data of the row at a low
    // place. That row is 4 GiB before the true directory, so it has no finding.
    let directory = 5 * GIB + 2000;
    let low_bits = directory - WRAP;
    let spec = Archive {
        rows: vec![
            Row::new("low", low_bits - 100).sized(1000),
            Row::new("last", 5 * GIB).body(b"x"),
        ],
        directory,
        ..Archive::default()
    };
    let parsed = parse(spec.build());
    assert_eq!(wrapped(&parsed), ["low"]);
    assert_eq!(offsets(&parsed)[0], low_bits - 100);
    assert_eq!(parsed.summary.into_directory_rows, 0);
}

#[test]
fn the_directory_check_finds_a_row_at_its_true_place() {
    // A row in the last window runs into the true directory by one byte.
    let directory = 5 * GIB + 2000;
    let row = |size| Row::new("last", 5 * GIB).sized(size);
    let spec = |size| Archive {
        rows: vec![row(size)],
        directory,
        ..Archive::default()
    };
    let parsed = parse(spec(2000 - 30).build());
    assert_eq!(parsed.summary.into_directory_rows, 0);
    let parsed = parse(spec(2000 - 29).build());
    assert_eq!(wrapped(&parsed), Vec::<&str>::new());
    assert_eq!(parsed.summary.into_directory_rows, 1);
}

#[test]
fn records_with_other_names_at_one_low_header_keep_the_overlap() {
    // The overlapping-file zip bomb: many records, each with its own name,
    // and one local header. Only the first name agrees with that header.
    let spec = Archive {
        rows: vec![
            Row::new("kernel", 100).sized(1 << 24),
            Row::new("alias-1", 100).sized(1 << 24),
            Row::new("alias-2", 100).sized(1 << 24),
            Row::new("last", 4 * GIB + GIB).body(b"x"),
        ],
        directory: 5 * GIB + 100,
        ..Archive::default()
    };
    let parsed = parse(spec.build());
    assert_eq!(offsets(&parsed), [100, 100, 100, 5 * GIB]);
    assert_eq!(parsed.summary.overlap_rows, 3);
    assert_eq!(parsed.summary.wrapped_rows, 3);
}

#[test]
fn ranges_that_overlap_at_low_places_keep_the_overlap() {
    let spec = Archive {
        rows: vec![
            Row::new("first", 100).sized(1 << 24),
            Row::new("inside", 1000).sized(1 << 20),
            Row::new("last", 4 * GIB + GIB).body(b"x"),
        ],
        directory: 5 * GIB + 100,
        ..Archive::default()
    };
    let parsed = parse(spec.build());
    assert_eq!(wrapped(&parsed), ["first", "inside"]);
    assert_eq!(parsed.summary.overlap_rows, 2);
}

#[test]
fn an_overlap_at_the_given_offsets_stays() {
    // All records point to one header in the last window.
    let spec = Archive {
        rows: vec![
            Row::new("kernel", 5 * GIB).sized(1 << 24),
            Row::new("alias", 5 * GIB).sized(1 << 24),
        ],
        directory: 5 * GIB + 100,
        ..Archive::default()
    };
    let parsed = parse(spec.build());
    assert_eq!(parsed.summary.wrapped_rows, 0);
    assert_eq!(parsed.summary.overlap_rows, 2);
    assert_eq!(parsed.summary.prelude_bytes, 5 * GIB);
}

#[test]
fn a_bomb_like_ratio_stays_on_a_row_that_moved() {
    let mut spec = three_rows();
    spec.rows[0].compressed = Some(100);
    spec.rows[0].uncompressed = Some(1 << 31);
    let parsed = parse(spec.build());
    assert!(parsed.rows[0].wrapped && parsed.rows[0].bomb);
    assert_eq!(parsed.summary.bomb_rows, 1);
}

#[test]
fn one_low_header_moves_a_true_prelude_into_a_gap_that_shows() {
    // Reach of a hostile archive: a true prefix of 4 GiB with a real header
    // of one row at its start. The prelude ends at that row, as for a row at
    // offset 0 in any archive. The bytes stay visible in the map.
    let mut spec = after_prefix(WRAP, &["one", "two"]);
    spec.rows.push(Row::new("trap", 100).sized(1 << 10));
    let stub = b"MZ a program that a hostile archive hides".to_vec();
    spec.prefix = stub;
    let parsed = parse(spec.build());
    assert_eq!(wrapped(&parsed), ["trap"]);
    assert_eq!(parsed.summary.prelude_bytes, 100);
    let gap = parsed
        .layout
        .regions
        .iter()
        .find(|region| region.kind == Kind::Gap)
        .expect("the bytes of the prefix are a gap");
    assert_eq!(gap.end, WRAP);
    assert_eq!(parsed.layout.regions[0].kind, Kind::Prelude);
    assert_eq!(parsed.layout.regions[0].label, Label::WindowsProgram);
}

#[test]
fn a_row_with_a_field_of_64_bits_stays() {
    let mut extra = Vec::new();
    extra.extend_from_slice(&1u16.to_le_bytes());
    extra.extend_from_slice(&8u16.to_le_bytes());
    extra.extend_from_slice(&(3 * WRAP).to_le_bytes());
    let mut spec = three_rows();
    spec.rows[0].offset_field = Some(u32::MAX);
    spec.rows[0].extra = extra;
    let parsed = parse(spec.build());
    assert_eq!(parsed.rows[0].offset, 4 * WRAP);
    assert!(!parsed.rows[0].wrapped);
}

#[test]
fn a_field_of_64_bits_does_not_move_a_row_to_a_lower_header() {
    // A row with a Zip64 field has no low 32 bits that wrapped. A header of its
    // name below the given offset does not move it.
    let mut extra = Vec::new();
    extra.extend_from_slice(&1u16.to_le_bytes());
    extra.extend_from_slice(&8u16.to_le_bytes());
    extra.extend_from_slice(&(WRAP + 100).to_le_bytes());
    let mut row = Row::new("wide", WRAP + 100).sized(1 << 10);
    row.offset_field = Some(u32::MAX);
    row.extra = extra;
    let spec = Archive {
        rows: vec![row],
        directory: 3 * WRAP + 1000,
        ..Archive::default()
    };
    let parsed = parse(spec.build());
    assert_eq!(wrapped(&parsed), Vec::<&str>::new());
    assert_eq!(offsets(&parsed), [4 * WRAP + 100]);

    // Also after the limit of reads, with no read.
    let mut spec = spec;
    spec.rows.insert(0, Row::new("first", 100).sized(1 << 10));
    let parsed = parse_with_reads(&spec, 2);
    assert_eq!(wrapped(&parsed), ["first"]);
    assert_eq!(offsets(&parsed), [100, 4 * WRAP + 100]);
}

#[test]
fn the_reads_of_a_hostile_archive_have_a_limit_and_later_rows_stay() {
    // Many windows and no headers: each row can read each window.
    let rows: Vec<Row> = (0..50)
        .map(|index| Row::new(&format!("row-{index}"), 100 * index).no_header())
        .collect();
    let spec = Archive {
        rows,
        directory: 1024 * WRAP + 100_000,
        ..Archive::default()
    };
    let bytes = spec.build();
    let size = bytes.len();
    let (probes, reads) = counted(spec.build());
    let mut ingest = Ingest::<Counted>::open(counted(bytes).0, size).unwrap();
    ingest.set_probes(probes);
    ingest.set_place_reads(100);
    assert_eq!(ingest.parse(u32::MAX), 50);
    assert_eq!(reads.get(), 100);
    assert_eq!(ingest.health().wrapped_rows, 0);
}

/// Parses with a limit of reads.
fn parse_with_reads(spec: &Archive, reads: u32) -> Parsed {
    let bytes = spec.build();
    let copy = Rc::new(bytes.clone());
    let size = bytes.len();
    let mut ingest = Ingest::open(bytes, size).unwrap();
    ingest.set_place_reads(reads);
    ingest.parse(u32::MAX);
    ingest.finish_checks();
    finish(&ingest, &copy, size)
}

#[test]
fn a_row_that_finds_no_place_before_the_limit_keeps_the_old_findings() {
    // The limit ends before a row moved. It fails to the side of a false
    // alarm, not of a lost finding.
    let parsed = parse_with_reads(&three_rows(), 1);
    assert_eq!(parsed.summary.wrapped_rows, 0);
    assert_eq!(parsed.summary.overlap_rows, 2);
}

#[test]
fn rows_after_the_limit_follow_the_rows_before_them() {
    let spec = three_rows();
    let parsed = parse_with_reads(&spec, 2);
    assert_eq!(wrapped(&parsed), ["a.bin", "b.bin"]);
    let expected: Vec<u64> = spec.rows.iter().map(|row| row.place).collect();
    assert_eq!(offsets(&parsed), expected);
    assert_eq!(parsed.summary.overlap_rows, 0);
    assert_eq!(parsed.summary.prelude_bytes, 0);
}

#[test]
fn a_true_prefix_with_more_rows_than_reads_stays_a_prelude() {
    let spec = after_prefix(WRAP, &["one", "two", "three"]);
    let parsed = parse_with_reads(&spec, 2);
    assert_eq!(parsed.summary.wrapped_rows, 0);
    assert_eq!(parsed.summary.prelude_bytes, WRAP);
    assert_eq!(offsets(&parsed), [WRAP, WRAP + 100, WRAP + 200]);
}

#[test]
fn many_records_at_one_offset_after_the_limit_keep_the_overlap() {
    // The reach of a hostile archive after the reads: one record for each
    // window has no overlap. All the others stay at the given offset, and
    // the overlap check sees them.
    let mut rows = vec![Row::new("first", 100).sized(1 << 10)];
    rows.extend((0..20).map(|index| {
        let mut row = Row::new(&format!("alias-{index}"), 100).sized(1 << 24);
        row.header = false;
        row
    }));
    let spec = Archive {
        rows,
        directory: 4 * WRAP + 100_000,
        ..Archive::default()
    };
    let parsed = parse_with_reads(&spec, 2);
    assert_eq!(parsed.rows.len(), 21);
    // `first` and one alias for each of the windows 1, 2 and 3 moved.
    assert_eq!(parsed.summary.wrapped_rows, 4);
    // The rest are at the given offset, so they all overlap.
    assert_eq!(parsed.summary.overlap_rows, 17);
}

#[test]
fn the_default_limit_is_4096_reads() {
    // Many windows and no headers: each row can read each window.
    let rows: Vec<Row> = (0..20_000)
        .map(|index| Row::new(&format!("row-{index}"), 100 * index).no_header())
        .collect();
    let spec = Archive {
        rows,
        directory: 256 * WRAP + 3_000_000,
        ..Archive::default()
    };
    let size = spec.build().len();
    let (probes, reads) = counted(spec.build());
    let mut ingest = Ingest::open(counted(spec.build()).0, size).unwrap();
    ingest.set_probes(probes);
    assert_eq!(ingest.parse(u32::MAX), 20_000);
    assert_eq!(reads.get(), 4_096);
}

#[test]
fn after_the_limit_a_hostile_row_moves_and_the_other_stays_at_its_offset() {
    // `a.txt` follows the rows before it to a low place with no read, so it
    // has the mark, and the read worker refuses it. Thus only `b.txt` reads,
    // at its listed place, and the two do not read the same bytes.
    let spec = after_the_limit(2_048);
    let parsed = parse(spec.build());
    assert_eq!(parsed.rows.len(), 2_050);
    assert_eq!(parsed.summary.wrapped_rows, 2_049);
    let a = &parsed.rows[2_048];
    assert!(a.wrapped);
    assert_eq!(a.offset, 100_000);
    let b = &parsed.rows[2_049];
    assert!(!b.wrapped);
    assert_eq!(b.offset, spec.rows[2_049].place);
    // The 2,048 empty rows before them moved to one low header, so they overlap.
    // `a.txt` and `b.txt` have no overlap in the checks: they are at their own
    // places.
    assert_eq!(parsed.summary.overlap_rows, 2_048);
    assert!(!a.overlap);
    assert!(!b.overlap);
}

#[test]
fn rows_at_their_listed_places_keep_the_overlap_with_no_rows_before_them() {
    // The control of the attack: no row uses the reads, so both rows have a
    // header of their name at the given offset.
    let parsed = parse(after_the_limit(0).build());
    assert_eq!(parsed.summary.wrapped_rows, 0);
    assert_eq!(parsed.summary.overlap_rows, 2);
}

#[test]
fn the_zip64_marker_with_a_low_value_or_no_field_has_one_answer() {
    // The parse gives the only answer: the row moves
    // to the header of its name, gets the mark, and the read worker refuses
    // it by the mark.
    let mut extra = Vec::new();
    extra.extend_from_slice(&1u16.to_le_bytes());
    extra.extend_from_slice(&8u16.to_le_bytes());
    extra.extend_from_slice(&1000u64.to_le_bytes());
    let mut low_value = Row::new("low-value", 1000).sized(16);
    low_value.offset_field = Some(u32::MAX);
    low_value.extra = extra;
    let spec = Archive {
        rows: vec![low_value, Row::new("last", 5 * GIB).body(b"x")],
        directory: 5 * GIB + 100,
        ..Archive::default()
    };
    let parsed = parse(spec.build());
    assert_eq!(wrapped(&parsed), ["low-value"]);
    assert_eq!(offsets(&parsed), [1000, 5 * GIB]);

    // No Zip64 field: the marker counts as the low 32 bits.
    let mut no_field = Row::new("no-field", WRAP - 1).sized(16);
    no_field.offset_field = Some(u32::MAX);
    let spec = Archive {
        rows: vec![no_field, Row::new("last", 5 * GIB).body(b"x")],
        directory: 5 * GIB + 100,
        ..Archive::default()
    };
    let parsed = parse(spec.build());
    assert_eq!(wrapped(&parsed), ["no-field"]);
    assert_eq!(offsets(&parsed), [WRAP - 1, 5 * GIB]);
}

#[test]
fn rows_in_two_windows_with_real_headers_do_not_overlap() {
    // The reach of a hostile archive: `low` and `high` have one offset field
    // and two real headers. Only `high` can be read here. The parse gives the two
    // rows two places, so they have no overlap, at most one time for each 4 GiB of
    // the file. A third row at that place keeps the overlap.
    let spec = Archive {
        rows: vec![
            Row::new("low", 100).sized(1 << 20),
            Row::new("high", WRAP + 100).sized(1 << 20),
        ],
        directory: WRAP + (1 << 21),
        ..Archive::default()
    };
    let parsed = parse(spec.build());
    assert_eq!(wrapped(&parsed), ["low"]);
    assert_eq!(parsed.summary.overlap_rows, 0);

    let mut spec = spec.clone();
    spec.rows.push(Row::new("third", WRAP + 100).sized(1 << 20));
    let parsed = parse(spec.build());
    assert_eq!(wrapped(&parsed), ["low"]);
    assert_eq!(parsed.summary.overlap_rows, 2);
}

// Reads --------------------------------------------------------------------

/// The reads of a listing with rawzip alone.
fn rawzip_reads(bytes: SparseBytes) -> u64 {
    let size = bytes.len();
    let (reader, reads) = counted(bytes);
    let mut buffer = vec![0u8; 256 * 1024];
    let archive = rawzip::ZipLocator::new()
        .locate_in_reader(reader, &mut buffer, size)
        .map_err(|(_, err)| err)
        .unwrap();
    let mut records = vec![0u8; 256 * 1024];
    let mut entries = archive.entries(&mut records);
    while entries.next_entry().unwrap().is_some() {}
    reads.get()
}

/// The reads of a listing with the helper of the open sites.
fn helper_reads(bytes: SparseBytes) -> u64 {
    let size = bytes.len();
    let (reader, reads) = counted(bytes);
    let archive = zipscope_layout::end::open_end(reader, size)
        .unwrap()
        .archive;
    let mut records = vec![0u8; 256 * 1024];
    let mut entries = archive.entries(&mut records);
    while entries.next_entry().unwrap().is_some() {}
    reads.get()
}

fn ingest_reads(bytes: SparseBytes) -> u64 {
    let size = bytes.len();
    let (reader, reads) = counted(bytes);
    let mut ingest = Ingest::open(reader, size).unwrap();
    ingest.parse(u32::MAX);
    assert_eq!(*ingest.status(), Status::Complete);
    reads.get()
}

#[test]
fn a_directory_in_the_first_4_gib_costs_no_more_reads_than_rawzip() {
    let spec = after_prefix(3 * GIB, &["one", "two", "three"]);
    assert!(ingest_reads(spec.build()) <= rawzip_reads(spec.build()));
    let spec = after_prefix(0, &["one", "two", "three"]);
    assert!(ingest_reads(spec.build()) <= rawzip_reads(spec.build()));
}

#[test]
fn a_directory_past_4_gib_costs_one_read_more() {
    let spec = after_prefix(WRAP + 100, &["one", "two", "three"]);
    assert_eq!(ingest_reads(spec.build()), helper_reads(spec.build()) + 1);
    assert!(ingest_reads(spec.build()) <= rawzip_reads(spec.build()) + 1);
    assert_eq!(
        ingest_reads(zip64_sparse().unwrap()),
        helper_reads(zip64_sparse().unwrap()) + 1
    );
    assert!(ingest_reads(zip64_sparse().unwrap()) <= rawzip_reads(zip64_sparse().unwrap()) + 1);
}

#[test]
fn the_probes_read_the_local_headers_and_the_reader_of_the_archive_does_not() {
    // A true prefix: one read for each row. The shape: `a` reads its given
    // offset and its place, `b` has a given offset past the central directory
    // and reads only its place, and `c` reads its given offset.
    for (spec, expected) in [
        (after_prefix(WRAP, &["one", "two", "three"]), 3),
        (three_rows(), 4),
    ] {
        let bytes = spec.build();
        let size = bytes.len();
        let (reader, main) = counted(bytes);
        let (probes, probe_reads) = counted(spec.build());
        let mut ingest = Ingest::open(reader, size).unwrap();
        ingest.set_probes(probes);
        ingest.parse(u32::MAX);
        assert_eq!(probe_reads.get(), expected);
        assert_eq!(main.get(), helper_reads(spec.build()) + 1);
    }
}
