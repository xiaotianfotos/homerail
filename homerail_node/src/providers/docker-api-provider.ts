import Docker from "dockerode";
import type {
  ExecutionProvider,
  ContainerConfig,
  ContainerInfo,
  ExecResult,
  ContainerNetworkInfo,
} from "./types.js";

export interface DockerApiProviderOptions {
  socketPath?: string;
  host?: string;
  port?: number;
}

export function resolveDockerApiOptions(
  opts?: DockerApiProviderOptions,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): DockerApiProviderOptions | undefined {
  if (opts && Object.keys(opts).length > 0) return opts;
  if (env.DOCKER_HOST?.trim()) return opts;
  if (platform === "win32") return { socketPath: "//./pipe/docker_engine" };
  return opts;
}

function normalizeStatus(s: string): ContainerInfo["status"] {
  switch (s) {
    case "created":
      return "created";
    case "running":
      return "running";
    case "exited":
    case "dead":
      return "stopped";
    case "removing":
      return "removed";
    default:
      return "stopped";
  }
}

function toContainerInfo(data: Docker.ContainerInspectInfo): ContainerInfo {
  const name = typeof data.Name === "string" ? data.Name.replace(/^\//, "") : undefined;
  return {
    id: data.Id,
    status: normalizeStatus(data.State.Status || "unknown"),
    name,
    labels: data.Config?.Labels ?? undefined,
    exitCode: data.State.ExitCode,
    startedAt: data.State.StartedAt,
    finishedAt: data.State.FinishedAt,
    error: data.State.Error,
    measurement: {
      imageDigest: data.Image ?? "",
      command: [data.Path, ...(data.Args ?? [])].filter((entry): entry is string => typeof entry === "string" && entry.length > 0),
      envNames: (data.Config?.Env ?? []).map((entry) => entry.split("=", 1)[0]!).sort(),
      user: data.Config?.User ?? "",
      readOnlyRootfs: data.HostConfig?.ReadonlyRootfs === true,
      securityOpts: [...(data.HostConfig?.SecurityOpt ?? [])].sort(),
      capDrop: [...(data.HostConfig?.CapDrop ?? [])].sort(),
      mounts: (data.Mounts ?? []).flatMap((mount) => (
        mount.Source && mount.Destination
          ? [{ source: mount.Source, target: mount.Destination, mode: mount.RW === false ? "ro" as const : "rw" as const }]
          : []
      )).sort((left, right) => left.target.localeCompare(right.target)),
      tmpfs: Object.entries(data.HostConfig?.Tmpfs ?? {}).map(([target, raw]) => ({
        target,
        options: String(raw).split(",").map((entry) => entry.trim()).filter(Boolean).sort(),
      })).sort((left, right) => left.target.localeCompare(right.target)),
      networkMode: data.HostConfig?.NetworkMode ?? "default",
      networkNames: Object.keys(data.NetworkSettings?.Networks ?? {}).filter((network) => network !== "none").sort(),
      devices: (data.HostConfig?.Devices ?? []).flatMap((device: {
        PathOnHost?: string; PathInContainer?: string; CgroupPermissions?: string;
      }) => (
        device.PathOnHost && device.PathInContainer
          ? [{ host: device.PathOnHost, container: device.PathInContainer, permissions: device.CgroupPermissions ?? "rwm" }]
          : []
      )).sort(
        (left: { container: string }, right: { container: string }) => left.container.localeCompare(right.container),
      ),
      gpus: (data.HostConfig?.DeviceRequests ?? [])
        .filter((request) => request.Driver === "nvidia")
        .flatMap((request) => request.DeviceIDs ?? [])
        .sort(),
      resourceLimits: {
        pids: Number(data.HostConfig?.PidsLimit ?? 0),
        memoryBytes: Number(data.HostConfig?.Memory ?? 0),
        memorySwapBytes: Number(data.HostConfig?.MemorySwap ?? 0),
        nanoCpus: Number(data.HostConfig?.NanoCpus ?? 0),
      },
    },
  };
}

export class DockerApiProvider implements ExecutionProvider {
  private docker: Docker;

  constructor(opts?: DockerApiProviderOptions) {
    this.docker = new Docker(resolveDockerApiOptions(opts));
  }

  async create(config: ContainerConfig): Promise<ContainerInfo> {
    const createOpts: Docker.ContainerCreateOptions = {
      Image: config.image,
      Cmd: config.command,
      Env: config.env
        ? Object.entries(config.env).map(([k, v]) => `${k}=${v}`)
        : undefined,
      Labels: config.labels,
      WorkingDir: config.workdir,
      User: config.user,
    };

    if (config.name) {
      createOpts.name = config.name;
    }

    if (config.mounts && config.mounts.length > 0) {
      createOpts.HostConfig = {
        Mounts: config.mounts.map((m) => ({
          Type: "bind",
          Source: m.host,
          Target: m.container,
          ReadOnly: (m.mode ?? "").split(",").map((part) => part.trim().toLowerCase()).includes("ro"),
        })),
      };
    }

    if (config.ports && config.ports.length > 0) {
      const exposedPorts: Record<string, Record<string, never>> = {};
      const portBindings: Record<string, Array<{ HostIp?: string; HostPort: string }>> = {};
      for (const p of config.ports) {
        const protocol = p.protocol ?? "tcp";
        const key = `${p.containerPort}/${protocol}`;
        exposedPorts[key] = {};
        portBindings[key] = [{
          HostIp: p.hostIp,
          HostPort: String(p.hostPort),
        }];
      }
      createOpts.ExposedPorts = exposedPorts;
      createOpts.HostConfig = {
        ...createOpts.HostConfig,
        PortBindings: portBindings,
      };
    }

    if (config.extraHosts && config.extraHosts.length > 0) {
      createOpts.HostConfig = {
        ...createOpts.HostConfig,
        ExtraHosts: config.extraHosts,
      };
    }

    if (config.network) {
      createOpts.HostConfig = {
        ...createOpts.HostConfig,
        NetworkMode: config.network,
      };
    }

    createOpts.HostConfig = {
      ...createOpts.HostConfig,
      ReadonlyRootfs: config.readOnlyRootfs,
      SecurityOpt: [
        ...(config.noNewPrivileges ? ["no-new-privileges:true"] : []),
        ...(config.securityOpts ?? []),
      ],
      CapDrop: config.capDrop,
      Tmpfs: config.tmpfs?.length
        ? Object.fromEntries(config.tmpfs.map((entry) => [
          entry.target,
          `rw,noexec,nosuid,nodev,size=${entry.sizeBytes}`,
        ]))
        : undefined,
      Devices: config.devices?.map((device) => ({
        PathOnHost: device.host,
        PathInContainer: device.container ?? device.host,
        CgroupPermissions: device.permissions ?? "rwm",
      })),
      DeviceRequests: config.gpus?.length ? [{
        Driver: "nvidia",
        DeviceIDs: config.gpus,
        Capabilities: [["gpu"]],
      }] : undefined,
      PidsLimit: config.resourceLimits?.pids,
      Memory: config.resourceLimits?.memoryBytes,
      MemorySwap: config.resourceLimits?.memorySwapBytes,
      NanoCpus: config.resourceLimits?.nanoCpus,
    };

    const container = await this.docker.createContainer(createOpts);
    const data = await container.inspect();
    return toContainerInfo(data);
  }

  async start(id: string): Promise<void> {
    const container = this.docker.getContainer(id);
    await container.start();
  }

  async stop(id: string): Promise<void> {
    const container = this.docker.getContainer(id);
    await container.stop();
  }

  async kill(id: string): Promise<void> {
    const container = this.docker.getContainer(id);
    await container.kill();
  }

  async remove(id: string): Promise<void> {
    const container = this.docker.getContainer(id);
    await container.remove({ force: true });
  }

  async exec(id: string, cmd: string[]): Promise<ExecResult> {
    const container = this.docker.getContainer(id);
    const exec = await container.exec({
      Cmd: cmd,
      AttachStdout: true,
      AttachStderr: true,
    });

    const stream = await exec.start({ Detach: false, Tty: false });

    return new Promise<ExecResult>((resolve, reject) => {
      let stdout = "";
      let stderr = "";
      let exitCode = 0;

      stream.on("data", (chunk: Buffer) => {
        // dockerode multiplexes stdout/stderr into a single stream;
        // demuxStream separates them. For simplicity we capture all output.
        stdout += chunk.toString();
      });

      stream.on("end", () => {
        exec.inspect((_err, data) => {
          if (data?.ExitCode !== undefined && data.ExitCode !== null) {
            exitCode = data.ExitCode;
          }
          resolve({ exitCode, stdout, stderr });
        });
      });

      stream.on("error", reject);
    });
  }

  async execInput(id: string, cmd: string[], input: string, options: { timeoutMs?: number } = {}): Promise<ExecResult> {
    const container = this.docker.getContainer(id);
    const exec = await container.exec({
      Cmd: cmd,
      AttachStdin: true,
      AttachStdout: true,
      AttachStderr: true,
      Tty: true,
    });
    const stream = await exec.start({ Detach: false, Tty: true, stdin: true });
    let stdout = "";
    return await new Promise<ExecResult>((resolve, reject) => {
      let settled = false;
      const finish = (callback: () => void) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        callback();
      };
      const timer = options.timeoutMs && options.timeoutMs > 0
        ? setTimeout(() => {
          stream.destroy();
          finish(() => reject(new Error(`docker exec timed out after ${options.timeoutMs}ms`)));
        }, options.timeoutMs)
        : undefined;
      stream.on("data", (chunk: Buffer) => {
        stdout += chunk.toString();
        if (Buffer.byteLength(stdout, "utf8") > 24 * 1024 * 1024) {
          stream.destroy();
          finish(() => reject(new Error("docker exec output exceeds 24 MiB")));
        }
      });
      stream.on("error", (cause) => finish(() => reject(cause)));
      stream.on("end", () => {
        exec.inspect((_error, data) => finish(() => resolve({
            exitCode: data?.ExitCode ?? 1,
            stdout,
            stderr: "",
          })));
      });
      stream.end(input);
    });
  }

  async *logs(id: string): AsyncIterable<string> {
    const container = this.docker.getContainer(id);
    const stream = await container.logs({
      follow: true,
      stdout: true,
      stderr: true,
    });

    for await (const chunk of stream) {
      yield chunk.toString("utf-8");
    }
  }

  async inspect(id: string): Promise<ContainerInfo> {
    const container = this.docker.getContainer(id);
    const data = await container.inspect();
    return toContainerInfo(data);
  }

  async list(): Promise<ContainerInfo[]> {
    const containers = await this.docker.listContainers({ all: true });
    return containers.map((c) => ({
      id: c.Id,
      status: normalizeStatus(c.State || c.Status),
      name: c.Names?.[0]?.replace(/^\//, ""),
      labels: c.Labels,
      exitCode: undefined,
      startedAt: c.Created ? new Date(c.Created * 1000).toISOString() : undefined,
      finishedAt: undefined,
      error: c.Status?.includes("Error") ? c.Status : undefined,
    }));
  }

  async inspectNetwork(name: string): Promise<ContainerNetworkInfo> {
    const data = await this.docker.getNetwork(name).inspect();
    if (!data.Id || !data.Name) throw new Error(`docker network inspect returned invalid data for ${name}`);
    return { name: data.Name, id: data.Id, internal: data.Internal === true };
  }

  async ensureNetwork(name: string, internal: true): Promise<ContainerNetworkInfo> {
    try {
      const existing = await this.inspectNetwork(name);
      if (!existing.internal) throw new Error(`network ${name} exists but is not internal`);
      return existing;
    } catch (cause) {
      if (cause instanceof Error && cause.message.includes("exists but is not internal")) throw cause;
      await this.docker.createNetwork({ Name: name, Internal: internal });
      const created = await this.inspectNetwork(name);
      if (!created.internal) throw new Error(`network ${name} was not created internal`);
      return created;
    }
  }
}
