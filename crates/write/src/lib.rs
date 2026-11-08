//! The write module: the zstd remux ("save as zstd zip"). The wasm build
//! runs in the lead worker and in the encoder workers of the remux pool.
//! It loads only when the user saves a zstd copy.
//!
//! - [`lead`] reads the central directory and writes the copy in order
//!   with rawzip's writer ([`remux`]).
//! - [`encode`] decodes one entry through rawzip's verifying reader (the
//!   decoders of `zipscope_read`) and compresses it with the C zstd
//!   library.

pub mod encode;
pub mod kind;
pub mod lead;
pub mod out;
pub mod record;
pub mod remux;
mod wasm;

pub use wasm::*;

/// The allocator of the wasm build: dlmalloc with a system part that asks
/// the shared memory budget of the worker before each growth (see
/// `zipscope_heap`).
#[cfg(target_arch = "wasm32")]
#[global_allocator]
static ALLOCATOR: zipscope_heap::Counting<wasm::WriteBudget> = zipscope_heap::Counting::new();

// The wasm build must have SIMD. `.cargo/config.toml` turns it on.
#[cfg(target_arch = "wasm32")]
const _: () = assert!(cfg!(target_feature = "simd128"), "build with +simd128");
