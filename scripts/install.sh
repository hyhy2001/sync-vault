#!/usr/bin/env bash
# Install sync-vault into a LOCAL directory — no root, no /etc, no quota-bound
# home. Binary + config live together so the user runs ./sync-vault from there.
#
# Usage:
#   bash scripts/install.sh [TARGET_DIR]
# Defaults TARGET_DIR to ~/sync-vault only as a convenience; pass any path you
# have write access to (e.g. a project dir on a large volume).
set -euo pipefail

cd "$(dirname "$0")/.."

TARGET_DIR="${1:-$PWD/sync-vault}"
BIN_SRC="dist/sync-vault"
CONFIG_EXAMPLE="config/sync_vault_config.example.json"

if [[ ! -f "$BIN_SRC" ]]; then
  echo "error: $BIN_SRC not found — run 'bash scripts/build.sh' first" >&2
  exit 1
fi

mkdir -p "$TARGET_DIR"

echo "Installing binary → ${TARGET_DIR}/sync-vault"
install -m 0755 "$BIN_SRC" "${TARGET_DIR}/sync-vault"

if [[ ! -f "${TARGET_DIR}/sync_vault_config.json" ]]; then
  echo "Installing config → ${TARGET_DIR}/sync_vault_config.json"
  install -m 0600 "$CONFIG_EXAMPLE" "${TARGET_DIR}/sync_vault_config.json"
  echo "  → edit ${TARGET_DIR}/sync_vault_config.json with your connection details"
else
  echo "Config already exists at ${TARGET_DIR}/sync_vault_config.json — left untouched"
fi

echo
echo "Done. Config and audit log live next to the binary in ${TARGET_DIR}."
echo "Run it with:"
echo "  cd ${TARGET_DIR} && ./sync-vault"
echo "or from anywhere:"
echo "  ${TARGET_DIR}/sync-vault            # finds config next to the binary"
echo "  ${TARGET_DIR}/sync-vault --config /path/to/config.json"
