#!/usr/bin/env bash
# Build the geometry kernel to wasm and copy it into src/geometry/wasm/.
# Requires the Rust toolchain + `rustup target add wasm32-unknown-unknown`.
set -euo pipefail
cd "$(dirname "$0")"
cargo build --target wasm32-unknown-unknown --release
OUT=../src/geometry/wasm
mkdir -p "$OUT"
cp target/wasm32-unknown-unknown/release/whittle_kernel.wasm "$OUT/kernel.wasm"
echo "wrote $OUT/kernel.wasm ($(wc -c < "$OUT/kernel.wasm") bytes)"
