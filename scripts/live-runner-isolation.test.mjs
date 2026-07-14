import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cleanupScript = path.join(repoRoot, "scripts", "cleanup-dag-patterns-live-runner.sh");

test("routes live jobs to isolated runner slots and serializes only Manager port allocation", () => {
  const ci = fs.readFileSync(path.join(repoRoot, ".github", "workflows", "ci.yml"), "utf8");
  const review = fs.readFileSync(path.join(repoRoot, ".github", "workflows", "pr-review.yml"), "utf8");
  const actionlint = fs.readFileSync(path.join(repoRoot, ".github", "actionlint.yaml"), "utf8");
  const runner = fs.readFileSync(path.join(repoRoot, "scripts", "run-dag-patterns-live-runner.sh"), "utf8");

  assert.match(ci, /HOMERAIL_LIVE_SLOT: \$\{\{ runner\.name \}\}/);
  assert.match(ci, /PR_BASE_SHA: \$\{\{ github\.event\.pull_request\.base\.sha \}\}/);
  assert.match(ci, /HOMERAIL_LIVE_ISSUE_REVISION=\$revision/);
  assert.match(review, /runs-on: \[self-hosted, Linux, X64, homerail-pr-review\]/);
  assert.match(review, /HOMERAIL_LIVE_SLOT: \$\{\{ runner\.name \}\}/);
  assert.match(actionlint, /- homerail-pr-review/);
  assert.match(runner, /org\.homerail\.live_slot=\$LIVE_SLOT/);
  assert.match(runner, /LIVE_RUN_LABEL="org\.homerail\.live_run_v2"/);
  assert.match(runner, /--label "\$LIVE_RUN_LABEL=\$RUN_KEY"/);
  assert.match(runner, /manager-port-allocation\.lock/);
  assert.match(runner, /dag chats "\$REVIEW_RUN_ID" --tools 20 --raw-tools/);
  assert.doesNotMatch(runner, /--timeout-ms/);
  assert.match(runner, /--stall-timeout-ms/);

  const acquire = runner.indexOf('flock -w 60 8');
  const start = runner.indexOf('cli.js" start --host');
  const cleanupStart = runner.indexOf("cleanup() {");
  const cleanupRelease = runner.indexOf('flock -u 8', cleanupStart);
  const cleanupRuntimeStop = runner.indexOf('cli.js" runtime stop', cleanupStart);
  const releaseAfterStart = runner.indexOf('flock -u 8', start);
  assert.ok(acquire >= 0 && acquire < start, "port lock must be held before Manager starts");
  assert.ok(releaseAfterStart > start, "port lock must be released after Manager binds its port");
  assert.ok(
    cleanupRelease > cleanupStart && cleanupRelease < cleanupRuntimeStop,
    "failure cleanup must release the port lock before stopping runtime resources",
  );
});

test("cleanup fails closed when a custom home omits the matching runner root", { skip: process.platform !== "linux" }, (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "homerail-live-runner-config-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const customHome = path.join(root, "custom-home");
  const sentinel = path.join(customHome, "slots", "slot-a", "run-active", "sentinel");
  fs.mkdirSync(path.dirname(sentinel), { recursive: true });
  fs.writeFileSync(sentinel, "active");

  const result = spawnSync("bash", [cleanupScript], {
    cwd: repoRoot,
    env: {
      ...process.env,
      HOME: path.join(root, "default-home"),
      HOMERAIL_RUNNER_BASE: "",
      HOMERAIL_LIVE_HOME_BASE: customHome,
    },
    encoding: "utf8",
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /HOMERAIL_RUNNER_BASE is required/);
  assert.equal(fs.readFileSync(sentinel, "utf8"), "active");
});

test("cleanup removes only one unlocked live runner slot", { skip: process.platform !== "linux" }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "homerail-live-runner-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const runnerBase = path.join(root, "runner");
  const homeRoot = path.join(root, "home");
  const fakeBin = path.join(root, "bin");
  const dockerLog = path.join(root, "docker.log");
  const runA = path.join(homeRoot, "slots", "slot-a", "run-a");
  const runB = path.join(homeRoot, "slots", "slot-b", "run-b");
  const legacyRun = path.join(homeRoot, "run-legacy");
  fs.mkdirSync(fakeBin, { recursive: true });
  fs.mkdirSync(runA, { recursive: true });
  fs.mkdirSync(runB, { recursive: true });
  fs.mkdirSync(legacyRun, { recursive: true });

  const fakeDocker = `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "$DOCKER_LOG"
case "\${1:-}" in
  ps)
    case "$*" in
      *live_slot=slot-a*) echo container-a ;;
      *live_slot=slot-b*) echo container-b ;;
      *live_run*) printf '%s\\n' container-legacy container-a container-b container-inspect-error ;;
    esac
    ;;
  images)
    case "$*" in
      *live_slot=slot-a*) echo image-a ;;
      *live_slot=slot-b*) echo image-b ;;
      *live_run*) printf '%s\\n' image-legacy image-a image-b image-inspect-error ;;
    esac
    ;;
  container)
    id="\${!#}"
    case "$id" in
      container-a) echo slot-a ;;
      container-b) echo slot-b ;;
      container-legacy) ;;
      container-inspect-error) exit 42 ;;
    esac
    ;;
  image)
    if [ "\${2:-}" = "inspect" ]; then
      id="\${!#}"
      case "$id" in
        image-a) echo slot-a ;;
        image-b) echo slot-b ;;
        image-legacy) ;;
        image-inspect-error) exit 42 ;;
      esac
    fi
    ;;
  rm)
    if [ "\${FAIL_SLOT_A:-0}" = "1" ] && [[ "$*" == *container-a* ]]; then
      exit 42
    fi
    ;;
esac
`;
  const dockerPath = path.join(fakeBin, "docker");
  fs.writeFileSync(dockerPath, fakeDocker, { mode: 0o755 });

  const baseEnv = {
    ...process.env,
    PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
    DOCKER_LOG: dockerLog,
    HOMERAIL_RUNNER_BASE: runnerBase,
    HOMERAIL_LIVE_HOME_BASE: homeRoot,
    HOMERAIL_CLEANUP_LOCK_HELD: "0",
  };
  const runCleanup = (extraEnv = {}, expectedStatus = 0) => {
    const result = spawnSync("bash", [cleanupScript], {
      cwd: repoRoot,
      env: { ...baseEnv, HOMERAIL_LIVE_SLOT: "", ...extraEnv },
      encoding: "utf8",
    });
    assert.equal(result.status, expectedStatus, result.stderr);
    return result;
  };

  runCleanup({ HOMERAIL_LIVE_SLOT: "slot-a" });
  assert.equal(fs.existsSync(runA), false);
  assert.equal(fs.existsSync(runB), true);
  assert.equal(fs.existsSync(legacyRun), true);
  let removals = fs.readFileSync(dockerLog, "utf8").split("\n").filter((line) => /^(rm -f|image rm -f)/.test(line));
  assert.deepEqual(removals, ["rm -f container-a", "image rm -f image-a"]);

  fs.mkdirSync(runA, { recursive: true });
  fs.writeFileSync(dockerLog, "");
  runCleanup({ HOMERAIL_LIVE_SLOT: "slot-a", HOMERAIL_CLEANUP_LOCK_HELD: "1" });
  assert.equal(fs.existsSync(runA), false);
  removals = fs.readFileSync(dockerLog, "utf8").split("\n").filter((line) => /^(rm -f|image rm -f)/.test(line));
  assert.deepEqual(removals, ["rm -f container-a", "image rm -f image-a"]);

  fs.writeFileSync(dockerLog, "");
  const slotBLock = path.join(runnerBase, "slots", "slot-b", "dag-patterns-live.lock");
  const lockReady = path.join(root, "lock-ready");
  fs.mkdirSync(path.dirname(slotBLock), { recursive: true });
  const lockHolder = spawn("bash", ["-c", 'exec 9>"$1"; flock 9; : >"$2"; sleep 30', "bash", slotBLock, lockReady]);
  t.after(() => lockHolder.kill("SIGTERM"));
  for (let attempt = 0; attempt < 100 && !fs.existsSync(lockReady); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(fs.existsSync(lockReady), true, "slot lock holder did not start");

  runCleanup();
  assert.equal(fs.existsSync(legacyRun), false);
  assert.equal(fs.existsSync(runB), true, "timer cleanup must skip a locked slot");
  removals = fs.readFileSync(dockerLog, "utf8").split("\n").filter((line) => /^(rm -f|image rm -f)/.test(line));
  assert.ok(removals.includes("rm -f container-legacy"));
  assert.ok(removals.includes("image rm -f image-legacy"));
  assert.ok(
    removals.every(
      (line) =>
        !line.includes("container-b") &&
        !line.includes("image-b") &&
        !line.includes("container-inspect-error") &&
        !line.includes("image-inspect-error"),
    ),
  );

  if (lockHolder.exitCode === null) {
    lockHolder.kill("SIGTERM");
    await new Promise((resolve) => lockHolder.once("exit", resolve));
  }
  runCleanup();
  assert.equal(fs.existsSync(runB), false);
  removals = fs.readFileSync(dockerLog, "utf8").split("\n").filter((line) => /^(rm -f|image rm -f)/.test(line));
  assert.ok(removals.includes("rm -f container-b"));
  assert.ok(removals.includes("image rm -f image-b"));

  fs.mkdirSync(runA, { recursive: true });
  fs.mkdirSync(runB, { recursive: true });
  fs.writeFileSync(dockerLog, "");
  const failedCleanup = runCleanup({ FAIL_SLOT_A: "1" }, 1);
  assert.match(failedCleanup.stderr, /Cleanup failed for live runner slot slot-a/);
  assert.equal(fs.existsSync(runA), false);
  assert.equal(fs.existsSync(runB), false, "a failed slot must not prevent later slot cleanup");
  removals = fs.readFileSync(dockerLog, "utf8").split("\n").filter((line) => /^(rm -f|image rm -f)/.test(line));
  assert.ok(removals.includes("rm -f container-b"));
  assert.ok(removals.includes("image rm -f image-b"));
});
