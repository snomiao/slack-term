#!/usr/bin/env bash
# Parity test: run the Rust and TS implementations with the same args
# and diff their stdout. Read-only commands only.
#
# Requires: SLACK_MCP_XOXP_TOKEN in env (or via .env / ~/.config/slack-cli/.env.local).
# Rust binary is built on demand into target/release/slack.
# TS impl is invoked via `bun run ts/cli.ts`.

set -euo pipefail

cd "$(dirname "$0")/.."

ROOT="$(pwd)"
OUT_DIR="$(mktemp -d)"
trap 'rm -rf "$OUT_DIR"' EXIT

echo "Building Rust CLI..."
cargo build --release --manifest-path rs/Cargo.toml --bin slack --quiet
RUST="$ROOT/rs/target/release/slack"
TS="bun run $ROOT/ts/cli.ts"

run_pair() {
  local name="$1"
  shift
  local rust_out="$OUT_DIR/rust.$name.out"
  local ts_out="$OUT_DIR/ts.$name.out"
  echo ""
  echo "→ $name: slack $*"
  "$RUST" "$@" > "$rust_out" 2> "$OUT_DIR/rust.$name.err" || true
  # shellcheck disable=SC2086
  $TS "$@" > "$ts_out" 2> "$OUT_DIR/ts.$name.err" || true
  if diff -u "$rust_out" "$ts_out" > "$OUT_DIR/$name.diff"; then
    echo "  ✓ identical"
  else
    echo "  ✗ differ — see $OUT_DIR/$name.diff"
    head -40 "$OUT_DIR/$name.diff"
    return 1
  fi
}

# `news` and `search` are deterministic enough for direct diff under
# normal use. If Slack returns shifted results mid-run the test may
# flake — rerun, and file a bug only if it's reproducible.
run_pair news --limit 5
run_pair search deploy --count 10
# `msgs` depends on channel update times but usually stable within
# a few seconds. Keep it here; allow the user to skip via SKIP_MSGS=1.
if [[ "${SKIP_MSGS:-0}" != "1" ]]; then
  run_pair msgs
fi

echo ""
echo "All parity checks passed."
