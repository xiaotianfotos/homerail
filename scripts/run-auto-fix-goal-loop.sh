#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -ne 4 ]; then
  echo "usage: run-auto-fix-goal-loop.sh <trusted-checkout> <input.json> <artifact-root> <run-id-prefix>" >&2
  exit 2
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
TRUSTED_CHECKOUT="$(cd "$1" && pwd)"
INPUT_FILE="$(readlink -f "$2")"
ARTIFACT_ROOT="$3"
RUN_ID_PREFIX="$4"
NODE_BIN="${HOMERAIL_NODE_BIN:-node}"

if [ ! -f "$INPUT_FILE" ]; then
  echo "Auto Fix input file does not exist: $INPUT_FILE" >&2
  exit 1
fi
if [[ ! "$RUN_ID_PREFIX" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$ ]]; then
  echo "Auto Fix run ID prefix is invalid." >&2
  exit 1
fi

mkdir -p "$ARTIFACT_ROOT"
ARTIFACT_ROOT="$(cd "$ARTIFACT_ROOT" && pwd)"
cycle=0

while true; do
  cycle=$((cycle + 1))
  cycle_label="$(printf '%04d' "$cycle")"
  cycle_dir="$ARTIFACT_ROOT/cycle-$cycle_label"
  run_id="$RUN_ID_PREFIX-cycle-$cycle_label"
  mkdir -p "$cycle_dir"

  echo "Auto Fix goal cycle $cycle: starting durable DAG run $run_id."
  if ! HOMERAIL_AUTO_FIX_INPUT_FILE="$INPUT_FILE" \
    HOMERAIL_AUTO_FIX_ARTIFACT_DIR="$cycle_dir" \
    HOMERAIL_STABLE_RUN_ID="$run_id" \
    HOMERAIL_AUTO_FIX_TIMEOUT_SECONDS=0 \
    bash "$SCRIPT_DIR/run-auto-fix-stable-runner.sh"; then
    if [ -s "$cycle_dir/checkpoint.json" ] && "$NODE_BIN" -e '
      const fs = require("fs");
      const value = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
      if (value?.recorded !== true) process.exit(1);
    ' "$cycle_dir/checkpoint.json"; then
      echo "Auto Fix DAG $run_id ended after retaining a candidate checkpoint; continuing from it." >&2
      continue
    fi
    if grep -q '^  Failed: ' "$cycle_dir/dag-quick.txt" 2>/dev/null && "$NODE_BIN" -e '
      const fs = require("fs");
      const value = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
      const candidate = value?.checkpoint?.candidate;
      if (
        !candidate || candidate.status !== "fixed"
        || typeof candidate.patch !== "string" || !candidate.patch
      ) process.exit(1);
    ' "$INPUT_FILE"; then
      echo "Auto Fix DAG $run_id failed after hydrating an earlier candidate checkpoint; continuing from it." >&2
      continue
    fi
    echo "Auto Fix DAG $run_id ended before producing an approved candidate." >&2
    exit 1
  fi

  validation_log="$cycle_dir/validation.log"
  if HOMERAIL_NODE_BIN="$NODE_BIN" \
    bash "$SCRIPT_DIR/validate-auto-fix-checkout.sh" \
      "$TRUSTED_CHECKOUT" \
      "$cycle_dir/auto-fix.json" \
      "$cycle_dir/auto-fix.patch" \
      > >(tee "$validation_log") 2>&1; then
    for artifact in \
      auto-fix.json auto-fix.patch auto-fix.md \
      command.json checkpoint.json manager-revision.txt; do
      if [ -f "$cycle_dir/$artifact" ]; then
        cp "$cycle_dir/$artifact" "$ARTIFACT_ROOT/$artifact"
      fi
    done
    printf '%s\n' "$run_id" >"$ARTIFACT_ROOT/run-id.txt"
    printf '%s\n' "$cycle" >"$ARTIFACT_ROOT/cycle-count.txt"
    echo "Auto Fix goal reached after $cycle cycle(s): $run_id."
    exit 0
  fi

  echo "Auto Fix candidate from $run_id failed isolated validation; recording evidence for Qwen3.6 revision."
  "$NODE_BIN" "$SCRIPT_DIR/auto-fix-checkpoint.mjs" record \
    "$INPUT_FILE" "$run_id" "$validation_log" \
    >"$cycle_dir/checkpoint-with-validation.json"
done
