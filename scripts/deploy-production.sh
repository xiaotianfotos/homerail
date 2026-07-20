#!/usr/bin/env bash
set -euo pipefail

SOURCE_ROOT="${GITHUB_WORKSPACE:-$(cd "$(dirname "$0")/.." && pwd)}"
PRODUCTION_ROOT="${HOMERAIL_PRODUCTION_ROOT:-$HOME/.local/share/homerail-production}"
HOMERAIL_HOME="${HOMERAIL_PRODUCTION_HOME:-$HOME/.local/share/homerail-production-data}"
RESOURCE_ROOT="${HOMERAIL_PRODUCTION_RESOURCES:-$HOME/.local/share/homerail-resources}"
REVISION="${HOMERAIL_DEPLOY_REVISION:-}"
SERVICE_NAME="homerail-production.service"
UNIT_PATH="$HOME/.config/systemd/user/$SERVICE_NAME"
MANAGER_HOST="${HOMERAIL_PRODUCTION_MANAGER_HOST:-127.0.0.1}"
MANAGER_PORT="${HOMERAIL_PRODUCTION_MANAGER_PORT:-39191}"
MANAGER_URL="${HOMERAIL_PRODUCTION_MANAGER_URL:-http://$MANAGER_HOST:$MANAGER_PORT}"
UI_HOST="${HOMERAIL_PRODUCTION_UI_HOST:-0.0.0.0}"
UI_PORT="${HOMERAIL_PRODUCTION_UI_PORT:-19192}"
UI_HTTP_PORT="${HOMERAIL_PRODUCTION_UI_HTTP_PORT:-19193}"
PUBLIC_HOST="${HOMERAIL_PRODUCTION_PUBLIC_HOST:-}"
UI_URL="${HOMERAIL_PRODUCTION_UI_URL:-}"

case "$PRODUCTION_ROOT" in /*) ;; *) echo "HOMERAIL_PRODUCTION_ROOT must be absolute." >&2; exit 1 ;; esac
case "$HOMERAIL_HOME" in /*) ;; *) echo "HOMERAIL_PRODUCTION_HOME must be absolute." >&2; exit 1 ;; esac
case "$RESOURCE_ROOT" in /*) ;; *) echo "HOMERAIL_PRODUCTION_RESOURCES must be absolute." >&2; exit 1 ;; esac
if [ "$UI_HOST" != "0.0.0.0" ] && [ "$UI_HOST" != "::" ]; then
  echo "HOMERAIL_PRODUCTION_UI_HOST must bind all interfaces (0.0.0.0 or ::)." >&2
  exit 1
fi
case "$PUBLIC_HOST" in
  ""|localhost|127.*|::1|\[::1\])
    echo "HOMERAIL_PRODUCTION_PUBLIC_HOST must be a LAN-accessible host or address." >&2
    exit 1
    ;;
esac
for port in "$UI_PORT" "$UI_HTTP_PORT"; do
  if [[ ! "$port" =~ ^[0-9]+$ ]] || [ "$port" -lt 1 ] || [ "$port" -gt 65535 ]; then
    echo "Production UI ports must be integers from 1 through 65535." >&2
    exit 1
  fi
done
if [ -z "$UI_URL" ]; then
  if [[ "$PUBLIC_HOST" == *:* ]]; then
    UI_URL="https://[$PUBLIC_HOST]:$UI_PORT"
  else
    UI_URL="https://$PUBLIC_HOST:$UI_PORT"
  fi
fi
case "$UI_URL" in
  https://localhost:*|https://localhost/*|https://127.*|https://\[::1\]*)
    echo "HOMERAIL_PRODUCTION_UI_URL must use the LAN-facing HTTPS endpoint." >&2
    exit 1
    ;;
  https://*) ;;
  *)
    echo "HOMERAIL_PRODUCTION_UI_URL must use HTTPS." >&2
    exit 1
    ;;
esac
if [[ ! "$REVISION" =~ ^[0-9a-f]{40}$ ]]; then
  echo "HOMERAIL_DEPLOY_REVISION must be an exact 40-character commit SHA." >&2
  exit 1
fi
if [ ! -f "$SOURCE_ROOT/homerail_manager/dist/index.js" ] \
  || [ ! -f "$SOURCE_ROOT/homerail_node/dist/cli.js" ] \
  || [ ! -f "$SOURCE_ROOT/homerail_cli/dist/cli.js" ] \
  || [ ! -f "$SOURCE_ROOT/agent-ui/dist/index.html" ]; then
  echo "Production artifacts are not built." >&2
  exit 1
fi
if [ -d "$SOURCE_ROOT/.git" ]; then
  SOURCE_REVISION="$(git -C "$SOURCE_ROOT" rev-parse HEAD)"
  if [ "$SOURCE_REVISION" != "$REVISION" ]; then
    echo "Checked-out revision does not match HOMERAIL_DEPLOY_REVISION." >&2
    exit 1
  fi
fi

mkdir -p "$PRODUCTION_ROOT/releases" "$PRODUCTION_ROOT/locks" "$HOMERAIL_HOME" "$(dirname "$UNIT_PATH")"
HOMERAIL_HOME="$(realpath "$HOMERAIL_HOME")"
chmod 700 "$HOMERAIL_HOME"

# systemd user services do not inherit interactive-shell Node initialization.
# Resolve an optional Codex entry point now; the release later wraps it with
# the exact Node binary copied into runtime/ instead of trusting its shebang or
# prepending a package-manager directory to the persistent service PATH.
CODEX_BIN="${HOMERAIL_CODEX_BIN:-}"
if [ -n "$CODEX_BIN" ] && [[ "$CODEX_BIN" != */* ]]; then
  CODEX_BIN="$(command -v "$CODEX_BIN" 2>/dev/null || true)"
fi
if [ -z "$CODEX_BIN" ]; then
  CODEX_BIN="$(command -v codex 2>/dev/null || true)"
fi
SERVICE_PATH="/usr/local/bin:/usr/bin:/bin"
CODEX_UNIT_ENV=""
if [ -n "$CODEX_BIN" ]; then
  if [ ! -f "$CODEX_BIN" ] || [ ! -x "$CODEX_BIN" ]; then
    echo "HOMERAIL_CODEX_BIN is not an executable file: $CODEX_BIN" >&2
    exit 1
  fi
  CODEX_BIN="$(realpath "$CODEX_BIN")"
  if [[ ! "$CODEX_BIN" =~ ^/[A-Za-z0-9._/@+=:-]+$ ]]; then
    echo "HOMERAIL_CODEX_BIN must resolve to a safe absolute path." >&2
    exit 1
  fi
  CURRENT_UID="$(id -u)"
  for trusted_path in "$CODEX_BIN" "$(dirname "$CODEX_BIN")"; do
    trusted_owner="$(stat -Lc '%u' "$trusted_path")"
    trusted_mode="$(stat -Lc '%a' "$trusted_path")"
    if [ "$trusted_owner" != "0" ] && [ "$trusted_owner" != "$CURRENT_UID" ]; then
      echo "HOMERAIL_CODEX_BIN must be owned by the service user or root." >&2
      exit 1
    fi
    if (( (8#$trusted_mode & 8#022) != 0 )); then
      echo "HOMERAIL_CODEX_BIN and its parent directory must not be group/world writable." >&2
      exit 1
    fi
  done
  CODEX_UNIT_ENV="Environment=HOMERAIL_CODEX_BIN=$PRODUCTION_ROOT/current/runtime/codex"
fi
exec 9>"$PRODUCTION_ROOT/locks/deploy.lock"
if ! flock -w 60 9; then
  echo "Another production deployment is active." >&2
  exit 1
fi

SHORT_REVISION="${REVISION:0:12}"
WORKER_IMAGE="homerail-worker:production-$SHORT_REVISION"
echo "Building production Worker image $WORKER_IMAGE"
docker build \
  --label "org.homerail.production_revision=$REVISION" \
  -t "$WORKER_IMAGE" \
  -f "$SOURCE_ROOT/homerail_worker/Dockerfile" \
  "$SOURCE_ROOT"

RELEASE_NAME="$(date -u +%Y%m%dT%H%M%SZ)-$SHORT_REVISION"
STAGING="$PRODUCTION_ROOT/releases/.staging-$RELEASE_NAME-$$"
RELEASE="$PRODUCTION_ROOT/releases/$RELEASE_NAME"
cleanup_staging() { rm -rf "$STAGING"; }
trap cleanup_staging EXIT
mkdir -p "$STAGING"
rsync -a --delete \
  --exclude '/.git/' \
  --exclude '/artifacts/' \
  --exclude '/coverage/' \
  --exclude '/agent-ui/playwright-report/' \
  --exclude '/agent-ui/test-results/' \
  "$SOURCE_ROOT/" "$STAGING/"
mkdir -p "$STAGING/runtime"
install -m 0755 "$(command -v node)" "$STAGING/runtime/node"
if [ -n "$CODEX_BIN" ]; then
  cat > "$STAGING/runtime/codex" <<WRAPPER
#!/bin/sh
exec "\$(dirname "\$0")/node" "$CODEX_BIN" "\$@"
WRAPPER
  chmod 0755 "$STAGING/runtime/codex"
fi
printf '%s\n' "$REVISION" > "$STAGING/REVISION"
chmod 0755 "$STAGING/scripts/run-production-service.sh"
mv "$STAGING" "$RELEASE"
trap - EXIT

UNIT_BACKUP="$PRODUCTION_ROOT/locks/$SERVICE_NAME.previous.$$"
UNIT_EXISTED=0
if [ -f "$UNIT_PATH" ]; then
  cp -p "$UNIT_PATH" "$UNIT_BACKUP"
  UNIT_EXISTED=1
fi

cat > "$UNIT_PATH.tmp" <<UNIT
[Unit]
Description=HomeRail persistent production service
After=network-online.target docker.service
Wants=network-online.target
StartLimitIntervalSec=120
StartLimitBurst=5

[Service]
Type=simple
WorkingDirectory=$PRODUCTION_ROOT/current
Environment=HOMERAIL_PRODUCTION_ROOT=$PRODUCTION_ROOT
Environment=HOMERAIL_HOME=$HOMERAIL_HOME
Environment=HOMERAIL_PRODUCTION_RESOURCES=$RESOURCE_ROOT
Environment=HOMERAIL_PRODUCTION_MANAGER_URL=$MANAGER_URL
Environment=HOMERAIL_PRODUCTION_MANAGER_HOST=$MANAGER_HOST
Environment=HOMERAIL_PRODUCTION_MANAGER_PORT=$MANAGER_PORT
Environment=HOMERAIL_PRODUCTION_MANAGER_PUBLIC_URL=${HOMERAIL_PRODUCTION_MANAGER_PUBLIC_URL:-$MANAGER_URL}
Environment=HOMERAIL_PRODUCTION_UI_URL=$UI_URL
Environment=HOMERAIL_PRODUCTION_UI_HOST=$UI_HOST
Environment=HOMERAIL_PRODUCTION_UI_PORT=$UI_PORT
Environment=HOMERAIL_PRODUCTION_UI_HTTP_PORT=$UI_HTTP_PORT
Environment=HOMERAIL_PRODUCTION_PUBLIC_HOST=$PUBLIC_HOST
Environment=PATH=$SERVICE_PATH
$CODEX_UNIT_ENV
ExecStart=$PRODUCTION_ROOT/current/scripts/run-production-service.sh
Restart=always
RestartSec=5
KillMode=control-group
TimeoutStopSec=120
Nice=5
CPUQuota=600%
MemoryMax=16G
TasksMax=4096

[Install]
WantedBy=default.target
UNIT
chmod 0644 "$UNIT_PATH.tmp"
mv "$UNIT_PATH.tmp" "$UNIT_PATH"

PREVIOUS_TARGET="$(readlink "$PRODUCTION_ROOT/current" 2>/dev/null || true)"
NEXT_TARGET="releases/$RELEASE_NAME"
NEXT_LINK="$PRODUCTION_ROOT/.current-$RELEASE_NAME-$$"
ln -s "$NEXT_TARGET" "$NEXT_LINK"
mv -Tf "$NEXT_LINK" "$PRODUCTION_ROOT/current"

systemctl --user daemon-reload
systemctl --user enable "$SERVICE_NAME" >/dev/null
systemctl --user restart "$SERVICE_NAME"

healthy=0
for _ in $(seq 1 60); do
  if systemctl --user is-active --quiet "$SERVICE_NAME" \
    && curl -fsS --connect-timeout 3 --max-time 5 "$MANAGER_URL/health" >/dev/null \
    && curl -fkSs --connect-timeout 3 --max-time 5 "${UI_URL%/}/" >/dev/null \
    && curl -fsS --connect-timeout 3 --max-time 5 "$MANAGER_URL/runtime/status" \
      | "$PRODUCTION_ROOT/current/runtime/node" -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const v=JSON.parse(s);process.exit(Number(v.connected_nodes)>0?0:1)})"; then
    healthy=1
    break
  fi
  sleep 2
done

if [ "$healthy" != "1" ]; then
  echo "Production health check failed for $REVISION; rolling back." >&2
  if [ "$UNIT_EXISTED" = "1" ]; then
    mv "$UNIT_BACKUP" "$UNIT_PATH"
  else
    rm -f "$UNIT_PATH" "$UNIT_BACKUP"
  fi
  if [[ "$PREVIOUS_TARGET" == releases/* ]] && [ -d "$PRODUCTION_ROOT/$PREVIOUS_TARGET" ]; then
    ROLLBACK_LINK="$PRODUCTION_ROOT/.rollback-$$"
    ln -s "$PREVIOUS_TARGET" "$ROLLBACK_LINK"
    mv -Tf "$ROLLBACK_LINK" "$PRODUCTION_ROOT/current"
    systemctl --user daemon-reload
    systemctl --user restart "$SERVICE_NAME"
  else
    systemctl --user daemon-reload
    systemctl --user stop "$SERVICE_NAME" || true
  fi
  journalctl --user-unit "$SERVICE_NAME" -n 80 --no-pager >&2 || true
  exit 1
fi

rm -f "$UNIT_BACKUP"
printf '%s\n' "$REVISION" > "$PRODUCTION_ROOT/last-successful-revision"
mapfile -t OLD_RELEASES < <(find "$PRODUCTION_ROOT/releases" -mindepth 1 -maxdepth 1 -type d ! -name '.staging-*' -printf '%T@ %p\n' | sort -rn | tail -n +4 | cut -d' ' -f2-)
for old_release in "${OLD_RELEASES[@]}"; do
  old_revision="$(tr -d '[:space:]' < "$old_release/REVISION" 2>/dev/null || true)"
  rm -rf "$old_release"
  if [[ "$old_revision" =~ ^[0-9a-f]{40}$ ]] \
    && ! grep -Fxl -- "$old_revision" "$PRODUCTION_ROOT"/releases/*/REVISION >/dev/null 2>&1; then
    docker image rm "homerail-worker:production-${old_revision:0:12}" >/dev/null 2>&1 || true
  fi
done

echo "HomeRail production deployed: $REVISION"
echo "HomeRail production URL: $UI_URL"
