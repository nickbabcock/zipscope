//! The allocator of the Zipscope wasm modules: a count of the live heap, a
//! cap on the wasm memory and the shared memory budget.
//!
//! The memory budget counts the wasm memory size, which never shrinks. In
//! the wasm build, the allocator is dlmalloc (the allocator of std) with a
//! system part that grows the wasm memory only after the budget lets it
//! (see [`Budget`]). The budget is a counter that the parse worker and the
//! read worker share. Each worker reserves bytes on it before it grows.
//! Thus the total of the two workers cannot pass the hard stop.
//!
//! When the budget refuses a growth, the allocation fails:
//!
//! - In a fallible step ([`fallible`], [`Room`], [`try_buffer`],
//!   [`probe`]), the step gets an error and stops cleanly.
//! - Other allocations (small buffers of std, of wasm-bindgen and of other
//!   crates) cannot fail without a trap. For them, the worker reserves a
//!   small slack on the budget ([`set_slack`]). Such an allocation takes
//!   its growth from the slack, and [`refused`] becomes true. The worker
//!   then stops the work that grows.
//!
//! The native build has no wasm memory. It applies the cap to the live
//! bytes, for the tests, and it has the same slack and refusal rules.

use std::alloc::{GlobalAlloc, Layout};
use std::cell::Cell;
use std::marker::PhantomData;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

static LIVE: AtomicUsize = AtomicUsize::new(0);
static CAP: AtomicUsize = AtomicUsize::new(usize::MAX);
static SLACK: AtomicUsize = AtomicUsize::new(0);
static REFUSED: AtomicBool = AtomicBool::new(false);

thread_local! {
    /// The depth of the fallible steps that run on this thread.
    static FALLIBLE: Cell<u32> = const { Cell::new(0) };
}

/// The shared memory budget of a wasm module. The system part of the
/// allocator calls it before it grows the wasm memory.
pub trait Budget {
    /// True when the allocator keeps the count of the live bytes
    /// ([`live_bytes`]). The count costs a little time for each allocation,
    /// so a module that does not read it can turn it off.
    const LIVE_COUNT: bool = true;

    /// Reserves `bytes` on the budget. Returns false when the budget has
    /// no room for them. Then the memory does not grow.
    fn reserve(bytes: usize) -> bool;
    /// Gives back `bytes` that [`Budget::reserve`] reserved, when the
    /// memory did not grow.
    fn release(bytes: usize);
}

/// A budget that has room for all growth. The native tests and the
/// modules without a budget use it.
#[derive(Debug)]
pub struct Unlimited;

impl Budget for Unlimited {
    fn reserve(_bytes: usize) -> bool {
        true
    }

    fn release(_bytes: usize) {}
}

/// The live heap bytes. It stays 0 when the budget turns the count off
/// ([`Budget::LIVE_COUNT`]). The native cap needs the count.
#[must_use]
pub fn live_bytes() -> usize {
    LIVE.load(Ordering::Relaxed)
}

/// Sets the cap: in the wasm build, the most wasm memory in bytes; in the
/// native build, the most live heap bytes.
pub fn set_cap(bytes: usize) {
    CAP.store(bytes, Ordering::Relaxed);
}

/// The cap that [`set_cap`] set.
#[must_use]
pub fn cap() -> usize {
    CAP.load(Ordering::Relaxed)
}

/// Sets the slack: bytes that the worker reserved on the budget for the
/// allocations that cannot fail. A growth that the budget refuses takes
/// its bytes from the slack.
pub fn set_slack(bytes: usize) {
    SLACK.store(bytes, Ordering::Relaxed);
}

/// The slack that is not used.
#[must_use]
pub fn slack() -> usize {
    SLACK.load(Ordering::Relaxed)
}

/// True when the budget refused a growth since the last
/// [`clear_refused`]: a fallible step failed, or an allocation that cannot
/// fail took its growth from the slack.
#[must_use]
pub fn refused() -> bool {
    REFUSED.load(Ordering::Relaxed)
}

/// Sets [`refused`] to false.
pub fn clear_refused() {
    REFUSED.store(false, Ordering::Relaxed);
}

/// Runs a step whose allocations can fail. In the step, a growth that the
/// budget refuses never takes the slack: the allocation fails.
pub fn fallible<T>(step: impl FnOnce() -> T) -> T {
    struct Depth;
    impl Drop for Depth {
        fn drop(&mut self) {
            FALLIBLE.with(|depth| depth.set(depth.get() - 1));
        }
    }
    FALLIBLE.with(|depth| depth.set(depth.get() + 1));
    let _depth = Depth;
    step()
}

fn in_fallible_step() -> bool {
    FALLIBLE.with(Cell::get) > 0
}

/// Decides about a growth of `bytes` that the budget or the cap refused.
/// Returns true when the slack pays for it.
fn refuse(bytes: usize) -> bool {
    if in_fallible_step() {
        return false;
    }
    REFUSED.store(true, Ordering::Relaxed);
    SLACK
        .try_update(Ordering::Relaxed, Ordering::Relaxed, |slack| {
            slack.checked_sub(bytes)
        })
        .is_ok()
}

/// The budget has no room for a step.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Full;

impl std::fmt::Display for Full {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("The memory limit leaves no room for this step")
    }
}

impl std::error::Error for Full {}

/// The error when a buffer does not fit below the memory limit.
#[must_use]
pub fn limit_error() -> std::io::Error {
    std::io::Error::new(std::io::ErrorKind::OutOfMemory, Full.to_string())
}

/// Sets [`refused`] and returns [`Full`].
fn full() -> Full {
    REFUSED.store(true, Ordering::Relaxed);
    Full
}

/// Fallible growth of a vector. Use it for each vector whose length an
/// archive controls. When the budget has no room, the methods return
/// [`Full`] and set [`refused`]. The vector does not change.
pub trait Room<T> {
    /// Makes sure that `additional` more values fit without growth.
    ///
    /// # Errors
    ///
    /// Returns [`Full`] when the budget has no room.
    fn room(&mut self, additional: usize) -> Result<(), Full>;

    /// Pushes a value.
    ///
    /// # Errors
    ///
    /// Returns [`Full`] when the budget has no room.
    fn try_push(&mut self, value: T) -> Result<(), Full>;

    /// Appends the values.
    ///
    /// # Errors
    ///
    /// Returns [`Full`] when the budget has no room.
    fn try_extend_from_slice(&mut self, values: &[T]) -> Result<(), Full>
    where
        T: Clone;

    /// Resizes the vector to `length`. New values are `value`.
    ///
    /// # Errors
    ///
    /// Returns [`Full`] when the budget has no room.
    fn try_resize(&mut self, length: usize, value: T) -> Result<(), Full>
    where
        T: Clone;
}

impl<T> Room<T> for Vec<T> {
    #[inline]
    fn room(&mut self, additional: usize) -> Result<(), Full> {
        if self.capacity() - self.len() >= additional {
            Ok(())
        } else {
            grow(self, additional)
        }
    }

    #[inline]
    fn try_push(&mut self, value: T) -> Result<(), Full> {
        self.room(1)?;
        self.push(value);
        Ok(())
    }

    #[inline]
    fn try_extend_from_slice(&mut self, values: &[T]) -> Result<(), Full>
    where
        T: Clone,
    {
        self.room(values.len())?;
        self.extend_from_slice(values);
        Ok(())
    }

    #[inline]
    fn try_resize(&mut self, length: usize, value: T) -> Result<(), Full>
    where
        T: Clone,
    {
        self.room(length.saturating_sub(self.len()))?;
        self.resize(length, value);
        Ok(())
    }
}

/// Grows a vector for `additional` more values. It tries the usual
/// doubling first. Near the limit, it tries a step of one eighth of the
/// capacity, and then the exact growth. The rule is in [`grow_with`], which
/// has one copy for all element types.
#[cold]
fn grow<T>(vector: &mut Vec<T>, additional: usize) -> Result<(), Full> {
    let (length, capacity) = (vector.len(), vector.capacity());
    grow_with(length, capacity, additional, &mut |count| {
        vector.try_reserve_exact(count).is_ok()
    })
}

/// The growth rule of [`grow`]. `reserve(count)` tries to reserve room
/// for exactly `count` more values and returns true when it did.
#[cold]
#[inline(never)]
fn grow_with(
    length: usize,
    capacity: usize,
    additional: usize,
    reserve: &mut dyn FnMut(usize) -> bool,
) -> Result<(), Full> {
    let grown = fallible(|| {
        // The doubling of `Vec::try_reserve`, with at least 4 values.
        let doubled = capacity.saturating_mul(2).max(4).saturating_sub(length);
        if doubled > additional && reserve(doubled) {
            return true;
        }
        let step = additional.max(capacity / 8);
        (step > additional && reserve(step)) || reserve(additional)
    });
    if grown { Ok(()) } else { Err(full()) }
}

/// Returns an empty vector with room for `capacity` values.
///
/// # Errors
///
/// Returns [`Full`] when the budget has no room.
pub fn try_with_capacity<T>(capacity: usize) -> Result<Vec<T>, Full> {
    let mut vector = Vec::new();
    vector.room(capacity)?;
    Ok(vector)
}

/// Returns a vector of `length` copies of `value`.
///
/// # Errors
///
/// Returns [`Full`] when the budget has no room.
pub fn try_vec<T: Clone>(value: T, length: usize) -> Result<Vec<T>, Full> {
    let mut vector = Vec::new();
    vector.try_resize(length, value)?;
    Ok(vector)
}

/// Returns a vector of the values of `values`. The iterator must give its
/// exact length in `size_hint`, as slice iterators do.
///
/// # Errors
///
/// Returns [`Full`] when the budget has no room.
pub fn try_collect<T>(values: impl ExactSizeIterator<Item = T>) -> Result<Vec<T>, Full> {
    let mut vector = try_with_capacity(values.len())?;
    vector.extend(values);
    Ok(vector)
}

/// Returns a zeroed buffer of `length` bytes.
///
/// # Errors
///
/// Returns [`limit_error`] when the buffer does not fit below the cap.
pub fn try_buffer(length: usize) -> std::io::Result<Vec<u8>> {
    let mut buffer = try_with_capacity(length).map_err(|_full| limit_error())?;
    buffer.resize(length, 0);
    Ok(buffer)
}

/// Makes sure that `bytes` of heap are free below the cap: it allocates
/// them and frees them, so that the allocator keeps them for the small
/// allocations of the next step.
///
/// # Errors
///
/// Returns [`limit_error`] when the bytes do not fit.
pub fn probe(bytes: usize) -> std::io::Result<()> {
    try_with_capacity::<u8>(bytes)
        .map(drop)
        .map_err(|_full| limit_error())
}

#[cfg(target_arch = "wasm32")]
mod wasm {
    use std::marker::PhantomData;

    use dlmalloc::Allocator;

    use super::Budget;

    pub const PAGE: usize = 64 * 1024;

    /// The system part of dlmalloc: it grows the wasm memory, but not past
    /// the cap, and only after the budget reserved the growth.
    pub struct Capped<B>(pub PhantomData<fn() -> B>);

    // SAFETY: the methods follow the contract of `dlmalloc::Allocator`, as
    // the wasm system part of dlmalloc does: memory that grows is new and
    // zeroed, and it is never given back.
    unsafe impl<B: Budget> Allocator for Capped<B> {
        fn alloc(&self, size: usize) -> (*mut u8, usize, u32) {
            let pages = size.div_ceil(PAGE);
            let bytes = pages.saturating_mul(PAGE);
            let current = core::arch::wasm32::memory_size(0);
            let next = current.saturating_add(pages).saturating_mul(PAGE);
            let from_slack = if next > super::cap() || !B::reserve(bytes) {
                if !super::refuse(bytes) {
                    return (core::ptr::null_mut(), 0, 0);
                }
                true
            } else {
                false
            };
            let previous = core::arch::wasm32::memory_grow(0, pages);
            if previous == usize::MAX {
                if from_slack {
                    super::SLACK.fetch_add(bytes, std::sync::atomic::Ordering::Relaxed);
                } else {
                    B::release(bytes);
                }
                return (core::ptr::null_mut(), 0, 0);
            }
            ((previous * PAGE) as *mut u8, bytes, 0)
        }

        fn remap(&self, _ptr: *mut u8, _old: usize, _new: usize, _can_move: bool) -> *mut u8 {
            core::ptr::null_mut()
        }

        fn free_part(&self, _ptr: *mut u8, _old: usize, _new: usize) -> bool {
            false
        }

        fn free(&self, _ptr: *mut u8, _size: usize) -> bool {
            false
        }

        fn can_release_part(&self, _flags: u32) -> bool {
            false
        }

        fn allocates_zeros(&self) -> bool {
            true
        }

        fn page_size(&self) -> usize {
            PAGE
        }
    }
}

/// The allocator, with a count of the live bytes.
///
/// In the wasm build it is dlmalloc with the capped system part, which
/// asks the budget `B` before each growth. In the native build it is the
/// system allocator with a cap on the live bytes.
pub struct Counting<B: Budget = Unlimited> {
    #[cfg(target_arch = "wasm32")]
    heap: std::cell::UnsafeCell<dlmalloc::Dlmalloc<wasm::Capped<B>>>,
    budget: PhantomData<fn() -> B>,
}

impl<B: Budget> std::fmt::Debug for Counting<B> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Counting")
    }
}

// SAFETY: wasm32-unknown-unknown without the atomics feature has one
// thread, so no two calls use the heap at the same time.
#[cfg(target_arch = "wasm32")]
unsafe impl<B: Budget> Sync for Counting<B> {}

impl<B: Budget> Default for Counting<B> {
    fn default() -> Self {
        Self::new()
    }
}

impl<B: Budget> Counting<B> {
    #[must_use]
    pub const fn new() -> Self {
        Counting {
            #[cfg(target_arch = "wasm32")]
            heap: std::cell::UnsafeCell::new(dlmalloc::Dlmalloc::new_with_allocator(wasm::Capped(
                PhantomData,
            ))),
            budget: PhantomData,
        }
    }

    /// # Safety
    ///
    /// As [`GlobalAlloc::alloc`].
    #[cfg_attr(
        not(target_arch = "wasm32"),
        expect(
            clippy::unused_self,
            reason = "Only the wasm build has a heap in `self`."
        )
    )]
    unsafe fn raw_alloc(&self, layout: Layout, zeroed: bool) -> *mut u8 {
        #[cfg(target_arch = "wasm32")]
        {
            // SAFETY: one thread uses the heap (see the `Sync` impl).
            let heap = unsafe { &mut *self.heap.get() };
            if zeroed {
                // SAFETY: the layout is valid by the contract of the caller.
                unsafe { heap.calloc(layout.size(), layout.align()) }
            } else {
                // SAFETY: the layout is valid by the contract of the caller.
                unsafe { heap.malloc(layout.size(), layout.align()) }
            }
        }
        #[cfg(not(target_arch = "wasm32"))]
        {
            if LIVE.load(Ordering::Relaxed).saturating_add(layout.size()) > cap()
                && !refuse(layout.size())
            {
                return std::ptr::null_mut();
            }
            if zeroed {
                // SAFETY: the layout is valid by the contract of the caller.
                unsafe { std::alloc::System.alloc_zeroed(layout) }
            } else {
                // SAFETY: the layout is valid by the contract of the caller.
                unsafe { std::alloc::System.alloc(layout) }
            }
        }
    }

    /// # Safety
    ///
    /// As [`GlobalAlloc::dealloc`].
    #[cfg_attr(
        not(target_arch = "wasm32"),
        expect(
            clippy::unused_self,
            reason = "Only the wasm build has a heap in `self`."
        )
    )]
    unsafe fn raw_free(&self, ptr: *mut u8, layout: Layout) {
        #[cfg(target_arch = "wasm32")]
        {
            // SAFETY: one thread uses the heap (see the `Sync` impl).
            let heap = unsafe { &mut *self.heap.get() };
            // SAFETY: the pointer comes from this allocator with this layout.
            unsafe { heap.free(ptr, layout.size(), layout.align()) };
        }
        #[cfg(not(target_arch = "wasm32"))]
        // SAFETY: the pointer comes from the system allocator with this layout.
        unsafe {
            std::alloc::System.dealloc(ptr, layout);
        }
    }
}

// SAFETY: each method calls dlmalloc or the system allocator with the
// arguments of the caller and only adds a count.
unsafe impl<B: Budget> GlobalAlloc for Counting<B> {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        // SAFETY: the caller keeps the contract of `GlobalAlloc::alloc`.
        let pointer = unsafe { self.raw_alloc(layout, false) };
        if B::LIVE_COUNT && !pointer.is_null() {
            LIVE.fetch_add(layout.size(), Ordering::Relaxed);
        }
        pointer
    }

    unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
        // SAFETY: the caller keeps the contract of `GlobalAlloc::alloc_zeroed`.
        let pointer = unsafe { self.raw_alloc(layout, true) };
        if B::LIVE_COUNT && !pointer.is_null() {
            LIVE.fetch_add(layout.size(), Ordering::Relaxed);
        }
        pointer
    }

    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        // SAFETY: the caller keeps the contract of `GlobalAlloc::dealloc`.
        unsafe { self.raw_free(ptr, layout) };
        if B::LIVE_COUNT {
            LIVE.fetch_sub(layout.size(), Ordering::Relaxed);
        }
    }

    unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
        #[cfg(target_arch = "wasm32")]
        // SAFETY: one thread uses the heap, and the caller keeps the
        // contract of `GlobalAlloc::realloc`.
        let moved =
            unsafe { (*self.heap.get()).realloc(ptr, layout.size(), layout.align(), new_size) };
        #[cfg(not(target_arch = "wasm32"))]
        let moved = {
            let grows = new_size.saturating_sub(layout.size());
            if LIVE.load(Ordering::Relaxed).saturating_add(grows) > cap() && !refuse(grows) {
                return std::ptr::null_mut();
            }
            // SAFETY: the caller keeps the contract of `GlobalAlloc::realloc`.
            unsafe { std::alloc::System.realloc(ptr, layout, new_size) }
        };
        if B::LIVE_COUNT && !moved.is_null() {
            LIVE.fetch_add(new_size, Ordering::Relaxed);
            LIVE.fetch_sub(layout.size(), Ordering::Relaxed);
        }
        moved
    }
}
