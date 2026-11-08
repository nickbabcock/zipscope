/*
Best-match order of search results. It applies while a query is active and
the user chose no sort. `Tier` in `src/query.rs` gives the tiers.

These tests read the listing through `Ingest`, as the worker does. The
expected order comes from `expected`, a plain model of the contract.
*/

#[path = "support/zip.rs"]
#[allow(dead_code, reason = "These tests use part of the archive helpers.")]
mod zip;

use zip::{Entry, archive, open};
use zipscope_core::ingest::Ingest;
use zipscope_core::query::SortColumn;

fn file(name: impl AsRef<[u8]>, size: u32) -> Entry {
    Entry {
        size,
        compressed: size,
        ..Entry::new(name)
    }
}

fn start(entries: &[Entry]) -> Ingest<Vec<u8>> {
    open(archive(entries, entries.len().try_into().unwrap(), None).bytes)
}

fn parsed(entries: &[Entry]) -> Ingest<Vec<u8>> {
    let mut ingest = start(entries);
    assert_eq!(ingest.parse(u32::MAX) as usize, entries.len());
    ingest
}

fn names(ingest: &mut Ingest<Vec<u8>>) -> Vec<String> {
    ingest.settle_views();
    shown(ingest)
}

/// The names of the listing as it is now, with no more work.
fn shown(ingest: &Ingest<Vec<u8>>) -> Vec<String> {
    ingest
        .views()
        .listing()
        .iter()
        .map(|&row| {
            if row & zipscope_core::contract::FOLDER_TAG == 0 {
                String::from_utf8_lossy(ingest.store().name(row as usize)).into_owned()
            } else {
                format!("folder {}", row & !zipscope_core::contract::FOLDER_TAG)
            }
        })
        .collect()
}

fn results(ingest: &mut Ingest<Vec<u8>>, query: &str) -> Vec<String> {
    ingest.search(query);
    names(ingest)
}

/// The base name range of a name: the last segment. The separators at the
/// end are not part of it. A name with no segments is its own base name.
fn base(name: &[u8]) -> (usize, usize) {
    let is_separator = |byte: &u8| *byte == b'/' || *byte == b'\\';
    let end = name.len() - name.iter().rev().take_while(|b| is_separator(b)).count();
    if end == 0 {
        return (0, name.len());
    }
    let start = name[..end]
        .iter()
        .rposition(is_separator)
        .map_or(0, |at| at + 1);
    (start, end)
}

/// The place of a row in the contract: tier, folder first, size from the
/// largest, then row. `None` when the name does not match.
fn rank(name: &[u8], query: &[u8], size: u32, row: usize) -> Option<(u8, bool, u32, usize)> {
    let fold = |bytes: &[u8]| bytes.to_ascii_lowercase();
    let (name_low, query_low) = (fold(name), fold(query));
    let contains = |haystack: &[u8], needle: &[u8]| {
        needle.len() <= haystack.len() && haystack.windows(needle.len()).any(|w| w == needle)
    };
    if !contains(&name_low, &query_low) {
        return None;
    }
    let (start, end) = base(&name_low);
    let is_separator = |byte: &u8| *byte == b'/' || *byte == b'\\';
    let core = query_low.len()
        - query_low
            .iter()
            .rev()
            .take_while(|byte| is_separator(byte))
            .count();
    let tier = if query_low[..core].iter().any(is_separator) {
        // A part of a path: exact when it is the end of the path and starts at
        // a segment.
        let whole = (0..=name_low.len() - query_low.len()).any(|at| {
            name_low[at..].starts_with(&query_low)
                && at + core == end
                && (at == 0 || is_separator(&name_low[at - 1]) || is_separator(&query_low[0]))
        });
        if whole { 0 } else { 3 }
    } else {
        let tail = &name_low[start..];
        let at = (0..tail.len()).find(|&at| tail[at..].starts_with(&query_low));
        match at {
            Some(0) if query_low.len() >= end - start => 0,
            Some(0) => 1,
            Some(at) if at < end - start => 2,
            _ => 3,
        }
    };
    Some((tier, end == name.len(), u32::MAX - size, row))
}

fn expected(entries: &[(Vec<u8>, u32)], rows: usize, query: &[u8]) -> Vec<String> {
    let mut ranked: Vec<_> = entries[..rows]
        .iter()
        .enumerate()
        .filter_map(|(row, (name, size))| rank(name, query, *size, row))
        .collect();
    ranked.sort_unstable();
    ranked
        .into_iter()
        .map(|place| String::from_utf8_lossy(&entries[place.3].0).into_owned())
        .collect()
}

#[test]
fn an_exact_name_comes_before_larger_partial_names() {
    let mut ingest = parsed(&[
        file("readme.txt/inner", 800),
        file("a/old-readme.txt", 700),
        file("big/readme.txt.bak", 900),
        file("b/README.TXT", 1),
    ]);
    assert_eq!(
        results(&mut ingest, "ReadMe.txt"),
        [
            "b/README.TXT",
            "big/readme.txt.bak",
            "a/old-readme.txt",
            "readme.txt/inner",
        ]
    );
    assert!(ingest.views().listing_best_match());
}

#[test]
fn a_full_path_comes_before_larger_partial_matches() {
    let entries = [
        file("repo-1.0/src/main.rs.d/note.txt", 700),
        file("repo-1.0/src/main.rs.orig", 800),
        file("repo-1.0/src/main.rs", 900),
        file("vendor/dep/src/main.rs", 5000),
        file("mysrc/main.rs", 9000),
    ];
    let mut ingest = parsed(&entries);
    assert_eq!(
        results(&mut ingest, "repo-1.0/src/main.rs"),
        [
            "repo-1.0/src/main.rs",
            "repo-1.0/src/main.rs.orig",
            "repo-1.0/src/main.rs.d/note.txt",
        ]
    );
    // Both full paths are exact, and the size decides between them.
    assert_eq!(
        results(&mut ingest, "SRC/main.RS"),
        [
            "vendor/dep/src/main.rs",
            "repo-1.0/src/main.rs",
            "mysrc/main.rs",
            "repo-1.0/src/main.rs.orig",
            "repo-1.0/src/main.rs.d/note.txt",
        ]
    );
}

#[test]
fn inside_a_tier_the_largest_comes_first_then_archive_order() {
    let mut ingest = parsed(&[
        file("a/note.txt", 5),
        file("b/note.txt", 9),
        file("c/note.txt", 5),
        file("d/note.md", 100),
        file("e/note.md", 1000),
    ]);
    assert_eq!(
        results(&mut ingest, "note.txt"),
        ["b/note.txt", "a/note.txt", "c/note.txt"]
    );
    assert_eq!(
        results(&mut ingest, "note"),
        [
            "e/note.md",
            "d/note.md",
            "b/note.txt",
            "a/note.txt",
            "c/note.txt",
        ]
    );
}

#[test]
fn a_tier_comes_before_folders_and_folders_stay_first_inside_a_tier() {
    let mut ingest = parsed(&[
        file("a/report", 50),
        file("b/report/", 0),
        file("report-old/", 0),
        file("c/report-new", 90),
        file("d/report\\", 0),
    ]);
    assert_eq!(
        results(&mut ingest, "report"),
        [
            // Exact: the two folder rows, then the file.
            "b/report/",
            "d/report\\",
            "a/report",
            // Prefix: the folder row, then the file.
            "report-old/",
            "c/report-new",
        ]
    );
    // The separator at the end of a folder row can also be in the query.
    assert_eq!(results(&mut ingest, "report/"), ["b/report/"]);
}

#[test]
fn a_header_chooses_a_column_and_a_clear_goes_back_to_the_sort_of_the_folder() {
    let entries = [file("big-note.txt", 900), file("note.txt", 1), file("x", 5)];
    let mut ingest = parsed(&entries);
    ingest.default_sort();
    assert_eq!(names(&mut ingest), ["big-note.txt", "x", "note.txt"]);
    assert!(!ingest.views().listing_best_match());

    assert_eq!(results(&mut ingest, "note"), ["note.txt", "big-note.txt"]);
    assert!(ingest.views().listing_best_match());
    // The same column as the default: now the choice of the user. The rows
    // follow the column, not the tiers.
    ingest.sort(SortColumn::Size, true);
    assert_eq!(names(&mut ingest), ["big-note.txt", "note.txt"]);
    assert!(!ingest.views().listing_best_match());
    // The choice stays when the query changes and when the query goes.
    assert_eq!(results(&mut ingest, "NOTE."), ["big-note.txt", "note.txt"]);
    assert_eq!(results(&mut ingest, ""), ["big-note.txt", "x", "note.txt"]);
    assert_eq!(results(&mut ingest, "note"), ["big-note.txt", "note.txt"]);
    assert!(!ingest.views().listing_best_match());
}

#[test]
fn a_clear_with_no_choice_goes_back_to_the_order_of_the_folder() {
    let entries = [file("big-note.txt", 900), file("note.txt", 1), file("x", 5)];
    // During the parse, the folder is in archive order.
    let mut ingest = parsed(&entries);
    assert_eq!(results(&mut ingest, "note"), ["note.txt", "big-note.txt"]);
    assert_eq!(results(&mut ingest, ""), ["big-note.txt", "note.txt", "x"]);
    // After the default sort landed, the folder is by Size.
    ingest.default_sort();
    assert_eq!(results(&mut ingest, "note"), ["note.txt", "big-note.txt"]);
    assert_eq!(results(&mut ingest, ""), ["big-note.txt", "x", "note.txt"]);
}

#[test]
fn archive_order_from_the_cycle_is_a_choice() {
    // Here archive order, the Size order and the tiers are all different.
    let entries = [
        file("x-note.txt", 5),
        file("big-note.txt", 900),
        file("note.txt", 1),
    ];
    let archive_order = ["x-note.txt", "big-note.txt", "note.txt"];
    let mut ingest = parsed(&entries);
    ingest.default_sort();
    assert_eq!(
        names(&mut ingest),
        ["big-note.txt", "x-note.txt", "note.txt"]
    );
    ingest.sort(SortColumn::Archive, false);
    assert_eq!(names(&mut ingest), archive_order);
    assert_eq!(results(&mut ingest, "note"), archive_order);
    assert!(!ingest.views().listing_best_match());
    // The default sort does not replace it, in a search or in a folder.
    ingest.default_sort();
    assert_eq!(names(&mut ingest), archive_order);
    assert_eq!(results(&mut ingest, ""), archive_order);
    ingest.default_sort();
    assert_eq!(names(&mut ingest), archive_order);
}

#[test]
fn a_filter_of_a_chosen_sort_then_new_rows_merge_at_their_place() {
    let entries = [
        file("keep-1", 10),
        file("drop-1", 90),
        file("keep-2", 30),
        file("drop-2", 80),
        file("keep-3", 20),
        file("keep-4", 40),
    ];
    let mut ingest = start(&entries);
    ingest.sort(SortColumn::Size, true);
    assert_eq!(ingest.parse(4), 4);
    ingest.search("-");
    assert_eq!(names(&mut ingest), ["drop-1", "drop-2", "keep-2", "keep-1"]);
    // A filter of the listing: it has two rows fewer.
    ingest.search("ep-");
    assert_eq!(names(&mut ingest), ["keep-2", "keep-1"]);
    // The old end of the part would pass the end of the listing.
    assert_eq!(ingest.parse(2), 2);
    assert_eq!(names(&mut ingest), ["keep-4", "keep-2", "keep-3", "keep-1"]);
}

#[test]
fn few_matches_keep_the_rows_that_wait_when_the_query_gets_longer() {
    let mut names_of_rows: Vec<String> = (0..200u32).map(|i| format!("n{i}")).collect();
    names_of_rows.extend(["ab".to_owned(), "abx".to_owned()]);
    names_of_rows.push("zab".to_owned());
    names_of_rows.push("zabx".to_owned());
    let entries: Vec<Entry> = names_of_rows.iter().map(|name| file(name, 1)).collect();
    let mut ingest = start(&entries);
    assert_eq!(ingest.parse(202), 202);
    ingest.search("ab");
    assert_eq!(names(&mut ingest), ["ab", "abx"]);
    // Two new rows match and wait. Few rows matched, so the longer query
    // reads only the rows that match, and these two are among them.
    assert_eq!(ingest.parse(2), 2);
    ingest.refresh_views();
    assert!(ingest.merge_pending());
    ingest.search("abx");
    assert_eq!(names(&mut ingest), ["abx", "zabx"]);
}

#[test]
fn a_longer_query_finds_the_largest_of_its_rows() {
    let entries = [
        file("ab-1", 9),
        file("ax-1", 100),
        file("ab-2", 7),
        file("ax-2", 90),
    ];
    let mut ingest = parsed(&entries);
    ingest.search("a");
    ingest.settle_views();
    assert!((ingest.listing_largest() - 100.0).abs() < f64::EPSILON);
    // The size bars scale to the largest row that shows.
    ingest.search("ab");
    ingest.settle_views();
    assert_eq!(shown(&ingest), ["ab-1", "ab-2"]);
    assert!((ingest.listing_largest() - 9.0).abs() < f64::EPSILON);
    // Also for rows that were waiting.
    let mut ingest = start(&entries);
    assert_eq!(ingest.parse(2), 2);
    ingest.search("a");
    ingest.settle_views();
    assert_eq!(ingest.parse(2), 2);
    ingest.refresh_views();
    ingest.search("ax");
    ingest.settle_views();
    assert!((ingest.listing_largest() - 100.0).abs() < f64::EPSILON);
    ingest.search("ax-2");
    ingest.settle_views();
    assert!((ingest.listing_largest() - 90.0).abs() < f64::EPSILON);
}

#[test]
fn the_default_sort_lands_below_a_search_with_no_new_listing() {
    let entries = [file("big-note.txt", 900), file("note.txt", 1), file("x", 5)];
    let mut ingest = start(&entries);
    assert_eq!(ingest.parse(2), 2);
    assert_eq!(results(&mut ingest, "note"), ["note.txt", "big-note.txt"]);
    assert_eq!(ingest.parse(1), 1);
    ingest.settle_views();
    let epoch = ingest.views_build_epoch();
    ingest.default_sort();
    ingest.refresh_views();
    assert_eq!(ingest.views_build_epoch(), epoch);
    assert!(!ingest.views_building());
    assert_eq!(shown(&ingest), ["note.txt", "big-note.txt"]);
    assert!(ingest.views().listing_best_match());
    assert_eq!(results(&mut ingest, ""), ["big-note.txt", "x", "note.txt"]);
}

#[test]
fn a_query_replaces_a_default_sort_that_runs_in_steps() {
    let entries: Vec<Entry> = (0..300u32).map(|i| file(format!("f{i}"), i)).collect();
    let mut ingest = parsed(&entries);
    ingest.set_view_step_threshold(1);
    ingest.refresh_views();
    ingest.default_sort();
    ingest.refresh_views();
    assert!(ingest.views_building());
    ingest.search("f29");
    ingest.refresh_views();
    while ingest.views_building() {
        assert!(!ingest.views().listing_best_match());
        ingest.merge_views(1);
    }
    assert!(ingest.views().listing_best_match());
    // Exact, then the rest by size.
    assert_eq!(
        names(&mut ingest),
        [
            "f29", "f299", "f298", "f297", "f296", "f295", "f294", "f293", "f292", "f291", "f290"
        ]
    );
    assert_eq!(results(&mut ingest, "").first().unwrap(), "f299");
}

#[test]
fn a_longer_query_moves_rows_to_their_new_tiers() {
    let entries = [
        file("xab", 10),
        file("abx", 5),
        file("ab", 1),
        file("bz", 90),
        file("ab/z", 70),
    ];
    let mut ingest = parsed(&entries);
    assert_eq!(
        results(&mut ingest, "b"),
        ["bz", "xab", "abx", "ab", "ab/z"]
    );
    assert_eq!(results(&mut ingest, "ab"), ["ab", "abx", "xab", "ab/z"]);
    // Few rows match: the longer query reads only those rows.
    let many: Vec<Entry> = (0..200u32).map(|i| file(format!("n{i}"), 1)).collect();
    let mut ingest = parsed(&[many.as_slice(), entries.as_slice()].concat());
    assert_eq!(results(&mut ingest, "ab"), ["ab", "abx", "xab", "ab/z"]);
    assert_eq!(results(&mut ingest, "ab/"), ["ab/z"]);
    // It does not read the other rows: each step of a budget of 1 reads one
    // row, and few steps make the listing.
    ingest.set_view_step_threshold(1);
    ingest.search("ab");
    ingest.settle_views();
    ingest.search("abx");
    ingest.refresh_views();
    assert!(steps_of(&mut ingest, 1, |_| {}) < 20);
    assert_eq!(shown(&ingest), ["abx"]);
    // Rows that arrive after the shorter query are matched too.
    let mut ingest = start(&[many.as_slice(), entries.as_slice()].concat());
    assert_eq!(ingest.parse(202), 202);
    assert_eq!(results(&mut ingest, "a"), ["abx", "xab"]);
    assert_eq!(ingest.parse(1), 1);
    assert_eq!(results(&mut ingest, "ab"), ["ab", "abx", "xab"]);
    assert_eq!(ingest.parse(1), 1);
    assert_eq!(ingest.parse(1), 1);
    assert_eq!(results(&mut ingest, "ab/"), ["ab/z"]);
}

#[test]
fn a_longer_query_of_many_rows_needs_no_new_sort() {
    let rows = 20_000u32;
    let model: Vec<(Vec<u8>, u32)> = (0..rows)
        .map(|i| {
            let name = match i % 4 {
                0 => format!("d{i}/ab"),
                1 => format!("d{i}/abc{i}"),
                2 => format!("d{i}/xabc{i}/"),
                _ => format!("abc{i}/x{i}"),
            };
            (name.into_bytes(), i.wrapping_mul(2_654_435_761) >> 20)
        })
        .collect();
    let entries: Vec<Entry> = model
        .iter()
        .map(|(name, size)| file(name.clone(), *size))
        .collect();
    let count = usize::try_from(rows).unwrap();
    let mut ingest = parsed(&entries);
    ingest.set_view_step_threshold(1);
    // A sort of all rows.
    ingest.search("a");
    ingest.refresh_views();
    let first = steps_of(&mut ingest, 1024, |_| {});
    assert_eq!(shown(&ingest), expected(&model, count, b"a"));
    // The next keys read the names, then each row of the listing one time.
    for query in ["ab", "abc"] {
        ingest.search(query);
        ingest.refresh_views();
        let before = shown(&ingest);
        let steps = steps_of(&mut ingest, 1024, |ingest| {
            assert_eq!(shown(ingest), before);
        });
        assert_eq!(
            shown(&ingest),
            expected(&model, count, query.as_bytes()),
            "{query}"
        );
        assert!(
            steps * 2 < first,
            "{query}: {steps} steps, the sort has {first}"
        );
    }
    // Rows that wait for a merge are more sorted runs: a longer query reads
    // them and needs no new sort, and no row goes missing.
    let mut ingest = start(&entries);
    assert_eq!(ingest.parse(rows / 2) as usize, count / 2);
    ingest.search("a");
    ingest.settle_views();
    assert_eq!(ingest.parse(rows / 2) as usize, count / 2);
    ingest.refresh_views();
    assert!(ingest.merge_pending());
    ingest.set_view_step_threshold(1);
    ingest.search("ab");
    ingest.refresh_views();
    assert!(ingest.views_building());
    let steps = steps_of(&mut ingest, 1024, |_| {});
    assert_eq!(shown(&ingest), expected(&model, count, b"ab"));
    // A new part has two runs here, so a pass of merges remains. These rows
    // have few passes of a sort, and at 1M rows a sort has twice as many.
    assert!(steps * 3 < first * 2, "{steps} steps, the sort has {first}");
    // A merge that runs goes back to the rows that wait.
    let mut ingest = start(&entries);
    assert_eq!(ingest.parse(rows / 2) as usize, count / 2);
    ingest.search("a");
    ingest.settle_views();
    assert_eq!(ingest.parse(rows / 2) as usize, count / 2);
    ingest.refresh_views();
    assert!(!ingest.merge_views(1));
    ingest.search("abc");
    assert_eq!(names(&mut ingest), expected(&model, count, b"abc"));
    // The rows after the longer query come in by the merge path, also rows of
    // a new tier.
    let mut model = model;
    model.push((b"z/abc".to_vec(), 7));
    model.push((b"abc2".to_vec(), 9));
    let entries: Vec<Entry> = model
        .iter()
        .map(|(name, size)| file(name.clone(), *size))
        .collect();
    let mut ingest = start(&entries);
    assert_eq!(ingest.parse(rows) as usize, count);
    ingest.search("ab");
    ingest.settle_views();
    ingest.set_view_step_threshold(1);
    ingest.search("abc");
    ingest.refresh_views();
    assert!(ingest.views_building());
    assert_eq!(ingest.parse(1), 1);
    ingest.refresh_views();
    assert_eq!(ingest.parse(1), 1);
    ingest.settle_views();
    assert_eq!(shown(&ingest), expected(&model, count + 2, b"abc"));
}

#[test]
fn rows_waiting_tells_when_counted_rows_are_not_in_the_listing() {
    let entries = [
        file("note-1", 1),
        file("note-2", 2),
        file("note-3", 3),
        file("note-4", 4),
    ];
    // Rows wait for a merge in a search with no sort chosen, and in a chosen
    // sort. A merge in steps holds them too, until it ends.
    let mut ingest = start(&entries);
    ingest.search("note");
    ingest.refresh_views();
    assert!(!ingest.views().rows_waiting());
    assert_eq!(ingest.parse(2), 2);
    ingest.refresh_views();
    assert!(ingest.views().rows_waiting());
    assert!(!ingest.merge_views(1));
    assert!(ingest.views().rows_waiting());
    ingest.settle_views();
    assert!(!ingest.views().rows_waiting());
    // A new listing in steps: the old listing misses the rows that waited.
    assert_eq!(ingest.parse(1), 1);
    ingest.refresh_views();
    assert!(ingest.views().rows_waiting());
    ingest.set_view_step_threshold(1);
    ingest.search("e");
    ingest.refresh_views();
    assert!(ingest.views_building());
    assert!(ingest.views().rows_waiting());
    ingest.settle_views();
    assert!(!ingest.views().rows_waiting());
    // A new order of the same rows misses no row, until a new row comes.
    let mut ingest = start(&entries);
    assert_eq!(ingest.parse(3), 3);
    ingest.settle_views();
    assert!(!ingest.views().rows_waiting());
    ingest.set_view_step_threshold(1);
    ingest.sort(SortColumn::Size, true);
    ingest.refresh_views();
    assert!(ingest.views_building());
    assert!(!ingest.views().rows_waiting());
    assert_eq!(ingest.parse(1), 1);
    ingest.refresh_views();
    assert!(ingest.views().rows_waiting());
    ingest.settle_views();
    assert!(!ingest.views().rows_waiting());
    assert_eq!(shown(&ingest), ["note-4", "note-3", "note-2", "note-1"]);
}

#[test]
fn new_rows_go_to_their_tiers_by_the_merge_path() {
    let entries = [
        file("big-note", 900),
        file("a/note", 1),
        file("note/x", 1000),
        file("b/note", 50),
        file("old-note/", 0),
    ];
    let mut ingest = start(&entries);
    ingest.search("note");
    ingest.refresh_views();
    assert_eq!(ingest.parse(1), 1);
    ingest.refresh_views();
    // A new row waits for the merge, also in a listing with no sort chosen.
    assert!(ingest.merge_pending());
    assert_eq!(shown(&ingest), Vec::<String>::new());
    assert_eq!(names(&mut ingest), ["big-note"]);
    assert_eq!(ingest.parse(1), 1);
    assert_eq!(names(&mut ingest), ["a/note", "big-note"]);
    assert_eq!(ingest.parse(2), 2);
    assert_eq!(
        names(&mut ingest),
        ["b/note", "a/note", "big-note", "note/x"]
    );
    assert_eq!(ingest.parse(1), 1);
    assert_eq!(
        names(&mut ingest),
        ["b/note", "a/note", "old-note/", "big-note", "note/x"]
    );
}

#[test]
fn a_merge_in_steps_keeps_the_listing_until_its_last_step() {
    let entries: Vec<Entry> = (0..600u32)
        .map(|i| file(format!("d{}/note{}", i % 7, i % 5), i % 11))
        .collect();
    let model: Vec<(Vec<u8>, u32)> = (0..600u32)
        .map(|i| (format!("d{}/note{}", i % 7, i % 5).into_bytes(), i % 11))
        .collect();
    let mut ingest = start(&entries);
    ingest.search("note1");
    ingest.refresh_views();
    let mut parsed = 0;
    while parsed < 600 {
        parsed += ingest.parse(97) as usize;
        ingest.refresh_views();
        let before = shown(&ingest);
        while ingest.merge_pending() {
            assert_eq!(shown(&ingest), before);
            if ingest.merge_views(1) {
                break;
            }
        }
        assert_eq!(shown(&ingest), expected(&model, parsed, b"note1"));
    }
}

/// A random name from a small alphabet: names and queries then share many
/// parts, and folders and separators at the end are common.
fn random_name(seed: &mut u64) -> Vec<u8> {
    const LETTERS: [&str; 9] = ["a", "a", "A", "b", "B", "/", "/", "\\", "é"];
    let length = next(seed) % 12;
    (0..length)
        .flat_map(|_| LETTERS[next(seed) % LETTERS.len()].bytes())
        .collect()
}

fn next(seed: &mut u64) -> usize {
    *seed ^= *seed << 13;
    *seed ^= *seed >> 7;
    *seed ^= *seed << 17;
    usize::try_from(*seed >> 40).unwrap()
}

#[test]
fn any_batches_budgets_and_queries_give_the_order_of_the_model() {
    let mut seed = 0x51ce_b00d_u64;
    for round in 0..120u32 {
        let count = 5 + next(&mut seed) % 120;
        let model: Vec<(Vec<u8>, u32)> = (0..count)
            .map(|_| {
                let size = u32::try_from(next(&mut seed) % 4).unwrap();
                (random_name(&mut seed), size)
            })
            .collect();
        let entries: Vec<Entry> = model
            .iter()
            .map(|(name, size)| file(name.clone(), *size))
            .collect();
        let mut ingest = start(&entries);
        if round.is_multiple_of(2) {
            ingest.set_view_step_threshold(1);
        }
        let mut query: Vec<u8> = b"a".to_vec();
        ingest.search(&query);
        ingest.refresh_views();
        let mut rows = 0;
        while rows < count {
            rows += ingest.parse(1 + u32::try_from(next(&mut seed) % 40).unwrap()) as usize;
            ingest.refresh_views();
            for _ in 0..next(&mut seed) % 4 {
                ingest.merge_views(1 + next(&mut seed) % 5);
            }
            // Any of: a longer query, another query.
            match next(&mut seed) % 5 {
                0 => query.extend_from_slice(b"b"),
                1 => query = random_name(&mut seed),
                _ => {}
            }
            ingest.search(&query);
            if query.is_empty() {
                query = b"a".to_vec();
                ingest.search(&query);
            }
            ingest.refresh_views();
            if next(&mut seed).is_multiple_of(2) {
                ingest.settle_views();
                assert_eq!(
                    shown(&ingest),
                    expected(&model, rows, &query),
                    "round {round}, {query:?}"
                );
            }
        }
        assert_eq!(
            names(&mut ingest),
            expected(&model, count, &query),
            "round {round}, {query:?}"
        );
    }
}

/// Counts the calls of a budget that a listing needs, with `check` after
/// each call that did not end it.
fn steps_of(
    ingest: &mut Ingest<Vec<u8>>,
    budget: usize,
    mut check: impl FnMut(&Ingest<Vec<u8>>),
) -> usize {
    let mut steps = 0;
    while ingest.views_building() {
        ingest.merge_views(budget);
        steps += 1;
        if ingest.views_building() {
            check(ingest);
        }
    }
    steps
}

#[test]
fn hostile_long_names_make_steps_and_the_old_listing_stays() {
    // Each unit is 64 bytes of a name. A step ends after its budget.
    let long = "a".repeat(60_000);
    let entries: Vec<Entry> = (0..100u32).map(|i| file(format!("{long}{i}"), i)).collect();
    let mut ingest = parsed(&entries);
    ingest.set_view_step_threshold(1);
    ingest.search("zzz");
    ingest.refresh_views();
    // A name with no match has about 940 units.
    assert_eq!(steps_of(&mut ingest, 1024, |_| {}), 50);
    let mut query = long[..1024].to_owned();
    ingest.search(&query);
    ingest.refresh_views();
    // A name with a match also counts its base name: about 1,880 units.
    let steps = steps_of(&mut ingest, 1024, |views| {
        assert_eq!(shown(views), Vec::<String>::new());
    });
    assert!(steps >= 100, "{steps}");
    assert_eq!(shown(&ingest).len(), 100);
    // The largest first: all names are in one tier.
    assert_eq!(&shown(&ingest)[0][60_000..], "99");
    assert_eq!(&shown(&ingest)[99][60_000..], "0");
    // A longer query reads each name again, and each name counts: the steps
    // do not get fewer than for the first query, for a sort of few rows.
    let longer = long[..2048].to_owned();
    ingest.search(&longer);
    ingest.refresh_views();
    let again = steps_of(&mut ingest, 1024, |_| {});
    assert!(again >= 100, "{again}");
    assert_eq!(shown(&ingest).len(), 100);
    // A name with one more letter than each base name: no row matches.
    query = format!("{long}b");
    ingest.search(&query);
    ingest.refresh_views();
    ingest.settle_views();
    assert_eq!(shown(&ingest), Vec::<String>::new());
}

#[test]
fn the_first_hit_in_a_long_folder_part_does_not_end_the_match() {
    let (folder, tail) = ("a".repeat(30_000), "b".repeat(30_000));
    let entries = [
        file(format!("{folder}/{tail}1"), 1),
        file(format!("{folder}/a{tail}2"), 2),
        file(format!("{folder}/z{tail}a3"), 3),
    ];
    let mut ingest = parsed(&entries);
    let ends = |shown: Vec<String>| -> Vec<char> {
        shown
            .iter()
            .map(|name| name.chars().last().unwrap())
            .collect()
    };
    // Only the folder part has this query, so the largest comes first.
    ingest.search("aaaa");
    assert_eq!(ends(names(&mut ingest)), ['3', '2', '1']);
    // Prefix, contains, then only the folder part.
    ingest.search("a");
    assert_eq!(ends(names(&mut ingest)), ['2', '3', '1']);
}

#[test]
fn very_many_matches_make_steps_and_each_row_shows_once() {
    let rows = 50_000u32;
    let entries: Vec<Entry> = (0..rows)
        .map(|i| file(format!("d{}/note-{i}", i % 100), i % 1000))
        .collect();
    let mut ingest = parsed(&entries);
    ingest.set_view_step_threshold(1);
    ingest.search("note");
    ingest.refresh_views();
    let steps = steps_of(&mut ingest, 1024, |_| {});
    assert!(steps >= usize::try_from(rows).unwrap() / 1024, "{steps}");
    let mut listing = ingest.views().listing().to_vec();
    listing.sort_unstable();
    listing.dedup();
    assert_eq!(listing.len(), usize::try_from(rows).unwrap());
    // All rows are in one tier: the largest first, then archive order.
    let first = ingest.views().listing()[0];
    assert_eq!(first, 999);
    assert_eq!(ingest.views().listing()[1], 1999);
}

#[test]
fn the_tree_can_change_while_a_best_match_listing_builds() {
    let entries: Vec<Entry> = (0..3000u32)
        .map(|i| file(format!("d{}/note-{i}", i % 3), i % 10))
        .collect();
    let mut ingest = parsed(&entries);
    ingest.set_view_step_threshold(1);
    ingest.search("note");
    ingest.refresh_views();
    assert!(ingest.views_building());
    let epoch = ingest.views_build_epoch();
    let tree = ingest.views().tree_version();
    // A tree request does not start a listing, and its own change shows.
    assert!(ingest.expand(1, true));
    assert!(ingest.refresh_views());
    assert_ne!(ingest.views().tree_version(), tree);
    assert_eq!(ingest.views_build_epoch(), epoch);
    assert!(ingest.views_building());
    ingest.settle_views();
    assert_eq!(ingest.views().listing().len(), 3000);
}
