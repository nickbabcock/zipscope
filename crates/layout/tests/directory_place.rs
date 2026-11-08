//! Two facts about the place of a central directory: a declared offset after the
//! directory, and an end record before the chosen record that no row covers. These
//! tests look at the health vector and count reads. They use no clock.

#![expect(
    clippy::cast_precision_loss,
    reason = "The places in these files are small."
)]

use std::cell::Cell;
use std::rc::Rc;

use rawzip::ReaderAt;
use zipscope_core::contract::health;
use zipscope_core::ingest::{Ingest, Status};
use zipscope_layout::end::MAX_OPEN_READS;
use zipscope_testkit::end_shapes::{Body, Want, body_with, end_record, locator, shapes, two_rows};

const DECLARED: usize = health::END_DECLARED_DIRECTORY;
const FOUND: usize = health::END_FOUND_DIRECTORY;
const EARLIER: usize = health::END_EARLIER_RECORDS;
const EARLIER_RECORD: usize = health::END_EARLIER_RECORD;
const EARLIER_DIRECTORY: usize = health::END_EARLIER_DIRECTORY;

/// A reader that counts its reads.
#[derive(Debug, Clone)]
struct Counted {
    bytes: Rc<Vec<u8>>,
    reads: Rc<Cell<u64>>,
}

impl ReaderAt for Counted {
    fn read_at(&self, buf: &mut [u8], offset: u64) -> std::io::Result<usize> {
        self.reads.set(self.reads.get() + 1);
        self.bytes.as_slice().read_at(buf, offset)
    }
}

/// Parses the file. Returns the health vector and the rows.
fn parsed(bytes: &[u8]) -> (Vec<f64>, usize, Status) {
    let mut ingest = Ingest::open(bytes.to_vec(), bytes.len() as u64).unwrap();
    ingest.parse(u32::MAX);
    ingest.finish_checks();
    let rows = ingest.store().rows();
    (
        ingest.health_vector().to_vec(),
        rows,
        ingest.status().clone(),
    )
}

/// Parses the file with a counted reader. Returns the health vector, the reads
/// of the open, and all reads.
fn counted(bytes: &[u8]) -> (Vec<f64>, u64, u64) {
    let reader = Counted {
        bytes: Rc::new(bytes.to_vec()),
        reads: Rc::new(Cell::new(0)),
    };
    let reads = Rc::clone(&reader.reads);
    let mut ingest = Ingest::open(reader, bytes.len() as u64).unwrap();
    let opened = reads.get();
    ingest.parse(u32::MAX);
    assert_eq!(ingest.status(), &Status::Complete);
    (ingest.health_vector().to_vec(), opened, reads.get())
}

fn u32_of(value: usize) -> u32 {
    u32::try_from(value).unwrap()
}

/// `body` with an end record that declares the directory at `declared`.
fn declaring(body: &Body, declared: u32) -> Vec<u8> {
    let mut out = body.bytes.clone();
    out.extend_from_slice(&end_record(body.count, body.directory_size, declared, 0));
    out
}

/// An archive with these rows after `bytes`. Each row is (name, offset, compressed
/// size, length of extra field), and no local header is made for it.
fn rows_after(bytes: &[u8], rows: &[(&str, u64, u32, u16)]) -> Vec<u8> {
    let mut out = bytes.to_vec();
    let place = out.len();
    for (name, offset, compressed, extra) in rows {
        out.extend_from_slice(b"PK\x01\x02\x14\0\x14\0\0\0\0\0\0\0\0\0\0\0\0\0");
        out.extend_from_slice(&compressed.to_le_bytes());
        out.extend_from_slice(&compressed.to_le_bytes());
        out.extend_from_slice(&u16::try_from(name.len()).unwrap().to_le_bytes());
        out.extend_from_slice(&extra.to_le_bytes());
        out.extend_from_slice(&[0; 10]);
        out.extend_from_slice(&u32::try_from(*offset).unwrap().to_le_bytes());
        out.extend_from_slice(name.as_bytes());
        // An unknown extra field: its id and length, and then its data.
        if *extra > 0 {
            out.extend_from_slice(&0x7777_u16.to_le_bytes());
            out.extend_from_slice(&(extra - 4).to_le_bytes());
            out.extend_from_slice(&vec![0; usize::from(*extra) - 4]);
        }
    }
    let size = u32_of(out.len() - place);
    let count = u16::try_from(rows.len()).unwrap();
    out.extend_from_slice(&end_record(count, size, u32_of(place), 0));
    out
}

/// A true archive with its end record. Returns the file and the place of the
/// record.
fn true_archive() -> (Vec<u8>, u64) {
    let body = two_rows();
    let place = body.eocd();
    (body.end(b"", 0), place)
}

#[test]
fn a_declared_offset_one_byte_after_the_directory_gives_both_values() {
    let body = two_rows();
    let (fields, rows, status) = parsed(&declaring(&body, body.declared + 1));
    assert_eq!(status, Status::Complete);
    assert_eq!(rows, 2);
    assert_eq!(fields[DECLARED], f64::from(body.declared + 1));
    assert_eq!(fields[FOUND], f64::from(body.declared));
}

#[test]
fn a_declared_offset_at_the_directory_is_no_finding() {
    let body = two_rows();
    let (fields, rows, _) = parsed(&declaring(&body, body.declared));
    assert_eq!(rows, 2);
    assert_eq!(fields[DECLARED], 0.0);
    assert_eq!(fields[FOUND], 0.0);
}

#[test]
fn a_declared_offset_before_the_directory_stays_a_prefix() {
    let body = body_with(b"stub", &[("a.txt", b"data a")], b"");
    let (fields, _, _) = parsed(&body.end(b"", 0));
    assert_eq!(fields[health::PRELUDE_BYTES], 4.0);
    assert_eq!(fields[DECLARED], 0.0);
    // One byte before the true place, with no prefix.
    let plain = two_rows();
    let (fields, _, _) = parsed(&declaring(&plain, plain.declared - 1));
    assert_eq!(fields[health::PRELUDE_BYTES], 1.0);
    assert_eq!(fields[DECLARED], 0.0);
}

#[test]
fn a_declared_offset_at_the_record_counts() {
    let body = two_rows();
    let at_record = u32::try_from(body.eocd()).unwrap();
    let (fields, _, _) = parsed(&declaring(&body, at_record));
    assert_eq!(fields[DECLARED], f64::from(at_record));
}

/// A sample archive: the offset points into a row comment, and the two
/// stored entries have one CRC-32.
#[test]
fn the_sample_with_a_declared_offset_in_a_row_comment_gets_the_finding() {
    let first = body_with(b"", &[("real.txt", b"data029685")], b"");
    let local = usize::try_from(first.directory).unwrap();
    let mut bytes = first.bytes[..local].to_vec();
    bytes.extend_from_slice(&first.bytes[..local]);
    let comment = vec![b'c'; local + 60];
    let row = body_with(b"", &[("real.txt", b"data029685")], &comment);
    let directory = bytes.len();
    bytes.extend_from_slice(row.directory_bytes());
    let declared = u32_of(directory + local);
    bytes.extend_from_slice(&end_record(1, row.directory_size, declared, 0));
    let (fields, rows, _) = parsed(&bytes);
    assert_eq!(rows, 1);
    assert_eq!(fields[DECLARED], f64::from(declared));
    assert_eq!(fields[FOUND], directory as f64);
    assert_eq!(fields[health::END_OTHERS], 0.0);
    assert_eq!(fields[health::END_SECOND_DIRECTORY], 0.0);
}

/// A true Zip64 archive with `count` entries, up to its end record. Returns the
/// file and its directory.
fn zip64_file() -> (Vec<u8>, u64) {
    let body = two_rows();
    let mut file = body.bytes.clone();
    let record = file.len() as u64;
    file.extend_from_slice(b"PK\x06\x06");
    file.extend_from_slice(&44_u64.to_le_bytes());
    file.extend_from_slice(&[45, 0, 45, 0]);
    file.extend_from_slice(&[0; 8]);
    file.extend_from_slice(&2_u64.to_le_bytes());
    file.extend_from_slice(&2_u64.to_le_bytes());
    file.extend_from_slice(&u64::from(body.directory_size).to_le_bytes());
    file.extend_from_slice(&body.directory.to_le_bytes());
    file.extend_from_slice(&locator(record));
    file.extend_from_slice(&end_record(u16::MAX, u32::MAX, u32::MAX, 0));
    (file, body.directory)
}

#[test]
fn the_zip64_marker_and_a_part_of_a_spanned_archive_get_no_finding() {
    // The marker 0xffffffff in the offset field is larger than each place here.
    let (bytes, _) = zip64_file();
    let (fields, rows, _) = parsed(&bytes);
    assert_eq!(rows, 2);
    assert_eq!(fields[DECLARED], 0.0);
    let body = two_rows();
    // A disk field that is not 0: the offset is a place in another part.
    let mut bytes = declaring(&body, body.declared + 50);
    let end = bytes.len() - 22;
    bytes[end + 4] = 2;
    let (fields, _, _) = parsed(&bytes);
    assert_eq!(fields[DECLARED], 0.0);
    bytes[end + 4] = 0;
    bytes[end + 6] = 2;
    let (fields, _, _) = parsed(&bytes);
    assert_eq!(fields[DECLARED], 0.0);
}

#[test]
fn a_second_directory_at_the_declared_offset_is_one_finding() {
    // A signature in the last bytes of a row comment: the place holds no whole
    // record, so the open takes the directory by its size.
    let body = body_with(b"", &[("a.txt", b"data a")], b"PK\x01\x02");
    let declared = u32::try_from(body.eocd() - 4).unwrap();
    let (fields, rows, _) = parsed(&declaring(&body, declared));
    assert_eq!(rows, 1);
    assert_eq!(fields[health::END_SECOND_DIRECTORY], 1.0);
    assert_eq!(fields[DECLARED], 0.0);
    assert_eq!(fields[EARLIER], 0.0);
}

#[test]
fn a_fake_archive_after_an_archive_gets_the_places_of_the_true_record() {
    let (bytes, record) = true_archive();
    let fake = body_with(b"", &[("fake.txt", b"fake")], b"");
    let mut file = bytes.clone();
    file.extend_from_slice(&fake.end(b"", 0));
    let (fields, rows, status) = parsed(&file);
    assert_eq!(status, Status::Complete);
    assert_eq!(rows, 1);
    assert_eq!(fields[EARLIER], 1.0);
    assert_eq!(fields[EARLIER_RECORD], record as f64);
    assert_eq!(fields[EARLIER_DIRECTORY], two_rows().directory as f64);
    assert_eq!(fields[health::END_OTHERS], 0.0);
}

#[test]
fn an_update_after_the_old_directory_gets_the_places_of_the_old_record() {
    let (mut file, record) = true_archive();
    let directory = two_rows().directory;
    let new = file.len() as u64;
    file.extend_from_slice(b"PK\x03\x04");
    file.extend_from_slice(&[0; 26]);
    let file = rows_after(
        &file,
        &[
            ("a.txt", 0, 6, 0),
            ("b.txt", 41, 6, 0),
            ("new.txt", new, 0, 0),
        ],
    );
    let (fields, rows, _) = parsed(&file);
    assert_eq!(rows, 3);
    assert_eq!(fields[EARLIER], 1.0);
    assert_eq!(fields[EARLIER_RECORD], record as f64);
    assert_eq!(fields[EARLIER_DIRECTORY], directory as f64);
    assert_eq!(fields[health::OVERLAP_ROWS], 0.0);
}

#[test]
fn a_stored_zip_gets_no_finding_and_no_read() {
    let inner = two_rows().end(b"", 0);
    // The name is longer than the end record, so the end record of the inner
    // archive starts after the 30 bytes and the compressed size.
    let long = "lib/a-long-name-of-a-nested-archive-1.2.3.jar";
    for name in ["a.zip", long] {
        let file = body_with(b"", &[(name, &inner)], b"").end(b"", 0);
        let (fields, opened, all) = counted(&file);
        assert_eq!(fields[EARLIER], 0.0, "{name}");
        assert_eq!(fields[health::END_UNCHECKED], 0.0, "{name}");
        assert_eq!((opened, all), (1, 2), "{name}");
    }
    // It is not the last entry.
    let file = body_with(b"", &[("a.zip", &inner), ("z.txt", b"z")], b"").end(b"", 0);
    let (fields, _, _) = parsed(&file);
    assert_eq!(fields[EARLIER], 0.0);
}

/// The last record of a true archive, at `record`, with a row before it.
fn with_row(bytes: &[u8], row: (&str, u64, u32, u16)) -> f64 {
    parsed(&rows_after(bytes, &[row])).0[EARLIER]
}

#[test]
fn a_row_covers_a_record_from_its_start_to_the_end_of_its_range() {
    let (bytes, record) = true_archive();
    let record32 = u32::try_from(record).unwrap();
    // The range is 30 bytes, 5 of the name, and the compressed size.
    let reach = |offset: u64| record32 - u32::try_from(offset).unwrap() - 35;
    // The range ends after the first byte of the record, and at that byte.
    assert_eq!(with_row(&bytes, ("a.zip", 0, reach(0) + 1, 0)), 0.0);
    assert_eq!(with_row(&bytes, ("a.zip", 0, reach(0), 0)), 1.0);
    // The row starts at the record, and one byte after it.
    assert_eq!(with_row(&bytes, ("a.zip", record, 0, 0)), 0.0);
    assert_eq!(with_row(&bytes, ("a.zip", record + 1, 0, 0)), 1.0);
    // The extra field of the record counts too.
    assert_eq!(with_row(&bytes, ("a.zip", 0, reach(0) - 8, 9)), 0.0);
    assert_eq!(with_row(&bytes, ("a.zip", 0, reach(0) - 8, 8)), 1.0);
    // A range that saturates.
    assert_eq!(with_row(&bytes, ("a.zip", 0, u32::MAX - 1, 0)), 0.0);
}

#[test]
fn a_row_that_covers_only_the_directory_does_not_cover_the_record() {
    let (bytes, _) = true_archive();
    let directory = two_rows().directory;
    let row = ("a.zip", directory, 0, 0);
    let (fields, _, _) = parsed(&rows_after(&bytes, &[row]));
    assert_eq!(fields[EARLIER], 1.0);
    assert_eq!(fields[EARLIER_DIRECTORY], directory as f64);
}

#[test]
fn a_parse_that_fails_says_nothing_of_the_rows() {
    let (bytes, _) = true_archive();
    let mut file = rows_after(&bytes, &[("a.zip", 0, 0, 0), ("b.zip", 0, 0, 0)]);
    // A false signature on the second record.
    let second = file.len() - 22 - (46 + 5);
    file[second] = b'X';
    let (fields, rows, status) = parsed(&file);
    assert!(matches!(status, Status::Failed(_)), "{status:?}");
    assert_eq!(rows, 1);
    assert_eq!(fields[EARLIER], 0.0);
    assert_eq!(fields[health::END_UNCHECKED], 0.0);
}

#[test]
fn a_record_with_no_directory_is_no_finding() {
    // An empty archive, and a record whose places hold no directory.
    let mut file = end_record(0, 0, 0, 0);
    file.extend_from_slice(&two_rows().end(b"", 0));
    assert_eq!(parsed(&file).0[EARLIER], 0.0);
    let mut file = vec![0; 100];
    file.extend_from_slice(&end_record(1, 46, 3, 0));
    let rest = body_with(b"", &[("a.txt", b"data a")], b"");
    file.extend_from_slice(&rest.bytes);
    file.extend_from_slice(&end_record(1, rest.directory_size, rest.declared, 0));
    let (fields, rows, _) = parsed(&file);
    assert_eq!(rows, 1);
    assert_eq!(fields[EARLIER], 0.0);
}

#[test]
fn a_record_in_a_part_of_a_spanned_archive_is_no_finding() {
    let (bytes, _) = true_archive();
    let mut file = rows_after(&bytes, &[("a.zip", 200, 0, 0)]);
    let end = file.len() - 22;
    file[end + 4] = 1;
    assert_eq!(parsed(&file).0[EARLIER], 0.0);
}

#[test]
fn a_zip64_record_gives_the_place_of_the_earlier_directory() {
    let (file, directory) = zip64_file();
    let end = file.len() as u64 - 22;
    let new = file.len() as u64;
    let file = rows_after(&file, &[("fake.txt", new, 0, 0)]);
    let (fields, _, _) = parsed(&file);
    assert_eq!(fields[EARLIER], 1.0);
    assert_eq!(fields[EARLIER_RECORD], end as f64);
    assert_eq!(fields[EARLIER_DIRECTORY], directory as f64);
}

/// Each record of `count` archives. Returns the file and the place of the last
/// record.
fn chain(count: usize) -> (Vec<u8>, u64) {
    let body = body_with(b"", &[("a.txt", b"data a")], b"");
    let mut file = Vec::new();
    let mut last = 0;
    for _ in 0..count {
        let directory = file.len() + usize::try_from(body.directory).unwrap();
        file.extend_from_slice(&body.bytes);
        last = file.len() as u64;
        file.extend_from_slice(&end_record(1, body.directory_size, u32_of(directory), 0));
    }
    (file, last)
}

#[test]
fn the_open_keeps_the_nearest_records_and_gives_the_nearest_place() {
    for (records, want) in [(1, 1.0), (16, 16.0), (17, 16.0)] {
        let (file, last) = chain(records);
        let new = file.len() as u64;
        let file = rows_after(&file, &[("fake.txt", new, 0, 0)]);
        let (fields, _, _) = parsed(&file);
        assert_eq!(fields[EARLIER], want, "{records}");
        assert_eq!(fields[EARLIER_RECORD], last as f64, "{records}");
    }
}

#[test]
fn a_record_past_the_kept_bytes_is_out_of_reach() {
    let (bytes, _) = true_archive();
    for (padding, want) in [(65_000, 1.0), (66_000, 0.0)] {
        let mut file = bytes.clone();
        file.extend_from_slice(&vec![0; padding]);
        let new = file.len() as u64;
        let file = rows_after(&file, &[("fake.txt", new, 0, 0)]);
        assert_eq!(parsed(&file).0[EARLIER], want, "{padding}");
    }
}

#[test]
fn a_directory_outside_the_kept_bytes_costs_one_read_at_the_open() {
    // A directory of about 90 KB, so its start is not in the first read.
    let names: Vec<String> = (0..2000)
        .map(|at| format!("folder/name-{at:05}.txt"))
        .collect();
    let entries: Vec<(&str, &[u8])> = names.iter().map(|name| (name.as_str(), &b""[..])).collect();
    let body = body_with(b"", &entries, b"");
    let plain = body.end(b"", 0);
    let (fields, _, _) = counted(&plain);
    assert_eq!(fields[EARLIER], 0.0);

    let new = plain.len() as u64;
    let file = rows_after(&plain, &[("fake.txt", new, 0, 0)]);
    let (fields, opened, all) = counted(&file);
    assert_eq!(fields[EARLIER], 1.0);
    assert_eq!(fields[EARLIER_DIRECTORY], body.directory as f64);
    assert_eq!(
        opened, 2,
        "the first read and the head of the old directory"
    );
    assert_eq!(all, 3, "and the directory");

    // A row that covers the record: the open makes the same read.
    let row = ("a.zip", 0, u32::try_from(new).unwrap(), 0);
    let file = rows_after(&plain, &[row]);
    let (fields, opened, all) = counted(&file);
    assert_eq!(fields[EARLIER], 0.0);
    assert_eq!((opened, all), (2, 3));
}

#[test]
fn a_hostile_tail_of_earlier_records_stays_in_the_limit_with_no_finding() {
    // Each record is behind locator bytes, and each place is far away: a Zip64
    // place, the size before the record, and the declared offset. Thus each record
    // takes 3 reads, and the budget ends before the last record. The contract
    // states that this file has no finding of these records.
    let mut file = vec![0; 8 << 20];
    for at in 0..16_u64 {
        let far = at * (1 << 16);
        file.extend_from_slice(&locator(far));
        let place = u32::try_from(far + (1 << 15)).unwrap();
        let size = u32::try_from((1 << 21) + at).unwrap();
        file.extend_from_slice(&end_record(1, size, place, 0));
    }
    let new = file.len() as u64;
    let file = rows_after(&file, &[("fake.txt", new, 0, 0)]);
    let (fields, opened, _) = counted(&file);
    assert_eq!(
        opened, 46,
        "the first read and the budget that the trial left"
    );
    assert!(opened <= MAX_OPEN_READS);
    assert_eq!(fields[EARLIER], 0.0);
    assert_eq!(fields[health::END_UNCHECKED], 0.0);
}

#[test]
fn a_record_with_a_directory_and_a_declared_offset_past_it_gets_the_finding() {
    let body = two_rows();
    let record = body.eocd();
    let mut file = body.bytes.clone();
    file.extend_from_slice(&end_record(
        body.count,
        body.directory_size,
        u32::try_from(record + 1).unwrap(),
        0,
    ));
    let new = file.len() as u64;
    let file = rows_after(&file, &[("fake.txt", new, 0, 0)]);
    let (fields, _, _) = parsed(&file);
    assert_eq!(fields[EARLIER], 1.0);
    assert_eq!(fields[EARLIER_RECORD], record as f64);
    assert_eq!(fields[EARLIER_DIRECTORY], body.directory as f64);
}

#[test]
fn false_records_do_not_use_the_places_of_the_list() {
    // 17 records whose places the bytes show as false, near the chosen record.
    let (mut file, record) = true_archive();
    for _ in 0..17 {
        file.extend_from_slice(&end_record(1, 46, u32::MAX - 5, 0));
    }
    let new = file.len() as u64;
    let file = rows_after(&file, &[("fake.txt", new, 0, 0)]);
    let (fields, _, _) = parsed(&file);
    assert_eq!(fields[EARLIER], 1.0);
    assert_eq!(fields[EARLIER_RECORD], record as f64);
}

#[test]
fn the_records_of_the_walk_shapes_have_these_findings() {
    for shape in shapes() {
        if matches!(shape.want, Want::Fails(_)) {
            continue;
        }
        let (fields, _, _) = parsed(&shape.bytes);
        let name = shape.name;
        let (declared, earlier) = match name {
            "directory-at-zero" => (5.0, 0.0),
            "offset-at-record" => (184.0, 0.0),
            "fake-after-comment" | "fake-appended" => (0.0, 1.0),
            _ => (0.0, 0.0),
        };
        assert_eq!(fields[DECLARED], declared, "{name}");
        assert_eq!(fields[EARLIER], earlier, "{name}");
    }
}
