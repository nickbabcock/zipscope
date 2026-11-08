/*
The name order of the tree at the memory limit. This binary uses the counting
allocator, whose native build applies the cap to the live heap. When the job has
no room, the tree stays whole and in archive order, and the state says so.
*/

#[path = "support/zip.rs"]
#[allow(dead_code, reason = "These tests use part of the archive helpers.")]
mod zip;

use zip::{Entry, archive, open};
use zipscope_core::ingest::{Ingest, Status};
use zipscope_heap::{self as heap, Counting};

#[global_allocator]
static ALLOCATOR: Counting = Counting::new();

/// The cap and the refusal flag are global, so the tests run one at a time.
static SERIAL: std::sync::Mutex<()> = std::sync::Mutex::new(());

const FOLDERS: u32 = 50_000;

fn parsed() -> Ingest<Vec<u8>> {
    let entries: Vec<Entry> = (0..FOLDERS)
        .map(|n| Entry::new(format!("f{:06}/x", n * 7919 % FOLDERS)))
        .collect();
    let mut ingest = open(archive(&entries, u16::MAX, None).bytes);
    while ingest.status() == &Status::Parsing {
        ingest.parse(4096);
    }
    ingest.refresh_views();
    ingest
}

fn at_the_cap<T>(room: usize, test: impl FnOnce() -> T) -> T {
    heap::clear_refused();
    heap::set_slack(1 << 20);
    heap::set_cap(heap::live_bytes() + room);
    let result = test();
    heap::set_cap(usize::MAX);
    heap::clear_refused();
    result
}

#[test]
fn a_job_with_no_room_leaves_the_tree_in_archive_order() {
    let _serial = SERIAL
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    // The cap applies to the live bytes, and the tree buffers are in them.
    for room in [0, 1024, 100_000] {
        let mut ingest = parsed();
        let archive_order = ingest.views().tree().to_vec();
        let version = ingest.views().tree_version();
        at_the_cap(room, || {
            ingest.start_tree_order();
            assert!(heap::refused(), "room {room}");
            assert!(!ingest.views().tree_in_name_order());
            assert!(!ingest.views().tree_order_pending());
            assert_eq!(ingest.views().tree(), archive_order);
            assert_eq!(ingest.views().tree_version(), version);
            assert!(!ingest.tree_order_step(8192));
        });
        assert_eq!(ingest.store().rows(), FOLDERS as usize);
        assert_eq!(ingest.tree().folder_count(), FOLDERS as usize + 1);
    }
}

/// The job reserves its vectors at the start. Only the ends of the sorted runs
/// grow after that. When they cannot grow, the job stops, and the state says that
/// the tree is in archive order.
#[test]
fn a_job_that_stops_for_memory_keeps_archive_order() {
    let _serial = SERIAL
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let mut ingest = parsed();
    let archive_order = ingest.views().tree().to_vec();
    ingest.set_view_step_threshold(1);
    ingest.start_tree_order();
    assert!(ingest.views().tree_order_pending());
    at_the_cap(0, || {
        for _ in 0..200 {
            assert!(!ingest.tree_order_step(8192));
            if heap::refused() {
                break;
            }
        }
        assert!(heap::refused());
        assert!(ingest.views().tree_order_pending());
        assert!(!ingest.views().tree_in_name_order());
        assert_eq!(ingest.views().tree(), archive_order);
    });
}

/// With room for the job, it lands at the cap. Its memory is all in the first
/// call, except the small ends of the runs.
#[test]
fn a_job_with_room_lands_at_the_cap() {
    let _serial = SERIAL
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let mut ingest = parsed();
    at_the_cap(16 * FOLDERS as usize, || {
        ingest.start_tree_order();
        while ingest.views().tree_order_pending() {
            ingest.tree_order_step(8192);
            assert!(!heap::refused());
        }
        assert!(ingest.views().tree_in_name_order());
    });
}
