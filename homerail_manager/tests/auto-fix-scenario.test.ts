import * as fs from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import * as os from "node:os";
import * as path from "node:path";

import { describe, expect, it } from "vitest";

import {
  compileWorkflowSource,
} from "../src/orchestration/workflow-spec-v1.js";

const WORKFLOW_FILE = path.resolve(
  import.meta.dirname,
  "../../assets/orchestrations/auto-fix.yaml.template",
);

describe("Auto Fix scenario asset", () => {
  it("compiles a model-neutral two-pass repair with independent final consensus", () => {
    const source = fs.readFileSync(WORKFLOW_FILE, "utf8");
    const result = compileWorkflowSource(source);

    expect(result.valid).toBe(true);
    expect(result.diagnostics).toEqual([]);
    expect(result.summary).toMatchObject({
      workflow_id: "auto-fix",
      node_count: 41,
      edge_count: 68,
    });
    expect(source).not.toMatch(/^\s*(?:provider|model|llm_setting_id|api_key|base_url):/m);
    expect(source).not.toContain("qwen");
    expect(source).not.toContain("kimi");
    expect(source).not.toContain("glm");

    const canonical = result.canonical!;
    expect(canonical.nodes.filter((node) => node.kind === "command").map((node) => node.id)).toEqual([
      "collect_implementation_patch",
      "collect_revised_patch",
      "finalize_publication",
      "prepare_repository",
    ]);
    expect(canonical.nodes.find((node) => node.id === "prepare_repository")).toMatchObject({
      kind: "command",
      config: {
        cwd: "$run_workspace",
        stdin_field: "$inputs",
        parse_stdout: "json",
        result_payload: "value",
      },
    });
    expect(canonical.nodes.find((node) => node.id === "investigate")?.config.workspace_access).toMatchObject({
      writable_paths: [".homerail-runtime"],
      readonly_paths: ["source"],
    });
    expect(canonical.nodes.find((node) => node.id === "investigate")?.config.allowed_builtin_tools).toEqual([
      "Glob",
      "Grep",
      "Read",
    ]);
    expect(canonical.nodes.find((node) => node.id === "verification_quorum")).toMatchObject({
      kind: "join",
      config: {
        mode: "n_of_m",
        threshold: 2,
        field: "verdict",
        success_values: ["approve"],
      },
    });
    expect(canonical.nodes.find((node) => node.id === "revise")).toMatchObject({
      kind: "agent",
      agent: "reviser",
      outputs: expect.arrayContaining([
        expect.objectContaining({ name: "reported", contract: "ImplementationReport" }),
      ]),
    });
    expect(canonical.nodes.find((node) => node.id === "arbitrate")).toMatchObject({
      kind: "agent",
      agent: "arbiter",
    });
    expect(canonical.nodes.find((node) => node.id === "publish")?.config.workspace_access).toMatchObject({
      writable_paths: [".homerail-runtime"],
      readonly_paths: ["source"],
    });
    expect(canonical.nodes.find((node) => node.id === "publish")).toMatchObject({
      outputs: expect.arrayContaining([
        expect.objectContaining({ name: "summarized", contract: "PublicationSummary" }),
      ]),
    });
    for (const nodeId of ["collect_implementation_patch", "collect_revised_patch", "finalize_publication"]) {
      expect(canonical.nodes.find((node) => node.id === nodeId)).toMatchObject({
        kind: "command",
        config: {
          command: ["node", "-e", expect.any(String)],
          cwd: "$run_workspace",
          stdin_field: "$inputs",
          parse_stdout: "json",
          result_payload: "value",
        },
      });
    }
    expect(canonical.artifacts).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "auto-fix.json", contract: "AutoFixResult" }),
      expect.objectContaining({
        name: "auto-fix.patch",
        media_type: "text/plain",
        source: expect.objectContaining({ json_pointer: "/patch" }),
      }),
      expect.objectContaining({
        name: "auto-fix.md",
        media_type: "text/markdown",
        source: expect.objectContaining({ json_pointer: "/markdown" }),
      }),
    ]));
  });

  it("keeps GitHub mutation and host-selected test commands outside the DAG", () => {
    const source = fs.readFileSync(WORKFLOW_FILE, "utf8");
    const canonical = compileWorkflowSource(source).canonical!;

    expect(source).not.toMatch(/\b(?:gh\s+pr|git\s+push|createPullRequest|test_command)\b/i);
    expect(source).not.toMatch(/^\s*credentials:/m);
    const commands = canonical.nodes.filter((node) => node.kind === "command");
    expect(commands.map((node) => node.id)).toEqual([
      "collect_implementation_patch",
      "collect_revised_patch",
      "finalize_publication",
      "prepare_repository",
    ]);
    expect(JSON.stringify(commands)).not.toMatch(/(?:gh\s+pr|git\s+push|test_command)/i);

    for (const nodeId of [
      "review_correctness_initial",
      "review_regression_initial",
      "review_adversarial_initial",
      "review_correctness_final",
      "review_regression_final",
      "review_adversarial_final",
      "arbitrate",
    ]) {
      const node = canonical.nodes.find((candidate) => candidate.id === nodeId);
      expect(node?.config.workspace_access).toMatchObject({ readonly_paths: ["source"] });
      expect(node?.config.workspace_access?.writable_paths).not.toContain("source");
    }
  });

  it("collects tracked and untracked repair files without mutating the real Git index", () => {
    const canonical = compileWorkflowSource(fs.readFileSync(WORKFLOW_FILE, "utf8")).canonical!;
    const commandNode = canonical.nodes.find((node) => node.id === "collect_implementation_patch");
    if (commandNode?.kind !== "command" || !commandNode.config.command) throw new Error("collector command is missing");
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "homerail-auto-fix-collector-"));
    const repository = path.join(workspace, "source");
    fs.mkdirSync(repository);
    execFileSync("git", ["init", "-q", repository]);
    execFileSync("git", ["-C", repository, "config", "user.name", "Test"]);
    execFileSync("git", ["-C", repository, "config", "user.email", "41898282+github-actions[bot]@users.noreply.github.com"]);
    fs.writeFileSync(path.join(repository, "tracked.txt"), "before\n");
    execFileSync("git", ["-C", repository, "add", "tracked.txt"]);
    execFileSync("git", ["-C", repository, "commit", "-qm", "base"]);
    fs.writeFileSync(path.join(repository, "tracked.txt"), "after\n");
    fs.writeFileSync(path.join(repository, "new.txt"), "new\n");

    const result = spawnSync(process.execPath, commandNode.config.command.slice(1), {
      cwd: workspace,
      encoding: "utf8",
      input: JSON.stringify({ report: [{ status: "fixed", explanation: "repair", test_plan: ["focused"] }] }),
    });
    expect(result.status, result.stderr).toBe(0);
    const collected = JSON.parse(result.stdout) as { patch: string; files_changed: string[] };
    expect(collected.files_changed).toEqual(["new.txt", "tracked.txt"]);
    expect(collected.patch).toContain("diff --git a/new.txt b/new.txt");
    expect(collected.patch).toContain("diff --git a/tracked.txt b/tracked.txt");
    expect(() => execFileSync("git", ["-C", repository, "diff", "--cached", "--quiet"])).not.toThrow();
  });

  it("rejects protected workflow paths before model review", () => {
    const canonical = compileWorkflowSource(fs.readFileSync(WORKFLOW_FILE, "utf8")).canonical!;
    const commandNode = canonical.nodes.find((node) => node.id === "collect_revised_patch");
    if (commandNode?.kind !== "command" || !commandNode.config.command) throw new Error("collector command is missing");
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "homerail-auto-fix-protected-"));
    const repository = path.join(workspace, "source");
    fs.mkdirSync(path.join(repository, ".github", "workflows"), { recursive: true });
    execFileSync("git", ["init", "-q", repository]);
    execFileSync("git", ["-C", repository, "config", "user.name", "Test"]);
    execFileSync("git", ["-C", repository, "config", "user.email", "41898282+github-actions[bot]@users.noreply.github.com"]);
    fs.writeFileSync(path.join(repository, ".github", "workflows", "ci.yml"), "name: base\n");
    execFileSync("git", ["-C", repository, "add", ".github/workflows/ci.yml"]);
    execFileSync("git", ["-C", repository, "commit", "-qm", "base"]);
    fs.writeFileSync(path.join(repository, ".github", "workflows", "ci.yml"), "name: changed\n");

    const result = spawnSync(process.execPath, commandNode.config.command.slice(1), {
      cwd: workspace,
      encoding: "utf8",
      input: JSON.stringify({ report: [{ status: "fixed", explanation: "unsafe", test_plan: [] }] }),
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("repair targets forbidden path");
  });

  it("finalizes trusted metadata while preserving patch bytes", () => {
    const canonical = compileWorkflowSource(fs.readFileSync(WORKFLOW_FILE, "utf8")).canonical!;
    const commandNode = canonical.nodes.find((node) => node.id === "finalize_publication");
    if (commandNode?.kind !== "command" || !commandNode.config.command) throw new Error("finalizer command is missing");
    const revision = "a".repeat(40);
    const patch = "diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-a\n+b\n";
    const input = {
      issue: [{ repo: "owner/repo", issue: 92, revision }],
      patch: [{ status: "fixed", patch, explanation: "repair", files_changed: ["a.txt"], test_plan: ["focused"] }],
      arbitration: [{ verdict: "approve", summary: "approved", blocking_defects: [] }],
      summary: [{ review_summary: "approved by consensus", markdown: `# Auto Fix #92\n\nBase: ${revision}\n` }],
    };
    const result = spawnSync(process.execPath, commandNode.config.command.slice(1), {
      cwd: os.tmpdir(), encoding: "utf8", input: JSON.stringify(input),
    });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      status: "ready", repo: "owner/repo", issue: 92, revision, patch,
      files_changed: ["a.txt"], review_summary: "approved by consensus",
    });
  });

  it("allows obvious test credential placeholders in a candidate patch", () => {
    const canonical = compileWorkflowSource(fs.readFileSync(WORKFLOW_FILE, "utf8")).canonical!;
    const commandNode = canonical.nodes.find((node) => node.id === "finalize_publication");
    if (commandNode?.kind !== "command" || !commandNode.config.command) throw new Error("finalizer command is missing");
    const revision = "b".repeat(40);
    const patch = [
      "diff --git a/example.test.ts b/example.test.ts",
      "--- a/example.test.ts",
      "+++ b/example.test.ts",
      "@@ -0,0 +1 @@",
      "+const credential = { api_key: 'test-api-key-0000' };",
      "",
    ].join("\n");
    const input = {
      issue: [{ repo: "owner/repo", issue: 92, revision }],
      patch: [{ status: "fixed", patch, explanation: "repair", files_changed: ["example.test.ts"], test_plan: ["focused"] }],
      arbitration: [{ verdict: "approve", summary: "approved", blocking_defects: [] }],
      summary: [{ review_summary: "approved by consensus", markdown: `# Auto Fix #92\n\nBase: ${revision}\n` }],
    };
    const result = spawnSync(process.execPath, commandNode.config.command.slice(1), {
      cwd: os.tmpdir(), encoding: "utf8", input: JSON.stringify(input),
    });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ status: "ready", patch });
  });

  it("scans many test placeholders without rescanning the patch for every match", () => {
    const canonical = compileWorkflowSource(fs.readFileSync(WORKFLOW_FILE, "utf8")).canonical!;
    const commandNode = canonical.nodes.find((node) => node.id === "finalize_publication");
    if (commandNode?.kind !== "command" || !commandNode.config.command) throw new Error("finalizer command is missing");
    const revision = "1".repeat(40);
    const additions = Array.from(
      { length: 4_000 },
      (_, index) => `+const fixture${index} = { api_key: 'test-api-key-0000' };`,
    );
    const patch = [
      "diff --git a/tests/many.test.ts b/tests/many.test.ts",
      "--- a/tests/many.test.ts",
      "+++ b/tests/many.test.ts",
      `@@ -0,0 +1,${additions.length} @@`,
      ...additions,
      "",
    ].join("\n");
    const input = {
      issue: [{ repo: "owner/repo", issue: 92, revision }],
      patch: [{ status: "fixed", patch, explanation: "repair", files_changed: ["tests/many.test.ts"], test_plan: [] }],
      arbitration: [{ verdict: "approve", summary: "approved", blocking_defects: [] }],
      summary: [{ review_summary: "approved by consensus", markdown: `# Auto Fix #92\n\nBase: ${revision}\n` }],
    };
    const result = spawnSync(process.execPath, commandNode.config.command.slice(1), {
      cwd: os.tmpdir(), encoding: "utf8", input: JSON.stringify(input), timeout: 3_000,
    });
    expect(result.status, result.stderr).toBe(0);
  });

  it.each([
    { field: "explanation", mutate: (candidate: Record<string, unknown>) => { candidate.explanation = { api_key: "hidden" }; } },
    { field: "files_changed", mutate: (candidate: Record<string, unknown>) => { candidate.files_changed = [{ api_key: "hidden" }]; } },
    { field: "test_plan", mutate: (candidate: Record<string, unknown>) => { candidate.test_plan = [{ api_key: "hidden" }]; } },
  ])("rejects a non-string $field before publication scanning", ({ mutate }) => {
    const canonical = compileWorkflowSource(fs.readFileSync(WORKFLOW_FILE, "utf8")).canonical!;
    const commandNode = canonical.nodes.find((node) => node.id === "finalize_publication");
    if (commandNode?.kind !== "command" || !commandNode.config.command) throw new Error("finalizer command is missing");
    const revision = "f".repeat(40);
    const candidate: Record<string, unknown> = {
      status: "fixed",
      patch: "diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-a\n+b\n",
      explanation: "repair",
      files_changed: ["a.txt"],
      test_plan: ["focused"],
    };
    mutate(candidate);
    const input = {
      issue: [{ repo: "owner/repo", issue: 92, revision }],
      patch: [candidate],
      arbitration: [{ verdict: "approve", summary: "approved", blocking_defects: [] }],
      summary: [{ review_summary: "approved by consensus", markdown: `# Auto Fix #92\n\nBase: ${revision}\n` }],
    };
    const result = spawnSync(process.execPath, commandNode.config.command.slice(1), {
      cwd: os.tmpdir(), encoding: "utf8", input: JSON.stringify(input),
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("FixCandidate input is invalid");
    expect(result.stderr).not.toContain("hidden");
  });

  it("rejects real-looking credentials with a redacted, actionable location", () => {
    const canonical = compileWorkflowSource(fs.readFileSync(WORKFLOW_FILE, "utf8")).canonical!;
    const commandNode = canonical.nodes.find((node) => node.id === "finalize_publication");
    if (commandNode?.kind !== "command" || !commandNode.config.command) throw new Error("finalizer command is missing");
    const revision = "c".repeat(40);
    const credential = ["r4Nd0m", "S3cr3t", "V4lu3", "9XyZ"].join("");
    const patch = [
      "diff --git a/src/config.ts b/src/config.ts",
      "--- a/src/config.ts",
      "+++ b/src/config.ts",
      "@@ -0,0 +1 @@",
      `+const client_secret = '${credential}';`,
      "",
    ].join("\n");
    const input = {
      issue: [{ repo: "owner/repo", issue: 92, revision }],
      patch: [{ status: "fixed", patch, explanation: "repair", files_changed: ["src/config.ts"], test_plan: [] }],
      arbitration: [{ verdict: "approve", summary: "approved", blocking_defects: [] }],
      summary: [{ review_summary: "approved by consensus", markdown: `# Auto Fix #92\n\nBase: ${revision}\n` }],
    };
    const result = spawnSync(process.execPath, commandNode.config.command.slice(1), {
      cwd: os.tmpdir(), encoding: "utf8", input: JSON.stringify(input),
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("publication patch (src/config.ts, patch line 5) contains credential-like client_secret assignment");
    expect(result.stderr).not.toContain(credential);
  });

  it.each([
    {
      name: "placeholder outside a test fixture path",
      file: "src/config.ts",
      credential: ["test", "api", "key", "0000"].join("-"),
    },
    {
      name: "marker-bearing value with an unrecognized secret token",
      file: "tests/config.test.ts",
      credential: ["sk", "test", "realcredential"].join("-"),
    },
  ])("rejects $name", ({ file, credential }) => {
    const canonical = compileWorkflowSource(fs.readFileSync(WORKFLOW_FILE, "utf8")).canonical!;
    const commandNode = canonical.nodes.find((node) => node.id === "finalize_publication");
    if (commandNode?.kind !== "command" || !commandNode.config.command) throw new Error("finalizer command is missing");
    const revision = "e".repeat(40);
    const patch = [
      `diff --git a/${file} b/${file}`,
      `--- a/${file}`,
      `+++ b/${file}`,
      "@@ -0,0 +1 @@",
      `+const api_key = '${credential}';`,
      "",
    ].join("\n");
    const input = {
      issue: [{ repo: "owner/repo", issue: 92, revision }],
      patch: [{ status: "fixed", patch, explanation: "repair", files_changed: [file], test_plan: [] }],
      arbitration: [{ verdict: "approve", summary: "approved", blocking_defects: [] }],
      summary: [{ review_summary: "approved by consensus", markdown: `# Auto Fix #92\n\nBase: ${revision}\n` }],
    };
    const result = spawnSync(process.execPath, commandNode.config.command.slice(1), {
      cwd: os.tmpdir(), encoding: "utf8", input: JSON.stringify(input),
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(`publication patch (${file}, patch line 5) contains credential-like api_key assignment`);
    expect(result.stderr).not.toContain(credential);
  });

  it.each([
    {
      name: "private network address",
      sensitive: ["192", "168", "100", "112"].join("."),
      diagnostic: "contains a private network address",
    },
    {
      name: "non-noreply email",
      sensitive: ["local", "example.com"].join("@"),
      diagnostic: "contains a non-noreply email",
    },
  ])("keeps $name publication protection strict", ({ sensitive, diagnostic }) => {
    const canonical = compileWorkflowSource(fs.readFileSync(WORKFLOW_FILE, "utf8")).canonical!;
    const commandNode = canonical.nodes.find((node) => node.id === "finalize_publication");
    if (commandNode?.kind !== "command" || !commandNode.config.command) throw new Error("finalizer command is missing");
    const revision = "d".repeat(40);
    const patch = `diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -0,0 +1 @@\n+${sensitive}\n`;
    const input = {
      issue: [{ repo: "owner/repo", issue: 92, revision }],
      patch: [{ status: "fixed", patch, explanation: "repair", files_changed: ["a.txt"], test_plan: [] }],
      arbitration: [{ verdict: "approve", summary: "approved", blocking_defects: [] }],
      summary: [{ review_summary: "approved by consensus", markdown: `# Auto Fix #92\n\nBase: ${revision}\n` }],
    };
    const result = spawnSync(process.execPath, commandNode.config.command.slice(1), {
      cwd: os.tmpdir(), encoding: "utf8", input: JSON.stringify(input),
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(diagnostic);
    expect(result.stderr).not.toContain(sensitive);
  });

});
