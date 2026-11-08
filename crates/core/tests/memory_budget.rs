//! The core at the memory limit. When the
//! budget refuses a growth, a parse batch, a view change and the final
//! checks stop cleanly: no abort, `refused()` is true, and the store and
//! the tree keep all the rows that they have. This test binary uses the
//! counting allocator, whose native build applies the cap to the live heap.

#[path = "support/checks.rs"]
#[allow(dead_code, reason = "These tests use part of the check helpers.")]
mod checks;
#[path = "support/zip.rs"]
#[allow(dead_code, reason = "These tests use part of the archive helpers.")]
mod zip;

use checks::check_tree;
use zip::{Entry, archive, open};
use zipscope_core::contract::health;
use zipscope_core::ingest::{Ingest, Status};
use zipscope_core::query::SortColumn;
use zipscope_core::tree::MAX_FOLDERS;
use zipscope_heap::{self as heap, Counting};

#[global_allocator]
static ALLOCATOR: Counting = Counting::new();

/// The cap and the refusal flag are global, so the tests run one at a time.
static SERIAL: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// The slack of the parse worker (`STORE_GROWTH_SLACK_BYTES`).
const SLACK: usize = 1 << 20;

fn name(row: usize) -> String {
    format!("d{:03}/e{}/f{row:06}.txt", row % 251, row % 7)
}

fn entries(count: usize) -> Vec<Entry> {
    (0..count).map(|row| Entry::new(name(row))).collect()
}

fn bytes(entries: &[Entry]) -> Vec<u8> {
    let hint = u16::try_from(entries.len()).unwrap_or(u16::MAX);
    archive(entries, hint, None).bytes
}

/// Runs `test` with the cap at the live heap and `room` more bytes, and
/// the slack of the worker.
fn at_the_cap<T>(room: usize, test: impl FnOnce() -> T) -> T {
    heap::clear_refused();
    heap::set_slack(SLACK);
    heap::set_cap(heap::live_bytes() + room);
    let result = test();
    heap::set_cap(usize::MAX);
    result
}

/// Parses in batches, as the worker does, until the budget refuses a
/// growth or the parse ends.
fn parse_until_stop(ingest: &mut Ingest<Vec<u8>>) {
    loop {
        ingest.parse(2048);
        ingest.refresh_views();
        while ingest.merge_pending() && !heap::refused() {
            ingest.merge_views(8192);
        }
        if heap::refused() || *ingest.status() != Status::Parsing {
            return;
        }
    }
}

/// The store and the tree hold the same rows, with their names.
fn check_rows(ingest: &Ingest<Vec<u8>>) {
    check_tree(ingest, MAX_FOLDERS);
    for row in 0..ingest.store().rows() {
        assert_eq!(ingest.store().name(row), name(row).as_bytes(), "row {row}");
    }
    assert_eq!(ingest.health().terminal_error, None);
}

#[test]
fn a_parse_at_the_limit_stops_cleanly_with_whole_rows() {
    let _serial = SERIAL
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let count = 60_000;
    let data = bytes(&entries(count));
    for room in [0, 256 << 10, 2 << 20, 5 << 20] {
        let mut ingest = open(data.clone());
        // A name sort makes the merges allocate too.
        ingest.sort(SortColumn::Name, false);
        at_the_cap(room, || parse_until_stop(&mut ingest));
        assert!(heap::refused(), "room {room}");
        // The stop is the hard stop of the worker, not a parse error.
        assert_eq!(ingest.status(), &Status::Parsing, "room {room}");
        assert!(ingest.store().rows() < count, "room {room}");
        check_rows(&ingest);
    }
    heap::clear_refused();
}

#[test]
fn the_control_name_count_at_the_limit_counts_the_whole_rows() {
    let _serial = SERIAL
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    // Every third name has the character, so a count that is not from the
    // kept rows shows.
    let marked = |row: usize| {
        if row.is_multiple_of(3) {
            format!("{}\u{202e}", name(row))
        } else {
            name(row)
        }
    };
    let data = bytes(
        &(0..60_000)
            .map(|row| Entry::new(marked(row)))
            .collect::<Vec<_>>(),
    );
    let mut ingest = open(data);
    ingest.sort(SortColumn::Name, false);
    // Room for the first page (4.25 MiB) and chunk (4 MiB), not for all of
    // the tree and the views.
    at_the_cap(9 << 20, || parse_until_stop(&mut ingest));
    assert!(heap::refused());
    let rows = ingest.store().rows();
    assert!(rows > 0 && rows < 60_000, "{rows} rows");
    let fields = ingest.health_vector();
    let want = u32::try_from(rows.div_ceil(3)).unwrap();
    assert_eq!(fields[health::CONTROL_NAME_ROWS], f64::from(want));
    assert_eq!(fields[health::CONTROL_NAME_EXAMPLE], 0.0);
    for row in 0..rows {
        assert_eq!(
            ingest.store().name(row),
            marked(row).as_bytes(),
            "row {row}"
        );
    }
    heap::clear_refused();
}

#[test]
fn a_view_change_at_the_limit_stops_cleanly() {
    let _serial = SERIAL
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let count = 60_000;
    let mut ingest = open(bytes(&entries(count)));
    heap::clear_refused();
    parse_until_stop(&mut ingest);
    assert_eq!(ingest.status(), &Status::Complete);
    assert!(!heap::refused());
    at_the_cap(16 << 10, || {
        // Each change needs a new listing of thousands of rows.
        ingest.search("f0");
        ingest.refresh_views();
        while ingest.merge_pending() && !heap::refused() {
            ingest.merge_views(8192);
        }
        ingest.sort(SortColumn::Size, true);
        ingest.refresh_views();
    });
    assert!(heap::refused());
    check_rows(&ingest);
    heap::clear_refused();
}

#[test]
fn the_final_checks_at_the_limit_stop_cleanly() {
    let _serial = SERIAL
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    // The offsets go back, so the overlap check sorts all rows after
    // parsing. More than 16,384 rows: the last batch does not run the
    // checks.
    let count = 40_000;
    let mut list = entries(count);
    for (row, entry) in list.iter_mut().enumerate() {
        entry.offset = Some(u32::try_from((count - row) * 64).unwrap());
        entry.compressed = 100;
        entry.size = 100;
    }
    let mut ingest = open(bytes(&list));
    heap::clear_refused();
    while *ingest.status() == Status::Parsing {
        ingest.parse(8192);
    }
    assert_eq!(ingest.status(), &Status::Complete);
    let ended = at_the_cap(16 << 10, || {
        let mut steps = 0;
        while !ingest.finish_checks_step(1 << 16) {
            steps += 1;
            assert!(steps < 10_000, "the checks do not end");
        }
        true
    });
    assert!(ended);
    assert!(heap::refused());
    let health = ingest.health_vector();
    let checked = health[zipscope_core::contract::health::OVERLAPS_CHECKED]
        + health[zipscope_core::contract::health::DUPLICATES_CHECKED];
    assert!(
        checked < 2.0,
        "a check that the limit stopped is not marked as checked"
    );
    heap::clear_refused();
}
