#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
RUNNER_BASE="${HOMERAIL_RUNNER_BASE:-$HOME/.homerail-runners}"
HOME_BASE="${HOMERAIL_LIVE_HOME_BASE:-$RUNNER_BASE/homerail_home}"
ARTIFACT_BASE="${HOMERAIL_LIVE_ARTIFACTS:-$RUNNER_BASE/artifacts}"
PREFERRED_MANAGER_PORT="${HOMERAIL_MANAGER_PORT:-}"
MODEL_BASE_URL="${HOMERAIL_PATTERN_MODEL_BASE_URL:-}"
MODEL_NAME="${HOMERAIL_PATTERN_MODEL:-qwen3.6}"
MODEL_MAC="${HOMERAIL_PATTERN_MODEL_MAC:-}"
WAKE_MODEL="${HOMERAIL_WAKE_MODEL:-1}"
MODEL_PROTOCOL="${HOMERAIL_PATTERN_MODEL_PROTOCOL:-anthropic_compatible}"
AGENT_TYPE="${HOMERAIL_PATTERN_AGENT_TYPE:-claude-sdk}"
RUN_KEY="${HOMERAIL_LIVE_RUN_KEY:-${GITHUB_RUN_ID:-manual}-${GITHUB_RUN_ATTEMPT:-1}}"
RUN_KEY="$(printf '%s' "$RUN_KEY" | tr -c 'A-Za-z0-9_.-' '-')"

if [ -z "$MODEL_BASE_URL" ]; then
  echo "HOMERAIL_PATTERN_MODEL_BASE_URL is required for live DAG validation." >&2
  exit 1
fi

export HOMERAIL_HOME="$HOME_BASE/run-$RUN_KEY"
export HOMERAIL_PATTERN_MODEL="$MODEL_NAME"
export HOMERAIL_PATTERN_MODEL_PROTOCOL="$MODEL_PROTOCOL"
export HOMERAIL_PATTERN_AGENT_TYPE="$AGENT_TYPE"
export HOMERAIL_WORKER_IMAGE="${HOMERAIL_LIVE_WORKER_IMAGE_PREFIX:-homerail-worker:dag-live}-$RUN_KEY"
export HOMERAIL_MANAGER_AGENT_IMAGE="$HOMERAIL_WORKER_IMAGE"
export HOMERAIL_DAG_COMMAND_ALLOWLIST="${HOMERAIL_DAG_COMMAND_ALLOWLIST:-node}"
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
LOCK_FILE="$RUNNER_BASE/dag-patterns-live.lock"

mkdir -p "$RUNNER_BASE" "$HOME_BASE" "$PERSISTENT_ARTIFACT_DIR" "$(dirname "$UPLOAD_REPORT_PATH")"
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
  if [ -x "$REPO_ROOT/homerail_cli/dist/cli.js" ] || [ -f "$REPO_ROOT/homerail_cli/dist/cli.js" ]; then
    node "$REPO_ROOT/homerail_cli/dist/cli.js" runtime stop >/dev/null 2>&1
  fi
  mapfile -t containers < <(docker ps -aq --filter "label=org.homerail.live_run=$RUN_KEY" 2>/dev/null)
  if [ "${#containers[@]}" -gt 0 ]; then
    docker rm -f "${containers[@]}" >/dev/null 2>&1
  fi
  mapfile -t images < <(docker images --filter "label=org.homerail.live_run=$RUN_KEY" --format "{{.ID}}" | sort -u)
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

echo "Building isolated worker image $HOMERAIL_WORKER_IMAGE"
docker build \
  --label "org.homerail.live_run=$RUN_KEY" \
  -t "$HOMERAIL_WORKER_IMAGE" \
  -f "$REPO_ROOT/homerail_worker/Dockerfile" \
  "$REPO_ROOT"

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
SETTING_ID="$(node "$REPO_ROOT/scripts/configure-live-pattern-model.mjs")"

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
