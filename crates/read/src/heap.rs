//! The allocator of the read module and the blocks that a step holds.
//!
//! The allocator is in `zipscope_heap`, which the core module also uses:
//! dlmalloc with a system part that asks the shared memory budget before
//! it grows the wasm memory, and a cap. The read worker sets the cap before
//! each call that can allocate: the most memory that the budget leaves for
//! the read worker. Thus no decode path can grow the memory past the
//! limit, whatever it allocates:
//!
//! - The C zstd library allocates through this allocator (the wasm shim of
//!   zstd-sys), and it reports a null result as a `memory_allocation`
//!   error, so the read fails cleanly.
//! - The large buffers of the read module (output, table, input) use
//!   `try_reserve` (see [`try_buffer`]) and report a failure.
//! - Small allocations of other code (flate2, rawzip) come from a free
//!   region that [`probe`] makes sure of before each step. When the budget
//!   refuses one, it takes its growth from the slack that the worker
//!   reserved (see `zipscope_heap::set_slack`), so it does not trap.
//!
//! The native build uses the cap on the live bytes, for the tests.

pub use zipscope_heap::*;

thread_local! {
    /// Blocks that [`reserve`] holds until [`release`].
    static RESERVED: std::cell::RefCell<Vec<Vec<u8>>> = const { std::cell::RefCell::new(Vec::new()) };
}

/// Allocates and holds one block of `bytes`.
///
/// Thus the wasm memory grows by at most `bytes` in this call. Call it in
/// steps to grow the memory before a large allocation, then call
/// [`release`]: the freed blocks are free heap below the memory size, and
/// the large allocation uses them. Returns false when the block does not
/// fit below the cap.
#[must_use]
pub fn reserve(bytes: usize) -> bool {
    let Ok(block) = try_with_capacity::<u8>(bytes) else {
        return false;
    };
    RESERVED.with(|held| held.borrow_mut().try_push(block).is_ok())
}

/// Frees the blocks of [`reserve`].
pub fn release() {
    RESERVED.with(|held| held.borrow_mut().clear());
}
