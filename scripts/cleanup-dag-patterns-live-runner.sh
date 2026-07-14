#!/usr/bin/env bash
set -euo pipefail

RUNNER_BASE="${HOMERAIL_RUNNER_BASE:-$HOME/.homerail-runners}"
HOME_ROOT="${HOMERAIL_LIVE_HOME_BASE:-$RUNNER_BASE/homerail_home}"

if [ -n "${HOMERAIL_LIVE_HOME_BASE:-}" ] && [ -z "${HOMERAIL_RUNNER_BASE:-}" ]; then
  echo "HOMERAIL_RUNNER_BASE is required when HOMERAIL_LIVE_HOME_BASE is configured." >&2
  exit 1
fi

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
    if ! label="$(
      docker container inspect \
        --format '{{with index .Config.Labels "org.homerail.live_slot"}}{{.}}{{end}}' \
        "$id" 2>/dev/null
    )"; then
      continue
    fi
    [ -z "$label" ] && printf '%s\n' "$id"
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
    if ! label="$(
      docker image inspect \
        --format '{{with index .Config.Labels "org.homerail.live_slot"}}{{.}}{{end}}' \
        "$id" 2>/dev/null
    )"; then
      continue
    fi
    [ -z "$label" ] && printf '%s\n' "$id"
  done < <(docker images --filter "label=org.homerail.live_run" --format "{{.ID}}" | sort -u)
}

cleanup_scope() {
  local slot="$1" home_base="$2"
  local -a containers images
  local failed=0

  mkdir -p "$home_base" || return 1
  mapfile -t containers < <(container_ids_for_scope "$slot")
  if [ "${#containers[@]}" -gt 0 ]; then
    if ! docker rm -f "${containers[@]}" >/dev/null; then
      failed=1
    fi
  fi

  mapfile -t images < <(image_ids_for_scope "$slot")
  if [ "${#images[@]}" -gt 0 ]; then
    if ! docker image rm -f "${images[@]}" >/dev/null; then
      failed=1
    fi
  fi

  if ! find "$home_base" -mindepth 1 -maxdepth 1 -type d -name 'run-*' -exec rm -rf -- {} +; then
    failed=1
  fi
  return "$failed"
}

cleanup_scope_with_lock() (
  local slot="$1" home_base="$2" lock_file="$3"
  mkdir -p "$(dirname "$lock_file")" "$home_base" || exit 1
  exec 9>"$lock_file" || exit 1
  flock -n 9 || exit 0
  cleanup_scope "$slot" "$home_base"
)

mkdir -p "$RUNNER_BASE" "$HOME_ROOT"
cleanup_failed=0

if [ -n "${HOMERAIL_LIVE_SLOT:-}" ]; then
  LIVE_SLOT="$(sanitize_slot "$HOMERAIL_LIVE_SLOT")"
  case "$LIVE_SLOT" in
    ""|.|..) exit 1 ;;
  esac
  HOME_BASE="$HOME_ROOT/slots/$LIVE_SLOT"
  LOCK_FILE="$RUNNER_BASE/slots/$LIVE_SLOT/dag-patterns-live.lock"
  if [ "${HOMERAIL_CLEANUP_LOCK_HELD:-0}" = "1" ]; then
    if ! cleanup_scope "$LIVE_SLOT" "$HOME_BASE"; then
      cleanup_failed=1
    fi
  else
    if ! cleanup_scope_with_lock "$LIVE_SLOT" "$HOME_BASE" "$LOCK_FILE"; then
      cleanup_failed=1
    fi
  fi
  exit "$cleanup_failed"
fi

# Legacy runs used one global lock and did not label resources with a runner slot.
LEGACY_LOCK_FILE="$RUNNER_BASE/dag-patterns-live.lock"
if [ "${HOMERAIL_CLEANUP_LOCK_HELD:-0}" = "1" ]; then
  if ! cleanup_scope "__legacy_unscoped__" "$HOME_ROOT"; then
    cleanup_failed=1
  fi
else
  if ! cleanup_scope_with_lock "__legacy_unscoped__" "$HOME_ROOT" "$LEGACY_LOCK_FILE"; then
    cleanup_failed=1
  fi
fi

shopt -s nullglob
for slot_dir in "$RUNNER_BASE"/slots/*; do
  [ -d "$slot_dir" ] || continue
  LIVE_SLOT="$(basename "$slot_dir")"
  HOME_BASE="$HOME_ROOT/slots/$LIVE_SLOT"
  if ! cleanup_scope_with_lock "$LIVE_SLOT" "$HOME_BASE" "$slot_dir/dag-patterns-live.lock"; then
    echo "Cleanup failed for live runner slot $LIVE_SLOT; continuing with remaining slots." >&2
    cleanup_failed=1
  fi
done
exit "$cleanup_failed"
