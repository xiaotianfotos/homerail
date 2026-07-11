#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
RUNNER_BASE="${HOMERAIL_RUNNER_BASE:-/vol1/1000/homerail_runners}"
HOME_BASE="${HOMERAIL_LIVE_HOME_BASE:-$RUNNER_BASE/homerail_home}"
ARTIFACT_BASE="${HOMERAIL_LIVE_ARTIFACTS:-$RUNNER_BASE/artifacts}"
MANAGER_PORT="${HOMERAIL_MANAGER_PORT:-29191}"
MODEL_BASE_URL="${HOMERAIL_PATTERN_MODEL_BASE_URL:-http://192.168.100.10:5000}"
MODEL_NAME="${HOMERAIL_PATTERN_MODEL:-qwen3.6}"
MODEL_MAC="${HOMERAIL_PATTERN_MODEL_MAC:-}"
WAKE_MODEL="${HOMERAIL_WAKE_MODEL:-1}"
RUN_KEY="${HOMERAIL_LIVE_RUN_KEY:-${GITHUB_RUN_ID:-manual}-${GITHUB_RUN_ATTEMPT:-1}}"
RUN_KEY="$(printf '%s' "$RUN_KEY" | tr -c 'A-Za-z0-9_.-' '-')"

export HOMERAIL_HOME="$HOME_BASE/run-$RUN_KEY"
export HOMERAIL_MANAGER_PORT="$MANAGER_PORT"
export HOMERAIL_MANAGER_URL="http://127.0.0.1:$MANAGER_PORT"
export HOMERAIL_WORKER_IMAGE="${HOMERAIL_LIVE_WORKER_IMAGE_PREFIX:-homerail-worker:dag-live}-$RUN_KEY"
export HOMERAIL_MANAGER_AGENT_IMAGE="$HOMERAIL_WORKER_IMAGE"

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
    | MODEL_NAME="$MODEL_NAME" python3 -c 'import json, os, sys; data=json.load(sys.stdin); raise SystemExit(0 if any(item.get("id") == os.environ["MODEL_NAME"] for item in data.get("data", [])) else 1)'
}

wake_model() {
  if [ -z "$MODEL_MAC" ]; then
    echo "Model host is offline and HOMERAIL_PATTERN_MODEL_MAC is not configured." >&2
    return 1
  fi
  python3 - "$MODEL_MAC" <<'PY'
import socket
import sys

mac = bytes.fromhex(sys.argv[1].replace(":", "").replace("-", ""))
packet = b"\xff" * 6 + mac * 16
sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
sock.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
for address in ("255.255.255.255", "192.168.100.255"):
    sock.sendto(packet, (address, 9))
sock.close()
PY
}

if ! model_ready; then
  if [ "$WAKE_MODEL" != "1" ]; then
    echo "Model $MODEL_NAME is unavailable at $MODEL_BASE_URL and wake_model is disabled." >&2
    exit 1
  fi
  echo "Waking model host for $MODEL_NAME..."
  wake_model
  ready=0
  for _ in $(seq 1 60); do
    if model_ready; then
      ready=1
      break
    fi
    sleep 10
  done
  if [ "$ready" -ne 1 ]; then
    echo "Model $MODEL_NAME did not become ready within 10 minutes." >&2
    exit 1
  fi
fi

if curl -fsS --max-time 3 "$HOMERAIL_MANAGER_URL/health" >/dev/null 2>&1 \
  || ss -H -ltn "sport = :$MANAGER_PORT" | grep -q .; then
  echo "Runner Manager port $MANAGER_PORT is already serving another process; refusing to interfere." >&2
  exit 1
fi

echo "Building isolated worker image $HOMERAIL_WORKER_IMAGE"
docker build \
  --label "org.homerail.live_run=$RUN_KEY" \
  -t "$HOMERAIL_WORKER_IMAGE" \
  -f "$REPO_ROOT/homerail_worker/Dockerfile" \
  "$REPO_ROOT"

node "$REPO_ROOT/homerail_cli/dist/cli.js" start --host 0.0.0.0 --no-build-worker-image
SETTING_ID="$(node "$REPO_ROOT/scripts/configure-live-pattern-model.mjs")"

validation_args=(
  --base-url "$HOMERAIL_MANAGER_URL"
  --setting-id "$SETTING_ID"
  --expected-model "$MODEL_NAME"
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
