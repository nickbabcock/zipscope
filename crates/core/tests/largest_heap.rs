/*
ASSUMED API: see hostile_largest.rs (Ingest::largest_files).

The largest-files query at the memory limit. The query is a view request:
on `main`, a view request that cannot grow stops cleanly, `refused()` is
true, and the worker refuses it (`memoryFull()`, then a
`MemoryLimitError`). This binary uses the counting allocator, whose native
build applies the cap to the live heap.

The rules that these tests pin:
- At the cap, the query never aborts. It gives a correct answer, or
  `None` when the budget refused a growth (then `refused()` is true). It
  never gives a part of an answer.
- The store and the tree keep all their rows.
- What the query keeps on the heap grows with the folders and the rows,
  not more: at most 128 bytes for each folder and 16 bytes for each row,
  and 1 MiB.
*/

#[path = "support/checks.rs"]
#[allow(dead_code, reason = "These tests use part of the check helpers.")]
mod checks;
#[path = "support/largest.rs"]
#[allow(dead_code, reason = "Each test binary uses part of the helpers.")]
mod largest;
#[path = "support/zip.rs"]
#[allow(dead_code, reason = "These tests use part of the archive helpers.")]
mod zip;

use checks::check_tree;
use largest::{Rng, agrees, file, shape, start};
use zip::Entry;
use zipscope_core::ingest::{Ingest, Status};
use zipscope_core::tree::{MAX_FOLDERS, ROOT};
use zipscope_heap::{self as heap, Counting};

#[global_allocator]
static ALLOCATOR: Counting = Counting::new();

/// The cap and the refusal flag are global, so the tests run one at a time.
static SERIAL: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// The slack of the parse worker (`STORE_GROWTH_SLACK_BYTES`).
const SLACK: usize = 1 << 20;

fn entries(count: u32) -> Vec<Entry> {
    let mut rng = Rng(0x4a11);
    (0..count)
        .map(|row| {
            let name = format!("d{:03}/e{}/f{row:06}.txt", row % 251, row % 7);
            file(name, u32::try_from(rng.below(1 << 20)).unwrap())
        })
        .collect()
}

/// Each row has its own folder of the second level, so an index for each
/// folder is larger than the slack.
fn many_folders() -> Vec<Entry> {
    (0..30_000_u32)
        .map(|row| file(format!("a{}/b{row}/f", row % 100), row % 977))
        .collect()
}

fn at_the_cap<T>(room: usize, test: impl FnOnce() -> T) -> T {
    heap::clear_refused();
    heap::set_slack(SLACK);
    heap::set_cap(heap::live_bytes() + room);
    let result = test();
    heap::set_cap(usize::MAX);
    result
}

fn folders(ingest: &Ingest<Vec<u8>>) -> Vec<u32> {
    let count = u32::try_from(ingest.tree().folder_count()).unwrap();
    // The root, the first level and a part of the second level.
    (0..count).step_by(7).take(60).chain([ROOT]).collect()
}

#[test]
fn a_query_at_the_limit_gives_a_whole_answer_or_none() {
    let _serial = SERIAL
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    for (list, room) in [entries(60_000), many_folders()]
        .iter()
        .flat_map(|list| [0, 1 << 10, 16 << 10, 256 << 10, 2 << 20].map(|room| (list, room)))
    {
        heap::clear_refused();
        let mut ingest = start(list);
        while *ingest.status() == Status::Parsing {
            ingest.parse(8_192);
            ingest.refresh_views();
        }
        ingest.settle_views();
        let asked = folders(&ingest);
        let answers: Vec<Option<Vec<u32>>> = at_the_cap(room, || {
            asked
                .iter()
                .map(|&folder| ingest.largest_files(folder))
                .collect()
        });
        let refused = heap::refused();
        let rows = ingest.store().rows();
        assert_eq!(rows, list.len());
        for (&folder, answer) in asked.iter().zip(&answers) {
            match answer {
                Some(answer) => {
                    shape(&ingest, folder, rows, answer);
                    assert!(
                        agrees(&ingest, folder, rows, answer),
                        "room {room}, folder {folder}: {answer:?}"
                    );
                }
                None => assert!(refused, "room {room}: no answer for folder {folder}"),
            }
        }
        check_tree(&ingest, MAX_FOLDERS);
    }
    heap::clear_refused();
}

#[test]
fn a_query_while_parsing_at_the_limit_stops_cleanly() {
    let _serial = SERIAL
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let list = entries(60_000);
    for room in [0, 256 << 10, 2 << 20, 5 << 20] {
        heap::clear_refused();
        let mut ingest = start(&list);
        // The checks allocate, so they run after the cap. Keep the
        // answers in room that is reserved before the cap.
        let mut answers: Vec<(u32, usize, Option<Vec<u32>>, bool)> = Vec::with_capacity(4_096);
        at_the_cap(room, || {
            loop {
                ingest.parse(2_048);
                ingest.refresh_views();
                while ingest.merge_pending() && !heap::refused() {
                    ingest.merge_views(8_192);
                }
                for folder in [ROOT, 1, 2] {
                    if (folder as usize) >= ingest.tree().folder_count() {
                        continue;
                    }
                    let rows = ingest.store().rows();
                    let answer = ingest.largest_files(folder);
                    assert!(answers.len() < answers.capacity());
                    answers.push((folder, rows, answer, heap::refused()));
                }
                if heap::refused() || *ingest.status() != Status::Parsing {
                    return;
                }
            }
        });
        for (folder, rows, answer, refused) in &answers {
            match answer {
                Some(answer) => {
                    shape(&ingest, *folder, *rows, answer);
                    assert!(agrees(&ingest, *folder, *rows, answer), "room {room}");
                }
                None => assert!(refused, "room {room}"),
            }
        }
        assert!(heap::refused(), "room {room}");
        assert!(ingest.store().rows() < list.len(), "room {room}");
        check_tree(&ingest, MAX_FOLDERS);
        for (row, entry) in list.iter().enumerate().take(ingest.store().rows()) {
            assert_eq!(ingest.store().name(row), entry.name, "room {room}");
        }
    }
    heap::clear_refused();
}

#[test]
fn the_query_keeps_little_memory_for_each_folder_and_row() {
    let _serial = SERIAL
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    heap::clear_refused();
    let list = many_folders();
    let mut ingest = start(&list);
    while *ingest.status() == Status::Parsing {
        ingest.parse(4_096);
        ingest.refresh_views();
    }
    ingest.settle_views();
    let before = heap::live_bytes();
    let count = u32::try_from(ingest.tree().folder_count()).unwrap();
    let mut answers = 0;
    for folder in 0..count {
        answers += ingest
            .largest_files(folder)
            .map_or(0, |answer| answer.len());
    }
    assert!(answers >= list.len());
    let kept = heap::live_bytes().saturating_sub(before);
    let limit = 128 * count as usize + 16 * list.len() + (1 << 20);
    assert!(
        kept <= limit,
        "the query keeps {kept} bytes for {count} folders and {} rows (limit {limit})",
        list.len()
    );
}
