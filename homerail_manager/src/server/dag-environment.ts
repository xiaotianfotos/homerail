import { spawn, execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  HOMERAIL_WORKER_CREATED_LABEL,
  HOMERAIL_WORKER_IMAGE,
  HOMERAIL_WORKER_PROTOCOL_LABEL,
  HOMERAIL_WORKER_REVISION_LABEL,
  HOMERAIL_WORKER_SOURCE_LABEL,
  HOMERAIL_WORKER_VERSION_LABEL,
  WORKER_CONTRACT_VERSION,
} from "homerail-protocol";
import { getHomerailHome } from "../config/env.js";
import { emit } from "../events/bus.js";
import { getAllWorkers } from "../worker/registry.js";
import { dagResourceStatusPath } from "./dag-resource-status.js";
import {
  normalizeWorkerBuildNetworkSummary,
  resolveWorkerBuildNetwork,
  workerBuildNetworkDockerArgs,
  workerBuildNetworkSummary,
  type WorkerBuildNetworkConfig,
  type WorkerBuildNetworkSummary,
} from "./worker-build-network.js";

const SOURCE_INPUTS = [
  "homerail_worker/Dockerfile",
  "homerail_worker/native/codex-secret-guard.c",
  "homerail_worker/scripts/configure-apt-sources.mjs",
  "homerail_worker/package.json",
  "homerail_worker/package-lock.json",
  "homerail_worker/tsconfig.json",
  "homerail_worker/dsh",
  "homerail_worker/src",
  "homerail_protocol/package.json",
  "homerail_protocol/package-lock.json",
  "homerail_protocol/tsconfig.json",
  "homerail_protocol/src",
  "homerail_plugin_sdk/package.json",
  "homerail_plugin_sdk/package-lock.json",
  "homerail_manager/package.json",
  "homerail_manager/package-lock.json",
  "homerail_node/package.json",
  "homerail_node/package-lock.json",
  "homerail_cli/package.json",
  "homerail_cli/package-lock.json",
  "agent-ui/package.json",
  "agent-ui/package-lock.json",
] as const;
const DEPENDENCY_METADATA_PACKAGES = [
  "homerail_worker",
  "homerail_protocol",
  "homerail_plugin_sdk",
  "homerail_manager",
  "homerail_node",
  "homerail_cli",
  "agent-ui",
] as const;
const MAX_BUILD_LOG_LINES = 240;
const DEFAULT_BUILD_TIMEOUT_MS = 30 * 60_000;

export type DagEnvironmentReasonCode =
  | "docker_cli_missing"
  | "docker_daemon_unavailable"
  | "docker_permission_denied"
  | "docker_linux_engine_required"
  | "docker_check_failed"
  | "worker_source_unavailable"
  | "worker_image_missing"
  | "worker_image_stale"
  | "worker_image_incompatible"
  | "worker_build_network_invalid"
  | "worker_image_build_failed";

export type ImageCompatibility = "current" | "stale" | "incompatible" | "unknown";

export interface DagEnvironmentImage {
  id: string;
  tags: string[];
  created_at?: string;
  size_bytes?: number;
  os?: string;
  architecture?: string;
  source_fingerprint?: string;
  worker_version?: string;
  protocol_version?: string;
  image_revision?: string;
  compatibility: ImageCompatibility;
  selected: boolean;
}

export interface DagEnvironmentWorker {
  worker_id: string;
  status: string;
  registered_at: number;
  worker_version?: string;
  protocol_version?: string;
  source_fingerprint?: string;
  image_revision?: string;
  compatibility: ImageCompatibility;
}

export interface DagEnvironmentBuild {
  operation_id: string;
  status: "queued" | "running" | "succeeded" | "failed";
  started_at: number;
  finished_at?: number;
  logs: string[];
  error?: string;
}

export interface DagEnvironmentStatus {
  revision: number;
  updated_at: number;
  platform: NodeJS.Platform;
  docker: {
    status: "unknown" | "checking" | "ready" | "error";
    reason_code?: DagEnvironmentReasonCode;
    message: string;
    client_version?: string;
    server_version?: string;
    os_type?: string;
    architecture?: string;
    checked_at?: number;
  };
  source: {
    available: boolean;
    repo_root: string;
    fingerprint?: string;
    worker_version?: string;
    protocol_version: string;
    image_revision?: string;
  };
  worker_image: {
    status: "unknown" | "checking" | "building" | "ready" | "error" | "skipped";
    image: string;
    reason?: string;
    reason_code?: DagEnvironmentReasonCode;
    message: string;
    started_at?: number;
    updated_at?: number;
    error?: string;
    compatibility?: ImageCompatibility;
    build_network?: WorkerBuildNetworkSummary;
  };
  images: DagEnvironmentImage[];
  workers: DagEnvironmentWorker[];
  build?: DagEnvironmentBuild;
}

interface CommandResult {
  stdout: string;
  stderr: string;
}

export type DagEnvironmentCommandRunner = (
  command: string,
  args: string[],
  options: { cwd?: string; timeoutMs?: number },
) => Promise<CommandResult>;

export type DagEnvironmentSpawn = (
  command: string,
  args: string[],
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    windowsHide: boolean;
  },
) => ReturnType<typeof spawn>;

interface ActiveBuildProcess {
  operationId: string;
  child: ReturnType<typeof spawn>;
  timeout: ReturnType<typeof setTimeout>;
}

export interface DagEnvironmentControllerOptions {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  commandRunner?: DagEnvironmentCommandRunner;
  spawnImpl?: DagEnvironmentSpawn;
  now?: () => number;
  repoRoot?: string;
  statusPath?: string;
  workerImage?: string;
  buildTimeoutMs?: number;
}

class CommandFailure extends Error {
  readonly code?: string | number;
  readonly stderr: string;
  readonly stdout: string;

  constructor(message: string, input: { code?: string | number; stderr?: string; stdout?: string } = {}) {
    super(message);
    this.code = input.code;
    this.stderr = input.stderr ?? "";
    this.stdout = input.stdout ?? "";
  }
}

function defaultCommandRunner(
  command: string,
  args: string[],
  options: { cwd?: string; timeoutMs?: number },
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    execFile(command, args, {
      cwd: options.cwd,
      encoding: "utf8",
      env: { ...process.env, LANG: "C", LC_ALL: "C" },
      maxBuffer: 8 * 1024 * 1024,
      timeout: options.timeoutMs ?? 15_000,
      windowsHide: true,
    }, (error, stdout, stderr) => {
      if (error) {
        const code = (error as NodeJS.ErrnoException).code;
        reject(new CommandFailure(error.message, {
          code,
          stdout: String(stdout ?? ""),
          stderr: String(stderr ?? ""),
        }));
        return;
      }
      resolve({ stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
    });
  });
}

function defaultSpawn(
  command: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; windowsHide: boolean },
): ReturnType<typeof spawn> {
  return spawn(command, args, {
    ...options,
    stdio: ["ignore", "pipe", "pipe"],
    shell: false,
  });
}

export function resolveDagEnvironmentRepoRoot(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.HOMERAIL_REPO_ROOT?.trim();
  if (configured) return path.resolve(configured);
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "../../..");
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function fingerprintContent(relativePath: string, content: Buffer): Buffer | string {
  const normalizedPath = relativePath.split(path.sep).join("/");
  const isPackageJson = DEPENDENCY_METADATA_PACKAGES
    .some((packageName) => normalizedPath === `${packageName}/package.json`);
  const isPackageLock = DEPENDENCY_METADATA_PACKAGES
    .some((packageName) => normalizedPath === `${packageName}/package-lock.json`);
  if (!isPackageJson && !isPackageLock) return content;

  try {
    const parsed = JSON.parse(content.toString("utf8")) as Record<string, unknown>;
    delete parsed.version;
    if (isPackageLock && typeof parsed.packages === "object" && parsed.packages !== null) {
      const packages = parsed.packages as Record<string, unknown>;
      for (const workspacePath of ["", "../homerail_protocol", "../homerail_plugin_sdk"]) {
        const metadata = packages[workspacePath];
        if (typeof metadata === "object" && metadata !== null) {
          delete (metadata as Record<string, unknown>).version;
        }
      }
    }
    return stableJson(parsed);
  } catch {
    // Invalid package metadata must still affect the fingerprint and surface in
    // the later build instead of being silently ignored.
    return content;
  }
}

function addPathToHash(hash: ReturnType<typeof createHash>, repoRoot: string, relativePath: string): void {
  const absolutePath = path.join(repoRoot, relativePath);
  if (!fs.existsSync(absolutePath)) return;
  const stat = fs.statSync(absolutePath);
  if (stat.isDirectory()) {
    for (const name of fs.readdirSync(absolutePath).sort()) {
      addPathToHash(hash, repoRoot, path.join(relativePath, name));
    }
    return;
  }
  if (!stat.isFile()) return;
  hash.update(relativePath.split(path.sep).join("/"));
  hash.update("\0");
  hash.update(fingerprintContent(relativePath, fs.readFileSync(absolutePath)));
  hash.update("\0");
}

export function dagWorkerSourceFingerprint(repoRoot: string): string | undefined {
  if (!SOURCE_INPUTS.every((entry) => fs.existsSync(path.join(repoRoot, entry)))) return undefined;
  const hash = createHash("sha256");
  for (const relativePath of SOURCE_INPUTS) addPathToHash(hash, repoRoot, relativePath);
  return hash.digest("hex").slice(0, 16);
}

function readPackageVersion(repoRoot: string): string | undefined {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(repoRoot, "homerail_worker", "package.json"), "utf8")) as {
      version?: unknown;
    };
    return typeof raw.version === "string" && raw.version.trim() ? raw.version.trim() : undefined;
  } catch {
    return undefined;
  }
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() && value !== "<no value>" && value !== "unknown"
    ? value.trim()
    : undefined;
}

function dockerReason(error: unknown, platform: NodeJS.Platform): {
  code: DagEnvironmentReasonCode;
  message: string;
} {
  const failure = error instanceof CommandFailure ? error : undefined;
  const errorCode = failure?.code
    ?? (typeof error === "object" && error !== null && "code" in error
      ? (error as { code?: unknown }).code
      : undefined);
  const text = `${failure?.message ?? String(error)} ${failure?.stderr ?? ""} ${failure?.stdout ?? ""}`.toLowerCase();
  if (errorCode === "ENOENT" || text.includes("enoent") || text.includes("not recognized as an internal")) {
    return { code: "docker_cli_missing", message: "Docker CLI is not installed or is not available on PATH." };
  }
  if (
    errorCode === "EACCES"
    || errorCode === "EPERM"
    || text.includes("permission denied")
    || text.includes("access is denied")
  ) {
    return { code: "docker_permission_denied", message: "HomeRail does not have permission to access the Docker engine." };
  }
  if (
    errorCode === "ECONNREFUSED"
    || text.includes("cannot connect to the docker daemon")
    || text.includes("is the docker daemon running")
    || text.includes("dockerdesktoplinuxengine")
    || text.includes("open //./pipe/docker")
    || text.includes("error during connect")
  ) {
    return {
      code: "docker_daemon_unavailable",
      message: platform === "win32"
        ? "Docker Desktop is installed, but its Linux engine is not running."
        : "Docker is installed, but its engine is not running.",
    };
  }
  return { code: "docker_check_failed", message: "Docker environment check failed." };
}

function parseJsonLines(raw: string): Array<Record<string, unknown>> {
  const values: Array<Record<string, unknown>> = [];
  for (const line of raw.split(/\r?\n/).map((entry) => entry.trim()).filter(Boolean)) {
    try {
      const parsed = JSON.parse(line) as unknown;
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        values.push(parsed as Record<string, unknown>);
      }
    } catch {
      // Ignore a malformed row and keep the rest of Docker's inventory.
    }
  }
  return values;
}

function hasDockerLabel(labels: string, key: string): boolean {
  return labels
    .split(",")
    .some((entry) => entry === key || entry.startsWith(`${key}=`));
}

function compatibleWithSource(
  protocolVersion: string | undefined,
  fingerprint: string | undefined,
  sourceFingerprint: string | undefined,
): ImageCompatibility {
  if (protocolVersion && protocolVersion !== WORKER_CONTRACT_VERSION) return "incompatible";
  if (!sourceFingerprint) return "unknown";
  if (!protocolVersion) return "stale";
  if (!fingerprint) return "stale";
  return fingerprint === sourceFingerprint ? "current" : "stale";
}

function defaultStatus(
  repoRoot: string,
  workerImage: string,
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
): DagEnvironmentStatus {
  const fingerprint = dagWorkerSourceFingerprint(repoRoot);
  return {
    revision: 0,
    updated_at: Date.now(),
    platform,
    docker: {
      status: "unknown",
      message: "Docker environment has not been checked yet.",
    },
    source: {
      available: Boolean(fingerprint),
      repo_root: repoRoot,
      fingerprint,
      worker_version: readPackageVersion(repoRoot),
      protocol_version: WORKER_CONTRACT_VERSION,
      image_revision: nonEmpty(env.HOMERAIL_BUILD_REVISION) ?? nonEmpty(env.GITHUB_SHA),
    },
    worker_image: {
      status: "unknown",
      image: workerImage,
      message: "DAG worker image status has not been checked yet.",
    },
    images: [],
    workers: [],
  };
}

function cloneStatus(status: DagEnvironmentStatus): DagEnvironmentStatus {
  return structuredClone(status);
}

export class DagEnvironmentController {
  private readonly env: NodeJS.ProcessEnv;
  private readonly platform: NodeJS.Platform;
  private readonly commandRunner: DagEnvironmentCommandRunner;
  private readonly spawnImpl: DagEnvironmentSpawn;
  private readonly now: () => number;
  private readonly repoRoot: string;
  private readonly statusPath: string;
  private readonly workerImage: string;
  private readonly buildTimeoutMs: number;
  private readonly buildNetworkConfig?: WorkerBuildNetworkConfig;
  private readonly buildNetworkError?: Error;
  private persistedBuildNetworkSummary?: WorkerBuildNetworkSummary;
  private status: DagEnvironmentStatus;
  private checkPromise: Promise<DagEnvironmentStatus> | null = null;
  private monitorTimer: ReturnType<typeof setInterval> | null = null;
  private buildCommitTimer: ReturnType<typeof setTimeout> | null = null;
  private activeBuildProcess: ActiveBuildProcess | null = null;
  private checkEpoch = 0;
  private shuttingDown = false;

  constructor(options: DagEnvironmentControllerOptions = {}) {
    this.env = options.env ?? process.env;
    this.platform = options.platform ?? process.platform;
    this.commandRunner = options.commandRunner ?? defaultCommandRunner;
    this.spawnImpl = options.spawnImpl ?? defaultSpawn;
    this.now = options.now ?? Date.now;
    this.repoRoot = options.repoRoot ?? resolveDagEnvironmentRepoRoot(this.env);
    this.statusPath = options.statusPath ?? dagResourceStatusPath();
    this.workerImage = nonEmpty(options.workerImage)
      ?? nonEmpty(this.env.HOMERAIL_WORKER_IMAGE)
      ?? HOMERAIL_WORKER_IMAGE;
    this.buildTimeoutMs = Math.max(1, options.buildTimeoutMs ?? DEFAULT_BUILD_TIMEOUT_MS);
    try {
      this.buildNetworkConfig = resolveWorkerBuildNetwork(this.env);
    } catch (error) {
      this.buildNetworkError = error instanceof Error ? error : new Error(String(error));
    }
    this.status = this.readPersistedStatus();
    this.persistedBuildNetworkSummary = this.status.worker_image.build_network;
  }

  getStatus(): DagEnvironmentStatus {
    const sourceFingerprint = dagWorkerSourceFingerprint(this.repoRoot);
    this.status.source = {
      ...this.status.source,
      available: Boolean(sourceFingerprint),
      fingerprint: sourceFingerprint,
      worker_version: readPackageVersion(this.repoRoot),
      protocol_version: WORKER_CONTRACT_VERSION,
    };
    this.status.workers = this.connectedWorkers(sourceFingerprint);
    this.applyBuildNetworkStatus();
    return cloneStatus(this.status);
  }

  startMonitoring(intervalMs = 60_000): void {
    if (this.monitorTimer || this.shuttingDown) return;
    void this.check();
    this.monitorTimer = setInterval(() => void this.check(), intervalMs);
    this.monitorTimer.unref?.();
  }

  stopMonitoring(): void {
    if (this.monitorTimer) {
      clearInterval(this.monitorTimer);
      this.monitorTimer = null;
    }
  }

  shutdown(): void {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    this.checkEpoch += 1;
    this.stopMonitoring();
    this.abortBuild("Manager shutdown interrupted the Docker build.");
  }

  check(): Promise<DagEnvironmentStatus> {
    if (this.shuttingDown) return Promise.resolve(this.getStatus());
    if (this.checkPromise) return this.checkPromise;
    const epoch = this.checkEpoch;
    this.checkPromise = this.runCheck(epoch).finally(() => {
      this.checkPromise = null;
    });
    return this.checkPromise;
  }

  startBuild(): DagEnvironmentStatus {
    if (this.shuttingDown) return this.getStatus();
    if (this.status.build?.status === "queued" || this.status.build?.status === "running") {
      return this.getStatus();
    }
    const startedAt = this.now();
    this.status.build = {
      operation_id: `worker-image-${startedAt}-${randomUUID().slice(0, 8)}`,
      status: "queued",
      started_at: startedAt,
      logs: [],
    };
    this.status.worker_image = {
      status: "building",
      image: this.workerImage,
      reason: "requested",
      message: "Worker image build is queued.",
      started_at: startedAt,
      updated_at: startedAt,
    };
    this.commit();
    void this.runBuild();
    return this.getStatus();
  }

  refreshConnectedWorkers(): DagEnvironmentStatus {
    const workers = this.connectedWorkers(dagWorkerSourceFingerprint(this.repoRoot));
    if (JSON.stringify(workers) !== JSON.stringify(this.status.workers)) {
      this.status.workers = workers;
      this.commit();
    }
    return this.getStatus();
  }

  private async runCheck(epoch: number): Promise<DagEnvironmentStatus> {
    if (this.status.build?.status !== "queued" && this.status.build?.status !== "running") {
      this.status.docker = {
        ...this.status.docker,
        status: "checking",
        message: "Checking Docker environment.",
      };
      this.status.worker_image = {
        ...this.status.worker_image,
        status: "checking",
        message: "Checking DAG worker images.",
        updated_at: this.now(),
      };
      this.commit();
    }

    let version: Record<string, unknown>;
    try {
      const result = await this.commandRunner("docker", ["version", "--format", "{{json .}}"], {
        cwd: os.tmpdir(),
        timeoutMs: 15_000,
      });
      if (!this.isCheckCurrent(epoch)) return this.getStatus();
      version = JSON.parse(result.stdout.trim()) as Record<string, unknown>;
    } catch (error) {
      if (!this.isCheckCurrent(epoch)) return this.getStatus();
      const reason = dockerReason(error, this.platform);
      this.status.docker = {
        status: "error",
        reason_code: reason.code,
        message: reason.message,
        checked_at: this.now(),
      };
      if (this.status.build?.status !== "queued" && this.status.build?.status !== "running") {
        this.status.worker_image = {
          status: "error",
          image: this.workerImage,
          reason: reason.code,
          reason_code: reason.code,
          message: reason.message,
          updated_at: this.now(),
          error: reason.message,
        };
      }
      this.status.images = [];
      this.commit();
      return this.getStatus();
    }

    const client = typeof version.Client === "object" && version.Client !== null
      ? version.Client as Record<string, unknown>
      : {};
    const server = typeof version.Server === "object" && version.Server !== null
      ? version.Server as Record<string, unknown>
      : {};
    let info: Record<string, unknown> = {};
    try {
      const result = await this.commandRunner("docker", ["info", "--format", "{{json .}}"], {
        cwd: os.tmpdir(),
        timeoutMs: 15_000,
      });
      if (!this.isCheckCurrent(epoch)) return this.getStatus();
      info = JSON.parse(result.stdout.trim()) as Record<string, unknown>;
    } catch {
      if (!this.isCheckCurrent(epoch)) return this.getStatus();
      // `docker version` already proved the daemon is reachable. Missing info
      // fields should not make an otherwise usable engine unavailable.
    }
    const osType = nonEmpty(info.OSType) ?? nonEmpty(server.Os);
    if (osType === "windows") {
      const message = "HomeRail Worker images require Docker's Linux container engine.";
      this.status.docker = {
        status: "error",
        reason_code: "docker_linux_engine_required",
        message,
        client_version: nonEmpty(client.Version),
        server_version: nonEmpty(server.Version),
        os_type: osType,
        architecture: nonEmpty(info.Architecture) ?? nonEmpty(server.Arch),
        checked_at: this.now(),
      };
      this.status.worker_image = {
        status: "error",
        image: this.workerImage,
        reason: "docker_linux_engine_required",
        reason_code: "docker_linux_engine_required",
        message,
        updated_at: this.now(),
        error: message,
      };
      this.status.images = [];
      this.commit();
      return this.getStatus();
    }
    this.status.docker = {
      status: "ready",
      message: "Docker Linux engine is available.",
      client_version: nonEmpty(client.Version),
      server_version: nonEmpty(server.Version),
      os_type: osType,
      architecture: nonEmpty(info.Architecture) ?? nonEmpty(server.Arch),
      checked_at: this.now(),
    };

    try {
      const images = await this.inspectImages();
      if (!this.isCheckCurrent(epoch)) return this.getStatus();
      this.status.images = images;
    } catch (error) {
      if (!this.isCheckCurrent(epoch)) return this.getStatus();
      const reason = dockerReason(error, this.platform);
      this.status.images = [];
      if (!this.hasActiveBuild()) {
        this.status.worker_image = {
          status: "error",
          image: this.workerImage,
          reason: reason.code,
          reason_code: reason.code,
          message: "HomeRail could not inspect the available Worker images.",
          updated_at: this.now(),
          error: reason.message,
          compatibility: "unknown",
        };
      }
      this.commit();
      return this.getStatus();
    }
    if (!this.hasActiveBuild()) {
      const selected = this.status.images.find((image) => image.selected);
      if (!selected) {
        this.status.worker_image = {
          status: "error",
          image: this.workerImage,
          reason: "missing",
          reason_code: "worker_image_missing",
          message: `${this.workerImage} is not available.`,
          updated_at: this.now(),
          error: "The configured HomeRail Worker image has not been built.",
          compatibility: "unknown",
        };
      } else if (selected.compatibility === "incompatible") {
        this.status.worker_image = {
          status: "error",
          image: this.workerImage,
          reason: "incompatible",
          reason_code: "worker_image_incompatible",
          message: `${this.workerImage} needs to be updated before starting new DAG runs.`,
          updated_at: this.now(),
          error: "Rebuild the Worker image before starting new DAG runs.",
          compatibility: selected.compatibility,
        };
      } else if (selected.compatibility !== "current") {
        this.status.worker_image = {
          status: "error",
          image: this.workerImage,
          reason: "stale",
          reason_code: "worker_image_stale",
          message: `${this.workerImage} needs to be updated before starting new DAG runs.`,
          updated_at: this.now(),
          error: "Rebuild the Worker image before starting new DAG runs.",
          compatibility: selected.compatibility,
        };
      } else {
        this.status.worker_image = {
          status: "ready",
          image: this.workerImage,
          message: `${this.workerImage} is ready for DAG runs.`,
          updated_at: this.now(),
          compatibility: selected.compatibility,
        };
      }
    }
    this.commit();
    return this.getStatus();
  }

  private async inspectImages(): Promise<DagEnvironmentImage[]> {
    const inventory = await this.commandRunner("docker", [
      "image",
      "ls",
      "--no-trunc",
      "--format",
      "{{json .}}",
    ], { cwd: os.tmpdir(), timeoutMs: 15_000 });
    const refs = new Set<string>([this.workerImage]);
    for (const row of parseJsonLines(inventory.stdout)) {
      const repository = nonEmpty(row.Repository);
      const tag = nonEmpty(row.Tag);
      const labels = nonEmpty(row.Labels) ?? "";
      if (
        repository
        && tag
        && tag !== "<none>"
        && (
          // Generic OCI version/revision labels are intentionally excluded:
          // they do not identify an image as a HomeRail Worker.
          repository === "homerail-worker"
          || repository.endsWith("/homerail-worker")
          || hasDockerLabel(labels, HOMERAIL_WORKER_SOURCE_LABEL)
          || hasDockerLabel(labels, HOMERAIL_WORKER_PROTOCOL_LABEL)
        )
      ) {
        refs.add(`${repository}:${tag}`);
      }
    }

    const inspections: Array<Record<string, unknown>> = [];
    for (const ref of refs) {
      try {
        const result = await this.commandRunner("docker", ["image", "inspect", ref], {
          cwd: os.tmpdir(),
          timeoutMs: 15_000,
        });
        const parsed = JSON.parse(result.stdout) as unknown;
        if (Array.isArray(parsed)) {
          for (const item of parsed) {
            if (typeof item === "object" && item !== null && !Array.isArray(item)) {
              inspections.push(item as Record<string, unknown>);
            }
          }
        }
      } catch {
        // A listed image can disappear between list and inspect.
      }
    }

    const sourceFingerprint = dagWorkerSourceFingerprint(this.repoRoot);
    const byId = new Map<string, DagEnvironmentImage>();
    for (const inspection of inspections) {
      const id = nonEmpty(inspection.Id);
      if (!id) continue;
      const config = typeof inspection.Config === "object" && inspection.Config !== null
        ? inspection.Config as Record<string, unknown>
        : {};
      const labels = typeof config.Labels === "object" && config.Labels !== null
        ? config.Labels as Record<string, unknown>
        : {};
      const tags = Array.isArray(inspection.RepoTags)
        ? inspection.RepoTags.filter((tag): tag is string => typeof tag === "string")
        : [];
      const source = nonEmpty(labels[HOMERAIL_WORKER_SOURCE_LABEL]);
      const protocol = nonEmpty(labels[HOMERAIL_WORKER_PROTOCOL_LABEL]);
      const workerVersion = nonEmpty(labels[HOMERAIL_WORKER_VERSION_LABEL]);
      const image: DagEnvironmentImage = {
        id,
        tags,
        created_at: nonEmpty(inspection.Created),
        size_bytes: typeof inspection.Size === "number" ? inspection.Size : undefined,
        os: nonEmpty(inspection.Os),
        architecture: nonEmpty(inspection.Architecture),
        source_fingerprint: source,
        worker_version: workerVersion,
        protocol_version: protocol,
        image_revision: nonEmpty(labels[HOMERAIL_WORKER_REVISION_LABEL]),
        compatibility: compatibleWithSource(
          protocol,
          source,
          sourceFingerprint,
        ),
        selected: tags.includes(this.workerImage),
      };
      const previous = byId.get(id);
      if (previous) {
        previous.tags = [...new Set([...previous.tags, ...tags])];
        previous.selected ||= image.selected;
      } else {
        byId.set(id, image);
      }
    }
    return [...byId.values()].sort((left, right) => Number(right.selected) - Number(left.selected));
  }

  private async runBuild(): Promise<void> {
    const initialBuild = this.status.build;
    if (!initialBuild) return;
    const operationId = initialBuild.operation_id;
    // Invalid source configuration must fail the build before Docker starts.
    const network = this.buildNetworkConfig;
    if (!network) {
      this.failBuild(
        this.buildNetworkError?.message ?? "Worker build network configuration is invalid.",
        "worker_build_network_invalid",
        operationId,
      );
      return;
    }
    const networkSummary = workerBuildNetworkSummary(network);
    this.status.build = {
      ...initialBuild,
      status: "running",
      logs: [
        ...initialBuild.logs,
        `Worker build network: apt_main=${networkSummary.apt_main}`
          + ` apt_security=${networkSummary.apt_security}`
          + ` npm=${networkSummary.npm} dsh_git=${networkSummary.dsh_git}`
          + ` proxy=${networkSummary.proxy}`,
        "Checking Docker before build…",
      ],
    };
    this.status.worker_image.message = `Building ${this.workerImage}.`;
    this.commit();

    await this.check();
    if (!this.isBuildActive(operationId)) return;
    if (this.status.docker.status !== "ready") {
      this.failBuild(this.status.docker.message, "worker_image_build_failed", operationId);
      return;
    }
    this.status.worker_image = {
      status: "building",
      image: this.workerImage,
      reason: "requested",
      message: `Building ${this.workerImage}.`,
      started_at: this.status.build?.started_at,
      updated_at: this.now(),
    };
    this.commit();
    const fingerprint = dagWorkerSourceFingerprint(this.repoRoot);
    const workerVersion = readPackageVersion(this.repoRoot);
    if (!fingerprint || !workerVersion) {
      this.failBuild(
        "HomeRail Worker source files are unavailable in this installation.",
        "worker_source_unavailable",
        operationId,
      );
      return;
    }
    const revision = nonEmpty(this.env.HOMERAIL_BUILD_REVISION)
      ?? nonEmpty(this.env.GITHUB_SHA)
      ?? "unknown";
    const created = new Date(this.now()).toISOString();
    const args = [
      "build",
      "-f",
      "homerail_worker/Dockerfile",
      "--label", `${HOMERAIL_WORKER_SOURCE_LABEL}=${fingerprint}`,
      "--label", `${HOMERAIL_WORKER_PROTOCOL_LABEL}=${WORKER_CONTRACT_VERSION}`,
      "--label", `${HOMERAIL_WORKER_VERSION_LABEL}=${workerVersion}`,
      "--label", `${HOMERAIL_WORKER_REVISION_LABEL}=${revision}`,
      "--label", `${HOMERAIL_WORKER_CREATED_LABEL}=${created}`,
      "--build-arg", `HOMERAIL_WORKER_SOURCE_FINGERPRINT=${fingerprint}`,
      "--build-arg", `HOMERAIL_WORKER_PROTOCOL_VERSION=${WORKER_CONTRACT_VERSION}`,
      "--build-arg", `HOMERAIL_WORKER_VERSION=${workerVersion}`,
      "--build-arg", `HOMERAIL_WORKER_IMAGE_REVISION=${revision}`,
      ...workerBuildNetworkDockerArgs(network),
      "-t", this.workerImage,
      ".",
    ];

    let child: ReturnType<typeof spawn>;
    try {
      child = this.spawnImpl("docker", args, {
        cwd: this.repoRoot,
        env: { ...this.env, HOMERAIL_HOME: getHomerailHome() },
        windowsHide: true,
      });
    } catch (error) {
      this.failBuild(
        error instanceof Error ? error.message : String(error),
        "worker_image_build_failed",
        operationId,
      );
      return;
    }
    this.appendBuildLog(`Building ${this.workerImage} from ${this.repoRoot}`);
    child.stdout?.on("data", (chunk) => this.appendBuildLog(String(chunk)));
    child.stderr?.on("data", (chunk) => this.appendBuildLog(String(chunk)));
    const buildTimeout = setTimeout(() => {
      const activeProcess = this.detachBuildProcess(operationId);
      if (!activeProcess || !this.isBuildActive(operationId)) return;
      const timeoutMinutes = Math.max(1, Math.round(this.buildTimeoutMs / 60_000));
      const message = `Docker build timed out after ${timeoutMinutes} minute${timeoutMinutes === 1 ? "" : "s"}.`;
      this.failBuild(message, "worker_image_build_failed", operationId);
      try {
        activeProcess.child.kill("SIGTERM");
      } catch {
        // The process may already have exited while the timeout callback ran.
      }
    }, this.buildTimeoutMs);
    buildTimeout.unref?.();
    this.activeBuildProcess = { operationId, child, timeout: buildTimeout };
    child.once("error", (error) => {
      this.detachBuildProcess(operationId);
      this.failBuild(error.message, "worker_image_build_failed", operationId);
    });
    child.once("close", (code, signal) => {
      this.detachBuildProcess(operationId);
      const activeBuild = this.status.build;
      if (
        activeBuild?.operation_id !== operationId
        || (activeBuild.status !== "queued" && activeBuild.status !== "running")
      ) return;
      if (code !== 0) {
        this.failBuild(
          code === null
            ? `Docker build stopped by ${signal ?? "an unknown signal"}`
            : `Docker build exited with code ${code}`,
          "worker_image_build_failed",
          operationId,
        );
        return;
      }
      this.status.build = {
        ...activeBuild,
        status: "succeeded",
        finished_at: this.now(),
        logs: [...activeBuild.logs, "Worker image build completed."],
      };
      this.flushBuildCommitTimer();
      this.commit();
      void this.check();
    });
  }

  private appendBuildLog(raw: string): void {
    if (!this.status.build || this.status.build.status !== "running") return;
    const incoming = raw.split(/\r?\n/).map((line) => line.trimEnd()).filter(Boolean);
    if (!incoming.length) return;
    this.status.build.logs = [...this.status.build.logs, ...incoming].slice(-MAX_BUILD_LOG_LINES);
    if (!this.buildCommitTimer) {
      this.buildCommitTimer = setTimeout(() => {
        this.buildCommitTimer = null;
        this.commit();
      }, 150);
      this.buildCommitTimer.unref?.();
    }
  }

  private failBuild(
    message: string,
    reasonCode: DagEnvironmentReasonCode = "worker_image_build_failed",
    operationId?: string,
  ): void {
    if (
      !this.status.build
      || (operationId && this.status.build.operation_id !== operationId)
      || (this.status.build.status !== "queued" && this.status.build.status !== "running")
    ) return;
    this.status.build = {
      ...this.status.build,
      status: "failed",
      finished_at: this.now(),
      error: message,
      logs: [...this.status.build.logs, `Build failed: ${message}`].slice(-MAX_BUILD_LOG_LINES),
    };
    this.status.worker_image = {
      status: "error",
      image: this.workerImage,
      reason: reasonCode,
      reason_code: reasonCode,
      message,
      updated_at: this.now(),
      error: message,
    };
    this.flushBuildCommitTimer();
    this.commit();
  }

  private isBuildActive(operationId: string): boolean {
    return this.status.build?.operation_id === operationId
      && (this.status.build.status === "queued" || this.status.build.status === "running");
  }

  private hasActiveBuild(): boolean {
    return this.status.build?.status === "queued" || this.status.build?.status === "running";
  }

  private isCheckCurrent(epoch: number): boolean {
    return !this.shuttingDown && this.checkEpoch === epoch;
  }

  private detachBuildProcess(operationId: string): ActiveBuildProcess | null {
    if (this.activeBuildProcess?.operationId !== operationId) return null;
    const activeProcess = this.activeBuildProcess;
    this.activeBuildProcess = null;
    clearTimeout(activeProcess.timeout);
    return activeProcess;
  }

  private abortBuild(message: string): void {
    const build = this.status.build;
    if (!build || (build.status !== "queued" && build.status !== "running")) return;
    const activeProcess = this.detachBuildProcess(build.operation_id);
    this.failBuild(message, "worker_image_build_failed", build.operation_id);
    if (!activeProcess) return;
    try {
      activeProcess.child.kill("SIGTERM");
    } catch {
      // Shutdown will continue even if the child has already exited.
    }
  }

  private flushBuildCommitTimer(): void {
    if (!this.buildCommitTimer) return;
    clearTimeout(this.buildCommitTimer);
    this.buildCommitTimer = null;
  }

  private connectedWorkers(sourceFingerprint: string | undefined): DagEnvironmentWorker[] {
    return getAllWorkers().map((worker) => {
      const identity = worker.runtime_identity;
      return {
        worker_id: worker.worker_id,
        status: worker.status,
        registered_at: worker.registered_at,
        worker_version: identity?.worker_version,
        protocol_version: identity?.protocol_version,
        source_fingerprint: identity?.source_fingerprint,
        image_revision: identity?.image_revision,
        compatibility: compatibleWithSource(
          identity?.protocol_version,
          identity?.source_fingerprint,
          sourceFingerprint,
        ),
      };
    });
  }

  private currentBuildNetworkSummary(): WorkerBuildNetworkSummary | undefined {
    return this.buildNetworkConfig ? workerBuildNetworkSummary(this.buildNetworkConfig) : undefined;
  }

  private applyBuildNetworkStatus(): void {
    if (this.buildNetworkError) {
      const message = this.buildNetworkError.message;
      this.status.worker_image = {
        ...this.status.worker_image,
        status: "error",
        image: this.workerImage,
        reason: "worker_build_network_invalid",
        reason_code: "worker_build_network_invalid",
        message,
        error: message,
      };
      delete this.status.worker_image.build_network;
      return;
    }
    const summary = this.currentBuildNetworkSummary() ?? this.persistedBuildNetworkSummary;
    if (summary) {
      this.status.worker_image.build_network = summary;
    } else {
      delete this.status.worker_image.build_network;
    }
  }

  private commit(): void {
    this.status.revision += 1;
    this.status.updated_at = this.now();
    this.applyBuildNetworkStatus();
    this.status.workers = this.connectedWorkers(this.status.source.fingerprint);
    const dir = path.dirname(this.statusPath);
    fs.mkdirSync(dir, { recursive: true });
    const tempPath = `${this.statusPath}.${process.pid}.tmp`;
    fs.writeFileSync(tempPath, `${JSON.stringify(this.status, null, 2)}\n`, "utf8");
    fs.renameSync(tempPath, this.statusPath);
    emit("dag:resource_status_updated", {
      revision: this.status.revision,
      updated_at: this.status.updated_at,
      status: cloneStatus(this.status),
    });
  }

  private readPersistedStatus(): DagEnvironmentStatus {
    const fallback = defaultStatus(this.repoRoot, this.workerImage, this.platform, this.env);
    try {
      const parsed = JSON.parse(fs.readFileSync(this.statusPath, "utf8")) as Partial<DagEnvironmentStatus>;
      if (typeof parsed.revision !== "number" || !parsed.docker || !parsed.source || !parsed.worker_image) {
        return fallback;
      }
      return {
        ...fallback,
        ...parsed,
        revision: parsed.revision,
        platform: this.platform,
        source: { ...fallback.source, ...parsed.source, repo_root: this.repoRoot },
        docker: { ...fallback.docker, ...parsed.docker },
        worker_image: {
          ...fallback.worker_image,
          ...parsed.worker_image,
          image: this.workerImage,
          build_network: this.currentBuildNetworkSummary()
            ?? normalizeWorkerBuildNetworkSummary(parsed.worker_image.build_network),
        },
        images: Array.isArray(parsed.images) ? parsed.images : [],
        workers: [],
        build: parsed.build?.status === "running" || parsed.build?.status === "queued"
          ? {
              ...parsed.build,
              status: "failed",
              finished_at: this.now(),
              error: "Manager restarted while the image build was running.",
              logs: [...(parsed.build.logs ?? []), "Build interrupted by Manager restart."].slice(-MAX_BUILD_LOG_LINES),
            }
          : parsed.build,
      };
    } catch {
      return fallback;
    }
  }
}

let defaultController: DagEnvironmentController | undefined;

export function getDagEnvironmentController(): DagEnvironmentController {
  defaultController ??= new DagEnvironmentController();
  return defaultController;
}

export function resetDagEnvironmentControllerForTests(): void {
  defaultController?.shutdown();
  defaultController = undefined;
}
