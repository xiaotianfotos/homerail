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

const HOST_AGENT_PORT_BASE = 59000;
const HOST_AGENT_PORT_SPAN = 5000;

const running = new Map<string, { process: ChildProcess; fingerprint: string }>();

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

async function health(url: string, fingerprint?: string): Promise<boolean> {
  try {
    const res = await fetch(`${url}/health`, { signal: AbortSignal.timeout(3_000) });
    if (!res.ok) return false;
    const data = await res.json() as Record<string, unknown>;
    if (data.status !== "running" || data.service !== "manager-agent") return false;
    return fingerprint ? data.fingerprint === fingerprint : true;
  } catch {
    return false;
  }
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

function stopProcess(record?: { process: ChildProcess }): void {
  if (!record?.process || record.process.killed) return;
  try {
    record.process.kill();
  } catch {
    // Best-effort.
  }
}

export async function ensureHostShellManagerAgent(
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
  if (existing && existing.fingerprint === fingerprint && !existing.process.killed && await health(url, fingerprint)) {
    return { processId: existing.process.pid ?? null, baseUrl: url, workerId: workerId(projectId), processName: name };
  }
  if (!existing && await health(url, fingerprint)) {
    return { processId: null, baseUrl: url, workerId: workerId(projectId), processName: name };
  }
  if (existing) {
    stopProcess(existing);
    running.delete(name);
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
  running.set(name, { process: child, fingerprint });

  const healthy = await waitForHealth(url, fingerprint, options.healthTimeoutMs ?? options.startTimeoutMs ?? 15_000);
  if (!healthy) {
    stopProcess({ process: child });
    running.delete(name);
    throw new Error("Host-shell Manager Agent did not become healthy");
  }

  return { processId: child.pid ?? null, baseUrl: url, workerId: workerId(projectId), processName: name };
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
