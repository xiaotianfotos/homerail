export interface ContainerConfig {
  image: string;
  /** Manager-pinned immutable image id; providers must measure, not trust, it. */
  expectedImageDigest?: string;
  command?: string[];
  env?: Record<string, string>;
  mounts?: Array<{ host: string; container: string; mode?: string }>;
  ports?: Array<{
    hostPort: number | string;
    containerPort: number | string;
    hostIp?: string;
    protocol?: "tcp" | "udp";
  }>;
  labels?: Record<string, string>;
  network?: string;
  extraHosts?: string[];
  workdir?: string;
  name?: string;
  /** Explicit non-root identity for isolated Agent/Plugin Runtime containers. */
  user?: string;
  readOnlyRootfs?: boolean;
  noNewPrivileges?: boolean;
  capDrop?: string[];
  securityOpts?: string[];
  devices?: Array<{ host: string; container?: string; permissions?: string }>;
  gpus?: string[];
  tmpfs?: Array<{ target: string; sizeBytes: number }>;
  resourceLimits?: {
    pids: number;
    memoryBytes: number;
    memorySwapBytes: number;
    nanoCpus: number;
  };
}

export interface ContainerInspectMeasurement {
  imageDigest: string;
  command: string[];
  envNames: string[];
  user: string;
  readOnlyRootfs: boolean;
  securityOpts: string[];
  capDrop: string[];
  mounts: Array<{ source: string; target: string; mode: "ro" | "rw" }>;
  tmpfs: Array<{ target: string; options: string[] }>;
  networkMode: string;
  networkNames: string[];
  devices: Array<{ host: string; container: string; permissions: string }>;
  gpus: string[];
  resourceLimits: {
    pids: number;
    memoryBytes: number;
    memorySwapBytes: number;
    nanoCpus: number;
  };
}

export interface ContainerNetworkInfo {
  name: string;
  id: string;
  internal: boolean;
}

export interface ContainerInfo {
  id: string;
  status: "created" | "running" | "stopped" | "removed";
  name?: string;
  labels?: Record<string, string>;
  exitCode?: number;
  startedAt?: string;
  finishedAt?: string;
  error?: string;
  measurement?: ContainerInspectMeasurement;
}

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface ExecInputOptions {
  timeoutMs?: number;
}

export interface ExecutionProvider {
  create(config: ContainerConfig): Promise<ContainerInfo>;
  start(id: string): Promise<void>;
  stop(id: string): Promise<void>;
  kill(id: string): Promise<void>;
  remove(id: string): Promise<void>;
  exec(id: string, cmd: string[]): Promise<ExecResult>;
  execInput(id: string, cmd: string[], input: string, options?: ExecInputOptions): Promise<ExecResult>;
  logs(id: string): AsyncIterable<string>;
  inspect(id: string): Promise<ContainerInfo>;
  list(): Promise<ContainerInfo[]>;
  ensureNetwork(name: string, internal: true): Promise<ContainerNetworkInfo>;
  inspectNetwork(name: string): Promise<ContainerNetworkInfo>;
}
