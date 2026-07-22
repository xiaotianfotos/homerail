#!/usr/bin/env bash

# Shared bootstrap for GitHub runners that submit durable DAG runs to the
# auto-deployed stable HomeRail Manager. The caller must use `set -euo pipefail`.

initialize_stable_automation_runtime() {
  local root="${HOMERAIL_STABLE_ROOT:-}"
  local home="${HOMERAIL_STABLE_HOME:-}"
  local manager_url="${HOMERAIL_STABLE_MANAGER_URL:-}"

  if [[ "$root" != /* ]] || [[ "$home" != /* ]]; then
    echo "HOMERAIL_STABLE_ROOT and HOMERAIL_STABLE_HOME must be absolute paths." >&2
    return 1
  fi
  if [[ ! "$manager_url" =~ ^http://(127\.[0-9.]+|172\.(1[6-9]|2[0-9]|3[01])\.[0-9]+\.[0-9]+|\[[0-9A-Fa-f:]+\]):[0-9]{1,5}$ ]]; then
    echo "HOMERAIL_STABLE_MANAGER_URL must be a loopback or private Docker-bridge HTTP URL with an explicit port." >&2
    return 1
  fi

  HOMERAIL_STABLE_RELEASE="$(readlink -f "$root/current" 2>/dev/null || true)"
  HOMERAIL_STABLE_NODE="$HOMERAIL_STABLE_RELEASE/runtime/node"
  HOMERAIL_STABLE_CLI="$HOMERAIL_STABLE_RELEASE/homerail_cli/dist/cli.js"
  HOMERAIL_STABLE_REVISION_FILE="$HOMERAIL_STABLE_RELEASE/REVISION"
  HOMERAIL_STABLE_TOKEN_FILE="$home/manager/secrets/dag-mutation.token"

  if [[ "$HOMERAIL_STABLE_RELEASE" != "$root"/releases/* ]] \
    || [ ! -x "$HOMERAIL_STABLE_NODE" ] \
    || [ ! -f "$HOMERAIL_STABLE_CLI" ] \
    || [ ! -f "$HOMERAIL_STABLE_REVISION_FILE" ]; then
    echo "Stable HomeRail release is incomplete under $root/current." >&2
    return 1
  fi
  if [ -L "$HOMERAIL_STABLE_TOKEN_FILE" ] || [ ! -f "$HOMERAIL_STABLE_TOKEN_FILE" ]; then
    echo "Stable Manager DAG mutation token is missing or unsafe." >&2
    return 1
  fi
  if [ "$(stat -Lc '%a' "$HOMERAIL_STABLE_TOKEN_FILE")" != "600" ]; then
    echo "Stable Manager DAG mutation token must have mode 0600." >&2
    return 1
  fi

  HOMERAIL_STABLE_REVISION="$(tr -d '[:space:]' < "$HOMERAIL_STABLE_REVISION_FILE")"
  HOMERAIL_DAG_MUTATION_TOKEN="$(tr -d '\r\n' < "$HOMERAIL_STABLE_TOKEN_FILE")"
  if [[ ! "$HOMERAIL_STABLE_REVISION" =~ ^[0-9a-f]{40}$ ]] \
    || [[ ! "$HOMERAIL_DAG_MUTATION_TOKEN" =~ ^[A-Za-z0-9_-]{43}$ ]]; then
    echo "Stable release revision or DAG mutation token has an invalid format." >&2
    return 1
  fi

  export HOMERAIL_STABLE_RELEASE HOMERAIL_STABLE_NODE HOMERAIL_STABLE_CLI
  export HOMERAIL_STABLE_REVISION HOMERAIL_DAG_MUTATION_TOKEN
  export HOMERAIL_HOME="$home"
  export HOMERAIL_MANAGER_URL="$manager_url"
  export HOMERAIL_ASSET_DIR="$HOMERAIL_STABLE_RELEASE/assets"

  curl -fsS --connect-timeout 3 --max-time 10 "$manager_url/health" >/dev/null
}

stable_hr() {
  "$HOMERAIL_STABLE_NODE" "$HOMERAIL_STABLE_CLI" \
    --base-url "$HOMERAIL_MANAGER_URL" "$@"
}
