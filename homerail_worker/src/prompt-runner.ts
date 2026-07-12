/**
 * Prompt runner — receives a task via WS, runs the agent with DAG tools,
 * streams events back, and handles graceful shutdown.
 * @version 0.1.0
 */

import { normalizeManagerAgentRuntimeAgentType, type DagAdvisorConfig, type DagNodeConfig } from "homerail-protocol";
import { createAgentClient } from "./agent/factory.js";
import type { AgentEvent, AgentRunContext, AgentUsage } from "./agent/types.js";
import { createDagTools, createDagToolsState, deliverInbox } from "./dag-tools/index.js";
import type { DagToolsState } from "./dag-tools/index.js";
import { createAuditWriters } from "./audit/index.js";
import type { AuditWriters } from "./audit/index.js";
import { appendTranscriptEntry, redactAgentContext, saveSession } from "./session/session-store.js";
import { redactTelemetry } from "./telemetry-redaction.js";
import { snapshotWorkspace, verifyWorkspacePolicy, type WorkspaceSnapshot } from "./workspace-policy.js";

export interface PromptJob {
  task: string;
  sender: string;
  runId: string;
  dagConfig: DagNodeConfig;
  systemPrompt?: string;
  llmProvider?: string;
  llmProtocol?: string;
  llmApiKey?: string;
  llmBaseUrl?: string;
  checkpointResume?: {
    parentSessionId?: string;
    entryUuid?: string;
    instruction: string;
    attempt: number;
  };
}

export interface PromptRunnerDeps {
  wsSend: (data: string) => void;
  onTerminalMessage?: (data: string) => void;
  agentBackend?: string;
  auditDir?: string;
  abortSignal?: AbortSignal;
  registerInboxHandler?: (handler: (content: unknown) => void) => () => void;
}

function resolveLlmBaseUrl(job: PromptJob): string {
  const baseUrl = job.llmBaseUrl ?? process.env.LLM_BASE_URL ?? "";
  if (!baseUrl.trim()) {
    throw new Error("LLM base URL is required. Provide job.llmBaseUrl or set LLM_BASE_URL.");
  }
  return baseUrl;
}

function resolveAgentBaseUrl(job: PromptJob, agentBackend?: string): string {
  const backend = (agentBackend ?? process.env.AGENT_BACKEND ?? "").trim();
  if (backend === "deterministic") {
    return job.llmBaseUrl ?? process.env.LLM_BASE_URL ?? "";
  }
  return resolveLlmBaseUrl(job);
}

function assertAgentRuntimeProtocol(agentBackend: string | undefined, protocol: string | undefined): void {
  const backend = normalizeManagerAgentRuntimeAgentType(agentBackend ?? process.env.AGENT_BACKEND);
  if (backend === "claude-sdk" && protocol !== "anthropic_compatible") {
    throw new Error(
      "Claude SDK requires an Anthropic-compatible endpoint; missing or non-Anthropic protocol is not allowed for harness execution.",
    );
  }
}

async function runAdvisorCall(
  advisor: DagAdvisorConfig,
  question: string,
  workspace: string,
  parentSignal?: AbortSignal,
): Promise<{ text: string; usage: AgentUsage }> {
  assertAgentRuntimeProtocol(advisor.agent_type, advisor.protocol);
  const controller = new AbortController();
  const onParentAbort = () => controller.abort(parentSignal?.reason);
  parentSignal?.addEventListener("abort", onParentAbort, { once: true });
  const timeout = setTimeout(() => controller.abort(new Error(`advisor timeout after ${advisor.timeout_ms}ms`)), advisor.timeout_ms);
  const usage: AgentUsage = {};
  const text: string[] = [];
  try {
    const client = createAgentClient(advisor.agent_type);
    const context: AgentRunContext = {
      systemPrompt: advisor.system_prompt,
      provider: advisor.provider,
      protocol: advisor.protocol,
      model: advisor.model,
      apiKey: advisor.api_key ?? "",
      baseUrl: advisor.base_url ?? "",
      workspace,
      sessionId: `advisor-${advisor.id}-${Date.now()}`,
      abortSignal: controller.signal,
    };
    for await (const event of client.run(question, [], context)) {
      if (event.type === "text") text.push(event.text);
      if (event.type === "usage") {
        for (const [key, value] of Object.entries(event.usage) as Array<[keyof AgentUsage, number | undefined]>) {
          if (typeof value === "number") usage[key] = value;
        }
        const totalTokens = (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0);
        if (totalTokens > advisor.max_tokens) {
          controller.abort(new Error(`advisor token limit exceeded: ${totalTokens} > ${advisor.max_tokens}`));
          throw controller.signal.reason;
        }
      }
      if (event.type === "error") throw new Error(event.message);
    }
    if (controller.signal.aborted) {
      throw controller.signal.reason instanceof Error ? controller.signal.reason : new Error("advisor call aborted");
    }
    return { text: text.join("\n").trim(), usage };
  } finally {
    clearTimeout(timeout);
    parentSignal?.removeEventListener("abort", onParentAbort);
  }
}

export async function runPrompt(
  job: PromptJob,
  deps: PromptRunnerDeps,
): Promise<void> {
  const { wsSend, agentBackend, auditDir } = deps;
  const sessionId = job.dagConfig.session_id ?? job.runId;

  function appendSessionTranscript(type: string, content?: unknown, metadata?: Record<string, unknown>): void {
    try {
      appendTranscriptEntry({
        type,
        runId: job.runId,
        nodeId: job.dagConfig.node_id,
        sessionId,
        timestamp: Date.now(),
        content: redactTelemetry(content),
        metadata: redactTelemetry(metadata) as Record<string, unknown> | undefined,
      });
    } catch {
      // Session transcript persistence is best-effort. The manager DB run
      // state remains authoritative for scheduling.
    }
  }

  try {
    saveSession({
      sessionId,
      runId: job.runId,
      nodeId: job.dagConfig.node_id,
      messages: [{ role: "user", content: job.task }],
      toolCallState: { inFlight: false },
      agentConfig: {
        provider: job.llmProvider,
        model: job.dagConfig.model,
        workspace: process.env.WORKSPACE ?? process.cwd(),
      },
      timestamp: Date.now(),
    });
  } catch {
    // Best-effort; never fail a worker turn because local session metadata
    // cannot be written.
  }
  if (job.checkpointResume) {
    appendSessionTranscript(
      "checkpoint_resume",
      { instruction: job.checkpointResume.instruction },
      {
        parentSessionId: job.checkpointResume.parentSessionId,
        entryUuid: job.checkpointResume.entryUuid,
        attempt: job.checkpointResume.attempt,
      },
    );
  }

  // Test affordance: when AGENT_BACKEND=deterministic and
  // HOMERAIL_DETERMINISTIC_PROMPT_DELAY_MS is set, sleep before processing
  // the task. This gives a harness a chance to inject while the run is
  // still active. Default off.
  const delayEnv = process.env.HOMERAIL_DETERMINISTIC_PROMPT_DELAY_MS;
  const delayMs = delayEnv ? Number(delayEnv) : 0;
  if (delayMs > 0 && (agentBackend === "deterministic" || process.env.AGENT_BACKEND === "deterministic")) {
    await new Promise((r) => setTimeout(r, delayMs));
  }

  // Create DAG tools state
  const dagState = createDagToolsState(job.dagConfig, job.runId, wsSend);
  const workspace = process.env.WORKSPACE ?? process.cwd();
  const dagTools = createDagTools(dagState, {
    advisorRunner: (advisor, question) => runAdvisorCall(advisor, question, workspace, deps.abortSignal),
  });
  const unregisterInboxHandler = deps.registerInboxHandler?.((content) => {
    deliverInbox(dagState, content);
  });

  // Create audit writers
  let audit: AuditWriters | null = null;
  try {
    audit = createAuditWriters(job.runId, auditDir);
  } catch {
    // Non-fatal — audit is best-effort
  }

  // Write initial transcript entry
  audit?.transcript.write({
    event: "prompt_start",
    node_id: job.dagConfig.node_id,
    run_id: job.runId,
    sender: job.sender,
    task_preview: job.task.slice(0, 500),
  });
  appendSessionTranscript("prompt_start", { task_preview: job.task.slice(0, 500) });

  // Stream content via WS
  function sendContent(text: string) {
    const redactedText = String(redactTelemetry(text));
    wsSend(
      JSON.stringify({
        type: "content",
        data: {
          text: redactedText,
          run_id: job.runId,
          node_id: job.dagConfig.node_id,
          session_id: job.dagConfig.session_id ?? job.runId,
        },
      }),
    );
  }

  function sendStream(data: Record<string, unknown>) {
    const redactedData = redactTelemetry(data) as Record<string, unknown>;
    wsSend(
      JSON.stringify({
        type: "stream",
        data: {
          type: typeof redactedData.event === "string" ? redactedData.event : "stream",
          ...redactedData,
          run_id: job.runId,
          node_id: job.dagConfig.node_id,
          session_id: job.dagConfig.session_id ?? job.runId,
        },
      }),
    );
  }

  // Declared outside try so emitUsage() (a closure defined after the
  // try/catch) and the catch handler can read them even on early failure.
  const nodeUsage: AgentUsage = {};
  let nodeDurationMs: number | undefined;
  let nodeNumTurns: number | undefined;
  let workspaceBefore: WorkspaceSnapshot | undefined;

  try {
    if (dagState.workspaceAccess) {
      workspaceBefore = snapshotWorkspace(workspace, dagState.workspaceAccess);
      sendStream({
        event: "workspace_policy_snapshot",
        before_file_count: Object.keys(workspaceBefore.files).length,
        readonly_paths: dagState.workspaceAccess.readonly_paths ?? [],
        writable_paths: dagState.workspaceAccess.writable_paths,
      });
    }
    assertAgentRuntimeProtocol(agentBackend, job.llmProtocol);
    const agent = createAgentClient(agentBackend);
    const context: AgentRunContext = {
      systemPrompt: job.systemPrompt,
      provider: job.llmProvider,
      protocol: job.llmProtocol,
      model: job.dagConfig.model,
      apiKey: job.llmApiKey ?? process.env.LLM_API_KEY ?? "",
      baseUrl: resolveAgentBaseUrl(job, agentBackend),
      workspace,
      sessionId: job.dagConfig.session_id ?? job.runId,
      abortSignal: deps.abortSignal,
    };
    try {
      saveSession({
        sessionId,
        runId: job.runId,
        nodeId: job.dagConfig.node_id,
        messages: [{ role: "user", content: job.task }],
        toolCallState: { inFlight: false },
        agentConfig: redactAgentContext(context),
        timestamp: Date.now(),
      });
    } catch {
      // Best-effort.
    }
    let errorMessage: string | null = null;
    for await (const event of agent.run(job.task, dagTools, context)) {
      switch (event.type) {
        case "text":
          sendContent(event.text);
          audit?.transcript.write({ event: "text", text: event.text });
          appendSessionTranscript("text", event.text);
          break;
        case "debug": {
          const debugMessage = String(redactTelemetry(event.message));
          const debugData = redactTelemetry(event.data ?? {}) as Record<string, unknown>;
          sendStream({
            event: "agent_debug",
            source: event.source,
            message: debugMessage,
            data: debugData,
          });
          console.log(
            `[homerail_worker] HOMERAIL_AGENT_DEBUG ${JSON.stringify({
              run_id: job.runId,
              node_id: job.dagConfig.node_id,
              source: event.source,
              message: debugMessage,
              data: debugData,
            })}`,
          );
          audit?.transcript.write({
            event: "agent_debug",
            source: event.source,
            message: debugMessage,
            data: debugData,
          });
          appendSessionTranscript("agent_debug", undefined, {
            source: event.source,
            message: debugMessage,
            data: debugData,
          });
          break;
        }
        case "tool_use":
          appendSessionTranscript("tool_use", undefined, {
            tool_name: event.name,
            tool_id: event.id,
            tool_input: redactTelemetry(event.input),
          });
          sendStream({
            event: "tool_use",
            tool_name: event.name,
            tool_id: event.id,
            tool_input: redactTelemetry(event.input),
          });
          audit?.toolEvents.write({
            event: "tool_use",
            tool_name: event.name,
            tool_id: event.id,
            input: redactTelemetry(event.input),
            node_id: job.dagConfig.node_id,
            run_id: job.runId,
          });
          break;
        case "tool_result":
          appendSessionTranscript("tool_result", undefined, {
            tool_use_id: event.tool_use_id,
            is_error: event.is_error,
            result_preview: redactTelemetry(event.content),
          });
          sendStream({
            event: "tool_result",
            tool_use_id: event.tool_use_id,
            is_error: event.is_error,
            result_preview: redactTelemetry(event.content),
          });
          audit?.toolEvents.write({
            event: "tool_result",
            tool_use_id: event.tool_use_id,
            is_error: event.is_error,
            node_id: job.dagConfig.node_id,
            run_id: job.runId,
          });
          break;
        case "error":
          errorMessage = String(redactTelemetry(event.message));
          sendContent(`[ERROR] ${errorMessage}`);
          audit?.transcript.write({ event: "error", message: errorMessage });
          appendSessionTranscript("error", errorMessage);
          break;
        case "usage":
          // The claude-sdk adapter emits running-total snapshots (one per
          // assistant message, carrying the cumulative total so far), so
          // we replace rather than accumulate. Other adapters that emit a
          // single final aggregate behave the same way.
          Object.assign(nodeUsage, event.usage);
          break;
        case "done":
          if (event.usage) Object.assign(nodeUsage, event.usage);
          if (event.duration_ms !== undefined) nodeDurationMs = event.duration_ms;
          if (event.num_turns !== undefined) nodeNumTurns = event.num_turns;
          break;
      }

      // If handoff was called, stop processing. Emit the final accumulated
      // usage first so the manager can persist per-node token totals even
      // when the node yields early via handoff.
      if (dagState.yielded) {
        emitUsage();
        break;
      }
    }
    // Normal completion (no handoff, no error) — emit usage once more so
    // the manager records totals before the node-error fallback fires.
    if (!dagState.yielded) {
      emitUsage();
      sendNodeError(errorMessage ?? "agent ended without DAG handoff");
    } else {
      let workspaceValid = true;
      if (dagState.workspaceAccess && workspaceBefore) {
        const workspaceAfter = snapshotWorkspace(workspace, dagState.workspaceAccess);
        const policyResult = verifyWorkspacePolicy(workspaceBefore, workspaceAfter, dagState.workspaceAccess);
        sendStream({ event: "workspace_policy_verified", ...policyResult });
        workspaceValid = policyResult.valid;
        if (!workspaceValid) {
          dagState.yielded = false;
          sendNodeError(`DAG_WORKSPACE_POLICY_VIOLATION ${JSON.stringify(policyResult)}`);
        }
      }
      if (workspaceValid && dagState.handoffData) {
        // This is the authoritative runtime payload, not telemetry. The
        // Manager applies it before writing redacted evidence copies.
        sendTerminalMessage(JSON.stringify({
          type: "response",
          session_id: dagState.sessionId,
          data: dagState.handoffData,
        }));
      }
    }
  } catch (err) {
    const msg = String(redactTelemetry(err instanceof Error ? err.message : String(err)));
    sendContent(`[FATAL] ${msg}`);
    audit?.transcript.write({ event: "fatal", message: msg });
    appendSessionTranscript("fatal", msg);
    // Best-effort: emit whatever usage was accumulated before the crash.
    emitUsage();
    if (!dagState.yielded || dagState.workspaceAccess) {
      sendNodeError(msg);
    }
  }

  try {
    unregisterInboxHandler?.();
  } catch {
    // Best-effort cleanup
  }

  // Write final transcript entry
  audit?.transcript.write({
    event: "prompt_end",
    node_id: job.dagConfig.node_id,
    run_id: job.runId,
    yielded: dagState.yielded,
  });
  appendSessionTranscript("prompt_end", undefined, { yielded: dagState.yielded });

  // Send SESSION_END
  wsSend(
    JSON.stringify({
      type: "SESSION_END",
      data: {
        session_id: job.dagConfig.session_id ?? job.runId,
        run_id: job.runId,
        node_id: job.dagConfig.node_id,
      },
    }),
  );

  // Close audit writers
  try {
    await audit?.transcript.close();
    await audit?.toolEvents.close();
  } catch {
    // Best-effort cleanup
  }

  function sendNodeError(message: string) {
    const redactedMessage = String(redactTelemetry(message));
    const data = {
      runId: job.runId,
      nodeId: job.dagConfig.node_id,
      message: redactedMessage,
      session_id: job.dagConfig.session_id ?? job.runId,
    };
    sendTerminalMessage(JSON.stringify({ type: "node_error", data }));
  }

  function sendTerminalMessage(data: string) {
    if (deps.onTerminalMessage) deps.onTerminalMessage(data);
    else wsSend(data);
  }

  function emitUsage(): void {
    const hasUsage = nodeUsage.input_tokens !== undefined
      || nodeUsage.output_tokens !== undefined
      || nodeUsage.cache_read_input_tokens !== undefined
      || nodeUsage.cache_creation_input_tokens !== undefined;
    if (!hasUsage) return;
    sendStream({
      event: "usage",
      usage: {
        input_tokens: nodeUsage.input_tokens ?? 0,
        output_tokens: nodeUsage.output_tokens ?? 0,
        cache_read_input_tokens: nodeUsage.cache_read_input_tokens ?? 0,
        cache_creation_input_tokens: nodeUsage.cache_creation_input_tokens ?? 0,
      },
      duration_ms: nodeDurationMs,
      num_turns: nodeNumTurns,
    });
    audit?.transcript.write({
      event: "usage",
      usage: nodeUsage,
      duration_ms: nodeDurationMs,
      num_turns: nodeNumTurns,
    });
    appendSessionTranscript("usage", undefined, {
      usage: nodeUsage,
      duration_ms: nodeDurationMs,
      num_turns: nodeNumTurns,
    });
  }
}

/** Expose deliverInbox for external callers (e.g., dag_inbox handler). */
export { deliverInbox, type DagToolsState };
