import { spawn, type ChildProcess } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createProgram } from "../src/index.js";

const ENV_KEYS = [
  "HOMERAIL_HOME",
  "HOMERAIL_REPO_ROOT",
  "HOMERAIL_CONFIG_PATH",
  "HOMERAIL_SECRETS_PATH",
  "HOMERAIL_MANAGER_URL",
  "HOMERAIL_MANAGER_PORT",
  "HOMERAIL_MANAGER_HOST",
  "HOMERAIL_MANAGER_PUBLIC_URL",
  "HOMERAIL_TEST_MANAGER_SHUTDOWN_DELAY_MS",
] as const;

let tempHome: string;
let repoRoot: string;
let managerPort: number;
let previousExitCode: number | undefined;
let previousEnv: Map<string, string | undefined>;
let children: ChildProcess[];

beforeEach(async () => {
  vi.restoreAllMocks();
  previousExitCode = process.exitCode;
  process.exitCode = undefined;
  previousEnv = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of ENV_KEYS) delete process.env[key];

  tempHome = mkdtempSync(join(tmpdir(), "homerail-runtime-restart-test-"));
  repoRoot = join(tempHome, "repo");
  managerPort = await availablePort();
  children = [];
  process.env.HOMERAIL_HOME = tempHome;
  process.env.HOMERAIL_REPO_ROOT = repoRoot;

  mkdirSync(join(repoRoot, "homerail_manager", "dist"), { recursive: true });
  mkdirSync(join(repoRoot, "homerail_node", "dist"), { recursive: true });
  writeFileSync(join(repoRoot, "homerail_manager", "dist", "index.js"), dummyManagerSource());
  writeFileSync(join(repoRoot, "homerail_node", "dist", "cli.js"), "setInterval(() => {}, 1000);\n");
  writeFileSync(join(tempHome, "config.json"), JSON.stringify({
    manager: {
      url: `http://127.0.0.1:${managerPort}`,
      port: managerPort,
      host: "0.0.0.0",
    },
    runtime: { buildWorkerImage: false },
  }));
});

afterEach(async () => {
  collectRecordedPids();
  for (const child of children) {
    if (child.pid) terminateProcessGroup(child.pid);
  }
  await new Promise((resolve) => setTimeout(resolve, 50));
  rmSync(tempHome, { recursive: true, force: true });
  for (const key of ENV_KEYS) restoreEnv(key, previousEnv.get(key));
  process.exitCode = previousExitCode;
});

describe("runtime restart --manager-only", () => {
  it("exposes the manager-only option", () => {
    const program = createProgram();
    const runtime = program.commands.find((command) => command.name() === "runtime");
    const restart = runtime?.commands.find((command) => command.name() === "restart");

    expect(restart?.options.map((option) => option.long)).toContain("--manager-only");
  });

  it.each(["missing", "stale"] as const)(
    "replaces Manager with a %s pid file while preserving Node, UI, and Worker",
    async (pidFileState) => {
      const oldManagerPid = await startDummyManager();
      writeManagerState(oldManagerPid, pidFileState);
      const nodePid = startKeeper("node");
      const uiPid = startKeeper("ui-https");
      const workerPid = startKeeper("worker");
      writeUiState(uiPid);

      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      const program = createProgram();
      await program.parseAsync([
        "node",
        "homerail",
        "--json",
        "runtime",
        "restart",
        "--manager-only",
        "--no-build-worker-image",
      ]);

      const output = logSpy.mock.calls.map(([line]) => String(line));
      expect(output).toHaveLength(1);
      const status = JSON.parse(output[0]) as {
        managerPid: number;
        managerPidRunning: boolean;
        nodePid: number;
        nodePidRunning: boolean;
        uiHttpsPid: number;
        uiHttpsPidRunning: boolean;
      };
      children.push({ pid: status.managerPid } as ChildProcess);

      expect(status.managerPid).not.toBe(oldManagerPid);
      expect(status.managerPidRunning).toBe(true);
      expect(status.nodePid).toBe(nodePid);
      expect(status.nodePidRunning).toBe(true);
      expect(status.uiHttpsPid).toBe(uiPid);
      expect(status.uiHttpsPidRunning).toBe(true);
      expect(readPid("worker")).toBe(workerPid);
      expect(isRunning(workerPid)).toBe(true);
      expect(isRunning(oldManagerPid)).toBe(false);
      expect(process.exitCode).toBe(0);

      const starts = readFileSync(join(tempHome, "manager-starts.jsonl"), "utf-8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { pid: number; home: string; host: string; port: number });
      expect(starts.at(-1)).toMatchObject({
        pid: status.managerPid,
        home: tempHome,
        host: "127.0.0.1",
        port: managerPort,
      });
    },
  );

  it("waits past the Manager five-second forced-shutdown boundary", async () => {
    process.env.HOMERAIL_TEST_MANAGER_SHUTDOWN_DELAY_MS = "5200";
    const oldManagerPid = await startDummyManager();
    writeManagerState(oldManagerPid, "missing");
    startKeeper("node");
    startKeeper("ui-https");
    startKeeper("worker");

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const program = createProgram();
    await program.parseAsync([
      "node",
      "homerail",
      "--json",
      "runtime",
      "restart",
      "--manager-only",
      "--no-build-worker-image",
    ]);

    const output = logSpy.mock.calls.map(([line]) => String(line));
    expect(output).toHaveLength(1);
    const status = JSON.parse(output[0]) as { managerPid: number; managerPidRunning: boolean };
    children.push({ pid: status.managerPid } as ChildProcess);

    expect(status.managerPid).not.toBe(oldManagerPid);
    expect(status.managerPidRunning).toBe(true);
    expect(isRunning(oldManagerPid)).toBe(false);
    expect(process.exitCode).toBe(0);
  }, 15_000);

  it("keeps the existing full restart stop semantics by default", async () => {
    const nodePid = startKeeper("node");
    const uiPid = startKeeper("ui-https");
    const workerPid = startKeeper("worker");
    writeUiState(uiPid);
    mkdirSync(join(tempHome, "pids"), { recursive: true });
    writeFileSync(join(tempHome, "pids", "manager.pid"), "999999999\n");

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const program = createProgram();
    await program.parseAsync([
      "node",
      "homerail",
      "--json",
      "runtime",
      "restart",
      "--no-build-worker-image",
    ]);

    const output = logSpy.mock.calls.map(([line]) => String(line));
    expect(output).toHaveLength(1);
    const status = JSON.parse(output[0]) as { managerPid: number; managerPidRunning: boolean };
    children.push({ pid: status.managerPid } as ChildProcess);

    await waitFor(() => !isRunning(nodePid) && !isRunning(uiPid) && !isRunning(workerPid));
    expect(existsSync(join(tempHome, "pids", "node.pid"))).toBe(false);
    expect(existsSync(join(tempHome, "pids", "ui-https.pid"))).toBe(false);
    expect(existsSync(join(tempHome, "pids", "worker.pid"))).toBe(false);
    expect(status.managerPidRunning).toBe(true);
    expect(process.exitCode).toBe(0);
  });
});

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("failed to reserve a test port");
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

async function startDummyManager(): Promise<number> {
  const child = spawn(process.execPath, [join(repoRoot, "homerail_manager", "dist", "index.js")], {
    detached: true,
    env: {
      ...process.env,
      HOMERAIL_HOME: tempHome,
      HOMERAIL_MANAGER_HOST: "127.0.0.1",
      HOMERAIL_MANAGER_PORT: String(managerPort),
    },
    stdio: "ignore",
  });
  child.unref();
  if (!child.pid) throw new Error("failed to start dummy Manager");
  children.push(child);
  await waitFor(async () => {
    try {
      return (await fetch(`http://127.0.0.1:${managerPort}/health`)).ok;
    } catch {
      return false;
    }
  });
  return child.pid;
}

function startKeeper(name: "node" | "ui-https" | "worker"): number {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  if (!child.pid) throw new Error(`failed to start ${name} keeper`);
  children.push(child);
  mkdirSync(join(tempHome, "pids"), { recursive: true });
  writeFileSync(join(tempHome, "pids", `${name}.pid`), `${child.pid}\n`);
  return child.pid;
}

function writeManagerState(pid: number, pidFileState: "missing" | "stale"): void {
  const pidsDir = join(tempHome, "pids");
  mkdirSync(pidsDir, { recursive: true });
  if (pidFileState === "stale") writeFileSync(join(pidsDir, "manager.pid"), "999999999\n");
  writeFileSync(join(pidsDir, "manager.json"), JSON.stringify({
    pid,
    host: "127.0.0.1",
    port: managerPort,
    accessUrl: `http://127.0.0.1:${managerPort}`,
    publicUrl: `http://127.0.0.1:${managerPort}`,
    startedAt: Date.now(),
  }));
}

function writeUiState(pid: number): void {
  writeFileSync(join(tempHome, "pids", "ui-https.json"), JSON.stringify({
    pid,
    host: "127.0.0.1",
    port: 19192,
    protocol: "https",
    managerUrl: `http://127.0.0.1:${managerPort}`,
    publicUrl: "https://127.0.0.1:19192",
    startedAt: Date.now(),
  }));
}

function readPid(name: string): number {
  return Number(readFileSync(join(tempHome, "pids", `${name}.pid`), "utf-8").trim());
}

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`condition was not met within ${timeoutMs}ms`);
}

function collectRecordedPids(): void {
  for (const name of ["manager", "node", "ui-https", "worker"]) {
    const filePath = join(tempHome, "pids", `${name}.pid`);
    if (!existsSync(filePath)) continue;
    const pid = Number(readFileSync(filePath, "utf-8").trim());
    if (Number.isInteger(pid) && pid > 0) children.push({ pid } as ChildProcess);
  }
}

function terminateProcessGroup(pid: number): void {
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Already stopped.
    }
  }
}

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

function dummyManagerSource(): string {
  return `
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");

const home = process.env.HOMERAIL_HOME;
const host = process.env.HOMERAIL_MANAGER_HOST || "127.0.0.1";
const port = Number(process.env.HOMERAIL_MANAGER_PORT);
fs.appendFileSync(
  path.join(home, "manager-starts.jsonl"),
  JSON.stringify({ pid: process.pid, home, host, port }) + "\\n",
);

const server = http.createServer((request, response) => {
  response.setHeader("content-type", "application/json");
  if (request.url === "/health") {
    response.end(JSON.stringify({ status: "ok" }));
    return;
  }
  if (request.url === "/api/runtime/status") {
    response.end(JSON.stringify({
      success: true,
      data: {
        connected_nodes: 1,
        connected_workers: 1,
        active_runs: 0,
        node_ids: ["local-docker-node"],
        worker_ids: ["worker-test"],
      },
    }));
    return;
  }
  response.statusCode = 404;
  response.end(JSON.stringify({ error: "not found" }));
});

server.listen(port, host);
const shutdownDelayMs = Number(process.env.HOMERAIL_TEST_MANAGER_SHUTDOWN_DELAY_MS || 0);
process.on("SIGTERM", () => setTimeout(() => process.exit(0), shutdownDelayMs));
process.on("SIGINT", () => process.exit(0));
`;
}
