#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -ne 3 ]; then
  echo "usage: validate-auto-fix-checkout.sh <trusted-checkout> <auto-fix.json> <auto-fix.patch>" >&2
  exit 2
fi

TRUSTED_CHECKOUT="$(cd "$1" && pwd)"
PUBLICATION_PATH="$(readlink -f "$2")"
PATCH_PATH="$(readlink -f "$3")"
VALIDATOR_IMAGE="${HOMERAIL_AUTO_FIX_VALIDATOR_IMAGE:-mcr.microsoft.com/playwright:v1.57.0-noble@sha256:3bed4b1a12f2338642f3d8cba28e291deef3c66bd4a964bbeb3e57bbff511dbd}"
RUNNER_TEMP_ROOT="${RUNNER_TEMP:-${TMPDIR:-/tmp}}"
VALIDATION_ROOT="$(mktemp -d "$RUNNER_TEMP_ROOT/homerail-auto-fix-validation.XXXXXX")"
VALIDATION_CHECKOUT="$VALIDATION_ROOT/source"
NODE_BIN="${HOMERAIL_NODE_BIN:-node}"
REVISION="$($NODE_BIN -e 'const fs=require("fs");const v=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));if(!/^[0-9a-f]{40}$/i.test(v.revision))process.exit(1);process.stdout.write(v.revision)' "$PUBLICATION_PATH")"

cleanup() {
  git -C "$TRUSTED_CHECKOUT" worktree remove --force "$VALIDATION_CHECKOUT" >/dev/null 2>&1 || true
  rm -rf "$VALIDATION_ROOT"
}
trap cleanup EXIT

if [ -n "$(git -C "$TRUSTED_CHECKOUT" status --porcelain)" ]; then
  echo "Trusted Auto Fix checkout must be clean." >&2
  exit 1
fi
if [ "$(git -C "$TRUSTED_CHECKOUT" rev-parse HEAD)" != "$REVISION" ]; then
  echo "Trusted Auto Fix checkout is not at the published base revision." >&2
  exit 1
fi

git -C "$TRUSTED_CHECKOUT" worktree add --detach "$VALIDATION_CHECKOUT" "$REVISION"

# Dependencies come only from the trusted base. The candidate patch is applied
# after installation, so package lifecycle hooks proposed by a model do not run
# with network access.
docker run --rm \
  --user "$(id -u):$(id -g)" \
  --cap-drop ALL \
  --security-opt no-new-privileges \
  --pids-limit 1024 \
  --memory "${HOMERAIL_AUTO_FIX_MEMORY_LIMIT:-8g}" \
  --cpus "${HOMERAIL_AUTO_FIX_CPU_LIMIT:-8}" \
  --tmpfs /tmp:rw,nosuid,nodev,size=2g \
  -e HOME=/tmp/home \
  -e CI=1 \
  -v "$VALIDATION_CHECKOUT:/workspace" \
  -w /workspace \
  "$VALIDATOR_IMAGE" \
  npm run install:all

"$NODE_BIN" "$(dirname "$0")/apply-auto-fix-patch.mjs" "$VALIDATION_CHECKOUT" "$PUBLICATION_PATH" "$PATCH_PATH"

# The candidate receives no credentials, no Docker socket, no host Home, and no
# network. It can only mutate its disposable validation checkout and tmpfs.
docker run --rm \
  --network none \
  --user "$(id -u):$(id -g)" \
  --cap-drop ALL \
  --security-opt no-new-privileges \
  --pids-limit 1024 \
  --memory "${HOMERAIL_AUTO_FIX_MEMORY_LIMIT:-8g}" \
  --cpus "${HOMERAIL_AUTO_FIX_CPU_LIMIT:-8}" \
  --tmpfs /tmp:rw,nosuid,nodev,exec,size=2g \
  -e HOME=/tmp/home \
  -e CI=1 \
  -e NPM_CONFIG_OFFLINE=true \
  -v "$VALIDATION_CHECKOUT:/workspace" \
  -w /workspace \
  "$VALIDATOR_IMAGE" \
  npm run ci

echo "Auto Fix candidate passed the fixed offline validation command at $REVISION."
