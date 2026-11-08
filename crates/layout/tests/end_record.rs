//! The walk to the end record, with the shapes of `end_shapes`. These tests
//! count reads. They use no clock.

use std::cell::Cell;
use std::rc::Rc;

use rawzip::{ReaderAt, ZipLocator};
use zipscope_core::contract::health;
use zipscope_core::ingest::{Ingest, Status};
use zipscope_layout::end::{
    EndNotes, FIRST_READ_BYTES, MAX_OPEN_BYTES, MAX_OPEN_READS, MAX_TRIALS, NO_RECORD_TEXT,
    SEARCH_BYTES, TOO_MANY_TEXT, open_end,
};
use zipscope_testkit::end_shapes::{
    END_BYTES, END_SIGNATURE, NO_RECORD, Want, body_with, costly_decoy, costly_tail, end_record,
    locator, shapes, two_rows, worst_tail,
};

/// A reader that counts its reads and their bytes.
#[derive(Debug, Clone)]
struct Counted {
    bytes: Rc<Vec<u8>>,
    reads: Rc<Cell<u64>>,
    read_bytes: Rc<Cell<u64>>,
}

impl Counted {
    fn new(bytes: &[u8]) -> Self {
        Counted {
            bytes: Rc::new(bytes.to_vec()),
            reads: Rc::new(Cell::new(0)),
            read_bytes: Rc::new(Cell::new(0)),
        }
    }

    fn size(&self) -> u64 {
        self.bytes.len() as u64
    }

    fn take(&self) -> (u64, u64) {
        (self.reads.replace(0), self.read_bytes.replace(0))
    }
}

impl ReaderAt for Counted {
    fn read_at(&self, buf: &mut [u8], offset: u64) -> std::io::Result<usize> {
        self.reads.set(self.reads.get() + 1);
        let count = self.bytes.as_slice().read_at(buf, offset)?;
        self.read_bytes.set(self.read_bytes.get() + count as u64);
        Ok(count)
    }
}

/// The end record that rawzip alone chooses, and its reads.
fn rawzip_alone(bytes: &[u8]) -> Option<(u64, u64, u64, u64, u64)> {
    let reader = Counted::new(bytes);
    let size = reader.size();
    let mut buffer = vec![0u8; 256 * 1024];
    let archive = ZipLocator::new()
        .locate_in_reader(reader.clone(), &mut buffer, size)
        .ok()?;
    let reads = reader.take().0;
    Some((
        archive.eocd_offset(),
        archive.directory_offset(),
        archive.entries_hint(),
        archive.end_offset(),
        reads,
    ))
}

fn notes_of(bytes: &[u8]) -> EndNotes {
    open_end(bytes.to_vec(), bytes.len() as u64).unwrap().notes
}

/// Parses the file in the core, and checks the listing and the health vector.
fn check_listing(name: &str, bytes: &[u8], want: &Want) {
    let opened = Ingest::open(bytes.to_vec(), bytes.len() as u64);
    match want {
        Want::Fails(text) => {
            assert_eq!(opened.err().unwrap().to_string(), *text, "{name}");
        }
        Want::Opens {
            rows,
            parse_error,
            skipped,
            others,
            cut,
            second,
            ..
        } => {
            let mut ingest = opened.unwrap_or_else(|err| panic!("{name}: {err}"));
            ingest.parse(u32::MAX);
            ingest.finish_checks();
            let store = ingest.store();
            let names: Vec<_> = (0..store.rows())
                .map(|row| String::from_utf8(store.name(row).to_vec()).unwrap())
                .collect();
            assert_eq!(names, *rows, "{name}");
            let failed = matches!(ingest.status(), Status::Failed(_));
            assert_eq!(failed, *parse_error, "{name}: {:?}", ingest.status());
            let vector = ingest.health_vector();
            assert_eq!(vector[health::END_SKIPPED], f64::from(*skipped), "{name}");
            assert_eq!(vector[health::END_OTHERS], f64::from(*others), "{name}");
            assert_eq!(vector[health::END_UNCHECKED], 0.0, "{name}");
            assert_eq!(
                vector[health::END_SECOND_DIRECTORY],
                f64::from(u8::from(*second)),
                "{name}"
            );
            let (declared, present) = cut.unwrap_or((0, 0));
            assert_eq!(
                vector[health::COMMENT_DECLARED],
                f64::from(declared),
                "{name}"
            );
            assert_eq!(
                vector[health::COMMENT_PRESENT],
                f64::from(present),
                "{name}"
            );
        }
    }
}

#[test]
fn each_shape_gets_its_record_and_its_notes() {
    for shape in shapes() {
        check_listing(shape.name, &shape.bytes, &shape.want);
        let opened = open_end(shape.bytes.clone(), shape.bytes.len() as u64);
        match &shape.want {
            Want::Fails(text) => {
                assert_eq!(opened.unwrap_err().to_string(), *text, "{}", shape.name);
            }
            Want::Opens {
                eocd, directory, ..
            } => {
                let opened = opened.unwrap_or_else(|err| panic!("{}: {err}", shape.name));
                assert_eq!(opened.archive.eocd_offset(), *eocd, "{}", shape.name);
                assert_eq!(
                    opened.archive.directory_offset(),
                    *directory,
                    "{}",
                    shape.name
                );
            }
        }
    }
    assert_eq!(NO_RECORD, NO_RECORD_TEXT);
}

/// Each file whose comment is empty, with a false record in its comment. Each
/// sound record must stay the choice. Without it, the walk opens the nearest
/// record that fits, so this test tells a sound record from a false one.
#[test]
fn a_false_record_in_a_comment_does_not_change_the_choice() {
    let mut tested = 0;
    for shape in shapes() {
        let Want::Opens {
            eocd,
            directory,
            parse_error,
            skipped,
            others,
            cut: None,
            ..
        } = shape.want
        else {
            continue;
        };
        // A file that lost its records can fail for its own reasons. A jar has
        // a last record that is weak, and it stays the choice.
        if parse_error || eocd + END_BYTES != shape.bytes.len() as u64 {
            continue;
        }
        let at = usize::try_from(eocd).unwrap();
        if shape.bytes[at + 20..at + 22] != [0, 0] {
            continue;
        }
        let mut bytes = shape.bytes.clone();
        bytes[at + 20] = 22;
        bytes.extend_from_slice(&end_record(0, 0, 0, 0));
        let opened = open_end(bytes.clone(), bytes.len() as u64)
            .unwrap_or_else(|err| panic!("{}: {err}", shape.name));
        assert_eq!(opened.archive.eocd_offset(), eocd, "{}", shape.name);
        assert_eq!(
            opened.archive.directory_offset(),
            directory,
            "{}",
            shape.name
        );
        // A file with a directory at offset 0 gives the false record a directory
        // at its declared offset. It then counts as another record.
        assert_eq!(
            opened.notes.skipped + opened.notes.other_records,
            skipped + others + 1,
            "{}",
            shape.name
        );
        tested += 1;
    }
    assert!(tested >= 20, "{tested}");
}

#[test]
fn a_copy_of_the_record_with_its_directory_far_away_has_no_other_directory() {
    // The copy has the directory of the chosen record, so it lists the same rows.
    // That directory is before the kept bytes, so it takes reads to see it.
    let body = large_body(b"");
    let copy = end_record(body.count, body.directory_size, body.declared, 0);
    let bytes = body.end(&copy, u16::try_from(copy.len()).unwrap());
    let opened = open_end(bytes.clone(), bytes.len() as u64).unwrap();
    assert_eq!(opened.archive.eocd_offset(), body.eocd());
    assert_eq!(opened.notes.skipped, 1);
    assert_eq!(opened.notes.other_records, 0);
}

#[test]
fn a_holder_with_a_false_size_has_no_other_directory() {
    // The first record holds the fake record in its comment. Its size is past
    // the start of the file, and its offset does not hold a directory.
    let body = large_body(b"");
    let fake = body_with(b"", &[("FAKE.txt", b"fake")], b"");
    let mut comment = fake.directory_bytes().to_vec();
    comment.extend_from_slice(&end_record(1, fake.directory_size, 0, 0));
    let mut bytes = body.bytes.clone();
    bytes.extend_from_slice(&end_record(
        1,
        u32::MAX - 5,
        100,
        u16::try_from(comment.len()).unwrap(),
    ));
    bytes.extend_from_slice(&comment);
    let notes = notes_of(&bytes);
    assert_eq!(notes.other_records, 0);
    assert_eq!(notes.unchecked, 0);
}

/// With no stray signature, the record is the record of rawzip alone, and the
/// open makes no read more.
fn check_as_rawzip_alone(name: &str, bytes: &[u8]) {
    let Some((eocd, directory, entries, end, alone)) = rawzip_alone(bytes) else {
        panic!("{name}: rawzip alone cannot open this file");
    };
    let reader = Counted::new(bytes);
    let opened = open_end(reader.clone(), reader.size()).unwrap();
    let reads = reader.take().0;
    assert_eq!(opened.archive.eocd_offset(), eocd, "{name}");
    assert_eq!(opened.archive.directory_offset(), directory, "{name}");
    assert_eq!(opened.archive.entries_hint(), entries, "{name}");
    assert_eq!(opened.archive.end_offset(), end, "{name}");
    assert_eq!(opened.notes, EndNotes::default(), "{name}");
    assert!(
        reads <= alone,
        "{name}: {reads} reads, rawzip alone {alone}"
    );
}

/// Many entries, so that the central directory starts before the first read.
fn large_body(prefix: &[u8]) -> zipscope_testkit::end_shapes::Body {
    let names: Vec<String> = (0..3000)
        .map(|at| format!("folder/name-{at:05}.txt"))
        .collect();
    let entries: Vec<(&str, &[u8])> = names
        .iter()
        .map(|name| (name.as_str(), &b"x"[..]))
        .collect();
    body_with(prefix, &entries, b"")
}

#[test]
fn a_valid_archive_gets_the_record_of_rawzip_with_no_extra_read() {
    let small = two_rows();
    let large = large_body(b"");
    for (name, body) in [("small", &small), ("large", &large)] {
        for length in [0_u16, 1, 979, 1002, 1003, 1024, 2000, 60_000, u16::MAX] {
            let comment = vec![b'c'; usize::from(length)];
            let bytes = body.end(&comment, length);
            check_as_rawzip_alone(&format!("{name} comment {length}"), &bytes);
        }
        let plain = body.end(b"", 0);
        for trailing in [
            1_usize,
            1000,
            1002,
            1003,
            2000,
            66_000,
            67_000,
            67_605,
            67_606,
            133_000,
            200_000,
            1_000_000,
            (1 << 20) - 23,
            (1 << 20) - 22,
        ] {
            let mut bytes = plain.clone();
            bytes.extend(std::iter::repeat_n(0_u8, trailing));
            check_as_rawzip_alone(&format!("{name} trailing {trailing}"), &bytes);
        }
    }
    let prefix = vec![b'p'; 300_000];
    let far = large_body(&prefix);
    check_as_rawzip_alone("a prefix before a large directory", &far.end(b"", 0));
    let near = body_with(&prefix, &[("a.txt", b"data")], b"");
    check_as_rawzip_alone("a prefix before a small directory", &near.end(b"", 0));
    for shape in shapes() {
        if matches!(
            shape.name,
            "plain" | "comment" | "trailing" | "prefix" | "zip64"
        ) || shape.name.starts_with("empty-zip")
            || shape.name.starts_with("false-locator")
        {
            if shape.name == "false-locator-prefix-stray" {
                continue;
            }
            check_as_rawzip_alone(shape.name, &shape.bytes);
        }
    }
}

#[test]
fn a_usual_archive_makes_the_reads_of_rawzip_alone() {
    // The first directory record is before the first read of the helper.
    let large = large_body(b"").end(b"", 0);
    assert!(large.len() as u64 > FIRST_READ_BYTES * 2);
    let reader = Counted::new(&large);
    open_end(reader.clone(), reader.size()).unwrap();
    assert_eq!(reader.take(), (2, FIRST_READ_BYTES + 46));
    assert_eq!(rawzip_alone(&large).unwrap().4, 2);
    // The first read holds a small archive, so the helper makes only that read.
    let small = two_rows().end(b"", 0);
    let reader = Counted::new(&small);
    open_end(reader.clone(), reader.size()).unwrap();
    assert_eq!(reader.take(), (1, small.len() as u64));
    assert_eq!(rawzip_alone(&small).unwrap().4, 2);
}

#[test]
fn the_reads_after_the_open_are_the_reads_of_rawzip_alone() {
    let bytes = large_body(b"").end(b"", 0);
    let mut alone = vec![0u8; 256 * 1024];
    let reader = Counted::new(&bytes);
    let archive = ZipLocator::new()
        .locate_in_reader(reader.clone(), &mut alone, reader.size())
        .unwrap();
    reader.take();
    let mut count = 0;
    let mut entries = archive.entries(&mut alone);
    while entries.next_entry().unwrap().is_some() {
        count += 1;
    }
    assert_eq!(count, 3000);
    let expected = reader.take();

    let reader = Counted::new(&bytes);
    let archive = open_end(reader.clone(), reader.size()).unwrap().archive;
    reader.take();
    let mut buffer = vec![0u8; 256 * 1024];
    let mut count = 0;
    let mut entries = archive.entries(&mut buffer);
    while entries.next_entry().unwrap().is_some() {
        count += 1;
    }
    assert_eq!(count, 3000);
    assert_eq!(reader.take(), expected);

    // The same when the first read of the open holds the whole directory: the
    // bytes of the open are gone after the open.
    let small = two_rows().end(b"", 0);
    let reader = Counted::new(&small);
    let archive = open_end(reader.clone(), reader.size()).unwrap().archive;
    reader.take();
    let mut entries = archive.entries(&mut buffer);
    while entries.next_entry().unwrap().is_some() {}
    assert_eq!(reader.take().0, 1);

    // A read past the end of the file gets no bytes after the open, also the
    // one byte that rawzip asks for during the open of a cut comment.
    let cut = two_rows().end(b"cut", 100);
    let archive = open_end(cut.clone(), cut.len() as u64).unwrap().archive;
    let last = archive.eocd_offset() + END_BYTES + 99;
    assert_eq!(archive.get_ref().read_at(&mut [0u8; 1], last).unwrap(), 0);
}

#[test]
fn the_search_window_is_the_window_of_rawzip() {
    let plain = two_rows().end(b"", 0);
    let eocd = two_rows().eocd();
    for trailing in [SEARCH_BYTES - END_BYTES, SEARCH_BYTES - 3, SEARCH_BYTES - 4] {
        let mut bytes = plain.clone();
        bytes.extend(std::iter::repeat_n(
            0_u8,
            usize::try_from(trailing).unwrap(),
        ));
        // Where the signature is in the window.
        let room = bytes.len() as u64 - eocd;
        let alone = rawzip_alone(&bytes).map(|found| found.0);
        let helper = open_end(bytes.clone(), bytes.len() as u64)
            .ok()
            .map(|opened| opened.archive.eocd_offset());
        assert_eq!(helper, alone, "{room}");
        assert_eq!(helper.is_some(), room <= SEARCH_BYTES, "{room}");
    }
    let mut outside = plain.clone();
    outside.extend(std::iter::repeat_n(
        0_u8,
        usize::try_from(SEARCH_BYTES).unwrap(),
    ));
    assert!(rawzip_alone(&outside).is_none());
    let err = open_end(outside.clone(), outside.len() as u64).unwrap_err();
    assert_eq!(err.to_string(), "Missing end of central directory");
}

#[test]
fn a_hostile_tail_stays_in_budget_and_gives_a_clear_failure() {
    let trials = usize::try_from(MAX_TRIALS).unwrap();
    for count in [trials + 1, trials + 2, 4000] {
        let bytes = costly_tail(count, 0);
        let reader = Counted::new(&bytes);
        let err = open_end(reader.clone(), reader.size()).unwrap_err();
        assert_eq!(err.to_string(), TOO_MANY_TEXT);
        let (reads, read_bytes) = reader.take();
        // One read of the end of the file, and 3 reads for each trial.
        assert_eq!(reads, 1 + 3 * u64::from(MAX_TRIALS), "{count}");
        assert!(reads <= MAX_OPEN_READS);
        assert!(read_bytes <= MAX_OPEN_BYTES, "{read_bytes}");
    }
}

#[test]
fn the_worst_open_is_the_limit_in_the_docs() {
    // One costly record 2 KB before the end, and the others near the start of the
    // search window. Three reads of the end of the file, the trials, and the last
    // call of rawzip for the nearest record.
    let trials = usize::try_from(MAX_TRIALS).unwrap();
    let bytes = worst_tail(trials - 1);
    let reader = Counted::new(&bytes);
    let opened = open_end(reader.clone(), reader.size()).unwrap();
    assert_eq!(opened.archive.entries_hint(), 1);
    // No read is left to look at the far Zip64 place of the chosen record.
    assert_eq!(opened.notes.unchecked, 1);
    let (reads, read_bytes) = reader.take();
    assert_eq!(reads, MAX_OPEN_READS);
    assert!(read_bytes <= MAX_OPEN_BYTES, "{read_bytes}");
}

#[test]
fn signatures_that_fail_in_memory_cost_no_read() {
    // The bytes in memory show that each of these records is false, so the
    // walk gets to the true record with no read after the first.
    let body = two_rows();
    let mut comment = Vec::new();
    for _ in 0..2900 {
        comment.extend_from_slice(&end_record(0, 0, 0, 0));
    }
    let bytes = body.end(&comment, u16::try_from(comment.len()).unwrap());
    let reader = Counted::new(&bytes);
    let opened = open_end(reader.clone(), reader.size()).unwrap();
    assert_eq!(opened.archive.eocd_offset(), body.eocd());
    assert_eq!(opened.notes.skipped, 2900);
    assert_eq!(opened.notes.other_records, 0);
    assert_eq!(reader.take().0, 1);

    // A file of only signatures: only the reads of the end of the file. Each
    // record is false in memory, so no record makes one more read.
    let only = END_SIGNATURE.repeat(1 << 18);
    let reader = Counted::new(&only);
    let err = open_end(reader.clone(), reader.size()).unwrap_err();
    assert_eq!(err.to_string(), NO_RECORD_TEXT);
    assert_eq!(reader.take().0, 3);
}

#[test]
fn the_limit_counts_only_records_that_need_a_read() {
    // A true record behind one fewer costly record than the limit opens. The
    // last trial finds it.
    let trials = usize::try_from(MAX_TRIALS).unwrap();
    let body = large_body(b"");
    let mut comment = Vec::new();
    let start = body.eocd() + END_BYTES;
    for at in 0..trials - 1 {
        comment.extend_from_slice(&costly_decoy(4000, start + (at * 42) as u64));
    }
    let bytes = body.end(&comment, u16::try_from(comment.len()).unwrap());
    let reader = Counted::new(&bytes);
    let opened = open_end(reader.clone(), reader.size()).unwrap();
    assert_eq!(opened.archive.eocd_offset(), body.eocd());
    assert_eq!(opened.archive.directory_offset(), body.directory);
    // The trials are used up, so the walk cannot say more about these records.
    assert_eq!(opened.notes.unchecked, u32::try_from(trials - 1).unwrap());
    // One more costly record: the limit stops the walk before the true record.
    comment.extend_from_slice(&costly_decoy(4000, start + ((trials - 1) * 42) as u64));
    let bytes = body.end(&comment, u16::try_from(comment.len()).unwrap());
    let err = open_end(bytes.clone(), bytes.len() as u64).unwrap_err();
    assert_eq!(err.to_string(), TOO_MANY_TEXT);
}

#[test]
fn a_hostile_file_cannot_use_up_the_trials_to_hide_a_record() {
    // After the chosen record, each costly signature that holds it in a comment
    // can have another directory. Those that the limit stops are counted.
    let chosen = large_body(b"");
    let plain = chosen.end(b"", 0);
    let eocd = chosen.eocd();
    let mut bytes = plain[..usize::try_from(eocd).unwrap()].to_vec();
    // Records in the last entry data would be at a false place, so these are in
    // the central directory bytes, as an attacker can have in an entry comment.
    let count = usize::try_from(MAX_TRIALS).unwrap() + 3;
    let first = eocd - (count as u64) * 42 - 8;
    for at in 0..count {
        let place = first + (at * 42) as u64;
        let far = 4000 + u32::try_from(at).unwrap() * 7000;
        let mut decoy = costly_decoy(far, place);
        let covers = eocd + END_BYTES - place - 42;
        decoy[40..42].copy_from_slice(&u16::try_from(covers).unwrap().to_le_bytes());
        let start = usize::try_from(place).unwrap();
        bytes[start..start + 42].copy_from_slice(&decoy);
    }
    bytes.extend_from_slice(&plain[usize::try_from(eocd).unwrap()..]);
    let notes = notes_of(&bytes);
    assert_eq!(notes.other_records, 0);
    assert_eq!(notes.unchecked, 4);
}

#[test]
fn the_limits_are_the_values_in_the_docs() {
    assert_eq!(FIRST_READ_BYTES, 66_657);
    assert_eq!(SEARCH_BYTES, 1 << 20);
    assert_eq!(MAX_TRIALS, 16);
    assert_eq!(MAX_OPEN_READS, 54);
    assert_eq!(MAX_OPEN_BYTES, 1_185_405);
}

/// A record whose comment holds the chosen record, and that starts as far
/// before it as a comment allows, is at the start of the kept bytes. rawzip must
/// not read before them.
#[test]
fn a_record_at_the_start_of_the_kept_bytes_costs_no_read_for_its_search() {
    let body = body_with(b"", &[("a.bin", &vec![0u8; 200_000]), ("b.txt", b"x")], b"");
    let fake = body_with(b"", &[("FAKE.txt", b"fake")], b"");
    // The fake record is 1 KiB before the end of the file, so the first read
    // starts exactly where the bytes of the walk must start.
    let filler = usize::from(u16::MAX) - 1 - fake.directory_bytes().len();
    let mut comment = vec![b'f'; filler];
    comment.extend_from_slice(fake.directory_bytes());
    comment.extend_from_slice(&end_record(1, fake.directory_size, 0, 1002));
    comment.extend_from_slice(&[b't'; 1002]);
    // The longest comment reaches one byte into the fake record, so the first
    // record holds it.
    let bytes = body.end(&comment, u16::MAX);
    let reader = Counted::new(&bytes);
    let opened = open_end(reader.clone(), reader.size()).unwrap();
    assert_eq!(opened.notes.other_records, 1);
    // The end of the file, the false offset of the fake record, and the
    // directory of the first record. No read for a search.
    assert_eq!(reader.take().0, 3);
}

#[test]
fn a_weak_record_stays_the_choice_within_the_trials() {
    // A weak record, with its directory at its declared offset, far before the
    // kept bytes. Many records hold it in their comments, and each one costs
    // reads, and none is strong. The trials limit the reads.
    let body = large_body(b"");
    let mut bytes = body.bytes.clone();
    let count = 30_usize;
    let weak_at = bytes.len() as u64 + (count as u64) * 42;
    for at in 0..count {
        let place = bytes.len() as u64;
        let far = 4000 + u32::try_from(at).unwrap() * 7000;
        let mut decoy = costly_decoy(far, place);
        let holds = weak_at + 1 - place - 42;
        decoy[40..42].copy_from_slice(&u16::try_from(holds).unwrap().to_le_bytes());
        bytes.extend_from_slice(&decoy);
    }
    bytes.extend_from_slice(&end_record(
        body.count,
        body.directory_size + 3,
        body.declared,
        0,
    ));
    let reader = Counted::new(&bytes);
    let opened = open_end(reader.clone(), reader.size()).unwrap();
    assert_eq!(opened.archive.eocd_offset(), weak_at);
    assert_eq!(opened.archive.directory_offset(), body.directory);
    assert!(opened.notes.unchecked > 0);
    assert!(reader.take().0 <= MAX_OPEN_READS);
}

/// A reader that fails after some reads.
#[derive(Debug)]
struct Broken {
    bytes: Vec<u8>,
    good_reads: Cell<u32>,
}

impl ReaderAt for Broken {
    fn read_at(&self, buf: &mut [u8], offset: u64) -> std::io::Result<usize> {
        if self.good_reads.get() == 0 {
            return Err(std::io::Error::other("the file changed"));
        }
        self.good_reads.set(self.good_reads.get() - 1);
        self.bytes.as_slice().read_at(buf, offset)
    }
}

#[test]
fn a_read_error_of_a_directory_ends_the_open() {
    // rawzip hides an error of its read of the first directory record. The
    // helper makes that read again, and it gets the error.
    let bytes = large_body(b"").end(b"", 0);
    let size = bytes.len() as u64;
    let reader = Broken {
        bytes,
        good_reads: Cell::new(1),
    };
    let err = open_end(reader, size).unwrap_err();
    assert_eq!(err.to_string(), "the file changed");
}

#[test]
fn a_read_error_of_a_false_record_ends_the_open() {
    // The record with a locator needs a read that fails, and the true record
    // needs none, because the first read holds its directory. A read error must
    // not look like a false record.
    let large = vec![0u8; 200_000];
    let body = body_with(b"", &[("a.bin", &large)], b"");
    let mut comment = locator(100);
    comment.extend_from_slice(&end_record(1, 1000, 500, 0));
    let bytes = body.end(&comment, u16::try_from(comment.len()).unwrap());
    let size = bytes.len() as u64;
    let opened = open_end(bytes.clone(), size).unwrap();
    assert_eq!(opened.archive.eocd_offset(), body.eocd());
    let reader = Broken {
        bytes,
        good_reads: Cell::new(1),
    };
    let err = open_end(reader, size).unwrap_err();
    assert_eq!(err.to_string(), "the file changed");
}

#[test]
fn a_read_error_in_a_call_of_rawzip_ends_the_open() {
    // Only the read of rawzip for the Zip64 record fails. A later read is good, so
    // only the error of that call can end the open.
    #[derive(Debug)]
    struct FailsOnce {
        bytes: Vec<u8>,
        reads: Cell<u32>,
    }
    impl ReaderAt for FailsOnce {
        fn read_at(&self, buf: &mut [u8], offset: u64) -> std::io::Result<usize> {
            self.reads.set(self.reads.get() + 1);
            if self.reads.get() == 2 {
                return Err(std::io::Error::other("the file changed"));
            }
            self.bytes.as_slice().read_at(buf, offset)
        }
    }
    let large = vec![0u8; 200_000];
    let body = body_with(b"", &[("a.bin", &large)], b"");
    let mut comment = locator(100);
    comment.extend_from_slice(&end_record(1, 1000, 500, 0));
    let bytes = body.end(&comment, u16::try_from(comment.len()).unwrap());
    let size = bytes.len() as u64;
    let reader = FailsOnce {
        bytes,
        reads: Cell::new(0),
    };
    let err = open_end(reader, size).unwrap_err();
    assert_eq!(err.to_string(), "the file changed");
}

#[test]
fn a_read_error_ends_the_open() {
    let bytes = costly_tail(2, 0);
    let size = bytes.len() as u64;
    for good_reads in [0, 1] {
        let reader = Broken {
            bytes: bytes.clone(),
            good_reads: Cell::new(good_reads),
        };
        let err = open_end(reader, size).unwrap_err();
        assert_eq!(err.to_string(), "the file changed", "{good_reads}");
    }
}
