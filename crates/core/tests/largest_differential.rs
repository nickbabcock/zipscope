//! The two paths of the largest files: the
//! result that the views publish for the listed folder, and the native
//! `Ingest::largest_files`. Both use `largest::Largest`, but only the views
//! have `show` and its rule for the result of an earlier folder. Thus a
//! change to one path must not go unnoticed.
//!
//! Each seeded archive parses in random batches. Between the batches come
//! random `list` and `sort` calls and `merge_views` calls with small
//! budgets, and a small step threshold makes the listings build in steps.
//! After each step, the published result must obey `shape` for the folder
//! of the permutation. When no work waits, it must agree with the
//! reference. While the published folder does not change, a result that
//! showed must not go away (this catches a stale earlier result). After
//! `settle_views`, the published result of each folder must be the native
//! answer, and the native answer must agree with the reference.

#[path = "support/largest.rs"]
#[allow(dead_code, reason = "This test uses part of the helpers.")]
mod largest;
#[path = "support/zip.rs"]
#[allow(dead_code, reason = "This test uses part of the archive helpers.")]
mod zip;

use std::fmt::Write as _;

use largest::{Rng, agrees, check, file, shape, start};
use zip::Entry;
use zipscope_core::contract::NONE;
use zipscope_core::ingest::{Ingest, Status};
use zipscope_core::query::SortColumn;
use zipscope_core::tree::MAX_DEPTH;

fn entries(rng: &mut Rng) -> Vec<Entry> {
    let deep = rng.below(3) == 0;
    let count = 50 + rng.index(250);
    (0..count)
        .map(|index| {
            let depth = if deep && rng.below(20) == 0 {
                MAX_DEPTH + 1 + rng.index(10)
            } else {
                rng.index(5)
            };
            let mut name = String::new();
            for _ in 0..depth {
                write!(name, "{}/", rng.below(3)).unwrap();
            }
            match rng.below(8) {
                // A folder entry, also a second one for the same folder.
                0 => name.push('/'),
                // Long names make a name sort cost more than the scan, so a
                // listing can still build when its scan ended.
                _ => write!(name, "{}{index}", "f".repeat(300)).unwrap(),
            }
            // Many equal sizes and 0-byte files.
            file(name, rng.small(6) * 100)
        })
        .collect()
}

#[test]
fn the_views_and_the_native_query_give_the_same_files() {
    for seed in 1..=60u64 {
        let mut rng = Rng(seed.wrapping_mul(0x9e37_79b9_7f4a_7c15) | 1);
        let entries = entries(&mut rng);
        let mut ingest = start(&entries);
        ingest.set_view_step_threshold(1 + rng.index(48));
        if rng.below(2) == 0 {
            ingest.sort(SortColumn::Name, false);
        }
        // The folder whose result showed, while it stays published.
        let mut held = NONE;
        let mut published = |ingest: &Ingest<Vec<u8>>| {
            let folder = ingest.views().permutation_folder();
            let rows = ingest.views().largest_files().to_vec();
            if folder != held {
                held = NONE;
            }
            if folder == NONE {
                assert_eq!(rows, Vec::<u32>::new(), "seed {seed}: search results");
                return;
            }
            let count = ingest.store().rows();
            shape(ingest, folder, count, &rows);
            assert!(
                held == NONE || !rows.is_empty(),
                "seed {seed}: the result of folder {folder} went away"
            );
            if !ingest.merge_pending() {
                assert!(
                    agrees(ingest, folder, count, &rows),
                    "seed {seed}, folder {folder}"
                );
            }
            if !rows.is_empty() {
                held = folder;
            }
        };
        while *ingest.status() == Status::Parsing {
            ingest.parse(1 + rng.small(40));
            ingest.refresh_views();
            published(&ingest);
            for _ in 0..=rng.index(4) {
                let folders = u64::try_from(ingest.tree().folder_count()).unwrap();
                ingest.list(u32::try_from(rng.below(folders)).unwrap());
                ingest.refresh_views();
                published(&ingest);
            }
            if rng.below(5) == 0 {
                let column =
                    [SortColumn::Name, SortColumn::Size, SortColumn::Archive][rng.index(3)];
                ingest.sort(column, rng.below(2) == 0);
                ingest.refresh_views();
                published(&ingest);
            }
            for _ in 0..=rng.index(4) {
                ingest.merge_views(1 + rng.index(30));
                published(&ingest);
            }
            if rng.below(4) == 0 {
                // The native query of another folder while parsing.
                let folders = u64::try_from(ingest.tree().folder_count()).unwrap();
                check(&mut ingest, u32::try_from(rng.below(folders)).unwrap());
            }
        }
        ingest.settle_views();
        let folders = u32::try_from(ingest.tree().folder_count()).unwrap();
        for folder in 0..folders {
            ingest.list(folder);
            ingest.settle_views();
            assert_eq!(ingest.views().permutation_folder(), folder, "seed {seed}");
            let native = check(&mut ingest, folder);
            assert_eq!(
                ingest.views().largest_files(),
                native.as_slice(),
                "seed {seed}, folder {folder}"
            );
        }
    }
}
