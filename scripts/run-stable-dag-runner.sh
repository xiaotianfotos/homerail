#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/lib/stable-automation-runtime.sh"
initialize_stable_automation_runtime

TASK="${HOMERAIL_STABLE_TASK:-}"
case "$TASK" in
  pr-review)
    INPUT="${HOMERAIL_PR_REVIEW_INPUT:-}"
    INPUT_FILE="${HOMERAIL_PR_REVIEW_INPUT_FILE:-}"
    ARTIFACT_DIR="${HOMERAIL_PR_REVIEW_ARTIFACT_DIR:-${GITHUB_WORKSPACE:-$PWD}/artifacts/pr-review}"
    TIMEOUT_SECONDS="${HOMERAIL_PR_REVIEW_TIMEOUT_SECONDS:-5400}"
    PROFILE_SCRIPT="$HOMERAIL_STABLE_RELEASE/scripts/configure-pr-review-runtime-profile.mjs"
    ARTIFACT_NAMES=(pr-review.json pr-review.md pr-privacy-review.json)
    ;;
  auto-fix)
    INPUT="${HOMERAIL_AUTO_FIX_INPUT:-}"
    INPUT_FILE="${HOMERAIL_AUTO_FIX_INPUT_FILE:-}"
    ARTIFACT_DIR="${HOMERAIL_AUTO_FIX_ARTIFACT_DIR:-${GITHUB_WORKSPACE:-$PWD}/artifacts/auto-fix}"
    TIMEOUT_SECONDS="${HOMERAIL_AUTO_FIX_TIMEOUT_SECONDS:-10800}"
    PROFILE_SCRIPT="$HOMERAIL_STABLE_RELEASE/scripts/configure-auto-fix-runtime-profile.mjs"
    ARTIFACT_NAMES=(auto-fix.json auto-fix.patch auto-fix.md)
    ;;
  *)
    echo "HOMERAIL_STABLE_TASK must be pr-review or auto-fix." >&2
    exit 1
    ;;
esac

# Sync from the deployed release before binding its private runtime profile.
# Both operations are durable in the one stable Manager database.
stable_hr dag sync "$TASK" >/dev/null
PROFILE_ID="$("$HOMERAIL_STABLE_NODE" "$PROFILE_SCRIPT")"

if [ -n "$INPUT_FILE" ]; then
  if [ ! -f "$INPUT_FILE" ]; then
    echo "Structured input file does not exist: $INPUT_FILE" >&2
    exit 1
  fi
  INPUT="$(<"$INPUT_FILE")"
fi
if [ -z "$INPUT" ]; then
  echo "Structured input is required for $TASK." >&2
  exit 1
fi
if [[ ! "$TIMEOUT_SECONDS" =~ ^[0-9]+$ ]] || [ "$TIMEOUT_SECONDS" -lt 60 ] || [ "$TIMEOUT_SECONDS" -gt 14400 ]; then
  echo "Stable DAG timeout must be an integer from 60 through 14400 seconds." >&2
  exit 1
fi

mkdir -p "$ARTIFACT_DIR"
COMMAND_PATH="$ARTIFACT_DIR/command.json"
COMMAND_TMP="$COMMAND_PATH.tmp"
STDERR_PATH="$ARTIFACT_DIR/command.stderr.log"
rm -f "$COMMAND_PATH" "$COMMAND_TMP" "$STDERR_PATH"

RUN_ARGS=(
  --json dag run-template "$TASK"
  --input "$INPUT"
  --profile "$PROFILE_ID"
  --wait
  --timeout "$TIMEOUT_SECONDS"
)
if [ -n "${HOMERAIL_STABLE_RUN_ID:-}" ]; then
  RUN_ARGS+=(--run-id "$HOMERAIL_STABLE_RUN_ID")
fi
if ! stable_hr "${RUN_ARGS[@]}" \
  >"$COMMAND_TMP" 2> >(tee "$STDERR_PATH" >&2); then
  rm -f "$COMMAND_TMP"
  exit 1
fi
mv "$COMMAND_TMP" "$COMMAND_PATH"
[ -s "$STDERR_PATH" ] || rm -f "$STDERR_PATH"

RUN_ID="$(
  "$HOMERAIL_STABLE_NODE" -e '
    const fs=require("fs");
    const value=JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    if(typeof value.run_id!=="string"||!value.run_id)process.exit(1);
    process.stdout.write(value.run_id);
  ' "$COMMAND_PATH"
)"
RUN_STATUS="$(
  "$HOMERAIL_STABLE_NODE" -e '
    const fs=require("fs");
    const value=JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    process.stdout.write(String(value.status??"unknown"));
  ' "$COMMAND_PATH"
)"

if [ "$RUN_STATUS" != "completed" ]; then
  stable_hr dag quick "$RUN_ID" --events 80 >"$ARTIFACT_DIR/dag-quick.txt" 2>&1 || true
  stable_hr dag chats "$RUN_ID" --tools 30 --raw-tools >"$ARTIFACT_DIR/dag-chats.txt" 2>&1 || true
  stable_hr dag handoffs "$RUN_ID" --content-limit 4000 >"$ARTIFACT_DIR/dag-handoffs.txt" 2>&1 || true
  echo "$TASK DAG ended with status $RUN_STATUS (run $RUN_ID)." >&2
  exit 1
fi

for artifact in "${ARTIFACT_NAMES[@]}"; do
  stable_hr dag artifact "$RUN_ID" "$artifact" --output "$ARTIFACT_DIR/$artifact"
  test -s "$ARTIFACT_DIR/$artifact"
done

case "$TASK" in
  pr-review)
    "$HOMERAIL_STABLE_NODE" "$HOMERAIL_STABLE_RELEASE/scripts/validate-pr-review-artifacts.mjs" \
      "$COMMAND_PATH" \
      "$ARTIFACT_DIR/pr-review.json" \
      "$ARTIFACT_DIR/pr-review.md" \
      "$ARTIFACT_DIR/pr-privacy-review.json"
    ;;
  auto-fix)
    "$HOMERAIL_STABLE_NODE" "$HOMERAIL_STABLE_RELEASE/scripts/validate-auto-fix-artifacts.mjs" \
      "$COMMAND_PATH" \
      "$ARTIFACT_DIR/auto-fix.json" \
      "$ARTIFACT_DIR/auto-fix.patch" \
      "$ARTIFACT_DIR/auto-fix.md"
    ;;
esac

printf '%s\n' "$RUN_ID" >"$ARTIFACT_DIR/run-id.txt"
printf '%s\n' "$HOMERAIL_STABLE_REVISION" >"$ARTIFACT_DIR/manager-revision.txt"
echo "Stable $TASK artifacts: $ARTIFACT_DIR"
