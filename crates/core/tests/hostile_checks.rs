// Range checks use [local_header_offset, local_header_offset + compressed_size).
// Empty ranges do not overlap. Check all rows after parsing ends.
// Mark each repeated decoded name after its first row. Keep all rows.

#[path = "support/checks.rs"]
mod checks;
#[path = "support/zip.rs"]
#[allow(dead_code, reason = "These tests use part of the archive helpers.")]
mod zip;

use checks::{check_tree, finish, marked};
use zip::{Entry, archive, field, open, u64le};
use zipscope_core::contract::{CHUNK_BYTES, Column, NameSource, marks};
use zipscope_core::ingest::{Ingest, Status};
use zipscope_core::tree::{MAX_DEPTH, ROOT};

fn parsed(entries: &[Entry], batch: u32) -> Ingest<Vec<u8>> {
    let mut ingest = open(archive(entries, entries.len().try_into().unwrap(), None).bytes);
    finish(&mut ingest, batch, entries.len());
    assert_eq!(ingest.status(), &Status::Complete);
    ingest
}

fn zip64(name: &str, size: u64, compressed: u64, offset: u64) -> Entry {
    let mut body = Vec::new();
    for value in [size, compressed, offset] {
        u64le(&mut body, value);
    }
    Entry {
        size: u32::MAX,
        compressed: u32::MAX,
        offset: Some(u32::MAX),
        extra: field(1, &body),
        ..Entry::new(name)
    }
}

#[test]
fn duplicate_names_cross_batches_without_losing_rows() {
    let entries = [
        "same", "other", "same", "same", "Same", "same/", "same/", "", "",
    ]
    .map(Entry::new);
    for batch in [1, 2, 100] {
        let ingest = parsed(&entries, batch);
        assert_eq!(ingest.store().rows(), entries.len());
        for row in [1, 4] {
            assert!(!marked(&ingest, row, marks::DUPLICATE_NAME));
        }
        for row in [2, 3, 6, 8] {
            assert!(marked(&ingest, row, marks::DUPLICATE_NAME), "row {row}");
        }
        check_tree(&ingest, 2);
    }
}

#[test]
fn duplicate_detection_uses_decoded_cp437_and_unicode_path_names() {
    let raw = b"different";
    let entries = [
        Entry::new(b"caf\x82/\x8e.txt"),
        Entry::new("café/Ä.txt"),
        Entry {
            extra: zip::unicode_path(1, zip::crc32(raw), "café/Ä.txt".as_bytes()),
            ..Entry::new(raw)
        },
        Entry {
            extra: zip::unicode_path(1, 0, "café/Ä.txt".as_bytes()),
            ..Entry::new("unique")
        },
    ];
    let ingest = parsed(&entries, 1);
    for row in 0..3 {
        assert_eq!(ingest.store().name(row), "café/Ä.txt".as_bytes());
    }
    assert_eq!(
        ingest.store().value(0, Column::NameSource),
        f64::from(NameSource::Cp437 as u8)
    );
    for row in [1, 2] {
        assert!(marked(&ingest, row, marks::DUPLICATE_NAME));
    }
    assert!(!marked(&ingest, 3, marks::DUPLICATE_NAME));
    check_tree(&ingest, 2);
}

#[test]
fn duplicate_detection_compares_the_full_name_and_keeps_nul_bytes() {
    let prefix = "p".repeat(4096);
    let entries = [
        Entry::new(format!("{prefix}a")),
        Entry::new(format!("{prefix}b")),
        Entry::new(b"x\0one"),
        Entry::new(b"x\0two"),
        Entry::new(b"x\0one"),
    ];
    let ingest = parsed(&entries, 2);
    for row in [1, 2, 3] {
        assert!(!marked(&ingest, row, marks::DUPLICATE_NAME), "row {row}");
    }
    assert!(marked(&ingest, 4, marks::DUPLICATE_NAME));
    assert_eq!(ingest.store().name(4), b"x\0one");
}

#[test]
fn bomb_ratios_use_a_strict_threshold_and_handle_zero_sizes() {
    // The sizes are at least 16 MiB where the ratio matters, because a
    // smaller entry is never bomb-like (`BOMB_MIN_BYTES`). 25 MiB is 100
    // times 256 KiB.
    let large = 25 << 20;
    let entries: Vec<_> = [
        (large, large / 100),
        (large + 100, large / 100),
        (0, 0),
        (large, 0),
        (0, 1),
        (1, 0),
    ]
    .into_iter()
    .enumerate()
    .map(|(row, (size, compressed))| Entry {
        size,
        compressed,
        ..Entry::new(format!("r{row}"))
    })
    .collect();
    let ingest = parsed(&entries, 1);
    for (row, expected) in [false, true, false, true, false, false]
        .into_iter()
        .enumerate()
    {
        assert_eq!(
            marked(&ingest, row, marks::BOMB_RATIO),
            expected,
            "row {row}"
        );
    }
}

#[test]
fn zip64_ratios_do_not_overflow_or_truncate_sizes() {
    let entries = [
        zip64("huge", 1 << 48, 1, 0),
        zip64("equal", 1 << 48, 1 << 48, 0),
        zip64("overflow", u64::MAX, u64::MAX / 2, 0),
        zip64("empty", 0, 0, 0),
    ];
    let ingest = parsed(&entries, 2);
    assert_eq!(
        ingest.store().value(0, Column::UncompressedSize),
        2f64.powi(48)
    );
    for (row, expected) in [true, false, false, false].into_iter().enumerate() {
        assert_eq!(
            marked(&ingest, row, marks::BOMB_RATIO),
            expected,
            "row {row}"
        );
    }
}

#[test]
fn overlap_detection_finds_aliases_nested_ranges_and_unsorted_offsets() {
    let intervals = [(50, 20), (0, 100), (10, 5), (30, 5), (50, 20), (200, 10)];
    let entries: Vec<_> = intervals
        .into_iter()
        .enumerate()
        .map(|(row, (offset, compressed))| Entry {
            offset: Some(offset),
            compressed,
            size: compressed,
            ..Entry::new(format!("f{row}"))
        })
        .collect();
    for batch in [1, 3, 100] {
        let ingest = parsed(&entries, batch);
        for row in 0..entries.len() {
            assert_eq!(marked(&ingest, row, marks::OVERLAP), row != 5, "row {row}");
        }
        assert_eq!(ingest.store().rows(), entries.len());
        check_tree(&ingest, 1);
    }
}

#[test]
fn touching_ranges_and_empty_ranges_do_not_overlap() {
    // A range has 30 bytes of local header and the compressed size.
    let intervals = [(0, 10), (40, 10), (80, 0), (110, 0), (140, 0)];
    let entries: Vec<_> = intervals
        .into_iter()
        .enumerate()
        .map(|(row, (offset, compressed))| Entry {
            offset: Some(offset),
            compressed,
            size: compressed,
            ..Entry::new(format!("f{row}"))
        })
        .collect();
    let ingest = parsed(&entries, 2);
    for row in 0..entries.len() {
        assert!(!marked(&ingest, row, marks::OVERLAP), "row {row}");
    }
}

#[test]
fn overlap_offsets_keep_bits_above_four_gib() {
    let base = (1 << 40) + 7;
    let entries = [
        zip64("f0", 16, 16, base),
        zip64("f1", 16, 16, base + 8),
        // F1 ends at `base + 8 + 30 + 16`, and this row only touches it.
        zip64("f2", 16, 16, base + 54),
        zip64("f3", 4, 4, 7),
    ];
    let ingest = parsed(&entries, 1);
    assert_eq!(
        ingest.store().value(0, Column::LocalHeaderOffset),
        2f64.powi(40) + 7.0
    );
    for (row, expected) in [true, true, false, false].into_iter().enumerate() {
        assert_eq!(marked(&ingest, row, marks::OVERLAP), expected, "row {row}");
    }
}

#[test]
fn largest_record_decodes_expanded_cp437_and_keeps_the_next_record() {
    let first = Entry {
        name: vec![0x82; usize::from(u16::MAX)],
        extra: field(0xcafe, &vec![0; 65_531]),
        comment: vec![0x82; usize::from(u16::MAX)],
        ..Entry::new("")
    };
    let entries = [first, Entry::new("after")];
    let ingest = parsed(&entries, 1);
    let expected = "é".repeat(usize::from(u16::MAX));
    assert_eq!(ingest.store().name(0), expected.as_bytes());
    assert_eq!(ingest.store().comment(0), expected.as_bytes());
    assert_eq!(ingest.store().name(1), b"after");
    assert_eq!(ingest.store().names().chunk_count(), 1);
    assert_eq!(ingest.store().comments().chunk_count(), 1);
}

#[test]
fn depth_boundaries_and_a_64k_path_keep_every_row() {
    assert_eq!(MAX_DEPTH, 256);
    let entries: Vec<_> = [MAX_DEPTH - 1, MAX_DEPTH, MAX_DEPTH + 1, 32_767]
        .into_iter()
        .map(|depth| Entry::new(format!("{}x", "d/".repeat(depth))))
        .collect();
    let ingest = parsed(&entries, 1);
    for (row, expected) in [false, false, true, true].into_iter().enumerate() {
        assert_eq!(
            marked(&ingest, row, marks::DEPTH_CAP),
            expected,
            "row {row}"
        );
        assert_eq!(ingest.tree().is_limited(row), expected);
        assert_eq!(ingest.store().name(row), entries[row].name);
    }
    check_tree(&ingest, MAX_DEPTH + 3);
}

#[test]
fn folder_cap_keeps_new_rows_and_can_reuse_existing_folders() {
    let entries = ["a/b/one", "x/y/two", "a/b/three", "a/c/", "root"].map(Entry::new);
    let bytes = archive(&entries, 5, None).bytes;
    let mut ingest = Ingest::with_folder_limit(bytes.clone(), bytes.len() as u64, 3).unwrap();
    finish(&mut ingest, 1, entries.len());
    assert_eq!(ingest.status(), &Status::Complete);
    assert_eq!(ingest.tree().folder_count(), 3);
    for (row, expected) in [false, true, false, true, false].into_iter().enumerate() {
        assert_eq!(ingest.tree().is_limited(row), expected, "row {row}");
    }
    check_tree(&ingest, 3);
}

#[test]
fn giant_zip64_count_allocates_only_for_the_rows_read() {
    let entries = [Entry::new("one"), Entry::new("two")];
    let mut ingest = open(archive(&entries, u16::MAX, Some(1 << 63)).bytes);
    assert_eq!(ingest.entries_hint(), 1 << 63);
    assert_eq!(ingest.store().page_count(), 0);
    assert_eq!(ingest.store().names().allocated_bytes(), 0);
    assert_eq!(ingest.store().comments().allocated_bytes(), 0);
    assert_eq!(ingest.parse(0), 0);
    assert_eq!(ingest.store().page_count(), 0);
    finish(&mut ingest, 1, 2);
    assert_eq!(ingest.status(), &Status::Complete);
    assert_eq!(ingest.store().page_count(), 1);
    assert_eq!(ingest.store().names().allocated_bytes(), CHUNK_BYTES);
    assert_eq!(ingest.store().comments().allocated_bytes(), 0);
    assert_eq!(ingest.tree().rollup(ROOT).entry_count, 2.0);
}

#[test]
fn health_marks_preserve_raw_names_and_tree_limit_marks() {
    let mut name = b"d/".repeat(MAX_DEPTH + 1);
    name.extend_from_slice(b"bad\xff");
    let entry = Entry {
        flags: 1 << 11,
        compressed: 1,
        size: 16 << 20,
        offset: Some(0),
        ..Entry::new(&name)
    };
    let ingest = parsed(&[entry.clone(), entry], 1);
    for row in 0..2 {
        assert_eq!(ingest.store().raw_name(row), Some(name.as_slice()));
        for bit in [
            marks::RAW_NAME_KEPT,
            marks::DEPTH_CAP,
            marks::BOMB_RATIO,
            marks::OVERLAP,
        ] {
            assert!(marked(&ingest, row, bit), "row {row}: bit {bit}");
        }
    }
    assert!(marked(&ingest, 1, marks::DUPLICATE_NAME));
    check_tree(&ingest, MAX_DEPTH + 1);
}

#[test]
fn a_four_gib_directory_claim_does_not_control_store_allocation() {
    let entries = [Entry::new("one"), Entry::new("two")];
    let mut fixture = archive(&entries, 2, None);
    fixture.bytes[fixture.eocd + 12..fixture.eocd + 16]
        .copy_from_slice(&0xffff_fffe_u32.to_le_bytes());
    let size = fixture.bytes.len() as u64;
    // rawzip can reject the false directory size at open or during parsing.
    if let Ok(mut ingest) = Ingest::open(fixture.bytes, size) {
        finish(&mut ingest, 1, 2);
        assert!(matches!(
            ingest.status(),
            Status::Complete | Status::Failed(_)
        ));
        assert!(ingest.store().page_count() <= 1);
        assert!(ingest.store().names().allocated_bytes() <= CHUNK_BYTES);
        assert_eq!(ingest.store().comments().allocated_bytes(), 0);
        check_tree(&ingest, 1);
    }
}

#[test]
fn overflowing_range_ends_do_not_panic_or_discard_the_valid_prefix() {
    let entries = [
        Entry::new("kept"),
        zip64("overflow-one", 16, 16, u64::MAX - 7),
        zip64("overflow-two", 8, 8, u64::MAX - 3),
    ];
    let mut ingest = open(archive(&entries, 3, None).bytes);
    finish(&mut ingest, 1, 3);
    assert!(matches!(
        ingest.status(),
        Status::Complete | Status::Failed(_)
    ));
    assert!(ingest.store().rows() >= 1);
    assert_eq!(ingest.store().name(0), b"kept");
    assert_eq!(ingest.store().page_count(), 1);
    assert_eq!(ingest.store().names().allocated_bytes(), CHUNK_BYTES);
    assert_eq!(ingest.store().comments().allocated_bytes(), 0);
    check_tree(&ingest, 1);
}
