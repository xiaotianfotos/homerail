import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { accessSync, constants, lstatSync, mkdirSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { normalizeWorkspaceAccess } from "homerail-protocol";
import { assertWorkspacePreparationBoundary } from "../storage/mount-policy.js";
import { prepareWorkerWorkspace } from "../storage/workspace-prepare.js";
import { materializeWorkspaceInputs } from "../storage/workspace-inputs.js";
import { resolveHomerailHome } from "../platform/paths.js";
import { assertSecureControlPlaneUrl } from "../control-plane/security.js";
import type { ContainerInfo } from "../providers/types.js";

export const NATIVE_CODEX_EXECUTION_MODE = "native_codex_subscription";
export const NATIVE_CODEX_CAPABILITY = "native-codex-subscription";
const ID_PREFIX = "native-codex-worker-";
const REMOTE_ENV_KEYS = new Set(["MANAGER_WORKER_WS_URL", "HOMERAIL_WORKER_ID", "HOMERAIL_WORKER_TOKEN", "AGENT_BACKEND"]);
const SPEC_KEYS = new Set([
  "execution_mode", "workspace_id", "workspace", "workspace_read_only", "workspace_access",
  "workspace_inputs", "workspace_git_metadata_read_only", "codex_nested_sandbox", "env", "labels",
]);

export interface NativeCodexWorkerOptions {
  managerUrl: string;
  projectId: string;
  env?: NodeJS.ProcessEnv;
}

interface WorkerRecord {
  info: ContainerInfo;
  workspace: string;
  env: NodeJS.ProcessEnv;
  child?: ChildProcess;
  exited?: Promise<void>;
  stopping?: Promise<void>;
  starting?: Promise<void>;
}

function inside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function configuredPath(env: NodeJS.ProcessEnv, name: string, directory: boolean): string {
  const value = env[name]?.trim();
  if (!value || !path.isAbsolute(value)) throw new Error(`${name} must be a local absolute path`);
  const resolved = realpathSync(value);
  const stat = statSync(resolved);
  if (directory ? !stat.isDirectory() : !stat.isFile()) throw new Error(`${name} has the wrong file type`);
  return resolved;
}

function privateDirectory(directory: string): string {
  let current = path.parse(directory).root;
  for (const segment of directory.slice(current.length).split(path.sep)) {
    current = path.join(current, segment);
    try {
      const stat = lstatSync(current);
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("Native Codex state directory must not traverse symlinks or files");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      mkdirSync(current, { mode: 0o700 });
    }
  }
  const final = statSync(directory);
  if ((final.mode & 0o077) !== 0 || (process.getuid && final.uid !== process.getuid())) {
    throw new Error("Native Codex state directory must be private and owned by the Node user");
  }
  return realpathSync(directory);
}

/** Node-owned, on-demand Workers. The ordinary Docker provider is never used
 * for this opt-in path; the existing Worker owns all task transport semantics. */
export class NativeCodexWorkerService {
  private readonly records = new Map<string, WorkerRecord>();
  private readonly localEnv: NodeJS.ProcessEnv;
  private readonly codexHome: string;
  private readonly codexBin: string;
  private readonly workerEntry: string;
  private readonly stateDir: string;
  private readonly runtimeDir: string;
  private readonly managerUrl: URL;

  constructor(private readonly options: NativeCodexWorkerOptions) {
    const env = { ...(options.env ?? process.env) };
    if (env.HOMERAIL_CODEX_SUBSCRIPTION_ENABLED !== "1") throw new Error("Native Codex subscription is not enabled on this Node");
    if (process.platform === "win32") throw new Error("Native Codex Worker process containment currently requires POSIX");
    this.codexHome = configuredPath(env, "HOMERAIL_CODEX_SUBSCRIPTION_HOME", true);
    this.codexBin = configuredPath(env, "HOMERAIL_CODEX_SUBSCRIPTION_BIN", false);
    accessSync(this.codexBin, constants.X_OK);
    this.workerEntry = configuredPath(env, "HOMERAIL_CODEX_SUBSCRIPTION_WORKER_ENTRY", false);
    if (!/\.(?:m?js)$/.test(this.workerEntry)) throw new Error("Native Codex Worker entry must be a built JavaScript file");
    const home = path.resolve(env.HOMERAIL_HOME || resolveHomerailHome());
    const workspaceTree = path.join(home, "workspace");
    const runtimeDir = path.join(home, "node", "runtime", NATIVE_CODEX_EXECUTION_MODE);
    const stateDir = env.HOMERAIL_CODEX_SUBSCRIPTION_STATE_DIR?.trim() || path.join(runtimeDir, "sessions");
    if (!path.isAbsolute(stateDir)) throw new Error("HOMERAIL_CODEX_SUBSCRIPTION_STATE_DIR must be absolute");
    if (inside(workspaceTree, path.resolve(stateDir)) || inside(workspaceTree, this.codexHome)
      || inside(this.codexHome, path.resolve(stateDir)) || inside(path.resolve(stateDir), this.codexHome)) {
      throw new Error("Native Codex state and account home must be outside Worker workspaces and separate from one another");
    }
    this.runtimeDir = privateDirectory(runtimeDir);
    this.stateDir = privateDirectory(path.resolve(stateDir));
    this.managerUrl = new URL(options.managerUrl);
    assertSecureControlPlaneUrl(options.managerUrl, env.HOMERAIL_ALLOW_INSECURE_REMOTE_WS === "1");
    if (this.managerUrl.username || this.managerUrl.password || this.managerUrl.search || this.managerUrl.hash) {
      throw new Error("Native Codex Manager URL must not contain credentials, query, or fragment");
    }
    this.localEnv = {};
    for (const key of ["PATH", "HOME", "LANG", "LC_ALL", "TMPDIR", "TZ"] as const) {
      if (env[key]) this.localEnv[key] = env[key];
    }
    this.localEnv.HOMERAIL_HOME = home;
    if (env.HOMERAIL_ALLOW_INSECURE_REMOTE_WS === "1") this.localEnv.HOMERAIL_ALLOW_INSECURE_REMOTE_WS = "1";
  }

  static isWorkerId(id: unknown): id is string {
    return typeof id === "string" && id.startsWith(ID_PREFIX);
  }

  async create(spec: Record<string, unknown>): Promise<ContainerInfo> {
    for (const [key, value] of Object.entries(spec)) {
      if (value !== undefined && !SPEC_KEYS.has(key)) throw new Error(`Native Codex Worker does not accept spec.${key}`);
    }
    if (spec.execution_mode !== NATIVE_CODEX_EXECUTION_MODE) throw new Error("Native Codex Worker requires explicit execution_mode");
    if (spec.workspace_read_only !== true || spec.workspace_access === undefined
      || normalizeWorkspaceAccess(spec.workspace_access).writable_paths.length !== 0) {
      throw new Error("Native Codex Worker requires a read-only workspace with no writable paths");
    }
    if (spec.codex_nested_sandbox === true) throw new Error("Native Codex Worker does not accept Docker sandbox options");
    const workspaceId = spec.workspace_id;
    if (typeof workspaceId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(workspaceId)) {
      throw new Error("Native Codex Worker requires a safe run workspace_id");
    }
    const workspace = spec.workspace;
    if (workspace !== undefined && (!workspace || typeof workspace !== "object" || Array.isArray(workspace)
      || Object.keys(workspace).some((key) => key !== "mode")
      || !["isolated", "shared"].includes(String((workspace as Record<string, unknown>).mode)))) {
      throw new Error("Native Codex Worker workspace accepts only isolated/shared mode; host paths are local configuration");
    }
    const env = spec.env;
    if (!env || typeof env !== "object" || Array.isArray(env)) throw new Error("Native Codex Worker requires control-plane env");
    const remote = env as Record<string, unknown>;
    for (const [key, value] of Object.entries(remote)) {
      if (!REMOTE_ENV_KEYS.has(key) || typeof value !== "string" || value.includes("\0")) {
        throw new Error(`Native Codex Worker does not accept environment key ${key}`);
      }
    }
    if (remote.AGENT_BACKEND !== undefined && remote.AGENT_BACKEND !== "codex_appserver") throw new Error("Native Codex Worker backend must be codex_appserver");
    const workerId = remote.HOMERAIL_WORKER_ID;
    if (typeof workerId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,299}$/.test(workerId)) throw new Error("Native Codex Worker id is invalid");
    const expectedUrl = `${this.managerUrl.href.replace(/\/$/, "")}/ws/projects/${encodeURIComponent(this.options.projectId)}/workers/${encodeURIComponent(workerId)}`;
    if (remote.MANAGER_WORKER_WS_URL !== expectedUrl) throw new Error("Native Codex Worker callback must match the configured Node Manager and project");
    assertWorkspacePreparationBoundary(workspaceId);
    const prepared = await prepareWorkerWorkspace(workspaceId, workspace ?? { mode: "isolated" });
    assertWorkspacePreparationBoundary(workspaceId);
    materializeWorkspaceInputs(workspaceId, spec.workspace_inputs);
    const id = `${ID_PREFIX}${randomUUID()}`;
    const audit = privateDirectory(path.join(this.runtimeDir, "audit", id));
    const record: WorkerRecord = {
      info: { id, status: "created", labels: { "homerail.resource_type": "worker", "homerail.execution_mode": NATIVE_CODEX_EXECUTION_MODE } },
      workspace: prepared.root,
      env: {
        ...this.localEnv,
        HOMERAIL_WORKER_ID: workerId,
        MANAGER_WORKER_WS_URL: expectedUrl,
        ...(typeof remote.HOMERAIL_WORKER_TOKEN === "string" ? { HOMERAIL_WORKER_TOKEN: remote.HOMERAIL_WORKER_TOKEN } : {}),
        AGENT_BACKEND: "codex_appserver",
        HOMERAIL_WORKER_CAPABILITIES: NATIVE_CODEX_CAPABILITY,
        WORKSPACE: prepared.root,
        HOMERAIL_AUDIT_DIR: audit,
        HOMERAIL_CODEX_SUBSCRIPTION_ENABLED: "1",
        HOMERAIL_CODEX_SUBSCRIPTION_HOME: this.codexHome,
        HOMERAIL_CODEX_SUBSCRIPTION_BIN: this.codexBin,
        HOMERAIL_CODEX_SUBSCRIPTION_STATE_DIR: this.stateDir,
      },
    };
    this.records.set(id, record);
    return { ...record.info };
  }

  inspect(id: string): ContainerInfo {
    return { ...this.record(id).info };
  }

  async start(id: string): Promise<void> {
    const record = this.record(id);
    if (record.info.status === "stopped") throw new Error("Native Codex Worker cannot restart after termination; provision a new Worker");
    if (record.starting) return record.starting;
    record.starting = this.startRecord(record);
    return record.starting;
  }

  private async startRecord(record: WorkerRecord): Promise<void> {
    if (record.info.status === "running") return;
    if (record.info.status !== "created") throw new Error("Native Codex Worker cannot restart after termination; provision a new Worker");
    const child = spawn(process.execPath, [this.workerEntry], {
      cwd: record.workspace, env: record.env, stdio: "ignore", shell: false, detached: true,
    });
    record.child = child;
    record.exited = new Promise((resolve) => {
      const finished = (code: number | null) => {
        record.info.status = "stopped";
        record.info.finishedAt = new Date().toISOString();
        if (code !== null) record.info.exitCode = code;
        resolve();
      };
      child.once("exit", finished);
      child.once("error", () => finished(null));
    });
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", () => {
        record.info.status = "running";
        record.info.startedAt = new Date().toISOString();
        resolve();
      });
      child.once("error", () => reject(new Error("Native Codex Worker failed to start")));
    });
  }

  async stop(id: string): Promise<void> {
    const record = this.record(id);
    if (record.stopping) return record.stopping;
    record.stopping = this.stopRecord(record);
    return record.stopping;
  }

  private async stopRecord(record: WorkerRecord): Promise<void> {
    const pid = record.child?.pid;
    if (!pid) { record.info.status = "stopped"; return; }
    const signal = (value: NodeJS.Signals) => {
      try { process.kill(-pid, value); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
    };
    // Let the Worker drive turn/interrupt, await its ACK and release the native
    // session lease. Signalling Codex simultaneously can cut that finally short.
    try { process.kill(pid, "SIGTERM"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([record.exited, new Promise<void>((resolve) => { timer = setTimeout(resolve, 10_000); })]);
    if (timer) clearTimeout(timer);
    // Also reap descendants when the Worker exited before its Codex child.
    signal("SIGKILL");
    await record.exited;
    record.info.status = "stopped";
  }

  async remove(id: string): Promise<void> {
    const record = this.record(id);
    await this.stop(id);
    record.info.status = "removed";
    this.records.delete(id);
    // Native account home, session mappings, audit and run workspaces persist.
  }

  async close(): Promise<void> {
    await Promise.allSettled([...this.records.keys()].map((id) => this.remove(id)));
  }

  private record(id: string): WorkerRecord {
    const record = this.records.get(id);
    if (!record) throw new Error("Native Codex Worker is not owned by this Node instance");
    return record;
  }
}

export function resolveNativeCodexWorkerService(options: NativeCodexWorkerOptions): NativeCodexWorkerService | undefined {
  const env = options.env ?? process.env;
  return env.HOMERAIL_CODEX_SUBSCRIPTION_ENABLED === "1" ? new NativeCodexWorkerService(options) : undefined;
}
