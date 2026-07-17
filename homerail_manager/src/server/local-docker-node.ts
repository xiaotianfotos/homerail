import * as fs from "node:fs";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { getDataRoot, getHomerailHome } from "../config/env.js";
import { getAllNodes, isDockerCapableNode } from "../node/registry.js";

export interface LocalDockerNodeOptions {
  managerRestUrl: string | (() => string);
  localManagerUrl?: string | (() => string);
}

const LOCAL_NODE_ID = "local-docker-node";
let localNodeStartPromise: Promise<string | undefined> | null = null;

function valueOf(value: string | (() => string)): string {
  return typeof value === "function" ? value() : value;
}

function localManagerUrl(options: LocalDockerNodeOptions): string {
  return valueOf(options.localManagerUrl ?? options.managerRestUrl);
}

function selectDockerNode(): string | undefined {
  return getAllNodes().find((node) => node.socket.readyState === 1 && isDockerCapableNode(node))?.node_id;
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

export function resolveLocalNodeManagerWsUrl(options: LocalDockerNodeOptions): string {
  return restUrlToWsUrl(localManagerUrl(options));
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

export async function ensureLocalDockerNode(
  options: LocalDockerNodeOptions,
  projectId?: string,
): Promise<string | undefined> {
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
    const child = spawn(process.execPath, [cliPath], {
      cwd: runtimeRoot(),
      detached: true,
      shell: false,
      stdio: ["ignore", out, err],
      windowsHide: true,
      env: {
        ...process.env,
        HOMERAIL_HOME: getHomerailHome(),
        HOMERAIL_MANAGER_WS_URL: resolveLocalNodeManagerWsUrl(options),
        HOMERAIL_PROJECT_ID: projectId || process.env.HOMERAIL_PROJECT_ID || "p1",
        HOMERAIL_NODE_ID: nodeId,
        HOMERAIL_NODE_PROVIDER: process.env.HOMERAIL_NODE_PROVIDER || "docker-cli",
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
