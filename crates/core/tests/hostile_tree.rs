/*
ASSUMED API
ingest::Ingest<R>::tree(&self) -> &tree::Tree
ingest::Ingest<R>::with_folder_limit(reader: R, size: u64, max_folders: usize)
    -> Result<Self, rawzip::Error>
tree::Tree::folders(&self) -> &[tree::Folder]
tree::Tree::rollup(&self, folder: u32) -> tree::Rollup
tree::Tree::children(&self, folder: u32) -> Vec<u32>
tree::Tree::compact_end(&self, folder: u32) -> u32
tree::Tree::is_limited(&self, row: usize) -> bool
tree::Folder: name_offset: u32, name_length: u32, parent: u32, explicit_row: u32
tree::Rollup: uncompressed_size: f64, compressed_size: f64, entry_count: f64

Use folder id 0 for the archive root. Use 0xffffffff for absent rows and
the root parent. children gives direct children before chain compaction.
compact_end gives the last folder in a chain, also for the root. A direct
file stops the chain. Explicit folder rows do not stop it.

Rollups count each central-directory row once, including folder rows.
A folder includes its explicit row. Keep duplicate rows in the totals.
An explicit folder row is represented by its folder tag, not a file tag.
For repeated explicit folder entries, keep the first explicit_row and
list the other rows as entries in that folder. This keeps each row visible.

Skip empty path components. Keep dot components, NUL and drive prefixes
as inspection data. Do not apply extraction path rules to the tree.
The depth limit is 256 folders, without the archive root. Fold excess
folder components into the last folder name. Keep the final file row.
The folder limit includes the root. Keep rows and root totals at a limit;
attach a row to the nearest folder that fits. is_limited flags each row
that needs either limit. Depth also sets marks bit 1. The low folder limit
is a test input, so no test needs millions of nodes or a memory budget.

These are test access methods, not a new shared-memory layout. The names
may change. Record a reason for any change to an expected result.
*/

#[path = "support/tree.rs"]
mod tree;
#[path = "support/zip.rs"]
#[allow(
    dead_code,
    reason = "These tests use only part of the archive helpers."
)]
mod zip;

use std::collections::BTreeSet;
use tree::*;
use zip::{archive, cell_u32, crc32, field, open, unicode_path};
use zipscope_core::contract::{Column, marks};
use zipscope_core::ingest::{Ingest, Status};

#[test]
fn empty_archive_has_only_a_zero_root() {
    let ingest = parsed(&[]);
    assert_eq!(ingest.tree().folders().len(), 1);
    assert!(children(&ingest, ROOT).is_empty());
    assert_eq!(totals(&ingest, ROOT), [0.0; 3]);
    assert_eq!(ingest.tree().compact_end(ROOT), ROOT);
    check(&ingest);
}

#[test]
fn implied_folders_and_mixed_children_use_tagged_ids() {
    let ingest = parsed(&[
        file("pkg/src/a", 11, 3),
        file("pkg/src/b", 17, 5),
        file("pkg/top", 23, 7),
        file("loose", 29, 9),
    ]);
    let pkg = folder(&ingest, "pkg");
    let src = folder(&ingest, "pkg/src");
    assert_eq!(ingest.tree().folders().len(), 3);
    assert_eq!(ingest.tree().folders()[pkg as usize].explicit_row, NONE);
    assert_eq!(ingest.tree().folders()[src as usize].explicit_row, NONE);
    assert_eq!(children(&ingest, ROOT), BTreeSet::from([FOLDER | pkg, 3]));
    assert_eq!(children(&ingest, pkg), BTreeSet::from([FOLDER | src, 2]));
    assert_eq!(children(&ingest, src), BTreeSet::from([0, 1]));
    assert_eq!(totals(&ingest, src), [28.0, 8.0, 2.0]);
    assert_eq!(totals(&ingest, pkg), [51.0, 15.0, 3.0]);
    assert_eq!(totals(&ingest, ROOT), [80.0, 24.0, 4.0]);
    check(&ingest);
}

#[test]
fn late_explicit_folders_reuse_ids_slices_and_rollups() {
    let mut ingest = start(&[
        file("a/b/file", 13, 5),
        file("a/", 0, 0),
        file("a/b/", 0, 0),
    ]);
    assert_eq!(ingest.parse(1), 1);
    let a = folder(&ingest, "a");
    let b = folder(&ingest, "a/b");
    let slice = |id: u32| {
        let node = &ingest.tree().folders()[id as usize];
        (node.name_offset, node.name_length, node.parent)
    };
    let before = [slice(a), slice(b)];
    assert_eq!(totals(&ingest, ROOT), [13.0, 5.0, 1.0]);
    check(&ingest);
    finish(&mut ingest, 1);
    assert_eq!(ingest.tree().folders().len(), 3);
    for (id, expected) in [a, b].into_iter().zip(before) {
        let node = &ingest.tree().folders()[id as usize];
        assert_eq!((node.name_offset, node.name_length, node.parent), expected);
    }
    assert_eq!(ingest.tree().folders()[a as usize].explicit_row, 1);
    assert_eq!(ingest.tree().folders()[b as usize].explicit_row, 2);
    assert_eq!(totals(&ingest, b), [13.0, 5.0, 2.0]);
    assert_eq!(totals(&ingest, a), [13.0, 5.0, 3.0]);
    assert_eq!(children(&ingest, b), BTreeSet::from([0]));
    check(&ingest);
}

#[test]
fn explicit_folders_before_children_do_not_count_twice() {
    let ingest = parsed(&[
        file("a/", 7, 9),
        file("a/b/", 11, 13),
        file("a/b/file", 17, 19),
    ]);
    let a = folder(&ingest, "a");
    let b = folder(&ingest, "a/b");
    assert_eq!(totals(&ingest, b), [28.0, 32.0, 2.0]);
    assert_eq!(totals(&ingest, a), [35.0, 41.0, 3.0]);
    assert_eq!(totals(&ingest, ROOT), [35.0, 41.0, 3.0]);
    assert_eq!(children(&ingest, ROOT), BTreeSet::from([FOLDER | a]));
    assert_eq!(ingest.tree().compact_end(ROOT), b);
    check(&ingest);
}

#[test]
fn duplicates_and_file_folder_collisions_keep_all_rows() {
    let ingest = parsed(&[
        file("same", 2, 3),
        file("same/child", 5, 7),
        file("same", 11, 13),
        file("same/child", 17, 19),
        file("same/", 0, 0),
        file("same/", 0, 0),
    ]);
    let same = folder(&ingest, "same");
    assert_eq!(ingest.tree().folders().len(), 2);
    assert_eq!(ingest.tree().folders()[same as usize].explicit_row, 4);
    assert_eq!(
        children(&ingest, ROOT),
        BTreeSet::from([0, 2, FOLDER | same])
    );
    assert_eq!(children(&ingest, same), BTreeSet::from([1, 3, 5]));
    assert_eq!(totals(&ingest, same), [22.0, 26.0, 4.0]);
    assert_eq!(totals(&ingest, ROOT), [35.0, 42.0, 6.0]);
    assert_eq!(ingest.tree().compact_end(ROOT), ROOT);
    check(&ingest);
}

#[test]
fn overlapping_data_claims_do_not_merge_rows_or_rollups() {
    let mut entries = [
        file("left/one", 101, 200),
        file("right/two", 103, 200),
        file("left/three", 107, 200),
    ];
    for entry in &mut entries {
        entry.offset = Some(0);
    }
    let ingest = parsed(&entries);
    assert_eq!(totals(&ingest, ROOT), [311.0, 600.0, 3.0]);
    let left = folder(&ingest, "left");
    let right = folder(&ingest, "right");
    assert_eq!(children(&ingest, left), BTreeSet::from([0, 2]));
    assert_eq!(children(&ingest, right), BTreeSet::from([1]));
    assert_eq!(totals(&ingest, left), [208.0, 400.0, 2.0]);
    assert_eq!(totals(&ingest, right), [103.0, 200.0, 1.0]);
    check(&ingest);
}

#[test]
fn mixed_separators_share_folders_without_changing_stored_names() {
    let entries = [
        file(b"pkg\\src/one", 2, 1),
        file(b"pkg/src\\two", 3, 1),
        file(b"pkg\\src\\", 0, 0),
        file(b"pkg/three", 5, 2),
    ];
    let ingest = parsed(&entries);
    let pkg = folder(&ingest, "pkg");
    let src = folder(&ingest, "pkg/src");
    assert_eq!(ingest.tree().folders().len(), 3);
    assert_eq!(ingest.tree().folders()[src as usize].explicit_row, 2);
    assert_eq!(children(&ingest, src), BTreeSet::from([0, 1]));
    assert_eq!(totals(&ingest, pkg), [10.0, 4.0, 4.0]);
    for (row, entry) in entries.iter().enumerate() {
        assert_eq!(ingest.store().name(row), entry.name);
    }
    check(&ingest);
}

#[test]
fn decoded_names_define_the_tree_and_utf8_byte_slices() {
    let cp437 = file(b"caf\x82/\x8e/one", 2, 1);
    let mut unicode = file("raw/no/folders", 3, 1);
    unicode.extra = unicode_path(1, crc32(&unicode.name), "café/Ä/猫".as_bytes());
    let mut wrong_crc = file("raw/leaf", 5, 1);
    wrong_crc.extra = unicode_path(1, 0, b"decoy/deep/leaf");
    let ingest = parsed(&[cp437, unicode, wrong_crc, file("café/Ä/two", 7, 1)]);
    let cafe = folder(&ingest, "café");
    let child = folder(&ingest, "café/Ä");
    assert_eq!(ingest.tree().folders().len(), 4);
    assert_eq!(ingest.tree().folders()[cafe as usize].name_length, 5);
    assert_eq!(ingest.tree().folders()[child as usize].name_length, 2);
    assert_eq!(children(&ingest, child), BTreeSet::from([0, 1, 3]));
    assert_eq!(totals(&ingest, cafe), [12.0, 3.0, 3.0]);
    assert_eq!(
        children(&ingest, folder(&ingest, "raw")),
        BTreeSet::from([2])
    );
    check(&ingest);
}

#[test]
fn folder_keys_use_full_parent_identity_and_exact_case() {
    let ingest = parsed(&[
        file("left/src/one", 2, 1),
        file("right/src/two", 3, 1),
        file("Left/src/three", 5, 1),
        file("left/SRC/four", 7, 1),
        file("left/srcx/five", 11, 1),
        file("é/x", 13, 1),
        file("e\u{301}/y", 17, 1),
    ]);
    let expected = [
        ("left/src", 0, 2.0),
        ("right/src", 1, 3.0),
        ("Left/src", 2, 5.0),
        ("left/SRC", 3, 7.0),
        ("left/srcx", 4, 11.0),
        ("é", 5, 13.0),
        ("e\u{301}", 6, 17.0),
    ];
    for (name, row, size) in expected {
        let id = folder(&ingest, name);
        assert_eq!(children(&ingest, id), BTreeSet::from([row]));
        assert_eq!(totals(&ingest, id), [size, 1.0, 1.0]);
    }
    check(&ingest);
}

#[test]
fn folder_slices_survive_name_arena_growth_and_decoding_expansion() {
    let entries: Vec<_> = (0..24)
        .map(|i| {
            let mut name = format!("dir-{i:02}/").into_bytes();
            name.resize(u16::MAX as usize, 0xdb);
            file(name, 1, 1)
        })
        .collect();
    let mut ingest = start(&entries);
    ingest.parse(1);
    let first = folder(&ingest, "dir-00");
    let node = &ingest.tree().folders()[first as usize];
    let before = (node.name_offset, node.name_length);
    let pointer = ingest.store().names().chunk(0).as_ptr();
    finish(&mut ingest, 5);
    assert!(ingest.store().names().chunk_count() > 1);
    assert_eq!(ingest.store().names().chunk(0).as_ptr(), pointer);
    let node = &ingest.tree().folders()[first as usize];
    assert_eq!((node.name_offset, node.name_length), before);
    let last = folder(&ingest, "dir-23");
    assert!(ingest.tree().folders()[last as usize].name_offset >> 22 > 0);
    assert_eq!(children(&ingest, last), BTreeSet::from([23]));
    assert_eq!(totals(&ingest, ROOT), [24.0, 24.0, 24.0]);
    check(&ingest);
}

#[test]
fn entry_order_and_batch_size_do_not_change_paths_or_totals() {
    let entries = [
        file("a/b/one", 2, 1),
        file("a/", 0, 0),
        file("a/b/", 0, 0),
        file("a/b/two", 3, 1),
        file("a/c/three", 5, 2),
        file("loose", 7, 3),
    ];
    for order in [[0, 1, 2, 3, 4, 5], [5, 4, 3, 2, 1, 0], [2, 0, 5, 4, 1, 3]] {
        for batch in [1, 2, 7] {
            let ordered: Vec<_> = order.iter().map(|&i| entries[i].clone()).collect();
            let mut ingest = start(&ordered);
            finish(&mut ingest, batch);
            assert_eq!(ingest.tree().folders().len(), 4);
            for (name, expected) in [
                ("", [17.0, 7.0, 6.0]),
                ("a", [10.0, 4.0, 5.0]),
                ("a/b", [5.0, 2.0, 3.0]),
                ("a/c", [5.0, 2.0, 1.0]),
            ] {
                assert_eq!(totals(&ingest, folder(&ingest, name)), expected);
            }
            check(&ingest);
        }
    }
}

#[test]
fn inspection_keeps_dot_drive_nul_and_markup_components() {
    let names = [
        "../outside/file",
        "a/../b/file",
        "./dot/file",
        "C:\\drive\\file",
        "nul\0dir/file",
        "<img src=x>/עברית/\u{202e}file",
    ];
    let entries: Vec<_> = names.iter().map(|name| file(name, 1, 1)).collect();
    let ingest = parsed(&entries);
    for (row, parent) in [
        "../outside",
        "a/../b",
        "./dot",
        "C:/drive",
        "nul\0dir",
        "<img src=x>/עברית",
    ]
    .into_iter()
    .enumerate()
    {
        assert_eq!(
            children(&ingest, folder(&ingest, parent)),
            BTreeSet::from([u32::try_from(row).unwrap()])
        );
        assert_eq!(ingest.store().name(row), names[row].as_bytes());
    }
    check(&ingest);
}

#[test]
fn empty_components_do_not_create_empty_folders_or_cycles() {
    let ingest = parsed(&[
        file("", 2, 1),
        file("/", 0, 0),
        file("\\", 0, 0),
        file("//a///b//file", 3, 1),
        file("a\\\\b\\other", 5, 1),
    ]);
    assert_eq!(ingest.tree().folders().len(), 3);
    let a = folder(&ingest, "a");
    let b = folder(&ingest, "a/b");
    assert_eq!(
        children(&ingest, ROOT),
        BTreeSet::from([0, 1, 2, FOLDER | a])
    );
    assert_eq!(children(&ingest, b), BTreeSet::from([3, 4]));
    assert_eq!(totals(&ingest, ROOT), [10.0, 3.0, 5.0]);
    check(&ingest);
}

#[test]
fn each_batch_has_exact_prefix_rollups_and_no_future_nodes() {
    let entries: Vec<_> = (0..97)
        .map(|i| file(format!("group-{}/nested/file-{i}", i % 7), i + 1, i % 5))
        .collect();
    let mut ingest = start(&entries);
    let mut count = 0;
    for _ in 0..=entries.len() {
        if ingest.status() != &Status::Parsing {
            break;
        }
        let added = ingest.parse(4) as usize;
        count += added;
        assert_eq!(ingest.store().rows(), count);
        assert_eq!(ingest.tree().folders().len(), 1 + 2 * count.min(7));
        let sum = entries[..count].iter().fold([0.0; 3], |mut total, row| {
            total[0] += f64::from(row.size);
            total[1] += f64::from(row.compressed);
            total[2] += 1.0;
            total
        });
        assert_eq!(totals(&ingest, ROOT), sum);
        check(&ingest);
    }
    assert_eq!(count, entries.len());
    assert_eq!(ingest.status(), &Status::Complete);
    let before = totals(&ingest, ROOT);
    assert_eq!(ingest.parse(0), 0);
    assert_eq!(ingest.parse(u32::MAX), 0);
    assert_eq!(totals(&ingest, ROOT), before);
}

#[test]
fn zero_batch_does_not_create_folders_or_rollups_for_unread_rows() {
    let mut ingest = start(&[file("not/read/yet", 100, 80)]);
    assert_eq!(ingest.parse(0), 0);
    assert_eq!(ingest.status(), &Status::Parsing);
    assert_eq!(ingest.tree().folders().len(), 1);
    assert_eq!(totals(&ingest, ROOT), [0.0; 3]);
    check(&ingest);
}

#[test]
fn compact_chain_splits_when_a_late_sibling_or_file_arrives() {
    let mut ingest = start(&[
        file("project/src/main/one", 2, 1),
        file("project/src/test/two", 3, 1),
        file("project/README", 5, 1),
        file("loose", 7, 1),
    ]);
    ingest.parse(1);
    let project = folder(&ingest, "project");
    let src = folder(&ingest, "project/src");
    let main = folder(&ingest, "project/src/main");
    assert_eq!(ingest.tree().compact_end(ROOT), main);
    ingest.parse(1);
    assert_eq!(ingest.tree().compact_end(ROOT), src);
    assert_eq!(ingest.tree().compact_end(main), main);
    ingest.parse(1);
    assert_eq!(ingest.tree().compact_end(ROOT), project);
    ingest.parse(1);
    assert_eq!(ingest.tree().compact_end(ROOT), ROOT);
    finish(&mut ingest, 1);
    check(&ingest);
}

#[test]
fn zip64_rollups_use_f64_without_u32_wrap_or_compressed_clamps() {
    let ingest = parsed(&[
        zip64_file("a/big", (1 << 40) + 7, (1 << 39) + 3),
        zip64_file("a/other", (1 << 32) + 11, (1 << 40) + 5),
        file("zero", 0, 19),
    ]);
    #[expect(
        clippy::cast_precision_loss,
        reason = "The sums are below 2^53, so f64 holds them exactly."
    )]
    let (size, compressed) = (
        ((1u64 << 40) + (1u64 << 32) + 18) as f64,
        ((1u64 << 39) + (1u64 << 40) + 8) as f64,
    );
    assert_eq!(
        totals(&ingest, folder(&ingest, "a")),
        [size, compressed, 2.0]
    );
    assert_eq!(totals(&ingest, ROOT), [size, compressed + 19.0, 3.0]);
    check(&ingest);
}

#[test]
fn zero_sizes_and_growing_entries_keep_finite_totals() {
    let ingest = parsed(&[
        file("empty/", 0, 0),
        file("zeros/a", 0, 0),
        file("zeros/b", 0, 3),
        file("grown/a", 2, 7),
    ]);
    assert_eq!(totals(&ingest, folder(&ingest, "empty")), [0.0, 0.0, 1.0]);
    assert_eq!(totals(&ingest, folder(&ingest, "zeros")), [0.0, 3.0, 2.0]);
    assert_eq!(totals(&ingest, ROOT), [2.0, 10.0, 4.0]);
    check(&ingest);
}

#[test]
fn depth_boundary_folds_only_excess_components_and_marks_rows() {
    for levels in [255, 256, 257, 1024] {
        let name = format!("{}leaf", "d/".repeat(levels));
        let ingest = parsed(&[file(&name, 7, 3)]);
        assert_eq!(ingest.tree().folders().len(), 1 + levels.min(256));
        assert_eq!(ingest.tree().is_limited(0), levels > 256);
        assert_eq!(
            u8::try_from(cell_u32(ingest.store(), 0, Column::Marks)).unwrap() & marks::DEPTH_CAP
                != 0,
            levels > 256
        );
        let deepest = (1..u32::try_from(ingest.tree().folders().len()).unwrap())
            .max_by_key(|&id| depth(&ingest, id))
            .unwrap();
        assert_eq!(
            path(&ingest, deepest),
            "d/".repeat(levels).trim_end_matches('/')
        );
        assert_eq!(children(&ingest, deepest), BTreeSet::from([0]));
        assert_eq!(ingest.store().name(0), name.as_bytes());
        check(&ingest);
    }
}

#[test]
fn maximum_name_depth_bomb_keeps_the_row_and_bounded_tree() {
    let name = format!("{}z", "x/".repeat(32_767));
    assert_eq!(name.len(), u16::MAX as usize);
    let mut entry = file(&name, 13, 7);
    entry.comment = vec![b'c'; u16::MAX as usize];
    entry.extra = field(0xbeef, &vec![0; u16::MAX as usize - 4]);
    let ingest = parsed(&[entry]);
    assert_eq!(ingest.tree().folders().len(), 257);
    assert!(ingest.tree().is_limited(0));
    assert_eq!(ingest.store().name(0), name.as_bytes());
    assert_eq!(totals(&ingest, ROOT), [13.0, 7.0, 1.0]);
    check(&ingest);
}

#[test]
fn folded_suffixes_are_not_merged_by_a_truncated_prefix() {
    let prefix = "x/".repeat(255);
    let ingest = parsed(&[
        file(format!("{prefix}a/deeper/file"), 2, 1),
        file(format!("{prefix}b/deeper/file"), 3, 1),
        file(format!("{prefix}a/deeper/other"), 5, 1),
    ]);
    let a = folder(&ingest, &format!("{prefix}a/deeper"));
    let b = folder(&ingest, &format!("{prefix}b/deeper"));
    assert_ne!(a, b);
    assert_eq!(children(&ingest, a), BTreeSet::from([0, 2]));
    assert_eq!(children(&ingest, b), BTreeSet::from([1]));
    assert_eq!(totals(&ingest, a), [7.0, 2.0, 2.0]);
    check(&ingest);
}

#[test]
fn depth_mark_keeps_the_lossy_name_mark() {
    let mut name = b"d/".repeat(300);
    name.extend_from_slice(b"bad\xff");
    let mut entry = file(&name, 1, 1);
    entry.flags = 0x0800;
    let ingest = parsed(&[entry]);
    let bits = u8::try_from(cell_u32(ingest.store(), 0, Column::Marks)).unwrap();
    assert_eq!(
        bits & (marks::DEPTH_CAP | marks::RAW_NAME_KEPT),
        marks::DEPTH_CAP | marks::RAW_NAME_KEPT
    );
    assert_eq!(ingest.store().raw_name(0), Some(name.as_slice()));
    check(&ingest);
}

#[test]
fn folder_cap_keeps_entries_totals_and_existing_folder_access() {
    let entries = [
        file("common/a/one", 2, 1),
        file("common/b/two", 3, 1),
        file("common/c/three", 5, 1),
        file("common/a/four", 7, 1),
        file("root-file", 11, 1),
    ];
    let bytes = archive(&entries, u16::try_from(entries.len()).unwrap(), None).bytes;
    let mut ingest = Ingest::with_folder_limit(bytes.clone(), bytes.len() as u64, 4).unwrap();
    finish(&mut ingest, 1);
    assert_eq!(ingest.tree().folders().len(), 4);
    assert!(!ingest.tree().is_limited(0));
    assert!(!ingest.tree().is_limited(1));
    assert!(ingest.tree().is_limited(2));
    assert!(!ingest.tree().is_limited(3));
    assert_eq!(
        children(&ingest, folder(&ingest, "common/a")),
        BTreeSet::from([0, 3])
    );
    assert_eq!(totals(&ingest, ROOT), [28.0, 5.0, 5.0]);
    check(&ingest);
}

#[test]
fn folder_cap_can_stop_inside_one_path_without_orphan_nodes() {
    let entries = [file("a/b/c/d/file", 7, 3), file("loose", 11, 5)];
    for limit in [1, 2, 3] {
        let bytes = archive(&entries, 2, None).bytes;
        let mut ingest =
            Ingest::with_folder_limit(bytes.clone(), bytes.len() as u64, limit).unwrap();
        finish(&mut ingest, 1);
        assert!(ingest.tree().folders().len() <= limit);
        assert!(ingest.tree().is_limited(0));
        assert!(!ingest.tree().is_limited(1));
        assert_eq!(ingest.store().rows(), 2);
        assert_eq!(totals(&ingest, ROOT), [18.0, 8.0, 2.0]);
        check(&ingest);
    }
}

#[test]
fn terminal_record_error_keeps_only_the_valid_prefix_tree() {
    let entries = [
        file("good/a", 7, 3),
        file("good/deep/b", 11, 5),
        file("bad/path/c", 13, 7),
        file("unread/path/d", 17, 9),
    ];
    let mut fixture = archive(&entries, 4, None);
    fixture.bytes[fixture.records[2]] = b'X';
    let mut ingest = open(fixture.bytes);
    assert_eq!(ingest.parse(u32::MAX), 2);
    assert!(matches!(ingest.status(), Status::Failed(_)));
    assert_eq!(ingest.tree().folders().len(), 3);
    assert_eq!(totals(&ingest, ROOT), [18.0, 8.0, 2.0]);
    check(&ingest);
    assert_eq!(ingest.parse(u32::MAX), 0);
    assert_eq!(totals(&ingest, ROOT), [18.0, 8.0, 2.0]);
}

#[test]
fn false_eocd_counts_do_not_create_folders_or_drop_real_paths() {
    let entries = [file("a/one", 7, 3), file("b/two", 11, 5)];
    for (hint, zip64) in [(0, None), (1, None), (65_535, Some(1u64 << 63))] {
        let mut ingest = open(archive(&entries, hint, zip64).bytes);
        assert_eq!(ingest.tree().folders().len(), 1);
        assert_eq!(totals(&ingest, ROOT), [0.0; 3]);
        assert_eq!(ingest.parse(u32::MAX), 2);
        assert_eq!(ingest.status(), &Status::Complete);
        assert_eq!(ingest.tree().folders().len(), 3);
        assert_eq!(totals(&ingest, ROOT), [18.0, 8.0, 2.0]);
        check(&ingest);
    }
}
