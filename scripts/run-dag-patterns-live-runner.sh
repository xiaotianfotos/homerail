#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LIVE_TASK="${HOMERAIL_LIVE_TASK:-patterns}"
RUNNER_BASE="${HOMERAIL_RUNNER_BASE:-$HOME/.homerail-runners}"
HOME_ROOT="${HOMERAIL_LIVE_HOME_BASE:-$RUNNER_BASE/homerail_home}"
ARTIFACT_ROOT="${HOMERAIL_LIVE_ARTIFACTS:-$RUNNER_BASE/artifacts}"
PREFERRED_MANAGER_PORT="${HOMERAIL_MANAGER_PORT:-}"
MODEL_BASE_URL="${HOMERAIL_PATTERN_MODEL_BASE_URL:-}"
MODEL_NAME="${HOMERAIL_PATTERN_MODEL:-qwen3.6}"
MODEL_MAC="${HOMERAIL_PATTERN_MODEL_MAC:-}"
WAKE_MODEL="${HOMERAIL_WAKE_MODEL:-1}"
MODEL_PROTOCOL="${HOMERAIL_PATTERN_MODEL_PROTOCOL:-anthropic_compatible}"
AGENT_TYPE="${HOMERAIL_PATTERN_AGENT_TYPE:-claude-sdk}"
RUN_KEY="${HOMERAIL_LIVE_RUN_KEY:-${GITHUB_RUN_ID:-manual}-${GITHUB_RUN_ATTEMPT:-1}}"
RUN_KEY="$(printf '%s' "$RUN_KEY" | tr -c 'A-Za-z0-9_.-' '-')"
LIVE_SLOT_INPUT="${HOMERAIL_LIVE_SLOT:-}"
LIVE_SLOT="$(printf '%s' "${LIVE_SLOT_INPUT:-legacy}" | tr -c 'A-Za-z0-9_.-' '-')"
LIVE_RUN_LABEL="org.homerail.live_run"
if [ -n "$LIVE_SLOT_INPUT" ]; then
  # Old checkout scripts globally delete the legacy label, so explicit slots use
  # a versioned label that remains safe during the migration.
  LIVE_RUN_LABEL="org.homerail.live_run_v2"
fi

case "$LIVE_SLOT" in
  ""|.|..)
    echo "HOMERAIL_LIVE_SLOT must contain a safe runner slot name." >&2
    exit 1
    ;;
esac

export HOMERAIL_LIVE_SLOT="$LIVE_SLOT"
HOME_BASE="$HOME_ROOT/slots/$LIVE_SLOT"
ARTIFACT_BASE="$ARTIFACT_ROOT/slots/$LIVE_SLOT"
SLOT_BASE="$RUNNER_BASE/slots/$LIVE_SLOT"

case "$LIVE_TASK" in
  patterns|pr-review) ;;
  *)
    echo "Unsupported HOMERAIL_LIVE_TASK: $LIVE_TASK" >&2
    exit 1
    ;;
esac

if [ -z "$MODEL_BASE_URL" ]; then
  echo "HOMERAIL_PATTERN_MODEL_BASE_URL is required for isolated live DAG execution." >&2
  exit 1
fi

export HOMERAIL_HOME="$HOME_BASE/run-$RUN_KEY"
unset HOMERAIL_ASSET_DIR
export HOMERAIL_PATTERN_MODEL="$MODEL_NAME"
export HOMERAIL_PATTERN_MODEL_PROTOCOL="$MODEL_PROTOCOL"
export HOMERAIL_PATTERN_AGENT_TYPE="$AGENT_TYPE"
export HOMERAIL_WORKER_IMAGE="${HOMERAIL_LIVE_WORKER_IMAGE_PREFIX:-homerail-worker:dag-live}-$RUN_KEY"
export HOMERAIL_MANAGER_AGENT_IMAGE="$HOMERAIL_WORKER_IMAGE"
export HOMERAIL_DAG_COMMAND_ALLOWLIST="${HOMERAIL_DAG_COMMAND_ALLOWLIST:-node,git}"
export HOMERAIL_DAG_ALLOW_DYNAMIC_COMMANDS="${HOMERAIL_DAG_ALLOW_DYNAMIC_COMMANDS:-true}"
if [ -z "${HOMERAIL_DAG_APPROVAL_TOKEN:-}" ]; then
  HOMERAIL_DAG_APPROVAL_TOKEN="$(python3 -c 'import secrets; print(secrets.token_hex(32))')"
  export HOMERAIL_DAG_APPROVAL_TOKEN
fi
if [ -z "${HOMERAIL_DAG_MUTATION_TOKEN:-}" ]; then
  HOMERAIL_DAG_MUTATION_TOKEN="$(python3 -c 'import secrets; print(secrets.token_hex(32))')"
  export HOMERAIL_DAG_MUTATION_TOKEN
fi
PERSISTENT_ARTIFACT_DIR="$ARTIFACT_BASE/$RUN_KEY"
REPORT_PATH="$PERSISTENT_ARTIFACT_DIR/dag-patterns-live.json"
UPLOAD_REPORT_PATH="${HOMERAIL_LIVE_REPORT_PATH:-$REPO_ROOT/artifacts/dag-patterns-live.json}"
LOCK_FILE="$SLOT_BASE/dag-patterns-live.lock"

mkdir -p "$RUNNER_BASE" "$SLOT_BASE" "$HOME_BASE" "$PERSISTENT_ARTIFACT_DIR" "$(dirname "$UPLOAD_REPORT_PATH")"
exec 9>"$LOCK_FILE"
if ! flock -w 60 9; then
  echo "Another HomeRail live validation is already running on this runner." >&2
  exit 1
fi
HOMERAIL_CLEANUP_LOCK_HELD=1 "$REPO_ROOT/scripts/cleanup-dag-patterns-live-runner.sh"
mkdir -p "$HOMERAIL_HOME"

cleanup() {
  local exit_code=$?
  set +e
  flock -u 8 2>/dev/null || true
  exec 8>&-
  if [ -x "$REPO_ROOT/homerail_cli/dist/cli.js" ] || [ -f "$REPO_ROOT/homerail_cli/dist/cli.js" ]; then
    node "$REPO_ROOT/homerail_cli/dist/cli.js" runtime stop >/dev/null 2>&1
  fi
  mapfile -t containers < <(docker ps -aq --filter "label=$LIVE_RUN_LABEL=$RUN_KEY" 2>/dev/null)
  if [ "${#containers[@]}" -gt 0 ]; then
    docker rm -f "${containers[@]}" >/dev/null 2>&1
  fi
  mapfile -t images < <(docker images --filter "label=$LIVE_RUN_LABEL=$RUN_KEY" --format "{{.ID}}" | sort -u)
  if [ "${#images[@]}" -gt 0 ]; then
    docker image rm -f "${images[@]}" >/dev/null 2>&1
  fi
  if [ -d "$HOMERAIL_HOME/logs" ]; then
    tar -czf "$PERSISTENT_ARTIFACT_DIR/homerail-logs.tgz" -C "$HOMERAIL_HOME" logs >/dev/null 2>&1
  fi
  if [ -f "$REPORT_PATH" ] && [ "$REPORT_PATH" != "$UPLOAD_REPORT_PATH" ]; then
    cp "$REPORT_PATH" "$UPLOAD_REPORT_PATH"
  fi
  case "$HOMERAIL_HOME" in
    "$HOME_BASE"/run-*) rm -rf "$HOMERAIL_HOME" ;;
    *) echo "Refusing to remove unexpected HOMERAIL_HOME: $HOMERAIL_HOME" >&2 ;;
  esac
  exit "$exit_code"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

model_ready() {
  curl -fsS --connect-timeout 3 --max-time 10 "$MODEL_BASE_URL/v1/models" 2>/dev/null \
    | MODEL_NAME="$MODEL_NAME" python3 -c '
import json, os, sys
try:
    data = json.load(sys.stdin)
except Exception:
    raise SystemExit(1)
raise SystemExit(0 if any(item.get("id") == os.environ["MODEL_NAME"] for item in data.get("data", [])) else 1)
'
}

wait_for_model() {
  local attempts="$1"
  local delay_seconds="$2"
  local attempt
  for attempt in $(seq 1 "$attempts"); do
    if model_ready; then
      return 0
    fi
    if [ "$attempt" -lt "$attempts" ]; then
      sleep "$delay_seconds"
    fi
  done
  return 1
}

port_is_available() {
  local port="$1"
  ! ss -H -ltn "sport = :$port" 2>/dev/null | grep -q .
}

select_manager_port() {
  local preferred="$1"
  local start offset candidate
  if [[ "$preferred" =~ ^[0-9]+$ ]] \
    && [ "$preferred" -ge 20000 ] \
    && [ "$preferred" -le 29999 ] \
    && port_is_available "$preferred"; then
    printf '%s\n' "$preferred"
    return 0
  fi

  start=$((20000 + $(printf '%s' "$RUN_KEY" | cksum | awk '{print $1}') % 10000))
  for offset in $(seq 0 9999); do
    candidate=$((20000 + (start - 20000 + offset) % 10000))
    if port_is_available "$candidate"; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done
  return 1
}

wake_model() {
  if [ -z "$MODEL_MAC" ]; then
    echo "Model host is offline and HOMERAIL_PATTERN_MODEL_MAC is not configured." >&2
    return 1
  fi
  python3 - "$MODEL_MAC" <<'PY'
import socket
import sys
import os

mac = bytes.fromhex(sys.argv[1].replace(":", "").replace("-", ""))
packet = b"\xff" * 6 + mac * 16
sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
sock.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
addresses = os.environ.get("HOMERAIL_PATTERN_MODEL_BROADCASTS", "255.255.255.255")
for address in filter(None, (item.strip() for item in addresses.split(","))):
    sock.sendto(packet, (address, 9))
sock.close()
PY
}

if ! wait_for_model 6 5; then
  if [ "$WAKE_MODEL" != "1" ]; then
    echo "Model $MODEL_NAME is unavailable at $MODEL_BASE_URL and wake_model is disabled." >&2
    exit 1
  fi
  echo "Waking model host for $MODEL_NAME..."
  wake_model
  if ! wait_for_model 60 10; then
    echo "Model $MODEL_NAME did not become ready within 10 minutes." >&2
    exit 1
  fi
fi

requested_live_patterns="${HOMERAIL_LIVE_PATTERNS:-}"
requested_live_patterns=",${requested_live_patterns//[[:space:]]/},"
if [ "$LIVE_TASK" = "patterns" ] \
  && { [ -z "${HOMERAIL_LIVE_PATTERNS:-}" ] || [[ "$requested_live_patterns" == *",issue-diagnosis,"* ]]; }; then
  if [ -z "${HOMERAIL_LIVE_ISSUE_REVISION:-}" ]; then
    HOMERAIL_LIVE_ISSUE_REVISION="$(
      HOME="$HOMERAIL_HOME" \
      USERPROFILE="$HOMERAIL_HOME" \
      XDG_CONFIG_HOME="$HOMERAIL_HOME/.config" \
      GIT_ASKPASS='' \
      GIT_TERMINAL_PROMPT=0 \
      GCM_INTERACTIVE=Never \
      git -c credential.helper= -c http.extraHeader= ls-remote --exit-code \
        https://github.com/xiaotianfotos/homerail.git refs/heads/main \
        | awk 'NR == 1 { print $1 }'
    )"
  fi
  if [[ ! "$HOMERAIL_LIVE_ISSUE_REVISION" =~ ^([0-9a-f]{40}|[0-9a-f]{64})$ ]]; then
    echo "Could not resolve an exact commit for live issue diagnosis." >&2
    exit 1
  fi
  export HOMERAIL_LIVE_ISSUE_REVISION
fi

echo "Building isolated worker image $HOMERAIL_WORKER_IMAGE"
docker build \
  --label "$LIVE_RUN_LABEL=$RUN_KEY" \
  --label "org.homerail.live_slot=$LIVE_SLOT" \
  -t "$HOMERAIL_WORKER_IMAGE" \
  -f "$REPO_ROOT/homerail_worker/Dockerfile" \
  "$REPO_ROOT"

PORT_LOCK_FILE="$RUNNER_BASE/manager-port-allocation.lock"
exec 8>"$PORT_LOCK_FILE"
if ! flock -w 60 8; then
  echo "Could not acquire the Manager port allocation lock." >&2
  exit 1
fi
if ! MANAGER_PORT="$(select_manager_port "$PREFERRED_MANAGER_PORT")"; then
  echo "No free Runner Manager port is available in the 20000-29999 range." >&2
  exit 1
fi
export HOMERAIL_MANAGER_PORT="$MANAGER_PORT"
export HOMERAIL_MANAGER_URL="http://127.0.0.1:$MANAGER_PORT"
if [ -n "$PREFERRED_MANAGER_PORT" ] && [ "$MANAGER_PORT" != "$PREFERRED_MANAGER_PORT" ]; then
  echo "Preferred Runner Manager port $PREFERRED_MANAGER_PORT is busy; using isolated port $MANAGER_PORT."
else
  echo "Using isolated Runner Manager port $MANAGER_PORT."
fi

node "$REPO_ROOT/homerail_cli/dist/cli.js" start --host 0.0.0.0 --no-build-worker-image
flock -u 8
exec 8>&-
SETTING_ID="$(node "$REPO_ROOT/scripts/configure-live-pattern-model.mjs")"

if [ "$LIVE_TASK" = "pr-review" ]; then
  REVIEW_INPUT="${HOMERAIL_PR_REVIEW_INPUT:-}"
  REVIEW_ARTIFACT_DIR="${HOMERAIL_PR_REVIEW_ARTIFACT_DIR:-$REPO_ROOT/artifacts/pr-review}"
  REVIEW_TIMEOUT_SECONDS="${HOMERAIL_PR_REVIEW_TIMEOUT_SECONDS:-3300}"
  if [ -z "$REVIEW_INPUT" ]; then
    echo "HOMERAIL_PR_REVIEW_INPUT is required for the pr-review live task." >&2
    exit 1
  fi
  mkdir -p "$REVIEW_ARTIFACT_DIR"
  command_path="$REVIEW_ARTIFACT_DIR/command.json"
  command_tmp="$command_path.tmp"
  stderr_path="$REVIEW_ARTIFACT_DIR/command.stderr.log"
  rm -f "$command_path" "$command_tmp" "$stderr_path"
  review_args=(
    dag run-template pr-review
    --input "$REVIEW_INPUT"
    --setting-id "$SETTING_ID"
    --wait
    --timeout "$REVIEW_TIMEOUT_SECONDS"
  )
  if ! node "$REPO_ROOT/homerail_cli/dist/cli.js" --json "${review_args[@]}" \
    >"$command_tmp" 2> >(tee "$stderr_path" >&2); then
    rm -f "$command_tmp"
    exit 1
  fi
  mv "$command_tmp" "$command_path"
  [ -s "$stderr_path" ] || rm -f "$stderr_path"
  REVIEW_RUN_ID="$(
    node -e 'const fs=require("fs"); const value=JSON.parse(fs.readFileSync(process.argv[1], "utf8")); if (!value.run_id) process.exit(1); process.stdout.write(String(value.run_id))' \
      "$command_path"
  )"
  REVIEW_STATUS="$(
    node -e 'const fs=require("fs"); const value=JSON.parse(fs.readFileSync(process.argv[1], "utf8")); process.stdout.write(String(value.status ?? "unknown"))' \
      "$command_path"
  )"
  if [ "$REVIEW_STATUS" != "completed" ]; then
    node "$REPO_ROOT/homerail_cli/dist/cli.js" dag quick "$REVIEW_RUN_ID" --events 50 \
      >"$REVIEW_ARTIFACT_DIR/dag-quick.txt" 2>&1 || true
    node "$REPO_ROOT/homerail_cli/dist/cli.js" dag chats "$REVIEW_RUN_ID" --tools 20 --raw-tools \
      >"$REVIEW_ARTIFACT_DIR/dag-chats.txt" 2>&1 || true
    node "$REPO_ROOT/homerail_cli/dist/cli.js" dag handoffs "$REVIEW_RUN_ID" --content-limit 2000 \
      >"$REVIEW_ARTIFACT_DIR/dag-handoffs.txt" 2>&1 || true
  fi
  node "$REPO_ROOT/homerail_cli/dist/cli.js" dag artifact "$REVIEW_RUN_ID" pr-review.json \
    --output "$REVIEW_ARTIFACT_DIR/pr-review.json"
  node "$REPO_ROOT/homerail_cli/dist/cli.js" dag artifact "$REVIEW_RUN_ID" pr-review.md \
    --output "$REVIEW_ARTIFACT_DIR/pr-review.md"
  test -s "$REVIEW_ARTIFACT_DIR/pr-review.json"
  test -s "$REVIEW_ARTIFACT_DIR/pr-review.md"
  node "$REPO_ROOT/scripts/validate-pr-review-artifacts.mjs" \
    "$command_path" \
    "$REVIEW_ARTIFACT_DIR/pr-review.json" \
    "$REVIEW_ARTIFACT_DIR/pr-review.md"
  echo "HomeRail PR Review artifacts: $REVIEW_ARTIFACT_DIR"
  exit 0
fi

validation_args=(
  --base-url "$HOMERAIL_MANAGER_URL"
  --setting-id "$SETTING_ID"
  --expected-model "$MODEL_NAME"
  --workflow-suffix "$RUN_KEY"
  --timeout-ms 360000
  --output "$REPORT_PATH"
)
if [ -n "${HOMERAIL_LIVE_PATTERNS:-}" ]; then
  IFS=',' read -ra requested_patterns <<<"$HOMERAIL_LIVE_PATTERNS"
  for pattern in "${requested_patterns[@]}"; do
    pattern="${pattern//[[:space:]]/}"
    if [ -n "$pattern" ]; then
      validation_args+=(--pattern "$pattern")
    fi
  done
fi

node "$REPO_ROOT/scripts/validate-dag-patterns-live.mjs" "${validation_args[@]}"

cp "$REPORT_PATH" "$UPLOAD_REPORT_PATH"
echo "Live DAG pattern report: $REPORT_PATH"
