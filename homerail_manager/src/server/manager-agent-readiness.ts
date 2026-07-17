import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { getAllNodes, isDockerCapableNode } from "../node/registry.js";
import { readManagerAgentConfig, type ManagerAgentConfig } from "../persistence/manager-agent-config.js";
import { sendLifecycleRequest } from "../node/lifecycle-request.js";
import { getHomerailHome } from "../config/env.js";
import {
  resolveManagerAgentConfig,
} from "./manager-agent-runtime-config.js";
import { hostShellDiagnostics } from "./host-shell-manager-agent.js";
import {
  ensureLocalDockerNode,
  type LocalDockerNodeOptions,
} from "./local-docker-node.js";
import { readDagResourceStatus, type DagResourceStatus } from "./dag-resource-status.js";
import { resolveCodexBinary, runCodexCommandSync } from "./codex-binary.js";
import {
  ensurePreferredManagerAgentConfig,
  type ManagerAgentConfigRoutesOptions,
} from "./manager-agent-config.js";

interface ReadinessBlocker {
  code: string;
  message: string;
  detail?: string;
}

interface CodexCheck {
  available: boolean;
  logged_in: boolean;
  version?: string;
  binary?: string;
}

interface ManagerAgentReadiness {
  ready: boolean;
  status: "ready" | "blocked";
  harness: string;
  runtime_placement: "host" | "host_shell" | null;
  agent_type: string | null;
  provider_name: string | null;
  model_name: string | null;
  blockers: ReadinessBlocker[];
  checks: {
    config: boolean;
    codex?: CodexCheck;
    docker_workspace?: {
      required: boolean;
      host_path: string;
      probe_endpoint: string;
    };
    host_shell?: {
      required: boolean;
      available: boolean;
      shell_path?: string;
      worker_entry?: string;
    };
    dag_resources?: DagResourceStatus;
  };
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function ok(res: http.ServerResponse, message: string, data: unknown): void {
  json(res, 200, { success: true, message, data });
}

function methodNotAllowed(res: http.ServerResponse): void {
  json(res, 405, { success: false, message: "Method not allowed" });
}

function codexStatus(): CodexCheck {
  const requested = process.env.HOMERAIL_CODEX_BIN || process.env.CODEX_BIN_PATH || "codex";
  const resolved = resolveCodexBinary(requested);
  let available = false;
  let version: string | undefined;
  if (resolved) {
    const result = runCodexCommandSync(resolved.command, ["--version"]);
    if (result.status === 0) {
      available = true;
      version = (result.stdout || "").trim().split("\n")[0] || undefined;
    }
  }
  let loggedIn = false;
  try {
    const authPath = path.join(os.homedir(), ".codex", "auth.json");
    if (fs.existsSync(authPath)) {
      const content = fs.readFileSync(authPath, "utf-8").trim();
      loggedIn = content.length > 0 && content !== "{}";
    }
  } catch {
    loggedIn = false;
  }
  return { available, logged_in: loggedIn, version, binary: resolved?.command ?? requested };
}

function dockerCapableNodeIds(): string[] {
  return getAllNodes()
    .filter((node) => node.socket.readyState === 1 && isDockerCapableNode(node))
    .map((node) => node.node_id);
}

function dockerWorkspaceRoot(): string {
  return path.join(getHomerailHome(), "workspace");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function probeDockerWorkspaceMount(
  options?: DockerWorkspaceProbeOptions,
): Promise<Record<string, unknown>> {
  const nodeId = dockerCapableNodeIds()[0]
    ?? (options ? await ensureLocalDockerNode(options) : undefined);
  const workspaceRoot = dockerWorkspaceRoot();
  fs.mkdirSync(workspaceRoot, { recursive: true });

  if (!nodeId) {
    return {
      available: false,
      node_id: null,
      host_path: workspaceRoot,
      probe_path: workspaceRoot,
      error: "No connected docker-capable node available",
      code: "docker_node_unavailable",
    };
  }

  const image = options?.image ?? "homerail-worker:latest";
  const name = `homerail-docker-workspace-probe-${Date.now()}`;
  let containerId = "";
  try {
    const create = await sendLifecycleRequest(nodeId, "container", "create", {
      image,
      name,
      labels: {
        "homerail.resource_type": "docker-workspace-probe",
      },
      mounts: [{ host: workspaceRoot, container: "/workspace", mode: "rw" }],
      mount_policy: { allowed_host_roots: [workspaceRoot] },
      workdir: "/workspace",
    }, { timeoutMs: 60_000 });
    if (create.status !== "success") {
      return {
        available: false,
        node_id: nodeId,
        image,
        host_path: workspaceRoot,
        probe_path: workspaceRoot,
        error: create.error?.message ?? JSON.stringify(create.error ?? {}),
        code: "docker_workspace_mount_failed",
      };
    }
    containerId = String(create.resource_data?.id || "");
    return {
      available: true,
      node_id: nodeId,
      image,
      host_path: workspaceRoot,
      probe_path: workspaceRoot,
      container_id: containerId || null,
    };
  } catch (err) {
    return {
      available: false,
      node_id: nodeId,
      image,
      host_path: workspaceRoot,
      probe_path: workspaceRoot,
      error: errorMessage(err),
      code: "docker_workspace_mount_failed",
    };
  } finally {
    if (containerId) {
      try {
        await sendLifecycleRequest(nodeId, "container", "remove", { container_id: containerId }, { timeoutMs: 20_000 });
      } catch {
        // Best-effort cleanup for the probe container.
      }
    }
  }
}

export function managerAgentReadiness(
  effectiveConfig?: ManagerAgentConfig,
): ManagerAgentReadiness {
  const config = effectiveConfig ?? readManagerAgentConfig();
  const blockers: ReadinessBlocker[] = [];
  let runtimeConfig;
  try {
    runtimeConfig = resolveManagerAgentConfig(
      undefined,
      config.provider_name ?? undefined,
      config.model_name ?? undefined,
      config.llm_setting_id ?? undefined,
      config.harness,
      config.reasoning_effort,
      config.service_tier,
    );
  } catch (err) {
    blockers.push({
      code: "manager_config_invalid",
      message: err instanceof Error ? err.message : String(err),
    });
  }

  const readiness: ManagerAgentReadiness = {
    ready: false,
    status: "blocked",
    harness: config.harness,
    runtime_placement: runtimeConfig?.runtime_placement === "host"
      || runtimeConfig?.runtime_placement === "host_shell"
      ? runtimeConfig.runtime_placement
      : null,
    agent_type: runtimeConfig?.agent_type ?? null,
    provider_name: runtimeConfig?.provider_name ?? config.provider_name,
    model_name: runtimeConfig?.model ?? config.model_name,
    blockers,
    checks: {
      config: blockers.length === 0,
      docker_workspace: {
        required: true,
        host_path: dockerWorkspaceRoot(),
        probe_endpoint: "/api/dag/docker-workspace-probe",
      },
      dag_resources: readDagResourceStatus(),
    },
  };

  if (!runtimeConfig) return readiness;

  if (runtimeConfig.runtime_placement === "host") {
    const codex = codexStatus();
    readiness.checks.codex = codex;
    if (!codex.available) {
      blockers.push({ code: "codex_unavailable", message: "Codex CLI is not available" });
    }
    if (!codex.logged_in) {
      blockers.push({ code: "codex_auth_missing", message: "Codex is not logged in" });
    }
  } else if (runtimeConfig.runtime_placement === "host_shell") {
    const hostShell = hostShellDiagnostics();
    readiness.checks.host_shell = {
      required: true,
      available: hostShell.available,
      shell_path: hostShell.shell_path,
      worker_entry: hostShell.worker_entry,
    };
    if (!hostShell.available) {
      blockers.push({
        code: "host_shell_unavailable",
        message: hostShell.error ?? "Host-shell Manager Agent runtime is unavailable",
      });
    }
  } else {
    blockers.push({
      code: "manager_runtime_placement_invalid",
      message: "Manager Agent must run on the host",
    });
  }

  readiness.ready = blockers.length === 0;
  readiness.status = readiness.ready ? "ready" : "blocked";
  return readiness;
}

export function managerAgentReadinessRoutesHandler(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  managerAgentConfigOptions: ManagerAgentConfigRoutesOptions = {},
  dockerWorkspaceOptions?: DockerWorkspaceProbeOptions,
): boolean {
  const pathname = new URL(req.url || "/", "http://localhost").pathname;
  if (pathname === "/api/manager-agent/readiness") {
    if (req.method !== "GET") {
      methodNotAllowed(res);
      return true;
    }
    void ensurePreferredManagerAgentConfig(managerAgentConfigOptions)
      .then((config) => ok(res, "Manager Agent readiness checked", managerAgentReadiness(config)))
      .catch((error) => json(res, 500, {
        success: false,
        message: error instanceof Error ? error.message : String(error),
      }));
    return true;
  }
  if (pathname === "/api/dag/docker-workspace-probe") {
    if (req.method !== "POST") {
      methodNotAllowed(res);
      return true;
    }
    void probeDockerWorkspaceMount(dockerWorkspaceOptions)
      .then((data) => ok(res, "Docker workspace mount checked", data))
      .catch((err) => json(res, 500, {
        success: false,
        message: "Docker workspace mount check failed",
        data: { error: errorMessage(err) },
    }));
    return true;
  }
  return false;
}

export interface DockerWorkspaceProbeOptions extends LocalDockerNodeOptions {
  image?: string;
}
