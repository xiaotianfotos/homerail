import * as http from "node:http";
import { healthHandler, versionHandler } from "../health/index.js";
import { getDiagnostics } from "../config/diagnostics.js";
import { runtimeStatusHandler } from "../runtime/status.js";
import { setupWorkerWebSocket, type WorkerWebSocketOptions } from "../worker/websocket.js";
import { setupNodeWebSocket, type NodeWebSocketOptions } from "../node/websocket.js";
import { inspectionRoutesHandler } from "./routes.js";
import {
  isDagMutationRequestAuthorized,
  mutationRoutesHandler,
  requiresDagMutationAuthorization,
} from "./mutations.js";
import { agentSessionRoutesHandler } from "./agent-sessions.js";
import { llmSettingsRoutesHandler } from "./llm-settings.js";
import { setupVoiceRealtimeWebSocket, voiceRoutesHandler } from "./voice.js";
import { projectsChangesRoutesHandler } from "./projects-changes.js";
import { gitServersRoutesHandler } from "./git-servers.js";
import { mcpServersRoutesHandler } from "./mcp-servers.js";
import { memoryRoutesHandler } from "./memory.js";
import { dagWorkflowRoutesHandler } from "./dag-workflows.js";
import { settingsBootstrapHandler } from "./settings-bootstrap.js";
import { settingsStorageInfoHandler } from "./settings-storage-info.js";
import { voiceAgentBootstrapHandler } from "./voice-agent-bootstrap.js";
import {
  managerAgentConfigRoutesHandler,
  type ManagerAgentConfigRoutesOptions,
} from "./manager-agent-config.js";
import { managerAgentReadinessRoutesHandler } from "./manager-agent-readiness.js";
import { setupEventWebSocket } from "./events-websocket.js";
import { ChangeOrchestrator } from "../orchestration/change-orchestrator.js";
import { GraphExecutor } from "../orchestration/graph-executor.js";
import { WsDispatchAdapter, type WsDispatchAdapterOptions } from "../orchestration/ws-dispatch-adapter.js";
import type { DAGDispatcher } from "../orchestration/dag-dispatcher.js";
import { emit } from "../events/bus.js";
import { dispatchRecoveredRuns } from "../runtime/active-runs.js";
import { startDagTriggerScheduler } from "../runtime/dag-triggers.js";
import { readOrCreateControlPlaneToken } from "../persistence/control-plane-secret.js";
import { startWorkspaceCleanupScheduler } from "../runtime/workspace-retention.js";

function json(res: http.ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function setCorsHeaders(res: http.ServerResponse): void {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Homerail-Approval-Token, X-Homerail-Dag-Token");
}

export function resolveManagerWorkerWsBaseUrl(actualPort: number): string {
  const explicit = process.env.HOMERAIL_MANAGER_WORKER_WS_BASE_URL;
  if (explicit) return explicit.replace(/\/$/, "");

  const explicitHost = process.env.HOMERAIL_MANAGER_WORKER_WS_HOST;
  const host = explicitHost && explicitHost.trim()
    ? explicitHost.trim()
    : "host.docker.internal";
  return `ws://${host}:${actualPort}`;
}

export function resolveManagerContainerRestUrl(actualPort: number): string {
  const explicit = process.env.HOMERAIL_MANAGER_CONTAINER_REST_URL;
  if (explicit) return explicit.replace(/\/$/, "");
  return resolveManagerWorkerWsBaseUrl(actualPort)
    .replace(/^ws:/, "http:")
    .replace(/^wss:/, "https:");
}

export function resolveManagerWorkerExtraHosts(): string[] {
  const explicit = process.env.HOMERAIL_MANAGER_WORKER_EXTRA_HOSTS;
  if (explicit !== undefined) {
    return explicit
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
  }
  return ["host.docker.internal:host-gateway"];
}

const WORKER_ENV_PASSTHROUGH = [
  "CLAUDE_MAX_TURNS",
  "CLAUDE_SDK_QUERY_TIMEOUT_MS",
  "CLAUDE_THINKING_BUDGET",
  "HOMERAIL_ALLOW_INSECURE_REMOTE_WS",
] as const;

export interface WorkerControlPlaneAuth {
  token: string;
  explicitlyConfigured: boolean;
}

export function resolveWorkerControlPlaneAuth(
  env: NodeJS.ProcessEnv = process.env,
  generateToken: () => string = readOrCreateControlPlaneToken,
): WorkerControlPlaneAuth {
  const configured = env.HOMERAIL_WORKER_TOKEN?.trim()
    || env.HOMERAIL_CONTROL_PLANE_TOKEN?.trim();
  return configured
    ? { token: configured, explicitlyConfigured: true }
    : { token: generateToken(), explicitlyConfigured: false };
}

const MANAGER_AGENT_ENV_PASSTHROUGH = [
  "HOMERAIL_MANAGER_AGENT_BACKEND",
  "HOMERAIL_MANAGER_AGENT_SMOKE",
  "HOMERAIL_MANAGER_AGENT_SMOKE_YAML",
  "HOMERAIL_MANAGER_AGENT_SMOKE_PROFILE",
  "HOMERAIL_MANAGER_AGENT_SMOKE_PROMPT",
  "MANAGER_AGENT_TURN_TIMEOUT_MS",
  "HOMERAIL_DAG_MUTATION_TOKEN",
] as const;

export function resolveWorkerRuntimeEnv(): Record<string, string> | undefined {
  return resolveWorkerRuntimeEnvFrom(process.env);
}

export function resolveProvisionedWorkerRuntimeEnv(
  auth: WorkerControlPlaneAuth,
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  return {
    ...(resolveWorkerRuntimeEnvFrom(env) ?? {}),
    HOMERAIL_WORKER_TOKEN: auth.token,
  };
}

function resolveWorkerRuntimeEnvFrom(envSource: NodeJS.ProcessEnv): Record<string, string> | undefined {
  const env: Record<string, string> = {};
  for (const key of WORKER_ENV_PASSTHROUGH) {
    const value = envSource[key];
    if (value !== undefined && value.trim().length > 0) {
      env[key] = value;
    }
  }
  return Object.keys(env).length > 0 ? env : undefined;
}

export function resolveManagerAgentRuntimeEnv(): Record<string, string> | undefined {
  const env: Record<string, string> = {};
  for (const key of MANAGER_AGENT_ENV_PASSTHROUGH) {
    const value = process.env[key];
    if (value !== undefined && value.trim().length > 0) {
      env[key] = value;
    }
  }
  const managerAgentBackend = process.env.HOMERAIL_MANAGER_AGENT_BACKEND ?? process.env.AGENT_BACKEND;
  if (managerAgentBackend !== undefined && managerAgentBackend.trim().length > 0) {
    env.AGENT_BACKEND = managerAgentBackend;
  }
  return Object.keys(env).length > 0 ? env : undefined;
}

export function mergeProvisionerOptions(
  defaults: WsDispatchAdapterOptions,
  overrides: WsDispatchAdapterOptions | false | undefined,
  workerToken: string,
): WsDispatchAdapterOptions {
  if (overrides === undefined) return defaults;
  if (overrides === false) return { provisioner: false };
  if (overrides.provisioner === false) {
    return { ...defaults, ...overrides, provisioner: false };
  }

  const defaultProvisioner = defaults.provisioner === false
    ? undefined
    : defaults.provisioner;
  const overrideProvisioner = overrides.provisioner;
  return {
    ...defaults,
    ...overrides,
    provisioner: {
      ...defaultProvisioner,
      ...overrideProvisioner,
      env: {
        ...(defaultProvisioner?.env ?? {}),
        ...(overrideProvisioner?.env ?? {}),
        HOMERAIL_WORKER_TOKEN: workerToken,
      },
    },
  };
}

export function createServer(
  port: number,
  wsOptions?: WorkerWebSocketOptions & NodeWebSocketOptions,
  dispatcher?: DAGDispatcher,
  provisionerOptions?: WsDispatchAdapterOptions | false,
  managerAgentConfigOptions: ManagerAgentConfigRoutesOptions = {},
) {
  let server: http.Server;
  const workerControlPlaneAuth = resolveWorkerControlPlaneAuth();
  const effectiveWorkerToken = wsOptions?.authToken?.trim()
    || workerControlPlaneAuth.token;
  const effectiveWorkerTokenIsExplicit = Boolean(wsOptions?.authToken?.trim())
    || workerControlPlaneAuth.explicitlyConfigured;
  const configuredNodeToken = process.env.HOMERAIL_NODE_TOKEN?.trim()
    || process.env.HOMERAIL_CONTROL_PLANE_TOKEN?.trim();
  const workerImage = process.env.HOMERAIL_WORKER_IMAGE || "homerail-worker:latest";
  const workerRuntimeEnv = resolveProvisionedWorkerRuntimeEnv({
    token: effectiveWorkerToken,
    explicitlyConfigured: effectiveWorkerTokenIsExplicit,
  });
  const defaultProvisionerOptions: WsDispatchAdapterOptions = {
    provisioner: {
      image: workerImage,
      extraHosts: resolveManagerWorkerExtraHosts(),
      env: workerRuntimeEnv,
    },
    managerBaseUrl: () => {
      const addr = server?.address();
      const actualPort = typeof addr === "object" && addr ? addr.port : port;
      return `http://127.0.0.1:${actualPort}`;
    },
    managerWorkerWsBaseUrl: () => {
      const addr = server?.address();
      const actualPort = typeof addr === "object" && addr ? addr.port : port;
      return resolveManagerWorkerWsBaseUrl(actualPort);
    },
    projectId: process.env.HOMERAIL_PROJECT_ID ?? "p1",
  };
  const adapterOptions = mergeProvisionerOptions(
    defaultProvisionerOptions,
    provisionerOptions,
    effectiveWorkerToken,
  );
  const managerAgentContainerOptions =
    provisionerOptions === false
      ? undefined
      : {
          image: process.env.HOMERAIL_MANAGER_AGENT_IMAGE || workerImage,
          env: resolveManagerAgentRuntimeEnv(),
          extraHosts: resolveManagerWorkerExtraHosts(),
          managerRestUrl: () => {
            const addr = server?.address();
            const actualPort = typeof addr === "object" && addr ? addr.port : port;
            return resolveManagerContainerRestUrl(actualPort);
          },
        };
  const actualDispatcher =
    dispatcher ?? new WsDispatchAdapter(adapterOptions);
  const graphExecutor = new GraphExecutor(actualDispatcher);
  const changeOrchestrator = new ChangeOrchestrator(graphExecutor);
  const stopTriggerScheduler = startDagTriggerScheduler(changeOrchestrator);
  const stopWorkspaceCleanupScheduler = startWorkspaceCleanupScheduler();

  server = http.createServer((req, res) => {
    setCorsHeaders(res);

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    const pathname = new URL(req.url || "/", "http://localhost").pathname;
    if (requiresDagMutationAuthorization(pathname, req.method)) {
      const rawHeader = req.headers["x-homerail-dag-token"];
      const headerToken = Array.isArray(rawHeader) ? rawHeader[0] : rawHeader;
      if (!isDagMutationRequestAuthorized({
        remoteAddress: req.socket.remoteAddress,
        headerToken,
        configuredToken: process.env.HOMERAIL_DAG_MUTATION_TOKEN,
      })) {
        json(res, 403, {
          success: false,
          message: "DAG mutations require a local request or valid HOMERAIL_DAG_MUTATION_TOKEN",
          error: "DAG mutations require a local request or valid HOMERAIL_DAG_MUTATION_TOKEN",
        });
        return;
      }
    }

    if (inspectionRoutesHandler(req, res)) {
      return;
    }

    if (mutationRoutesHandler(req, res, changeOrchestrator, managerAgentContainerOptions, managerAgentConfigOptions)) {
      return;
    }

    if (agentSessionRoutesHandler(req, res)) {
      return;
    }

    if (llmSettingsRoutesHandler(req, res)) {
      return;
    }

    if (voiceRoutesHandler(req, res)) {
      return;
    }

    if (projectsChangesRoutesHandler(req, res)) {
      return;
    }

    if (gitServersRoutesHandler(req, res)) {
      return;
    }

    if (mcpServersRoutesHandler(req, res)) {
      return;
    }

    if (memoryRoutesHandler(req, res)) {
      return;
    }

    if (dagWorkflowRoutesHandler(req, res)) {
      return;
    }

    if (settingsStorageInfoHandler(req, res)) {
      return;
    }

    if (settingsBootstrapHandler(req, res)) {
      return;
    }

    if (managerAgentConfigRoutesHandler(req, res, managerAgentConfigOptions)) {
      return;
    }

    if (managerAgentReadinessRoutesHandler(req, res, managerAgentContainerOptions, managerAgentConfigOptions)) {
      return;
    }

    if (voiceAgentBootstrapHandler(req, res, managerAgentContainerOptions, managerAgentConfigOptions)) {
      return;
    }

    switch (req.url) {
      case "/health":
        json(res, 200, healthHandler(port));
        break;
      case "/version":
        json(res, 200, versionHandler());
        break;
      case "/config/diagnostics":
        json(res, 200, getDiagnostics(port));
        break;
      case "/runtime/status":
        json(res, 200, runtimeStatusHandler());
        break;
      default:
        json(res, 404, { error: "not found" });
    }
  });
  server.once("close", stopTriggerScheduler);
  server.once("close", stopWorkspaceCleanupScheduler);

  const workerWebsocketOptions: WorkerWebSocketOptions = {
    ...wsOptions,
    authToken: effectiveWorkerToken,
    allowLoopbackWithoutToken: wsOptions?.allowLoopbackWithoutToken
      ?? !effectiveWorkerTokenIsExplicit,
    onHandoffApplied: (runId: string) => {
      graphExecutor.tick(runId);
    },
    onManagerCommand: (workerId: string, data: Record<string, unknown>) => {
      const runId = typeof data.runId === "string" ? data.runId : "";
      const command = typeof data.command === "string" ? data.command : "";
      const sourceNodeId = typeof data.sourceNodeId === "string" ? data.sourceNodeId : "";
      const commandId = typeof data.commandId === "string"
        ? data.commandId
        : `worker-command-${Date.now()}`;
      const append = typeof data.append === "object" && data.append !== null
        ? data.append as Record<string, unknown>
        : undefined;
      const appendNodeId = append && typeof append.node_id === "string"
        ? append.node_id
        : append && typeof append.nodeId === "string"
          ? append.nodeId
          : undefined;
      try {
        if (!runId) throw new Error("Missing required field: runId");
        if (!command) throw new Error("Missing required field: command");
        if (!sourceNodeId) throw new Error("Missing required field: sourceNodeId");
        emit("dag:worker_manager_command_requested", {
          runId,
          commandId,
          command,
          workerId,
          sourceNodeId,
          nodeId: appendNodeId,
        });
        const result = changeOrchestrator.runManagerCommand(runId, {
          command,
          commandId,
          source: `worker:${workerId}:${sourceNodeId}`,
          append: append
            ? {
              nodeId: String(append.node_id ?? append.nodeId ?? ""),
              agentId: typeof append.agent_id === "string" ? append.agent_id : undefined,
              agent: typeof append.agent === "object" && append.agent !== null ? append.agent as any : undefined,
              after: Array.isArray(append.after) ? append.after.filter((v): v is string => typeof v === "string") : undefined,
              outputs: typeof append.outputs === "object" && append.outputs !== null ? append.outputs as any : undefined,
              name: typeof append.name === "string" ? append.name : undefined,
              description: typeof append.description === "string" ? append.description : undefined,
              image: typeof append.image === "string" ? append.image : undefined,
              container_group: typeof append.container_group === "string" ? append.container_group : undefined,
            }
            : undefined,
        });
        return { ok: true, result };
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
    onFirstWorkerRegistered: () => {
      // Cold-recovery: now that a dispatch target has reconnected, push READY
      // nodes of every recovered active run out to the worker pool.
      dispatchRecoveredRuns(actualDispatcher);
    },
  };
  const nodeWebsocketOptions: NodeWebSocketOptions = {
    ...wsOptions,
    authToken: wsOptions?.authToken ?? configuredNodeToken,
    allowLoopbackWithoutToken: wsOptions?.allowLoopbackWithoutToken
      ?? !configuredNodeToken,
    onHandoffApplied: workerWebsocketOptions.onHandoffApplied,
  };
  setupWorkerWebSocket(server, workerWebsocketOptions);
  setupNodeWebSocket(server, nodeWebsocketOptions);
  setupEventWebSocket(server);
  setupVoiceRealtimeWebSocket(server);

  return server;
}
