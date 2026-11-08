/*
ASSUMED API: see hostile_largest.rs (Ingest::largest_files).

The cost of the largest-files query at scale. The spec designs for
1,000,000 rows. The UI asks for the answer on each frame while the listing
is short, also while parsing. Thus the query must not scan the whole store
for each call, and while parsing its cost must follow the new rows, not
all rows.

The limits are ratios to one plain pass over the store (`one_pass`), which
this test measures on the same machine and build. A pass over the whole
store for each call is about 1 pass each. Each limit is between the true
cost and the cost of a scan.

`mise run test` starts other tests at the same time, so the scheduler can
stop this thread for some milliseconds. A delay makes one measure long. A
scan makes all measures long. Thus the limits of the small folders and of
the answers while parsing fail only when each of their `ROUNDS` measures
is over a limit.

The root loop has one measure and no retry. Its calls take about 1 ms in
all, and a scan for each call costs about 2,000 passes. Its limit is 40
passes (about 500 ms). A delay that fails it must be about 500 times longer
than the loop.
*/

#[path = "support/largest.rs"]
#[allow(dead_code, reason = "Each test binary uses part of the helpers.")]
mod largest;
#[path = "support/zip.rs"]
#[allow(dead_code, reason = "These tests use part of the archive helpers.")]
mod zip;

use largest::{Rng, check, file, folder, reference, start};
use std::hint::black_box;
use std::time::{Duration, Instant};
use zip::Entry;
use zipscope_core::contract::Column;
use zipscope_core::ingest::{Ingest, Status};
use zipscope_core::tree::ROOT;

const ROWS: u32 = 200_000;
/// The calls of a test, as frames ask for them.
const CALLS: u32 = 2_000;
/// The maximum number of measures of a limit. A measure starts only when
/// the measures before it are over the limit.
const ROUNDS: u32 = 5;

fn entries() -> Vec<Entry> {
    let mut rng = Rng(0x1_000_000);
    (0..ROWS)
        .map(|row| {
            let name = format!("g{}/h{}/f{row}", row % 97, row % 13);
            file(name, u32::try_from(rng.below(1 << 31)).unwrap())
        })
        .collect()
}

/// The time of one plain pass over the sizes and folders of all rows: the
/// least work of a query that scans the store.
fn one_pass(ingest: &Ingest<Vec<u8>>) -> Duration {
    (0..5)
        .map(|_| {
            let begin = Instant::now();
            let mut best = 0.0_f64;
            for row in 0..ingest.store().rows() {
                let folder = ingest.tree().row_folder(u32::try_from(row).unwrap());
                let size = ingest.store().value(row, Column::UncompressedSize);
                if folder != u32::MAX && size > best {
                    best = size;
                }
            }
            black_box(best);
            begin.elapsed()
        })
        .min()
        .unwrap()
}

fn parse_all(ingest: &mut Ingest<Vec<u8>>, batch: u32, mut each: impl FnMut(&mut Ingest<Vec<u8>>)) {
    while *ingest.status() == Status::Parsing {
        ingest.parse(batch);
        ingest.refresh_views();
        each(ingest);
    }
    assert_eq!(ingest.status(), &Status::Complete);
}

#[test]
fn repeated_answers_without_new_rows_do_not_scan_the_store() {
    let list = entries();
    let mut ingest = start(&list);
    parse_all(&mut ingest, 8_192, |_| {});
    ingest.settle_views();
    let mut pass = one_pass(&ingest);
    let root = check(&mut ingest, ROOT);
    let begin = Instant::now();
    for call in 0..CALLS {
        assert_eq!(
            black_box(ingest.largest_files(ROOT)).as_deref(),
            Some(root.as_slice())
        );
        // Stop early when the limit is already passed.
        assert!(
            begin.elapsed() < pass * 40,
            "{call} calls took {:?}",
            begin.elapsed()
        );
    }
    let spent = begin.elapsed();
    eprintln!("one pass {pass:?}, {CALLS} root calls {spent:?}");
    assert!(
        spent < pass * 40,
        "{CALLS} calls took {spent:?}, one pass over the store takes {pass:?}"
    );
    // A small folder costs about its own rows. Ask for each folder of the
    // first level in turn: no call may scan the store. The time of a folder
    // is its shortest measure.
    let ids: Vec<u32> = (0..97)
        .map(|index| folder(&ingest, &format!("g{index}")))
        .collect();
    let mut shortest = vec![Duration::MAX; ids.len()];
    for round in 1..=ROUNDS {
        // Each new round uses a new store. If a round used the old store, a
        // cache of old answers could hide a scan.
        if round > 1 {
            ingest = start(&list);
            parse_all(&mut ingest, 8_192, |_| {});
            ingest.settle_views();
        }
        for (id, time) in ids.iter().zip(&mut shortest) {
            let begin = Instant::now();
            black_box(ingest.largest_files(*id));
            black_box(ingest.largest_files(*id));
            *time = begin.elapsed().min(*time);
        }
        // The lowest pass sets the limits. This pass comes directly after the
        // measures, so a load that stops before them cannot raise the limits.
        pass = pass.min(one_pass(&ingest));
        // Each folder has 1/97 of the rows, so the sum is about 1 pass. A scan
        // for each folder makes the sum about 97 passes. The sum does not see
        // a scan in few folders. Thus each folder has a limit too. A folder
        // costs about 1/100 pass and a scan costs about 1 pass.
        let sum = shortest.iter().sum::<Duration>();
        let slow = shortest.iter().filter(|time| **time >= pass / 2).count();
        eprintln!("97 small folders: round {round}, sum {sum:?}, {slow} slow, one pass {pass:?}");
        if sum < pass * 10 && slow == 0 {
            return;
        }
    }
    panic!("the small folders are over a limit in each of the {ROUNDS} rounds");
}

#[test]
fn answers_while_parsing_cost_about_the_new_rows() {
    let list = entries();
    let mut plain = start(&list);
    parse_all(&mut plain, 8_192, |_| {});
    // The answers cost about 1 pass. There are about 780 batches. A new walk
    // of the tree for each batch costs about 20 passes. A scan of the store
    // for each batch costs about 390 passes.
    let limit = one_pass(&plain) * 10;
    drop(plain);

    for round in 1..=ROUNDS {
        let mut asked = start(&list);
        let mut spent = Duration::ZERO;
        let begin = Instant::now();
        parse_all(&mut asked, 256, |ingest| {
            // Stop the answers when the limit is already passed.
            if spent < limit {
                let begin = Instant::now();
                // Four frames for each batch.
                for _ in 0..4 {
                    black_box(ingest.largest_files(ROOT));
                }
                spent += begin.elapsed();
            }
        });
        let whole = begin.elapsed();
        // A true parse costs about 65 passes when quiet and at most 189 under
        // load. A scan for each batch in the parse or in the views costs about
        // 420 passes when quiet and 278 at the lowest. This margin is small.
        // Thus this pass comes directly after the parse, at about the same load.
        let near = one_pass(&asked);
        let ratio = whole.as_secs_f64() / near.as_secs_f64();
        eprintln!(
            "answers while parsing: round {round}, answers {spent:?} of {limit:?}, \
             parse {whole:?}, {ratio:.0} passes of {near:?}"
        );
        if spent < limit && whole < near * 200 {
            asked.settle_views();
            let rows = asked.store().rows();
            assert_eq!(
                asked.largest_files(ROOT),
                Some(reference(&asked, ROOT, rows))
            );
            return;
        }
    }
    panic!("the answers or the parse are over a limit in each of the {ROUNDS} rounds");
}
