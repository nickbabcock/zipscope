//! Fuzz target for the ingest: archive bytes into the store. See
//! `zipscope_fuzz::ingest` for the checks.
#![no_main]

use libfuzzer_sys::fuzz_target;

fuzz_target!(|data: &[u8]| zipscope_fuzz::ingest(data));
