#!/usr/bin/env bash
set -euo pipefail

RUNNER_BASE="${HOMERAIL_RUNNER_BASE:-$HOME/.homerail-runners}"
HOME_ROOT="${HOMERAIL_LIVE_HOME_BASE:-$RUNNER_BASE/homerail_home}"

sanitize_slot() {
  printf '%s' "$1" | tr -c 'A-Za-z0-9_.-' '-'
}

container_ids_for_scope() {
  local slot="$1" id label
  if [ "$slot" != "__legacy_unscoped__" ]; then
    docker ps -aq --filter "label=org.homerail.live_slot=$slot"
    return
  fi
  while IFS= read -r id; do
    [ -n "$id" ] || continue
    label="$(docker container inspect --format '{{ index .Config.Labels "org.homerail.live_slot" }}' "$id" 2>/dev/null || true)"
    { [ -z "$label" ] || [ "$label" = "<no value>" ]; } && printf '%s\n' "$id"
  done < <(docker ps -aq --filter "label=org.homerail.live_run")
}

image_ids_for_scope() {
  local slot="$1" id label
  if [ "$slot" != "__legacy_unscoped__" ]; then
    docker images --filter "label=org.homerail.live_slot=$slot" --format "{{.ID}}" | sort -u
    return
  fi
  while IFS= read -r id; do
    [ -n "$id" ] || continue
    label="$(docker image inspect --format '{{ index .Config.Labels "org.homerail.live_slot" }}' "$id" 2>/dev/null || true)"
    { [ -z "$label" ] || [ "$label" = "<no value>" ]; } && printf '%s\n' "$id"
  done < <(docker images --filter "label=org.homerail.live_run" --format "{{.ID}}" | sort -u)
}

cleanup_scope() {
  local slot="$1" home_base="$2"
  local -a containers images

  mkdir -p "$home_base"
  mapfile -t containers < <(container_ids_for_scope "$slot")
  if [ "${#containers[@]}" -gt 0 ]; then
    docker rm -f "${containers[@]}" >/dev/null
  fi

  mapfile -t images < <(image_ids_for_scope "$slot")
  if [ "${#images[@]}" -gt 0 ]; then
    docker image rm -f "${images[@]}" >/dev/null
  fi

  find "$home_base" -mindepth 1 -maxdepth 1 -type d -name 'run-*' -exec rm -rf -- {} +
}

cleanup_scope_with_lock() (
  local slot="$1" home_base="$2" lock_file="$3"
  mkdir -p "$(dirname "$lock_file")" "$home_base"
  exec 9>"$lock_file"
  flock -n 9 || exit 0
  cleanup_scope "$slot" "$home_base"
)

mkdir -p "$RUNNER_BASE" "$HOME_ROOT"

if [ -n "${HOMERAIL_LIVE_SLOT:-}" ]; then
  LIVE_SLOT="$(sanitize_slot "$HOMERAIL_LIVE_SLOT")"
  case "$LIVE_SLOT" in
    ""|.|..) exit 1 ;;
  esac
  HOME_BASE="$HOME_ROOT/slots/$LIVE_SLOT"
  LOCK_FILE="$RUNNER_BASE/slots/$LIVE_SLOT/dag-patterns-live.lock"
  if [ "${HOMERAIL_CLEANUP_LOCK_HELD:-0}" = "1" ]; then
    cleanup_scope "$LIVE_SLOT" "$HOME_BASE"
  else
    cleanup_scope_with_lock "$LIVE_SLOT" "$HOME_BASE" "$LOCK_FILE"
  fi
  exit 0
fi

# Legacy runs used one global lock and did not label resources with a runner slot.
LEGACY_LOCK_FILE="$RUNNER_BASE/dag-patterns-live.lock"
if [ "${HOMERAIL_CLEANUP_LOCK_HELD:-0}" = "1" ]; then
  cleanup_scope "__legacy_unscoped__" "$HOME_ROOT"
  exit 0
fi
cleanup_scope_with_lock "__legacy_unscoped__" "$HOME_ROOT" "$LEGACY_LOCK_FILE"

shopt -s nullglob
for slot_dir in "$RUNNER_BASE"/slots/*; do
  [ -d "$slot_dir" ] || continue
  LIVE_SLOT="$(basename "$slot_dir")"
  HOME_BASE="$HOME_ROOT/slots/$LIVE_SLOT"
  cleanup_scope_with_lock "$LIVE_SLOT" "$HOME_BASE" "$slot_dir/dag-patterns-live.lock"
done
