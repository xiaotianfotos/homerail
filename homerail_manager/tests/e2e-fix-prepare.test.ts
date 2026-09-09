import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prepareE2eFix } from "../src/runtime/e2e-fix-prepare.js";
import { e2eFixDigest } from "../src/runtime/e2e-fix-candidates.js";
import { parseWorkflowSource } from "../src/orchestration/workflow-spec-v1.js";
import type { E2eFixTaskConfig } from "../src/runtime/e2e-fix-stage.js";

describe.skipIf(process.platform !== "linux")("offline E2E Fix preparation", () => {
  let root: string;
  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-prepare-")); });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));
  function input() {
    const source = path.join(root, "source"), runtime = path.join(root, "runtime");
    fs.mkdirSync(source); fs.mkdirSync(runtime);
    // Preparation pins the descriptor only; stage bootstrap verifies inventory.
    fs.writeFileSync(path.join(runtime, "manifest.json"), "{}");
    const sha = e2eFixDigest("{}");
    const config: E2eFixTaskConfig = {
      version: 1, task_id: "task", root_run_id: "root", mode: "production",
      source_repo: source, repo: "fixture/repo", base: "a".repeat(40),
      issue: { number: 1, title: "Fix sum", body: "Signed addition" },
      allowed_paths: ["sum.js"], protected_paths: ["tests"],
      tests: [{ id: "sum", image: "sha256:" + "b".repeat(64), argv: ["node", "/checks/test.js"],
        cwd: ".", timeout_ms: 1000, memory_mb: 256, workspace_mb: 64, cpus: 1, pids_limit: 64,
        files: { "test.js": "throw new Error('fixture only');" } }],
      policy: { required_tests: ["sum"], reviewer_ids: ["review_a", "review_b", "review_c"], review_approvals: 2,
        required_ci_jobs: ["unit"], ci_workflow_path: ".github/workflows/ci.yml" },
      max_rounds: 3, max_infra_retries: 1, context_bytes: 64000, total_timeout_ms: 100000,
      runtime_sha256: sha, host_codex: { model: "fixture-codex", timeout_ms: 30000, output_bytes: 64000 },
      github: { base_ref: "main", job_names: { unit: "Unit tests" }, wait_ms: 30000, poll_ms: 1000, checkout_ref: "c".repeat(40) },
    };
    return { directory: path.join(root, "prepared"), config, runtime: { directory: runtime, sha256: sha },
      profile: { profile_id: "root", workflow_id: "root", default: { llm_setting_id: "offline-setting", agent_type: "deepseek_harness" } },
      stage_timeout_ms: 60000 };
  }
  it("emits a parseable durable graph bound to final custody paths and an honest offline manifest", () => {
    const value = input(), result = prepareE2eFix(value);
    expect(result.started).toBe(false);
    for (const [name, sha] of Object.entries(result.files)) expect(e2eFixDigest(fs.readFileSync(path.join(value.directory, name)))).toBe(sha);
    const workflow = JSON.parse(fs.readFileSync(path.join(value.directory, "workflow.json"), "utf8"));
    const parsed = parseWorkflowSource(JSON.stringify(workflow));
    expect(parsed.graph.nodes.find(n => n.node_id === "fix")!.node_type).toBe("agent");
    for (const id of ["plan", "judge_candidate", "judge_ci", "test", "publish", "ci"]) {
      const node = workflow.spec.nodes[id];
      expect(node.config.durable).toBe(true);
      expect(node.config.command).toContain(path.join(value.directory, "task"));
      expect(node.config.command).toContain(value.runtime.sha256);
    }
    expect(fs.statSync(value.directory).mode & 0o077).toBe(0);
    expect(fs.readdirSync(path.join(value.directory, "task")).sort()).toEqual(["config.json", "config.sha256"]);
    const before = fs.readFileSync(path.join(value.directory, "prepared.json"));
    expect(() => prepareE2eFix(value)).toThrow(/exist/i);
    expect(fs.readFileSync(path.join(value.directory, "prepared.json"))).toEqual(before);
  });
  it("keeps optional host Fixer as a native command", () => {
    const value = input(); value.config.host_codex!.fixer = true; prepareE2eFix(value);
    const workflow = JSON.parse(fs.readFileSync(path.join(value.directory, "workflow.json"), "utf8"));
    expect(workflow.spec.nodes.fix.kind).toBe("command");
    expect(workflow.spec.nodes.fix.config.command.slice(-2)).toEqual(["host-codex", "fix"]);
  });
  it("rejects wrong runtime/profile identity and credentials before creating custody", () => {
    const value = input(); value.config.runtime_sha256 = "d".repeat(64);
    expect(() => prepareE2eFix(value)).toThrow(/digest mismatch/);
    value.config.runtime_sha256 = value.runtime.sha256; value.profile.workflow_id = "other";
    expect(() => prepareE2eFix(value)).toThrow(/identities/);
    value.profile.workflow_id = "root";
    Object.assign(value.profile.default, { api_key: "fixture-not-a-secret" });
    expect(() => prepareE2eFix(value)).toThrow(/DB model_alias/);
    expect(fs.existsSync(value.directory)).toBe(false);
  });
  it("refuses an artifact directory within the source even through a symlinked parent", () => {
    const value = input(); fs.symlinkSync(value.config.source_repo, path.join(root, "alias"));
    value.directory = path.join(root, "alias", "private");
    expect(() => prepareE2eFix(value)).toThrow(/outside/);
    expect(fs.readdirSync(value.config.source_repo)).toEqual([]);
  });
  it("retains a failed preparation without issuing a completion manifest or overwriting it on retry", () => {
    const value = input(); value.config.policy.required_tests = ["invented"];
    expect(() => prepareE2eFix(value)).toThrow(/set mismatch/);
    expect(fs.existsSync(value.directory)).toBe(true);
    expect(fs.existsSync(path.join(value.directory, "prepared.json"))).toBe(false);
    value.config.policy.required_tests = ["sum"];
    expect(() => prepareE2eFix(value)).toThrow(/exist/i);
  });
});
