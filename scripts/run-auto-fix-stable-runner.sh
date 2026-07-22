#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
export HOMERAIL_STABLE_TASK=auto-fix
exec bash "$SCRIPT_DIR/run-stable-dag-runner.sh"
