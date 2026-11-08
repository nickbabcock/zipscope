/*
ASSUMED API
ingest::Ingest<R>::search(&mut self, query: &str)
ingest::Ingest<R>::sort(&mut self, key: view::SortKey, descending: bool)
view::SortKey::{Name, UncompressedSize, CompressedSize, Ratio, Method, Modified}

Use the existing refresh_views() to make a requested view from all parsed
rows. The worker can delay a merge. An explicit refresh must finish it.
Use the existing views().listing() to read the result.

refresh_views() keeps new rows of a
sorted listing waiting, so the worker can merge them in budgeted steps
between batches. Ingest::settle_views() is refresh_views() followed by all
merge steps: it is the "explicit refresh that finishes the merge". The
helper `listing` calls it. view::SortKey is query::SortColumn, with Size
and Compressed for UncompressedSize and CompressedSize. No expected result
changed.

Search is a literal substring of the decoded full name. Fold ASCII case
only. A nonempty query lists entry rows from the whole archive, including
explicit folder rows. An empty query restores the selected folder view.
Sort the filtered rows. Keep the sort when the query changes.

For unequal lowercase ASCII names, use lexical order. Numeric columns use
their stored values. Ratio is compressed size divided by uncompressed
size, as in the table. The tests do not set the order of equal keys,
missing times, zero-size ratios, folders versus files, or method labels.
Each of these values must stay in the permutation exactly once.

The names may change. Record a reason for a change to an expected result.
*/

#[path = "support/zip.rs"]
#[allow(dead_code, reason = "These tests use part of the archive helpers.")]
mod zip;

use std::collections::BTreeSet;
use zip::{Entry, archive, cell, crc32, field, ntfs, open, u64le, unicode_path, ut};
use zipscope_core::contract::{CHUNK_BYTES, Column, FOLDER_TAG};
use zipscope_core::ingest::{Ingest, Status};
use zipscope_core::query::SortColumn as SortKey;
use zipscope_core::tree::ROOT;

fn start(entries: &[Entry]) -> Ingest<Vec<u8>> {
    open(archive(entries, entries.len().try_into().unwrap(), None).bytes)
}

fn parsed(entries: &[Entry]) -> Ingest<Vec<u8>> {
    let mut ingest = start(entries);
    assert_eq!(ingest.parse(u32::MAX) as usize, entries.len());
    assert_eq!(ingest.status(), &Status::Complete);
    ingest
}

fn listing(ingest: &mut Ingest<Vec<u8>>) -> Vec<u32> {
    ingest.settle_views();
    let rows = ingest.views().listing().to_vec();
    assert_eq!(rows.len(), rows.iter().collect::<BTreeSet<_>>().len());
    for &id in &rows {
        if id & FOLDER_TAG == 0 {
            assert!((id as usize) < ingest.store().rows(), "unparsed row {id}");
        } else {
            assert!(((id & !FOLDER_TAG) as usize) < ingest.tree().folders().len());
        }
    }
    rows
}

fn results(ingest: &mut Ingest<Vec<u8>>, query: &str) -> Vec<u32> {
    ingest.search(query);
    let rows = listing(ingest);
    assert!(rows.iter().all(|id| id & FOLDER_TAG == 0));
    rows
}

fn matches(ingest: &mut Ingest<Vec<u8>>, query: &str, expected: &[u32]) {
    let actual: BTreeSet<_> = results(ingest, query).into_iter().collect();
    assert_eq!(
        actual,
        expected.iter().copied().collect(),
        "query {query:?}"
    );
}

fn ordered(ingest: &mut Ingest<Vec<u8>>, key: SortKey, descending: bool) -> Vec<u32> {
    ingest.sort(key, descending);
    listing(ingest)
}

fn file(name: impl AsRef<[u8]>, size: u32, compressed: u32) -> Entry {
    Entry {
        size,
        compressed,
        ..Entry::new(name)
    }
}

fn zip64(name: &str, size: u64, compressed: u64) -> Entry {
    let mut body = Vec::new();
    u64le(&mut body, size);
    u64le(&mut body, compressed);
    Entry {
        size: u32::MAX,
        compressed: u32::MAX,
        extra: field(1, &body),
        ..Entry::new(name)
    }
}

fn snapshot(ingest: &Ingest<Vec<u8>>) -> Vec<(Vec<u8>, Vec<u8>, Vec<u64>)> {
    (0..ingest.store().rows())
        .map(|row| {
            (
                ingest.store().name(row).to_vec(),
                ingest.store().comment(row).to_vec(),
                Column::ALL
                    .iter()
                    .map(|&column| cell(ingest.store(), row, column).to_bits())
                    .collect(),
            )
        })
        .collect()
}

#[test]
fn search_uses_each_decoded_name_source_and_checks_unicode_path_crc() {
    let raw = b"raw-only.txt";
    let mut ingest = parsed(&[
        Entry {
            flags: 0x0800,
            ..Entry::new("UTF8/日本.TXT")
        },
        Entry::new("unflagged/日本.txt"),
        Entry::new(b"cp437/caf\x82.TXT"),
        Entry {
            extra: unicode_path(1, crc32(raw), "override/日本.txt".as_bytes()),
            ..Entry::new(raw)
        },
        Entry {
            extra: unicode_path(1, crc32(b"wrong"), b"override/decoy.txt"),
            ..Entry::new(raw)
        },
        Entry {
            flags: 0x0800,
            ..Entry::new(b"lossy/bad\xff.TXT")
        },
    ]);
    matches(&mut ingest, "日本.TxT", &[0, 1, 3]);
    matches(&mut ingest, "CAFé.txt", &[2]);
    matches(&mut ingest, "override", &[3]);
    matches(&mut ingest, "raw-only", &[4]);
    matches(&mut ingest, "decoy", &[]);
    matches(&mut ingest, "BAD\u{fffd}.txt", &[5]);
}

#[test]
fn search_folds_ascii_only_and_does_not_normalize_unicode() {
    let mut ingest = parsed(&[
        Entry::new("Ä/FILE.txt"),
        Entry::new("ä/file.txt"),
        Entry::new("Straße.txt"),
        Entry::new("STRASSE.txt"),
        Entry::new("é.txt"),
        Entry::new("e\u{301}.txt"),
        Entry::new("Σ.txt"),
        Entry::new("σ.txt"),
    ]);
    matches(&mut ingest, "Ä/file.TXT", &[0]);
    matches(&mut ingest, "ä/FILE", &[1]);
    matches(&mut ingest, "strasse", &[3]);
    matches(&mut ingest, "STRAßE", &[2]);
    matches(&mut ingest, "é", &[4]);
    matches(&mut ingest, "e\u{301}", &[5]);
    matches(&mut ingest, "Σ", &[6]);
    matches(&mut ingest, "σ", &[7]);
}

#[test]
fn ascii_case_folding_does_not_change_punctuation_or_del() {
    let mut ingest = parsed(&[Entry::new("@A[Z]\\^_"), Entry::new("`a{z}|~\u{7f}")]);
    matches(&mut ingest, "@a[z]\\^_", &[0]);
    matches(&mut ingest, "`A{Z}|~\u{7f}", &[1]);
    matches(&mut ingest, "{", &[1]);
    matches(&mut ingest, "[", &[0]);
    matches(&mut ingest, "_", &[0]);
    matches(&mut ingest, "\u{7f}", &[1]);
}

#[test]
fn search_is_literal_and_keeps_nul_spaces_and_unsafe_paths() {
    let mut ingest = parsed(&[
        Entry::new("[a].*?.txt"),
        Entry::new("aZZ.txt"),
        Entry::new(" before after "),
        Entry::new(b"left\0RIGHT.txt"),
        Entry::new("../parent/needle"),
        Entry::new("/absolute/needle"),
        Entry::new("C:\\drive\\needle"),
        Entry::new(""),
    ]);
    matches(&mut ingest, "[a].*?", &[0]);
    matches(&mut ingest, " before ", &[2]);
    matches(&mut ingest, "RIGHT.txt", &[3]);
    matches(&mut ingest, "\0right", &[3]);
    matches(&mut ingest, "needle", &[4, 5, 6]);
    matches(&mut ingest, " ", &[2]);
    matches(&mut ingest, "does not exist", &[]);
    assert!(ingest.list(ROOT));
    ingest.search("");
    assert!(listing(&mut ingest).contains(&7));
}

#[test]
fn search_does_not_join_names_or_read_comments_and_extra_fields() {
    let mut ingest = parsed(&[
        Entry {
            comment: b"needle".to_vec(),
            extra: field(0xcafe, b"needle"),
            ..Entry::new("left-END")
        },
        Entry::new("START-right"),
        Entry::new("last/needle"),
    ]);
    matches(&mut ingest, "ENDSTART", &[]);
    matches(&mut ingest, "needle", &[2]);
    matches(&mut ingest, "rightlast", &[]);
    matches(&mut ingest, &"x".repeat(70_000), &[]);
}

#[test]
fn search_includes_explicit_folder_rows_duplicates_and_other_folders() {
    let mut ingest = parsed(&[
        Entry::new("selected/other"),
        Entry::new("hidden/needle/"),
        Entry::new("hidden/needle/child"),
        Entry::new("hidden/needle/"),
        Entry::new("needle"),
        Entry::new("needle"),
    ]);
    let selected = ingest
        .tree()
        .folders()
        .iter()
        .position(|node| node.explicit_row == u32::MAX && node.parent == ROOT)
        .unwrap();
    assert!(ingest.list(u32::try_from(selected).unwrap()));
    matches(&mut ingest, "needle", &[1, 2, 3, 4, 5]);
}

#[test]
fn search_updates_the_prefix_and_replaces_queries_between_batches() {
    let entries = [
        Entry::new("a/old-hit"),
        Entry::new("b/new-hit"),
        Entry::new("a/old-again"),
        Entry::new("b/new-again"),
        Entry::new("a/final-new"),
    ];
    let mut ingest = start(&entries);
    matches(&mut ingest, "old", &[]);
    assert_eq!(ingest.parse(1), 1);
    assert_eq!(listing(&mut ingest), [0]);
    assert_eq!(ingest.parse(1), 1);
    matches(&mut ingest, "new", &[1]);
    assert_eq!(ingest.parse(2), 2);
    assert_eq!(
        listing(&mut ingest).into_iter().collect::<BTreeSet<_>>(),
        BTreeSet::from([1, 3])
    );
    matches(&mut ingest, "absent", &[]);
    assert_eq!(ingest.parse(1), 1);
    assert_eq!(listing(&mut ingest), Vec::<u32>::new());
    matches(&mut ingest, "NEW", &[1, 3, 4]);
    assert_eq!(ingest.parse(1), 0);
    assert_eq!(ingest.status(), &Status::Complete);
    matches(&mut ingest, "old", &[0, 2]);
}

#[test]
fn clearing_search_restores_the_selected_folder_and_sort() {
    let mut ingest = parsed(&[
        Entry::new("chosen/z.txt"),
        Entry::new("chosen/a.txt"),
        Entry::new("elsewhere/zz.txt"),
    ]);
    let chosen = ingest
        .tree()
        .folders()
        .iter()
        .position(|node| node.parent == ROOT)
        .unwrap();
    assert!(ingest.list(u32::try_from(chosen).unwrap()));
    ingest.sort(SortKey::Name, false);
    matches(&mut ingest, ".txt", &[0, 1, 2]);
    matches(&mut ingest, "absent", &[]);
    ingest.search("");
    assert_eq!(listing(&mut ingest), [1, 0]);
    matches(&mut ingest, ".TXT", &[0, 1, 2]);
    assert_eq!(listing(&mut ingest), [1, 0, 2]);
}

#[test]
fn name_sort_uses_decoded_names_and_does_not_move_store_rows() {
    let mut ingest = parsed(&[
        Entry {
            extra: unicode_path(1, crc32(b"aaa"), b"zulu"),
            comment: b"first".to_vec(),
            ..Entry::new("aaa")
        },
        Entry {
            extra: unicode_path(1, crc32(b"zzz"), b"alpha"),
            ..Entry::new("zzz")
        },
        Entry::new("middle"),
    ]);
    let before = snapshot(&ingest);
    matches(&mut ingest, "a", &[1]);
    ingest.search("");
    assert_eq!(ordered(&mut ingest, SortKey::Name, false), [1, 2, 0]);
    assert_eq!(ordered(&mut ingest, SortKey::Name, true), [0, 2, 1]);
    for query in ["alpha", "absent", "zulu", ""] {
        ingest.search(query);
        listing(&mut ingest);
    }
    assert_eq!(snapshot(&ingest), before);
}

#[test]
fn numeric_sort_keeps_zip64_values_above_u32_and_adjacent_integers() {
    let mut ingest = parsed(&[
        zip64("same", (1 << 40) + 2, (1 << 39) + 1),
        zip64("same", (1 << 40) + 1, (1 << 39) + 3),
        file("same", 9, 10),
        zip64("same", (1 << 53) - 1, (1 << 53) - 2),
        zip64("same", 1 << 32, (1 << 39) + 2),
    ]);
    assert_eq!(ordered(&mut ingest, SortKey::Size, false), [2, 4, 1, 0, 3]);
    assert_eq!(ordered(&mut ingest, SortKey::Size, true), [3, 0, 1, 4, 2]);
    assert_eq!(
        ordered(&mut ingest, SortKey::Compressed, false),
        [2, 0, 4, 1, 3]
    );
    assert_eq!(
        ordered(&mut ingest, SortKey::Compressed, true),
        [3, 1, 4, 0, 2]
    );
}

#[test]
fn ratio_sort_uses_numeric_fractions_and_keeps_zero_size_rows() {
    let mut ingest = parsed(&[
        file("same", 100, 90),
        file("same", 10_000, 1),
        file("same", 100, 120),
        file("same", 1000, 100),
        file("same", 0, 0),
        file("same", 0, 1),
    ]);
    for descending in [false, true] {
        let rows = ordered(&mut ingest, SortKey::Ratio, descending);
        assert_eq!(
            rows.iter().copied().collect::<BTreeSet<_>>(),
            (0..6).collect()
        );
        let finite: Vec<_> = rows.into_iter().filter(|&id| id < 4).collect();
        assert_eq!(
            finite,
            if descending {
                vec![2, 0, 3, 1]
            } else {
                vec![1, 3, 0, 2]
            }
        );
    }
}

#[test]
fn modified_sort_uses_preferred_timestamps_and_keeps_missing_times() {
    let mut ingest = parsed(&[
        Entry {
            extra: ut(1_600_000_003),
            ..Entry::new("same")
        },
        Entry {
            extra: ntfs(1_600_000_001_123),
            ..Entry::new("same")
        },
        Entry {
            extra: ut(1_600_000_002),
            date: 0x0021,
            ..Entry::new("same")
        },
        Entry::new("same"),
    ]);
    for descending in [false, true] {
        let rows = ordered(&mut ingest, SortKey::Modified, descending);
        assert_eq!(
            rows.iter().copied().collect::<BTreeSet<_>>(),
            (0..4).collect()
        );
        let dated: Vec<_> = rows.into_iter().filter(|&id| id != 3).collect();
        assert_eq!(
            dated,
            if descending {
                vec![0, 2, 1]
            } else {
                vec![1, 2, 0]
            }
        );
    }
}

#[test]
fn method_sort_handles_unknown_and_aes_methods_in_both_directions() {
    let mut ingest = parsed(&[
        Entry {
            method: 65_535,
            ..Entry::new("same")
        },
        Entry {
            method: 8,
            ..Entry::new("same")
        },
        Entry {
            method: 99,
            extra: zip::aes(2, 3, 93),
            ..Entry::new("same")
        },
        Entry::new("same"),
    ]);
    let ascending = ordered(&mut ingest, SortKey::Method, false);
    let descending = ordered(&mut ingest, SortKey::Method, true);
    assert_eq!(ascending.len(), 4);
    assert_eq!(descending.len(), 4);
    assert_eq!(ascending.into_iter().rev().collect::<Vec<_>>(), descending);
}

#[test]
fn batch_merges_keep_equal_keys_duplicate_rows_and_overlapping_offsets() {
    let entries: Vec<_> = (0..513)
        .map(|i| Entry {
            offset: Some(0),
            ..file(format!("dir/item-{:03}", (i * 73) % 47), (i % 7) + 1, 1)
        })
        .collect();
    let mut ingest = start(&entries);
    ingest.search("item");
    ingest.sort(SortKey::Size, true);
    for batch in [1, 7, 31, 2, 64, 3, 101, 304] {
        ingest.parse(batch);
        let rows = listing(&mut ingest);
        assert_eq!(rows.len(), ingest.store().rows());
        assert_eq!(
            rows.iter().copied().collect::<BTreeSet<_>>(),
            (0..u32::try_from(rows.len()).unwrap()).collect()
        );
        let sizes: Vec<_> = rows
            .iter()
            .map(|&id| cell(ingest.store(), id as usize, Column::UncompressedSize))
            .collect();
        assert!(sizes.windows(2).all(|pair| pair[0] >= pair[1]));
    }
    ingest.parse(u32::MAX);
    assert_eq!(ingest.status(), &Status::Complete);
    assert_eq!(listing(&mut ingest).len(), 513);
}

#[test]
fn sort_changes_during_parse_replace_pending_order_and_finish_the_tail() {
    let mut ingest = start(&[
        file("z-hit", 20, 3),
        file("a-hit", 30, 1),
        file("m-miss", 10, 2),
        file("b-hit", 40, 5),
        file("y-hit", 5, 4),
    ]);
    ingest.parse(2);
    ingest.search("hit");
    assert_eq!(ordered(&mut ingest, SortKey::Name, false), [1, 0]);
    ingest.parse(2);
    assert_eq!(ordered(&mut ingest, SortKey::Size, true), [3, 1, 0]);
    ingest.parse(1);
    assert_eq!(ordered(&mut ingest, SortKey::Name, true), [0, 4, 3, 1]);
    assert_eq!(ingest.parse(1), 0);
    assert_eq!(ingest.status(), &Status::Complete);
    assert_eq!(listing(&mut ingest), [0, 4, 3, 1]);
    matches(&mut ingest, "miss", &[2]);
    matches(&mut ingest, "hit", &[0, 1, 3, 4]);
    assert_eq!(listing(&mut ingest), [0, 4, 3, 1]);
}

#[test]
fn folder_size_sort_tracks_late_rollups_and_search_uses_entry_sizes() {
    let mut ingest = start(&[
        file("a/first", 1, 1),
        file("b/first", 5, 2),
        file("a/late", 10, 9),
    ]);
    ingest.parse(2);
    assert!(ingest.list(ROOT));
    let a = 1 | FOLDER_TAG;
    let b = 2 | FOLDER_TAG;
    assert_eq!(ordered(&mut ingest, SortKey::Size, false), [a, b]);
    ingest.parse(1);
    assert_eq!(listing(&mut ingest), [b, a]);
    assert_eq!(ordered(&mut ingest, SortKey::Compressed, false), [b, a]);
    ingest.search("/");
    assert_eq!(ordered(&mut ingest, SortKey::Size, false), [0, 1, 2]);
    assert_eq!(ingest.listing_largest(), 10.0);
}

#[test]
fn terminal_error_keeps_a_searchable_sorted_prefix_and_ignores_the_tail() {
    let entries = [
        Entry::new("z-hit"),
        Entry::new("a-hit"),
        Entry::new("bad-hit"),
        Entry::new("tail-hit"),
    ];
    let mut fixture = archive(&entries, 4, None);
    fixture.bytes[fixture.records[2]] = b'X';
    let mut ingest = open(fixture.bytes);
    ingest.search("hit");
    ingest.sort(SortKey::Name, false);
    assert_eq!(ingest.parse(u32::MAX), 2);
    assert!(matches!(ingest.status(), Status::Failed(_)));
    assert_eq!(listing(&mut ingest), [1, 0]);
    matches(&mut ingest, "tail", &[]);
    matches(&mut ingest, "hit", &[0, 1]);
    assert_eq!(ordered(&mut ingest, SortKey::Name, true), [0, 1]);
    assert_eq!(ingest.parse(10), 0);
    assert_eq!(listing(&mut ingest), [0, 1]);
}

#[test]
fn false_eocd_counts_do_not_create_phantom_search_or_sort_rows() {
    let entries = [
        Entry::new("z-hit"),
        Entry::new("a-hit"),
        Entry::new("m-hit"),
    ];
    for (hint, zip64_hint) in [(0, None), (1, None), (65_535, Some(1u64 << 63))] {
        let mut ingest = open(archive(&entries, hint, zip64_hint).bytes);
        matches(&mut ingest, "hit", &[]);
        ingest.sort(SortKey::Name, false);
        assert_eq!(ingest.parse(u32::MAX), 3);
        assert_eq!(ingest.status(), &Status::Complete);
        assert_eq!(listing(&mut ingest), [1, 2, 0]);
    }
}

#[test]
fn depth_and_folder_caps_do_not_limit_global_search() {
    let deep = format!("{}needle", "d/".repeat(300));
    let entries = [
        Entry::new(deep),
        Entry::new("other/needle"),
        Entry::new("third/needle"),
    ];
    let bytes = archive(&entries, 3, None).bytes;
    let size = bytes.len() as u64;
    let mut ingest = Ingest::with_folder_limit(bytes, size, 3).unwrap();
    ingest.search("needle");
    ingest.sort(SortKey::Name, false);
    for expected in 1..=3 {
        assert_eq!(ingest.parse(1), 1);
        assert_eq!(listing(&mut ingest).len(), expected);
    }
    matches(&mut ingest, "needle", &[0, 1, 2]);
    assert!(ingest.tree().folders().len() <= 3);
}

#[test]
fn maximum_record_and_name_chunk_boundary_keep_search_within_slices() {
    let mut long = vec![b'x'; 65_535];
    long[65_529..].copy_from_slice(b"NEEDLE");
    let count = CHUNK_BYTES / long.len() + 1;
    let mut entries = vec![Entry::new(&long); count];
    entries[0].extra = field(0xcafe, &vec![b'e'; 65_531]);
    entries[0].comment = vec![b'c'; 65_535];
    entries.push(Entry::new("after/needle"));
    let mut ingest = start(&entries);
    ingest.search("needle");
    ingest.sort(SortKey::Name, false);
    while ingest.status() == &Status::Parsing {
        ingest.parse(7);
        assert_eq!(listing(&mut ingest).len(), ingest.store().rows());
    }
    assert_eq!(ingest.status(), &Status::Complete);
    assert!(ingest.store().names().chunk_count() >= 2);
    assert_eq!(results(&mut ingest, "needle").len(), entries.len());
    matches(&mut ingest, "NEEDLEx", &[]);
    matches(&mut ingest, "needleafter", &[]);
    matches(&mut ingest, "cccc", &[]);
}

#[test]
fn empty_archive_and_equal_keys_keep_valid_permutations_for_every_column() {
    for entries in [vec![], vec![Entry::new("")], vec![Entry::new("same"); 9]] {
        let mut ingest = parsed(&entries);
        assert!(ingest.list(ROOT));
        for key in [
            SortKey::Name,
            SortKey::Size,
            SortKey::Compressed,
            SortKey::Ratio,
            SortKey::Method,
            SortKey::Modified,
        ] {
            ingest.sort(key, true);
            let actual: BTreeSet<_> = listing(&mut ingest).into_iter().collect();
            assert_eq!(actual, (0..u32::try_from(entries.len()).unwrap()).collect());
            matches(&mut ingest, "absent", &[]);
            ingest.search("");
            assert_eq!(
                listing(&mut ingest).into_iter().collect::<BTreeSet<_>>(),
                actual
            );
        }
    }
}

#[test]
fn a_late_explicit_folder_row_joins_search_without_a_folder_tag() {
    let mut ingest = start(&[
        Entry::new("needle/child"),
        Entry::new("needle/"),
        Entry::new("needle/"),
    ]);
    ingest.search("needle");
    ingest.sort(SortKey::Name, false);
    for count in 1..=3 {
        assert_eq!(ingest.parse(1), 1);
        let rows = listing(&mut ingest);
        assert_eq!(
            rows.iter().copied().collect::<BTreeSet<_>>(),
            (0..count).collect()
        );
        assert!(rows.iter().all(|id| id & FOLDER_TAG == 0));
    }
    let rows = listing(&mut ingest);
    assert_eq!(rows.last(), Some(&0));
}
