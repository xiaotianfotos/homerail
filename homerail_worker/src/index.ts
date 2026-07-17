/**
 * homerail_worker entry point — reads env vars, connects to Manager WS,
 * and dispatches tasks to PromptRunner.
 * @version 0.1.0
 */

import { WsClient } from "./ws-client.js";
import { runPrompt } from "./prompt-runner.js";
import type { PromptJob, PromptRunResult } from "./prompt-runner.js";
import {
  DAG_ACTOR_LIVE_COMMAND_CAPABILITY,
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
import {
  AgentTurnController,
  agentTurnControllerOptionsForBackend,
} from "./agent/turn-controller.js";
import { envelopeInputsToTaskText } from "./envelope-task.js";
import { envelopeActivityToDagConfig } from "./envelope-activity.js";
import {
  activePromptTransportIdentity,
  routeDagActorCommand,
  type ActivePromptLiveSteering,
} from "./live-steering.js";
import {
  createWorkerSkillVisualDataContractRegistry,
  createWorkerSkillVisualViewRegistry,
  prepareWorkerSkillContext,
} from "./worker-skill-context.js";
import { DAG_ACTOR_SURFACE_PATCH_V1_CAPABILITY } from "./dag-tools/report-surface-state.js";

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
  DAG_ACTOR_LIVE_COMMAND_CAPABILITY,
  DAG_TRANSPORT_FENCE_V1_CAPABILITY,
  DAG_TRANSPORT_FENCE_CAPABILITY,
  DAG_ACTOR_SURFACE_PATCH_V1_CAPABILITY,
]));
const configuredLiveSteerQueueSize = Number(process.env.HOMERAIL_LIVE_STEER_QUEUE_MAX ?? 32);
const LIVE_STEER_QUEUE_SIZE = Number.isSafeInteger(configuredLiveSteerQueueSize)
  && configuredLiveSteerQueueSize > 0
  ? configuredLiveSteerQueueSize
  : 32;

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
  | (ActivePromptLiveSteering & {
      abortController: AbortController;
      commandRoutes: Set<Promise<unknown>>;
      deliverInbox?: (content: unknown) => void;
    })
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
        ...envelopeActivityToDagConfig(activity),
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
  const systemPromptValue = envelope ? agentConfig.system : data.system_prompt;
  let preparedSkillContext;
  try {
    preparedSkillContext = prepareWorkerSkillContext({
      systemPrompt: systemPromptValue,
      declaredSkills: envelope ? agentConfig.skills : undefined,
      allowedSurfaceViews: envelope ? agentConfig.allowed_surface_views : undefined,
      skillContext: envelope?.skillContext,
      actorCheckpoint,
    });
  } catch (cause) {
    const message = `Worker Skill Context rejected: ${cause instanceof Error ? cause.message : String(cause)}`;
    console.error(`[homerail_worker] ${message}`);
    client.send(JSON.stringify({
      type: "node_error",
      data: {
        runId,
        nodeId,
        message,
        ...(sessionId ? { session_id: sessionId } : {}),
        ...(typeof activity?.roundId === "string" ? { round_id: activity.roundId } : {}),
        ...(typeof activity?.actorId === "string" ? { actor_id: activity.actorId } : {}),
        ...(typeof activity?.generation === "number" ? { generation: activity.generation } : {}),
        ...(typeof activity?.leaseGeneration === "number"
          ? { lease_generation: activity.leaseGeneration }
          : {}),
        ...(typeof activity?.commandId === "string" ? { command_id: activity.commandId } : {}),
      },
    }));
    return;
  }

  if (!task) {
    console.error("[homerail_worker] received task with empty body");
    return;
  }

  console.log(
    `[homerail_worker] task received: run=${runId} node=${dagConfig.node_id} backend=${backend} agent_type=${agentType} provider=${provider || "<unset>"} model=${model || "<unset>"}`,
  );

  const trustedInputs = structuredClone(envelope?.inputs ?? {}) as Record<string, unknown[]>;
  const job: PromptJob = {
    task,
    sender,
    runId,
    dagConfig,
    systemPrompt: preparedSkillContext.systemPrompt,
    llmProvider: provider,
    llmProtocol: protocol,
    llmApiKey: apiKey,
    llmBaseUrl: baseUrl,
    checkpointResume,
    actorCheckpoint,
    skillContextSummary: preparedSkillContext.summary,
    skillProjection: preparedSkillContext.skillProjection,
    pinnedSurfaceViews: createWorkerSkillVisualViewRegistry(
      preparedSkillContext.context,
      preparedSkillContext.allowedSurfaceViewIds,
    ),
    pinnedSurfaceDataContracts: createWorkerSkillVisualDataContractRegistry(
      preparedSkillContext.context,
      preparedSkillContext.allowedSurfaceViewIds,
    ),
    trustedInputs,
  };

  const abortController = new AbortController();
  const controllerOptions = agentTurnControllerOptionsForBackend(backend);
  const turnController = new AgentTurnController({
    ...controllerOptions,
    maxQueueSize: LIVE_STEER_QUEUE_SIZE,
    interruptFallback: () => abortController.abort(),
  });
  const commandRoutes = new Set<Promise<unknown>>();
  activePrompt = {
    identity: activePromptTransportIdentity({
      runId,
      nodeId: dagConfig.node_id,
      sessionId: dagConfig.session_id ?? runId,
      roundId: dagConfig.round_id ?? "",
      actorId: dagConfig.actor_id ?? "",
      generation: dagConfig.generation ?? 0,
      leaseGeneration: dagConfig.lease_generation ?? 0,
      commandId: dagConfig.command_id ?? "",
    }),
    controller: turnController,
    onCommandAccepted: (command) => {
      trustedInputs.command = [{
        command_id: command.command_id,
        round_id: command.round_id,
        actor_id: command.actor_id,
        payload: structuredClone(command.payload),
      }];
    },
    abortController,
    commandRoutes,
  };
  const deferredTerminalMessages: string[] = [];
  let promptResult: PromptRunResult = {
    status: "failed",
    reason: "prompt runner did not reach a successful handoff",
  };

  try {
    promptResult = await runPrompt(job, {
      wsSend: (d) => client.send(d),
      onTerminalMessage: (data) => deferredTerminalMessages.push(data),
      agentBackend: backend,
      abortSignal: abortController.signal,
      turnController,
      registerInboxHandler: (handler) => {
        if (activePrompt?.controller === turnController) {
          activePrompt.deliverInbox = handler;
        }
        return () => {
          if (activePrompt?.controller === turnController) {
            delete activePrompt.deliverInbox;
          }
        };
      },
    });
  } catch (err) {
    promptResult = {
      status: "failed",
      reason: err instanceof Error ? err.message : String(err),
    };
    console.error("[homerail_worker] prompt runner error:", err);
  } finally {
    const closeResult = await turnController.close({
      outcome: promptResult.status === "completed" ? "completed" : "failed",
      ...(promptResult.status === "failed" ? { reason: promptResult.reason } : {}),
    });
    if (closeResult.driverError) {
      console.error("[homerail_worker] agent turn driver close error:", closeResult.driverError);
    }
    await Promise.allSettled([...commandRoutes]);
    if (activePrompt?.controller === turnController) {
      activePrompt = null;
    }
  }
  // Manager validation or correction may target this same worker. Send
  // terminal handoffs/errors only after the prompt releases active state.
  for (const data of deferredTerminalMessages) {
    client.send(data);
  }
});

client.on("dag_actor_command", (msg) => {
  const prompt = activePrompt;
  const routing = routeDagActorCommand(msg, prompt, (data) => client.send(data));
  prompt?.commandRoutes.add(routing);
  void routing
    .then((result) => {
      if (!result.handled) {
        console.log("[homerail_worker] dag_actor_command ignored:", result.reason ?? "unrecognized message");
      }
    })
    .catch((err) => {
      console.error("[homerail_worker] dag_actor_command routing error:", err);
    })
    .finally(() => {
      prompt?.commandRoutes.delete(routing);
    });
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
    activePrompt.identity.runId === runId &&
    activePrompt.identity.nodeId === nodeId
  ) {
    const interruptedPrompt = activePrompt;
    void interruptedPrompt.controller.interrupt("manager inject interrupt").then((result) => {
      client.send(
        JSON.stringify({
          type: "stream",
          data: {
            event: result.status === "interrupted" ? "agent_interrupted" : "agent_interrupt_failed",
            run_id: runId,
            node_id: nodeId,
            reason: result.status === "interrupted" ? "manager inject interrupt" : result.reason,
          },
        }),
      );
    });
  }
});

client.on("dag_inbox", (msg) => {
  const data = (msg.data ?? msg) as Record<string, unknown>;
  const runId = stringField(data, "runId", "run_id");
  const nodeId = stringField(data, "toNode", "to_node", "nodeId", "node_id");
  if (
    activePrompt &&
    activePrompt.identity.runId === runId &&
    activePrompt.identity.nodeId === nodeId &&
    activePrompt.deliverInbox
  ) {
    activePrompt.deliverInbox(data);
    return;
  }
  console.log("[homerail_worker] dag_inbox dropped:", JSON.stringify(data));
});

// ── Graceful shutdown ────────────────────────────────────────

async function shutdown() {
  console.log("[homerail_worker] shutting down...");
  const prompt = activePrompt;
  if (prompt) {
    await prompt.controller.close({
      outcome: "failed",
      reason: "Worker shutting down",
    });
    await Promise.allSettled([...prompt.commandRoutes]);
  }
  client.close();
  process.exit(0);
}

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());

// ── Start ────────────────────────────────────────────────────

console.log(`[homerail_worker] starting: worker_id=${WORKER_ID} capabilities=${CAPABILITIES.join(",") || "-"}`);
client.connect();
}
