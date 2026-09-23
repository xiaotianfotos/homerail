import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runPrompt, type PromptJob } from "../prompt-runner.js";
import * as agentFactory from "../agent/factory.js";
import type { AgentClient, AgentEvent } from "../agent/types.js";

describe("native subscription handoff acceptance", () => {
  let workspace: string;
  let job: PromptJob;

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), "native-codex-handoff-test-"));
    vi.stubEnv("WORKSPACE", workspace);
    job = {
      task: "Read the input and return a result",
      sender: "test",
      runId: "native-handoff-run",
      llmProvider: "openai",
      llmProtocol: "codex_subscription",
      dagConfig: {
        node_id: "reader", agent_type: "codex_appserver", model: "exact-model",
        reasoning_effort: "low", codex_sandbox: "read-only", builtin_tool_policy: "backend_native",
        workspace_access: { writable_paths: [], readonly_paths: ["."] },
        outgoing_edges: [{ from_port: "done", to_node: "result", to_port: "in" }],
        incoming_edges: [], graph_nodes: ["reader", "result"], allowed_dag_tools: ["handoff"],
      },
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    rmSync(workspace, { recursive: true, force: true });
  });

  it("rejects API tasks on a dedicated native host Worker before creating an agent", async () => {
    vi.stubEnv("HOMERAIL_CODEX_SUBSCRIPTION_ENABLED", "1");
    const create = vi.spyOn(agentFactory, "createAgentClient");
    const messages: string[] = [];
    const result = await runPrompt({ ...job, llmProtocol: "openai_responses" }, {
      agentBackend: "codex_appserver", wsSend: message => messages.push(message),
    });
    expect(result).toMatchObject({ status: "failed", reason: expect.stringContaining("only explicitly selected native") });
    expect(create).not.toHaveBeenCalled();
    expect(messages.map(message => JSON.parse(message).type)).not.toContain("response");
  });

  it("rejects a substituted executor for an explicit subscription task", async () => {
    const create = vi.spyOn(agentFactory, "createAgentClient");
    const result = await runPrompt(job, { agentBackend: "deterministic", wsSend: () => {} });
    expect(result).toMatchObject({ status: "failed", reason: expect.stringContaining("executor fallback is disabled") });
    expect(create).not.toHaveBeenCalled();
  });

  async function runWithTail(tail: AgentEvent[], options: { disconnect?: boolean; cancel?: boolean } = {}) {
    const controller = new AbortController();
    let drainedPastHandoff = false;
    let cleaned = false;
    const terminal: string[] = [];
    const streamed: string[] = [];
    const agent: AgentClient = {
      run(_prompt, tools) {
        return (async function* (): AsyncGenerator<AgentEvent> {
          try {
            const result = await tools.find(tool => tool.name === "handoff")!.handler({ port: "done", content: "candidate result" });
            expect(result.is_error).not.toBe(true);
            yield { type: "tool_result", tool_use_id: "handoff-call", content: "accepted" };
            drainedPastHandoff = true;
            // HomeRail must withhold its authoritative response until the
            // backend confirms the native turn has actually completed.
            expect(terminal.map(message => JSON.parse(message).type)).not.toContain("response");
            if (options.cancel) controller.abort();
            if (options.disconnect) throw new Error("native transport disconnected before terminal ACK");
            for (const event of tail) yield event;
          } finally {
            cleaned = true;
          }
        })();
      },
    };
    vi.spyOn(agentFactory, "createAgentClient").mockReturnValue(agent);
    const result = await runPrompt(job, {
      agentBackend: "codex_appserver", abortSignal: controller.signal,
      wsSend: message => streamed.push(message),
      onTerminalMessage: message => terminal.push(message),
    });
    expect(drainedPastHandoff).toBe(true);
    expect(cleaned).toBe(true);
    return { result, terminal: terminal.map(message => JSON.parse(message)), streamed: streamed.map(message => JSON.parse(message)) };
  }

  it.each(["failed", "interrupted"])("rejects a buffered handoff when the native turn ends %s", async status => {
    const { result, terminal } = await runWithTail([
      { type: "error", message: `Native Codex turn ended without success (${status})` }, { type: "done" },
    ]);
    expect(result.status).toBe("failed");
    expect(terminal.some(message => message.type === "response")).toBe(false);
    expect(terminal).toContainEqual(expect.objectContaining({ type: "node_error" }));
  });

  it("rejects a buffered handoff when the event stream ends without a successful native terminal ACK", async () => {
    const { result, terminal } = await runWithTail([{ type: "done" }]);
    expect(result.status).toBe("failed");
    expect(terminal.some(message => message.type === "response")).toBe(false);
    expect(terminal).toContainEqual(expect.objectContaining({ type: "node_error" }));
  });

  it("rejects a buffered handoff when the native transport disconnects", async () => {
    const { result, terminal } = await runWithTail([], { disconnect: true });
    expect(result.status).toBe("failed");
    expect(terminal.some(message => message.type === "response")).toBe(false);
    expect(terminal).toContainEqual(expect.objectContaining({ type: "node_error" }));
  });

  it("does not accept a late successful completion after cancellation", async () => {
    const { result, terminal } = await runWithTail([{ type: "turn_complete" }, { type: "done" }], { cancel: true });
    expect(result.status).toBe("failed");
    expect(terminal.some(message => message.type === "response")).toBe(false);
  });

  it("accepts the buffered handoff only after a successful native terminal ACK", async () => {
    const { result, terminal } = await runWithTail([
      { type: "turn_complete" }, { type: "done", usage: { input_tokens: 12, output_tokens: 6 } },
    ]);
    expect(result.status).toBe("completed");
    expect(terminal.filter(message => message.type === "response")).toHaveLength(1);
    expect(terminal.some(message => message.type === "node_error")).toBe(false);
  });
});
