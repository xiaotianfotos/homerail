import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("stable runner uses the deployed release and never starts a transient Manager", () => {
  const bootstrap = fs.readFileSync(path.join(root, "scripts/lib/stable-automation-runtime.sh"), "utf8");
  const runner = fs.readFileSync(path.join(root, "scripts/run-stable-dag-runner.sh"), "utf8");
  const reviewWorkflow = fs.readFileSync(path.join(root, ".github/workflows/pr-review.yml"), "utf8");
  assert.match(bootstrap, /HOMERAIL_STABLE_RELEASE=.*readlink -f.*current/);
  assert.match(bootstrap, /dag-mutation\.token/);
  assert.match(runner, /\$HOMERAIL_STABLE_RELEASE\/scripts\/configure-/);
  assert.doesNotMatch(runner, /npm run install:all|build:packages|run-pr-review-live-runner|docker compose/);
  assert.match(reviewWorkflow, /adapter_mode=release/);
  assert.match(reviewWorkflow, /steps\.stable\.outputs\.release }}\/scripts\/run-pr-review-stable-runner\.sh/);
  assert.match(reviewWorkflow, /github\.event\.pull_request\.number == 101/);
  assert.match(reviewWorkflow, /github\.ref == 'refs\/heads\/feat\/auto-fix-dag'/);
  assert.match(reviewWorkflow, /sparse-checkout:[\s\S]*scripts\/run-pr-review-stable-runner\.sh[\s\S]*scripts\/run-stable-dag-runner\.sh[\s\S]*scripts\/lib\/stable-automation-runtime\.sh/);
  assert.match(reviewWorkflow, /git -C "\$checkout_root" rev-parse HEAD/);
  assert.doesNotMatch(reviewWorkflow, /npm run install:all|build:packages|run-pr-review-live-runner|docker compose/);
});

test("manual CI validates the requested target revision in every non-live job", () => {
  const ci = fs.readFileSync(path.join(root, ".github/workflows/ci.yml"), "utf8");
  const nonLiveCi = ci.slice(0, ci.indexOf("  live-dag-patterns:"));
  const checkoutCount = [...nonLiveCi.matchAll(/uses: actions\/checkout@/g)].length;
  const targetRefCount = [
    ...nonLiveCi.matchAll(
      /ref: \$\{\{ github\.event_name == 'workflow_dispatch' && inputs\.target_ref \|\| github\.ref \}\}/g,
    ),
  ].length;

  assert.equal(checkoutCount, 4, "update this contract when adding another non-live CI checkout");
  assert.equal(
    targetRefCount,
    checkoutCount,
    "every manual non-live CI checkout must honor target_ref instead of silently testing main",
  );
});

test("Auto Fix validation installs trusted dependencies before applying the patch", () => {
  const source = fs.readFileSync(path.join(root, "scripts/validate-auto-fix-checkout.sh"), "utf8");
  const installIndex = source.indexOf("npm run install:all");
  const applyIndex = source.indexOf("apply-auto-fix-patch.mjs");
  const testIndex = source.indexOf("npm run ci");
  assert.ok(installIndex > 0 && applyIndex > installIndex && testIndex > applyIndex);
  assert.match(source.slice(applyIndex), /--network none/);
  assert.match(
    source.slice(applyIndex),
    /--tmpfs \/tmp:rw,nosuid,nodev,exec,size=2g/,
    "offline package tests must be able to execute isolated temporary fixtures",
  );
  assert.match(
    source,
    /mcr\.microsoft\.com\/playwright:v1\.57\.0-noble@sha256:[0-9a-f]{64}/,
    "validator image must pin the Chromium version required by the trusted base",
  );
  assert.match(source, /--cap-drop ALL/);
  assert.doesNotMatch(source, /docker\.sock|GITHUB_TOKEN|SSH_AUTH_SOCK/);
});

test("Auto Fix keeps model selection local and publishes only a human-gated Draft PR", () => {
  const workflow = fs
    .readFileSync(path.join(root, ".github/workflows/auto-fix.yml"), "utf8")
    .replace(/\r\n/g, "\n");
  const stableRunner = fs.readFileSync(path.join(root, "scripts/run-stable-dag-runner.sh"), "utf8");
  const validator = fs.readFileSync(path.join(root, "scripts/validate-auto-fix-checkout.sh"), "utf8");
  const publisher = fs.readFileSync(path.join(root, "scripts/publish-auto-fix-pr.sh"), "utf8");

  assert.match(workflow, /issues:\n    types: \[labeled\]/);
  assert.match(workflow, /github\.event\.sender\.login == 'xiaotianfotos'/);
  assert.match(workflow, /github\.event\.label\.name == 'auto-fix'/);
  assert.match(workflow, /runs-on: \[self-hosted, Linux, X64, homerail-auto-fix\]/);
  assert.match(workflow, /timeout-minutes: 210/);
  assert.match(workflow, /run-auto-fix-stable-runner\.sh/);
  assert.match(workflow, /steps\.stable\.outputs\.release }}\/scripts\/validate-auto-fix-checkout\.sh/);
  assert.match(workflow, /steps\.stable\.outputs\.release }}\/scripts\/publish-auto-fix-pr\.sh/);
  assert.doesNotMatch(workflow, /HOMERAIL_AUTO_FIX_(?:IMPLEMENTATION|REVIEW|ARBITRATION)_MODEL/);
  assert.doesNotMatch(workflow, /ssh[_-]?key|SSH_AUTH_SOCK|id_rsa|id_ed25519/i);
  assert.match(stableRunner, /initialize_stable_automation_runtime/);
  assert.match(stableRunner, /HOMERAIL_AUTO_FIX_TIMEOUT_SECONDS:-10800/);
  assert.match(stableRunner, /auto-fix-checkpoint\.mjs/);
  assert.match(stableRunner, /hydrate "\$INPUT_FILE"/);
  assert.ok(
    stableRunner.indexOf('INPUT_FILE="$ARTIFACT_DIR/input.json"') < stableRunner.indexOf('hydrate "$INPUT_FILE"'),
    "inline Auto Fix input must be materialized before checkpoint hydration",
  );
  assert.match(stableRunner, /candidate-v2\.json candidate-v2\.patch candidate-v1\.json candidate-v1\.patch/);
  assert.match(stableRunner, /stable_hr stop "\$HOMERAIL_STABLE_RUN_ID"/);
  assert.match(workflow, /Finalize durable candidate checkpoint/);
  assert.match(workflow, /steps\.publish\.outcome/);
  assert.doesNotMatch(stableRunner, /start --host|install:all|build:packages/);
  assert.match(validator, /npm run install:all/);
  assert.match(validator, /--network none/);
  assert.match(validator, /npm run ci/);
  assert.match(publisher, /gh pr create/);
  assert.match(publisher, /--draft/);
  assert.match(publisher, /41898282\+github-actions\[bot\]@users\.noreply\.github\.com/);
  assert.doesNotMatch(publisher, /gh pr (?:merge|review)|--approve|auto-merge/);
});
