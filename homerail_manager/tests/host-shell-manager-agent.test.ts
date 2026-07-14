import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  _forgetHostShellManagerAgentsForTest,
  _hostShellWorkerEntryFingerprintForTest,
  ensureHostShellManagerAgent,
  shutdownHostShellManagerAgents,
} from "../src/server/host-shell-manager-agent.js";

async function availablePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("failed to allocate test port");
  await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
  return address.port;
}

function writeFakeWorker(entry: string, marker: string): void {
  fs.writeFileSync(entry, `
    // ${marker}
    const http = require('node:http');
    const port = Number(process.env.MANAGER_AGENT_PORT || '0');
    const server = http.createServer((req, res) => {
      if (req.method === 'GET' && req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          status: 'running',
          service: 'manager-agent',
          fingerprint: process.env.HOMERAIL_MANAGER_AGENT_FINGERPRINT,
          process_id: process.pid,
          project_id: process.env.PROJECT_ID || null,
          worker_id: process.env.HOMERAIL_WORKER_ID,
        }));
        return;
      }
      res.writeHead(404).end();
    });
    setTimeout(() => server.listen(port, '127.0.0.1'), 100);
  `, "utf-8");
}

function processIsRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForProcessToStop(pid: number): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() <= deadline && processIsRunning(pid)) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

describe("host-shell Manager Agent worker fingerprint", () => {
  let tmpDir: string | undefined;
  let oldHome: string | undefined;
  let oldPort: string | undefined;
  let oldEntry: string | undefined;
  let oldShell: string | undefined;
  let oldWorkspace: string | undefined;

  beforeEach(async () => {
    oldHome = process.env.HOMERAIL_HOME;
    oldPort = process.env.HOMERAIL_MANAGER_AGENT_HOST_PORT;
    oldEntry = process.env.HOMERAIL_MANAGER_AGENT_HOST_ENTRY;
    oldShell = process.env.HOMERAIL_MANAGER_AGENT_SHELL;
    oldWorkspace = process.env.HOMERAIL_PROJECT_WORKSPACE;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "homerail-host-shell-"));
    process.env.HOMERAIL_HOME = tmpDir;
    process.env.HOMERAIL_MANAGER_AGENT_HOST_PORT = String(await availablePort());
    process.env.HOMERAIL_MANAGER_AGENT_SHELL = process.platform === "win32" ? process.execPath : "/bin/sh";
    process.env.HOMERAIL_PROJECT_WORKSPACE = tmpDir;
  });

  afterEach(async () => {
    await shutdownHostShellManagerAgents();
    _forgetHostShellManagerAgentsForTest();
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
    if (oldHome === undefined) delete process.env.HOMERAIL_HOME;
    else process.env.HOMERAIL_HOME = oldHome;
    if (oldPort === undefined) delete process.env.HOMERAIL_MANAGER_AGENT_HOST_PORT;
    else process.env.HOMERAIL_MANAGER_AGENT_HOST_PORT = oldPort;
    if (oldEntry === undefined) delete process.env.HOMERAIL_MANAGER_AGENT_HOST_ENTRY;
    else process.env.HOMERAIL_MANAGER_AGENT_HOST_ENTRY = oldEntry;
    if (oldShell === undefined) delete process.env.HOMERAIL_MANAGER_AGENT_SHELL;
    else process.env.HOMERAIL_MANAGER_AGENT_SHELL = oldShell;
    if (oldWorkspace === undefined) delete process.env.HOMERAIL_PROJECT_WORKSPACE;
    else process.env.HOMERAIL_PROJECT_WORKSPACE = oldWorkspace;
  });

  it("changes when the worker entry build artifact changes", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "homerail-host-shell-fingerprint-"));
    const entry = path.join(tmpDir, "worker-entry.js");
    fs.writeFileSync(entry, "console.log('one')\n", "utf-8");

    const first = _hostShellWorkerEntryFingerprintForTest(entry);
    fs.writeFileSync(entry, "console.log('two with a larger build')\n", "utf-8");
    const second = _hostShellWorkerEntryFingerprintForTest(entry);

    expect(first.path).toBe(path.resolve(entry));
    expect(second.path).toBe(path.resolve(entry));
    expect(second).not.toEqual(first);
  });

  it("coalesces concurrent starts for the same project", async () => {
    const entry = path.join(tmpDir!, "fake-worker.cjs");
    writeFakeWorker(entry, "concurrent start");
    process.env.HOMERAIL_MANAGER_AGENT_HOST_ENTRY = entry;
    const options = { managerRestUrl: "http://127.0.0.1:19191", healthTimeoutMs: 5_000 };

    const [first, second] = await Promise.all([
      ensureHostShellManagerAgent(undefined, options),
      ensureHostShellManagerAgent(undefined, options),
    ]);

    expect(first.processId).toBeTypeOf("number");
    expect(second.processId).toBe(first.processId);
  });

  it("reclaims a persisted process when the Manager restarts with a new worker build", async () => {
    const entry = path.join(tmpDir!, "fake-worker.cjs");
    writeFakeWorker(entry, "first worker build");
    process.env.HOMERAIL_MANAGER_AGENT_HOST_ENTRY = entry;
    const options = { managerRestUrl: "http://127.0.0.1:19191", healthTimeoutMs: 5_000 };

    const first = await ensureHostShellManagerAgent(undefined, options);
    expect(first.processId).toBeTypeOf("number");
    _forgetHostShellManagerAgentsForTest();
    writeFakeWorker(entry, "second worker build with a different artifact size");

    const second = await ensureHostShellManagerAgent(undefined, options);

    expect(second.processId).toBeTypeOf("number");
    expect(second.processId).not.toBe(first.processId);
    await waitForProcessToStop(first.processId!);
    expect(processIsRunning(first.processId!)).toBe(false);
    const state = JSON.parse(fs.readFileSync(
      path.join(tmpDir!, "manager", "manager-agents-host", "__default__", "runtime.json"),
      "utf-8",
    )) as { pid: number; fingerprint: string };
    expect(state.pid).toBe(second.processId);
    expect(state.fingerprint).toMatch(/^[a-f0-9]{16}$/);
  });
});
