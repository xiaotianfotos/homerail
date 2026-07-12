#!/usr/bin/env bash
set -euo pipefail

RUNNER_BASE="${HOMERAIL_RUNNER_BASE:-$HOME/.homerail-runners}"
HOME_BASE="${HOMERAIL_LIVE_HOME_BASE:-$RUNNER_BASE/homerail_home}"
LOCK_FILE="$RUNNER_BASE/dag-patterns-live.lock"

mkdir -p "$RUNNER_BASE" "$HOME_BASE"
if [ "${HOMERAIL_CLEANUP_LOCK_HELD:-0}" != "1" ]; then
  exec 9>"$LOCK_FILE"
  flock -n 9 || exit 0
fi

mapfile -t containers < <(docker ps -aq --filter "label=org.homerail.live_run")
if [ "${#containers[@]}" -gt 0 ]; then
  docker rm -f "${containers[@]}" >/dev/null
fi

mapfile -t images < <(docker images --filter "label=org.homerail.live_run" --format "{{.ID}}" | sort -u)
if [ "${#images[@]}" -gt 0 ]; then
  docker image rm -f "${images[@]}" >/dev/null
fi

find "$HOME_BASE" -mindepth 1 -maxdepth 1 -type d -name 'run-*' -exec rm -rf -- {} +
