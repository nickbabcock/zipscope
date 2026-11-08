/*
The memory of a best-match listing. This binary uses the counting allocator,
whose native build applies the cap to the live heap.

The rules that these tests pin:
- A best-match listing keeps no bytes for each row beyond a listing in a
  chosen sort: after it ends, the views have the same bytes.
- While it builds, it needs no more than a chosen sort of the same rows.
- `Views::allocated_bytes` counts what the rows of a build and a merge hold.
- At the cap, a search stops cleanly and `refused()` is true. It never aborts,
  and the listing that shows does not change.
*/

#[path = "support/zip.rs"]
#[allow(dead_code, reason = "These tests use part of the archive helpers.")]
mod zip;

use zip::{Entry, archive, open};
use zipscope_core::ingest::Ingest;
use zipscope_core::query::SortColumn;
use zipscope_heap::{self as heap, Counting};

#[global_allocator]
static ALLOCATOR: Counting = Counting::new();

/// The cap and the refusal flag are global, so the tests run one at a time.
static SERIAL: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// The slack of the parse worker (`STORE_GROWTH_SLACK_BYTES`).
const SLACK: usize = 1 << 20;
const ROWS: u32 = 60_000;

/// Rows in all four tiers, and folder rows and files in each.
fn entries() -> Vec<Entry> {
    (0..ROWS)
        .map(|row| {
            let name = match row % 6 {
                0 => format!("d{row}/note"),
                1 => format!("d{row}/note-{row}"),
                2 => format!("d{row}/old-note-{row}"),
                3 => format!("note-{row}/x"),
                4 => format!("d{row}/note-{row}/"),
                _ => format!("d{row}/old-note-{row}/"),
            };
            Entry {
                size: row % 1000,
                compressed: row % 1000,
                ..Entry::new(name)
            }
        })
        .collect()
}

fn parsed() -> Ingest<Vec<u8>> {
    let list = entries();
    let mut ingest = open(archive(&list, list.len().try_into().unwrap(), None).bytes);
    assert_eq!(ingest.parse(u32::MAX), ROWS);
    ingest.finish_checks();
    ingest.settle_views();
    ingest
}

/// Runs the listing in steps, and returns the largest live heap on the way.
fn peak_of(ingest: &mut Ingest<Vec<u8>>) -> usize {
    let mut peak = heap::live_bytes();
    ingest.set_view_step_threshold(1);
    ingest.refresh_views();
    peak = peak.max(heap::live_bytes());
    while ingest.merge_pending() {
        ingest.merge_views(512);
        peak = peak.max(heap::live_bytes());
    }
    peak
}

#[test]
fn a_best_match_listing_needs_no_more_than_a_chosen_sort() {
    let _serial = SERIAL
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    heap::set_cap(usize::MAX);
    let mut chosen = parsed();
    chosen.sort(SortColumn::Size, true);
    chosen.search("note");
    let chosen_base = heap::live_bytes();
    let chosen_peak = peak_of(&mut chosen);
    let chosen_end = chosen.views().allocated_bytes();
    assert_eq!(chosen.views().listing().len(), ROWS as usize);
    drop(chosen);

    let mut best = parsed();
    best.search("note");
    let best_base = heap::live_bytes();
    let best_peak = peak_of(&mut best);
    let best_end = best.views().allocated_bytes();
    assert_eq!(best.views().listing().len(), ROWS as usize);
    assert!(best.views().listing_best_match());
    // The live heap of the two ingests differs by no more than a small count.
    assert!(
        best_peak - best_base <= chosen_peak - chosen_base + 4096,
        "best {} chosen {}",
        best_peak - best_base,
        chosen_peak - chosen_base
    );
    // No bytes for each row: 4 bytes for each row of the listing and of its
    // information words, and spare room from the last build.
    assert!(best_end <= chosen_end + 4096, "{best_end} > {chosen_end}");
}

#[test]
fn a_longer_query_needs_one_byte_for_each_row_and_only_while_it_runs() {
    let _serial = SERIAL
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    heap::set_cap(usize::MAX);
    let mut ingest = parsed();
    ingest.search("note");
    let base = heap::live_bytes();
    let first = peak_of(&mut ingest) - base;
    let end = ingest.views().allocated_bytes();
    let base = heap::live_bytes();
    ingest.search("note-");
    let longer = peak_of(&mut ingest) - base;
    assert!(ingest.views().listing_best_match());
    // Less than the sort, also with its byte for each row.
    assert!(longer <= first, "{longer} > {first}");
    // After it, no byte for each row stays.
    assert!(
        ingest.views().allocated_bytes() <= end + 4096,
        "{} > {end}",
        ingest.views().allocated_bytes()
    );
}

#[test]
fn at_the_cap_a_longer_query_stops_cleanly_and_takes_no_slack() {
    let _serial = SERIAL
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let mut refused = 0;
    for room in [8 << 10, 32 << 10, 64 << 10, 96 << 10, 128 << 10, 192 << 10] {
        heap::set_cap(usize::MAX);
        heap::clear_refused();
        let mut ingest = parsed();
        ingest.search("note");
        ingest.settle_views();
        let before = ingest.views().listing().to_vec();
        // All rows matched, so this makes the listing from the old listing.
        ingest.search("note-");
        heap::set_slack(SLACK);
        heap::set_cap(heap::live_bytes() + room);
        ingest.set_view_step_threshold(1);
        ingest.refresh_views();
        while !heap::refused() && ingest.merge_pending() {
            ingest.merge_views(4096);
        }
        heap::set_cap(usize::MAX);
        let slack = heap::slack();
        heap::set_slack(0);
        if heap::refused() {
            refused += 1;
            assert_eq!(ingest.views().listing(), before.as_slice());
            // The growth failed. It did not take the slack, which is only for
            // the allocations that cannot fail.
            assert_eq!(slack, SLACK, "room {room}");
        }
        heap::clear_refused();
    }
    assert!(refused >= 4, "{refused}");
}

#[test]
fn the_count_of_the_views_holds_the_rows_of_a_build() {
    let _serial = SERIAL
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    heap::set_cap(usize::MAX);
    let mut ingest = parsed();
    ingest.search("note");
    ingest.set_view_step_threshold(1);
    ingest.refresh_views();
    let start = heap::live_bytes();
    let counted = ingest.views().allocated_bytes();
    while ingest.views_building() {
        ingest.merge_views(4096);
        // Each byte that the build took since its start is in the count, but
        // for the small boxes of the build.
        let live = heap::live_bytes() - start;
        let more = ingest.views().allocated_bytes().saturating_sub(counted);
        assert!(live <= more + 4096, "live {live}, counted {more}");
    }
}

#[test]
fn at_the_cap_a_search_stops_cleanly_and_the_listing_stays() {
    let _serial = SERIAL
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    for room in [16 << 10, 64 << 10, 128 << 10, 256 << 10, 512 << 10] {
        heap::set_cap(usize::MAX);
        heap::clear_refused();
        let mut ingest = parsed();
        let before = ingest.views().listing().to_vec();
        ingest.search("note");
        heap::set_slack(SLACK);
        heap::set_cap(heap::live_bytes() + room);
        ingest.set_view_step_threshold(1);
        ingest.refresh_views();
        while !heap::refused() && ingest.merge_pending() {
            ingest.merge_views(4096);
        }
        heap::set_cap(usize::MAX);
        if heap::refused() {
            // The worker refuses the request. The listing is the old one.
            assert_eq!(ingest.views().listing(), before.as_slice());
        } else {
            assert_eq!(ingest.views().listing().len(), ROWS as usize);
        }
        heap::clear_refused();
    }
}
