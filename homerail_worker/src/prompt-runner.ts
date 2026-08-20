/**
 * Prompt runner — receives a task via WS, runs the agent with DAG tools,
 * streams events back, and handles graceful shutdown.
 * @version 0.1.0
 */

import { randomUUID } from "node:crypto";
import {
  CODEX_RESPONSES_PROTOCOL,
  DEFAULT_MANAGER_AGENT_RUNTIME_AGENT_TYPE,
  normalizeManagerAgentRuntimeAgentType,
  validateDagActorSurfaceMediaV1,
  classifyReviewFailure,
  sanitizeAttemptDiagnostic,
  type DagActorCheckpointV1,
  type DagAdvisorConfig,
  type DagCredentialBrokerCallRequest,
  type DagCredentialBrokerCallResult,
  type DagCredentialProjection,
  type DagNodeConfig,
  type DagWorkspaceAccess,
  type DagWorkerSkillContextSummaryV1,
  type DagWorkerSkillVisualDataContractV1,
  type AttemptDiagnosticV1,
  type ReviewFailureCategory,
} from "homerail-protocol";
import { createAgentClient } from "./agent/factory.js";
import { supportsDeepSeekHarnessReadTools } from "./agent/deepseek-harness-read-tools.js";
import type {
  AgentEvent,
  AgentRunContext,
  AgentSkillProjection,
  AgentUsage,
} from "./agent/types.js";
import type { AgentTurnController } from "./agent/turn-controller.js";
import { createDagTools, createDagToolsState, deliverInbox } from "./dag-tools/index.js";
import type { DagToolsState } from "./dag-tools/index.js";
import { createAuditWriters } from "./audit/index.js";
import type { AuditWriters } from "./audit/index.js";
import {
  createClaudeSdkTraceWriter,
  type ClaudeSdkTraceWriter,
} from "./audit/claude-sdk-trace-writer.js";
import { appendTranscriptEntry, redactAgentContext, saveSession } from "./session/session-store.js";
import { redactTelemetry } from "./telemetry-redaction.js";
import { snapshotWorkspace, verifyWorkspacePolicy, type WorkspaceSnapshot } from "./workspace-policy.js";
import { materializeTrustedWorkspaceDependencies } from "./workspace-dependencies.js";
import { completedActivityPayloadForHandoff, createDagActivityEmitter } from "./dag-activity.js";
import {
  REPORT_SURFACE_STATE_PROMPT,
  REPORT_SURFACE_STATE_TOOL_NAME,
  type PinnedSurfaceViewRegistry,
} from "./dag-tools/report-surface-state.js";
import {
  createSurfaceMediaPublisher,
  type SurfaceMediaDownloader,
} from "./dag-tools/surface-media.js";
import {
  containsCredentialValue,
  redactCredentialValues,
} from "./credential-projection.js";

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
  llmAnthropicAuthMode?: "api_key" | "auth_token";
  checkpointResume?: {
    parentSessionId?: string;
    entryUuid?: string;
    instruction: string;
    attempt: number;
  };
  actorCheckpoint?: DagActorCheckpointV1;
  skillContextSummary?: DagWorkerSkillContextSummaryV1;
  skillProjection?: AgentSkillProjection;
  pinnedSurfaceViews?: PinnedSurfaceViewRegistry;
  pinnedSurfaceDataContracts?: ReadonlyMap<string, DagWorkerSkillVisualDataContractV1>;
  /** Manager-dispatched structured inputs retained outside the model prompt. */
  trustedInputs?: Readonly<Record<string, unknown[]>>;
  credentialEnv?: Readonly<Record<string, string>>;
  credentialRedactionValues?: readonly string[];
  credentialBrokerBindings?: ReadonlyArray<
    Extract<DagCredentialProjection, { mode: "manager_broker" }>
  >;
}

export interface PromptRunnerDeps {
  wsSend: (data: string) => void;
  onTerminalMessage?: (data: string) => void;
  agentBackend?: string;
  auditDir?: string;
  abortSignal?: AbortSignal;
  turnController?: AgentTurnController;
  registerInboxHandler?: (handler: (content: unknown) => void) => () => void;
  surfaceMediaDownloader?: SurfaceMediaDownloader;
  credentialBrokerCall?: (
    request: DagCredentialBrokerCallRequest,
  ) => Promise<DagCredentialBrokerCallResult>;
}

export type PromptRunResult =
  | { status: "completed" }
  | { status: "failed"; reason: string };

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
  if (backend === "codex_appserver" && protocol !== CODEX_RESPONSES_PROTOCOL) {
    throw new Error(
      "Codex app-server requires a Responses-compatible endpoint; Chat Completions and Anthropic protocols are not valid Codex wire transports.",
    );
  }
  if (backend === "deepseek_harness" && protocol !== "openai_compatible") {
    throw new Error(
      "DeepSeek Harness requires an OpenAI-compatible Chat Completions endpoint.",
    );
  }
}

function assertBuiltinToolPolicySupported(
  agentBackend: string | undefined,
  allowedTools: unknown,
  builtinToolPolicy: unknown,
  workspaceAccess: unknown,
): void {
  const backend = normalizeManagerAgentRuntimeAgentType(
    agentBackend ?? process.env.AGENT_BACKEND ?? "claude-sdk",
  );
  if (builtinToolPolicy !== undefined) {
    if (builtinToolPolicy !== "backend_native") {
      throw new Error(`unsupported builtin_tool_policy '${String(builtinToolPolicy)}'`);
    }
    if (allowedTools !== undefined) {
      throw new Error("builtin_tool_policy is mutually exclusive with allowed_builtin_tools");
    }
    if (backend !== "codex_appserver") {
      throw new Error(`builtin_tool_policy 'backend_native' is not supported by agent backend '${backend ?? "unknown"}'`);
    }
    if (!workspaceAccess || typeof workspaceAccess !== "object" || Array.isArray(workspaceAccess)) {
      throw new Error("builtin_tool_policy 'backend_native' requires workspace_access");
    }
    return;
  }
  if (allowedTools === undefined) return;
  if (backend === "claude-sdk" || backend === "deterministic") return;
  if (backend === "deepseek_harness") {
    if (!Array.isArray(allowedTools) || !allowedTools.every((tool) => typeof tool === "string")) {
      throw new Error("DeepSeek Harness allowed_builtin_tools must be an array");
    }
    if (!supportsDeepSeekHarnessReadTools(allowedTools)) {
      throw new Error("DeepSeek Harness only enforces the read-only built-in tools Read, Grep, Glob, and LS");
    }
    if (allowedTools.length > 0 && (!workspaceAccess || typeof workspaceAccess !== "object" || Array.isArray(workspaceAccess))) {
      throw new Error("DeepSeek Harness read-only built-in tools require workspace_access");
    }
    return;
  }
  throw new Error(
    `allowed_builtin_tools is not enforced by agent backend '${backend ?? "unknown"}'`,
  );
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
): Promise<PromptRunResult> {
  const { wsSend: rawWsSend, agentBackend, auditDir } = deps;
  const credentialRedactionValues = job.credentialRedactionValues ?? [];
  const redactForTurn = (value: unknown): unknown => redactCredentialValues(
    redactTelemetry(value),
    credentialRedactionValues,
  );
  const wsSend = (data: string): void => {
    rawWsSend(String(redactCredentialValues(data, credentialRedactionValues)));
  };
  const sessionId = job.dagConfig.session_id ?? job.runId;
  const effectiveTask = job.actorCheckpoint
    ? [
        "## HomeRail portable actor checkpoint",
        "Continue the same logical actor and objective from this durable checkpoint.",
        "Treat only recorded conclusions as confirmed. This contains no hidden reasoning or provider session state.",
        JSON.stringify(job.actorCheckpoint),
        "## Current round input",
        job.task,
      ].join("\n")
    : job.task;

  function appendSessionTranscript(type: string, content?: unknown, metadata?: Record<string, unknown>): void {
    try {
      appendTranscriptEntry({
        type,
        runId: job.runId,
        nodeId: job.dagConfig.node_id,
        sessionId,
        timestamp: Date.now(),
        content: redactForTurn(content),
        metadata: redactForTurn(metadata) as Record<string, unknown> | undefined,
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
      messages: [{ role: "user", content: effectiveTask }],
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
  const correctionOnly = /(?:^|\n)## input:correction(?:\r?\n|$)/.test(job.task);
  const correctionRepairsWorkspaceEvidence = correctionOnly
    && job.task.includes("DAG_HANDOFF_WORKSPACE_FILE_REQUIREMENT");
  const workspacePolicy: DagWorkspaceAccess | undefined = correctionRepairsWorkspaceEvidence
    && dagState.workspaceAccess
    ? {
        ...dagState.workspaceAccess,
        writable_paths: dagState.workspaceAccess.writable_paths.map((root) => (
          root === "." ? ".homerail" : `${root.replace(/\/$/, "")}/.homerail`
        )),
      }
    : dagState.workspaceAccess;
  const activityEmitter = createDagActivityEmitter(job.dagConfig, job.runId, (activity) => {
    sendStream({ event: "dag_activity", activity });
  });
  const allowedDagTools = job.dagConfig.allowed_dag_tools === undefined
    ? undefined
    : new Set<string>(job.dagConfig.allowed_dag_tools);
  const surfacePatchAllowed = allowedDagTools?.has(REPORT_SURFACE_STATE_TOOL_NAME) === true;
  const surfaceMediaPublisher = surfacePatchAllowed
    ? createSurfaceMediaPublisher(dagState, (media) => sendStream({
        event: "dag_actor_surface_media",
        media,
      }), deps.surfaceMediaDownloader)
    : undefined;
  const allDagTools = createDagTools(dagState, {
    advisorRunner: (advisor, question) => runAdvisorCall(advisor, question, workspace, deps.abortSignal),
    activityEmitter: (type, payload) => activityEmitter.emit(type, payload),
    trustedInputs: job.trustedInputs,
    credentialBrokerBindings: job.credentialBrokerBindings,
    credentialBrokerCaller: deps.credentialBrokerCall,
    ...(surfacePatchAllowed
      ? {
          surfacePatchEmitter: ({ surface_id, patch }) => sendStream({
            event: "dag_actor_surface_patch",
            surface_id,
            patch,
          }),
          surfaceMediaPublisher,
          pinnedSurfaceViews: job.pinnedSurfaceViews,
          pinnedSurfaceDataContracts: job.pinnedSurfaceDataContracts,
        }
      : {}),
  });
  const selectedDagTools = allowedDagTools === undefined
    ? allDagTools
    : allDagTools.filter((tool) => allowedDagTools.has(tool.name));
  const correctionAllowsBrokerVerification = allowedDagTools?.has("credential_broker_call") === true
    && selectedDagTools.some((tool) => tool.name === "credential_broker_call");
  const dagTools = correctionOnly
    ? selectedDagTools.filter((tool) => (
        tool.name === "handoff"
        || (correctionAllowsBrokerVerification && tool.name === "credential_broker_call")
      ))
    : selectedDagTools;
  const ordinarySystemPrompt = surfacePatchAllowed
    ? [job.systemPrompt?.trim(), REPORT_SURFACE_STATE_PROMPT].filter(Boolean).join("\n\n")
    : job.systemPrompt;
  const effectiveSystemPrompt = correctionOnly
    ? [
        "DAG CONTRACT CORRECTION MODE.",
        "The previous turn did not produce a contract-valid handoff.",
        `The active DAG run_id is ${job.runId}. Copy it exactly when the output contract requires it.`,
        correctionRepairsWorkspaceEvidence
          ? "You may inspect and rewrite only the declared .homerail workspace evidence JSON, compute its SHA-256, reuse durable broker receipts, and then call handoff exactly once. Do not modify source files, rerun tests, or repeat external side effects."
          : correctionAllowsBrokerVerification
            ? "Your only permitted actions are declared credential broker verification calls followed by exactly one handoff tool call."
            : "Your only permitted action is one call to the handoff tool.",
        "Do not emit prose or tool-like markup. Do not call, describe, or simulate any non-permitted tool.",
        "Use the correction message and original inputs to preserve completed work and satisfy the exact output schema.",
        "The original node instructions follow only for output schema and evidence context:",
        job.systemPrompt ?? "",
      ].join("\n")
    : ordinarySystemPrompt;
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
  let claudeSdkTrace: ClaudeSdkTraceWriter | null = null;
  const effectiveAgentBackend = normalizeManagerAgentRuntimeAgentType(
    agentBackend ?? process.env.AGENT_BACKEND ?? DEFAULT_MANAGER_AGENT_RUNTIME_AGENT_TYPE,
  ) ?? DEFAULT_MANAGER_AGENT_RUNTIME_AGENT_TYPE;
  if (effectiveAgentBackend === "claude-sdk") {
    try {
      claudeSdkTrace = createClaudeSdkTraceWriter(job.runId, job.dagConfig.node_id, {
        baseDir: auditDir,
        redact: redactForTurn,
      });
    } catch {
      // The trace is durable observability, not part of the scheduling path.
      // Failure to open it must not prevent the agent turn from running.
    }
  }

  // Write initial transcript entry
  audit?.transcript.write({
    event: "prompt_start",
    node_id: job.dagConfig.node_id,
    run_id: job.runId,
    sender: job.sender,
    task_preview: effectiveTask.slice(0, 500),
    ...(job.skillContextSummary ? { skill_context: job.skillContextSummary } : {}),
  });
  appendSessionTranscript(
    "prompt_start",
    { task_preview: effectiveTask.slice(0, 500) },
    job.skillContextSummary ? { skill_context: job.skillContextSummary } : undefined,
  );

  // Stream content via WS
  function sendContent(text: string) {
    const redactedText = String(redactForTurn(text));
    wsSend(
      JSON.stringify({
        type: "content",
        data: {
          text: redactedText,
          run_id: job.runId,
          node_id: job.dagConfig.node_id,
          session_id: job.dagConfig.session_id ?? job.runId,
          ...(job.dagConfig.round_id !== undefined ? { round_id: job.dagConfig.round_id } : {}),
          ...(job.dagConfig.actor_id !== undefined ? { actor_id: job.dagConfig.actor_id } : {}),
          ...(job.dagConfig.generation !== undefined ? { generation: job.dagConfig.generation } : {}),
          ...(job.dagConfig.lease_generation !== undefined ? { lease_generation: job.dagConfig.lease_generation } : {}),
          ...(job.dagConfig.command_id !== undefined ? { command_id: job.dagConfig.command_id } : {}),
        },
      }),
    );
  }

  function sendStream(data: Record<string, unknown>) {
    let redactedData: Record<string, unknown>;
    if (data.event === "dag_actor_surface_media") {
      const validation = validateDagActorSurfaceMediaV1(data.media);
      if (!validation.valid) {
        throw new Error(`invalid Actor surface media stream: ${validation.errors[0]?.message ?? "validation failed"}`);
      }
      redactedData = { event: "dag_actor_surface_media", media: data.media };
    } else {
      redactedData = redactForTurn(data) as Record<string, unknown>;
    }
    wsSend(
      JSON.stringify({
        type: "stream",
        data: {
          type: typeof redactedData.event === "string" ? redactedData.event : "stream",
          ...redactedData,
          run_id: job.runId,
          node_id: job.dagConfig.node_id,
          session_id: job.dagConfig.session_id ?? job.runId,
          ...(job.dagConfig.round_id !== undefined ? { round_id: job.dagConfig.round_id } : {}),
          ...(job.dagConfig.actor_id !== undefined ? { actor_id: job.dagConfig.actor_id } : {}),
          ...(job.dagConfig.generation !== undefined ? { generation: job.dagConfig.generation } : {}),
          ...(job.dagConfig.lease_generation !== undefined ? { lease_generation: job.dagConfig.lease_generation } : {}),
          ...(job.dagConfig.command_id !== undefined ? { command_id: job.dagConfig.command_id } : {}),
        },
      }),
    );
  }

  // Declared outside try so emitUsage() (a closure defined after the
  // try/catch) and the catch handler can read them even on early failure.
  const nodeUsage: AgentUsage = {};
  const usageExecutionId = randomUUID();
  let nodeDurationMs: number | undefined;
  let nodeNumTurns: number | undefined;
  let nodeFinishReason: string | null = null;
  let nodeOutputTokenLimit: number | null = null;
  let lastUsageEmission: string | undefined;
  let workspaceBefore: WorkspaceSnapshot | undefined;
  let terminalActivityEmitted = false;
  let promptResult: PromptRunResult = {
    status: "failed",
    reason: "agent turn ended without a successful DAG handoff",
  };
  const toolNamesById = new Map<string, string>();
  let lastReasoningActivityAt = 0;

  function buildAttemptDiagnostics(
    failureCategory: ReviewFailureCategory,
  ): AttemptDiagnosticV1 | undefined {
    return sanitizeAttemptDiagnostic({
      schema: "attempt-diagnostic-v1",
      finish_reason: nodeFinishReason,
      output_tokens: nodeUsage.output_tokens,
      output_token_limit: nodeOutputTokenLimit,
      tool_argument_parse_state: dagState.toolArgumentParseState,
      contract_stage: dagState.contractStage,
      failure_category: failureCategory,
    }) ?? undefined;
  }

  activityEmitter.emit("started", {
    session_id: job.dagConfig.session_id ?? job.runId,
    sender: job.sender,
  });

  try {
    if (workspacePolicy) {
      workspaceBefore = snapshotWorkspace(workspace, workspacePolicy);
      sendStream({
        event: "workspace_policy_snapshot",
        before_file_count: Object.keys(workspaceBefore.files).length,
        readonly_paths: workspacePolicy.readonly_paths ?? [],
        writable_paths: workspacePolicy.writable_paths,
      });
    }
    assertAgentRuntimeProtocol(agentBackend, job.llmProtocol);
    assertBuiltinToolPolicySupported(
      agentBackend,
      job.dagConfig.allowed_builtin_tools,
      job.dagConfig.builtin_tool_policy,
      job.dagConfig.workspace_access,
    );
    const dependencyProjection = effectiveAgentBackend === "codex_appserver" && !correctionOnly
      ? materializeTrustedWorkspaceDependencies(workspace, dagState.workspaceAccess)
      : { projected: [], already_present: [], skipped: [] };
    const readyDependencyPackages = [
      ...dependencyProjection.projected,
      ...dependencyProjection.already_present,
    ];
    if (readyDependencyPackages.length > 0 || dependencyProjection.skipped.length > 0) {
      sendStream({
        event: "workspace_dependency_projection",
        projected: dependencyProjection.projected,
        already_present: dependencyProjection.already_present,
        skipped: dependencyProjection.skipped,
      });
    }
    const dependencyPrompt = readyDependencyPackages.length > 0 || dependencyProjection.skipped.length > 0
      ? [
          readyDependencyPackages.length > 0
            ? `Trusted lockfile-matched node_modules are already projected for: ${readyDependencyPackages.join(", ")}. Run repository build, typecheck, and test commands directly. Do not run npm install or npm ci unless you intentionally changed package.json or package-lock.json.`
            : "No trusted node_modules projection is available for this worktree.",
          dependencyProjection.skipped.length > 0
            ? `No dependency projection was made for: ${dependencyProjection.skipped.map((entry) => `${entry.package} (${entry.reason})`).join(", ")}.`
            : "",
        ].filter(Boolean).join(" ")
      : undefined;
    const projectedSystemPrompt = [effectiveSystemPrompt, dependencyPrompt].filter(Boolean).join("\n\n") || undefined;
    const agent = createAgentClient(agentBackend);
    const context: AgentRunContext = {
      systemPrompt: projectedSystemPrompt,
      systemPromptMode: correctionOnly ? "replace" : "append",
      provider: job.llmProvider,
      protocol: job.llmProtocol,
      model: job.dagConfig.model,
      apiKey: job.llmApiKey ?? process.env.LLM_API_KEY ?? "",
      baseUrl: resolveAgentBaseUrl(job, agentBackend),
      reasoningEffort: job.dagConfig.reasoning_effort,
      reasoningEffortMap: job.dagConfig.reasoning_effort_map,
      codexSandbox: job.dagConfig.codex_sandbox,
      serviceTier: job.dagConfig.service_tier,
      anthropicAuthMode: job.llmAnthropicAuthMode,
      workspace,
      sessionId: job.dagConfig.session_id ?? job.runId,
      abortSignal: deps.abortSignal,
      turnController: deps.turnController,
      handoffOnly: correctionOnly && !correctionRepairsWorkspaceEvidence,
      allowedBuiltinTools: job.dagConfig.allowed_builtin_tools,
      maxBuiltinToolCalls: job.dagConfig.max_builtin_tool_calls,
      workspaceAccess: job.dagConfig.workspace_access,
      skillProjection: job.skillProjection,
      environmentVariables: job.credentialEnv,
      rawTraceSink: claudeSdkTrace ?? undefined,
    };
    try {
      saveSession({
        sessionId,
        runId: job.runId,
        nodeId: job.dagConfig.node_id,
        messages: [{ role: "user", content: effectiveTask }],
        toolCallState: { inFlight: false },
        agentConfig: redactAgentContext(context),
        timestamp: Date.now(),
      });
    } catch {
      // Best-effort.
    }
    let errorMessage: string | null = null;
    for await (const event of agent.run(effectiveTask, dagTools, context)) {
      switch (event.type) {
        case "text":
          sendContent(event.text);
          audit?.transcript.write({ event: "text", text: redactForTurn(event.text) });
          appendSessionTranscript("text", redactForTurn(event.text));
          break;
        case "thinking": {
          // Thinking content is deliberately neither streamed nor persisted.
          // A generic, throttled activity renews the actor lease while models
          // such as DeepSeek V4 Flash spend a long time reasoning.
          const now = Date.now();
          if (now - lastReasoningActivityAt >= 30_000) {
            activityEmitter.emit("progress", { message: "model reasoning" });
            lastReasoningActivityAt = now;
          }
          break;
        }
        case "debug": {
          const debugMessage = String(redactForTurn(event.message));
          const debugData = redactForTurn(event.data ?? {}) as Record<string, unknown>;
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
          toolNamesById.set(event.id, event.name);
          appendSessionTranscript("tool_use", undefined, {
            tool_name: event.name,
            tool_id: event.id,
            tool_input: redactForTurn(event.input),
          });
          sendStream({
            event: "tool_use",
            tool_name: event.name,
            tool_id: event.id,
            tool_input: redactForTurn(event.input),
          });
          if (event.name !== "report_activity" && event.name !== REPORT_SURFACE_STATE_TOOL_NAME) {
            activityEmitter.emit("tool_used", {
              phase: "started",
              tool_name: event.name,
              tool_id: event.id,
              input: event.input,
            });
          }
          audit?.toolEvents.write({
            event: "tool_use",
            tool_name: event.name,
            tool_id: event.id,
            input: redactForTurn(event.input),
            node_id: job.dagConfig.node_id,
            run_id: job.runId,
          });
          break;
        case "tool_result":
          appendSessionTranscript("tool_result", undefined, {
            tool_use_id: event.tool_use_id,
            is_error: event.is_error,
            result_preview: redactForTurn(event.content),
          });
          sendStream({
            event: "tool_result",
            tool_use_id: event.tool_use_id,
            is_error: event.is_error,
            result_preview: redactForTurn(event.content),
          });
          if (toolNamesById.get(event.tool_use_id) !== "report_activity"
            && toolNamesById.get(event.tool_use_id) !== REPORT_SURFACE_STATE_TOOL_NAME) {
            activityEmitter.emit("tool_used", {
              phase: "completed",
              tool_name: toolNamesById.get(event.tool_use_id) ?? "unknown",
              tool_id: event.tool_use_id,
              is_error: event.is_error === true,
              result_preview: String(redactForTurn(event.content)).slice(0, 4000),
            });
          }
          audit?.toolEvents.write({
            event: "tool_result",
            tool_use_id: event.tool_use_id,
            is_error: event.is_error,
            node_id: job.dagConfig.node_id,
            run_id: job.runId,
          });
          break;
        case "error":
          errorMessage = String(redactForTurn(event.message));
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
          if (event.finish_reason !== undefined) nodeFinishReason = event.finish_reason ?? null;
          if (event.output_token_limit !== undefined) {
            nodeOutputTokenLimit = event.output_token_limit ?? null;
          }
          emitUsage();
          break;
        case "done":
          if (event.usage) Object.assign(nodeUsage, event.usage);
          if (event.duration_ms !== undefined) nodeDurationMs = event.duration_ms;
          if (event.num_turns !== undefined) nodeNumTurns = event.num_turns;
          if (event.finish_reason !== undefined) nodeFinishReason = event.finish_reason ?? null;
          if (event.output_token_limit !== undefined) {
            nodeOutputTokenLimit = event.output_token_limit ?? null;
          }
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
      if (workspacePolicy && workspaceBefore) {
        const workspaceAfter = snapshotWorkspace(workspace, workspacePolicy);
        const policyResult = verifyWorkspacePolicy(workspaceBefore, workspaceAfter, workspacePolicy);
        sendStream({ event: "workspace_policy_verified", ...policyResult });
        workspaceValid = policyResult.valid;
        if (!workspaceValid) {
          dagState.yielded = false;
          sendNodeError(`DAG_WORKSPACE_POLICY_VIOLATION ${JSON.stringify(policyResult)}`);
        }
      }
      if (workspaceValid && dagState.handoffData
        && containsCredentialValue(dagState.handoffData, credentialRedactionValues)) {
        dagState.yielded = false;
        sendNodeError("DAG_CREDENTIAL_OUTPUT_REJECTED handoff reflected a turn-scoped credential");
        workspaceValid = false;
      }
      if (workspaceValid && dagState.handoffData) {
        const handoff = dagState.handoffData as Record<string, unknown>;
        const attemptDiagnostics = buildAttemptDiagnostics("accepted");
        activityEmitter.emit("completed", completedActivityPayloadForHandoff(handoff));
        terminalActivityEmitted = true;
        // This is the authoritative runtime payload, not telemetry. The
        // Manager applies it before writing redacted evidence copies.
        sendTerminalMessage(JSON.stringify({
          type: "response",
          session_id: dagState.sessionId,
          data: {
            ...handoff,
            ...(attemptDiagnostics ? { attempt_diagnostics: attemptDiagnostics } : {}),
          },
        }));
        promptResult = { status: "completed" };
      }
    }
  } catch (err) {
    const msg = String(redactForTurn(err instanceof Error ? err.message : String(err)));
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
        ...(job.dagConfig.round_id !== undefined ? { round_id: job.dagConfig.round_id } : {}),
        ...(job.dagConfig.actor_id !== undefined ? { actor_id: job.dagConfig.actor_id } : {}),
        ...(job.dagConfig.generation !== undefined ? { generation: job.dagConfig.generation } : {}),
        ...(job.dagConfig.lease_generation !== undefined ? { lease_generation: job.dagConfig.lease_generation } : {}),
        ...(job.dagConfig.command_id !== undefined ? { command_id: job.dagConfig.command_id } : {}),
      },
    }),
  );

  // Close audit writers
  await Promise.allSettled([
    ...(audit ? [audit.transcript.close(), audit.toolEvents.close()] : []),
    ...(claudeSdkTrace ? [claudeSdkTrace.close()] : []),
  ]);

  function sendNodeError(message: string) {
    const redactedMessage = String(redactForTurn(message));
    promptResult = { status: "failed", reason: redactedMessage };
    if (!terminalActivityEmitted) {
      activityEmitter.emit("failed", { message: redactedMessage });
      terminalActivityEmitted = true;
    }
    const data = {
      runId: job.runId,
      nodeId: job.dagConfig.node_id,
      message: redactedMessage,
      session_id: job.dagConfig.session_id ?? job.runId,
      attempt_diagnostics: buildAttemptDiagnostics(classifyReviewFailure(redactedMessage)),
      ...(job.dagConfig.round_id !== undefined ? { round_id: job.dagConfig.round_id } : {}),
      ...(job.dagConfig.actor_id !== undefined ? { actor_id: job.dagConfig.actor_id } : {}),
      ...(job.dagConfig.generation !== undefined ? { generation: job.dagConfig.generation } : {}),
      ...(job.dagConfig.lease_generation !== undefined ? { lease_generation: job.dagConfig.lease_generation } : {}),
      ...(job.dagConfig.command_id !== undefined ? { command_id: job.dagConfig.command_id } : {}),
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
    const usage = {
      input_tokens: nodeUsage.input_tokens ?? 0,
      output_tokens: nodeUsage.output_tokens ?? 0,
      cache_read_input_tokens: nodeUsage.cache_read_input_tokens ?? 0,
      cache_creation_input_tokens: nodeUsage.cache_creation_input_tokens ?? 0,
    };
    const signature = JSON.stringify({
      usage,
      duration_ms: nodeDurationMs,
      num_turns: nodeNumTurns,
      finish_reason: nodeFinishReason,
      output_token_limit: nodeOutputTokenLimit,
    });
    if (signature === lastUsageEmission) return;
    lastUsageEmission = signature;
    sendStream({
      event: "usage",
      execution_id: usageExecutionId,
      usage,
      duration_ms: nodeDurationMs,
      num_turns: nodeNumTurns,
      finish_reason: nodeFinishReason,
      output_token_limit: nodeOutputTokenLimit,
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

  return promptResult;
}

/** Expose deliverInbox for external callers (e.g., dag_inbox handler). */
export { deliverInbox, type DagToolsState };
