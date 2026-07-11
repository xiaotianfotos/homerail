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
