/*
ASSUMED API

ingest::Ingest<R>::largest_files(&mut self, folder: u32) -> Option<Vec<u32>>

    The rows of the ten largest files anywhere below `folder` (a folder id
    without FOLDER_TAG). `None` for a folder id that does not exist, and
    at the memory limit when the budget refused a growth (see
    largest_heap.rs). `Some(vec![])` when the subtree has no files.
    The wasm export and the worker must treat it as a view request: after
    `memoryFull()`, no work, and the worker refuses it with a
    `MemoryLimitError` (see hostile-largest.spec.ts).

The rules that these tests pin:

- "Below a folder" is the folder, its subfolders and all their subfolders,
  as the tree gives them (`Tree::row_folder`). The direct entries of the
  folder count. A path deeper than the depth cap counts in the folded
  folder and in all of its ancestors. A row that the folder cap kept in a
  higher folder counts where the tree keeps it.
- A file is an entry row. The explicit row of a folder is never a file,
  also when it declares a size. The answer has no folder items.
- The rank is the declared uncompressed size of the central directory
  (`Column::UncompressedSize`, the Size column of the table), largest
  first. It is not the compressed size, not the rollup of a folder, and it
  does not depend on the method or the encryption. The core never reads
  entry data, so a size that is a lie ranks as declared.
- Equal sizes (as the f64 that the store keeps) rank in row order, which
  is archive order. Thus the answer is deterministic.
- At most ten rows. Fewer when the subtree has fewer files.
- The rule does not say if a file of 0 bytes shows. The checks accept
  both (see `largest::agrees`).
- The answer does not depend on the sort, the search, the listed folder or
  the inline expansion of the listing.
- While parsing, each answer is the answer for all rows up to some batch
  boundary, never a mix (no torn result, no row outside the subtree, no
  row that is not parsed). After `settle_views`, it is the answer for all
  parsed rows.

The memory rules are in largest_heap.rs. The performance rules are in
largest_scale.rs.

Names may change. Record a reason for a change to an expected result.
*/

#[path = "support/largest.rs"]
#[allow(dead_code, reason = "Each test binary uses part of the helpers.")]
mod largest;
#[path = "support/zip.rs"]
#[allow(dead_code, reason = "These tests use part of the archive helpers.")]
mod zip;

use largest::{
    LARGEST, Rng, check, file, file_folder, find, folder, parsed, reference, shape, size, start,
    zip64,
};
use std::fmt::Write as _;
use zip::{Entry, aes, archive, open};
use zipscope_core::contract::{FOLDER_TAG, NONE, marks};
use zipscope_core::ingest::{Ingest, Status};
use zipscope_core::query::SortColumn;
use zipscope_core::tree::{MAX_DEPTH, ROOT};

fn largest(ingest: &mut Ingest<Vec<u8>>, folder: u32) -> Vec<u32> {
    ingest.largest_files(folder).expect("a known folder")
}

fn largest_at(ingest: &mut Ingest<Vec<u8>>, path: &str) -> Vec<u32> {
    let id = folder(ingest, path);
    largest(ingest, id)
}

fn check_at(ingest: &mut Ingest<Vec<u8>>, path: &str) -> Vec<u32> {
    let id = folder(ingest, path);
    check(ingest, id)
}

#[test]
fn ranks_the_whole_subtree_by_declared_uncompressed_size() {
    let mut ingest = parsed(&[
        file("a/one", 10),        // 0
        file("a/b/two", 30),      // 1
        file("a/b/c/three", 20),  // 2
        file("z/outside", 1_000), // 3
        file("top", 500),         // 4
        // A large compressed size does not rank.
        Entry {
            size: 5,
            compressed: 4_000_000_000,
            ..Entry::new("a/b/c/compressed-only")
        }, // 5
        file("a/b/c/d/e/f/g/deep", 40), // 6
        file("a/direct", 25),           // 7
    ]);
    let a = folder(&ingest, "a");
    let b = folder(&ingest, "a/b");
    let c = folder(&ingest, "a/b/c");
    assert_eq!(check(&mut ingest, a), [6, 1, 7, 2, 0, 5]);
    assert_eq!(check(&mut ingest, b), [6, 1, 2, 5]);
    assert_eq!(check(&mut ingest, c), [6, 2, 5]);
    assert_eq!(check_at(&mut ingest, "z"), [3]);
    assert_eq!(check(&mut ingest, ROOT), [3, 4, 6, 1, 7, 2, 0, 5]);
}

#[test]
fn gives_ten_rows_at_most_and_all_rows_when_fewer() {
    let entries: Vec<Entry> = (0..25)
        .map(|index| file(format!("many/f{index:02}"), 100 + index))
        .chain((0..3).map(|index| file(format!("few/f{index}"), 1 + index)))
        .collect();
    let mut ingest = parsed(&entries);
    let many = check_at(&mut ingest, "many");
    assert_eq!(many, (15..25).rev().collect::<Vec<u32>>());
    assert_eq!(check_at(&mut ingest, "few"), [27, 26, 25]);
    assert_eq!(check(&mut ingest, ROOT).len(), LARGEST);
}

#[test]
fn equal_sizes_rank_in_archive_order_across_folders() {
    // The rows of later folders come first, so folder id order, name
    // order and row order do not agree.
    let mut entries = Vec::new();
    for index in 0..40 {
        let folder = ["zz", "aa", "mm/deep", "aa/sub"][index % 4];
        entries.push(file(format!("{folder}/{}", 99 - index), 7));
    }
    let mut ingest = parsed(&entries);
    assert_eq!(check(&mut ingest, ROOT), (0..10).collect::<Vec<u32>>());
    // "aa" has its own rows (1, 5, 9, ...) and "aa/sub" (3, 7, 11, ...).
    assert_eq!(
        check_at(&mut ingest, "aa"),
        [1, 3, 5, 7, 9, 11, 13, 15, 17, 19]
    );
    // The same answer each time.
    for _ in 0..3 {
        assert_eq!(largest(&mut ingest, ROOT), (0..10).collect::<Vec<u32>>());
    }
}

#[test]
fn zip64_sizes_above_u32_and_near_u64_max_rank_by_the_stored_value() {
    // An f64 keeps 53 bits. u64::MAX and u64::MAX - 1 are the same f64,
    // and so are 2^53 + 1 and 2^53. Each pair is in the order that both
    // rules (exact and f64) give, so the test does not pin which one is
    // used.
    let mut ingest = parsed(&[
        zip64("z/max", u64::MAX, 1),              // 0
        zip64("z/max-1", u64::MAX - 1, 1),        // 1
        zip64("z/half", 1 << 63, 1),              // 2
        zip64("z/2^53+1", (1 << 53) + 1, 1),      // 3
        zip64("z/2^53", 1 << 53, 1),              // 4
        zip64("z/5gib", 5 << 30, 1),              // 5
        file("z/u32-max-less-one", u32::MAX - 1), // 6
        zip64("z/4gib", 1 << 32, 1),              // 7
        zip64("z/tib", 1 << 40, 1 << 41),         // 8
        file("z/small", 3),                       // 9
        zip64("z/zip64-small", 2, u64::MAX),      // 10
        file("z/one", 1),                         // 11
    ]);
    assert_eq!(size(&ingest, 2), 2f64.powi(63));
    assert_eq!(size(&ingest, 8), 2f64.powi(40));
    let expected = [0, 1, 2, 3, 4, 8, 5, 7, 6, 9];
    assert_eq!(check_at(&mut ingest, "z"), expected);
    assert_eq!(check(&mut ingest, ROOT), expected);
}

#[test]
fn a_lying_size_encryption_and_unknown_methods_rank_by_the_declared_size() {
    // The local headers have no data: each size is a claim only.
    let mut ingest = parsed(&[
        Entry {
            flags: 1,
            method: 8,
            ..zip64("x/zipcrypto", 9_000_000_000, 12)
        }, // 0
        Entry {
            flags: 1,
            method: 99,
            extra: [aes(2, 3, 8), zip64("", 7_000_000_000, 7).extra].concat(),
            size: u32::MAX,
            compressed: u32::MAX,
            ..Entry::new("x/aes")
        }, // 1
        Entry {
            method: 0x4242,
            size: 8_000,
            compressed: 8_000,
            ..Entry::new("x/unknown-method")
        }, // 2
        Entry {
            method: 0,
            size: u32::MAX - 7,
            compressed: u32::MAX - 7,
            ..Entry::new("x/stored-claims-4gib")
        }, // 3
        Entry {
            method: 8,
            size: 10,
            compressed: 3_000_000_000,
            ..Entry::new("x/grows")
        }, // 4
        Entry {
            flags: 0x0008,
            method: 8,
            size: 500,
            compressed: 400,
            ..Entry::new("x/descriptor")
        }, // 5
    ]);
    assert_eq!(size(&ingest, 1), 7_000_000_000.0);
    assert_eq!(check_at(&mut ingest, "x"), [0, 1, 3, 2, 5, 4]);
}

#[test]
fn folder_rows_never_rank_as_files() {
    let mut entries = vec![
        // An explicit folder row that claims 2^60 bytes.
        zip64("claims/", 1 << 60, 1 << 60), // 0
        file("claims/small", 1),            // 1
        file("late/x", 2),                  // 2
        // A late explicit row: the folder was implied before.
        zip64("late/", 1 << 50, 1), // 3
    ];
    // Many files in one folder: the rollup of the folder is the largest
    // value of the archive, but a folder is not a file.
    for index in 0..12 {
        entries.push(file(format!("sum/f{index}"), 1_000 + index)); // 4..16
    }
    let mut ingest = parsed(&entries);
    let claims = folder(&ingest, "claims");
    let late = folder(&ingest, "late");
    assert_eq!(ingest.tree().folder(claims).explicit_row, 0);
    assert_eq!(ingest.tree().folder(late).explicit_row, 3);
    assert_eq!(check(&mut ingest, claims), [1]);
    assert_eq!(check(&mut ingest, late), [2]);
    let root = check(&mut ingest, ROOT);
    assert_eq!(root, (6..16).rev().collect::<Vec<u32>>());
    assert!(!root.contains(&0) && !root.contains(&3));
}

#[test]
fn a_second_folder_entry_is_an_entry_but_the_first_is_not() {
    // The contract: a later folder entry for the same folder is an entry
    // of that folder. It is a row of the listing, so it can rank. The
    // first is the explicit row and never ranks.
    let mut ingest = parsed(&[
        file("dup/", 900), // 0: explicit row
        file("dup/", 800), // 1: an entry of "dup"
        file("dup/a", 5),  // 2
    ]);
    let dup = folder(&ingest, "dup");
    assert_eq!(ingest.tree().folder(dup).explicit_row, 0);
    assert_eq!(file_folder(&ingest, 1), Some(dup));
    assert_eq!(check(&mut ingest, dup), [1, 2]);
}

#[test]
fn a_file_with_the_name_of_a_folder_stays_in_its_own_folder() {
    let mut ingest = parsed(&[
        file("a", 1_000),  // 0: a file at the root
        file("a/x", 1),    // 1
        file("a\\y", 2),   // 2: the same folder
        file("a//z", 3),   // 3: empty segments are ignored
        file("A/w", 500),  // 4: another folder (names keep case)
        file("a/", 0),     // 5: the explicit row, after the folder
        file("/a/v", 4),   // 6: a leading separator
        file("ab/u", 700), // 7: a prefix of the name is not the folder
        file("a/b/a", 6),  // 8
    ]);
    let a = folder(&ingest, "a");
    assert_eq!(check(&mut ingest, a), [8, 6, 3, 2, 1]);
    assert_eq!(check_at(&mut ingest, "A"), [4]);
    assert_eq!(check(&mut ingest, ROOT), [0, 7, 4, 8, 6, 3, 2, 1]);
}

#[test]
fn duplicate_names_each_rank_as_their_own_row() {
    let mut ingest = parsed(&[
        file("d/same", 5),  // 0
        file("d/same", 9),  // 1
        file("d/same", 9),  // 2
        file("d/SAME", 9),  // 3
        file("d/same", 12), // 4
    ]);
    assert_eq!(check_at(&mut ingest, "d"), [4, 1, 2, 3, 0]);
}

#[test]
fn a_subtree_with_folders_only_or_an_empty_archive_shows_nothing() {
    let mut ingest = parsed(&[
        file("e/", 0),
        zip64("e/f/", 1 << 40, 1),
        file("e/f/g/", 77),
        file("other/file", 3),
    ]);
    assert_eq!(largest_at(&mut ingest, "e"), Vec::<u32>::new());
    assert_eq!(largest_at(&mut ingest, "e/f/g"), Vec::<u32>::new());
    assert_eq!(check(&mut ingest, ROOT), [3]);

    let mut empty = parsed(&[]);
    assert_eq!(largest(&mut empty, ROOT), Vec::<u32>::new());

    let mut folders = parsed(&[file("only/", 0), file("only/more/", 0)]);
    assert_eq!(largest(&mut folders, ROOT), Vec::<u32>::new());
}

#[test]
fn an_unknown_folder_gives_no_answer() {
    let mut ingest = parsed(&[file("a/b", 1)]);
    let count = u32::try_from(ingest.tree().folder_count()).unwrap();
    assert_eq!(count, 2);
    for unknown in [
        count,
        count + 1,
        NONE,
        FOLDER_TAG,
        FOLDER_TAG | 1,
        u32::MAX - 1,
    ] {
        assert_eq!(ingest.largest_files(unknown), None, "folder {unknown:#x}");
    }
}

#[test]
fn rows_below_the_depth_cap_count_in_the_folded_folder_and_above() {
    let deep = format!("{}deep.bin", "d/".repeat(300));
    // 32,767 folders in a name of 65,535 bytes.
    let mut long = "s/".repeat(32_767);
    long.push('x');
    assert_eq!(long.len(), 65_535);
    let mut ingest = parsed(&[
        file(&deep, 900),                                       // 0
        file("d/d/shallow.bin", 950),                           // 1
        file(&long, 800),                                       // 2
        file(format!("{}at-cap", "d/".repeat(300)), 10),        // 3: the same folded folder
        file("d/d/d/small", 1),                                 // 4
        file(format!("{}sibling", "d/".repeat(MAX_DEPTH)), 20), // 5: a folder "d" at depth 256
    ]);
    assert_ne!(ingest.store().marks(0) & marks::DEPTH_CAP, 0);
    // The folders from the root to the folded folder.
    let mut chain = Vec::new();
    let mut at = file_folder(&ingest, 0).unwrap();
    while at != NONE {
        chain.push(at);
        at = ingest.tree().parent(at);
    }
    chain.reverse();
    assert_eq!(chain.len(), MAX_DEPTH + 1);
    assert_eq!(file_folder(&ingest, 3), Some(chain[MAX_DEPTH]));
    for depth in [1, 2, 3, 4, 128, 255, MAX_DEPTH] {
        let answer = check(&mut ingest, chain[depth]);
        assert!(answer.contains(&0), "depth {depth}: {answer:?}");
        assert!(answer.contains(&3), "depth {depth}: {answer:?}");
        assert_eq!(answer.contains(&1), depth <= 2, "depth {depth}");
        assert_eq!(answer.contains(&4), depth <= 3, "depth {depth}");
        assert_eq!(answer.contains(&5), depth < MAX_DEPTH, "depth {depth}");
    }
    let sibling = file_folder(&ingest, 5).unwrap();
    assert_ne!(sibling, chain[MAX_DEPTH]);
    assert_eq!(check(&mut ingest, sibling), [5]);
    let mut at = file_folder(&ingest, 2).unwrap();
    while at != NONE {
        assert!(check(&mut ingest, at).contains(&2));
        at = ingest.tree().parent(at);
    }
    assert_eq!(check(&mut ingest, ROOT), [1, 0, 2, 5, 3, 4]);
}

#[test]
fn rows_that_the_folder_cap_keeps_higher_rank_where_the_tree_keeps_them() {
    let entries = [
        file("a/b/c/d/e/f1", 50), // 0: folders a, b, c fill the table
        file("a/b/x/f2", 60),     // 1
        file("a/f3", 5),          // 2
        file("q/f4", 70),         // 3
        file("a/b/c/f5", 1),      // 4
    ];
    let data = largest::bytes(&entries);
    let size_of = data.len() as u64;
    let mut ingest = Ingest::with_folder_limit(data, size_of, 4).unwrap();
    while *ingest.status() == Status::Parsing {
        ingest.parse(2);
        ingest.refresh_views();
    }
    ingest.settle_views();
    assert_eq!(ingest.tree().folder_count(), 4);
    assert!((0..5).any(|row| ingest.store().marks(row) & marks::FOLDER_CAP != 0));
    for folder in 0..4 {
        check(&mut ingest, folder);
    }
    assert_eq!(check(&mut ingest, ROOT), [3, 1, 0, 2, 4]);
}

#[test]
fn a_wide_folder_does_not_leak_into_its_siblings() {
    let mut rng = Rng(0x19);
    let mut entries: Vec<Entry> = (0..20_000)
        .map(|index| file(format!("wide/f{index:05}"), 1 + rng.small(1 << 30)))
        .collect();
    entries[12_345] = zip64("wide/max", 1 << 35, 1);
    entries.push(file("narrow/n0", 3)); // 20,000
    entries.push(file("narrow/n1", 2)); // 20,001
    entries.push(file("narrow/n2", 3)); // 20,002
    let mut ingest = parsed(&entries);
    let narrow = folder(&ingest, "narrow");
    assert_eq!(check(&mut ingest, narrow), [20_000, 20_002, 20_001]);
    let wide = check_at(&mut ingest, "wide");
    assert_eq!(wide[0], 12_345);
    assert_eq!(check(&mut ingest, ROOT), wide);
}

#[test]
fn a_compact_chain_gives_the_same_rows_for_each_of_its_folders() {
    let mut ingest = parsed(&[
        file("c/d/e/f1", 4),
        file("c/d/e/f2", 8),
        file("c/d/e/g/f3", 6),
    ]);
    for path in ["c", "c/d", "c/d/e"] {
        assert_eq!(check_at(&mut ingest, path), [1, 2, 0], "{path}");
    }
    assert_eq!(check_at(&mut ingest, "c/d/e/g"), [2]);
}

#[test]
fn the_answer_does_not_follow_the_sort_the_search_or_the_listing() {
    let mut rng = Rng(7);
    let entries: Vec<Entry> = (0..60)
        .map(|index| {
            let place = ["a", "a/x", "a/y/z", "b", "b/x"][index % 5];
            file(format!("{place}/x{index}"), rng.small(40))
        })
        .collect();
    let mut ingest = parsed(&entries);
    let a = folder(&ingest, "a");
    let b = folder(&ingest, "b");
    let base = [
        check(&mut ingest, ROOT),
        check(&mut ingest, a),
        check(&mut ingest, b),
    ];
    let again = |ingest: &mut Ingest<Vec<u8>>, step: &str| {
        ingest.settle_views();
        let now = [
            largest(ingest, ROOT),
            largest(ingest, a),
            largest(ingest, b),
        ];
        assert_eq!(now, base, "after {step}");
    };
    ingest.sort(SortColumn::Size, false);
    again(&mut ingest, "an ascending size sort");
    ingest.sort(SortColumn::Name, true);
    again(&mut ingest, "a name sort");
    ingest.sort(SortColumn::Compressed, true);
    again(&mut ingest, "a compressed size sort");
    ingest.search("x1");
    again(&mut ingest, "a search");
    ingest.search("");
    assert!(ingest.list(b));
    again(&mut ingest, "a listing of b");
    assert!(ingest.expand_inline(a, true, true));
    again(&mut ingest, "an inline expansion");
    assert!(ingest.expand(a, false));
    again(&mut ingest, "a collapse");
}

#[test]
fn each_row_shows_in_the_tree_and_in_the_listing_of_its_folder() {
    let mut rng = Rng(3);
    let entries: Vec<Entry> = (0..200)
        .map(|index| {
            let depth = rng.index(5);
            let mut path = String::new();
            for level in 0..depth {
                write!(path, "p{}/", (index + level) % 3).unwrap();
            }
            file(format!("{path}r{index}"), rng.small(1_000))
        })
        .collect();
    let mut ingest = parsed(&entries);
    let folders = u32::try_from(ingest.tree().folder_count()).unwrap();
    for listed in 0..folders {
        for row in check(&mut ingest, listed) {
            // "Show in tree": the folder of the row.
            let at = ingest.entry_folder(row);
            assert_eq!(at & FOLDER_TAG, 0, "row {row}");
            assert!(ingest.list(at));
            ingest.settle_views();
            assert_eq!(ingest.views().permutation_folder(), at, "row {row}");
            assert!(ingest.views().listing().contains(&row), "row {row}");
        }
    }
}

#[test]
fn during_parse_each_answer_is_whole_for_a_prefix_of_the_rows() {
    let mut rng = Rng(0xfeed);
    let places = ["t", "t/v", "t/v/w", "u", "late", ""];
    let mut entries = Vec::new();
    for index in 0..360_u32 {
        let place = if index < 300 {
            places[rng.index(4)]
        } else {
            places[4 + rng.index(2)]
        };
        // Sizes grow with the row, so most batches change the answer. Some
        // sizes are equal.
        let value = index * 16 + rng.small(24) + 1;
        let name = if place.is_empty() {
            format!("r{index}")
        } else {
            format!("{place}/r{index}")
        };
        entries.push(file(name, value));
        if index == 200 {
            // A late explicit row for "t" that claims a large size.
            entries.push(zip64("t/", 1 << 45, 1));
        }
    }
    let mut ingest = start(&entries);
    let paths = ["", "t", "t/v", "t/v/w", "u", "late"];
    let batches = [1_u32, 2, 3, 7, 16];
    // The row counts at batch ends since the last settle, and the index
    // of the last prefix that each folder showed.
    let mut ends = vec![0_usize];
    let mut shown = [0_usize; 6];
    let mut turn = 0;
    while *ingest.status() == Status::Parsing {
        ingest.parse(batches[turn % batches.len()]);
        ingest.refresh_views();
        ingest.merge_views(64);
        ends.push(ingest.store().rows());
        // The view state changes while rows arrive.
        match turn % 9 {
            3 => ingest.sort(SortColumn::Name, false),
            5 => {
                if let Some(t) = find(&ingest, "t") {
                    assert!(ingest.list(t));
                }
            }
            7 => ingest.sort(SortColumn::Size, true),
            _ => {}
        }
        for (slot, path) in paths.iter().enumerate() {
            let Some(id) = find(&ingest, path) else {
                continue;
            };
            let answer = ingest.largest_files(id).expect("a known folder");
            let rows = ingest.store().rows();
            shape(&ingest, id, rows, &answer);
            let prefix = (shown[slot]..ends.len())
                .find(|&index| reference(&ingest, id, ends[index]) == answer)
                .unwrap_or_else(|| {
                    panic!(
                        "turn {turn}, folder {path:?}: {answer:?} is not the answer of a \
                         batch end from {} rows on (now {:?})",
                        ends[shown[slot]],
                        reference(&ingest, id, rows)
                    )
                });
            shown[slot] = prefix;
        }
        if turn % 5 == 4 {
            ingest.settle_views();
            for path in paths {
                if let Some(id) = find(&ingest, path) {
                    check(&mut ingest, id);
                }
            }
            ends = vec![ingest.store().rows()];
            shown = [0; 6];
        }
        turn += 1;
        assert!(turn < 10_000);
    }
    assert_eq!(ingest.status(), &Status::Complete);
    ingest.settle_views();
    for path in paths {
        let id = folder(&ingest, path);
        check(&mut ingest, id);
    }
    let t = folder(&ingest, "t");
    assert!(!largest(&mut ingest, t).contains(&201));
    assert_eq!(ingest.tree().folder(t).explicit_row, 201);
}

#[test]
fn the_answer_of_one_folder_follows_each_batch_after_a_settle() {
    // A frame asks for the same folder again and again. A new row that
    // ranks must show after the next settle, also when it is in a deep
    // subfolder or in a folder that the batch made.
    let entries: Vec<Entry> = (0..40_u32)
        .map(|index| {
            let depth = usize::try_from(index % 6).unwrap();
            file(format!("s/{}/f{index}", "n/".repeat(depth)), 10 + index)
        })
        .collect();
    let mut ingest = start(&entries);
    let mut known = None;
    while *ingest.status() == Status::Parsing {
        if ingest.parse(1) == 0 {
            continue;
        }
        ingest.settle_views();
        let s = *known.get_or_insert_with(|| folder(&ingest, "s"));
        let rows = u32::try_from(ingest.store().rows()).unwrap();
        let answer = check(&mut ingest, s);
        assert_eq!(answer[0], rows - 1);
        assert_eq!(check(&mut ingest, s), answer);
    }
    let s = folder(&ingest, "s");
    assert_eq!(check(&mut ingest, ROOT), check(&mut ingest, s));
}

#[test]
fn a_terminal_error_keeps_the_answer_of_the_parsed_rows() {
    let entries = [
        file("k/a", 10),
        file("k/b", 20),
        file("k/bad", 30),
        file("k/tail", 4_000_000),
    ];
    let mut fixture = archive(&entries, 4, None);
    fixture.bytes[fixture.records[2]] = b'X';
    let mut ingest = open(fixture.bytes);
    assert_eq!(ingest.parse(u32::MAX), 2);
    assert!(matches!(ingest.status(), Status::Failed(_)));
    ingest.settle_views();
    let k = folder(&ingest, "k");
    assert_eq!(check(&mut ingest, k), [1, 0]);
    assert_eq!(ingest.parse(10), 0);
    assert_eq!(check(&mut ingest, ROOT), [1, 0]);
}

#[test]
fn false_entry_counts_do_not_make_phantom_rows() {
    let entries = [file("f/a", 3), file("f/b", 1), file("f/c", 2)];
    for (hint, zip64_hint) in [(0, None), (1, None), (65_535, Some(1u64 << 63))] {
        let mut ingest = open(archive(&entries, hint, zip64_hint).bytes);
        assert_eq!(largest(&mut ingest, ROOT), Vec::<u32>::new());
        assert_eq!(ingest.parse(u32::MAX), 3);
        ingest.settle_views();
        assert_eq!(check(&mut ingest, ROOT), [0, 2, 1]);
    }
}

#[test]
fn the_root_answer_matches_the_reference_for_a_random_tree() {
    let mut rng = Rng(0x1919);
    let entries: Vec<Entry> = (0..3_000)
        .map(|index| {
            let depth = rng.index(7);
            let mut name = String::new();
            for _ in 0..depth {
                write!(name, "{}/", rng.below(4)).unwrap();
            }
            match rng.below(10) {
                0 => name.push('/'), // a folder entry
                1 => return zip64(format!("{name}z{index}"), rng.next(), 1),
                _ => write!(name, "f{index}").unwrap(),
            }
            // Many equal sizes.
            file(name, rng.small(50) * 1_000)
        })
        .collect();
    let mut ingest = start(&entries);
    while *ingest.status() == Status::Parsing {
        ingest.parse(97);
        ingest.refresh_views();
    }
    ingest.settle_views();
    let folders = u32::try_from(ingest.tree().folder_count()).unwrap();
    for id in 0..folders {
        check(&mut ingest, id);
    }
}
