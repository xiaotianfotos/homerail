#!/usr/bin/env bash
set -euo pipefail

PRODUCTION_ROOT="${HOMERAIL_PRODUCTION_ROOT:-$HOME/.local/share/homerail-production}"
CURRENT="$PRODUCTION_ROOT/current"
RELEASE_ROOT="$(readlink -f "$CURRENT")"
HOMERAIL_HOME="${HOMERAIL_HOME:-$HOME/.local/share/homerail-production-data}"
RESOURCE_ROOT="${HOMERAIL_PRODUCTION_RESOURCES:-$HOME/.local/share/homerail-resources}"
MANAGER_PORT="${HOMERAIL_PRODUCTION_MANAGER_PORT:-39191}"
DOCKER_BRIDGE_GATEWAY="$(docker network inspect bridge --format '{{(index .IPAM.Config 0).Gateway}}' 2>/dev/null || true)"
MANAGER_HOST="${HOMERAIL_PRODUCTION_MANAGER_HOST:-$DOCKER_BRIDGE_GATEWAY}"
ALLOW_INSECURE_REMOTE_WS="${HOMERAIL_PRODUCTION_ALLOW_INSECURE_REMOTE_WS:-${HOMERAIL_ALLOW_INSECURE_REMOTE_WS:-0}}"
DAG_COMMAND_ALLOWLIST="${HOMERAIL_PRODUCTION_DAG_COMMAND_ALLOWLIST:-node}"
if [ -z "$DOCKER_BRIDGE_GATEWAY" ] || [ -z "$MANAGER_HOST" ]; then
  echo "Production requires Docker's default 'bridge' network because provisioned Workers use it; restore that network before starting HomeRail." >&2
  exit 1
fi
case "$ALLOW_INSECURE_REMOTE_WS" in 0|1) ;; *) echo "HOMERAIL_PRODUCTION_ALLOW_INSECURE_REMOTE_WS must be 0 or 1." >&2; exit 1 ;; esac
if [ "$DAG_COMMAND_ALLOWLIST" != "node" ]; then
  echo "Production deterministic DAG commands are restricted to the built-in node runtime." >&2
  exit 1
fi
case "$MANAGER_HOST" in
  localhost|127.*|::1|\[::1\]|0.0.0.0|::|\[::\])
    echo "Production Manager must bind the Docker bridge gateway, not loopback or a wildcard address." >&2
    exit 1
    ;;
esac
if [ "$MANAGER_HOST" != "$DOCKER_BRIDGE_GATEWAY" ]; then
  echo "Production Manager may bind only to the Docker bridge gateway." >&2
  exit 1
fi
case "$MANAGER_HOST" in *:*) MANAGER_URL_HOST="[$MANAGER_HOST]" ;; *) MANAGER_URL_HOST="$MANAGER_HOST" ;; esac
MANAGER_URL="${HOMERAIL_PRODUCTION_MANAGER_URL:-http://$MANAGER_URL_HOST:$MANAGER_PORT}"
UI_HOST="${HOMERAIL_PRODUCTION_UI_HOST:-0.0.0.0}"
UI_PORT="${HOMERAIL_PRODUCTION_UI_PORT:-19192}"
UI_HTTP_PORT="${HOMERAIL_PRODUCTION_UI_HTTP_PORT:-19193}"
PUBLIC_HOST="${HOMERAIL_PRODUCTION_PUBLIC_HOST:-}"
UI_URL="${HOMERAIL_PRODUCTION_UI_URL:-}"
NODE="$RELEASE_ROOT/runtime/node"
CLI="$RELEASE_ROOT/homerail_cli/dist/cli.js"
REVISION="$(tr -d '[:space:]' < "$RELEASE_ROOT/REVISION")"

if [[ "$RELEASE_ROOT" != "$PRODUCTION_ROOT"/releases/* ]] \
  || [[ ! "$REVISION" =~ ^[0-9a-f]{40}$ ]] \
  || [ ! -x "$NODE" ] \
  || [ ! -f "$CLI" ] \
  || [ ! -f "$RELEASE_ROOT/scripts/lib/production-runtime.sh" ]; then
  echo "Production release is incomplete." >&2
  exit 1
fi
source "$RELEASE_ROOT/scripts/lib/production-runtime.sh"
if [ "$UI_HOST" != "0.0.0.0" ] && [ "$UI_HOST" != "::" ]; then
  echo "Production UI must bind all interfaces." >&2
  exit 1
fi
case "$PUBLIC_HOST" in
  ""|localhost|127.*|::1|\[::1\])
    echo "Production UI requires a LAN-accessible public host." >&2
    exit 1
    ;;
esac
if [ -z "$UI_URL" ]; then
  if [[ "$PUBLIC_HOST" == *:* ]]; then
    UI_URL="https://[$PUBLIC_HOST]:$UI_PORT"
  else
    UI_URL="https://$PUBLIC_HOST:$UI_PORT"
  fi
fi

AUTH_SECRET_DIR="$HOMERAIL_HOME/manager/secrets"
initialize_production_tokens "$NODE" "$AUTH_SECRET_DIR"

export HOMERAIL_HOME
export HOMERAIL_NODE_TOKEN
export HOMERAIL_WORKER_TOKEN
export HOMERAIL_DAG_MUTATION_TOKEN
export HOMERAIL_REPO_ROOT="$RELEASE_ROOT"
export HOMERAIL_MANAGER_URL="$MANAGER_URL"
export HOMERAIL_MANAGER_PORT="$MANAGER_PORT"
export HOMERAIL_MANAGER_HOST="$MANAGER_HOST"
export HOMERAIL_MANAGER_PUBLIC_URL="${HOMERAIL_PRODUCTION_MANAGER_PUBLIC_URL:-$MANAGER_URL}"
export HOMERAIL_ALLOW_INSECURE_REMOTE_WS="$ALLOW_INSECURE_REMOTE_WS"
export HOMERAIL_DAG_COMMAND_ALLOWLIST="$DAG_COMMAND_ALLOWLIST"
export HOMERAIL_UI_HOST="$UI_HOST"
export HOMERAIL_UI_PORT="$UI_PORT"
export HOMERAIL_UI_HTTP_PORT="$UI_HTTP_PORT"
export HOMERAIL_UI_PUBLIC_URL="$UI_URL"
export HOMERAIL_PUBLIC_HOST="$PUBLIC_HOST"
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
    && curl -fkSs --connect-timeout 3 --max-time 10 "${UI_URL%/}/" >/dev/null \
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
