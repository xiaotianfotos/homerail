#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORKFLOW="${ROOT_DIR}/.github/workflows/ci.yml"
RUNNER_IMAGE="${HOMERAIL_ACT_IMAGE:-ghcr.io/catthehacker/ubuntu@sha256:2362bb12b0c61438d334b9ed3686809981796a864ab89d93b5ee657652774eb7}"
DEFAULT_JOBS=(core-linux agent-ui-coverage docker-smoke)

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    printf 'Required command not found: %s\n' "$1" >&2
    exit 1
  fi
}

require_command actionlint
require_command act
require_command docker

docker info >/dev/null
actionlint "${WORKFLOW}"

if (( $# > 0 )); then
  jobs=("$@")
else
  jobs=("${DEFAULT_JOBS[@]}")
fi

cd "${ROOT_DIR}"
for job in "${jobs[@]}"; do
  case "${job}" in
    core-linux|agent-ui-coverage|docker-smoke) ;;
    *)
      printf 'Unsupported local job: %s\n' "${job}" >&2
      printf 'Supported jobs: %s\n' "${DEFAULT_JOBS[*]}" >&2
      exit 1
      ;;
  esac

  act pull_request \
    --job "${job}" \
    --workflows "${WORKFLOW}" \
    --platform "ubuntu-latest=${RUNNER_IMAGE}" \
    --container-architecture linux/amd64 \
    --pull=false
done
