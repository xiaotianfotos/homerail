import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildGoalWorkflow, buildWorkflow, executeNativeGoal, parseOptions, readGoalFile } from "./native-codex-subscription-smoke.mjs";
import { compileWorkflowSource } from "../homerail_manager/dist/orchestration/workflow-spec-v1.js";

const explicit = ["--execute", "--codex-home", "/trusted/codex-home", "--codex-bin", "/trusted/codex",
  "--model", "gpt-exact-contract", "--reasoning-effort", "medium", "--output-dir", "/private/results"];

test("one-shot requires an absolute goal file and retains exact explicit runtime selectors", () => {
  assert.deepEqual(parseOptions([...explicit, "--goal-file", "/private/validated-goal.txt"]), {
    execute: true, timeoutMs: 180_000, codexHome: "/trusted/codex-home", codexBin: "/trusted/codex",
    model: "gpt-exact-contract", effort: "medium", outputDir: "/private/results", goalFile: "/private/validated-goal.txt",
  });
  assert.throws(() => parseOptions([...explicit, "--goal-file", "relative.txt"]), /absolute/);
  assert.throws(() => parseOptions([...explicit, "--profile", "replacement"]), /Unknown/);
  assert.throws(() => parseOptions(["--execute", "--codex-home", "/a", "--codex-bin", "/b", "--output-dir", "/c"]), /model/);
  assert.equal(parseOptions([]).execute, false);
  assert.equal(parseOptions(explicit).goalFile, undefined);
});

test("the exported goal entry rejects untrusted runtime fields before launching anything", async () => {
  await assert.rejects(executeNativeGoal({ goalFile: "/private/goal", llmSettingId: "injected" }), /unsupported runtime fields/);
  await assert.rejects(executeNativeGoal({ goalFile: "/private/goal", command: "injected" }), /unsupported runtime fields/);
  await assert.rejects(executeNativeGoal({ goalFile: "/private/goal" }), /codexHome is required/);
});

test("goal file reader preserves exact UTF-8 text and rejects empty, invalid, or indirect inputs", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hr-goal-input-test-"));
  try {
    const file = path.join(root, "goal.txt");
    const goal = "\ufeff  只读分析此目标。\r\nKeep these spaces.  \n";
    fs.writeFileSync(file, goal, { mode: 0o600 });
    assert.equal(readGoalFile(file), goal);
    assert.deepEqual(Buffer.from(readGoalFile(file)), fs.readFileSync(file));
    fs.writeFileSync(file, " \r\n");
    assert.throws(() => readGoalFile(file), /nonempty/);
    fs.writeFileSync(file, Buffer.from([0xc3, 0x28]));
    assert.throws(() => readGoalFile(file), /encoded data/);
    fs.writeFileSync(file, "x".repeat(20_001));
    assert.throws(() => readGoalFile(file), /20000/);
    if (process.platform !== "win32") {
      const alias = path.join(root, "alias.txt");
      fs.symlinkSync(file, alias);
      assert.throws(() => readGoalFile(alias));
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("one-shot compiles to a real terminal while the full smoke retains its resumable topology", () => {
  const oneShot = buildGoalWorkflow("gpt-exact-contract", "medium", "goal-input-contract");
  const smoke = buildWorkflow("gpt-exact-contract", "medium", "smoke-input-contract");
  for (const workflow of [oneShot, smoke]) {
    const compiled = compileWorkflowSource(JSON.stringify(workflow));
    assert.equal(compiled.valid, true, JSON.stringify(compiled.diagnostics));
    assert.deepEqual(workflow.spec.agents.inspector.native_subscription,
      { provider: "codex", model: "gpt-exact-contract", reasoning_effort: "medium" });
    assert.equal(workflow.spec.nodes.inspect.codex_sandbox, "read-only");
    assert.deepEqual(workflow.spec.nodes.inspect.workspace_access, { writable_paths: [] });
    assert.equal(workflow.spec.agents.inspector.llm_setting_id, undefined);
    assert.equal(workflow.spec.agents.inspector.llm, undefined);
  }
  assert.equal(oneShot.spec.nodes.done.kind, "terminal");
  assert.equal(oneShot.spec.nodes.done.outcome, "success");
  assert.equal(oneShot.spec.nodes.suspend, undefined);
  assert.deepEqual(oneShot.spec.edges[1], { from: "inspect.result", to: "done.result" });
  assert.equal(smoke.spec.nodes.suspend.kind, "await_command");
  assert.equal(smoke.spec.nodes.done, undefined);
});
