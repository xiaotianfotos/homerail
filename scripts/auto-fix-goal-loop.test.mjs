import assert from "node:assert/strict";
import { chmod, cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "homerail-auto-fix-goal-loop-"));
  const scripts = path.join(directory, "scripts");
  const checkout = path.join(directory, "checkout");
  const artifacts = path.join(directory, "artifacts");
  const input = path.join(artifacts, "input.json");
  const calls = path.join(directory, "checkpoint-calls.txt");
  await mkdir(scripts);
  await mkdir(checkout);
  await mkdir(artifacts);
  await cp(path.join(root, "scripts/run-auto-fix-goal-loop.sh"), path.join(scripts, "run-auto-fix-goal-loop.sh"));
  await writeFile(input, `${JSON.stringify({ repo: "owner/repo", issue: 92, revision: "a".repeat(40) })}\n`);
  await writeFile(path.join(scripts, "run-auto-fix-stable-runner.sh"), `#!/usr/bin/env bash
set -euo pipefail
mkdir -p "$HOMERAIL_AUTO_FIX_ARTIFACT_DIR"
cycle="$(basename "$HOMERAIL_AUTO_FIX_ARTIFACT_DIR")"
printf '{"cycle":"%s"}\\n' "$cycle" >"$HOMERAIL_AUTO_FIX_ARTIFACT_DIR/auto-fix.json"
printf 'patch-%s\\n' "$cycle" >"$HOMERAIL_AUTO_FIX_ARTIFACT_DIR/auto-fix.patch"
printf 'report-%s\\n' "$cycle" >"$HOMERAIL_AUTO_FIX_ARTIFACT_DIR/auto-fix.md"
printf '{"run_id":"%s","status":"completed"}\\n' "$HOMERAIL_STABLE_RUN_ID" >"$HOMERAIL_AUTO_FIX_ARTIFACT_DIR/command.json"
printf '{"recorded":true}\\n' >"$HOMERAIL_AUTO_FIX_ARTIFACT_DIR/checkpoint.json"
printf 'revision\\n' >"$HOMERAIL_AUTO_FIX_ARTIFACT_DIR/manager-revision.txt"
`);
  await writeFile(path.join(scripts, "validate-auto-fix-checkout.sh"), `#!/usr/bin/env bash
set -euo pipefail
if [[ "$2" == *"/cycle-0001/"* ]]; then
  echo "focused validation failed"
  exit 1
fi
echo "validation passed"
`);
  await writeFile(path.join(scripts, "auto-fix-checkpoint.mjs"), `import fs from "node:fs";
fs.appendFileSync(process.env.CHECKPOINT_CALLS, process.argv.slice(2).join("|") + "\\n");
process.stdout.write('{"recorded":true}\\n');
`);
  for (const file of [
    "run-auto-fix-goal-loop.sh",
    "run-auto-fix-stable-runner.sh",
    "validate-auto-fix-checkout.sh",
  ]) {
    await chmod(path.join(scripts, file), 0o755);
  }
  return { directory, scripts, checkout, artifacts, input, calls };
}

test("keeps iterating from validation evidence until a candidate passes", async () => {
  const { scripts, checkout, artifacts, input, calls } = await fixture();
  const result = spawnSync("bash", [
    path.join(scripts, "run-auto-fix-goal-loop.sh"),
    checkout,
    input,
    artifacts,
    "auto-fix-test",
  ], {
    encoding: "utf8",
    env: {
      ...process.env,
      HOMERAIL_NODE_BIN: process.execPath,
      CHECKPOINT_CALLS: calls,
    },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /failed isolated validation/);
  assert.match(result.stdout, /goal reached after 2 cycle/);
  assert.equal(await readFile(path.join(artifacts, "cycle-count.txt"), "utf8"), "2\n");
  assert.equal(await readFile(path.join(artifacts, "run-id.txt"), "utf8"), "auto-fix-test-cycle-0002\n");
  assert.equal(JSON.parse(await readFile(path.join(artifacts, "auto-fix.json"), "utf8")).cycle, "cycle-0002");
  assert.match(await readFile(calls, "utf8"), /record\|.*input\.json\|auto-fix-test-cycle-0001\|.*validation\.log/);
  assert.match(await readFile(path.join(artifacts, "cycle-0001/validation.log"), "utf8"), /focused validation failed/);
});

test("continues after a DAG failure when the stable runner retained a candidate checkpoint", async () => {
  const { scripts, checkout, artifacts, input, calls } = await fixture();
  await writeFile(path.join(scripts, "run-auto-fix-stable-runner.sh"), `#!/usr/bin/env bash
set -euo pipefail
mkdir -p "$HOMERAIL_AUTO_FIX_ARTIFACT_DIR"
cycle="$(basename "$HOMERAIL_AUTO_FIX_ARTIFACT_DIR")"
if [ "$cycle" = "cycle-0001" ]; then
  printf '{"recorded":true,"artifact":"candidate-v1.json"}\\n' >"$HOMERAIL_AUTO_FIX_ARTIFACT_DIR/checkpoint.json"
  exit 1
fi
printf '{"cycle":"%s"}\\n' "$cycle" >"$HOMERAIL_AUTO_FIX_ARTIFACT_DIR/auto-fix.json"
printf 'patch-%s\\n' "$cycle" >"$HOMERAIL_AUTO_FIX_ARTIFACT_DIR/auto-fix.patch"
printf 'report-%s\\n' "$cycle" >"$HOMERAIL_AUTO_FIX_ARTIFACT_DIR/auto-fix.md"
printf '{"run_id":"%s","status":"completed"}\\n' "$HOMERAIL_STABLE_RUN_ID" >"$HOMERAIL_AUTO_FIX_ARTIFACT_DIR/command.json"
printf '{"recorded":true}\\n' >"$HOMERAIL_AUTO_FIX_ARTIFACT_DIR/checkpoint.json"
printf 'revision\\n' >"$HOMERAIL_AUTO_FIX_ARTIFACT_DIR/manager-revision.txt"
`);
  await chmod(path.join(scripts, "run-auto-fix-stable-runner.sh"), 0o755);

  const result = spawnSync("bash", [
    path.join(scripts, "run-auto-fix-goal-loop.sh"),
    checkout,
    input,
    artifacts,
    "auto-fix-checkpoint-resume",
  ], {
    encoding: "utf8",
    env: {
      ...process.env,
      HOMERAIL_NODE_BIN: process.execPath,
      CHECKPOINT_CALLS: calls,
    },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /ended after retaining a candidate checkpoint; continuing from it/);
  assert.match(result.stdout, /goal reached after 2 cycle/);
  assert.equal(await readFile(path.join(artifacts, "cycle-count.txt"), "utf8"), "2\n");
  assert.equal(
    await readFile(path.join(artifacts, "run-id.txt"), "utf8"),
    "auto-fix-checkpoint-resume-cycle-0002\n",
  );
});
