import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { getAllNodes, isDockerCapableNode } from "../node/registry.js";
import { sendLifecycleRequest } from "../node/lifecycle-request.js";
import { ensureDefaultWorkspacePath, getDataRoot, getHomerailHome } from "../config/env.js";
import { getProject } from "../persistence/projects-changes.js";
import { resolveAgentRuntimeConfig } from "../runtime/agent-runtime-resolver.js";
import {
  type ManagerAgentHarness,
  type ManagerAgentRuntimePlacement,
  type ManagerAgentReasoningEffort,
  type ManagerAgentServiceTier,
} from "homerail-protocol";
import { getManagerAgentTurnEnvelopeAuthority } from "./manager-agent-turn-envelope.js";

export interface ManagerAgentRuntimeConfig {
  provider_name: string;
  model: string;
  api_key: string;
  base_url: string;
  protocol?: string;
  agent_type: string;
  runtime_placement: ManagerAgentRuntimePlacement;
  project_id?: string;
  project_workspace?: string;
  /** 每轮实时生效的推理幅度，codex 传 model_reasoning_effort */
  reasoning_effort?: ManagerAgentReasoningEffort;
  service_tier: ManagerAgentServiceTier;
}

export interface ManagerAgentContainerOptions {
  managerRestUrl: string | (() => string);
  image?: string;
  env?: Record<string, string>;
  extraHosts?: string[];
  createTimeoutMs?: number;
  startTimeoutMs?: number;
  healthTimeoutMs?: number;
}

export interface ManagerAgentContainer {
  containerId: string;
  nodeId: string;
  baseUrl: string;
  containerName: string;
  workerId: string;
}

const MANAGER_AGENT_CONTAINER_PORT = 9001;
const MANAGER_AGENT_PORT_BASE = 39000;
const MANAGER_AGENT_PORT_SPAN = 20000;
const LOCAL_NODE_ID = "local-docker-node";

let localNodeStartPromise: Promise<string | undefined> | null = null;

function managerAgentContainerEnv(source: Record<string, string> = {}): Record<string, string> {
  const env = { ...source };
  delete env.HOMERAIL_MANAGER_ADMIN_TOKEN;
  delete env.HOMERAIL_PLUGIN_CAPABILITY_SECRET;
  return env;
}

function canonicalProjectId(projectId?: string): string {
  const trimmed = (projectId ?? "").trim();
  if (!trimmed || trimmed === "None") return "__default__";
  return trimmed.replace(/[^A-Za-z0-9_.-]/g, "-");
}

function containerName(projectId?: string): string {
  return `homerail-manager-agent-${canonicalProjectId(projectId)}`;
}

function workerId(projectId?: string): string {
  return `manager-agent-${canonicalProjectId(projectId)}`;
}

function hostPort(projectId?: string): number {
  const fixed = process.env.HOMERAIL_MANAGER_AGENT_PORT;
  if (fixed) return Number(fixed);
  const digest = createHash("sha256").update(canonicalProjectId(projectId)).digest("hex");
  return MANAGER_AGENT_PORT_BASE + (Number.parseInt(digest.slice(0, 8), 16) % MANAGER_AGENT_PORT_SPAN);
}

function baseUrl(projectId?: string): string {
  return `http://127.0.0.1:${hostPort(projectId)}`;
}

function managerRestUrl(options: ManagerAgentContainerOptions): string {
  const raw = typeof options.managerRestUrl === "function" ? options.managerRestUrl() : options.managerRestUrl;
  return raw.replace(/\/+$/, "").endsWith("/api") ? raw.replace(/\/+$/, "") : `${raw.replace(/\/+$/, "")}/api`;
}

function resolveProjectWorkspace(projectId?: string): string | undefined {
  if (projectId) {
    const project = getProject(projectId);
    const candidate = project?.workspace_path ?? project?.project_root;
    if (candidate && fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
      return path.resolve(candidate);
    }
    return undefined;
  }
  const explicit = process.env.HOMERAIL_PROJECT_WORKSPACE || process.env.HOMERAIL_REPO_ROOT;
  if (explicit && fs.existsSync(explicit) && fs.statSync(explicit).isDirectory()) {
    return path.resolve(explicit);
  }
  return ensureDefaultWorkspacePath();
}

function prepareWorkspace(projectId?: string): string {
  const dir = path.join(getDataRoot(), "manager-agents", canonicalProjectId(projectId));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "AGENTS.md"),
    [
      "# HomeRail Manager Agent",
      "",
      "This directory is the long-lived Manager Agent workspace.",
      "Use /workspace/project for the selected project workspace, or the default workspace when no project is selected.",
      "Use Manager Agent tools to create and invoke DAG runs; do not invent run IDs.",
      "",
    ].join("\n"),
    "utf-8",
  );
  return dir;
}

function selectDockerNode(): string | undefined {
  return getAllNodes().find((node) =>
    node.socket.readyState === 1 &&
    isDockerCapableNode(node)
  )?.node_id;
}

function runtimeRoot(): string {
  const explicit = process.env.HOMERAIL_REPO_ROOT;
  if (explicit && fs.existsSync(explicit)) return path.resolve(explicit);
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
}

function localNodeCliPath(): string | undefined {
  const explicit = process.env.HOMERAIL_NODE_CLI;
  if (explicit && fs.existsSync(explicit)) return path.resolve(explicit);
  const candidate = path.join(runtimeRoot(), "homerail_node", "dist", "cli.js");
  return fs.existsSync(candidate) ? candidate : undefined;
}

function restUrlToWsUrl(raw: string): string {
  const url = new URL(raw.replace(/\/+$/, "").replace(/\/api$/, ""));
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = url.pathname.replace(/\/+$/, "");
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

function localNodeAutostartEnabled(): boolean {
  const raw = process.env.HOMERAIL_LOCAL_NODE_AUTOSTART;
  return raw === undefined || !["0", "false", "no", "off"].includes(raw.trim().toLowerCase());
}

async function waitForDockerNode(timeoutMs: number): Promise<string | undefined> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    const nodeId = selectDockerNode();
    if (nodeId) return nodeId;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return undefined;
}

async function ensureLocalDockerNode(options: ManagerAgentContainerOptions, projectId?: string): Promise<string | undefined> {
  const existing = selectDockerNode();
  if (existing) return existing;
  if (!localNodeAutostartEnabled()) return undefined;
  if (localNodeStartPromise) return localNodeStartPromise;

  localNodeStartPromise = (async () => {
    const cliPath = localNodeCliPath();
    if (!cliPath) return undefined;
    const logDir = path.join(getDataRoot(), "logs");
    fs.mkdirSync(logDir, { recursive: true });
    const out = fs.openSync(path.join(logDir, "local-node.log"), "a");
    const err = fs.openSync(path.join(logDir, "local-node.err.log"), "a");
    const nodeId = process.env.HOMERAIL_NODE_ID || LOCAL_NODE_ID;
    const managerUrl = restUrlToWsUrl(managerRestUrl(options));
    const child = spawn(process.execPath, [cliPath], {
      cwd: runtimeRoot(),
      detached: true,
      shell: false,
      stdio: ["ignore", out, err],
      windowsHide: true,
      env: {
        ...process.env,
        HOMERAIL_HOME: getHomerailHome(),
        HOMERAIL_MANAGER_WS_URL: managerUrl,
        HOMERAIL_PROJECT_ID: projectId || process.env.HOMERAIL_PROJECT_ID || "p1",
        HOMERAIL_NODE_ID: nodeId,
        HOMERAIL_NODE_PROVIDER: process.env.HOMERAIL_NODE_PROVIDER || "docker-cli",
        HOMERAIL_NODE_CAPABILITIES: process.env.HOMERAIL_NODE_CAPABILITIES || "docker-cli",
      },
    });
    fs.closeSync(out);
    fs.closeSync(err);
    child.unref();
    return waitForDockerNode(8_000);
  })().finally(() => {
    localNodeStartPromise = null;
  });

  return localNodeStartPromise;
}

async function listContainers(nodeId: string): Promise<Array<Record<string, unknown>>> {
  const result = await sendLifecycleRequest(nodeId, "container", "list", {}, { timeoutMs: 20_000 });
  if (result.status !== "success") {
    throw new Error(`container list failed: ${JSON.stringify(result.error)}`);
  }
  const containers = result.resource_data?.containers;
  return Array.isArray(containers) ? containers as Array<Record<string, unknown>> : [];
}

async function findContainerByName(nodeId: string, name: string): Promise<Record<string, unknown> | undefined> {
  const containers = await listContainers(nodeId);
  return containers.find((container) => container.name === name);
}

async function inspectContainer(nodeId: string, containerId: string): Promise<Record<string, unknown> | undefined> {
  const result = await sendLifecycleRequest(nodeId, "container", "inspect", { container_id: containerId }, { timeoutMs: 10_000 });
  if (result.status !== "success") return undefined;
  return result.resource_data as Record<string, unknown> | undefined;
}

function labelsOf(container?: Record<string, unknown>): Record<string, string> {
  const raw = container?.labels;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  return Object.fromEntries(
    Object.entries(raw as Record<string, unknown>).map(([key, value]) => [key, String(value)]),
  );
}

function stableRecord(input?: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(input ?? {}).sort(([a], [b]) => a.localeCompare(b)),
  );
}

function managerAgentConfigFingerprint(input: {
  image: string;
  managerRestUrl: string;
  projectId?: string;
  projectWorkspace?: string;
  env?: Record<string, string>;
  extraHosts?: string[];
}): string {
  return createHash("sha256")
    .update(JSON.stringify({
      image: input.image,
      managerRestUrl: input.managerRestUrl,
      projectId: input.projectId ?? "",
      projectWorkspace: input.projectWorkspace ?? "",
      env: stableRecord(input.env),
      extraHosts: [...(input.extraHosts ?? [])].sort(),
    }))
    .digest("hex")
    .slice(0, 16);
}

async function stopRemove(nodeId: string, containerId: string): Promise<void> {
  try {
    await sendLifecycleRequest(nodeId, "container", "stop", { container_id: containerId }, { timeoutMs: 15_000 });
  } catch {
    // Best-effort.
  }
  try {
    await sendLifecycleRequest(nodeId, "container", "remove", { container_id: containerId }, { timeoutMs: 20_000 });
  } catch {
    // Best-effort.
  }
}

async function health(url: string): Promise<boolean> {
  try {
    const res = await fetch(`${url}/health`, { signal: AbortSignal.timeout(3_000) });
    if (!res.ok) return false;
    const data = await res.json() as Record<string, unknown>;
    return data.status === "running" && data.service === "manager-agent";
  } catch {
    return false;
  }
}

async function waitForHealth(url: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    if (await health(url)) return true;
    await new Promise((resolve) => setTimeout(resolve, 800));
  }
  return false;
}

export function resolveManagerAgentConfig(
  projectId: string | undefined,
  providerName?: string,
  modelName?: string,
  settingId?: string,
  harness?: ManagerAgentHarness | string | null,
  reasoningEffort?: ManagerAgentReasoningEffort | string | null,
  serviceTier?: ManagerAgentServiceTier,
): ManagerAgentRuntimeConfig {
  const effort = typeof reasoningEffort === "string" && reasoningEffort.trim()
    ? reasoningEffort.trim()
    : undefined;
  const normalizedServiceTier = serviceTier === "fast" ? "priority" : serviceTier ?? null;
  return {
    ...resolveAgentRuntimeConfig({
      surface: "manager_agent",
      providerName,
      modelName,
      settingId,
      harness,
    }),
    project_id: projectId,
    project_workspace: resolveProjectWorkspace(projectId),
    reasoning_effort: effort ?? "low",
    service_tier: normalizedServiceTier,
  };
}

export async function ensureManagerAgentContainer(
  projectId: string | undefined,
  options: ManagerAgentContainerOptions,
): Promise<ManagerAgentContainer> {
  const nodeId = await ensureLocalDockerNode(options, projectId);
  if (!nodeId) throw new Error("No connected docker-capable node available");
  const name = containerName(projectId);
  const image = options.image ?? "homerail-worker:latest";
  const projectWorkspace = resolveProjectWorkspace(projectId);
  const resolvedManagerRestUrl = managerRestUrl(options);
  const env = {
    ...managerAgentContainerEnv(options.env),
    MANAGER_AGENT_MODE: "1",
    MANAGER_AGENT_PORT: String(MANAGER_AGENT_CONTAINER_PORT),
    HOMERAIL_MANAGER_AGENT_RUNTIME_PLACEMENT: "container",
    MANAGER_REST_URL: resolvedManagerRestUrl,
    PROJECT_ID: projectId ?? "",
    PROJECT_WORKSPACE: projectWorkspace ? "/workspace/project" : "",
    HOMERAIL_WORKER_ID: workerId(projectId),
    ...getManagerAgentTurnEnvelopeAuthority().workerEnvironment(),
  };
  const fingerprint = managerAgentConfigFingerprint({
    image,
    managerRestUrl: resolvedManagerRestUrl,
    projectId,
    projectWorkspace,
    env,
    extraHosts: options.extraHosts,
  });
  const existing = await findContainerByName(nodeId, name);
  const url = baseUrl(projectId);
  if (existing?.id) {
    const inspected = await inspectContainer(nodeId, String(existing.id));
    const labels = labelsOf(inspected ?? existing);
    const status = String(inspected?.status ?? existing.status ?? "");
    const reusable = status === "running" &&
      labels["homerail.config_fingerprint"] === fingerprint &&
      await health(url);
    if (reusable) {
      return { containerId: String(existing.id), nodeId, baseUrl: url, containerName: name, workerId: workerId(projectId) };
    }
  }
  if (existing?.id) {
    await stopRemove(nodeId, String(existing.id));
  }

  const workspace = prepareWorkspace(projectId);
  const mounts = [
    { host: workspace, container: "/workspace", mode: "rw" },
    ...(projectWorkspace ? [{ host: projectWorkspace, container: "/workspace/project", mode: "rw" }] : []),
  ];
  const create = await sendLifecycleRequest(nodeId, "container", "create", {
    image,
    name,
    env,
    labels: {
      "homerail.resource_type": "manager-agent",
      "homerail.project_id": projectId ?? "",
      "homerail.config_fingerprint": fingerprint,
    },
    ports: [{
      hostIp: "127.0.0.1",
      hostPort: hostPort(projectId),
      containerPort: MANAGER_AGENT_CONTAINER_PORT,
      protocol: "tcp",
    }],
    extraHosts: options.extraHosts,
    mounts,
    mount_policy: projectWorkspace ? { allowed_host_roots: [projectWorkspace] } : undefined,
    workdir: "/workspace",
  }, { timeoutMs: options.createTimeoutMs ?? 60_000 });
  if (create.status !== "success") {
    throw new Error(`Manager Agent container create failed: ${JSON.stringify(create.error)}`);
  }
  const containerId = String(create.resource_data?.id || "");
  if (!containerId) throw new Error("Manager Agent container create did not return id");
  const start = await sendLifecycleRequest(nodeId, "container", "start", { container_id: containerId }, {
    timeoutMs: options.startTimeoutMs ?? 30_000,
  });
  if (start.status !== "success") {
    await stopRemove(nodeId, containerId);
    throw new Error(`Manager Agent container start failed: ${JSON.stringify(start.error)}`);
  }
  const healthy = await waitForHealth(url, options.healthTimeoutMs ?? 45_000);
  if (!healthy) {
    await stopRemove(nodeId, containerId);
    throw new Error("Manager Agent container did not become healthy");
  }
  return { containerId, nodeId, baseUrl: url, containerName: name, workerId: workerId(projectId) };
}

export async function forwardChatToManagerAgentContainer(
  container: ManagerAgentContainer,
  payload: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const res = await fetch(`${container.baseUrl}/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(getManagerAgentTurnEnvelopeAuthority().seal({
      payload,
      target: { runtime_placement: "container", worker_id: container.workerId },
    })),
    signal: AbortSignal.timeout(300_000),
  });
  const text = await res.text();
  let body: unknown = text;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { raw: text };
  }
  if (!res.ok) throw new Error(`Manager Agent HTTP ${res.status}: ${JSON.stringify(body).slice(0, 1000)}`);
  return body as Record<string, unknown>;
}
