import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { ensureDefaultWorkspacePath, getDataRoot, getHomerailHome } from "../config/env.js";
import { getProject } from "../persistence/projects-changes.js";

export interface HostShellManagerAgentOptions {
  managerRestUrl: string | (() => string);
  env?: Record<string, string>;
  startTimeoutMs?: number;
  healthTimeoutMs?: number;
}

export interface HostShellManagerAgent {
  processId: number | null;
  baseUrl: string;
  workerId: string;
  processName: string;
}

interface HostShellHealth {
  fingerprint: string;
  processId: number | null;
  projectId: string | null;
  workerId: string;
}

interface PersistedHostShellProcess {
  version: 1;
  pid: number;
  port: number;
  fingerprint: string;
  processName: string;
  workerId: string;
  projectId: string | null;
}

interface RunningHostShellProcess {
  process?: ChildProcess;
  processId: number;
  fingerprint: string;
  projectId?: string;
  stateFile: string;
  url: string;
}

const HOST_AGENT_PORT_BASE = 59000;
const HOST_AGENT_PORT_SPAN = 5000;

const running = new Map<string, RunningHostShellProcess>();
const starting = new Map<string, Promise<HostShellManagerAgent>>();

function canonicalProjectId(projectId?: string): string {
  const trimmed = (projectId ?? "").trim();
  if (!trimmed || trimmed === "None") return "__default__";
  return trimmed.replace(/[^A-Za-z0-9_.-]/g, "-");
}

function processName(projectId?: string): string {
  return `homerail-manager-agent-host-${canonicalProjectId(projectId)}`;
}

function workerId(projectId?: string): string {
  return `manager-agent-host-${canonicalProjectId(projectId)}`;
}

function hostPort(projectId?: string): number {
  const fixed = process.env.HOMERAIL_MANAGER_AGENT_HOST_PORT;
  if (fixed) return Number(fixed);
  const digest = createHash("sha256").update(canonicalProjectId(projectId)).digest("hex");
  return HOST_AGENT_PORT_BASE + (Number.parseInt(digest.slice(0, 8), 16) % HOST_AGENT_PORT_SPAN);
}

function baseUrl(projectId?: string): string {
  return `http://127.0.0.1:${hostPort(projectId)}`;
}

function runtimeStatePath(projectId?: string): string {
  const dir = path.join(getDataRoot(), "manager-agents-host", canonicalProjectId(projectId));
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, "runtime.json");
}

function readRuntimeStateFile(file: string): PersistedHostShellProcess | undefined {
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf-8")) as Partial<PersistedHostShellProcess>;
    if (
      raw.version !== 1 ||
      !Number.isSafeInteger(raw.pid) || Number(raw.pid) <= 0 ||
      !Number.isSafeInteger(raw.port) || Number(raw.port) <= 0 ||
      typeof raw.fingerprint !== "string" || !raw.fingerprint ||
      typeof raw.processName !== "string" || !raw.processName ||
      typeof raw.workerId !== "string" || !raw.workerId ||
      !(typeof raw.projectId === "string" || raw.projectId === null)
    ) {
      return undefined;
    }
    return raw as PersistedHostShellProcess;
  } catch {
    return undefined;
  }
}

function writeRuntimeState(file: string, state: PersistedHostShellProcess): void {
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf-8", mode: 0o600 });
  fs.renameSync(temp, file);
}

function removeRuntimeState(file: string, expected?: Pick<PersistedHostShellProcess, "pid" | "fingerprint">): void {
  if (expected) {
    const current = readRuntimeStateFile(file);
    if (!current || current.pid !== expected.pid || current.fingerprint !== expected.fingerprint) return;
  }
  try {
    fs.rmSync(file, { force: true });
  } catch {
    // Best-effort cleanup; a later ensure can reconcile the stale record.
  }
}

function runtimeRoot(): string {
  const explicit = process.env.HOMERAIL_REPO_ROOT;
  if (explicit && fs.existsSync(explicit)) return path.resolve(explicit);
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
}

export function hostShellWorkerEntryPath(): string | undefined {
  const explicit = process.env.HOMERAIL_MANAGER_AGENT_HOST_ENTRY || process.env.HOMERAIL_WORKER_ENTRY;
  if (explicit && fs.existsSync(explicit)) return path.resolve(explicit);
  const candidate = path.join(runtimeRoot(), "homerail_worker", "dist", "index.js");
  return fs.existsSync(candidate) ? candidate : undefined;
}

export function resolveGitBashPath(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const configured = env.HOMERAIL_MANAGER_AGENT_SHELL || env.GIT_BASH;
  if (configured && fs.existsSync(configured)) return path.resolve(configured);
  if (process.platform !== "win32") return "/bin/sh";
  const candidates = [
    "C:\\Program Files\\Git\\bin\\bash.exe",
    "C:\\Program Files\\Git\\usr\\bin\\bash.exe",
    "C:\\Program Files (x86)\\Git\\bin\\bash.exe",
    "C:\\Program Files (x86)\\Git\\usr\\bin\\bash.exe",
  ];
  return candidates.find((candidate) => fs.existsSync(candidate));
}

export function hostShellDiagnostics(): { available: boolean; shell_path?: string; worker_entry?: string; error?: string } {
  const workerEntry = hostShellWorkerEntryPath();
  if (!workerEntry) {
    return { available: false, error: "homerail_worker dist entry not found" };
  }
  const shellPath = resolveGitBashPath();
  if (!shellPath) {
    return { available: false, worker_entry: workerEntry, error: "Git Bash shell not found" };
  }
  return { available: true, shell_path: shellPath, worker_entry: workerEntry };
}

function managerRestUrl(options: HostShellManagerAgentOptions): string {
  const raw = typeof options.managerRestUrl === "function" ? options.managerRestUrl() : options.managerRestUrl;
  const normalized = raw
    .replace("://host.docker.internal:", "://127.0.0.1:")
    .replace("://gateway.docker.internal:", "://127.0.0.1:")
    .replace(/\/+$/, "");
  return normalized.endsWith("/api") ? normalized : `${normalized}/api`;
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

function prepareHostWorkspace(projectId?: string): string {
  const dir = path.join(getDataRoot(), "manager-agents-host", canonicalProjectId(projectId));
  fs.mkdirSync(dir, { recursive: true });
  const agentsPath = path.join(dir, "AGENTS.md");
  if (!fs.existsSync(agentsPath)) {
    fs.writeFileSync(
      agentsPath,
      [
        "# HomeRail Manager Agent",
        "",
        "This is the host-shell Manager Agent workspace.",
        "Use the configured project workspace when one is available; do not treat this internal directory as a user project.",
        "",
      ].join("\n"),
      "utf-8",
    );
  }
  return dir;
}

function stableRecord(input?: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(input ?? {}).sort(([a], [b]) => a.localeCompare(b)),
  );
}

function workerEntryFingerprint(workerEntry: string): { path: string; size?: number; mtimeMs?: number } {
  const resolved = path.resolve(workerEntry);
  try {
    const stat = fs.statSync(resolved);
    return {
      path: resolved,
      size: stat.size,
      mtimeMs: Math.trunc(stat.mtimeMs),
    };
  } catch {
    return { path: resolved };
  }
}

function hostFingerprint(input: {
  managerRestUrl: string;
  projectId?: string;
  projectWorkspace?: string;
  workerEntry: string;
  shellPath: string;
  env?: Record<string, string>;
}): string {
  return createHash("sha256")
    .update(JSON.stringify({
      managerRestUrl: input.managerRestUrl,
      projectId: input.projectId ?? "",
      projectWorkspace: input.projectWorkspace ?? "",
      workerEntry: workerEntryFingerprint(input.workerEntry),
      shellPath: input.shellPath,
      env: stableRecord(input.env),
    }))
    .digest("hex")
    .slice(0, 16);
}

export const _hostShellWorkerEntryFingerprintForTest = workerEntryFingerprint;

async function healthDetails(url: string): Promise<HostShellHealth | undefined> {
  try {
    const res = await fetch(`${url}/health`, { signal: AbortSignal.timeout(3_000) });
    if (!res.ok) return undefined;
    const data = await res.json() as Record<string, unknown>;
    if (
      data.status !== "running" ||
      data.service !== "manager-agent" ||
      typeof data.fingerprint !== "string" ||
      typeof data.worker_id !== "string"
    ) {
      return undefined;
    }
    return {
      fingerprint: data.fingerprint,
      processId: typeof data.process_id === "number" && Number.isSafeInteger(data.process_id)
        ? data.process_id
        : null,
      projectId: typeof data.project_id === "string" ? data.project_id : null,
      workerId: data.worker_id,
    };
  } catch {
    return undefined;
  }
}

async function health(url: string, fingerprint?: string): Promise<boolean> {
  const details = await healthDetails(url);
  return Boolean(details && (!fingerprint || details.fingerprint === fingerprint));
}

async function waitForHealth(url: string, fingerprint: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    if (await health(url, fingerprint)) return true;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return false;
}

function enrichPathForGitBash(shellPath: string, env: NodeJS.ProcessEnv): string {
  if (process.platform !== "win32") return env.PATH ?? "";
  const binDir = path.dirname(shellPath);
  const gitRoot = path.dirname(binDir);
  const usrBin = path.join(gitRoot, "usr", "bin");
  return [binDir, usrBin, env.PATH ?? ""].filter(Boolean).join(path.delimiter);
}

function processIsRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function stopProcess(record?: RunningHostShellProcess): void {
  if (!record) return;
  if (record.process && !record.process.killed) {
    try {
      record.process.kill("SIGTERM");
      return;
    } catch {
      // Fall through to the persisted PID.
    }
  }
  if (!processIsRunning(record.processId)) return;
  try {
    process.kill(record.processId, "SIGTERM");
  } catch {
    // Best-effort.
  }
}

async function waitForFingerprintToStop(url: string, fingerprint: string, timeoutMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    const current = await healthDetails(url);
    if (!current || current.fingerprint !== fingerprint) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

async function waitForProcessToStop(pid: number, timeoutMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    if (!processIsRunning(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
}

function stateMatchesHealth(
  state: PersistedHostShellProcess,
  observed: HostShellHealth,
  projectId: string | undefined,
): boolean {
  return state.port === hostPort(projectId) &&
    state.processName === processName(projectId) &&
    state.workerId === workerId(projectId) &&
    state.projectId === (projectId ?? null) &&
    state.fingerprint === observed.fingerprint &&
    observed.workerId === state.workerId &&
    observed.projectId === state.projectId &&
    (observed.processId === null || observed.processId === state.pid);
}

function healthMatchesProject(observed: HostShellHealth, projectId: string | undefined): boolean {
  return observed.workerId === workerId(projectId) && observed.projectId === (projectId ?? null);
}

async function stopPersistedProcess(
  projectId: string | undefined,
  url: string,
  stateFile: string,
  state: PersistedHostShellProcess,
  observed: HostShellHealth,
): Promise<boolean> {
  if (!stateMatchesHealth(state, observed, projectId)) return false;
  stopProcess({ processId: state.pid, fingerprint: state.fingerprint, projectId, stateFile, url });
  const [healthStopped, processStopped] = await Promise.all([
    waitForFingerprintToStop(url, state.fingerprint),
    waitForProcessToStop(state.pid),
  ]);
  const stopped = healthStopped && processStopped;
  if (stopped) removeRuntimeState(stateFile, state);
  return stopped;
}

async function ensureHostShellManagerAgentInternal(
  projectId: string | undefined,
  options: HostShellManagerAgentOptions,
): Promise<HostShellManagerAgent> {
  const diagnostics = hostShellDiagnostics();
  if (!diagnostics.available || !diagnostics.worker_entry || !diagnostics.shell_path) {
    throw new Error(diagnostics.error ?? "Host-shell Manager Agent runtime is unavailable");
  }

  const name = processName(projectId);
  const projectWorkspace = resolveProjectWorkspace(projectId);
  const processCwd = projectWorkspace ?? prepareHostWorkspace(projectId);
  const resolvedManagerRestUrl = managerRestUrl(options);
  const url = baseUrl(projectId);
  const stateFile = runtimeStatePath(projectId);
  const env: Record<string, string> = {
    MANAGER_AGENT_MODE: "1",
    MANAGER_AGENT_PORT: String(hostPort(projectId)),
    HOMERAIL_MANAGER_AGENT_RUNTIME_PLACEMENT: "host_shell",
    MANAGER_REST_URL: resolvedManagerRestUrl,
    PROJECT_ID: projectId ?? "",
    PROJECT_WORKSPACE: projectWorkspace ?? "",
    HOMERAIL_WORKER_ID: workerId(projectId),
    HOMERAIL_HOME: getHomerailHome(),
    HOMERAIL_MANAGER_AGENT_SHELL: diagnostics.shell_path,
    SHELL: diagnostics.shell_path,
    ...(options.env ?? {}),
  };
  const fingerprint = hostFingerprint({
    managerRestUrl: resolvedManagerRestUrl,
    projectId,
    projectWorkspace,
    workerEntry: diagnostics.worker_entry,
    shellPath: diagnostics.shell_path,
    env,
  });
  env.HOMERAIL_MANAGER_AGENT_FINGERPRINT = fingerprint;

  const existing = running.get(name);
  if (
    existing &&
    existing.fingerprint === fingerprint &&
    (!existing.process || !existing.process.killed) &&
    await health(url, fingerprint)
  ) {
    return { processId: existing.processId, baseUrl: url, workerId: workerId(projectId), processName: name };
  }
  const observed = await healthDetails(url);
  const persisted = readRuntimeStateFile(stateFile);
  if (!existing && observed?.fingerprint === fingerprint && healthMatchesProject(observed, projectId)) {
    const processId = persisted && stateMatchesHealth(persisted, observed, projectId) ? persisted.pid : observed.processId;
    if (processId) {
      const adoptedState: PersistedHostShellProcess = {
        version: 1,
        pid: processId,
        port: hostPort(projectId),
        fingerprint,
        processName: name,
        workerId: workerId(projectId),
        projectId: projectId ?? null,
      };
      writeRuntimeState(stateFile, adoptedState);
      running.set(name, { processId, fingerprint, projectId, stateFile, url });
    }
    return { processId: processId ?? null, baseUrl: url, workerId: workerId(projectId), processName: name };
  }
  if (existing) {
    stopProcess(existing);
    running.delete(name);
    const [healthStopped, processStopped] = await Promise.all([
      waitForFingerprintToStop(url, existing.fingerprint),
      waitForProcessToStop(existing.processId),
    ]);
    if (!healthStopped || !processStopped) {
      throw new Error(`Host-shell Manager Agent process ${existing.processId} did not stop`);
    }
    removeRuntimeState(stateFile, { pid: existing.processId, fingerprint: existing.fingerprint });
  } else if (observed) {
    if (!persisted || !await stopPersistedProcess(projectId, url, stateFile, persisted, observed)) {
      throw new Error(
        `Host-shell Manager Agent port ${hostPort(projectId)} is occupied by an unmanaged or stale process`,
      );
    }
  }

  const logDir = path.join(getDataRoot(), "logs");
  fs.mkdirSync(logDir, { recursive: true });
  const out = fs.openSync(path.join(logDir, `${name}.log`), "a");
  const err = fs.openSync(path.join(logDir, `${name}.err.log`), "a");
  const child = spawn(process.execPath, [diagnostics.worker_entry], {
    cwd: processCwd,
    detached: true,
    shell: false,
    stdio: ["ignore", out, err],
    env: {
      ...process.env,
      ...env,
      PATH: enrichPathForGitBash(diagnostics.shell_path, process.env),
    },
    windowsHide: true,
  });
  fs.closeSync(out);
  fs.closeSync(err);
  child.unref();
  if (!child.pid) {
    try {
      child.kill("SIGTERM");
    } catch {
      // Best-effort.
    }
    throw new Error("Host-shell Manager Agent process did not expose a PID");
  }
  const state: PersistedHostShellProcess = {
    version: 1,
    pid: child.pid,
    port: hostPort(projectId),
    fingerprint,
    processName: name,
    workerId: workerId(projectId),
    projectId: projectId ?? null,
  };
  running.set(name, { process: child, processId: child.pid, fingerprint, projectId, stateFile, url });
  try {
    writeRuntimeState(stateFile, state);
  } catch (err) {
    stopProcess(running.get(name));
    running.delete(name);
    throw err;
  }
  child.once("exit", () => {
    if (running.get(name)?.process === child) running.delete(name);
    removeRuntimeState(stateFile, state);
  });

  const healthy = await waitForHealth(url, fingerprint, options.healthTimeoutMs ?? options.startTimeoutMs ?? 15_000);
  if (!healthy) {
    stopProcess({ process: child, processId: child.pid, fingerprint, projectId, stateFile, url });
    running.delete(name);
    removeRuntimeState(stateFile, state);
    throw new Error("Host-shell Manager Agent did not become healthy");
  }

  return { processId: child.pid ?? null, baseUrl: url, workerId: workerId(projectId), processName: name };
}

export async function ensureHostShellManagerAgent(
  projectId: string | undefined,
  options: HostShellManagerAgentOptions,
): Promise<HostShellManagerAgent> {
  const name = processName(projectId);
  const inflight = starting.get(name);
  if (inflight) return inflight;
  const promise = ensureHostShellManagerAgentInternal(projectId, options);
  starting.set(name, promise);
  try {
    return await promise;
  } finally {
    if (starting.get(name) === promise) starting.delete(name);
  }
}

export async function shutdownHostShellManagerAgents(): Promise<void> {
  const entries = [...running.values()];
  running.clear();
  await Promise.all(entries.map(async (record) => {
    stopProcess(record);
    const [healthStopped, processStopped] = await Promise.all([
      waitForFingerprintToStop(record.url, record.fingerprint, 2_000),
      waitForProcessToStop(record.processId, 2_000),
    ]);
    if (healthStopped && processStopped) {
      removeRuntimeState(record.stateFile, { pid: record.processId, fingerprint: record.fingerprint });
    }
  }));
}

export function _forgetHostShellManagerAgentsForTest(): void {
  running.clear();
  starting.clear();
}

export async function forwardChatToHostShellManagerAgent(
  agent: HostShellManagerAgent,
  payload: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const res = await fetch(`${agent.baseUrl}/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(300_000),
  });
  const text = await res.text();
  let body: unknown = text;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { raw: text };
  }
  if (!res.ok) throw new Error(`Host-shell Manager Agent HTTP ${res.status}: ${JSON.stringify(body).slice(0, 1000)}`);
  return body as Record<string, unknown>;
}
