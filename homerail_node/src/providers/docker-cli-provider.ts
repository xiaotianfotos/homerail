import { execFile as execFileCb, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import type {
  ExecutionProvider,
  ContainerConfig,
  ContainerInfo,
  ExecResult,
  ContainerNetworkInfo,
} from "./types.js";

type ExecFileOptions = {
  encoding?: BufferEncoding;
  maxBuffer?: number;
  windowsHide?: boolean;
  env?: NodeJS.ProcessEnv;
};

const DOCKER_INHERITED_SECRET_ENV = new Set([
  "HOMERAIL_MANAGER_ADMIN_TOKEN",
  "HOMERAIL_PLUGIN_CAPABILITY_SECRET",
]);

export interface DockerCliProviderOptions {
  dockerPath?: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  existsSync?: (filePath: string) => boolean;
}

export class DockerNotFoundError extends Error {
  constructor() {
    super("docker: command not found. Is Docker installed?");
    this.name = "DockerNotFoundError";
  }
}

export class DockerDaemonError extends Error {
  constructor() {
    super("Cannot connect to the Docker daemon. Is Docker running?");
    this.name = "DockerDaemonError";
  }
}

export class DockerPermissionError extends Error {
  constructor() {
    super(
      "permission denied while trying to connect to the Docker daemon. Is the current user in the docker group?",
    );
    this.name = "DockerPermissionError";
  }
}

function unquote(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith("\"") && trimmed.endsWith("\"")) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function windowsDockerBinaryCandidates(env: NodeJS.ProcessEnv): string[] {
  const candidates = new Set<string>();
  const programFiles = env.ProgramFiles || "C:\\Program Files";
  const programFilesX86 = env["ProgramFiles(x86)"];
  candidates.add(`${programFiles}\\Docker\\Docker\\resources\\bin\\docker.exe`);
  if (programFilesX86) {
    candidates.add(`${programFilesX86}\\Docker\\Docker\\resources\\bin\\docker.exe`);
  }
  candidates.add("C:\\ProgramData\\chocolatey\\bin\\docker.exe");
  return [...candidates];
}

export function resolveDockerCliPath(options: DockerCliProviderOptions = {}): string {
  const configured = options.dockerPath || options.env?.HOMERAIL_DOCKER_BIN || options.env?.DOCKER_BIN;
  if (configured) return unquote(configured);

  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const exists = options.existsSync ?? existsSync;
  if (platform === "win32") {
    const found = windowsDockerBinaryCandidates(env).find((candidate) => exists(candidate));
    if (found) return found;
  }
  return "docker";
}

function execFile(
  file: string,
  args?: string[],
  options?: ExecFileOptions,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const cb = (
      err: Error | null,
      stdout: string | Buffer,
      stderr: string | Buffer,
    ) => {
      if (err) reject(err);
      else
        resolve({
          stdout: typeof stdout === "string" ? stdout : stdout.toString(),
          stderr: typeof stderr === "string" ? stderr : stderr.toString(),
        });
    };
    if (args !== undefined && options !== undefined) {
      execFileCb(file, args, { windowsHide: true, ...options }, cb);
    } else if (args !== undefined) {
      execFileCb(file, args, { windowsHide: true }, cb);
    } else {
      execFileCb(file, { windowsHide: true }, cb);
    }
  });
}

function classifyError(err: Error): Error {
  const msg = (err as NodeJS.ErrnoException).message || "";
  const code = (err as NodeJS.ErrnoException).code;
  if (code === "ENOENT" || msg.includes("command not found")) {
    return new DockerNotFoundError();
  }
  if (code === "EACCES" || msg.includes("permission denied")) {
    return new DockerPermissionError();
  }
  if (
    msg.includes("Cannot connect to the Docker daemon") ||
    msg.includes("Is the docker daemon running")
  ) {
    return new DockerDaemonError();
  }
  return err;
}

function buildMountArg(mount: NonNullable<ContainerConfig["mounts"]>[number]): string {
  const parts = [
    "type=bind",
    `source=${mount.host}`,
    `target=${mount.container}`,
  ];
  const modeParts = (mount.mode ?? "")
    .split(",")
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean);
  if (modeParts.includes("ro") || modeParts.includes("readonly")) {
    parts.push("readonly");
  }
  return parts.join(",");
}

function buildCreateArgs(config: ContainerConfig): string[] {
  const args: string[] = ["create"];

  if (config.name) {
    args.push("--name", config.name);
  }

  if (config.workdir) {
    args.push("--workdir", config.workdir);
  }

  if (config.user) args.push("--user", config.user);
  if (config.readOnlyRootfs) args.push("--read-only");
  if (config.noNewPrivileges) args.push("--security-opt", "no-new-privileges:true");
  for (const capability of config.capDrop ?? []) args.push("--cap-drop", capability);
  for (const option of config.securityOpts ?? []) args.push("--security-opt", option);
  for (const device of config.devices ?? []) {
    const target = device.container ?? device.host;
    const permissions = device.permissions ?? "rwm";
    args.push("--device", `${device.host}:${target}:${permissions}`);
  }
  if (config.gpus?.length) args.push("--gpus", `device=${config.gpus.join(",")}`);
  for (const entry of config.tmpfs ?? []) {
    args.push("--tmpfs", `${entry.target}:rw,noexec,nosuid,nodev,size=${entry.sizeBytes}`);
  }
  if (config.resourceLimits) {
    args.push("--pids-limit", String(config.resourceLimits.pids));
    args.push("--memory", String(config.resourceLimits.memoryBytes));
    args.push("--memory-swap", String(config.resourceLimits.memorySwapBytes));
    args.push("--cpus", String(config.resourceLimits.nanoCpus / 1_000_000_000));
  }

  if (config.env) {
    for (const [key, value] of Object.entries(config.env)) {
      // Keep Manager credentials out of process listings and child_process
      // error messages. Docker copies these named values from its own env.
      args.push("-e", DOCKER_INHERITED_SECRET_ENV.has(key) ? key : `${key}=${value}`);
    }
  }

  if (config.mounts) {
    for (const m of config.mounts) {
      args.push("--mount", buildMountArg(m));
    }
  }

  if (config.ports) {
    for (const p of config.ports) {
      const protocol = p.protocol ?? "tcp";
      const hostIp = p.hostIp ? `${p.hostIp}:` : "";
      args.push("-p", `${hostIp}${p.hostPort}:${p.containerPort}/${protocol}`);
    }
  }

  if (config.labels) {
    for (const [key, value] of Object.entries(config.labels)) {
      args.push("--label", `${key}=${value}`);
    }
  }

  if (config.extraHosts) {
    for (const entry of config.extraHosts) {
      args.push("--add-host", entry);
    }
  }

  if (config.network) {
    args.push("--network", config.network);
  }

  if (config.command && config.command.length > 0) {
    args.push("--entrypoint", config.command[0]!);
    args.push(config.image);
    if (config.command.length > 1) {
      args.push(...config.command.slice(1));
    }
  } else {
    args.push(config.image);
  }

  return args;
}

function parseInspectOutput(stdout: string): ContainerInfo {
  const parsed = JSON.parse(stdout);
  const data = parsed[0];
  const state = data.State;
  const config = data.Config ?? {};
  const host = data.HostConfig ?? {};
  const name = typeof data.Name === "string" ? data.Name.replace(/^\//, "") : undefined;
  return {
    id: data.Id,
    status: normalizeStatus(state.Status),
    name,
    labels: data.Config?.Labels ?? undefined,
    exitCode: state.ExitCode,
    startedAt: state.StartedAt,
    finishedAt: state.FinishedAt,
    error: state.Error,
    measurement: {
      imageDigest: typeof data.Image === "string" ? data.Image : "",
      command: [data.Path, ...(Array.isArray(data.Args) ? data.Args : [])]
        .filter((entry): entry is string => typeof entry === "string" && entry.length > 0),
      envNames: (Array.isArray(config.Env) ? config.Env : [])
        .filter((entry: unknown): entry is string => typeof entry === "string")
        .map((entry: string) => entry.split("=", 1)[0]!)
        .sort(),
      user: typeof config.User === "string" ? config.User : "",
      readOnlyRootfs: host.ReadonlyRootfs === true,
      securityOpts: (Array.isArray(host.SecurityOpt) ? host.SecurityOpt : []).filter((entry: unknown): entry is string => typeof entry === "string").sort(),
      capDrop: (Array.isArray(host.CapDrop) ? host.CapDrop : []).filter((entry: unknown): entry is string => typeof entry === "string").sort(),
      mounts: (Array.isArray(data.Mounts) ? data.Mounts : []).flatMap((mount: Record<string, unknown>) => (
        typeof mount.Source === "string" && typeof mount.Destination === "string"
          ? [{ source: mount.Source, target: mount.Destination, mode: mount.RW === false ? "ro" as const : "rw" as const }]
          : []
      )).sort((left: { target: string }, right: { target: string }) => left.target.localeCompare(right.target)),
      tmpfs: Object.entries(host.Tmpfs ?? {}).map(([target, raw]) => ({
        target,
        options: String(raw).split(",").map((entry) => entry.trim()).filter(Boolean).sort(),
      })).sort((left, right) => left.target.localeCompare(right.target)),
      networkMode: typeof host.NetworkMode === "string" ? host.NetworkMode : "default",
      networkNames: Object.keys(data.NetworkSettings?.Networks ?? {}).filter((name) => name !== "none").sort(),
      devices: (Array.isArray(host.Devices) ? host.Devices : []).flatMap((device: Record<string, unknown>) => (
        typeof device.PathOnHost === "string" && typeof device.PathInContainer === "string"
          ? [{
            host: device.PathOnHost,
            container: device.PathInContainer,
            permissions: typeof device.CgroupPermissions === "string" ? device.CgroupPermissions : "rwm",
          }]
          : []
      )).sort((left: { container: string }, right: { container: string }) => left.container.localeCompare(right.container)),
      gpus: (Array.isArray(host.DeviceRequests) ? host.DeviceRequests : [])
        .filter((request: Record<string, unknown>) => request.Driver === "nvidia")
        .flatMap((request: Record<string, unknown>) => Array.isArray(request.DeviceIDs) ? request.DeviceIDs : [])
        .filter((entry: unknown): entry is string => typeof entry === "string")
        .sort(),
      resourceLimits: {
        pids: Number(host.PidsLimit ?? 0),
        memoryBytes: Number(host.Memory ?? 0),
        memorySwapBytes: Number(host.MemorySwap ?? 0),
        nanoCpus: Number(host.NanoCpus ?? 0),
      },
    },
  };
}

function normalizeStatus(s: string): ContainerInfo["status"] {
  switch (s) {
    case "created":
      return "created";
    case "running":
      return "running";
    case "exited":
    case "stopped":
    case "dead":
      return "stopped";
    case "removing":
    case "removed":
      return "removed";
    default:
      return "stopped";
  }
}

async function parseCreateOutput(stdout: string, dockerPath: string): Promise<ContainerInfo> {
  const id = stdout.trim();
  const info = await execFile(dockerPath, ["inspect", id]);
  return parseInspectOutput(info.stdout);
}

export class DockerCliProvider implements ExecutionProvider {
  private readonly dockerPath: string;

  constructor(options: DockerCliProviderOptions = {}) {
    this.dockerPath = resolveDockerCliPath(options);
  }

  async create(config: ContainerConfig): Promise<ContainerInfo> {
    try {
      const args = buildCreateArgs(config);
      const inheritedSecrets = Object.fromEntries(
        Object.entries(config.env ?? {}).filter(([key]) => DOCKER_INHERITED_SECRET_ENV.has(key)),
      );
      const { stdout } = await execFile(this.dockerPath, args, {
        encoding: "utf-8",
        env: { ...process.env, ...inheritedSecrets },
      });
      return parseCreateOutput(stdout, this.dockerPath);
    } catch (err) {
      throw classifyError(err as Error);
    }
  }

  async start(id: string): Promise<void> {
    try {
      await execFile(this.dockerPath, ["start", id]);
    } catch (err) {
      throw classifyError(err as Error);
    }
  }

  async stop(id: string): Promise<void> {
    try {
      await execFile(this.dockerPath, ["stop", id]);
    } catch (err) {
      throw classifyError(err as Error);
    }
  }

  async kill(id: string): Promise<void> {
    try {
      await execFile(this.dockerPath, ["kill", id]);
    } catch (err) {
      throw classifyError(err as Error);
    }
  }

  async remove(id: string): Promise<void> {
    try {
      await execFile(this.dockerPath, ["rm", "-f", id]);
    } catch (err) {
      throw classifyError(err as Error);
    }
  }

  async exec(id: string, cmd: string[]): Promise<ExecResult> {
    try {
      const args = ["exec", id, ...cmd];
      const { stdout, stderr } = await execFile(this.dockerPath, args, {
        encoding: "utf-8",
        maxBuffer: 10 * 1024 * 1024,
      });
      return {
        exitCode: 0,
        stdout: stdout || "",
        stderr: stderr || "",
      };
    } catch (err) {
      const e = err as NodeJS.ErrnoException & { code?: number };
      if (e.code !== undefined && typeof e.code === "number") {
        return {
          exitCode: e.code,
          stdout: "",
          stderr: e.message || "",
        };
      }
      throw classifyError(err as Error);
    }
  }

  async execInput(id: string, cmd: string[], input: string, options: { timeoutMs?: number } = {}): Promise<ExecResult> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.dockerPath, ["exec", "-i", id, ...cmd], {
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
      let stdout = "";
      let stderr = "";
      let settled = false;
      const finish = (callback: () => void) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        callback();
      };
      const timer = options.timeoutMs && options.timeoutMs > 0
        ? setTimeout(() => {
          child.kill("SIGKILL");
          finish(() => reject(new Error(`docker exec timed out after ${options.timeoutMs}ms`)));
        }, options.timeoutMs)
        : undefined;
      const append = (current: string, chunk: unknown) => {
        const next = current + String(chunk);
        if (Buffer.byteLength(next, "utf8") > 24 * 1024 * 1024) {
          child.kill("SIGKILL");
          finish(() => reject(new Error("docker exec output exceeds 24 MiB")));
        }
        return next;
      };
      child.stdout?.on("data", (chunk) => { stdout = append(stdout, chunk); });
      child.stderr?.on("data", (chunk) => { stderr = append(stderr, chunk); });
      child.once("error", (cause) => finish(() => reject(cause)));
      child.once("close", (code) => finish(() => resolve({ exitCode: code ?? 1, stdout, stderr })));
      child.stdin?.end(input);
    });
  }

  async *logs(id: string): AsyncIterable<string> {
    const child = spawn(this.dockerPath, ["logs", "-f", id], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });

    let done = false;

    child.on("close", () => {
      done = true;
    });

    try {
      for await (const chunk of child.stdout) {
        yield chunk.toString("utf-8");
      }
    } finally {
      if (!done) {
        child.kill();
      }
    }
  }

  async inspect(id: string): Promise<ContainerInfo> {
    try {
      const { stdout } = await execFile(this.dockerPath, ["inspect", id], {
        encoding: "utf-8",
      });
      return parseInspectOutput(stdout);
    } catch (err) {
      throw classifyError(err as Error);
    }
  }

  async list(): Promise<ContainerInfo[]> {
    try {
      const { stdout } = await execFile(this.dockerPath, [
        "ps",
        "-a",
        "--format",
        "json",
      ]);
      if (!stdout.trim()) return [];
      return stdout
        .trim()
        .split("\n")
        .map((line) => {
          const raw = JSON.parse(line);
          const names = typeof raw.Names === "string"
            ? raw.Names.split(",").map((s: string) => s.trim()).filter(Boolean)
            : [];
          const labels = typeof raw.Labels === "string" && raw.Labels
            ? Object.fromEntries(raw.Labels.split(",").filter(Boolean).map((item: string) => {
              const index = item.indexOf("=");
              return index === -1 ? [item, ""] : [item.slice(0, index), item.slice(index + 1)];
            }))
            : undefined;
          return {
            id: raw.ID,
            status: normalizeStatus(raw.State || raw.Status),
            name: names[0],
            labels,
            exitCode: raw.ExitCode !== undefined ? Number(raw.ExitCode) : undefined,
            startedAt: raw.StartedAt,
            finishedAt: raw.FinishedAt,
            error: raw.Error,
          };
        });
    } catch (err) {
      throw classifyError(err as Error);
    }
  }

  async inspectNetwork(name: string): Promise<ContainerNetworkInfo> {
    const { stdout } = await execFile(this.dockerPath, ["network", "inspect", name], { encoding: "utf-8" });
    const data = JSON.parse(stdout)?.[0];
    if (!data || typeof data.Id !== "string" || typeof data.Name !== "string") {
      throw new Error(`docker network inspect returned invalid data for ${name}`);
    }
    return { name: data.Name, id: data.Id, internal: data.Internal === true };
  }

  async ensureNetwork(name: string, internal: true): Promise<ContainerNetworkInfo> {
    try {
      const existing = await this.inspectNetwork(name);
      if (!existing.internal) throw new Error(`network ${name} exists but is not internal`);
      return existing;
    } catch (cause) {
      if (cause instanceof Error && cause.message.includes("exists but is not internal")) throw cause;
      await execFile(this.dockerPath, ["network", "create", "--internal", name], { encoding: "utf-8" });
      const created = await this.inspectNetwork(name);
      if (created.internal !== internal) throw new Error(`network ${name} was not created internal`);
      return created;
    }
  }
}
