/**
 * homerail_worker entry point — reads env vars, connects to Manager WS,
 * and dispatches tasks to PromptRunner.
 * @version 0.1.0
 */

import { WsClient } from "./ws-client.js";
import { runPrompt } from "./prompt-runner.js";
import type { PromptJob } from "./prompt-runner.js";
import {
  DAG_TRANSPORT_FENCE_CAPABILITY,
  DAG_TRANSPORT_FENCE_V1_CAPABILITY,
  type DagActorCheckpointV1,
  type AgentBuiltinToolName,
  type DagAdvisorConfig,
  type DagAgentToolName,
  type DagNodeConfig,
  type DagWorkspaceAccess,
} from "homerail-protocol";
import { startManagerAgentServer } from "./manager-agent/server.js";
import { resolveWorkerAgentBackend } from "./agent/backend-selection.js";
import { envelopeInputsToTaskText } from "./envelope-task.js";

// ── Env vars ─────────────────────────────────────────────────

const WORKER_ID = process.env.HOMERAIL_WORKER_ID ?? `worker-${process.pid}`;
const DEFAULT_MANAGER_PORT = process.env.HOMERAIL_MANAGER_PORT?.trim() || "19191";
const DEFAULT_MANAGER_WS_BASE = (
  process.env.HOMERAIL_MANAGER_WS_URL?.trim() || `ws://localhost:${DEFAULT_MANAGER_PORT}`
).replace(/\/+$/, "");
const MANAGER_WS_URL =
  process.env.MANAGER_WORKER_WS_URL ??
  `${DEFAULT_MANAGER_WS_BASE}/ws/projects/default/workers/${encodeURIComponent(WORKER_ID)}`;
const TOKEN = process.env.HOMERAIL_WORKER_TOKEN ?? "";
const ALLOW_INSECURE_REMOTE_WS = process.env.HOMERAIL_ALLOW_INSECURE_REMOTE_WS === "1";
const CONFIGURED_CAPABILITIES = (process.env.HOMERAIL_WORKER_CAPABILITIES ?? "")
  .split(",")
  .map((capability) => capability.trim())
  .filter((capability) => capability.length > 0);
const CAPABILITIES = Array.from(new Set([
  ...CONFIGURED_CAPABILITIES,
  DAG_TRANSPORT_FENCE_V1_CAPABILITY,
  DAG_TRANSPORT_FENCE_CAPABILITY,
]));

if (process.env.MANAGER_AGENT_MODE === "1") {
  startManagerAgentServer();
} else {
// ── Main ─────────────────────────────────────────────────────

const client = new WsClient({
  url: MANAGER_WS_URL,
  workerId: WORKER_ID,
  capabilities: CAPABILITIES,
  token: TOKEN,
  allowInsecureRemote: ALLOW_INSECURE_REMOTE_WS,
});

let activePrompt:
  | {
      runId: string;
      nodeId: string;
      abortController: AbortController;
      deliverInbox?: (content: unknown) => void;
    }
  | null = null;

function stringField(data: Record<string, unknown>, ...keys: string[]): string {
  for (const key of keys) {
    const value = data[key];
    if (typeof value === "string") return value;
  }
  return "";
}

function parseCheckpointResume(value: unknown): PromptJob["checkpointResume"] | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const instruction = typeof raw.instruction === "string" ? raw.instruction.trim() : "";
  if (!instruction) return undefined;
  return {
    parentSessionId: typeof raw.parentSessionId === "string" ? raw.parentSessionId : undefined,
    entryUuid: typeof raw.entryUuid === "string" ? raw.entryUuid : undefined,
    instruction,
    attempt: typeof raw.attempt === "number" && Number.isFinite(raw.attempt) ? raw.attempt : 1,
  };
}

client.on("connected", () => {
  console.log(`[homerail_worker] connected to ${MANAGER_WS_URL}`);
});

client.on("disconnected", () => {
  console.log("[homerail_worker] disconnected, will reconnect...");
});

client.on("error", (err) => {
  console.error("[homerail_worker] ws error:", err);
});

client.on("task", async (msg) => {
  const data = msg.data ?? msg;
  const envelope = msg.envelope as Record<string, unknown> | undefined;

  // Prompt envelope from TS Manager: { type: "prompt", envelope: { runId, nodeId, ... } }
  const runId = envelope
    ? String(envelope.runId ?? "")
    : String(data.run_id ?? process.env.HOMERAIL_RUN_ID ?? "");
  const nodeId = envelope
    ? String(envelope.nodeId ?? "")
    : String((data.dag_config as Record<string, unknown>)?.node_id ?? (data.dagConfig as Record<string, unknown>)?.node_id ?? "");
  const sessionId = envelope && typeof envelope.sessionId === "string" && envelope.sessionId.trim()
    ? envelope.sessionId.trim()
    : undefined;
  const agentConfig = (envelope?.agentConfig ?? {}) as Record<string, unknown>;
  const llmConfig = (agentConfig.llm ?? {}) as Record<string, unknown>;
  const agentType = String(agentConfig.agent_type ?? "claude");
  const provider = String(llmConfig.provider ?? "");
  const model = String(llmConfig.model ?? agentConfig.model ?? "");
  const apiKey = typeof llmConfig.api_key === "string" ? llmConfig.api_key : undefined;
  const baseUrl = typeof llmConfig.base_url === "string" ? llmConfig.base_url : undefined;
  const protocol = typeof llmConfig.protocol === "string" ? llmConfig.protocol : undefined;
  const backend = resolveWorkerAgentBackend({
    agentType,
    envBackend: process.env.AGENT_BACKEND,
    hasManagerEnvelope: Boolean(envelope),
  });
  const checkpointResume = envelope ? parseCheckpointResume(envelope.checkpointResume) : undefined;
  const actorCheckpoint = envelope?.actorCheckpoint && typeof envelope.actorCheckpoint === "object"
    ? envelope.actorCheckpoint as DagActorCheckpointV1
    : undefined;
  const activity = envelope?.activity && typeof envelope.activity === "object"
    ? envelope.activity as Record<string, unknown>
    : undefined;

  // Task text: prefer envelope.inputs (flattened), then data.task/prompt
  let task: string;
  if (envelope) {
    const allContent = envelopeInputsToTaskText(envelope.inputs);
    task = allContent || String(agentConfig.system ?? "");
  } else {
    task = String(data.task ?? data.prompt ?? "");
  }

  const sender = String(data.sender ?? "");
  const dagConfig: DagNodeConfig = envelope
    ? {
        node_id: nodeId,
        agent_type: agentType,
        model,
        outgoing_edges: ((envelope.outgoingEdges ?? []) as Array<Record<string, unknown>>).map((e) => ({
          from_port: String(e.from_port ?? ""),
          to_node: String(e.to_node ?? ""),
          to_port: String(e.to_port ?? ""),
        })),
        incoming_edges: [],
        graph_nodes: [nodeId],
        session_id: sessionId,
        round_id: typeof activity?.roundId === "string" ? activity.roundId : undefined,
        actor_id: typeof activity?.actorId === "string" ? activity.actorId : undefined,
        generation: typeof activity?.generation === "number" ? activity.generation : undefined,
        lease_generation: typeof activity?.leaseGeneration === "number" ? activity.leaseGeneration : undefined,
        command_id: typeof activity?.commandId === "string" ? activity.commandId : undefined,
        surface_id: typeof activity?.surfaceId === "string" ? activity.surfaceId : undefined,
        activity_sequence_start: typeof activity?.sequenceStart === "number" ? activity.sequenceStart : 0,
        advisors: Array.isArray(envelope.advisors) ? envelope.advisors as DagAdvisorConfig[] : undefined,
        workspace_access: envelope.workspaceAccess && typeof envelope.workspaceAccess === "object"
          ? envelope.workspaceAccess as unknown as DagWorkspaceAccess
          : undefined,
        allowed_builtin_tools: Array.isArray(envelope.allowedBuiltinTools)
          ? envelope.allowedBuiltinTools as AgentBuiltinToolName[]
          : undefined,
        allowed_dag_tools: Array.isArray(envelope.allowedDagTools)
          ? envelope.allowedDagTools as DagAgentToolName[]
          : undefined,
      }
    : (data.dag_config ?? data.dagConfig ?? {}) as DagNodeConfig;
  const systemPrompt = envelope
    ? (agentConfig.system as string | undefined)
    : (data.system_prompt as string | undefined);

  if (!task) {
    console.error("[homerail_worker] received task with empty body");
    return;
  }

  console.log(
    `[homerail_worker] task received: run=${runId} node=${dagConfig.node_id} backend=${backend} agent_type=${agentType} provider=${provider || "<unset>"} model=${model || "<unset>"}`,
  );

  const job: PromptJob = {
    task,
    sender,
    runId,
    dagConfig,
    systemPrompt,
    llmProvider: provider,
    llmProtocol: protocol,
    llmApiKey: apiKey,
    llmBaseUrl: baseUrl,
    checkpointResume,
    actorCheckpoint,
  };

  const abortController = new AbortController();
  activePrompt = { runId, nodeId: dagConfig.node_id, abortController };
  const deferredTerminalMessages: string[] = [];

  try {
    await runPrompt(job, {
      wsSend: (d) => client.send(d),
      onTerminalMessage: (data) => deferredTerminalMessages.push(data),
      agentBackend: backend,
      abortSignal: abortController.signal,
      registerInboxHandler: (handler) => {
        if (activePrompt?.abortController === abortController) {
          activePrompt.deliverInbox = handler;
        }
        return () => {
          if (activePrompt?.abortController === abortController) {
            delete activePrompt.deliverInbox;
          }
        };
      },
    });
  } catch (err) {
    console.error("[homerail_worker] prompt runner error:", err);
  } finally {
    if (activePrompt?.abortController === abortController) {
      activePrompt = null;
    }
  }
  // Manager validation or correction may target this same worker. Send
  // terminal handoffs/errors only after the prompt releases active state.
  for (const data of deferredTerminalMessages) {
    client.send(data);
  }
});

client.on("inject", (msg) => {
  const data = msg.data ?? msg;
  const runId = String(data.runId ?? "");
  const nodeId = String(data.nodeId ?? "");
  const mode = String(data.mode ?? "inbox");
  console.log("[homerail_worker] inject received:", JSON.stringify(data));
  if (
    mode === "interrupt" &&
    activePrompt &&
    activePrompt.runId === runId &&
    activePrompt.nodeId === nodeId
  ) {
    activePrompt.abortController.abort();
    client.send(
      JSON.stringify({
        type: "stream",
        data: {
          event: "agent_interrupted",
          run_id: runId,
          node_id: nodeId,
          reason: "manager inject interrupt",
        },
      }),
    );
  }
});

client.on("dag_inbox", (msg) => {
  const data = (msg.data ?? msg) as Record<string, unknown>;
  const runId = stringField(data, "runId", "run_id");
  const nodeId = stringField(data, "toNode", "to_node", "nodeId", "node_id");
  if (
    activePrompt &&
    activePrompt.runId === runId &&
    activePrompt.nodeId === nodeId &&
    activePrompt.deliverInbox
  ) {
    activePrompt.deliverInbox(data);
    return;
  }
  console.log("[homerail_worker] dag_inbox dropped:", JSON.stringify(data));
});

// ── Graceful shutdown ────────────────────────────────────────

function shutdown() {
  console.log("[homerail_worker] shutting down...");
  client.close();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

// ── Start ────────────────────────────────────────────────────

console.log(`[homerail_worker] starting: worker_id=${WORKER_ID} capabilities=${CAPABILITIES.join(",") || "-"}`);
client.connect();
}
