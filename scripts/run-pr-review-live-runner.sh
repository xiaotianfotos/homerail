#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
export HOMERAIL_LIVE_TASK=pr-review
exec bash "$SCRIPT_DIR/run-dag-patterns-live-runner.sh"
