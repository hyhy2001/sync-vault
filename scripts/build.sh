#!/usr/bin/env bash
# Build a single self-contained binary for RHEL8 (x86_64, glibc 2.28+).
set -euo pipefail

cd "$(dirname "$0")/.."

OUT_DIR="dist"
OUT_BIN="${OUT_DIR}/sync-vault"
TARGET="${1:-bun-linux-x64}"

mkdir -p "$OUT_DIR"

echo "Building sync-vault → ${OUT_BIN} (target: ${TARGET})"
bun build src/cli.tsx \
  --compile \
  --target="$TARGET" \
  --minify \
  --outfile "$OUT_BIN"

chmod +x "$OUT_BIN"
echo "Done: $(du -h "$OUT_BIN" | cut -f1) → ${OUT_BIN}"
echo "Run on RHEL8 with: ./${OUT_BIN}"
