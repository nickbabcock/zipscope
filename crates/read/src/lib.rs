//! The read module: it finds the data of an entry, checks its local header
//! and decodes it for preview and extraction. The wasm build runs in its own
//! worker, which loads only when the user first previews an entry.

pub mod directory;
pub mod heap;
pub mod local;
pub mod sanitize;
pub mod stream;
#[cfg(test)]
#[path = "../tests/support/zip.rs"]
mod testzip;
#[cfg(feature = "module")]
mod wasm;
pub mod zipout;
pub mod zstd;

#[cfg(feature = "module")]
pub use wasm::*;

#[cfg(all(target_arch = "wasm32", feature = "module"))]
#[global_allocator]
static ALLOCATOR: heap::Counting<wasm::ReadBudget> = heap::Counting::new();

// The wasm build must have SIMD. `.cargo/config.toml` turns it on.
#[cfg(target_arch = "wasm32")]
const _: () = assert!(cfg!(target_feature = "simd128"), "build with +simd128");
