//! The rules of the allocator: the live count, the cap, the slack and the
//! refusal flag. The cap and the slack are global, and the test harness
//! can allocate on other threads while a test runs, so this binary has one
//! test.

use std::alloc::{GlobalAlloc, Layout};

use zipscope_heap::{self as heap, Counting, Full, Room};

#[global_allocator]
static ALLOCATOR: Counting = Counting::new();

const SLACK: usize = 64 * 1024;

#[test]
fn the_cap_the_slack_and_the_refusal_flag() {
    // The live count follows each allocation, growth and free.
    let before = heap::live_bytes();
    let layout = Layout::from_size_align(4096, 8).unwrap();
    // SAFETY: the layout has a non-zero size.
    let pointer = unsafe { ALLOCATOR.alloc(layout) };
    assert_eq!(heap::live_bytes(), before + 4096);
    // SAFETY: the pointer comes from `alloc` with `layout`.
    let pointer = unsafe { ALLOCATOR.realloc(pointer, layout, 8192) };
    assert_eq!(heap::live_bytes(), before + 8192);
    let grown = Layout::from_size_align(8192, 8).unwrap();
    // SAFETY: the pointer comes from `realloc` to 8,192 bytes.
    unsafe { ALLOCATOR.dealloc(pointer, grown) };
    assert_eq!(heap::live_bytes(), before);

    // Below the cap, a vector grows by doubling.
    let mut values: Vec<u64> = vec![0; 1024];
    assert_eq!(values.capacity(), 1024);
    values.room(1).unwrap();
    assert_eq!(values.capacity(), 2048);

    heap::clear_refused();
    heap::set_slack(SLACK);
    heap::set_cap(heap::live_bytes() + 4096);
    // Near the cap, a fallible growth that does not fit fails. It does not
    // take the slack, and the vector does not change.
    let failed = values.room(4096);
    let slack_after_failure = heap::slack();
    let refused_after_failure = heap::refused();
    heap::clear_refused();
    // A step of the exact size fits when the doubling does not.
    let mut small: Vec<u8> = vec![0; 3000];
    let exact = small.room(1000);
    let small_capacity = small.capacity();
    let refused_after_exact = heap::refused();
    // An allocation that cannot fail takes its bytes from the slack.
    let paid = vec![1u8; 16 * 1024];
    let slack_after_paid = heap::slack();
    let refused_after_paid = heap::refused();
    heap::set_cap(usize::MAX);

    assert_eq!(failed, Err(Full));
    assert_eq!(values.len(), 1024);
    assert_eq!(slack_after_failure, SLACK);
    assert!(refused_after_failure);
    assert_eq!(exact, Ok(()));
    assert_eq!(small_capacity, 4000);
    assert!(!refused_after_exact);
    assert_eq!(slack_after_paid, SLACK - 16 * 1024);
    assert!(refused_after_paid);
    assert_eq!(paid.len(), 16 * 1024);
    heap::clear_refused();
}
