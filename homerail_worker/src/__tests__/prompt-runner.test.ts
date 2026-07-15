/**
 * Tests for prompt runner: full prompt → tool → result flow.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { runPrompt } from "../prompt-runner.js";
import type { PromptJob } from "../prompt-runner.js";
import type { DagNodeConfig } from "homerail-protocol";
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
      }),
    }));
    expect(parsed.map((msg) => msg.type)).toContain("SESSION_END");
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
    expect(observedContext?.systemPrompt).toContain("DAG CONTRACT CORRECTION MODE");
    expect(observedContext?.systemPrompt).toContain("The active DAG run_id is run-correction-only");
    expect(observedContext?.systemPrompt).toContain("Original reviewer instructions");
    expect(terminalMessages.map((message) => JSON.parse(message))).toContainEqual(expect.objectContaining({
      type: "response",
      data: expect.objectContaining({ port: "done", content: "corrected" }),
    }));
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
    expect(terminalMessages.map((message) => JSON.parse(message))).toEqual([{
      type: "node_error",
      data: {
        runId: "run-deferred-node-error",
        nodeId: "coder",
        message: "agent ended without DAG handoff",
        session_id: "session-deferred",
      },
    }]);
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

    expect(terminalMessages.map((message) => JSON.parse(message))).toEqual([{
      type: "node_error",
      data: {
        runId: "run-fenced-node-error",
        nodeId: "coder",
        message: "round two failed",
        session_id: "session-fenced",
        round_id: "round-0002",
        actor_id: "actor-coder",
        generation: 3,
        lease_generation: 8,
        command_id: "command-2",
      },
    }]);
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
            yield { type: "text" as const, text: "assistant sk-outputsecret12345" };
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
});
