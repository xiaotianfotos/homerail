#!/usr/bin/env bash
set -euo pipefail

PRODUCTION_ROOT="${HOMERAIL_PRODUCTION_ROOT:-$HOME/.local/share/homerail-production}"
CURRENT="$PRODUCTION_ROOT/current"
RELEASE_ROOT="$(readlink -f "$CURRENT")"
HOMERAIL_HOME="${HOMERAIL_HOME:-$HOME/.local/share/homerail-production-data}"
RESOURCE_ROOT="${HOMERAIL_PRODUCTION_RESOURCES:-$HOME/.local/share/homerail-resources}"
MANAGER_URL="${HOMERAIL_PRODUCTION_MANAGER_URL:-http://127.0.0.1:39191}"
UI_URL="${HOMERAIL_PRODUCTION_UI_URL:-https://127.0.0.1:29192}"
NODE="$RELEASE_ROOT/runtime/node"
CLI="$RELEASE_ROOT/homerail_cli/dist/cli.js"
REVISION="$(tr -d '[:space:]' < "$RELEASE_ROOT/REVISION")"

if [[ "$RELEASE_ROOT" != "$PRODUCTION_ROOT"/releases/* ]] \
  || [[ ! "$REVISION" =~ ^[0-9a-f]{40}$ ]] \
  || [ ! -x "$NODE" ] \
  || [ ! -f "$CLI" ]; then
  echo "Production release is incomplete." >&2
  exit 1
fi

export HOMERAIL_HOME
export HOMERAIL_REPO_ROOT="$RELEASE_ROOT"
export HOMERAIL_MANAGER_URL="$MANAGER_URL"
export HOMERAIL_MANAGER_PORT="${HOMERAIL_PRODUCTION_MANAGER_PORT:-39191}"
export HOMERAIL_MANAGER_HOST="${HOMERAIL_PRODUCTION_MANAGER_HOST:-127.0.0.1}"
export HOMERAIL_MANAGER_PUBLIC_URL="${HOMERAIL_PRODUCTION_MANAGER_PUBLIC_URL:-http://127.0.0.1:39191}"
export HOMERAIL_UI_HOST="${HOMERAIL_PRODUCTION_UI_HOST:-0.0.0.0}"
export HOMERAIL_UI_PORT="${HOMERAIL_PRODUCTION_UI_PORT:-29192}"
export HOMERAIL_UI_HTTP_PORT="${HOMERAIL_PRODUCTION_UI_HTTP_PORT:-29193}"
export HOMERAIL_UI_PUBLIC_URL="$UI_URL"
export HOMERAIL_PUBLIC_HOST="${HOMERAIL_PRODUCTION_PUBLIC_HOST:-127.0.0.1}"
export HOMERAIL_UI_SERVE_STATIC=1
export HOMERAIL_WORKER_IMAGE="homerail-worker:production-${REVISION:0:12}"

if ! docker image inspect "$HOMERAIL_WORKER_IMAGE" >/dev/null 2>&1; then
  echo "Production Worker image is missing: $HOMERAIL_WORKER_IMAGE" >&2
  exit 1
fi

mkdir -p "$HOMERAIL_HOME/pids" "$HOMERAIL_HOME/skills"
rm -f \
  "$HOMERAIL_HOME/pids/manager.pid" \
  "$HOMERAIL_HOME/pids/manager.json" \
  "$HOMERAIL_HOME/pids/node.pid" \
  "$HOMERAIL_HOME/pids/ui.pid" \
  "$HOMERAIL_HOME/pids/ui.json" \
  "$HOMERAIL_HOME/pids/ui-https.pid" \
  "$HOMERAIL_HOME/pids/ui-https.json"
rm -f "$HOMERAIL_HOME"/manager/manager-*.pid 2>/dev/null || true

for skill in "$RELEASE_ROOT"/skills/homerail-*; do
  [ -d "$skill" ] || continue
  ln -sfn "$skill" "$HOMERAIL_HOME/skills/$(basename "$skill")"
done
if [ -d "$RESOURCE_ROOT/skills" ]; then
  for skill in "$RESOURCE_ROOT"/skills/*; do
    [ -d "$skill" ] || continue
    destination="$HOMERAIL_HOME/skills/$(basename "$skill")"
    [ -e "$destination" ] || [ -L "$destination" ] || ln -s "$skill" "$destination"
  done
fi

stopping=0
stop_runtime() {
  if [ "$stopping" = "1" ]; then return; fi
  stopping=1
  "$NODE" "$CLI" runtime stop >/dev/null 2>&1 || true
}
trap 'stop_runtime; exit 0' TERM INT
trap 'stop_runtime' EXIT

"$NODE" "$CLI" start --ui --no-build-worker-image

runtime_has_node() {
  curl -fsS --connect-timeout 3 --max-time 10 "$MANAGER_URL/runtime/status" \
    | "$NODE" -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const v=JSON.parse(s);process.exit(Number(v.connected_nodes)>0?0:1)})"
}

failures=0
while sleep 10; do
  if curl -fsS --connect-timeout 3 --max-time 10 "$MANAGER_URL/health" >/dev/null \
    && curl -fkSs --connect-timeout 3 --max-time 10 "$UI_URL/" >/dev/null \
    && runtime_has_node; then
    failures=0
    continue
  fi
  failures=$((failures + 1))
  if [ "$failures" -ge 3 ]; then
    echo "Production service failed three consecutive health checks." >&2
    exit 1
  fi
done
