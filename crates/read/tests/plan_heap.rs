//! The plan of a large folder at the memory cap: the planner gives an
//! error, not a trap. This test binary uses the counting allocator, whose
//! native build caps the live heap; a failed allocation that is not
//! fallible aborts the test.

use zipscope_read::heap::{self, Counting};
use zipscope_read::sanitize::Planner;

#[global_allocator]
static ALLOCATOR: Counting = Counting::new();

/// The names of this test are ASCII, so they are their own NFD.
fn nfd(text: &str) -> String {
    text.to_string()
}

#[test]
fn a_plan_that_fills_the_memory_gives_an_error() {
    let mut planner = Planner::new("", nfd).unwrap();
    heap::set_cap(heap::live_bytes() + 8 * 1024 * 1024);
    let mut failed_at = None;
    for row in 0..2_000_000u32 {
        let name = format!("{}{row}.txt", "a".repeat(230));
        if planner.add(row, &name, &name, 0, 8, 0).is_err() {
            failed_at = Some(row);
            break;
        }
    }
    heap::set_cap(usize::MAX);
    let row = failed_at.expect("the cap stops the plan");
    assert!(row > 1000, "the plan stopped too early, at row {row}");
    // The plan keeps the rows before the error.
    assert_eq!(planner.files().len(), row as usize);
}
