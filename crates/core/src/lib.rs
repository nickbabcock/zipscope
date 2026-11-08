//! Parse-only core: locator, central-directory iteration, store, tree, sort
//! and search, health and limits.

pub mod arena;
pub mod contract;
pub mod entry;
pub mod health;
pub mod ingest;
pub mod largest;
pub mod query;
pub mod store;
#[cfg(test)]
mod testzip;
pub mod text;
pub mod tree;
pub mod view;
mod wasm;
pub mod wrap;

pub use wasm::*;

/// The allocator of the wasm build: dlmalloc with a system part that asks
/// the shared memory budget of the parse worker before each growth (see
/// `zipscope_heap`).
#[cfg(target_arch = "wasm32")]
#[global_allocator]
static ALLOCATOR: zipscope_heap::Counting<wasm::StoreBudget> = zipscope_heap::Counting::new();

// The wasm build must have SIMD. `.cargo/config.toml` turns it on.
#[cfg(target_arch = "wasm32")]
const _: () = assert!(cfg!(target_feature = "simd128"), "build with +simd128");
