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
    # Leave twenty minutes inside the 90-minute Actions job for deterministic
    # cancellation, artifact retrieval, diagnostics, and upload.
    TIMEOUT_SECONDS="${HOMERAIL_PR_REVIEW_TIMEOUT_SECONDS:-4200}"
    PROFILE_SCRIPT="$HOMERAIL_STABLE_RELEASE/scripts/configure-pr-review-runtime-profile.mjs"
    MARKDOWN_SCRIPT="$HOMERAIL_STABLE_RELEASE/scripts/render-pr-review-markdown.mjs"
    ARTIFACT_NAMES=(pr-review.json)
    ;;
  auto-fix)
    INPUT="${HOMERAIL_AUTO_FIX_INPUT:-}"
    INPUT_FILE="${HOMERAIL_AUTO_FIX_INPUT_FILE:-}"
    ARTIFACT_DIR="${HOMERAIL_AUTO_FIX_ARTIFACT_DIR:-${GITHUB_WORKSPACE:-$PWD}/artifacts/auto-fix}"
    TIMEOUT_SECONDS="${HOMERAIL_AUTO_FIX_TIMEOUT_SECONDS:-10800}"
    PROFILE_SCRIPT="$HOMERAIL_STABLE_RELEASE/scripts/configure-auto-fix-runtime-profile.mjs"
    CHECKPOINT_SCRIPT="$HOMERAIL_STABLE_RELEASE/scripts/auto-fix-checkpoint.mjs"
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

if [ -z "$INPUT_FILE" ] && [ -n "$INPUT" ]; then
  INPUT_FILE="$ARTIFACT_DIR/input.json"
  mkdir -p "$ARTIFACT_DIR"
  printf '%s\n' "$INPUT" >"$INPUT_FILE"
  chmod 600 "$INPUT_FILE"
fi
if [ -n "$INPUT_FILE" ]; then
  if [ ! -f "$INPUT_FILE" ]; then
    echo "Structured input file does not exist: $INPUT_FILE" >&2
    exit 1
  fi
  if [ "$TASK" = "auto-fix" ]; then
    "$HOMERAIL_STABLE_NODE" "$CHECKPOINT_SCRIPT" hydrate "$INPUT_FILE"
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
if [ "$TASK" = "pr-review" ]; then
  rm -f "$ARTIFACT_DIR/pr-review.md" "$ARTIFACT_DIR/pr-review.md.tmp"
fi

RUN_ID="${HOMERAIL_STABLE_RUN_ID:-$(
  "$HOMERAIL_STABLE_NODE" -e 'process.stdout.write(require("node:crypto").randomUUID())'
)}"

collect_pr_review_execution_evidence() {
  if [ "$TASK" != "pr-review" ]; then
    return 0
  fi
  "$HOMERAIL_STABLE_NODE" "$HOMERAIL_STABLE_RELEASE/scripts/pr-review-execution-evidence.mjs" \
    "$1" "$ARTIFACT_DIR/pr-review-execution.json" >/dev/null 2>&1 || true
}

collect_run_evidence() {
  local run_id="$1"
  stable_hr dag quick "$run_id" --events 120 >"$ARTIFACT_DIR/dag-quick.txt" 2>&1 || true
  stable_hr dag chats "$run_id" --tools 50 --raw-tools >"$ARTIFACT_DIR/dag-chats.txt" 2>&1 || true
  stable_hr dag handoffs "$run_id" --content-limit 8000 >"$ARTIFACT_DIR/dag-handoffs.txt" 2>&1 || true
  for artifact in "${ARTIFACT_NAMES[@]}"; do
    stable_hr dag artifact "$run_id" "$artifact" --output "$ARTIFACT_DIR/$artifact" >/dev/null 2>&1 || true
  done
  if [ "$TASK" = "auto-fix" ]; then
    for artifact in candidate-v2.json candidate-v2.patch candidate-v1.json candidate-v1.patch; do
      stable_hr dag artifact "$run_id" "$artifact" --output "$ARTIFACT_DIR/$artifact" >/dev/null 2>&1 || true
    done
  fi
  collect_pr_review_execution_evidence "$run_id"
}

render_pr_review_markdown() {
  if [ "$TASK" != "pr-review" ] || [ ! -s "$COMMAND_PATH" ] || [ ! -s "$ARTIFACT_DIR/pr-review.json" ]; then
    return 0
  fi
  "$HOMERAIL_STABLE_NODE" "$MARKDOWN_SCRIPT" \
    "$COMMAND_PATH" \
    "$ARTIFACT_DIR/pr-review.json" \
    "$ARTIFACT_DIR/pr-review-execution.json" \
    >"$ARTIFACT_DIR/pr-review.md.tmp"
  mv "$ARTIFACT_DIR/pr-review.md.tmp" "$ARTIFACT_DIR/pr-review.md"
}

RUN_ARGS=(
  --json dag run-template "$TASK"
  --input "$INPUT"
  --profile "$PROFILE_ID"
  --wait
  --timeout "$TIMEOUT_SECONDS"
  --run-id "$RUN_ID"
)
if ! stable_hr "${RUN_ARGS[@]}" \
  >"$COMMAND_TMP" 2> >(tee "$STDERR_PATH" >&2); then
  if [ -s "$COMMAND_TMP" ]; then
    mv "$COMMAND_TMP" "$ARTIFACT_DIR/command.failed.json"
  else
    rm -f "$COMMAND_TMP"
  fi
  stable_hr stop "$RUN_ID" >/dev/null 2>&1 || true
  collect_run_evidence "$RUN_ID"
  printf '%s\n' "$RUN_ID" >"$ARTIFACT_DIR/run-id.txt"
  printf '%s\n' "$HOMERAIL_STABLE_REVISION" >"$ARTIFACT_DIR/manager-revision.txt"
  if [ "$TASK" = "auto-fix" ]; then
    for _attempt in 1 2 3 4 5; do
      checkpoint_result="$("$HOMERAIL_STABLE_NODE" "$CHECKPOINT_SCRIPT" record "$INPUT_FILE" "$RUN_ID" 2>/dev/null || true)"
      if [[ "$checkpoint_result" == *'"recorded":true'* ]]; then
        printf '%s\n' "$checkpoint_result" >"$ARTIFACT_DIR/checkpoint.json"
        break
      fi
      sleep 1
    done
  fi
  exit 1
fi
mv "$COMMAND_TMP" "$COMMAND_PATH"
[ -s "$STDERR_PATH" ] || rm -f "$STDERR_PATH"

COMPLETED_RUN_ID="$(
  "$HOMERAIL_STABLE_NODE" -e '
    const fs=require("fs");
    const value=JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    if(typeof value.run_id!=="string"||!value.run_id)process.exit(1);
    process.stdout.write(value.run_id);
  ' "$COMMAND_PATH"
)"
if [ "$COMPLETED_RUN_ID" != "$RUN_ID" ]; then
  echo "Stable DAG returned run id $COMPLETED_RUN_ID instead of requested id $RUN_ID." >&2
  collect_run_evidence "$RUN_ID"
  exit 1
fi
RUN_STATUS="$(
  "$HOMERAIL_STABLE_NODE" -e '
    const fs=require("fs");
    const value=JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    process.stdout.write(String(value.status??"unknown"));
  ' "$COMMAND_PATH"
)"

if [ "$RUN_STATUS" != "completed" ]; then
  collect_run_evidence "$RUN_ID"
  render_pr_review_markdown
  if [ "$TASK" = "auto-fix" ]; then
    "$HOMERAIL_STABLE_NODE" "$CHECKPOINT_SCRIPT" record "$INPUT_FILE" "$RUN_ID" >"$ARTIFACT_DIR/checkpoint.json" || true
  fi
  printf '%s\n' "$RUN_ID" >"$ARTIFACT_DIR/run-id.txt"
  printf '%s\n' "$HOMERAIL_STABLE_REVISION" >"$ARTIFACT_DIR/manager-revision.txt"
  echo "$TASK DAG ended with status $RUN_STATUS (run $RUN_ID)." >&2
  exit 1
fi

for artifact in "${ARTIFACT_NAMES[@]}"; do
  stable_hr dag artifact "$RUN_ID" "$artifact" --output "$ARTIFACT_DIR/$artifact"
  test -s "$ARTIFACT_DIR/$artifact"
done
collect_pr_review_execution_evidence "$RUN_ID"
render_pr_review_markdown

case "$TASK" in
  pr-review)
    "$HOMERAIL_STABLE_NODE" "$HOMERAIL_STABLE_RELEASE/scripts/validate-pr-review-artifacts.mjs" \
      "$COMMAND_PATH" \
      "$ARTIFACT_DIR/pr-review.json" \
      "$ARTIFACT_DIR/pr-review.md"
    ;;
  auto-fix)
    "$HOMERAIL_STABLE_NODE" "$HOMERAIL_STABLE_RELEASE/scripts/validate-auto-fix-artifacts.mjs" \
      "$COMMAND_PATH" \
      "$ARTIFACT_DIR/auto-fix.json" \
      "$ARTIFACT_DIR/auto-fix.patch" \
      "$ARTIFACT_DIR/auto-fix.md"
    "$HOMERAIL_STABLE_NODE" "$CHECKPOINT_SCRIPT" record "$INPUT_FILE" "$RUN_ID" >"$ARTIFACT_DIR/checkpoint.json"
    ;;
esac

printf '%s\n' "$RUN_ID" >"$ARTIFACT_DIR/run-id.txt"
printf '%s\n' "$HOMERAIL_STABLE_REVISION" >"$ARTIFACT_DIR/manager-revision.txt"
echo "Stable $TASK artifacts: $ARTIFACT_DIR"
