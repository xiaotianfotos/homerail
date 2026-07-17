import * as http from "node:http";
import type { ChangeOrchestrator } from "../orchestration/change-orchestrator.js";
import type { AppendNodeRequest } from "../orchestration/change-orchestrator.js";
import {
  appendMessage,
  createSession,
  loadMessages,
  loadSession,
} from "../persistence/agent-sessions.js";
import {
  resolveManagerAgentConfig,
} from "./manager-agent-runtime-config.js";
import type { HostShellManagerAgentOptions } from "./host-shell-manager-agent.js";
import {
  ensurePreferredManagerAgentConfig,
  type ManagerAgentConfigRoutesOptions,
} from "./manager-agent-config.js";
import { getSetting } from "../persistence/llm-settings.js";
import { ManagerAgentRuntimeError, runManagerAgentTurn } from "./manager-agent-runtime.js";
import { dagResourcesUnavailableForRun } from "./dag-resource-status.js";
import { fireDagEventTrigger } from "../runtime/dag-triggers.js";
import { updateDagState } from "../persistence/dag-runtime-primitives.js";
import { WorkflowRunAdmissionError } from "../persistence/dag-run-admission.js";
import {
  cleanupRunWorkspaces,
  setRunWorkspacePinned,
} from "../runtime/workspace-retention.js";
import {
  focusDagSupervisorActor,
  getDagSupervisionSnapshot,
} from "../runtime/dag-manager-supervisor.js";
import { DagActorInterventionConflictError } from "../persistence/dag-actor-interventions.js";
import { DagActorInterventionRuntimeError } from "../runtime/active-runs.js";
import { DagActorLiveCommandRuntimeError } from "../runtime/dag-actor-live-command-runtime.js";
import { DagActorLiveCommandConflictError } from "../persistence/dag-actor-live-commands.js";
import {
  canonicalManagerAgentToolCallName,
  normalizeManagerAgentOutcomeCapabilities,
} from "homerail-protocol";

interface BaseResponse {
  success: boolean;
  message: string;
  data?: unknown;
  error?: string;
}

function json(res: http.ServerResponse, status: number, body: BaseResponse) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function _badRequest(res: http.ServerResponse, message: string) {
  json(res, 400, { success: false, message, error: message });
}

function _forbidden(res: http.ServerResponse, message: string) {
  json(res, 403, { success: false, message, error: message });
}

function _notFound(res: http.ServerResponse, message: string) {
  json(res, 404, { success: false, message, error: message });
}

function _ok(res: http.ServerResponse, message: string, data?: unknown) {
  json(res, 200, { success: true, message, data });
}

function _unsupported(res: http.ServerResponse, message: string, data?: unknown) {
  json(res, 410, { success: false, message, error: message, data });
}

function _unavailable(res: http.ServerResponse, message: string, data?: unknown) {
  json(res, 503, { success: false, message, error: message, data });
}

function _created(res: http.ServerResponse, message: string, data: unknown) {
  json(res, 201, { success: true, message, data });
}

function _accepted(res: http.ServerResponse, message: string, data: unknown) {
  json(res, 202, { success: true, message, data });
}

function publicManagerAgentToolCalls(value: unknown): unknown[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return item;
    const call = item as Record<string, unknown>;
    const runtimeName = typeof call.name === "string" ? call.name : "";
    const name = canonicalManagerAgentToolCallName(runtimeName);
    return name && name !== runtimeName
      ? { ...call, name, runtime_name: runtimeName }
      : call;
  });
}

function _runCreationError(res: http.ServerResponse, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof WorkflowRunAdmissionError) {
    json(res, 409, {
      success: false,
      message,
      error: message,
      data: {
        reason: error.reason,
        workflow_id: error.workflowId,
        active_count: error.activeCount,
        policy: error.policy,
      },
    });
    return;
  }
  _badRequest(res, message);
}

export function isDagApprovalRequestAuthorized(input: {
  remoteAddress?: string;
  headerToken?: string;
  bodyToken?: unknown;
  configuredToken?: string;
}): boolean {
  return isDagMutationRequestAuthorized(input);
}

export function isDagMutationRequestAuthorized(input: {
  remoteAddress?: string;
  headerToken?: string;
  bodyToken?: unknown;
  configuredToken?: string;
}): boolean {
  const configuredToken = input.configuredToken?.trim();
  if (configuredToken) {
    const supplied = input.headerToken?.trim() || (typeof input.bodyToken === "string" ? input.bodyToken.trim() : "");
    return supplied.length > 0 && supplied === configuredToken;
  }
  const address = input.remoteAddress ?? "";
  return address === "::1" || address === "localhost" || address.startsWith("127.") || address.startsWith("::ffff:127.");
}

export function requiresDagMutationAuthorization(pathname: string, method?: string): boolean {
  if (method !== "POST") return false;
  if (/^\/api\/runs\/[^/]+\/node\/[^/]+\/approval$/.test(pathname)) return false;
  return pathname === "/api/runs"
    || pathname.startsWith("/api/runs/")
    || pathname === "/api/dag/workflows/sync"
    || pathname === "/api/dag/profiles/sync"
    || pathname === "/api/dag/workspaces/cleanup"
    || pathname === "/api/settings/workspace-retention";
}

async function _readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => { data += chunk; });
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

function _appendNodeRequestFromBody(body: Record<string, unknown>): AppendNodeRequest | undefined {
  const nodeId = typeof body.node_id === "string"
    ? body.node_id
    : typeof body.nodeId === "string"
      ? body.nodeId
      : undefined;
  if (!nodeId) return undefined;
  return {
    nodeId,
    agentId: typeof body.agent_id === "string" ? body.agent_id : undefined,
    agent: typeof body.agent === "object" && body.agent !== null ? body.agent as any : undefined,
    after: Array.isArray(body.after) ? body.after.filter((v): v is string => typeof v === "string") : undefined,
    outputs: typeof body.outputs === "object" && body.outputs !== null ? body.outputs as any : undefined,
    name: typeof body.name === "string" ? body.name : undefined,
    description: typeof body.description === "string" ? body.description : undefined,
    image: typeof body.image === "string" ? body.image : undefined,
    container_group: typeof body.container_group === "string" ? body.container_group : undefined,
  };
}

export function mutationRoutesHandler(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  changeOrchestrator: ChangeOrchestrator,
  managerAgentOptions?: HostShellManagerAgentOptions,
  managerAgentConfigOptions: ManagerAgentConfigRoutesOptions = {},
): boolean {
  const pathname = new URL(req.url || "/", "http://localhost").pathname;

  // POST /api/manager/chat
  if (pathname === "/api/manager/chat" && req.method === "POST") {
    _readJsonBody(req)
      .then(async (body) => {
        const b = body as Record<string, unknown>;
        const message = typeof b.message === "string" ? b.message.trim() : "";
        if (!message) {
          _badRequest(res, "Missing required field: message");
          return;
        }
        const projectId = typeof b.project_id === "string" ? b.project_id : undefined;
        const managerSettingId =
          typeof b.manager_setting_id === "string" && b.manager_setting_id.trim()
            ? b.manager_setting_id.trim()
            : typeof b.manager_llm_setting_id === "string" && b.manager_llm_setting_id.trim()
              ? b.manager_llm_setting_id.trim()
              : typeof b.llm_setting_id === "string" && b.llm_setting_id.trim()
                ? b.llm_setting_id.trim()
                : undefined;
        const managerProviderName = typeof b.manager_provider_name === "string" ? b.manager_provider_name.trim() : undefined;
        const managerModelName = typeof b.manager_model_name === "string" ? b.manager_model_name.trim() : undefined;
        const requiredToolCalls = Array.isArray(b.required_tool_calls)
          ? Array.from(new Set(b.required_tool_calls
            .map((item) => typeof item === "string" ? item.trim() : "")
            .filter(Boolean)))
          : [];
        const requiredOutcomes = normalizeManagerAgentOutcomeCapabilities(b.required_outcomes);
        let sessionId = typeof b.session_id === "string" && b.session_id.trim() ? b.session_id.trim() : undefined;
        let session = sessionId ? loadSession(sessionId) : undefined;
        const savedManagerConfig = await ensurePreferredManagerAgentConfig(managerAgentConfigOptions);
        const existingSettingId = typeof session?.metadata.manager_llm_setting_id === "string"
          ? session.metadata.manager_llm_setting_id
          : typeof session?.metadata.llm_setting_id === "string"
            ? session.metadata.llm_setting_id
            : undefined;
        const inheritedSetting = existingSettingId ? getSetting(existingSettingId) : undefined;
        const inheritedSettingId = inheritedSetting?.is_active ? existingSettingId : undefined;
        const existingProvider = typeof session?.metadata.manager_provider_name === "string"
          ? session.metadata.manager_provider_name
          : undefined;
        const existingModel = typeof session?.metadata.manager_model_name === "string"
          ? session.metadata.manager_model_name
          : undefined;
        const inheritedProvider = existingSettingId && !inheritedSettingId ? undefined : existingProvider;
        const inheritedModel = existingSettingId && !inheritedSettingId ? undefined : existingModel;
        const hasExplicitRuntime = Boolean(managerSettingId || managerProviderName || managerModelName);
        const requestedSettingId = managerSettingId || inheritedSettingId || (!hasExplicitRuntime ? savedManagerConfig.llm_setting_id ?? undefined : undefined);
        const requestedProvider = managerProviderName || inheritedProvider || (!requestedSettingId ? savedManagerConfig.provider_name ?? undefined : undefined);
        const requestedModel = managerModelName || inheritedModel || (!requestedSettingId ? savedManagerConfig.model_name ?? undefined : undefined);
        const agentConfig = resolveManagerAgentConfig(
          projectId,
          requestedProvider,
          requestedModel,
          requestedSettingId,
          savedManagerConfig.harness,
          savedManagerConfig.reasoning_effort,
          savedManagerConfig.service_tier,
        );
        const parentSessionId = session && (existingSettingId || existingProvider || existingModel) &&
          (existingSettingId !== requestedSettingId || existingProvider !== agentConfig.provider_name || existingModel !== agentConfig.model)
          ? session.session_id
          : undefined;
        if (parentSessionId) {
          sessionId = undefined;
          session = undefined;
        }
        if (!session) {
          session = createSession(sessionId, {
            project_id: projectId,
            source: "manager-chat",
            parent_session_id: parentSessionId,
            manager_llm_setting_id: requestedSettingId ?? null,
            manager_provider_name: agentConfig.provider_name,
            manager_model_name: agentConfig.model,
            manager_agent_config: {
              provider_name: agentConfig.provider_name,
              model: agentConfig.model,
              agent_type: agentConfig.agent_type,
              runtime_placement: agentConfig.runtime_placement,
              base_url: agentConfig.base_url,
            },
          }, projectId);
          sessionId = session.session_id;
        }
        const historyForAgent = loadMessages(sessionId!).slice(-24).map((item) => ({
          role: item.role,
          content: item.content,
          timestamp: item.timestamp,
        }));
        appendMessage(sessionId!, "user", message);
        let result: Record<string, unknown>;
        let workerId: string | null = null;
        try {
          const turn = await runManagerAgentTurn({
            message,
            project_id: projectId,
            session_id: sessionId,
            continue_chat: b.continue_chat !== false,
            history: historyForAgent,
            required_tool_calls: requiredToolCalls,
            required_outcomes: requiredOutcomes,
            agent_config: agentConfig,
          }, managerAgentOptions);
          result = turn.result;
          workerId = turn.worker_id;
        } catch (err) {
          const detail = err instanceof Error ? err.message : String(err);
          if (err instanceof ManagerAgentRuntimeError) {
            if (err.code === "manager_runtime_options_missing") {
              _unavailable(res, detail, err.data);
            } else if (err.code === "manager_runtime_start_error") {
              _unavailable(res, `Manager Agent 本机进程启动失败: ${detail}`, err.data);
            } else if (err.runtime_placement === "host") {
              _unavailable(res, `Host Codex Manager Agent 响应错误: ${detail}`, err.data);
            } else {
              _unavailable(res, `Manager Agent 响应错误: ${detail}`, err.data);
            }
          } else {
            _unavailable(res, `Manager Agent 响应错误: ${detail}`, { project_id: projectId });
          }
          return;
        }
        const reply = typeof result.text === "string" ? result.text : "";
        const runId = typeof result.run_id === "string" ? result.run_id : undefined;
        appendMessage(sessionId!, "assistant", reply, runId ? { run_id: runId } : undefined);
        _ok(res, "Manager Agent 响应成功", {
          text: reply,
          tool_calls: publicManagerAgentToolCalls(result.tool_calls),
          tool_results: Array.isArray(result.tool_results) ? result.tool_results : [],
          agent_errors: Array.isArray(result.agent_errors) ? result.agent_errors : [],
          objective: result.objective && typeof result.objective === "object" && !Array.isArray(result.objective)
            ? result.objective
            : null,
          run_id: runId,
          run_ids: Array.isArray(result.run_ids) ? result.run_ids : runId ? [runId] : [],
          session_id: sessionId,
          project_id: projectId,
          worker_id: workerId,
          runtime_placement: agentConfig.runtime_placement,
          manager_llm_setting_id: requestedSettingId ?? null,
          manager_provider_name: agentConfig.provider_name,
          manager_model_name: agentConfig.model,
          manager_agent_config: {
            llm_setting_id: requestedSettingId ?? null,
            provider_name: agentConfig.provider_name,
            model: agentConfig.model,
            agent_type: agentConfig.agent_type,
            runtime_placement: agentConfig.runtime_placement,
            base_url: agentConfig.base_url,
          },
          forked_from_session_id: parentSessionId,
          status: "ok",
        });
      })
      .catch((err) => {
        _badRequest(res, err instanceof Error ? err.message : "Invalid JSON body");
    });
    return true;
  }

  // POST /api/runs
  if (pathname === "/api/runs" && req.method === "POST") {
    _readJsonBody(req)
      .then((body) => {
        const b = body as Record<string, unknown>;
        const yamlPath = typeof b.yamlPath === "string" ? b.yamlPath : undefined;
        const workflowId = typeof b.workflow_id === "string" && b.workflow_id.trim()
          ? b.workflow_id.trim()
          : typeof b.workflowId === "string" && b.workflowId.trim()
            ? b.workflowId.trim()
            : undefined;
        if (!yamlPath && !workflowId) {
          _badRequest(res, "Missing required field: yamlPath or workflow_id");
          return;
        }
        const profile = typeof b.profile === "string" ? b.profile : undefined;
        const runId = typeof b.runId === "string" ? b.runId : undefined;
        const prompt = typeof b.prompt === "string" ? b.prompt : undefined;
        const llmSettingId = typeof b.llm_setting_id === "string" && b.llm_setting_id.trim() ? b.llm_setting_id.trim() : undefined;
        try {
          const result = changeOrchestrator.createRun({ yamlPath, workflowId, profile, runId, prompt, llmSettingId });
          _created(res, "Run created", result);
        } catch (err) {
          _runCreationError(res, err);
        }
      })
      .catch((err) => {
        _badRequest(res, err instanceof Error ? err.message : "Invalid JSON body");
      });
    return true;
  }

  // POST /api/runs/create-and-run (atomic create + invoke)
  if (pathname === "/api/runs/create-and-run" && req.method === "POST") {
    const unavailable = dagResourcesUnavailableForRun();
    if (unavailable) {
      _unavailable(res, unavailable.message, {
        code: unavailable.code,
        dag_resources: unavailable.status,
      });
      return true;
    }
    _readJsonBody(req)
      .then((body) => {
        const b = body as Record<string, unknown>;
        const yamlPath = typeof b.yamlPath === "string" ? b.yamlPath : undefined;
        const workflowId = typeof b.workflow_id === "string" && b.workflow_id.trim()
          ? b.workflow_id.trim()
          : typeof b.workflowId === "string" && b.workflowId.trim()
            ? b.workflowId.trim()
            : undefined;
        if (!yamlPath && !workflowId) {
          _badRequest(res, "Missing required field: yamlPath or workflow_id");
          return;
        }
        const profile = typeof b.profile === "string" ? b.profile : undefined;
        const runId = typeof b.runId === "string" ? b.runId : undefined;
        const prompt = typeof b.prompt === "string" ? b.prompt : undefined;
        const llmSettingId = typeof b.llm_setting_id === "string" && b.llm_setting_id.trim() ? b.llm_setting_id.trim() : undefined;
        try {
          const result = changeOrchestrator.createAndRun({ yamlPath, workflowId, profile, runId, prompt, llmSettingId });
          _created(res, "Run created and invoked", result);
        } catch (err) {
          _runCreationError(res, err);
        }
      })
      .catch((err) => {
        _badRequest(res, err instanceof Error ? err.message : "Invalid JSON body");
      });
    return true;
  }

  // POST /api/runs/emergency-stop (must be before parametric :run_id routes)
  if (pathname === "/api/runs/emergency-stop" && req.method === "POST") {
    try {
      const result = changeOrchestrator.emergencyStopAllRuns();
      _ok(res, `Emergency stop: ${result.stopped} run(s) cancelled`, result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      _badRequest(res, message);
    }
    return true;
  }

  // POST /api/runs/:run_id/invoke
  const invokeMatch = pathname.match(/^\/api\/runs\/([^/]+)\/invoke$/);
  if (invokeMatch && req.method === "POST") {
    const unavailable = dagResourcesUnavailableForRun();
    if (unavailable) {
      _unavailable(res, unavailable.message, {
        code: unavailable.code,
        dag_resources: unavailable.status,
      });
      return true;
    }
    const runId = decodeURIComponent(invokeMatch[1]);
    try {
      const result = changeOrchestrator.invokeRun(runId);
      _ok(res, "Run invoked", result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes("not found")) {
        _notFound(res, message);
      } else {
        _badRequest(res, message);
      }
    }
    return true;
  }

  // POST /api/runs/:run_id/supervision consumes a durable per-session cursor.
  const supervisionMatch = pathname.match(/^\/api\/runs\/([^/]+)\/supervision$/);
  if (supervisionMatch && req.method === "POST") {
    let runId = "";
    try {
      runId = decodeURIComponent(supervisionMatch[1]);
    } catch {
      _badRequest(res, "run_id is invalid");
      return true;
    }
    void _readJsonBody(req).then((raw) => {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("request body must be an object");
      const body = raw as Record<string, unknown>;
      const consumerId = typeof body.consumer_id === "string" ? body.consumer_id.trim() : "";
      if (!consumerId) throw new Error("consumer_id is required");
      if (body.max_milestones !== undefined && typeof body.max_milestones !== "number") {
        throw new Error("max_milestones must be a number");
      }
      const maxMilestones = body.max_milestones as number | undefined;
      const result = getDagSupervisionSnapshot({
        run_id: runId,
        consumer_id: consumerId,
        max_milestones: maxMilestones,
      });
      _ok(res, "DAG supervision snapshot retrieved", result);
    }).catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("not found")) _notFound(res, message);
      else if (message.includes("concurrently")) json(res, 409, { success: false, message, error: message });
      else _badRequest(res, message);
    });
    return true;
  }

  // POST /api/runs/:run_id/focus
  const focusMatch = pathname.match(/^\/api\/runs\/([^/]+)\/focus$/);
  if (focusMatch && req.method === "POST") {
    const runId = decodeURIComponent(focusMatch[1]);
    void _readJsonBody(req).then((raw) => {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("request body must be an object");
      const body = raw as Record<string, unknown>;
      const actorId = typeof body.actor_id === "string" ? body.actor_id.trim() : "";
      const idempotencyKey = typeof body.idempotency_key === "string" ? body.idempotency_key.trim() : "";
      if (!actorId) throw new Error("actor_id is required");
      if (!idempotencyKey) throw new Error("idempotency_key is required");
      const durationMs = body.duration_ms === undefined ? undefined : Number(body.duration_ms);
      const result = focusDagSupervisorActor({
        run_id: runId,
        actor_id: actorId,
        idempotency_key: idempotencyKey,
        duration_ms: durationMs,
      });
      _ok(res, "DAG actor surface focused", result);
    }).catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("Unknown DAG actor") || message.includes("no projected surface")) _notFound(res, message);
      else if (message.includes("conflict") || message.includes("reused with different input")) {
        json(res, 409, { success: false, message, error: message });
      } else _badRequest(res, message);
    });
    return true;
  }

  // POST /api/runs/:run_id/actors/:actor_id/interventions
  const actorInterventionMatch = pathname.match(/^\/api\/runs\/([^/]+)\/actors\/([^/]+)\/interventions$/);
  if (actorInterventionMatch && req.method === "POST") {
    const runId = decodeURIComponent(actorInterventionMatch[1]);
    const actorId = decodeURIComponent(actorInterventionMatch[2]);
    void _readJsonBody(req).then((raw) => {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("request body must be an object");
      const body = raw as Record<string, unknown>;
      const allowed = new Set([
        "operation",
        "instruction",
        "expected_state_token",
        "idempotency_key",
        "checkpoint_version",
      ]);
      const unknown = Object.keys(body).filter((key) => !allowed.has(key));
      if (unknown.length > 0) throw new Error(`unsupported intervention fields: ${unknown.sort().join(", ")}`);
      const operation = typeof body.operation === "string" ? body.operation.trim() : "";
      if (!["interrupt", "cancel", "retry", "reassign", "checkpoint_fork"].includes(operation)) {
        throw new Error("operation must be interrupt, cancel, retry, reassign, or checkpoint_fork");
      }
      const expectedStateToken = typeof body.expected_state_token === "string"
        ? body.expected_state_token.trim()
        : "";
      const idempotencyKey = typeof body.idempotency_key === "string" ? body.idempotency_key.trim() : "";
      if (!expectedStateToken) throw new Error("expected_state_token is required");
      if (!idempotencyKey) throw new Error("idempotency_key is required");
      if (body.instruction !== undefined && typeof body.instruction !== "string") {
        throw new Error("instruction must be a string when provided");
      }
      const instruction = body.instruction as string | undefined;
      let checkpointVersion: number | undefined;
      if (body.checkpoint_version !== undefined) {
        if (
          typeof body.checkpoint_version !== "number"
          || !Number.isSafeInteger(body.checkpoint_version)
          || body.checkpoint_version < 1
        ) {
          throw new Error("checkpoint_version must be a positive integer");
        }
        checkpointVersion = body.checkpoint_version;
      }
      const result = changeOrchestrator.interveneActor(runId, {
        actor_id: actorId,
        operation: operation as "interrupt" | "cancel" | "retry" | "reassign" | "checkpoint_fork",
        expected_state_token: expectedStateToken,
        idempotency_key: idempotencyKey,
        ...(instruction === undefined ? {} : { instruction }),
        ...(checkpointVersion === undefined ? {} : { checkpoint_version: checkpointVersion }),
      });
      if (result.deduplicated) _ok(res, "DAG Actor intervention already applied", result);
      else _accepted(res, "DAG Actor intervention applied", result);
    }).catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      if (
        (error instanceof DagActorInterventionRuntimeError
          && error.code === "actor_not_found")
        || message.includes("Unknown DAG actor")
        || message.includes("Run not found")
      ) {
        _notFound(res, message);
      } else if (
        error instanceof DagActorInterventionConflictError
        || error instanceof DagActorInterventionRuntimeError
        || message.includes("conflict")
        || message.includes("not active")
      ) {
        json(res, 409, { success: false, message, error: message });
      } else {
        _badRequest(res, message);
      }
    });
    return true;
  }

  // POST /api/runs/:run_id/cancel
  const cancelMatch = pathname.match(/^\/api\/runs\/([^/]+)\/cancel$/);
  if (cancelMatch && req.method === "POST") {
    const runId = decodeURIComponent(cancelMatch[1]);
    try {
      const result = changeOrchestrator.cancelRun(runId);
      _ok(res, "Run cancelled", { cancelled: result });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes("not found")) {
        _notFound(res, message);
      } else {
        _badRequest(res, message);
      }
    }
    return true;
  }

  // POST /api/runs/:run_id/complete
  const completeMatch = pathname.match(/^\/api\/runs\/([^/]+)\/complete$/);
  if (completeMatch && req.method === "POST") {
    const runId = decodeURIComponent(completeMatch[1]);
    void _readJsonBody(req).then((raw) => {
      const body = raw as Record<string, unknown>;
      const expectedRoundId = typeof body.expected_round_id === "string"
        ? body.expected_round_id.trim()
        : "";
      if (!expectedRoundId) throw new Error("expected_round_id is required");
      const result = changeOrchestrator.completeRun(runId, expectedRoundId);
      _ok(res, "Run completed", { completed: result });
    }).catch((err) => {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes("not found")) _notFound(res, message);
      else if (message.includes("not waiting") || message.includes("conflict")) {
        json(res, 409, { success: false, message, error: message });
      } else _badRequest(res, message);
    });
    return true;
  }

  // POST /api/runs/:run_id/commands
  const commandsMatch = pathname.match(/^\/api\/runs\/([^/]+)\/commands$/);
  if (commandsMatch && req.method === "POST") {
    const runId = decodeURIComponent(commandsMatch[1]);
    void _readJsonBody(req).then((raw) => {
      const body = raw as Record<string, unknown>;
      const expectedRoundId = typeof body.expected_round_id === "string"
        ? body.expected_round_id.trim()
        : undefined;
      if (!Array.isArray(body.commands) || body.commands.length < 1 || body.commands.length > 128) {
        throw new Error("commands must contain between 1 and 128 entries");
      }
      const commands = body.commands.map((rawCommand, index) => {
        if (!rawCommand || typeof rawCommand !== "object" || Array.isArray(rawCommand)) {
          throw new Error(`commands[${index}] must be an object`);
        }
        const command = rawCommand as Record<string, unknown>;
        const actorId = typeof command.actor_id === "string" ? command.actor_id.trim() : "";
        if (!actorId) throw new Error(`commands[${index}].actor_id is required`);
        if (!("payload" in command)) throw new Error(`commands[${index}].payload is required`);
        const commandId = typeof command.command_id === "string" ? command.command_id.trim() : undefined;
        const idempotencyKey = typeof command.idempotency_key === "string"
          ? command.idempotency_key.trim()
          : undefined;
        const expectedStateToken = typeof command.expected_state_token === "string"
          ? command.expected_state_token.trim()
          : undefined;
        if (expectedStateToken !== undefined && !/^[0-9a-f]{64}$/.test(expectedStateToken)) {
          throw new Error(`commands[${index}].expected_state_token must be a 64-character lowercase hex token`);
        }
        return {
          actor_id: actorId,
          payload: command.payload,
          ...(commandId ? { command_id: commandId } : {}),
          ...(idempotencyKey ? { idempotency_key: idempotencyKey } : {}),
          ...(expectedStateToken ? { expected_state_token: expectedStateToken } : {}),
        };
      });
      const result = changeOrchestrator.sendActorCommands(runId, {
        ...(expectedRoundId ? { expected_round_id: expectedRoundId } : {}),
        commands,
      });
      _ok(
        res,
        result.delivery_mode === "live" ? "Actor commands persisted" : "Waiting run resumed",
        result,
      );
    }).catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      if (
        (error instanceof DagActorLiveCommandRuntimeError && error.code === "actor_not_found")
        || message.includes("not found")
        || message.includes("Unknown DAG actor")
      ) _notFound(res, message);
      else if (
        error instanceof DagActorLiveCommandConflictError
        || (error instanceof DagActorLiveCommandRuntimeError
          && (error.code === "state_token_conflict" || error.code === "expected_round_conflict"))
        || message.includes("not waiting")
        || message.includes("conflict")
        || message.includes("terminal")
      ) {
        json(res, 409, { success: false, message, error: message });
      } else _badRequest(res, message);
    });
    return true;
  }

  const workspaceRetentionMatch = pathname.match(/^\/api\/runs\/([^/]+)\/workspace-retention$/);
  if (workspaceRetentionMatch && req.method === "POST") {
    const runId = decodeURIComponent(workspaceRetentionMatch[1]);
    void _readJsonBody(req).then((raw) => {
      const body = raw as Record<string, unknown>;
      if (typeof body.pinned !== "boolean") throw new Error("pinned must be a boolean");
      const retention = setRunWorkspacePinned(runId, body.pinned);
      _ok(res, body.pinned ? "Run workspace pinned" : "Run workspace unpinned", retention);
    }).catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("not found")) _notFound(res, message);
      else _badRequest(res, message);
    });
    return true;
  }

  if (pathname === "/api/dag/workspaces/cleanup" && req.method === "POST") {
    void _readJsonBody(req).then(async (raw) => {
      const body = raw as Record<string, unknown>;
      if (body.dry_run !== undefined && typeof body.dry_run !== "boolean") {
        throw new Error("dry_run must be a boolean");
      }
      const report = await cleanupRunWorkspaces({ dryRun: body.dry_run !== false });
      _ok(res, report.dry_run ? "Workspace cleanup preview completed" : "Workspace cleanup completed", report);
    }).catch((error) => _badRequest(res, error instanceof Error ? error.message : String(error)));
    return true;
  }

  const approvalMatch = pathname.match(/^\/api\/runs\/([^/]+)\/node\/([^/]+)\/approval$/);
  if (approvalMatch && req.method === "POST") {
    const runId = decodeURIComponent(approvalMatch[1]);
    const nodeId = decodeURIComponent(approvalMatch[2]);
    void _readJsonBody(req).then((raw) => {
      const body = raw as Record<string, unknown>;
      const headerToken = Array.isArray(req.headers["x-homerail-approval-token"])
        ? req.headers["x-homerail-approval-token"]?.[0]
        : req.headers["x-homerail-approval-token"];
      if (!isDagApprovalRequestAuthorized({
        remoteAddress: req.socket.remoteAddress,
        headerToken,
        bodyToken: body.authorization_token,
        configuredToken: process.env.HOMERAIL_DAG_APPROVAL_TOKEN,
      })) {
        _forbidden(res, "approval decisions require a local request or valid HOMERAIL_DAG_APPROVAL_TOKEN");
        return;
      }
      const decision = body.decision === "approved" || body.decision === "rejected" ? body.decision : undefined;
      const actor = typeof body.actor === "string" ? body.actor.trim() : "";
      const proposalHash = typeof body.proposal_hash === "string" ? body.proposal_hash.trim() : "";
      if (!decision || !actor || !proposalHash) throw new Error("decision, actor, and proposal_hash are required");
      const result = changeOrchestrator.decideApproval(runId, nodeId, { decision, actor, proposalHash });
      _ok(res, `Approval ${decision}`, result);
    }).catch((error) => _badRequest(res, error instanceof Error ? error.message : String(error)));
    return true;
  }

  const triggerEventMatch = pathname.match(/^\/api\/dag\/triggers\/events\/([^/]+)$/);
  if (triggerEventMatch && req.method === "POST") {
    void _readJsonBody(req).then((raw) => {
      const body = raw as Record<string, unknown>;
      const headerToken = Array.isArray(req.headers["x-homerail-dag-token"])
        ? req.headers["x-homerail-dag-token"]?.[0]
        : req.headers["x-homerail-dag-token"];
      if (!isDagMutationRequestAuthorized({
        remoteAddress: req.socket.remoteAddress,
        headerToken,
        bodyToken: body.authorization_token,
        configuredToken: process.env.HOMERAIL_DAG_MUTATION_TOKEN ?? process.env.HOMERAIL_DAG_APPROVAL_TOKEN,
      })) {
        _forbidden(res, "DAG event delivery requires a local request or valid HOMERAIL_DAG_MUTATION_TOKEN");
        return;
      }
      const idempotencyKey = typeof body.idempotency_key === "string" ? body.idempotency_key.trim() : "";
      if (!idempotencyKey) throw new Error("idempotency_key is required");
      const eventName = decodeURIComponent(triggerEventMatch[1]);
      const deliveries = fireDagEventTrigger(eventName, idempotencyKey, body.payload);
      _ok(res, `Event trigger '${eventName}' delivered`, { deliveries, total: deliveries.length });
    }).catch((error) => _badRequest(res, error instanceof Error ? error.message : String(error)));
    return true;
  }

  const stateMatch = pathname.match(/^\/api\/dag\/state\/([^/]+)\/([^/]+)$/);
  if (stateMatch && req.method === "POST") {
    const namespace = decodeURIComponent(stateMatch[1]);
    const key = decodeURIComponent(stateMatch[2]);
    void _readJsonBody(req).then((raw) => {
      const body = raw as Record<string, unknown>;
      const headerToken = Array.isArray(req.headers["x-homerail-dag-token"])
        ? req.headers["x-homerail-dag-token"]?.[0]
        : req.headers["x-homerail-dag-token"];
      if (!isDagMutationRequestAuthorized({
        remoteAddress: req.socket.remoteAddress,
        headerToken,
        bodyToken: body.authorization_token,
        configuredToken: process.env.HOMERAIL_DAG_MUTATION_TOKEN ?? process.env.HOMERAIL_DAG_APPROVAL_TOKEN,
      })) {
        _forbidden(res, "DAG state mutation requires a local request or valid HOMERAIL_DAG_MUTATION_TOKEN");
        return;
      }
      if (!("value" in body)) throw new Error("value is required");
      const expectedVersion = body.expected_version === undefined ? undefined : Number(body.expected_version);
      if (expectedVersion !== undefined && (!Number.isInteger(expectedVersion) || expectedVersion < 0)) {
        throw new Error("expected_version must be a non-negative integer");
      }
      const result = updateDagState({ namespace, key, value: body.value, expectedVersion });
      if (!result.updated) throw new Error(`state version conflict: current version is ${result.record.version}`);
      _ok(res, "DAG state updated", result);
    }).catch((error) => _badRequest(res, error instanceof Error ? error.message : String(error)));
    return true;
  }

  // POST /api/runs/:run_id/inject
  // Accept BOTH snake_case (`node_id`) and camelCase
  // (`nodeId`) keys for backwards-compatibility with older
  // harness/clients. snake_case remains the canonical contract
  // emitted by TS Manager; camelCase is accepted as a defensive
  // fallback so that 400s never silently drop a real inject
  // request. `instruction` and `mode` remain snake_case only
  // (no caller is known to send camelCase for these).
  const injectMatch = pathname.match(/^\/api\/runs\/([^/]+)\/inject$/);
  if (injectMatch && req.method === "POST") {
    const runId = decodeURIComponent(injectMatch[1]);
    _readJsonBody(req)
      .then((body) => {
        const b = body as Record<string, unknown>;
        const nodeId =
          typeof b.node_id === "string"
            ? b.node_id
            : typeof b.nodeId === "string"
              ? b.nodeId
              : undefined;
        const instruction = typeof b.instruction === "string" ? b.instruction : undefined;
        const mode = typeof b.mode === "string" ? b.mode : "inbox";
        if (!nodeId) {
          _badRequest(res, "Missing required field: node_id");
          return;
        }
        if (!instruction) {
          _badRequest(res, "Missing required field: instruction");
          return;
        }
        try {
          const result = changeOrchestrator.injectRun(runId, nodeId, instruction, mode);
          _ok(res, "Instruction injected", result);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          if (message.includes("not found")) {
            _notFound(res, message);
          } else if (message.includes("terminal")) {
            json(res, 409, { success: false, message, error: message });
          } else {
            _badRequest(res, message);
          }
        }
      })
      .catch((err) => {
        _badRequest(res, err instanceof Error ? err.message : "Invalid JSON body");
      });
    return true;
  }

  // POST /api/runs/:run_id/node/:node_id/checkpoint-resume
  // POST /api/dag-status/:run_id/node/:node_id/checkpoint-resume
  const checkpointResumeMatch =
    pathname.match(/^\/api\/runs\/([^/]+)\/node\/([^/]+)\/checkpoint-resume$/)
    ?? pathname.match(/^\/api\/dag-status\/([^/]+)\/node\/([^/]+)\/checkpoint-resume$/);
  if (checkpointResumeMatch && req.method === "POST") {
    const runId = decodeURIComponent(checkpointResumeMatch[1]);
    const nodeId = decodeURIComponent(checkpointResumeMatch[2]);
    _readJsonBody(req)
      .then((body) => {
        const b = body as Record<string, unknown>;
        const instruction = typeof b.instruction === "string" ? b.instruction.trim() : "";
        const entryUuid =
          typeof b.entry_uuid === "string" ? b.entry_uuid
            : typeof b.entryUuid === "string" ? b.entryUuid
              : typeof b.uuid === "string" ? b.uuid
                : undefined;
        const last = typeof b.last === "number"
          ? b.last
          : typeof b.last === "string" && b.last.trim()
            ? Number(b.last)
            : undefined;
        const sessionId =
          typeof b.session_id === "string" ? b.session_id
            : typeof b.sessionId === "string" ? b.sessionId
              : undefined;
        if (!instruction) {
          _badRequest(res, "Missing required field: instruction");
          return;
        }
        if (last !== undefined && !Number.isFinite(last)) {
          _badRequest(res, "last must be a finite number");
          return;
        }
        try {
          const result = changeOrchestrator.checkpointResumeNode(runId, nodeId, {
            instruction,
            entryUuid,
            last,
            sessionId,
          });
          _ok(res, "Checkpoint resume scheduled", result);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          if (message.includes("not active") || message.includes("terminal")) {
            json(res, 409, { success: false, message, error: message });
          } else if (message.includes("not found") || message.includes("Node not found") || message.includes("Unknown node")) {
            _notFound(res, message);
          } else {
            _badRequest(res, message);
          }
        }
      })
      .catch((err) => {
        _badRequest(res, err instanceof Error ? err.message : "Invalid JSON body");
      });
    return true;
  }

  // POST /api/runs/:run_id/dynamic/nodes
  const appendNodeMatch = pathname.match(/^\/api\/runs\/([^/]+)\/dynamic\/nodes$/);
  if (appendNodeMatch && req.method === "POST") {
    const runId = decodeURIComponent(appendNodeMatch[1]);
    _readJsonBody(req)
      .then((body) => {
        const b = body as Record<string, unknown>;
        const nodeId = typeof b.node_id === "string"
          ? b.node_id
          : typeof b.nodeId === "string"
            ? b.nodeId
            : undefined;
        if (!nodeId) {
          _badRequest(res, "Missing required field: node_id");
          return;
        }
        try {
          const result = changeOrchestrator.appendNode(runId, _appendNodeRequestFromBody(b)!);
          _created(res, "DAG node appended", result);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          if (message.includes("not found")) {
            _notFound(res, message);
          } else if (message.includes("terminal")) {
            json(res, 409, { success: false, message, error: message });
          } else {
            _badRequest(res, message);
          }
        }
      })
      .catch((err) => {
        _badRequest(res, err instanceof Error ? err.message : "Invalid JSON body");
      });
    return true;
  }

  // POST /api/runs/:run_id/manager/commands
  const managerCommandMatch = pathname.match(/^\/api\/runs\/([^/]+)\/manager\/commands$/);
  if (managerCommandMatch && req.method === "POST") {
    _unsupported(res, "Manager run commands are not supported by TS Manager", {
      code: "MANAGER_RUN_COMMAND_UNSUPPORTED",
      supported_paths: [
        "Edit the DAG template before creating the run",
        "POST /api/runs/:run_id/dynamic/nodes",
      ],
    });
    return true;
  }

  return false;
}
