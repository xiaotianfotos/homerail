import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { registerAgentBackend } from "../agent/factory.js";
import type { AgentClient } from "../agent/types.js";
import { createDagTools, createDagToolsState } from "../dag-tools/index.js";
import { runPrompt } from "../prompt-runner.js";
import { snapshotWorkspace, verifyWorkspacePolicy } from "../workspace-policy.js";

describe("runtime pattern worker tools", () => {
  const oldWorkspace = process.env.WORKSPACE;

  afterEach(() => {
    if (oldWorkspace === undefined) delete process.env.WORKSPACE;
    else process.env.WORKSPACE = oldWorkspace;
  });

  it("consults a bounded advisor and preserves the executor tool state", async () => {
    const sent: string[] = [];
    const state = createDagToolsState({
      node_id: "executor",
      agent_type: "deterministic",
      model: "executor-model",
      outgoing_edges: [{ from_port: "done", to_node: "", to_port: "" }],
      incoming_edges: [],
      graph_nodes: ["executor"],
      advisors: [{
        id: "expert",
        agent_id: "advisor",
        agent_type: "deterministic",
        model: "advisor-model",
        max_calls: 1,
        timeout_ms: 1000,
        max_tokens: 100,
      }],
    }, "run-advisor", (message) => sent.push(message));
    const tools = createDagTools(state, {
      advisorRunner: async (advisor, question) => ({
        text: `${advisor.model}:sk-secretvalue123:${question}`,
        usage: { input_tokens: 5, output_tokens: 3 },
      }),
    });
    const tool = tools.find((candidate) => candidate.name === "consult_advisor")!;
    const first = await tool.handler({ advisor_id: "expert", question: "Which API?", context: { api_key: "secret-value" } });
    expect(first.is_error).not.toBe(true);
    expect(first.content[0].text).toContain("advisor-model");
    expect(state.yielded).toBe(false);
    expect(sent.map((message) => JSON.parse(message).data.event)).toEqual(["advisor_call_started", "advisor_call_completed"]);
    expect(sent.join("\n")).not.toContain("sk-secretvalue123");
    expect(sent.join("\n")).not.toContain("secret-value");
    expect(JSON.parse(sent[0]!).data.request.context.api_key).toBe("***REDACTED***");
    expect(JSON.parse(sent[1]!).data.usage).toEqual({ input_tokens: 5, output_tokens: 3 });
    expect((await tool.handler({ advisor_id: "expert", question: "Again" })).is_error).toBe(true);
  });

  it("redacts advisor failures and rejects invalid runtime call limits", async () => {
    const sent: string[] = [];
    const state = createDagToolsState({
      node_id: "executor",
      agent_type: "deterministic",
      model: "executor-model",
      outgoing_edges: [{ from_port: "done", to_node: "", to_port: "" }],
      incoming_edges: [],
      graph_nodes: ["executor"],
      advisors: [{
        id: "expert",
        agent_id: "advisor",
        agent_type: "deterministic",
        model: "advisor-model",
        max_calls: 1,
        timeout_ms: 1000,
        max_tokens: 100,
      }],
    }, "run-advisor-failure", (message) => sent.push(message));
    const failing = createDagTools(state, {
      advisorRunner: async () => { throw new Error("Invalid key sk-secretvalue123"); },
    }).find((candidate) => candidate.name === "consult_advisor")!;
    expect((await failing.handler({ advisor_id: "expert", question: "Which API?" })).is_error).toBe(true);
    expect(sent.map((message) => JSON.parse(message).data.event)).toEqual(["advisor_call_started", "advisor_call_failed"]);
    expect(sent.join("\n")).not.toContain("sk-secretvalue123");

    state.advisors[0]!.max_calls = Number.NaN;
    state.advisorCalls.clear();
    expect((await failing.handler({ advisor_id: "expert", question: "Again" })).is_error).toBe(true);
    expect(sent).toHaveLength(2);
  });

  it("restores advisor call limits across corrected prompt attempts", async () => {
    const state = createDagToolsState({
      node_id: "executor",
      agent_type: "deterministic",
      model: "executor-model",
      outgoing_edges: [{ from_port: "done", to_node: "", to_port: "" }],
      incoming_edges: [],
      graph_nodes: ["executor"],
      advisors: [{
        id: "expert",
        agent_id: "advisor",
        agent_type: "deterministic",
        model: "advisor-model",
        max_calls: 1,
        calls_used: 1,
        timeout_ms: 1000,
        max_tokens: 100,
      }],
    }, "run-advisor-restored", () => {});
    let runnerCalls = 0;
    const tool = createDagTools(state, {
      advisorRunner: async () => {
        runnerCalls += 1;
        return { text: "must not run", usage: {} };
      },
    }).find((candidate) => candidate.name === "consult_advisor")!;

    const result = await tool.handler({ advisor_id: "expert", question: "Again" });
    expect(result.is_error).toBe(true);
    expect(result.content[0].text).toContain("call limit (1) exceeded");
    expect(runnerCalls).toBe(0);
  });

  it("detects protected and out-of-scope workspace mutations", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "homerail-workspace-policy-"));
    try {
      fs.mkdirSync(path.join(root, "tests"));
      fs.mkdirSync(path.join(root, "src"));
      fs.writeFileSync(path.join(root, "tests", "guard.test.ts"), "original");
      fs.writeFileSync(path.join(root, "src", "code.ts"), "before");
      const policy = { writable_paths: ["src"], readonly_paths: ["tests"] };
      const before = snapshotWorkspace(root, policy);
      fs.writeFileSync(path.join(root, "tests", "guard.test.ts"), "weakened");
      fs.writeFileSync(path.join(root, "README.md"), "outside");
      const result = verifyWorkspacePolicy(before, snapshotWorkspace(root, policy), policy);
      expect(result.valid).toBe(false);
      expect(result.protected_changes).toEqual(["tests/guard.test.ts"]);
      expect(result.unauthorized_changes).toEqual(["README.md", "tests/guard.test.ts"]);
      expect(result.before_hash).not.toBe(result.after_hash);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("ignores runtime-owned audit traces in workspace policy snapshots", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "homerail-workspace-runtime-audit-"));
    try {
      fs.mkdirSync(path.join(root, "src"));
      fs.writeFileSync(path.join(root, "src", "code.ts"), "unchanged");
      const policy = { writable_paths: ["src"], readonly_paths: [] };
      const before = snapshotWorkspace(root, policy);
      fs.mkdirSync(path.join(root, ".homerail-runtime", "audit"), { recursive: true });
      fs.writeFileSync(
        path.join(root, ".homerail-runtime", "audit", "claude-sdk.jsonl"),
        '{"record_type":"sdk_message"}\n',
      );

      const result = verifyWorkspacePolicy(before, snapshotWorkspace(root, policy), policy);
      expect(result.valid).toBe(true);
      expect(result.changed_paths).toEqual([]);
      expect(result.before_hash).toBe(result.after_hash);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects policy roots that enter reserved metadata directories", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "homerail-workspace-reserved-"));
    try {
      fs.mkdirSync(path.join(root, "repo", ".git"), { recursive: true });
      fs.writeFileSync(path.join(root, "repo", ".git", "config"), "unsafe");
      expect(() => snapshotWorkspace(root, { writable_paths: ["repo/.git"] }))
        .toThrow(/reserved segment \.git/);
      expect(() => snapshotWorkspace(root, { writable_paths: ["repo/node_modules/pkg"] }))
        .toThrow(/reserved segment node_modules/);
      expect(() => snapshotWorkspace(root, { writable_paths: ["repo/.homerail-runtime"] }))
        .toThrow(/reserved segment \.homerail-runtime/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not hide nested model-created Git metadata from snapshots", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "homerail-workspace-nested-git-"));
    try {
      fs.mkdirSync(path.join(root, "repo"));
      const policy = { writable_paths: ["repo"], readonly_paths: [] };
      const before = snapshotWorkspace(root, policy);
      fs.mkdirSync(path.join(root, "repo", "nested", ".git"), { recursive: true });
      fs.writeFileSync(path.join(root, "repo", "nested", ".git", "config"), "created");
      const result = verifyWorkspacePolicy(before, snapshotWorkspace(root, policy), policy);
      expect(result.changed_paths).toEqual(["repo/nested/.git/config"]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("ignores only the declared repository root Git metadata", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "homerail-workspace-root-git-"));
    try {
      fs.mkdirSync(path.join(root, "repo", ".git"), { recursive: true });
      fs.writeFileSync(path.join(root, "repo", ".git", "config"), "manager-owned");
      fs.writeFileSync(path.join(root, "repo", "code.ts"), "tracked");
      const snapshot = snapshotWorkspace(root, {
        writable_paths: ["repo"],
        readonly_paths: [],
        git_metadata_read_only: true,
      });
      expect(snapshot.files).toEqual({
        "repo/code.ts": expect.any(String),
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("ignores Git metadata directly beneath a declared writable checkout", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "homerail-workspace-writable-git-"));
    try {
      fs.mkdirSync(path.join(root, "repo", ".git"), { recursive: true });
      fs.writeFileSync(path.join(root, "repo", ".git", "config"), "before");
      const policy = { writable_paths: ["repo"], readonly_paths: [] };
      const before = snapshotWorkspace(root, policy);
      fs.writeFileSync(path.join(root, "repo", ".git", "config"), "after");
      expect(verifyWorkspacePolicy(before, snapshotWorkspace(root, policy), policy).changed_paths)
        .toEqual([]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("ignores Manager-declared concurrent paths without hiding other unauthorized mutations", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "homerail-workspace-concurrent-"));
    try {
      fs.mkdirSync(path.join(root, "workers", "own"), { recursive: true });
      fs.mkdirSync(path.join(root, "workers", "sibling"), { recursive: true });
      fs.writeFileSync(path.join(root, "workers", "own", "code.ts"), "before");
      fs.writeFileSync(path.join(root, "workers", "sibling", "code.ts"), "before");
      const policy = {
        writable_paths: ["workers/own"],
        readonly_paths: ["input"],
        snapshot_exclude_paths: ["workers/sibling"],
      };
      const before = snapshotWorkspace(root, policy);
      fs.writeFileSync(path.join(root, "workers", "own", "code.ts"), "own change");
      fs.writeFileSync(path.join(root, "workers", "sibling", "code.ts"), "concurrent sibling change");
      fs.writeFileSync(path.join(root, "README.md"), "unauthorized");

      const result = verifyWorkspacePolicy(before, snapshotWorkspace(root, policy), policy);
      expect(result.valid).toBe(false);
      expect(result.changed_paths).toEqual(["README.md", "workers/own/code.ts"]);
      expect(result.unauthorized_changes).toEqual(["README.md"]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("excludes only the exact Manager review projection and still detects sibling evidence writes", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "homerail-review-projection-"));
    try {
      const projection = "review-evidence/qwen/qwen_review/session/round-0001/generation-1.json";
      fs.mkdirSync(path.join(root, "review-evidence", "qwen", "qwen_review", "session", "round-0001"), {
        recursive: true,
      });
      const policy = {
        writable_paths: [],
        readonly_paths: ["review-evidence"],
        snapshot_exclude_paths: [projection],
      };
      const before = snapshotWorkspace(root, policy);

      fs.writeFileSync(path.join(root, projection), "manager projection");
      fs.writeFileSync(path.join(root, "review-evidence", "unexpected.json"), "worker mutation");

      const result = verifyWorkspacePolicy(before, snapshotWorkspace(root, policy), policy);
      expect(result.valid).toBe(false);
      expect(result.changed_paths).toEqual(["review-evidence/unexpected.json"]);
      expect(result.protected_changes).toEqual(["review-evidence/unexpected.json"]);
      expect(result.unauthorized_changes).toEqual(["review-evidence/unexpected.json"]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("ignores shared Manager Git writes during parallel fanout without hiding nested Git metadata", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "homerail-workspace-parallel-git-"));
    try {
      fs.mkdirSync(path.join(root, "repo", ".git", "objects"), { recursive: true });
      fs.mkdirSync(path.join(root, "workers", "own"), { recursive: true });
      fs.mkdirSync(path.join(root, "workers", "sibling"), { recursive: true });
      fs.writeFileSync(path.join(root, "repo", "README.md"), "tracked\n");
      fs.writeFileSync(path.join(root, "repo", ".git", "objects", "before"), "manager-owned\n");
      fs.writeFileSync(path.join(root, "workers", "own", "code.ts"), "before\n");
      fs.writeFileSync(path.join(root, "workers", "sibling", "code.ts"), "before\n");
      const policy = {
        writable_paths: ["workers/own"],
        readonly_paths: ["input", "repo"],
        snapshot_exclude_paths: ["workers/sibling"],
      };
      const before = snapshotWorkspace(root, policy);

      fs.writeFileSync(path.join(root, "workers", "own", "code.ts"), "implemented\n");
      fs.writeFileSync(path.join(root, "workers", "sibling", "code.ts"), "concurrent sibling\n");
      fs.writeFileSync(path.join(root, "repo", ".git", "objects", "after"), "manager commit\n");
      let result = verifyWorkspacePolicy(before, snapshotWorkspace(root, policy), policy);
      expect(result.valid).toBe(true);
      expect(result.changed_paths).toEqual(["workers/own/code.ts"]);

      fs.mkdirSync(path.join(root, "workers", "own", "nested", ".git"), { recursive: true });
      fs.writeFileSync(path.join(root, "workers", "own", "nested", ".git", "config"), "created\n");
      result = verifyWorkspacePolicy(before, snapshotWorkspace(root, policy), policy);
      expect(result.changed_paths).toEqual([
        "workers/own/code.ts",
        "workers/own/nested/.git/config",
      ]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects workspace symlinks that escape the policy root", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "homerail-workspace-symlink-"));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "homerail-workspace-outside-"));
    try {
      fs.writeFileSync(path.join(outside, "secret.txt"), "secret");
      fs.symlinkSync(path.join(outside, "secret.txt"), path.join(root, "linked.txt"));
      expect(() => snapshotWorkspace(root, { writable_paths: ["src"] }))
        .toThrow("workspace symlink escapes root");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it("withholds handoff when an agent mutates a readonly artifact", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "homerail-policy-run-"));
    process.env.WORKSPACE = root;
    fs.mkdirSync(path.join(root, "tests"));
    fs.mkdirSync(path.join(root, "src"));
    fs.writeFileSync(path.join(root, "tests", "guard.txt"), "original");
    const mutator: AgentClient = {
      async *run(_prompt, tools) {
        fs.writeFileSync(path.join(root, "tests", "guard.txt"), "changed");
        const handoff = tools.find((tool) => tool.name === "handoff")!;
        await handoff.handler({ port: "done", content: { status: "success" } });
        yield { type: "done" };
      },
    };
    registerAgentBackend("policy-mutator", () => mutator);
    const sent: Array<Record<string, unknown>> = [];
    try {
      await runPrompt({
        task: "mutate",
        sender: "test",
        runId: "policy-run",
        dagConfig: {
          node_id: "builder",
          agent_type: "policy-mutator",
          model: "test",
          outgoing_edges: [{ from_port: "done", to_node: "", to_port: "" }],
          incoming_edges: [],
          graph_nodes: ["builder"],
          workspace_access: { writable_paths: ["src"], readonly_paths: ["tests"] },
        },
        llmBaseUrl: "http://unused",
      }, {
        wsSend: (message) => sent.push(JSON.parse(message) as Record<string, unknown>),
        agentBackend: "policy-mutator",
      });
      expect(sent.some((message) => message.type === "response")).toBe(false);
      expect(sent.some((message) => message.type === "node_error" && JSON.stringify(message).includes("DAG_WORKSPACE_POLICY_VIOLATION"))).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("preserves an exact large and deep handoff after workspace verification", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "homerail-policy-exact-handoff-"));
    process.env.WORKSPACE = root;
    fs.mkdirSync(path.join(root, "src"));
    const exact = {
      long: "x".repeat(5000),
      many: Array.from({ length: 120 }, (_, index) => ({ index })),
      deep: { a: { b: { c: { d: { e: { f: { g: { h: { i: "kept" } } } } } } } } },
    };
    const agent: AgentClient = {
      async *run(_prompt, tools) {
        const handoff = tools.find((tool) => tool.name === "handoff")!;
        await handoff.handler({ port: "done", content: exact });
        yield { type: "done" };
      },
    };
    registerAgentBackend("policy-exact-handoff", () => agent);
    const sent: Array<Record<string, unknown>> = [];
    try {
      await runPrompt({
        task: "preserve",
        sender: "test",
        runId: "policy-exact-run",
        dagConfig: {
          node_id: "builder",
          agent_type: "policy-exact-handoff",
          model: "test",
          outgoing_edges: [{ from_port: "done", to_node: "", to_port: "" }],
          incoming_edges: [],
          graph_nodes: ["builder"],
          workspace_access: { writable_paths: ["src"] },
        },
        llmBaseUrl: "http://unused",
      }, {
        wsSend: (message) => sent.push(JSON.parse(message) as Record<string, unknown>),
        agentBackend: "policy-exact-handoff",
      });
      const response = sent.find((message) => message.type === "response") as { data?: { content?: unknown } } | undefined;
      expect(response?.data?.content).toEqual(exact);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
