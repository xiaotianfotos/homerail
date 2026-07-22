#!/usr/bin/env sh
set -eu

case "${1:-}" in
  *Username*) printf '%s\n' x-access-token ;;
  *)
    if [ -z "${GH_TOKEN:-}" ]; then
      echo "GH_TOKEN is required" >&2
      exit 1
    fi
    printf '%s\n' "$GH_TOKEN"
    ;;
esac
