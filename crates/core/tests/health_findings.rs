//! Hostile corpus tests: health findings, the tree caps and
//! the memory that the ingest allocates.

#[path = "support/zip.rs"]
#[allow(
    dead_code,
    reason = "These tests use only part of the archive helpers."
)]
mod zip;

use zip::{Entry, archive, field, open, parsed};
use zipscope_core::contract::{health, marks};
use zipscope_core::ingest::{Ingest, Status};
use zipscope_core::tree::{MAX_DEPTH, MAX_FOLDERS};

fn marks_of(ingest: &Ingest<Vec<u8>>) -> Vec<u8> {
    (0..ingest.store().rows())
        .map(|row| ingest.store().marks(row))
        .collect()
}

fn finished(entries: &[Entry]) -> Ingest<Vec<u8>> {
    let mut ingest = parsed(entries);
    ingest.finish_checks();
    ingest
}

#[test]
fn the_caps_have_the_spec_values() {
    assert_eq!(MAX_DEPTH, 256);
    assert_eq!(MAX_FOLDERS, 4_194_304);
}

#[test]
fn a_healthy_archive_has_no_findings() {
    let ingest = finished(&[
        Entry::new("a/b.txt"),
        Entry::new("a/c.txt"),
        Entry::new("d"),
    ]);
    let fields = ingest.health_vector();
    assert_eq!(fields[health::DECLARED_ENTRIES], 3.0);
    assert_eq!(fields[health::COUNT_MISMATCH], 0.0);
    for index in [
        health::DUPLICATE_ROWS,
        health::BOMB_ROWS,
        health::OVERLAP_ROWS,
        health::DEPTH_CAP_ROWS,
        health::FOLDER_CAP_ROWS,
        health::CONTROL_NAME_ROWS,
    ] {
        assert_eq!(fields[index], 0.0, "field {index}");
        assert_eq!(fields[index + 1], -1.0, "example {index}");
    }
    assert_eq!(fields[health::PRELUDE_BYTES], 0.0);
    assert_eq!(fields[health::EPILOGUE_BYTES], 0.0);
    assert_eq!(fields[health::OVERLAPS_CHECKED], 1.0);
    assert_eq!(fields[health::DUPLICATES_CHECKED], 1.0);
    assert_eq!(marks_of(&ingest), [0, 0, 0]);
}

#[test]
fn duplicate_names_mark_each_copy_after_the_first() {
    let mut ingest = open(
        archive(
            &[
                Entry::new("same.txt"),
                Entry::new("other.txt"),
                Entry::new("same.txt"),
                Entry::new("same.txt"),
            ],
            4,
            None,
        )
        .bytes,
    );
    assert_eq!(ingest.parse(2), 2);
    assert_eq!(ingest.health_vector()[health::DUPLICATES_CHECKED], 0.0);
    ingest.parse(u32::MAX);
    // The check runs when parsing stops. The first row does not change,
    // and the marked rows are in the updates for the worker.
    assert_eq!(ingest.mark_updates(), [2, 3]);
    assert_eq!(ingest.health_vector()[health::DUPLICATES_CHECKED], 1.0);
    let dup = marks::DUPLICATE_NAME;
    assert_eq!(marks_of(&ingest), [0, 0, dup, dup]);
    let fields = ingest.health_vector();
    assert_eq!(fields[health::DUPLICATE_ROWS], 2.0);
    assert_eq!(fields[health::DUPLICATE_EXAMPLE], 2.0);
}

#[test]
fn cp437_names_that_decode_the_same_are_duplicates() {
    // 0x82 is é in CP437. The second name is UTF-8 with the flag.
    let ingest = finished(&[
        Entry::new(b"caf\x82.txt"),
        Entry {
            flags: 1 << 11,
            ..Entry::new("café.txt")
        },
        Entry::new(b"caf\x83.txt"),
    ]);
    assert_eq!(ingest.store().name(0), "café.txt".as_bytes());
    assert_eq!(marks_of(&ingest), [0, marks::DUPLICATE_NAME, 0]);
}

#[test]
fn many_names_with_one_duplicate() {
    let mut entries: Vec<Entry> = (0..5000)
        .map(|i| Entry::new(format!("d{}/f{i}", i % 37)))
        .collect();
    entries.push(Entry::new(format!("d{}/f1234", 1234 % 37)));
    let ingest = finished(&entries);
    let fields = ingest.health_vector();
    assert_eq!(fields[health::DUPLICATE_ROWS], 1.0);
    assert_eq!(fields[health::DUPLICATE_EXAMPLE], 5000.0);
    assert_eq!(ingest.store().marks(5000), marks::DUPLICATE_NAME);
}

#[test]
fn overlapping_entries_in_offset_order_are_found_while_parsing() {
    // Each local header is 30 bytes and the name, so row 0 claims data
    // over rows 1 and 2.
    let one = |name| Entry {
        compressed: 1,
        ..Entry::new(name)
    };
    let entries = [
        Entry {
            compressed: 100,
            ..Entry::new("a")
        },
        one("b"),
        one("c"),
    ];
    let mut ingest = open(archive(&entries, 3, None).bytes);
    ingest.parse(2);
    ingest.clear_mark_updates();
    ingest.parse(u32::MAX);
    assert_eq!(ingest.mark_updates(), [0u32; 0]);
    let fields = ingest.health_vector();
    assert_eq!(fields[health::OVERLAPS_CHECKED], 1.0);
    assert_eq!(fields[health::OVERLAP_ROWS], 3.0);
    assert_eq!(fields[health::OVERLAP_EXAMPLE], 0.0);
    assert_eq!(marks_of(&ingest), [marks::OVERLAP; 3]);
}

#[test]
fn entries_that_share_one_local_header_overlap() {
    // The quoted-overlap bomb: many central-directory records point at the
    // same data.
    let entries: Vec<Entry> = (0..50)
        .map(|i| Entry {
            offset: Some(0),
            compressed: 1000,
            size: 1_000_000,
            ..Entry::new(format!("bomb-{i}"))
        })
        .collect();
    let ingest = finished(&entries);
    assert_eq!(ingest.health_vector()[health::OVERLAP_ROWS], 50.0);
}

#[test]
fn out_of_order_offsets_are_checked_when_parsing_ends() {
    let one = |name| Entry {
        compressed: 1,
        ..Entry::new(name)
    };
    let mut first = archive(&[one("a"), one("b"), one("c")], 3, None);
    // Point row 0 at the local header of row 2 and row 2 at row 0, and make
    // row 1 claim data that runs over row 2.
    let records = first.records.clone();
    let lho = |bytes: &Vec<u8>, record: usize| {
        u32::from_le_bytes(bytes[record + 42..record + 46].try_into().unwrap())
    };
    let (zero, two) = (lho(&first.bytes, records[0]), lho(&first.bytes, records[2]));
    first.bytes[records[0] + 42..records[0] + 46].copy_from_slice(&two.to_le_bytes());
    first.bytes[records[2] + 42..records[2] + 46].copy_from_slice(&zero.to_le_bytes());
    first.bytes[records[1] + 20..records[1] + 24].copy_from_slice(&40u32.to_le_bytes());
    let mut ingest = open(first.bytes);
    ingest.parse(2);
    assert_eq!(ingest.health_vector()[health::OVERLAPS_CHECKED], 0.0);
    ingest.clear_mark_updates();
    // The batch that ends parsing checks all rows.
    ingest.parse(u32::MAX);
    assert_eq!(ingest.status(), &Status::Complete);
    let fields = ingest.health_vector();
    assert_eq!(fields[health::OVERLAPS_CHECKED], 1.0);
    // Row 1 (b) runs into row 0, whose header is now the last one.
    assert_eq!(fields[health::OVERLAP_ROWS], 2.0);
    assert_eq!(marks_of(&ingest), [marks::OVERLAP, marks::OVERLAP, 0]);
    let mut updates = ingest.mark_updates().to_vec();
    updates.sort_unstable();
    assert_eq!(updates, [0, 1]);
    // A second check does nothing.
    ingest.clear_mark_updates();
    ingest.finish_checks();
    assert_eq!(ingest.mark_updates(), [0u32; 0]);
}

#[test]
fn bomb_like_ratios_are_above_100_times_and_at_least_16_mib() {
    // Two real cases: a 5.9 KiB text file and a 9.1 KiB folder of text
    // have ratios above 100x, but they are not a risk. A 20 MiB entry at
    // 200x is.
    let mib = 1 << 20;
    let ingest = finished(&[
        Entry {
            size: 20 * mib,
            compressed: 20 * mib / 200,
            ..Entry::new("bomb")
        },
        Entry {
            size: 6_042,
            compressed: 40,
            ..Entry::new("notes.txt")
        },
        Entry {
            size: 9_318,
            compressed: 60,
            ..Entry::new("docs/readme.txt")
        },
        Entry {
            size: 16 * mib,
            compressed: 16 * mib / 101,
            ..Entry::new("at 16 MiB")
        },
        Entry {
            size: 16 * mib - 1,
            compressed: 0,
            ..Entry::new("below 16 MiB")
        },
        Entry {
            size: 100 * mib,
            compressed: mib,
            ..Entry::new("exactly 100")
        },
        Entry {
            size: 0,
            compressed: 0,
            ..Entry::new("empty")
        },
        Entry {
            size: u32::MAX,
            compressed: 0,
            ..Entry::new("nothing")
        },
    ]);
    let bomb = marks::BOMB_RATIO;
    let without_overlap: Vec<u8> = marks_of(&ingest)
        .iter()
        .map(|bits| bits & !marks::OVERLAP)
        .collect();
    assert_eq!(without_overlap, [bomb, 0, 0, bomb, 0, 0, 0, bomb]);
    assert_eq!(ingest.health_vector()[health::BOMB_ROWS], 3.0);
    assert_eq!(ingest.health_vector()[health::BOMB_EXAMPLE], 0.0);
}

#[test]
fn a_depth_bomb_stays_within_the_caps() {
    let deep = "x/".repeat(30_000);
    let entries: Vec<Entry> = (0..20).map(|i| Entry::new(format!("{deep}{i}"))).collect();
    let ingest = finished(&entries);
    assert_eq!(ingest.tree().folder_count(), 1 + MAX_DEPTH);
    let fields = ingest.health_vector();
    assert_eq!(fields[health::DEPTH_CAP_ROWS], 20.0);
    assert_eq!(fields[health::DEPTH_CAP_EXAMPLE], 0.0);
    assert!(
        marks_of(&ingest)
            .iter()
            .all(|bits| bits & marks::DEPTH_CAP != 0)
    );
}

#[test]
fn the_folder_cap_marks_its_rows() {
    let entries: Vec<Entry> = (0..100)
        .map(|i| Entry::new(format!("top/{i}/file")))
        .collect();
    let bytes = archive(&entries, 100, None).bytes;
    let size = bytes.len() as u64;
    let mut ingest = Ingest::with_folder_limit(bytes, size, 10).unwrap();
    ingest.parse(u32::MAX);
    assert_eq!(ingest.tree().folder_count(), 10);
    let fields = ingest.health_vector();
    // The root, `top` and 8 subfolders fit.
    assert_eq!(fields[health::FOLDER_CAP_ROWS], 92.0);
    assert_eq!(fields[health::FOLDER_CAP_EXAMPLE], 8.0);
    assert_eq!(ingest.store().marks(7), 0);
    assert_eq!(ingest.store().marks(8), marks::FOLDER_CAP);
    assert_eq!(fields[health::DEPTH_CAP_ROWS], 0.0);
}

#[test]
fn control_names_have_one_finding_with_a_count_and_the_first_row() {
    let mut cp437_line = Entry::new(b"cp437\nline\xe9".as_slice());
    cp437_line.flags = 0;
    let mut in_utf8_flag = Entry::new("flag\u{202e}fdp.exe");
    in_utf8_flag.flags = 0x0800;
    let mut lossy = Entry::new(b"lossy\xe9.txt".as_slice());
    lossy.flags = 0x0800;
    let mut note = Entry::new("note.txt");
    note.comment = "comment \u{202e} with\nlines".into();
    let entries = [
        Entry::new("plain.txt"),
        Entry::new("invoice\u{202e}fdp.exe"),
        Entry::new("ok/\u{62a}\u{642}\u{631}\u{64a}\u{631}.pdf"),
        Entry::new("a\u{2066}b\u{2069}.txt"),
        Entry::new("line\nbreak.txt"),
        Entry::new("setup.p\u{200b}df"),
        // Persian with its joiner: a real name, no finding.
        Entry::new("\u{645}\u{6cc}\u{200c}\u{62e}.pdf"),
        cp437_line,
        in_utf8_flag,
        // U+FFFD is the mark of a bad byte. It has its own source code.
        lossy,
        // A comment is not a name.
        note,
    ];
    let marked = [1, 3, 4, 5, 7, 8];
    let ingest = finished(&entries);
    let fields = ingest.health_vector();
    assert_eq!(fields[health::CONTROL_NAME_ROWS], 6.0);
    assert_eq!(fields[health::CONTROL_NAME_EXAMPLE], 1.0);
    assert_eq!(ingest.health().control_name_rows, 6);
    for (row, bits) in marks_of(&ingest).into_iter().enumerate() {
        assert_eq!(
            bits & marks::CONTROL_NAME != 0,
            marked.contains(&row),
            "row {row}"
        );
    }
}

#[test]
fn a_mac_icon_file_gives_no_finding() {
    let ingest = finished(&[
        Entry::new("Pictures/Icon\r"),
        Entry::new("__MACOSX/Pictures/._Icon\r"),
        Entry::new("plain.txt"),
    ]);
    let fields = ingest.health_vector();
    assert_eq!(fields[health::CONTROL_NAME_ROWS], 0.0);
    assert_eq!(fields[health::CONTROL_NAME_EXAMPLE], -1.0);
    assert_eq!(marks_of(&ingest), [0, 0, 0]);
}

#[test]
fn marked_from_counts_only_the_rows_after_the_first() {
    let ingest = finished(&[
        Entry::new("a\u{202e}"),
        Entry::new("b"),
        Entry::new("c\u{202e}"),
        Entry::new("d\u{202e}"),
    ]);
    let counts: Vec<usize> = (0..6)
        .map(|first| ingest.marked_from(first, marks::CONTROL_NAME))
        .collect();
    assert_eq!(counts, [3, 2, 2, 1, 0, 0]);
}

#[test]
fn the_control_name_count_does_not_depend_on_the_batches() {
    let entries: Vec<Entry> = (0..300)
        .map(|i| {
            Entry::new(if i % 3 == 0 {
                format!("bad\u{202e}{i}.txt")
            } else {
                format!("good{i}.txt")
            })
        })
        .collect();
    let mut ingest = open(archive(&entries, 300, None).bytes);
    let mut seen = Vec::new();
    while ingest.parse(7) != 0 {
        seen.push(ingest.health_vector()[health::CONTROL_NAME_ROWS]);
    }
    assert_eq!(ingest.status(), &Status::Complete);
    assert!(seen.windows(2).all(|pair| pair[0] <= pair[1]));
    // Each step of 7 rows has 2 or 3 of them, so the count grows in steps.
    assert_eq!(seen[0], 3.0);
    assert_eq!(seen[1], 5.0);
    let fields = ingest.health_vector();
    assert_eq!(fields[health::CONTROL_NAME_ROWS], 100.0);
    assert_eq!(fields[health::CONTROL_NAME_EXAMPLE], 0.0);
}

#[test]
fn the_declared_count_is_compared_only_when_complete() {
    let mut ingest = open(archive(&[Entry::new("a"), Entry::new("b")], 7, None).bytes);
    ingest.parse(1);
    assert_eq!(ingest.health_vector()[health::COUNT_MISMATCH], 0.0);
    ingest.parse(u32::MAX);
    let fields = ingest.health_vector();
    assert_eq!(fields[health::DECLARED_ENTRIES], 7.0);
    assert_eq!(fields[health::COUNT_MISMATCH], 1.0);

    let mut zip64 = open(archive(&[Entry::new("a")], u16::MAX, Some(1 << 40)).bytes);
    zip64.parse(u32::MAX);
    assert_eq!(zip64.health_vector()[health::COUNT_MISMATCH], 1.0);
}

#[test]
fn prelude_and_epilogue_bytes() {
    let base = archive(&[Entry::new("a"), Entry::new("b")], 2, None);
    // A prefix with offsets that point past it, as a self-extractor has.
    let mut entries = [Entry::new("a"), Entry::new("b")];
    entries[0].offset = Some(300);
    entries[1].offset = Some(331);
    let mut bytes = archive(&entries, 2, None).bytes;
    let directory = base.directory;
    let eocd = bytes.len() - 22;
    bytes[eocd + 16..eocd + 20]
        .copy_from_slice(&u32::try_from(directory + 300).unwrap().to_le_bytes());
    let mut data = vec![0x90u8; 300];
    data.extend_from_slice(&bytes);
    data.extend_from_slice(b"trailing junk");
    let mut ingest = open(data);
    ingest.parse(u32::MAX);
    assert_eq!(ingest.status(), &Status::Complete);
    let fields = ingest.health_vector();
    assert_eq!(fields[health::PRELUDE_BYTES], 300.0);
    assert_eq!(fields[health::EPILOGUE_BYTES], 13.0);
    assert_eq!(fields[health::OVERLAP_ROWS], 0.0);
}

#[test]
fn encrypted_entries_are_counted_by_kind() {
    let aes = |strength: u8| field(0x9901, &[2, 0, b'A', b'E', strength, 8, 0]);
    let ingest = finished(&[
        Entry {
            flags: 1,
            ..Entry::new("zipcrypto")
        },
        Entry {
            flags: 1,
            method: 99,
            extra: aes(3),
            ..Entry::new("aes256")
        },
        Entry {
            flags: 1,
            method: 99,
            extra: aes(1),
            ..Entry::new("aes128")
        },
        Entry {
            flags: 1,
            method: 99,
            ..Entry::new("aes-unknown")
        },
        Entry {
            flags: 0x41,
            ..Entry::new("strong")
        },
        Entry::new("plain"),
    ]);
    let fields = ingest.health_vector();
    let kinds: Vec<f64> = (0..6)
        .map(|kind| fields[health::ENCRYPTED + kind])
        .collect();
    assert_eq!(kinds, [1.0, 1.0, 0.0, 1.0, 1.0, 1.0]);
}

#[test]
fn oversized_records_keep_their_findings() {
    let name = vec![b'n'; usize::from(u16::MAX)];
    let entries = [
        Entry {
            extra: field(0xcafe, &vec![1u8; usize::from(u16::MAX) - 4]),
            comment: vec![b'c'; usize::from(u16::MAX)],
            ..Entry::new(&name)
        },
        Entry {
            comment: vec![b'c'; usize::from(u16::MAX)],
            ..Entry::new(&name)
        },
    ];
    let ingest = finished(&entries);
    assert_eq!(ingest.store().rows(), 2);
    assert_eq!(marks_of(&ingest), [0, marks::DUPLICATE_NAME]);
}

#[test]
fn a_terminal_error_keeps_the_findings_of_the_rows_before_it() {
    let mut fixture = archive(
        &[
            Entry::new("x"),
            Entry::new("x"),
            Entry::new("y"),
            Entry::new("z"),
        ],
        4,
        None,
    );
    fixture.bytes[fixture.records[2]] = b'X';
    let mut ingest = open(fixture.bytes);
    assert_eq!(ingest.parse(u32::MAX), 2);
    assert!(matches!(ingest.status(), Status::Failed(_)));
    ingest.finish_checks();
    let fields = ingest.health_vector();
    assert_eq!(fields[health::DUPLICATE_ROWS], 1.0);
    // The declared count is not compared for a partial listing.
    assert_eq!(fields[health::COUNT_MISMATCH], 0.0);
}

/// Memory grows with the rows, the names and the folders, never with a
/// claim in a header.
#[test]
fn allocated_memory_is_proportional_to_the_input() {
    let empty = {
        let mut ingest = open(archive(&[Entry::new("a")], 1, None).bytes);
        ingest.parse(u32::MAX);
        ingest.allocated_bytes()
    };
    // A false count of 2^40 entries reserves at most 16 page slots (the
    // clamped hint) and allocates no page.
    let mut lying = open(archive(&[Entry::new("a")], u16::MAX, Some(1 << 40)).bytes);
    lying.parse(u32::MAX);
    assert_eq!(lying.store().page_count(), 1);
    assert!(lying.allocated_bytes() <= empty + 16 * 1024);

    // A depth bomb: each row can make up to 256 folders.
    let entries: Vec<Entry> = (0..200)
        .map(|i| Entry::new(format!("{}{i}", format!("{i}/").repeat(300))))
        .collect();
    let bytes = archive(&entries, 200, None).bytes;
    let input = bytes.len();
    let mut ingest = open(bytes);
    ingest.parse(u32::MAX);
    ingest.finish_checks();
    assert!(ingest.tree().folder_count() <= 1 + 200 * MAX_DEPTH);
    let extra = ingest.allocated_bytes() - empty;
    assert!(extra <= 64 * input, "{extra} bytes for {input} input bytes");
}

#[test]
fn empty_archive_reports_prefix_and_suffix_without_its_comment() {
    let prefix = b"MZ stub data!";
    let comment = b"archive comment";
    let suffix = b"trailing data";
    let mut bytes = prefix.to_vec();
    bytes.extend_from_slice(&0x0605_4b50_u32.to_le_bytes());
    bytes.extend_from_slice(&[0; 12]);
    bytes.extend_from_slice(&u32::try_from(prefix.len()).unwrap().to_le_bytes());
    bytes.extend_from_slice(&u16::try_from(comment.len()).unwrap().to_le_bytes());
    bytes.extend_from_slice(comment);
    bytes.extend_from_slice(suffix);
    let mut ingest = open(bytes);
    ingest.parse(u32::MAX);
    assert_eq!(ingest.status(), &Status::Complete);
    let report = ingest.health();
    assert_eq!(report.prelude_bytes, prefix.len() as u64);
    assert_eq!(report.epilogue_bytes, suffix.len() as u64);
    let fields = ingest.health_vector();
    assert_eq!(fields[health::PRELUDE_BYTES], 13.0);
    assert_eq!(fields[health::EPILOGUE_BYTES], 13.0);
}

#[test]
fn large_out_of_order_overlap_checks_run_in_bounded_steps() {
    let entries: Vec<_> = (0..20_000)
        .map(|row| Entry {
            offset: Some((19_999 - row) * 4),
            compressed: 5,
            size: 5,
            ..Entry::new(format!("f{row}"))
        })
        .collect();
    let mut ingest = open(archive(&entries, 20_000, None).bytes);
    ingest.parse(u32::MAX);
    assert_eq!(ingest.status(), &Status::Complete);
    assert_eq!(ingest.health_vector()[health::OVERLAPS_CHECKED], 0.0);
    let mut steps = 0;
    let before = ingest.allocated_bytes();
    while !ingest.finish_checks_step(4096) {
        steps += 1;
        assert!(steps < 1000);
        assert_eq!(ingest.store().rows(), 20_000);
        assert!(ingest.allocated_bytes() <= before + 20_000 * 32);
    }
    assert!(steps > 20);
    assert_eq!(ingest.health().overlap_rows, 20_000);
    assert_eq!(ingest.health_vector()[health::OVERLAPS_CHECKED], 1.0);
    assert_eq!(ingest.mark_updates().len(), 20_000);
    assert!(ingest.finish_checks_step(1));
}

#[test]
fn stepped_final_checks_match_a_one_shot_check_at_each_budget() {
    // The duplicate check takes about 4 units for each row (one count pass,
    // two sort passes and the scan). The budgets near 8192 include one at
    // which the duplicate check ends with no budget left for the overlap
    // check.
    let count = 24_576_u64;
    let entries: Vec<_> = (0..count)
        .map(|row| Entry {
            offset: Some(u32::try_from((count - 1 - row) * 4).unwrap()),
            compressed: 5,
            size: 5,
            ..Entry::new(format!("f{}", row % 20_000))
        })
        .collect();
    let bytes = archive(&entries, u16::MAX, None).bytes;
    let parse = || {
        let mut ingest = open(bytes.clone());
        while ingest.status() == &Status::Parsing {
            ingest.parse(4096);
        }
        ingest
    };
    let mut expected = parse();
    expected.finish_checks();
    let want = (expected.health(), marks_of(&expected));
    assert_eq!(want.0.overlap_rows, count);
    assert_eq!(want.0.duplicate_rows, count - 20_000);
    let budgets = [1, 4096, 24_576, 4 * 24_576, 4 * 24_576 + 1]
        .into_iter()
        .chain(8170..8200);
    for budget in budgets {
        let mut ingest = parse();
        let mut steps = 0;
        while !ingest.finish_checks_step(budget) {
            steps += 1;
            assert!(steps < 2_000_000, "budget {budget}");
        }
        let fields = ingest.health_vector();
        assert_eq!(fields[health::OVERLAPS_CHECKED], 1.0, "budget {budget}");
        assert_eq!(fields[health::DUPLICATES_CHECKED], 1.0, "budget {budget}");
        assert_eq!(
            (ingest.health(), marks_of(&ingest)),
            want,
            "budget {budget}"
        );
    }
}

#[test]
fn duplicates_are_found_in_bounded_steps() {
    let mut entries = Vec::new();
    for row in 0..20_000 {
        entries.push(Entry::new(format!("name-{row:08}-suffix.txt")));
        if row % 11 == 0 {
            entries.push(Entry::new(format!("name-{:08}-suffix.txt", row / 2)));
        }
    }
    let count = entries.len();
    let mut ingest = open(archive(&entries, u16::try_from(count).unwrap(), None).bytes);
    while ingest.status() == &Status::Parsing {
        ingest.parse(1000);
    }
    // More than 16,384 rows: the worker runs the check in steps.
    assert_eq!(ingest.health().duplicate_rows, 0);
    assert_eq!(ingest.health_vector()[health::DUPLICATES_CHECKED], 0.0);
    let mut steps = 0;
    while !ingest.finish_checks_step(997) {
        steps += 1;
    }
    assert!(steps > 2 * count / 997, "{steps} steps");
    assert_eq!(ingest.health().duplicate_rows, 1819);
    assert_eq!(ingest.health_vector()[health::DUPLICATES_CHECKED], 1.0);
    assert_eq!(ingest.store().rows(), count);
    // Each copy is marked, and its first row is not.
    let mut seen = std::collections::HashSet::new();
    for row in 0..count {
        let first = seen.insert(ingest.store().name(row).to_vec());
        let marked = ingest.store().marks(row) & marks::DUPLICATE_NAME != 0;
        assert_eq!(marked, !first, "row {row}");
    }
    assert!(ingest.finish_checks_step(1));
}

#[test]
fn a_listing_with_no_parsed_rows_does_not_claim_a_prelude() {
    let mut ingest = open(archive(&[Entry::new("a"), Entry::new("b")], 2, None).bytes);
    assert_eq!(ingest.health().prelude_bytes, 0);
    assert_eq!(ingest.health_vector()[health::PRELUDE_BYTES], 0.0);
    ingest.parse(1);
    assert_eq!(ingest.health().prelude_bytes, 0);
    assert_eq!(ingest.health_vector()[health::PRELUDE_BYTES], 0.0);
}

#[test]
fn a_byte_limit_stops_a_batch_when_the_records_become_large() {
    let mut entries: Vec<_> = (0..100)
        .map(|row| Entry::new(format!("s{row:03}")))
        .collect();
    let large = "n".repeat(10_000);
    entries.extend((0..100).map(|row| Entry::new(format!("{large}{row:03}"))));
    let mut ingest = open(archive(&entries, 200, None).bytes);
    // The first row starts a page, which is more than the limit.
    assert_eq!(ingest.parse_within(u32::MAX, 1), 1);
    // 99 short rows fit in this limit, and the first large row passes it.
    assert_eq!(ingest.parse_within(u32::MAX, 99 * (256 + 2 * 4) + 1), 100);
    assert_eq!(ingest.store().rows(), 101);
    // Each large row is about 20 KB of the estimate.
    assert_eq!(ingest.parse_within(u32::MAX, 100_000), 5);
    assert_eq!(ingest.parse_within(5, usize::MAX), 5);
    while ingest.status() == &Status::Parsing {
        ingest.parse_within(u32::MAX, 1);
    }
    assert_eq!(ingest.store().rows(), 200);
}

#[test]
fn a_byte_limit_stops_a_batch_before_a_new_chunk_that_does_not_fit() {
    // Names of 30,000 bytes: the first name chunk (4 MiB) has room for 139
    // of them. After 134 names, its room is less than the text of one row
    // can be. Row 0 has a comment, so the comment arena has its chunk.
    let name = |row: usize| format!("{row:03}{}", "n".repeat(29_997));
    let mut entries: Vec<_> = (0..200).map(|row| Entry::new(name(row))).collect();
    entries[0].comment = b"c".to_vec();
    let mut ingest = open(archive(&entries, 200, None).bytes);
    assert_eq!(ingest.parse_within(1, usize::MAX), 1);
    let allocated = ingest.store().allocated_bytes();
    // A limit of 10 MiB has room for about 170 rows of the estimate, but
    // after row 133 a new chunk can come, and 4 MiB more does not fit.
    // Thus the call stops before it, and the next call starts with it.
    assert_eq!(ingest.parse_within(u32::MAX, 10 << 20), 133);
    assert_eq!(ingest.store().allocated_bytes(), allocated);
    // The next call has the room, so it adds the chunk and goes on.
    assert!(ingest.parse_within(u32::MAX, 10 << 20) > 6);
    assert!(ingest.store().allocated_bytes() > allocated);
}

#[test]
fn a_byte_limit_stops_a_batch_before_the_first_comment_chunk_when_it_fits() {
    // Most archives have no comments. The first comment allocates the
    // first chunk of the comment arena (4 MiB).
    let mut entries: Vec<_> = (0..2_000)
        .map(|row| Entry::new(format!("n{row:04}")))
        .collect();
    entries[1_000].comment = b"c".to_vec();
    let mut ingest = open(archive(&entries, 2_000, None).bytes);
    assert_eq!(ingest.parse_within(1, usize::MAX), 1);
    // The chunk fits in this limit, but not with the rows before it: the
    // call stops at 4 MiB less than the limit.
    let added = ingest.parse_within(u32::MAX, (4 << 20) + 100_000);
    assert!((300..1_000).contains(&added), "{added} rows");
    assert!(!ingest.store().has_comment_chunk());
    // The chunk does not fit in a limit of 1 MiB, so a call of this size
    // does not stop for it. Else each call near the hard stop would add
    // one row.
    let mut calls = 0;
    while !ingest.store().has_comment_chunk() {
        ingest.parse_within(u32::MAX, 1 << 20);
        calls += 1;
    }
    assert_eq!(calls, 1);
}

#[test]
fn duplicates_are_found_past_the_tree_caps_and_with_odd_separators() {
    let deep = "d/".repeat(MAX_DEPTH + 5);
    let names = [
        format!("{deep}x"),
        format!("{deep}x"),
        format!("{deep}y"),
        "f1/f2/f3/name".to_owned(),
        "f1/f2/f3/name".to_owned(),
        "f1//f2/f3/name".to_owned(),
        "a/b/".to_owned(),
        "a/b/".to_owned(),
        "a\\b/".to_owned(),
    ];
    let entries: Vec<_> = names.iter().map(Entry::new).collect();
    let bytes = archive(&entries, u16::try_from(entries.len()).unwrap(), None).bytes;
    // A table of 4 folders is full after `f1/f2/f3`: `f3` and more go to
    // the deepest folder that exists.
    for limit in [MAX_FOLDERS, 4] {
        let mut ingest =
            Ingest::with_folder_limit(bytes.clone(), bytes.len() as u64, limit).unwrap();
        while ingest.status() == &Status::Parsing {
            ingest.parse(1);
        }
        ingest.finish_checks();
        let dup = marks::DUPLICATE_NAME;
        let found: Vec<u8> = marks_of(&ingest).iter().map(|bits| bits & dup).collect();
        assert_eq!(found, [0, dup, 0, 0, dup, 0, 0, dup, 0], "limit {limit}");
    }
}

#[test]
fn separator_variants_of_one_path_keep_the_final_steps_short() {
    // 50,000 names that differ only in the spelling of 16 separators. They
    // are in the same folder with the same last segment, but they are not
    // the same name.
    let count = 50_000_u32;
    let entries: Vec<_> = (0..count)
        .map(|variant| {
            let mut name = String::new();
            for bit in 0..16 {
                name.push('d');
                name.push(if variant >> bit & 1 == 0 { '/' } else { '\\' });
            }
            name.push('f');
            Entry::new(name)
        })
        .collect();
    let mut ingest = open(archive(&entries, u16::try_from(count).unwrap(), None).bytes);
    while ingest.status() == &Status::Parsing {
        ingest.parse(4096);
    }
    let mut steps = 0;
    loop {
        let start = std::time::Instant::now();
        let done = ingest.finish_checks_step(8192);
        assert!(
            start.elapsed() < std::time::Duration::from_millis(250),
            "step {steps}"
        );
        if done {
            break;
        }
        steps += 1;
        assert!(steps < 100, "{steps} steps");
    }
    assert_eq!(ingest.health().duplicate_rows, 0);
}

#[test]
fn a_scan_step_stops_inside_a_run_of_equal_names() {
    let entries: Vec<_> = (0..1000).map(|_| Entry::new("same")).collect();
    let mut ingest = open(archive(&entries, 1000, None).bytes);
    while ingest.status() == &Status::Parsing {
        ingest.parse(u32::MAX);
    }
    // At most 16,384 rows: the last parse call ran the checks.
    assert_eq!(ingest.health().duplicate_rows, 999);
    let mut entries: Vec<_> = (0..20_000)
        .map(|row| Entry::new(format!("n{row}")))
        .collect();
    entries.extend((0..5_000).map(|_| Entry::new("same")));
    let bytes = archive(&entries, u16::try_from(entries.len()).unwrap(), None).bytes;
    for budget in [1, 2, 3, 7, 8192] {
        let mut ingest = open(bytes.clone());
        while ingest.status() == &Status::Parsing {
            ingest.parse(u32::MAX);
        }
        while !ingest.finish_checks_step(budget) {}
        assert_eq!(ingest.health().duplicate_rows, 4_999, "budget {budget}");
        assert_eq!(ingest.store().marks(20_000) & marks::DUPLICATE_NAME, 0);
    }
}

#[test]
fn unicode_extra_fields_count_in_the_batch_byte_limit() {
    let text = "u".repeat(30_000);
    for comment in [false, true] {
        let entries: Vec<_> = (0..200)
            .map(|row| {
                let unicode = format!("{row:03}{text}");
                let mut body = vec![1];
                let raw: &[u8] = if comment { b"c" } else { b"n" };
                body.extend_from_slice(&zip::crc32(raw).to_le_bytes());
                body.extend_from_slice(unicode.as_bytes());
                let mut entry = Entry::new(format!("n{row}"));
                if comment {
                    entry.comment = b"c".to_vec();
                    entry.extra = field(0x6375, &body);
                } else {
                    entry.name = b"n".to_vec();
                    entry.extra = field(0x7075, &body);
                }
                entry
            })
            .collect();
        let mut ingest = open(archive(&entries, 200, None).bytes);
        // The first row starts a page.
        assert_eq!(ingest.parse_within(u32::MAX, 1), 1);
        let stored = if comment {
            ingest.store().comment(0).len()
        } else {
            ingest.store().name(0).len()
        };
        assert_eq!(stored, 30_003, "comment {comment}");
        // Each row stores about 30 KB of text from its extra field.
        let added = ingest.parse_within(u32::MAX, 1 << 20);
        assert!(
            (10..=20).contains(&added),
            "comment {comment}: {added} rows"
        );
    }
}

#[test]
fn long_duplicate_names_cost_units_for_their_bytes() {
    // 3,000 copies of a name of 6,400 bytes: each comparison costs 101
    // units, about 318,000 units in all. The inline check of the last
    // parse call stops at 262,144 units.
    let name = "l".repeat(6_400);
    let entries: Vec<_> = (0..3_000).map(|_| Entry::new(&name)).collect();
    let mut ingest = open(archive(&entries, 3_000, None).bytes);
    while ingest.status() == &Status::Parsing {
        ingest.parse(u32::MAX);
    }
    assert_eq!(ingest.health_vector()[health::DUPLICATES_CHECKED], 0.0);
    let mut calls = 1;
    while !ingest.finish_checks_step(8192) {
        calls += 1;
    }
    assert!((5..=9).contains(&calls), "{calls} calls");
    assert_eq!(ingest.health().duplicate_rows, 2_999);
}
