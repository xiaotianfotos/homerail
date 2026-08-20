/**
 * Tests for prompt runner: full prompt → tool → result flow.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { runPrompt } from "../prompt-runner.js";
import type { PromptJob } from "../prompt-runner.js";
import {
  HOMERAIL_A2UI_CATALOG_ID,
  HOMERAIL_A2UI_VERSION,
  type DagNodeConfig,
} from "homerail-protocol";
import { registerAgentBackend } from "../agent/factory.js";
import type { AgentClient, AgentEvent, AgentRunContext } from "../agent/types.js";

function makeConfig(): DagNodeConfig {
  return {
    node_id: "coder",
    agent_type: "claude-sdk",
    model: "test",
    outgoing_edges: [
      { from_port: "done", to_node: "tester", to_port: "in" },
    ],
    incoming_edges: [],
    graph_nodes: ["coder", "tester"],
  };
}

function makeConfigWith(overrides: Partial<DagNodeConfig>): DagNodeConfig {
  return { ...makeConfig(), ...overrides };
}

describe("prompt runner", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    process.env.LLM_BASE_URL = "https://llm.example.test/v1";
  });

  it("sends content and SESSION_END", async () => {
    // Register a mock agent
    const events: AgentEvent[] = [
      { type: "text", text: "hello" },
      { type: "done" },
    ];

    const mockAgent: AgentClient = {
      run() {
        return (async function* () {
          for (const e of events) yield e;
        })();
      },
    };
    registerAgentBackend("test-runner", () => mockAgent);

    const sent: string[] = [];
    const job: PromptJob = {
      task: "do something",
      sender: "test",
      runId: "run-1",
      dagConfig: makeConfig(),
    };

    await runPrompt(job, {
      wsSend: (d) => sent.push(d),
      agentBackend: "test-runner",
    });

    // Should have sent content + SESSION_END
    const types = sent.map((s) => JSON.parse(s).type);
    expect(types).toContain("content");
    expect(types).toContain("node_error");
    expect(types).toContain("SESSION_END");
    const activities = sent
      .map((message) => JSON.parse(message))
      .filter((message) => message.type === "stream" && message.data?.event === "dag_activity")
      .map((message) => message.data.activity);
    expect(activities.map((activity) => activity.type)).toEqual(["started", "failed"]);
    expect(activities.map((activity) => activity.sequence)).toEqual([1, 2]);
  });

  it("renews activity for reasoning without streaming or persisting its content", async () => {
    const mockAgent: AgentClient = {
      run() {
        return (async function* () {
          yield { type: "thinking" as const, text: "private chain of thought" };
          yield { type: "thinking" as const, text: "more private reasoning" };
          yield { type: "done" as const };
        })();
      },
    };
    registerAgentBackend("test-reasoning-heartbeat", () => mockAgent);

    const sent: string[] = [];
    await runPrompt(
      {
        task: "reason for a long time",
        sender: "test",
        runId: "run-reasoning-heartbeat",
        dagConfig: makeConfig(),
      },
      {
        wsSend: (data) => sent.push(data),
        agentBackend: "test-reasoning-heartbeat",
      },
    );

    const serialized = sent.join("\n");
    expect(serialized).not.toContain("private chain of thought");
    expect(serialized).not.toContain("more private reasoning");
    const activities = sent
      .map((message) => JSON.parse(message))
      .filter((message) => message.type === "stream" && message.data?.event === "dag_activity")
      .map((message) => message.data.activity);
    expect(activities.map((activity) => activity.type)).toEqual(["started", "progress", "failed"]);
    expect(activities[1]?.payload).toEqual({ message: "model reasoning" });
  });

  it("sends node_error with agent error when a prompt ends without handoff", async () => {
    const mockAgent: AgentClient = {
      run() {
        return (async function* () {
          yield { type: "error" as const, message: "Claude SDK result failed: error_max_turns" };
          yield { type: "done" as const };
        })();
      },
    };
    registerAgentBackend("test-node-error", () => mockAgent);

    const sent: string[] = [];
    await runPrompt(
      {
        task: "test",
        sender: "test",
        runId: "run-node-error",
        dagConfig: makeConfig(),
      },
      {
        wsSend: (d) => sent.push(d),
        agentBackend: "test-node-error",
      },
    );

    const parsed = sent.map((s) => JSON.parse(s));
    expect(parsed).toContainEqual(expect.objectContaining({
      type: "node_error",
      data: expect.objectContaining({
        runId: "run-node-error",
        nodeId: "coder",
        message: "Claude SDK result failed: error_max_turns",
        session_id: "run-node-error",
        attempt_diagnostics: expect.objectContaining({
          schema: "attempt-diagnostic-v1",
          finish_reason: null,
          tool_argument_parse_state: "unknown",
          contract_stage: "unknown",
          failure_category: "unknown",
        }),
      }),
    }));
    expect(parsed.map((msg) => msg.type)).toContain("SESSION_END");
  });

  it("streams cumulative usage snapshots with the authoritative node-turn scope", async () => {
    const mockAgent: AgentClient = {
      run() {
        return (async function* () {
          yield {
            type: "usage" as const,
            usage: {
              input_tokens: 10,
              output_tokens: 2,
              cache_read_input_tokens: 3,
              cache_creation_input_tokens: 1,
            },
          };
          yield {
            type: "usage" as const,
            usage: {
              input_tokens: 20,
              output_tokens: 4,
              cache_read_input_tokens: 5,
              cache_creation_input_tokens: 2,
            },
          };
          yield {
            type: "done" as const,
            usage: {
              input_tokens: 20,
              output_tokens: 4,
              cache_read_input_tokens: 5,
              cache_creation_input_tokens: 2,
            },
            duration_ms: 1500,
            num_turns: 2,
          };
        })();
      },
    };
    registerAgentBackend("test-live-usage", () => mockAgent);

    const sent: string[] = [];
    await runPrompt(
      {
        task: "measure usage",
        sender: "test",
        runId: "run-live-usage",
        dagConfig: makeConfigWith({
          session_id: "session-live-usage",
          round_id: "round-0002",
          actor_id: "researcher",
          generation: 3,
          command_id: "command-2",
        }),
      },
      {
        wsSend: (message) => sent.push(message),
        agentBackend: "test-live-usage",
      },
    );

    const usageEvents = sent
      .map((message) => JSON.parse(message))
      .filter((message) => message.type === "stream" && message.data?.event === "usage");
    expect(usageEvents).toHaveLength(3);
    expect(usageEvents.map((message) => message.data.usage.input_tokens)).toEqual([10, 20, 20]);
    expect(new Set(usageEvents.map((message) => message.data.execution_id)).size).toBe(1);
    expect(usageEvents[0]?.data.execution_id).toEqual(expect.any(String));
    expect(usageEvents.at(-1)?.data).toMatchObject({
      session_id: "session-live-usage",
      round_id: "round-0002",
      generation: 3,
      command_id: "command-2",
      duration_ms: 1500,
      num_turns: 2,
    });
  });

  it("propagates finish reason and output token limit into usage and handoff diagnostics", async () => {
    const mockAgent: AgentClient = {
      run(_prompt, tools) {
        return (async function* () {
          const handoffTool = tools.find((tool) => tool.name === "handoff")!;
          await handoffTool.handler({ port: "done", content: "complete" });
          yield {
            type: "usage" as const,
            usage: { output_tokens: 640 },
            finish_reason: "max_tokens",
            output_token_limit: 1024,
          };
          yield {
            type: "done" as const,
            usage: { output_tokens: 640 },
            finish_reason: "max_tokens",
            output_token_limit: 1024,
          };
        })();
      },
    };
    registerAgentBackend("test-terminal-metadata", () => mockAgent);

    const terminalMessages: string[] = [];
    const streamed: string[] = [];
    await runPrompt(
      {
        task: "finish metadata",
        sender: "test",
        runId: "run-terminal-metadata",
        dagConfig: makeConfigWith({ session_id: "session-terminal" }),
      },
      {
        wsSend: (data) => streamed.push(data),
        onTerminalMessage: (data) => terminalMessages.push(data),
        agentBackend: "test-terminal-metadata",
      },
    );

    const usageEvents = streamed
      .map((message) => JSON.parse(message))
      .filter((message) => message.type === "stream" && message.data?.event === "usage");
    expect(usageEvents.at(-1)?.data).toMatchObject({
      usage: { output_tokens: 640 },
      finish_reason: "max_tokens",
      output_token_limit: 1024,
    });
    expect(terminalMessages.map((message) => JSON.parse(message))).toContainEqual(expect.objectContaining({
      type: "response",
      data: expect.objectContaining({
        attempt_diagnostics: expect.objectContaining({
          schema: "attempt-diagnostic-v1",
          finish_reason: "max_tokens",
          output_tokens: 640,
          output_token_limit: 1024,
          failure_category: "accepted",
        }),
      }),
    }));
  });

  it("restricts correction turns to the handoff tool and correction system prompt", async () => {
    let observedTools: string[] = [];
    let observedContext: AgentRunContext | undefined;
    const mockAgent: AgentClient = {
      run(_prompt, tools, context) {
        observedTools = tools.map((tool) => tool.name);
        observedContext = context;
        return (async function* () {
          await tools[0].handler({ port: "done", content: "corrected" });
          yield { type: "done" as const };
        })();
      },
    };
    registerAgentBackend("test-correction-only", () => mockAgent);

    const terminalMessages: string[] = [];
    await runPrompt(
      {
        task: "## input:context\n{}\n\n## input:correction\nUse the exact contract",
        sender: "test",
        runId: "run-correction-only",
        dagConfig: makeConfig(),
        systemPrompt: "Original reviewer instructions",
      },
      {
        wsSend: () => {},
        onTerminalMessage: (data) => terminalMessages.push(data),
        agentBackend: "test-correction-only",
      },
    );

    expect(observedTools).toEqual(["handoff"]);
    expect(observedContext?.handoffOnly).toBe(true);
    expect(observedContext?.systemPromptMode).toBe("replace");
    expect(observedContext?.systemPrompt).toContain("DAG CONTRACT CORRECTION MODE");
    expect(observedContext?.systemPrompt).toContain("The active DAG run_id is run-correction-only");
    expect(observedContext?.systemPrompt).toContain("Original reviewer instructions");
    expect(terminalMessages.map((message) => JSON.parse(message))).toContainEqual(expect.objectContaining({
      type: "response",
      data: expect.objectContaining({
        port: "done",
        content: "corrected",
        attempt_diagnostics: expect.objectContaining({
          schema: "attempt-diagnostic-v1",
          attempt: 1,
          finish_reason: null,
          tool_argument_parse_state: "valid",
          contract_stage: "tool_arguments",
          failure_category: "accepted",
        }),
      }),
    }));
  });

  it("allows only declared broker verification plus handoff during correction", async () => {
    let observedTools: string[] = [];
    let observedContext: AgentRunContext | undefined;
    const mockAgent: AgentClient = {
      run(_prompt, tools, context) {
        observedTools = tools.map((tool) => tool.name);
        observedContext = context;
        return (async function* () {
          await tools.find((tool) => tool.name === "handoff")!.handler({ port: "done", content: "corrected" });
          yield { type: "done" as const };
        })();
      },
    };
    registerAgentBackend("test-correction-broker", () => mockAgent);

    await runPrompt(
      {
        task: "## input:context\n{}\n\n## input:correction\nVerify checks, then use the exact contract",
        sender: "test",
        runId: "run-correction-broker",
        dagConfig: makeConfigWith({
          session_id: "review-session",
          allowed_dag_tools: ["handoff", "credential_broker_call"],
        }),
        credentialBrokerBindings: [{
          credential_ref: "github-autofix",
          purpose: "verify required checks",
          mode: "manager_broker",
          broker: "github_pr",
          allowed_actions: ["required_checks"],
        }],
      },
      {
        wsSend: () => {},
        agentBackend: "test-correction-broker",
        credentialBrokerCall: async (request) => ({ request_id: request.request_id, ok: true, result: {} }),
      },
    );

    expect(observedTools).toEqual(["handoff", "credential_broker_call"]);
    expect(observedContext?.handoffOnly).toBe(true);
    expect(observedContext?.systemPrompt).toContain(
      "declared credential broker verification calls followed by exactly one handoff",
    );
  });

  it("permits only evidence-file repair before the corrected handoff", async () => {
    let observedTools: string[] = [];
    let observedContext: AgentRunContext | undefined;
    const sent: string[] = [];
    const mockAgent: AgentClient = {
      run(_prompt, tools, context) {
        observedTools = tools.map((tool) => tool.name);
        observedContext = context;
        return (async function* () {
          await tools.find((tool) => tool.name === "handoff")!.handler({ port: "done", content: "corrected" });
          yield { type: "done" as const };
        })();
      },
    };
    registerAgentBackend("test-correction-evidence", () => mockAgent);

    await runPrompt(
      {
        task: "## input:context\n{}\n\n## input:correction\nDAG_HANDOFF_WORKSPACE_FILE_REQUIREMENT aggregate.candidate: invalid TestReport",
        sender: "test",
        runId: "run-correction-evidence",
        dagConfig: makeConfigWith({
          allowed_dag_tools: ["handoff", "credential_broker_call"],
          workspace_access: { writable_paths: ["repo"], readonly_paths: ["input"] },
        }),
      },
      {
        wsSend: (message) => sent.push(message),
        agentBackend: "test-correction-evidence",
      },
    );

    expect(observedTools).toEqual(["handoff"]);
    expect(observedContext?.handoffOnly).toBe(false);
    expect(observedContext?.workspaceAccess).toEqual({ writable_paths: ["repo"], readonly_paths: ["input"] });
    expect(observedContext?.systemPrompt).toContain(
      "inspect and rewrite only the declared .homerail workspace evidence JSON",
    );
    expect(observedContext?.systemPrompt).toContain("Do not modify source files, rerun tests, or repeat external side effects");
    const policySnapshot = sent.map((message) => JSON.parse(message)).find((message) => (
      message.type === "stream" && message.data?.event === "workspace_policy_snapshot"
    ));
    expect(policySnapshot?.data?.writable_paths).toEqual(["repo/.homerail"]);
  });

  it("keeps the Claude Code preset for ordinary DAG work", async () => {
    let observedContext: AgentRunContext | undefined;
    const mockAgent: AgentClient = {
      run(_prompt, tools, context) {
        observedContext = context;
        return (async function* () {
          await tools.find((tool) => tool.name === "handoff")!.handler({ port: "done", content: "complete" });
          yield { type: "done" as const };
        })();
      },
    };
    registerAgentBackend("test-ordinary-system-prompt", () => mockAgent);

    await runPrompt(
      {
        task: "ordinary work",
        sender: "test",
        runId: "run-ordinary-system-prompt",
        dagConfig: makeConfig(),
        systemPrompt: "Node instructions",
      },
      {
        wsSend: () => {},
        agentBackend: "test-ordinary-system-prompt",
      },
    );

    expect(observedContext?.systemPromptMode).toBe("append");
    expect(observedContext?.systemPrompt).toBe("Node instructions");
  });

  it("filters HomeRail DAG tools through the node allowlist", async () => {
    let observedTools: string[] = [];
    const mockAgent: AgentClient = {
      run(_prompt, tools) {
        observedTools = tools.map((tool) => tool.name);
        return (async function* () {
          await tools[0].handler({ port: "done", content: "restricted" });
          yield { type: "done" as const };
        })();
      },
    };
    registerAgentBackend("test-dag-tool-policy", () => mockAgent);

    await runPrompt(
      {
        task: "handoff only",
        sender: "test",
        runId: "run-dag-tool-policy",
        dagConfig: makeConfigWith({ allowed_dag_tools: ["handoff"] }),
      },
      {
        wsSend: () => {},
        agentBackend: "test-dag-tool-policy",
      },
    );

    expect(observedTools).toEqual(["handoff"]);
  });

  it("does not expose rich surface reporting when allowed_dag_tools is omitted", async () => {
    let observedTools: string[] = [];
    let observedContext: AgentRunContext | undefined;
    const mockAgent: AgentClient = {
      run(_prompt, tools, context) {
        observedTools = tools.map((tool) => tool.name);
        observedContext = context;
        return (async function* () {
          await tools.find((tool) => tool.name === "handoff")!.handler({ port: "done", content: "complete" });
          yield { type: "done" as const };
        })();
      },
    };
    registerAgentBackend("test-surface-tool-default-deny", () => mockAgent);

    await runPrompt(
      {
        task: "ordinary work",
        sender: "test",
        runId: "run-surface-default-deny",
        dagConfig: makeConfigWith({
          round_id: "round-1",
          actor_id: "actor-coder",
          generation: 1,
          lease_generation: 1,
          surface_id: "surface:actor-coder",
        }),
        systemPrompt: "Node instructions",
      },
      {
        wsSend: () => {},
        agentBackend: "test-surface-tool-default-deny",
      },
    );

    expect(observedTools).not.toContain("report_surface_state");
    expect(observedContext?.systemPrompt).toBe("Node instructions");
  });

  it("exposes and prompts rich surface reporting only when explicitly allowed", async () => {
    let observedTools: string[] = [];
    let observedContext: AgentRunContext | undefined;
    let reportResult: Record<string, unknown> | undefined;
    const mockAgent: AgentClient = {
      run(_prompt, tools, context) {
        observedTools = tools.map((tool) => tool.name);
        observedContext = context;
        return (async function* () {
          const result = await tools.find((tool) => tool.name === "report_surface_state")!.handler({
            patch_id: "patch-prompt-1",
            patch_sequence: 1,
            phase: "partial",
            op: "replace_body",
            body: {
              a2ui: {
                version: HOMERAIL_A2UI_VERSION,
                catalogId: HOMERAIL_A2UI_CATALOG_ID,
                components: [
                  { id: "root", component: "Column", children: ["preview", "checks"] },
                  { id: "preview", component: "Image", url: { path: "/actor_view/data/image_url" } },
                  { id: "checks", component: "HrMetric", label: "Checks", value: { path: "/actor_view/data/checks" } },
                ],
              },
              data: { checks: 3, image_url: "https://cdn.example/progress.webp" },
              fallback: { title: "Checks", summary: "Three checks complete" },
            },
          });
          reportResult = JSON.parse(result.content[0]!.text) as Record<string, unknown>;
          await tools.find((tool) => tool.name === "handoff")!.handler({ port: "done", content: "complete" });
          yield { type: "done" as const };
        })();
      },
    };
    registerAgentBackend("test-surface-tool-explicit-allow", () => mockAgent);
    const sent: string[] = [];
    const richConfig = makeConfigWith({
      round_id: "round-rich",
      actor_id: "actor-coder",
      generation: 2,
      lease_generation: 3,
      surface_id: "surface:actor-coder",
      allowed_dag_tools: ["handoff", "report_surface_state"],
    } as unknown as Partial<DagNodeConfig>);

    await runPrompt(
      {
        task: "report progress",
        sender: "test",
        runId: "run-surface-allowed",
        dagConfig: richConfig,
        systemPrompt: "Node instructions",
      },
      {
        wsSend: (data) => sent.push(data),
        agentBackend: "test-surface-tool-explicit-allow",
        surfaceMediaDownloader: async () => ({
          bytes: Buffer.alloc(5_000, 7),
          media_type: "image/webp",
        }),
      },
    );

    expect(observedTools).toEqual(["handoff", "report_surface_state"]);
    expect(observedContext?.systemPrompt).toContain("Node instructions");
    expect(observedContext?.systemPrompt).toContain("RICH SURFACE REPORTING CAPABILITY");
    expect(observedContext?.systemPrompt).toContain("never mutates the Canvas directly");
    expect(reportResult).toMatchObject({
      status: "submitted",
      surface_id: "surface:actor-coder",
      manager_validation: "pending",
      canvas_mutated: false,
    });
    const proposal = sent
      .map((message) => JSON.parse(message))
      .find((message) => message.type === "stream" && message.data?.event === "dag_actor_surface_patch");
    expect(proposal?.data).toMatchObject({
      event: "dag_actor_surface_patch",
      surface_id: "surface:actor-coder",
      patch: {
        run_id: "run-surface-allowed",
        node_id: "coder",
        session_id: "run-surface-allowed",
        round_id: "round-rich",
        actor_id: "actor-coder",
        generation: 2,
        lease_generation: 3,
        patch_id: "patch-prompt-1",
        patch_sequence: 1,
      },
    });
    const media = sent
      .map((message) => JSON.parse(message))
      .find((message) => message.type === "stream" && message.data?.event === "dag_actor_surface_media");
    expect(media?.data.media).toMatchObject({
      run_id: "run-surface-allowed",
      actor_id: "actor-coder",
      media_type: "image/webp",
      size_bytes: 5_000,
    });
    expect(media?.data.media.content_base64).toHaveLength(Math.ceil(5_000 / 3) * 4);
    expect(sent.findIndex((message) => JSON.parse(message).data?.event === "dag_actor_surface_media"))
      .toBeLessThan(sent.findIndex((message) => JSON.parse(message).data?.event === "dag_actor_surface_patch"));
  });

  it("uses structured dispatch inputs to materialize trusted pinned Surface data", async () => {
    let reportResult: Record<string, unknown> | undefined;
    const mockAgent: AgentClient = {
      run(_prompt, tools) {
        return (async function* () {
          const result = await tools.find((tool) => tool.name === "report_surface_state")!.handler({
            phase: "final",
            view_id: "trusted-summary",
            data: { title: "wrong model copy", items: 1, phase_text: "Done" },
            fallback: "Trusted title",
          });
          reportResult = JSON.parse(result.content[0]!.text) as Record<string, unknown>;
          await tools.find((tool) => tool.name === "handoff")!.handler({ port: "done", content: "complete" });
          yield { type: "done" as const };
        })();
      },
    };
    registerAgentBackend("test-trusted-surface-input", () => mockAgent);
    const sent: string[] = [];
    const dagConfig = makeConfigWith({
      round_id: "round-trusted",
      actor_id: "actor-coder",
      generation: 1,
      lease_generation: 1,
      surface_id: "surface:actor-coder",
      allowed_dag_tools: ["handoff", "report_surface_state"],
    } as unknown as Partial<DagNodeConfig>);

    await runPrompt({
      task: "## input:mission\nEVIDENCE: model-visible copy",
      sender: "test",
      runId: "run-trusted-surface",
      dagConfig,
      pinnedSurfaceViews: new Map([["trusted-summary", {
        version: HOMERAIL_A2UI_VERSION,
        catalogId: HOMERAIL_A2UI_CATALOG_ID,
        components: [
          { id: "root", component: "Column", children: ["title", "items", "phase"] },
          { id: "title", component: "Text", text: { path: "/actor_view/data/title" } },
          { id: "items", component: "List", children: { path: "/actor_view/data/items", componentId: "item" } },
          { id: "item", component: "Text", text: { path: "label" } },
          { id: "phase", component: "Text", text: { path: "/actor_view/data/phase_text" } },
        ],
      }]]),
      pinnedSurfaceDataContracts: new Map([["trusted-summary", {
        source: { input_port: "mission", encoding: "json", json_prefix: "EVIDENCE: ", pointer: "/result" },
        fields: [
          { field: "title", mode: "source", source_pointer: "/title" },
          { field: "items", mode: "source_prefix", source_pointer: "/items", max_items: 4 },
          { field: "phase_text", mode: "presentation" },
        ],
      }]]),
      trustedInputs: {
        mission: ['EVIDENCE: {"result":{"title":"Trusted title","items":[{"label":"one"},{"label":"two"}]}}'],
      },
    }, {
      wsSend: (data) => sent.push(data),
      agentBackend: "test-trusted-surface-input",
    });

    expect(reportResult).toMatchObject({
      status: "submitted",
      ignored_model_source_fields: ["title"],
      source_prefix_counts: { items: 1 },
    });
    const proposal = sent
      .map((message) => JSON.parse(message))
      .find((message) => message.type === "stream" && message.data?.event === "dag_actor_surface_patch");
    expect(proposal?.data.patch.body.data).toEqual({
      title: "Trusted title",
      items: [{ label: "one" }],
      phase_text: "Done",
    });
  });

  it("fails closed when a backend cannot enforce the built-in tool allowlist", async () => {
    const sent: string[] = [];

    await runPrompt(
      {
        task: "must stay write-only",
        sender: "test",
        runId: "run-unsupported-builtin-policy",
        dagConfig: makeConfigWith({ allowed_builtin_tools: ["Write"] }),
      },
      {
        wsSend: (data) => sent.push(data),
        agentBackend: "kimi_code",
      },
    );

    expect(sent.map((message) => JSON.parse(message))).toContainEqual(expect.objectContaining({
      type: "node_error",
      data: expect.objectContaining({
        message: "allowed_builtin_tools is not enforced by agent backend 'kimi_code'",
      }),
    }));
  });

  it("limits DeepSeek Harness built-ins to HomeRail-managed read-only tools", async () => {
    for (const dagConfig of [
      makeConfigWith({
        agent_type: "deepseek_harness",
        allowed_builtin_tools: ["Write"],
        workspace_access: { writable_paths: ["repository"], readonly_paths: [] },
      }),
      makeConfigWith({
        agent_type: "deepseek_harness",
        allowed_builtin_tools: ["Read"],
      }),
    ]) {
      const sent: string[] = [];
      await runPrompt({
        task: "reject unsupported DSH filesystem policy",
        sender: "test",
        runId: "run-dsh-builtin-policy",
        llmProtocol: "openai_compatible",
        dagConfig,
      }, {
        wsSend: (data) => sent.push(data),
        agentBackend: "deepseek_harness",
      });
      expect(sent.map((message) => JSON.parse(message))).toContainEqual(expect.objectContaining({
        type: "node_error",
        data: expect.objectContaining({
          message: expect.stringMatching(/read-only built-in tools|require workspace_access/),
        }),
      }));
    }
  });

  it("allows explicit backend-native tools only for sandboxed Codex DAG turns", async () => {
    let called = false;
    const mockAgent: AgentClient = {
      run(_prompt, _tools, context) {
        called = true;
        expect(context.workspaceAccess).toEqual({ writable_paths: ["repo"], readonly_paths: ["input"] });
        return (async function* () {
          yield { type: "done" as const };
        })();
      },
    };
    registerAgentBackend("codex_appserver", () => mockAgent);

    const sent: string[] = [];
    await runPrompt({
      task: "use the native coding surface",
      sender: "test",
      runId: "run-codex-native-tools",
      llmProtocol: "responses_compatible",
      dagConfig: makeConfigWith({
        agent_type: "codex_appserver",
        builtin_tool_policy: "backend_native",
        workspace_access: { writable_paths: ["repo"], readonly_paths: ["input"] },
      }),
    }, {
      wsSend: (data) => sent.push(data),
      agentBackend: "codex_appserver",
    });

    expect(called).toBe(true);
    expect(sent.map((message) => JSON.parse(message)).filter((message) => message.type === "node_error"))
      .toEqual([expect.objectContaining({ data: expect.objectContaining({ message: "agent ended without DAG handoff" }) })]);

    for (const invalid of [
      makeConfigWith({ builtin_tool_policy: "backend_native" }),
      makeConfigWith({
        builtin_tool_policy: "backend_native",
        allowed_builtin_tools: ["Write"],
        workspace_access: { writable_paths: ["repo"] },
      }),
    ]) {
      const rejected: string[] = [];
      await runPrompt({
        task: "reject",
        sender: "test",
        runId: "run-invalid-native-tools",
        llmProtocol: "anthropic_compatible",
        dagConfig: invalid,
      }, {
        wsSend: (data) => rejected.push(data),
        agentBackend: "claude-sdk",
      });
      expect(rejected.map((message) => JSON.parse(message))).toContainEqual(expect.objectContaining({
        type: "node_error",
        data: expect.objectContaining({ message: expect.stringMatching(/backend_native|mutually exclusive/) }),
      }));
    }
  });

  it("defers node_error delivery to the worker lifecycle when requested", async () => {
    const mockAgent: AgentClient = {
      run() {
        return (async function* () {
          yield { type: "done" as const };
        })();
      },
    };
    registerAgentBackend("test-deferred-node-error", () => mockAgent);

    const sent: string[] = [];
    const terminalMessages: string[] = [];
    await runPrompt(
      {
        task: "test",
        sender: "test",
        runId: "run-deferred-node-error",
        dagConfig: makeConfigWith({ session_id: "session-deferred" }),
      },
      {
        wsSend: (data) => sent.push(data),
        onTerminalMessage: (data) => terminalMessages.push(data),
        agentBackend: "test-deferred-node-error",
      },
    );

    expect(sent.map((message) => JSON.parse(message).type)).toContain("SESSION_END");
    expect(sent.map((message) => JSON.parse(message).type)).not.toContain("node_error");
    expect(terminalMessages.map((message) => JSON.parse(message))).toEqual([expect.objectContaining({
      type: "node_error",
      data: expect.objectContaining({
        runId: "run-deferred-node-error",
        nodeId: "coder",
        message: "agent ended without DAG handoff",
        session_id: "session-deferred",
        attempt_diagnostics: expect.objectContaining({
          schema: "attempt-diagnostic-v1",
          failure_category: "unknown",
        }),
      }),
    })]);
  });

  it("binds node_error to the same round transport fence as handoff", async () => {
    const mockAgent: AgentClient = {
      run() {
        return (async function* () {
          yield { type: "error" as const, message: "round two failed" };
          yield { type: "done" as const };
        })();
      },
    };
    registerAgentBackend("test-fenced-node-error", () => mockAgent);

    const terminalMessages: string[] = [];
    await runPrompt(
      {
        task: "test",
        sender: "test",
        runId: "run-fenced-node-error",
        dagConfig: makeConfigWith({
          session_id: "session-fenced",
          round_id: "round-0002",
          actor_id: "actor-coder",
          generation: 3,
          lease_generation: 8,
          command_id: "command-2",
        }),
      },
      {
        wsSend: () => {},
        onTerminalMessage: (data) => terminalMessages.push(data),
        agentBackend: "test-fenced-node-error",
      },
    );

    expect(terminalMessages.map((message) => JSON.parse(message))).toEqual([expect.objectContaining({
      type: "node_error",
      data: expect.objectContaining({
        runId: "run-fenced-node-error",
        nodeId: "coder",
        message: "round two failed",
        session_id: "session-fenced",
        round_id: "round-0002",
        actor_id: "actor-coder",
        generation: 3,
        lease_generation: 8,
        command_id: "command-2",
        attempt_diagnostics: expect.objectContaining({
          schema: "attempt-diagnostic-v1",
          failure_category: "unknown",
        }),
      }),
    })]);
  });

  it("fails claude-sdk before execution when the protocol is missing", async () => {
    const sent: string[] = [];
    await runPrompt(
      {
        task: "test",
        sender: "test",
        runId: "run-claude-protocol-missing",
        dagConfig: makeConfig(),
      },
      {
        wsSend: (d) => sent.push(d),
        agentBackend: "claude-sdk",
      },
    );

    const parsed = sent.map((s) => JSON.parse(s));
    expect(parsed).toContainEqual(expect.objectContaining({
      type: "node_error",
      data: expect.objectContaining({
        runId: "run-claude-protocol-missing",
        nodeId: "coder",
        message: expect.stringContaining("Anthropic-compatible endpoint"),
      }),
    }));
    expect(parsed.map((msg) => msg.type)).toContain("SESSION_END");
  });

  it("fails DeepSeek Harness before execution for a non-OpenAI protocol", async () => {
    const sent: string[] = [];
    await runPrompt(
      {
        task: "test",
        sender: "test",
        runId: "run-dsh-protocol-invalid",
        llmProtocol: "anthropic_compatible",
        dagConfig: makeConfigWith({ agent_type: "deepseek_harness" }),
      },
      {
        wsSend: (data) => sent.push(data),
        agentBackend: "dsh",
      },
    );

    expect(sent.map((message) => JSON.parse(message))).toContainEqual(expect.objectContaining({
      type: "node_error",
      data: expect.objectContaining({
        message: expect.stringContaining("OpenAI-compatible Chat Completions endpoint"),
      }),
    }));
  });

  it("streams agent debug events without sending them as content", async () => {
    const mockAgent: AgentClient = {
      run() {
        return (async function* () {
          yield {
            type: "debug" as const,
            source: "claude-sdk",
            message: "query_start sk-debugsecret123",
            data: { model: "claude-sonnet-4-20250514", api_key: "debug-secret" },
          };
          yield { type: "done" as const };
        })();
      },
    };
    registerAgentBackend("test-debug", () => mockAgent);
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const sent: string[] = [];
    await runPrompt(
      {
        task: "test",
        sender: "test",
        runId: "run-debug",
        dagConfig: makeConfig(),
      },
      {
        wsSend: (d) => sent.push(d),
        agentBackend: "test-debug",
      },
    );

    const parsed = sent.map((s) => JSON.parse(s));
    expect(parsed.some((msg) => msg.type === "content")).toBe(false);
    expect(parsed).toContainEqual(expect.objectContaining({
      type: "stream",
      data: expect.objectContaining({
        event: "agent_debug",
        source: "claude-sdk",
        message: "query_start ***REDACTED***",
        data: expect.objectContaining({ api_key: "***REDACTED***" }),
      }),
    }));
    expect(sent.join("\n")).not.toContain("sk-debugsecret123");
    expect(sent.join("\n")).not.toContain("debug-secret");
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("HOMERAIL_AGENT_DEBUG"));
    expect(consoleSpy.mock.calls.flat().join("\n")).not.toContain("sk-debugsecret123");
    expect(consoleSpy.mock.calls.flat().join("\n")).not.toContain("debug-secret");
  });

  it("streams redacted tool inputs and result previews", async () => {
    const mockAgent: AgentClient = {
      run() {
        return (async function* () {
          yield {
            type: "tool_use" as const,
            id: "tool-1",
            name: "Bash",
            input: {
              command: "curl -H 'Authorization: Bearer secret-token-123456' https://example.test?token=secret-query-token",
              api_key: "secret-key-value",
            },
          };
          yield {
            type: "tool_result" as const,
            tool_use_id: "tool-1",
            content: "done token=secret-result-token",
          };
          yield { type: "done" as const };
        })();
      },
    };
    registerAgentBackend("test-tool-redaction", () => mockAgent);

    const sent: string[] = [];
    const auditDir = mkdtempSync(join(tmpdir(), "homerail-worker-redacted-audit-"));
    await runPrompt(
      {
        task: "test",
        sender: "test",
        runId: "run-tool-redaction",
        dagConfig: makeConfig(),
      },
      {
        wsSend: (d) => sent.push(d),
        agentBackend: "test-tool-redaction",
        auditDir,
      },
    );

    const parsed = sent.map((s) => JSON.parse(s));
    const toolUse = parsed.find((msg) => msg.type === "stream" && msg.data?.event === "tool_use");
    const toolResult = parsed.find((msg) => msg.type === "stream" && msg.data?.event === "tool_result");

    expect(toolUse?.data?.tool_input).toMatchObject({
      command: expect.stringContaining("Authorization: Bearer ***REDACTED***"),
      api_key: "***REDACTED***",
    });
    expect(toolResult?.data?.result_preview).toContain("token=***REDACTED***");
    expect(JSON.stringify([toolUse, toolResult])).not.toContain("secret-token-123456");
    expect(JSON.stringify([toolUse, toolResult])).not.toContain("secret-key-value");
    expect(JSON.stringify([toolUse, toolResult])).not.toContain("secret-result-token");
    const auditText = [
      readFileSync(join(auditDir, "run-tool-redaction.jsonl"), "utf8"),
      readFileSync(join(auditDir, "tool-events", "run-tool-redaction.jsonl"), "utf8"),
    ].join("\n");
    expect(auditText).not.toContain("secret-token-123456");
    expect(auditText).not.toContain("secret-key-value");
    expect(auditText).toContain("***REDACTED***");
    rmSync(auditDir, { recursive: true, force: true });
  });

  it("redacts task, text, errors, WS events, audit files, and session files", async () => {
    const oldHome = process.env.HOMERAIL_HOME;
    const tmpHome = mkdtempSync(join(tmpdir(), "homerail-worker-all-path-redaction-"));
    const auditDir = join(tmpHome, "audit-test");
    process.env.HOMERAIL_HOME = tmpHome;
    try {
      const mockAgent: AgentClient = {
        run() {
          return (async function* () {
            yield { type: "text" as const, text: "assistant sk-outputsecret12345 arbitrary-turn-value" };
            yield { type: "error" as const, message: "failure token=error-secret-value" };
            yield { type: "done" as const };
          })();
        },
      };
      registerAgentBackend("test-all-path-redaction", () => mockAgent);
      const sent: string[] = [];
      await runPrompt({
        task: "task api_key=task-secret-value",
        sender: "test",
        runId: "run-all-path-redaction",
        dagConfig: makeConfigWith({ session_id: "redacted-session" }),
        credentialRedactionValues: ["arbitrary-turn-value"],
      }, {
        wsSend: (data) => sent.push(data),
        agentBackend: "test-all-path-redaction",
        auditDir,
      });

      const evidence = [
        ...sent,
        readFileSync(join(auditDir, "run-all-path-redaction.jsonl"), "utf8"),
        readFileSync(join(tmpHome, "manager", "session-store", "redacted-session", "transcript.jsonl"), "utf8"),
      ].join("\n");
      expect(evidence).not.toContain("task-secret-value");
      expect(evidence).not.toContain("sk-outputsecret12345");
      expect(evidence).not.toContain("error-secret-value");
      expect(evidence).not.toContain("arbitrary-turn-value");
      expect(evidence).toContain("***REDACTED***");
      const resumableSession = readFileSync(
        join(tmpHome, "manager", "session-store", "redacted-session", "session.json"),
        "utf8",
      );
      expect(resumableSession).toContain("task api_key=task-secret-value");
    } finally {
      if (oldHome === undefined) delete process.env.HOMERAIL_HOME;
      else process.env.HOMERAIL_HOME = oldHome;
      rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  it("passes job LLM credential fields into the agent context", async () => {
    let observed: AgentRunContext | null = null;
    const mockAgent: AgentClient = {
      run(_prompt, _tools, context) {
        observed = context;
        return (async function* () {
          yield { type: "done" as const };
        })();
      },
    };
    registerAgentBackend("test-credential-context", () => mockAgent);

    await runPrompt(
      {
        task: "test",
        sender: "test",
        runId: "run-credential",
        dagConfig: makeConfig(),
        llmProvider: "anthropic",
        llmApiKey: "anthropic-test-secret",
        llmBaseUrl: "https://api.anthropic.test",
        llmAnthropicAuthMode: "auth_token",
      },
      {
        wsSend: () => {},
        agentBackend: "test-credential-context",
      },
    );

    expect(observed).toMatchObject({
      systemPromptMode: "append",
      provider: "anthropic",
      apiKey: "anthropic-test-secret",
      baseUrl: "https://api.anthropic.test",
      anthropicAuthMode: "auth_token",
    });
  });

  it("persists per-node session transcripts without plaintext credentials", async () => {
    const oldHome = process.env.HOMERAIL_HOME;
    const tmpHome = mkdtempSync(join(tmpdir(), "homerail-worker-session-store-"));
    process.env.HOMERAIL_HOME = tmpHome;
    try {
      const mockAgent: AgentClient = {
        run() {
          return (async function* () {
            yield { type: "text" as const, text: "hello" };
            yield { type: "done" as const };
          })();
        },
      };
      registerAgentBackend("test-session-store", () => mockAgent);

      for (const [nodeId, sessionId] of [["coder", "node-session-a"], ["tester", "node-session-b"]] as const) {
        await runPrompt(
          {
            task: `task for ${nodeId}`,
            sender: "test",
            runId: "same-run",
            dagConfig: makeConfigWith({ node_id: nodeId, session_id: sessionId }),
            llmProvider: "anthropic",
            llmApiKey: "pk-session-store-secret",
            llmBaseUrl: "https://llm.example.test/v1",
          },
          {
            wsSend: () => {},
            agentBackend: "test-session-store",
          },
        );
      }

      for (const sessionId of ["node-session-a", "node-session-b"]) {
        const dir = join(tmpHome, "manager", "session-store", sessionId);
        expect(existsSync(join(dir, "session.json"))).toBe(true);
        expect(existsSync(join(dir, "transcript.jsonl"))).toBe(true);
        const text = `${readFileSync(join(dir, "session.json"), "utf8")}\n${readFileSync(join(dir, "transcript.jsonl"), "utf8")}`;
        expect(text).toContain(sessionId);
        expect(text).not.toContain("pk-session-store-secret");
      }
    } finally {
      if (oldHome === undefined) delete process.env.HOMERAIL_HOME;
      else process.env.HOMERAIL_HOME = oldHome;
      rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  it("records checkpoint resume metadata in the forked session transcript", async () => {
    const oldHome = process.env.HOMERAIL_HOME;
    const tmpHome = mkdtempSync(join(tmpdir(), "homerail-worker-checkpoint-transcript-"));
    process.env.HOMERAIL_HOME = tmpHome;
    try {
      const mockAgent: AgentClient = {
        run() {
          return (async function* () {
            yield { type: "done" as const };
          })();
        },
      };
      registerAgentBackend("test-checkpoint-transcript", () => mockAgent);

      await runPrompt(
        {
          task: "checkpoint_resume: RESUME_MARKER",
          sender: "test",
          runId: "run-checkpoint",
          dagConfig: makeConfigWith({ session_id: "child-session" }),
          checkpointResume: {
            parentSessionId: "parent-session",
            entryUuid: "entry-7",
            instruction: "RESUME_MARKER",
            attempt: 2,
          },
        },
        {
          wsSend: () => {},
          agentBackend: "test-checkpoint-transcript",
        },
      );

      const transcript = readFileSync(
        join(tmpHome, "manager", "session-store", "child-session", "transcript.jsonl"),
        "utf8",
      );
      expect(transcript).toContain("\"type\":\"checkpoint_resume\"");
      expect(transcript).toContain("parent-session");
      expect(transcript).toContain("entry-7");
      expect(transcript).toContain("RESUME_MARKER");
      expect(existsSync(join(tmpHome, "manager", "session-store", "parent-session"))).toBe(false);
    } finally {
      if (oldHome === undefined) delete process.env.HOMERAIL_HOME;
      else process.env.HOMERAIL_HOME = oldHome;
      rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  it.each(["checkpoint-claude-adapter", "checkpoint-codex-adapter"])(
    "injects the same provider-neutral checkpoint before %s execution",
    async (backend) => {
      let observedPrompt = "";
      const mockAgent: AgentClient = {
        run(prompt) {
          observedPrompt = prompt;
          return (async function* () {
            yield { type: "done" as const };
          })();
        },
      };
      registerAgentBackend(backend, () => mockAgent);

      await runPrompt(
        {
          task: "Continue with the new command",
          sender: "test",
          runId: `run-${backend}`,
          dagConfig: makeConfig(),
          actorCheckpoint: {
            schema_version: 1,
            objective: "Research the selected topic",
            confirmed_conclusions: ["Primary source A is current"],
            unresolved_items: ["Verify source B"],
            key_event_refs: ["event-7"],
            artifact_refs: ["brief:artifact-1"],
            workspace_ref: "project-1",
            surface_binding: "surface-research",
            context_summary: "{\"last_step\":\"source A verified\"}",
            round_id: "round-0001",
            actor_generation: 1,
            captured_at: 1_784_000_000_000,
          },
        },
        {
          wsSend: () => {},
          agentBackend: backend,
        },
      );

      expect(observedPrompt).toContain("HomeRail portable actor checkpoint");
      expect(observedPrompt).toContain("Primary source A is current");
      expect(observedPrompt).toContain("Verify source B");
      expect(observedPrompt).toContain("## Current round input\nContinue with the new command");
    },
  );

  it("reports a node error when no LLM base URL is configured", async () => {
    delete process.env.LLM_BASE_URL;
    const mockAgent: AgentClient = {
      run() {
        return (async function* () {
          yield { type: "done" as const };
        })();
      },
    };
    registerAgentBackend("test-missing-base-url", () => mockAgent);

    const sent: string[] = [];
    await runPrompt(
      {
        task: "test",
        sender: "test",
        runId: "run-missing-base-url",
        dagConfig: makeConfig(),
      },
      {
        wsSend: (d) => sent.push(d),
        agentBackend: "test-missing-base-url",
      },
    );

    const parsed = sent.map((s) => JSON.parse(s));
    expect(parsed).toContainEqual(expect.objectContaining({
      type: "node_error",
      data: expect.objectContaining({
        runId: "run-missing-base-url",
        nodeId: "coder",
        message: "LLM base URL is required. Provide job.llmBaseUrl or set LLM_BASE_URL.",
        session_id: "run-missing-base-url",
      }),
    }));
    expect(parsed.map((msg) => msg.type)).toContain("SESSION_END");
  });

  it("passes the runner abort signal into the agent context", async () => {
    const controller = new AbortController();
    let observed: AgentRunContext | null = null;
    const mockAgent: AgentClient = {
      run(_prompt, _tools, context) {
        observed = context;
        return (async function* () {
          yield { type: "done" as const };
        })();
      },
    };
    registerAgentBackend("test-abort-context", () => mockAgent);

    await runPrompt(
      {
        task: "test",
        sender: "test",
        runId: "run-abort-context",
        dagConfig: makeConfig(),
      },
      {
        wsSend: () => {},
        agentBackend: "test-abort-context",
        abortSignal: controller.signal,
      },
    );

    const finalObserved = observed as AgentRunContext | null;
    expect(finalObserved?.abortSignal).toBe(controller.signal);
  });

  it("stops after handoff", async () => {
    const mockAgent: AgentClient = {
      run() {
        return (async function* () {
          yield { type: "text" as const, text: "before handoff" };
          yield { type: "text" as const, text: "after handoff" };
          yield { type: "done" as const };
        })();
      },
    };
    registerAgentBackend("test-handoff", () => mockAgent);

    const sent: string[] = [];
    const config = makeConfig();
    // Pre-set yielded to simulate handoff happening during first text
    // (In reality, handoff would be triggered by a tool call, but for
    // this test we just verify the SESSION_END is always sent)

    await runPrompt(
      {
        task: "test",
        sender: "test",
        runId: "run-2",
        dagConfig: config,
      },
      {
        wsSend: (d) => sent.push(d),
        agentBackend: "test-handoff",
      },
    );

    const types = sent.map((s) => JSON.parse(s).type);
    expect(types).toContain("SESSION_END");
  });

  it("deterministic backend sends node_handoff from systemPrompt directive", async () => {
    delete process.env.LLM_BASE_URL;
    const sent: string[] = [];
    const terminalMessages: string[] = [];

    await runPrompt(
      {
        task: "Initial user task wrapper",
        sender: "test",
        runId: "run-det",
        dagConfig: {
          ...makeConfig(),
          node_id: "live_node",
          agent_type: "deterministic",
          graph_nodes: ["live_node"],
          outgoing_edges: [{ from_port: "done", to_node: "", to_port: "" }],
          round_id: "round-0002",
          actor_id: "actor-live",
          generation: 4,
          lease_generation: 9,
          command_id: "command-live-2",
        },
        systemPrompt: "  HANDOFF port=done content=Source Issue: #847\n\nArtifact: ok",
      },
      {
        wsSend: (d) => sent.push(d),
        onTerminalMessage: (data) => terminalMessages.push(data),
        agentBackend: "deterministic",
      },
    );

    const parsed = sent.map((s) => JSON.parse(s));
    expect(parsed.find((msg) => msg.type === "response")).toBeUndefined();
    const handoff = terminalMessages.map((message) => JSON.parse(message)).find((msg) => msg.type === "response");
    expect(handoff?.data).toMatchObject({
      type: "node_handoff",
      runId: "run-det",
      nodeId: "live_node",
      port: "done",
      round_id: "round-0002",
      actor_id: "actor-live",
      generation: 4,
      lease_generation: 9,
      command_id: "command-live-2",
      content: "Source Issue: #847\n\nArtifact: ok",
    });
    const activityStreams = parsed
      .filter((message) => message.type === "stream" && message.data?.event === "dag_activity");
    expect(activityStreams).not.toHaveLength(0);
    for (const message of activityStreams) {
      expect(message.data).toMatchObject({
        round_id: "round-0002",
        actor_id: "actor-live",
        generation: 4,
        lease_generation: 9,
        command_id: "command-live-2",
      });
    }
    const activities = activityStreams
      .map((message) => message.data.activity);
    expect(activities.map((activity) => activity.type)).toEqual([
      "started",
      "tool_used",
      "tool_used",
      "completed",
    ]);
    expect(activities.map((activity) => activity.sequence)).toEqual([1, 2, 3, 4]);
    expect(activities.every((activity) => activity.lease_generation === 9)).toBe(true);
    expect(parsed.find((message) => message.type === "SESSION_END")?.data).toMatchObject({
      lease_generation: 9,
    });
    expect(parsed.map((msg) => msg.type)).toContain("SESSION_END");
  });

  it("rejects a handoff that reflects a turn-scoped credential", async () => {
    delete process.env.LLM_BASE_URL;
    const terminalMessages: string[] = [];
    const result = await runPrompt({
      task: "Initial user task wrapper",
      sender: "test",
      runId: "run-secret-handoff",
      dagConfig: {
        ...makeConfig(),
        node_id: "secret_node",
        agent_type: "deterministic",
        graph_nodes: ["secret_node"],
        outgoing_edges: [{ from_port: "done", to_node: "", to_port: "" }],
      },
      systemPrompt: "HANDOFF port=done content=prefix-arbitrary-turn-value-suffix",
      credentialRedactionValues: ["arbitrary-turn-value"],
    }, {
      wsSend: () => {},
      onTerminalMessage: (data) => terminalMessages.push(data),
      agentBackend: "deterministic",
    });

    expect(result).toMatchObject({ status: "failed", reason: expect.stringContaining("DAG_CREDENTIAL_OUTPUT_REJECTED") });
    const parsed = terminalMessages.map((message) => JSON.parse(message));
    expect(parsed.some((message) => message.type === "response")).toBe(false);
    expect(parsed).toContainEqual(expect.objectContaining({
      type: "node_error",
      data: expect.objectContaining({ message: expect.stringContaining("DAG_CREDENTIAL_OUTPUT_REJECTED") }),
    }));
    expect(terminalMessages.join("\n")).not.toContain("arbitrary-turn-value");
  });
});
