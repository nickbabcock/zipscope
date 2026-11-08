#!/bin/sh
set -eu
# Set PDX_TOOLS when pdx-tools is not beside the main checkout.
common=$(git rev-parse --path-format=absolute --git-common-dir)
PDX_TOOLS=${PDX_TOOLS:-$(dirname "$(dirname "$common")")/pdx-tools}
export PDX_BLOB_SOURCE="$PDX_TOOLS/src/wasm-pdx-core/src/blob.rs"
test -f "$PDX_BLOB_SOURCE"
cargo clippy --locked --target wasm32-unknown-unknown --manifest-path web/bench/reader/Cargo.toml -- -D warnings
cargo build --locked --release --target wasm32-unknown-unknown --manifest-path web/bench/reader/Cargo.toml
wasm-bindgen --target web web/bench/reader/target/wasm32-unknown-unknown/release/reader_bench.wasm --out-dir web/bench/reader/pkg
cd web && pnpm exec vitest run --config bench/reader/vitest.config.ts
