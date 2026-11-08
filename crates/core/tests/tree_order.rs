/*
The name order of the tree. After the last row, a job in steps sorts the child
folders of each folder with the comparison of the table. The tree stays in
archive order until the job ends, and one step changes all of it. Folder ids and
the links of the folder table do not change.
*/

#[path = "support/zip.rs"]
#[allow(dead_code, reason = "These tests use part of the archive helpers.")]
mod zip;

use std::cmp::Ordering;
use zip::{Entry, archive, open};
use zipscope_core::contract::{FOLDER_TAG, NONE, TREE_RECORD_WORDS};
use zipscope_core::ingest::{Ingest, Status};
use zipscope_core::query::{SortColumn, compare_names};
use zipscope_core::tree::{MAX_DEPTH, ROOT};
use zipscope_core::view::tree_record;

/// The budget of one step in the worker (`VIEW_CHUNK`).
const CHUNK: usize = 8192;

fn start(names: &[String]) -> Ingest<Vec<u8>> {
    let entries: Vec<Entry> = names.iter().map(Entry::new).collect();
    open(archive(&entries, u16::MAX, None).bytes)
}

fn parsed(names: &[String]) -> Ingest<Vec<u8>> {
    let mut ingest = start(names);
    while ingest.status() == &Status::Parsing {
        ingest.parse(4096);
    }
    assert_eq!(ingest.status(), &Status::Complete);
    ingest.refresh_views();
    ingest
}

fn strings(names: &[&str]) -> Vec<String> {
    names.iter().map(ToString::to_string).collect()
}

/// Numbers 0 to `count` - 1 in a fixed order that is not sorted.
fn shuffled(count: usize) -> impl Iterator<Item = usize> {
    (0..count).map(move |index| index * 7919 % count)
}

/// Runs the job to its end in steps. Returns the steps.
fn land(ingest: &mut Ingest<Vec<u8>>, budget: usize) -> usize {
    ingest.start_tree_order();
    let mut steps = 0;
    while ingest.views().tree_order_pending() {
        steps += 1;
        ingest.tree_order_step(budget);
    }
    assert!(ingest.views().tree_in_name_order());
    steps
}

fn name(ingest: &Ingest<Vec<u8>>, folder: u32) -> String {
    let bytes = ingest.tree().name(ingest.store().names(), folder);
    String::from_utf8(bytes.to_vec()).unwrap()
}

/// The folder ids of the tree rows.
fn ids(ingest: &Ingest<Vec<u8>>) -> Vec<u32> {
    ingest
        .views()
        .tree()
        .chunks(TREE_RECORD_WORDS)
        .map(|record| record[0] & !FOLDER_TAG)
        .collect()
}

/// The labels of the rows below the root row. A chain row has all its names.
fn labels(ingest: &Ingest<Vec<u8>>) -> Vec<String> {
    ingest
        .views()
        .tree()
        .chunks(TREE_RECORD_WORDS)
        .skip(1)
        .map(|record| {
            let extra = (record[1] >> tree_record::CHAIN_SHIFT) & tree_record::CHAIN_MASK;
            let mut parts = Vec::new();
            let mut folder = record[0] & !FOLDER_TAG;
            for _ in 0..=extra {
                parts.push(name(ingest, folder));
                folder = ingest.tree().parent(folder);
            }
            parts.reverse();
            parts.join("/")
        })
        .collect()
}

fn find(ingest: &Ingest<Vec<u8>>, path: &str) -> u32 {
    let mut folder = ROOT;
    for part in path.split('/') {
        folder = ingest
            .tree()
            .child_folders(folder)
            .find(|&id| name(ingest, id) == part)
            .unwrap_or_else(|| panic!("no folder {path}"));
    }
    folder
}

/// Opens all folders.
fn open_all(ingest: &mut Ingest<Vec<u8>>) {
    let folders = u32::try_from(ingest.tree().folder_count()).unwrap();
    for folder in 0..folders {
        ingest.expand(folder, true);
    }
    ingest.refresh_views();
}

/// Each row of the open tree: its chain head, and its place in its parent row.
/// Checks that the siblings of each row have the order of `compare_names`, and
/// that each folder that shows has a place.
fn check_name_order(ingest: &Ingest<Vec<u8>>) {
    let tree = ingest.tree();
    let names = ingest.store().names();
    let head = |tail: u32, chain: u32| {
        let mut folder = tail;
        for _ in 0..chain {
            folder = tree.parent(folder);
        }
        folder
    };
    let mut last_at_level: Vec<Option<u32>> = vec![None; MAX_DEPTH + 2];
    for record in ingest.views().tree().chunks(TREE_RECORD_WORDS) {
        let info = record[1];
        let level = (info & tree_record::LEVEL_MASK) as usize;
        let chain = (info >> tree_record::CHAIN_SHIFT) & tree_record::CHAIN_MASK;
        let first = head(record[0] & !FOLDER_TAG, chain);
        if record[2] > 1 {
            let before = last_at_level[level].expect("the row has a sibling before it");
            assert_eq!(tree.parent(before), tree.parent(first));
            assert_eq!(
                compare_names(tree.name(names, before), tree.name(names, first)),
                Ordering::Less,
                "{} before {}",
                name(ingest, before),
                name(ingest, first)
            );
        }
        last_at_level[level] = Some(first);
        assert!(record[2] >= 1 && record[2] <= record[3]);
    }
}

#[test]
fn the_tree_lands_in_natural_order_with_the_comparison_of_the_table() {
    let names = strings(&["d10/f", "d9/f", "d01/f", "D1/f", "d2/f", "Z/f", "a/f"]);
    let mut ingest = parsed(&names);
    // Archive order, also after the rows ended, until the job starts.
    assert_eq!(labels(&ingest), ["d10", "d9", "d01", "D1", "d2", "Z", "a"]);
    assert!(!ingest.views().tree_in_name_order());
    land(&mut ingest, CHUNK);
    // The parts of `D1` and `d01` are the same, so the bytes decide.
    assert_eq!(labels(&ingest), ["a", "D1", "d01", "d2", "d9", "d10", "Z"]);
    check_name_order(&ingest);
}

#[test]
fn a_chain_sorts_by_its_first_name_and_keeps_its_place_when_it_splits() {
    let names = strings(&["m/x/y/f", "a10/f", "a2/f", "z/q/g"]);
    let mut ingest = parsed(&names);
    land(&mut ingest, CHUNK);
    assert_eq!(labels(&ingest), ["a2", "a10", "m/x/y", "z/q"]);
    // The listed folder ends its chain, so the row splits. The first name of
    // the row does not change, so the row does not move.
    let x = find(&ingest, "m/x");
    ingest.list(x);
    ingest.refresh_views();
    let shown = labels(&ingest);
    assert_eq!(shown[..3], ["a2", "a10", "m/x"]);
    assert_eq!(shown[3], "y");
    assert_eq!(shown[4], "z/q");
}

#[test]
fn positions_of_the_rows_follow_the_name_order() {
    let names = strings(&["c/f", "a/f", "b/f"]);
    let mut ingest = parsed(&names);
    land(&mut ingest, CHUNK);
    let records: Vec<_> = ingest
        .views()
        .tree()
        .chunks(TREE_RECORD_WORDS)
        .skip(1)
        .map(|record| (record[2], record[3]))
        .collect();
    assert_eq!(records, [(1, 3), (2, 3), (3, 3)]);
}

/// A relink would change these. The first-seen links, the listing in archive
/// order, the folder ids, the open rows and the listed folder all stay.
#[test]
fn the_landing_changes_only_the_order_of_the_tree() {
    let names = strings(&[
        "src/lib/b.rs",
        "docs/",
        "src/app/a.rs",
        "docs/guide.md",
        "zeta/z.txt",
        "alpha/deep/er/x.txt",
        "src/lib/c.rs",
    ]);
    let mut ingest = parsed(&names);
    let src = find(&ingest, "src");
    let deep = find(&ingest, "alpha/deep/er");
    ingest.expand(src, true);
    ingest.list(deep);
    ingest.sort(SortColumn::Archive, false);
    ingest.settle_views();
    ingest.list(ROOT);
    ingest.settle_views();

    let walk = |ingest: &Ingest<Vec<u8>>| {
        (0..u32::try_from(ingest.tree().folder_count()).unwrap())
            .map(|folder| {
                (
                    folder,
                    ingest.tree().child_folders(folder).collect::<Vec<_>>(),
                    ingest.tree().compact_end(folder),
                    ingest.tree().next_sibling(folder),
                )
            })
            .collect::<Vec<_>>()
    };
    let links = walk(&ingest);
    let listing = ingest.views().listing().to_vec();
    let row_folders: Vec<u32> = (0..u32::try_from(names.len()).unwrap())
        .map(|row| ingest.tree().row_folder(row))
        .collect();
    let mut before_ids = ids(&ingest);
    let before_open: Vec<(u32, u32)> = ingest
        .views()
        .tree()
        .chunks(TREE_RECORD_WORDS)
        .map(|record| (record[0], record[1] & tree_record::EXPANDED))
        .collect();
    let largest = ingest.largest_files(ROOT).unwrap();

    land(&mut ingest, CHUNK);

    assert_eq!(walk(&ingest), links);
    assert_eq!(ingest.views().listed(), ROOT);
    assert_eq!(
        ingest.views().listing(),
        listing,
        "archive order is first seen"
    );
    assert_eq!(ingest.largest_files(ROOT).unwrap(), largest);
    let after_rows: Vec<u32> = (0..u32::try_from(names.len()).unwrap())
        .map(|row| ingest.tree().row_folder(row))
        .collect();
    assert_eq!(after_rows, row_folders);
    let mut after_ids = ids(&ingest);
    assert_ne!(after_ids, before_ids, "the test must change the order");
    before_ids.sort_unstable();
    after_ids.sort_unstable();
    assert_eq!(after_ids, before_ids);
    for (word, open) in before_open {
        let record = ingest
            .views()
            .tree()
            .chunks(TREE_RECORD_WORDS)
            .find(|record| record[0] == word)
            .unwrap();
        assert_eq!(record[1] & tree_record::EXPANDED, open);
    }
    // A new listing uses the links, so it also stays first seen.
    ingest.list(src);
    ingest.settle_views();
    ingest.list(ROOT);
    ingest.settle_views();
    assert_eq!(ingest.views().listing(), listing);
}

#[test]
fn a_parse_that_stopped_adds_no_rows_after_the_job_starts() {
    let names = strings(&["z/1", "y/2", "x/3", "w/4", "v/5", "u/6"]);
    let mut ingest = start(&names);
    ingest.parse(3);
    ingest.refresh_views();
    assert_eq!(ingest.status(), &Status::Parsing);
    land(&mut ingest, CHUNK);
    assert_eq!(labels(&ingest), ["x", "y", "z"]);
    // A resume after the stop finds no more rows.
    assert_eq!(ingest.parse(3), 0);
    assert_eq!(ingest.store().rows(), 3);
    assert_eq!(ingest.tree().folder_count(), 4);
    ingest.refresh_views();
    assert_eq!(labels(&ingest), ["x", "y", "z"]);
    check_name_order(&ingest);
}

#[test]
fn rows_of_a_parse_that_went_on_before_the_job_are_in_the_order() {
    let names = strings(&["z/1", "y/2", "x/3", "w/4"]);
    let mut ingest = start(&names);
    ingest.parse(2);
    ingest.refresh_views();
    assert_eq!(labels(&ingest), ["z", "y"]);
    ingest.parse(2);
    ingest.parse(1);
    ingest.refresh_views();
    assert_eq!(labels(&ingest), ["z", "y", "x", "w"]);
    land(&mut ingest, CHUNK);
    assert_eq!(labels(&ingest), ["w", "x", "y", "z"]);
}

#[test]
fn a_second_start_does_nothing() {
    let names = strings(&["b/1", "a/2"]);
    let mut ingest = parsed(&names);
    land(&mut ingest, CHUNK);
    let version = ingest.views().tree_version();
    ingest.start_tree_order();
    assert!(!ingest.views().tree_order_pending());
    assert!(ingest.views().tree_in_name_order());
    assert_eq!(ingest.views().tree_version(), version);
    assert!(!ingest.tree_order_step(CHUNK));
}

#[test]
fn an_archive_with_no_folders_lands_with_its_root() {
    let names = strings(&["one", "two"]);
    let mut ingest = parsed(&names);
    land(&mut ingest, CHUNK);
    assert_eq!(ids(&ingest), [ROOT]);
    assert_eq!(ingest.tree().next_sibling(ROOT), NONE);
}

/// A folder with many siblings: each frame in steps shows the whole old order,
/// no frame shows a mix, and the tree version changes one time.
#[test]
fn many_siblings_sort_in_steps_and_no_frame_shows_a_part_of_the_order() {
    const FOLDERS: usize = 30_000;
    let names: Vec<String> = shuffled(FOLDERS)
        .map(|n| format!("folder-{n:06}/f"))
        .collect();
    let mut ingest = parsed(&names);
    ingest.set_view_step_threshold(CHUNK);
    let archive = ingest.views().tree().to_vec();
    let version = ingest.views().tree_version();
    ingest.start_tree_order();
    let mut steps = 0;
    while ingest.views().tree_order_pending() {
        assert_eq!(ingest.views().tree(), archive);
        assert_eq!(ingest.views().tree_version(), version);
        assert!(!ingest.views().tree_in_name_order());
        let landed = ingest.tree_order_step(CHUNK);
        assert_eq!(landed, !ingest.views().tree_order_pending());
        steps += 1;
    }
    assert_eq!(ingest.views().tree_version(), version.wrapping_add(1));
    // The fill is one unit for each folder, and the sort is more than one
    // unit for each folder in each merge pass.
    assert!(steps > 2 * FOLDERS / CHUNK, "{steps} steps");
    check_name_order(&ingest);
    let shown = labels(&ingest);
    assert_eq!(shown.len(), FOLDERS);
    assert!(shown.windows(2).all(|pair| pair[0] < pair[1]));
}

/// One comparison of long names reads their common prefix. The work count must
/// see these bytes, or one step holds the worker for all of them.
#[test]
fn long_names_make_more_steps() {
    const FOLDERS: usize = 300;
    let prefix = "p".repeat(60_000);
    let names: Vec<String> = shuffled(FOLDERS)
        .map(|n| format!("{prefix}{n:04}/f"))
        .collect();
    let mut ingest = parsed(&names);
    ingest.set_view_step_threshold(1);
    let steps = land(&mut ingest, CHUNK);
    // About 300 × log2(300) comparisons, each more than 100 units.
    assert!(steps >= 20, "{steps} steps");
    check_name_order(&ingest);
}

/// The result does not depend on the budget.
#[test]
fn the_order_is_the_same_with_any_budget() {
    let names: Vec<String> = shuffled(5000)
        .map(|n| {
            format!(
                "t{}/{}{}/m{}/f{n}",
                n % 3,
                if n % 2 == 0 { "A" } else { "a" },
                n % 40,
                n % 7
            )
        })
        .collect();
    let mut small = parsed(&names);
    let mut large = parsed(&names);
    open_all(&mut small);
    open_all(&mut large);
    small.set_view_step_threshold(1);
    land(&mut small, 1);
    land(&mut large, usize::MAX);
    assert_eq!(ids(&small), ids(&large));
    check_name_order(&small);
}

/// Deep folders, chains and a long sibling group at each level.
#[test]
fn deep_trees_sort_at_each_level() {
    let deep = "d/".repeat(MAX_DEPTH + 40);
    let mut names = vec![format!("{deep}leaf")];
    for level in (1..MAX_DEPTH).step_by(7) {
        let path = "d/".repeat(level);
        names.push(format!("{path}z{level}/g"));
        names.push(format!("{path}b{level}/g"));
        names.push(format!("{path}c/only/one/chain/g"));
    }
    let mut ingest = parsed(&names);
    open_all(&mut ingest);
    let rows = ingest.views().tree_rows();
    land(&mut ingest, CHUNK);
    assert_eq!(ingest.views().tree_rows(), rows);
    check_name_order(&ingest);
}

/// A request during the job changes the tree in the old order. The job keeps
/// its work, and the new state is in the tree when the job lands.
#[test]
fn requests_during_the_job_stay_answered_and_keep_their_state() {
    const FOLDERS: usize = 20_000;
    let mut names: Vec<String> = shuffled(FOLDERS)
        .map(|n| format!("folder-{n:06}/inner-{}/f", 9 - n % 10))
        .collect();
    names.push("folder-000000/other/g".to_string());
    names.push("first-seen-last/x/y".to_string());
    let mut ingest = parsed(&names);
    ingest.start_tree_order();
    ingest.tree_order_step(CHUNK);
    assert!(ingest.views().tree_order_pending());
    let open = find(&ingest, "folder-000000");
    let select = find(&ingest, "folder-000005");
    ingest.expand(open, true);
    ingest.list(select);
    ingest.refresh_views();
    let listed = ids(&ingest);
    assert_eq!(listed[1], find(&ingest, "folder-000000"));
    assert_eq!(listed.len(), FOLDERS + 4);
    assert!(ingest.views().tree_order_pending());
    while ingest.views().tree_order_pending() {
        ingest.tree_order_step(CHUNK);
    }
    assert_eq!(ingest.views().listed(), select);
    // In name order, `first-seen-last` is the first row, then `folder-000000`
    // with its open child.
    let shown = labels(&ingest);
    assert_eq!(shown[0], "first-seen-last/x");
    assert_eq!(shown[1], "folder-000000");
    assert_eq!(shown[2], "inner-9");
    assert_eq!(shown[3], "other");
    assert_eq!(shown[4], "folder-000001/inner-8");
    check_name_order(&ingest);
}

/// The worker allows 16 bytes for each folder (`TREE_ORDER_BYTES_PER_FOLDER`).
/// The result keeps 9.
#[test]
fn the_job_stays_in_the_memory_that_the_worker_allows() {
    const FOLDERS: usize = 100_000;
    let names: Vec<String> = shuffled(FOLDERS).map(|n| format!("f{n:06}/x")).collect();
    let mut ingest = parsed(&names);
    let before = ingest.views().allocated_bytes();
    ingest.set_view_step_threshold(1);
    ingest.start_tree_order();
    let mut peak = ingest.views().allocated_bytes();
    while ingest.views().tree_order_pending() {
        ingest.tree_order_step(CHUNK);
        peak = peak.max(ingest.views().allocated_bytes());
    }
    assert!(peak - before <= 16 * FOLDERS, "{} bytes", peak - before);
    let after = ingest.views().allocated_bytes();
    assert!(
        after - before <= 9 * (FOLDERS + 1),
        "{} bytes",
        after - before
    );
}
