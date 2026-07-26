#!/usr/bin/env bash
set -euo pipefail

SOURCE_ROOT="${GITHUB_WORKSPACE:-$(cd "$(dirname "$0")/.." && pwd)}"
source "$SOURCE_ROOT/scripts/lib/production-runtime.sh"
PRODUCTION_ROOT="${HOMERAIL_PRODUCTION_ROOT:-$HOME/.local/share/homerail-production}"
HOMERAIL_HOME="${HOMERAIL_PRODUCTION_HOME:-$HOME/.local/share/homerail-production-data}"
RESOURCE_ROOT="${HOMERAIL_PRODUCTION_RESOURCES:-$HOME/.local/share/homerail-resources}"
REVISION="${HOMERAIL_DEPLOY_REVISION:-}"
SERVICE_NAME="homerail-production.service"
UNIT_PATH="$HOME/.config/systemd/user/$SERVICE_NAME"
MANAGER_PORT="${HOMERAIL_PRODUCTION_MANAGER_PORT:-39191}"
DOCKER_BRIDGE_GATEWAY="$(docker network inspect bridge --format '{{(index .IPAM.Config 0).Gateway}}' 2>/dev/null || true)"
MANAGER_HOST="${HOMERAIL_PRODUCTION_MANAGER_HOST:-$DOCKER_BRIDGE_GATEWAY}"
case "$MANAGER_HOST" in *:*) MANAGER_URL_HOST="[$MANAGER_HOST]" ;; *) MANAGER_URL_HOST="$MANAGER_HOST" ;; esac
MANAGER_URL="${HOMERAIL_PRODUCTION_MANAGER_URL:-http://$MANAGER_URL_HOST:$MANAGER_PORT}"
ALLOW_INSECURE_REMOTE_WS="${HOMERAIL_PRODUCTION_ALLOW_INSECURE_REMOTE_WS:-0}"
DAG_COMMAND_ALLOWLIST="${HOMERAIL_PRODUCTION_DAG_COMMAND_ALLOWLIST:-node}"
UI_HOST="${HOMERAIL_PRODUCTION_UI_HOST:-0.0.0.0}"
UI_PORT="${HOMERAIL_PRODUCTION_UI_PORT:-19192}"
UI_HTTP_PORT="${HOMERAIL_PRODUCTION_UI_HTTP_PORT:-19193}"
HEALTH_ATTEMPTS="${HOMERAIL_PRODUCTION_HEALTH_ATTEMPTS:-60}"
PUBLIC_HOST="${HOMERAIL_PRODUCTION_PUBLIC_HOST:-}"
UI_URL="${HOMERAIL_PRODUCTION_UI_URL:-}"

case "$PRODUCTION_ROOT" in /*) ;; *) echo "HOMERAIL_PRODUCTION_ROOT must be absolute." >&2; exit 1 ;; esac
case "$HOMERAIL_HOME" in /*) ;; *) echo "HOMERAIL_PRODUCTION_HOME must be absolute." >&2; exit 1 ;; esac
case "$RESOURCE_ROOT" in /*) ;; *) echo "HOMERAIL_PRODUCTION_RESOURCES must be absolute." >&2; exit 1 ;; esac
if [ -z "$DOCKER_BRIDGE_GATEWAY" ] || [ -z "$MANAGER_HOST" ]; then
  echo "Production requires Docker's default 'bridge' network because provisioned Workers use it; restore that network before deploying." >&2
  exit 1
fi
case "$ALLOW_INSECURE_REMOTE_WS" in 0|1) ;; *) echo "HOMERAIL_PRODUCTION_ALLOW_INSECURE_REMOTE_WS must be 0 or 1." >&2; exit 1 ;; esac
if [ "$DAG_COMMAND_ALLOWLIST" != "node" ]; then
  echo "HOMERAIL_PRODUCTION_DAG_COMMAND_ALLOWLIST must be exactly node." >&2
  exit 1
fi
case "$MANAGER_HOST" in
  localhost|127.*|::1|\[::1\]|0.0.0.0|::|\[::\])
    echo "HOMERAIL_PRODUCTION_MANAGER_HOST must be the Docker bridge gateway; loopback and wildcard binds are not supported." >&2
    exit 1
    ;;
esac
if [ "$MANAGER_HOST" != "$DOCKER_BRIDGE_GATEWAY" ]; then
  echo "Production Manager may bind only to the Docker bridge gateway." >&2
  exit 1
fi
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
if [[ ! "$HEALTH_ATTEMPTS" =~ ^[0-9]+$ ]] || [ "$HEALTH_ATTEMPTS" -lt 1 ] || [ "$HEALTH_ATTEMPTS" -gt 300 ]; then
  echo "HOMERAIL_PRODUCTION_HEALTH_ATTEMPTS must be an integer from 1 through 300." >&2
  exit 1
fi
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

NODE_BIN="$(command -v node)"
WORKER_METADATA="$(
  cd "$SOURCE_ROOT"
  "$NODE_BIN" --input-type=module -e '
    import fs from "node:fs";
    import path from "node:path";
    import { pathToFileURL } from "node:url";

    const repoRoot = process.cwd();
    const environmentModule = await import(pathToFileURL(
      path.join(repoRoot, "homerail_manager", "dist", "server", "dag-environment.js"),
    ).href);
    const protocolModule = await import(pathToFileURL(
      path.join(repoRoot, "homerail_protocol", "dist", "index.js"),
    ).href);
    const fingerprint = environmentModule.dagWorkerSourceFingerprint(repoRoot);
    const workerPackage = JSON.parse(fs.readFileSync(
      path.join(repoRoot, "homerail_worker", "package.json"),
      "utf8",
    ));
    if (!fingerprint || typeof workerPackage.version !== "string" || !protocolModule.PROTOCOL_VERSION) {
      throw new Error("Worker image metadata is incomplete.");
    }
    process.stdout.write(`${fingerprint}\n${protocolModule.PROTOCOL_VERSION}\n${workerPackage.version}\n`);
  '
)"
WORKER_SOURCE_FINGERPRINT="$(printf '%s\n' "$WORKER_METADATA" | sed -n '1p')"
WORKER_PROTOCOL_VERSION="$(printf '%s\n' "$WORKER_METADATA" | sed -n '2p')"
WORKER_VERSION="$(printf '%s\n' "$WORKER_METADATA" | sed -n '3p')"
if [[ ! "$WORKER_SOURCE_FINGERPRINT" =~ ^[0-9a-f]{16}$ ]] \
  || [[ ! "$WORKER_PROTOCOL_VERSION" =~ ^[0-9A-Za-z._+-]+$ ]] \
  || [[ ! "$WORKER_VERSION" =~ ^[0-9A-Za-z._+-]+$ ]]; then
  echo "Production Worker image metadata is invalid." >&2
  exit 1
fi
WORKER_IMAGE_CREATED="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

mkdir -p "$PRODUCTION_ROOT/releases" "$PRODUCTION_ROOT/locks" "$HOMERAIL_HOME" "$(dirname "$UNIT_PATH")"
HOMERAIL_HOME="$(realpath "$HOMERAIL_HOME")"
chmod 700 "$HOMERAIL_HOME"

# An enabled user unit starts during boot only when the account lingers without
# an interactive login. Fail deployment instead of accepting a service that
# silently disappears after the next reboot.
DEPLOY_USER="$(id -un)"
if ! command -v loginctl >/dev/null 2>&1; then
  echo "Production deployment requires loginctl to verify systemd user lingering." >&2
  exit 1
fi
LINGER_STATE="$(loginctl show-user "$DEPLOY_USER" --property=Linger --value 2>/dev/null || true)"
if [ "$LINGER_STATE" != "yes" ]; then
  echo "Production service requires user lingering; run: sudo loginctl enable-linger $DEPLOY_USER" >&2
  exit 1
fi

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
  --label "org.homerail.worker.source_fingerprint=$WORKER_SOURCE_FINGERPRINT" \
  --label "org.homerail.worker.protocol_version=$WORKER_PROTOCOL_VERSION" \
  --label "org.opencontainers.image.version=$WORKER_VERSION" \
  --label "org.opencontainers.image.revision=$REVISION" \
  --label "org.opencontainers.image.created=$WORKER_IMAGE_CREATED" \
  --build-arg "HOMERAIL_WORKER_SOURCE_FINGERPRINT=$WORKER_SOURCE_FINGERPRINT" \
  --build-arg "HOMERAIL_WORKER_PROTOCOL_VERSION=$WORKER_PROTOCOL_VERSION" \
  --build-arg "HOMERAIL_WORKER_VERSION=$WORKER_VERSION" \
  --build-arg "HOMERAIL_WORKER_IMAGE_REVISION=$REVISION" \
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
install -m 0755 "$NODE_BIN" "$STAGING/runtime/node"
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
After=network-online.target
Wants=network-online.target
# A boot-time data mount or Docker daemon may appear after the user manager.
# Keep retrying instead of entering a permanent failed state after five starts.
StartLimitIntervalSec=0

[Service]
Type=simple
# The production volume may not exist when the lingering user manager starts.
WorkingDirectory=%h
Environment=HOMERAIL_PRODUCTION_ROOT=$PRODUCTION_ROOT
Environment=HOMERAIL_HOME=$HOMERAIL_HOME
Environment=HOMERAIL_PRODUCTION_RESOURCES=$RESOURCE_ROOT
Environment=HOMERAIL_PRODUCTION_MANAGER_URL=$MANAGER_URL
Environment=HOMERAIL_PRODUCTION_MANAGER_HOST=$MANAGER_HOST
Environment=HOMERAIL_PRODUCTION_MANAGER_PORT=$MANAGER_PORT
Environment=HOMERAIL_PRODUCTION_MANAGER_PUBLIC_URL=${HOMERAIL_PRODUCTION_MANAGER_PUBLIC_URL:-$MANAGER_URL}
Environment=HOMERAIL_ALLOW_INSECURE_REMOTE_WS=$ALLOW_INSECURE_REMOTE_WS
Environment=HOMERAIL_PRODUCTION_DAG_COMMAND_ALLOWLIST=$DAG_COMMAND_ALLOWLIST
Environment=HOMERAIL_PRODUCTION_UI_URL=$UI_URL
Environment=HOMERAIL_PRODUCTION_UI_HOST=$UI_HOST
Environment=HOMERAIL_PRODUCTION_UI_PORT=$UI_PORT
Environment=HOMERAIL_PRODUCTION_UI_HTTP_PORT=$UI_HTTP_PORT
Environment=HOMERAIL_PRODUCTION_PUBLIC_HOST=$PUBLIC_HOST
Environment=PATH=$SERVICE_PATH
$CODEX_UNIT_ENV
# /bin/bash and %h exist before the data volume is mounted. Wait for the atomic
# current release, then preserve the release working-directory contract.
ExecStart=/bin/bash -c 'release="\$HOMERAIL_PRODUCTION_ROOT/current"; until [ -x "\$release/scripts/run-production-service.sh" ]; do sleep 10; done; cd "\$release"; exec "\$release/scripts/run-production-service.sh"'
Restart=always
RestartSec=10
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

PREVIOUS_TARGET="$(readlink "$PRODUCTION_ROOT/current" 2>/dev/null || true)"
PREVIOUS_RELEASE=""
if [[ "$PREVIOUS_TARGET" == releases/* ]] && [ -d "$PRODUCTION_ROOT/$PREVIOUS_TARGET" ]; then
  PREVIOUS_RELEASE="$PRODUCTION_ROOT/$PREVIOUS_TARGET"
fi

DATABASE_PATH="$HOMERAIL_HOME/manager/homerail.db"
DATABASE_BACKUP="$PRODUCTION_ROOT/locks/homerail.db.pre-$SHORT_REVISION-$$"
DATABASE_WAL_BACKUP="$DATABASE_BACKUP-wal"
DATABASE_EXISTED=0
PREVIOUS_DATABASE_COMPATIBLE=0
PROBE_HOME="$PRODUCTION_ROOT/locks/database-probe-$SHORT_REVISION-$$"
SERVICE_STOPPED_FOR_SNAPSHOT=0

cleanup_deploy_temporaries() {
  local exit_status=$?
  rm -rf "$PROBE_HOME"
  rm -f "$DATABASE_BACKUP" "$DATABASE_WAL_BACKUP"
  if [ "$SERVICE_STOPPED_FOR_SNAPSHOT" = "1" ]; then
    systemctl --user start "$SERVICE_NAME" >/dev/null 2>&1 || true
  fi
  exit "$exit_status"
}
trap cleanup_deploy_temporaries EXIT

# Stop the old release before snapshotting SQLite so the database and any WAL
# file represent the same point in time. A failed rollout restores this pair
# before an older release is allowed to start.
systemctl --user stop "$SERVICE_NAME" >/dev/null 2>&1 || true
SERVICE_STOPPED_FOR_SNAPSHOT=1
if [ -f "$DATABASE_PATH" ]; then
  DATABASE_EXISTED=1
  cp -p "$DATABASE_PATH" "$DATABASE_BACKUP"
  if [ -f "$DATABASE_PATH-wal" ]; then
    cp -p "$DATABASE_PATH-wal" "$DATABASE_WAL_BACKUP"
  fi
fi

# Probe rollback compatibility against a private copy. This catches an already
# upgraded database before the deployment can switch back to code that refuses
# to open it.
if [ "$DATABASE_EXISTED" = "0" ]; then
  PREVIOUS_DATABASE_COMPATIBLE=1
elif [ -n "$PREVIOUS_RELEASE" ] \
  && [ -x "$PREVIOUS_RELEASE/runtime/node" ] \
  && [ -f "$PREVIOUS_RELEASE/homerail_manager/dist/persistence/db.js" ]; then
  mkdir -p "$PROBE_HOME/manager"
  cp -p "$DATABASE_BACKUP" "$PROBE_HOME/manager/homerail.db"
  if [ -f "$DATABASE_WAL_BACKUP" ]; then
    cp -p "$DATABASE_WAL_BACKUP" "$PROBE_HOME/manager/homerail.db-wal"
  fi
  if HOMERAIL_HOME="$PROBE_HOME" "$PREVIOUS_RELEASE/runtime/node" --input-type=module -e '
    import { pathToFileURL } from "node:url";
    const databaseModule = await import(pathToFileURL(process.argv[1]).href);
    databaseModule.getDb();
    databaseModule.closeDb();
  ' "$PREVIOUS_RELEASE/homerail_manager/dist/persistence/db.js" >/dev/null 2>&1; then
    PREVIOUS_DATABASE_COMPATIBLE=1
  fi
fi
rm -rf "$PROBE_HOME"

mv "$UNIT_PATH.tmp" "$UNIT_PATH"
NEXT_TARGET="releases/$RELEASE_NAME"
NEXT_LINK="$PRODUCTION_ROOT/.current-$RELEASE_NAME-$$"
ln -s "$NEXT_TARGET" "$NEXT_LINK"
mv -Tf "$NEXT_LINK" "$PRODUCTION_ROOT/current"

systemctl --user daemon-reload
systemctl --user enable "$SERVICE_NAME" >/dev/null
systemctl --user restart "$SERVICE_NAME"
SERVICE_STOPPED_FOR_SNAPSHOT=0

healthy=0
for _ in $(seq 1 "$HEALTH_ATTEMPTS"); do
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

if [ "$healthy" = "1" ]; then
  smoke_output=""
  if ! smoke_output="$(verify_production_dag_smoke "$PRODUCTION_ROOT" "$HOMERAIL_HOME" "$MANAGER_URL" 2>&1)"; then
    echo "Production Docker Worker DAG smoke failed for $REVISION." >&2
    printf '%s\n' "$smoke_output" >&2
    healthy=0
  fi
fi

if [ "$healthy" != "1" ]; then
  echo "Production health check failed for $REVISION; rolling back." >&2
  systemctl --user stop "$SERVICE_NAME" >/dev/null 2>&1 || true
  rm -f "$DATABASE_PATH" "$DATABASE_PATH-wal" "$DATABASE_PATH-shm"
  if [ "$DATABASE_EXISTED" = "1" ]; then
    mkdir -p "$(dirname "$DATABASE_PATH")"
    cp -p "$DATABASE_BACKUP" "$DATABASE_PATH.rollback-$$"
    mv "$DATABASE_PATH.rollback-$$" "$DATABASE_PATH"
    if [ -f "$DATABASE_WAL_BACKUP" ]; then
      cp -p "$DATABASE_WAL_BACKUP" "$DATABASE_PATH-wal.rollback-$$"
      mv "$DATABASE_PATH-wal.rollback-$$" "$DATABASE_PATH-wal"
    fi
  fi
  if [ "$PREVIOUS_DATABASE_COMPATIBLE" = "1" ] && [ -n "$PREVIOUS_RELEASE" ]; then
    if [ "$UNIT_EXISTED" = "1" ]; then
      mv "$UNIT_BACKUP" "$UNIT_PATH"
    else
      rm -f "$UNIT_PATH" "$UNIT_BACKUP"
    fi
    ROLLBACK_LINK="$PRODUCTION_ROOT/.rollback-$$"
    ln -s "$PREVIOUS_TARGET" "$ROLLBACK_LINK"
    mv -Tf "$ROLLBACK_LINK" "$PRODUCTION_ROOT/current"
    systemctl --user daemon-reload
    systemctl --user restart "$SERVICE_NAME"
  elif [ -n "$PREVIOUS_RELEASE" ]; then
    echo "Previous release cannot open the pre-deployment database; refusing an incompatible code rollback." >&2
    rm -f "$UNIT_BACKUP"
    systemctl --user daemon-reload
    systemctl --user restart "$SERVICE_NAME"
  else
    rm -f "$UNIT_PATH" "$UNIT_BACKUP"
    systemctl --user daemon-reload
    systemctl --user stop "$SERVICE_NAME" || true
  fi
  journalctl --user-unit "$SERVICE_NAME" -n 80 --no-pager >&2 || true
  rm -f "$DATABASE_BACKUP" "$DATABASE_WAL_BACKUP"
  trap - EXIT
  exit 1
fi

rm -f "$UNIT_BACKUP" "$DATABASE_BACKUP" "$DATABASE_WAL_BACKUP"
trap - EXIT
printf '%s\n' "$REVISION" > "$PRODUCTION_ROOT/last-successful-revision"
OLD_RELEASES=("")
while IFS= read -r old_release; do
  [ -n "$old_release" ] && OLD_RELEASES+=("$old_release")
done < <(find "$PRODUCTION_ROOT/releases" -mindepth 1 -maxdepth 1 -type d ! -name '.staging-*' -printf '%T@ %p\n' | sort -rn | tail -n +4 | cut -d' ' -f2-)
for old_release in "${OLD_RELEASES[@]}"; do
  [ -n "$old_release" ] || continue
  old_revision="$(tr -d '[:space:]' < "$old_release/REVISION" 2>/dev/null || true)"
  rm -rf "$old_release"
  if [[ "$old_revision" =~ ^[0-9a-f]{40}$ ]] \
    && ! grep -Fxl -- "$old_revision" "$PRODUCTION_ROOT"/releases/*/REVISION >/dev/null 2>&1; then
    docker image rm "homerail-worker:production-${old_revision:0:12}" >/dev/null 2>&1 || true
  fi
done

echo "HomeRail production deployed: $REVISION"
echo "HomeRail production URL: $UI_URL"
