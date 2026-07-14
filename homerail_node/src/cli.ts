#!/usr/bin/env node

import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { createNodeClient } from "./control-plane/ws-client.js";
import { MockProvider } from "./providers/mock-provider.js";
import { DockerCliProvider } from "./providers/docker-cli-provider.js";
import { DockerApiProvider } from "./providers/docker-api-provider.js";
import type { ExecutionProvider } from "./providers/types.js";
import { NodeRuntimeAttestationAuthority } from "./security/runtime-attestation-key.js";
import { PluginRuntimeService } from "./runtime/plugin-runtime-service.js";
import * as os from "node:os";

// --- arg parsing (hand-rolled, no deps) ---

export interface CliArgs {
  managerUrl: string;
  projectId: string;
  nodeId: string;
  provider: string;
  capabilities: string[];
  token: string;
  allowInsecureRemoteWs: boolean;
}

type CliEnv = Partial<Record<
  | "HOMERAIL_MANAGER_WS_URL"
  | "HOMERAIL_MANAGER_PORT"
  | "HOMERAIL_PROJECT_ID"
  | "HOMERAIL_NODE_ID"
  | "HOMERAIL_NODE_PROVIDER"
  | "HOMERAIL_NODE_CAPABILITIES"
  | "HOMERAIL_NODE_TOKEN"
  | "HOMERAIL_CONTROL_PLANE_TOKEN"
  | "HOMERAIL_ALLOW_INSECURE_REMOTE_WS",
  string
>>;

const DEFAULT_MANAGER_PORT = "19191";

function defaultManagerWsUrl(env: CliEnv): string {
  const port = env.HOMERAIL_MANAGER_PORT?.trim() || DEFAULT_MANAGER_PORT;
  return `ws://localhost:${port}`;
}

function readFlagValue(argv: string[], index: number, flag: string): string {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`Missing value for ${flag}`);
  }
  return value;
}

function appendCapability(caps: string[], value: string): void {
  const trimmed = value.trim();
  if (trimmed && !caps.includes(trimmed)) caps.push(trimmed);
}

function appendCapabilities(caps: string[], value: string): void {
  for (const c of value.split(",")) {
    appendCapability(caps, c);
  }
}

function appendProviderCapabilities(caps: string[], provider: string): void {
  if (provider === "docker-cli" || provider === "docker-api") appendCapability(caps, provider);
}

export function parseArgs(argv: string[], env: CliEnv = process.env): CliArgs {
  let managerUrl = env.HOMERAIL_MANAGER_WS_URL ?? defaultManagerWsUrl(env);
  let projectId = env.HOMERAIL_PROJECT_ID ?? "";
  let nodeId = env.HOMERAIL_NODE_ID ?? "";
  let provider = env.HOMERAIL_NODE_PROVIDER ?? "docker-cli";
  const token = (env.HOMERAIL_NODE_TOKEN ?? env.HOMERAIL_CONTROL_PLANE_TOKEN ?? "").trim();
  const allowInsecureRemoteWs = env.HOMERAIL_ALLOW_INSECURE_REMOTE_WS === "1";
  const caps: string[] = [];

  const envCaps = env.HOMERAIL_NODE_CAPABILITIES;
  if (envCaps) {
    appendCapabilities(caps, envCaps);
  }

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--manager-url") {
      managerUrl = readFlagValue(argv, i, arg);
      i++;
    } else if (arg === "--project-id") {
      projectId = readFlagValue(argv, i, arg);
      i++;
    } else if (arg === "--node-id") {
      nodeId = readFlagValue(argv, i, arg);
      i++;
    } else if (arg === "--provider") {
      provider = readFlagValue(argv, i, arg);
      i++;
    } else if (arg === "--capability") {
      appendCapabilities(caps, readFlagValue(argv, i, arg));
      i++;
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }

  appendProviderCapabilities(caps, provider);
  appendCapability(caps, "workspace-artifacts");

  return {
    managerUrl,
    projectId,
    nodeId,
    provider,
    capabilities: caps,
    token,
    allowInsecureRemoteWs,
  };
}

export function resolveProvider(name: string): ExecutionProvider {
  switch (name) {
    case "mock":
      return new MockProvider();
    case "docker-cli":
      return new DockerCliProvider();
    case "docker-api":
      return new DockerApiProvider();
    default:
      throw new Error(`Unknown provider: ${name}. Valid: mock, docker-cli, docker-api`);
  }
}

export function resolvePluginRuntimeService(
  args: CliArgs,
  provider: ExecutionProvider,
  env: NodeJS.ProcessEnv = process.env,
): PluginRuntimeService | undefined {
  if (!args.capabilities.includes("plugin-runtime")) return undefined;
  const packageRoots = (env.HOMERAIL_PLUGIN_RUNTIME_PACKAGE_ROOTS ?? "")
    .split(path.delimiter)
    .map((value) => value.trim())
    .filter(Boolean);
  let imageAllowlist: Record<string, string>;
  try {
    const raw = JSON.parse(env.HOMERAIL_PLUGIN_RUNTIME_IMAGE_ALLOWLIST ?? "{}") as unknown;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("not an object");
    imageAllowlist = raw as Record<string, string>;
  } catch {
    throw new Error("HOMERAIL_PLUGIN_RUNTIME_IMAGE_ALLOWLIST must be a JSON object of image to sha256 digest");
  }
  const seccomp = env.HOMERAIL_PLUGIN_RUNTIME_SECCOMP_PROFILE?.trim();
  if (!seccomp) throw new Error("HOMERAIL_PLUGIN_RUNTIME_SECCOMP_PROFILE is required for plugin-runtime capability");
  const home = path.resolve(env.HOMERAIL_HOME?.trim() || path.join(os.homedir(), ".homerail"));
  const authority = new NodeRuntimeAttestationAuthority({
    node_id: args.nodeId,
    ...(env.HOMERAIL_NODE_ATTESTATION_KEY_FILE?.trim()
      ? { key_file: env.HOMERAIL_NODE_ATTESTATION_KEY_FILE.trim() }
      : { env }),
  });
  const list = (name: string) => (env[name] ?? "").split(",").map((value) => value.trim()).filter(Boolean);
  return new PluginRuntimeService({
    node_id: args.nodeId,
    provider,
    authority,
    data_root: path.join(home, "node-runtime"),
    package_roots: packageRoots,
    image_allowlist: imageAllowlist,
    seccomp_profile: seccomp,
    allowed_devices: list("HOMERAIL_PLUGIN_RUNTIME_ALLOWED_DEVICES"),
    allowed_gpus: list("HOMERAIL_PLUGIN_RUNTIME_ALLOWED_GPUS"),
    ...(env.HOMERAIL_PLUGIN_RUNTIME_RUNNER?.trim() ? { runtime_runner: env.HOMERAIL_PLUGIN_RUNTIME_RUNNER.trim() } : {}),
  });
}

// --- main ---

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (!args.managerUrl.trim()) {
    console.error("Error: --manager-url is required (or set HOMERAIL_MANAGER_WS_URL)");
    process.exit(1);
  }
  if (!args.projectId) {
    console.error("Error: --project-id is required (or set HOMERAIL_PROJECT_ID)");
    process.exit(1);
  }
  if (!args.nodeId) {
    console.error("Error: --node-id is required (or set HOMERAIL_NODE_ID)");
    process.exit(1);
  }

  const provider = resolveProvider(args.provider);
  const pluginRuntime = resolvePluginRuntimeService(args, provider);

  const client = createNodeClient({
    managerUrl: args.managerUrl,
    projectId: args.projectId,
    nodeId: args.nodeId,
    provider,
    capabilities: args.capabilities,
    pluginRuntime,
    token: args.token,
    allowInsecureRemote: args.allowInsecureRemoteWs,
  });

  await client.connect();
  console.log(`HOMERAIL_NODE_READY node_id=${args.nodeId}`);

  const shutdown = () => {
    client.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  setInterval(() => {}, 1 << 30);
}

// Only run main when executed directly, not when imported
const thisFile = fileURLToPath(import.meta.url);
const argFile = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (thisFile === argFile) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
