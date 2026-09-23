import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync, symlinkSync, chmodSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { NativeCodexWorkerService, NATIVE_CODEX_CAPABILITY, resolveNativeCodexWorkerService } from "../native-codex-worker.js";
import { handleLifecycleRequest, type LifecycleResponse } from "../../control-plane/lifecycle-handler.js";
import { createNodeClient } from "../../control-plane/ws-client.js";
import { MockProvider } from "../../providers/mock-provider.js";

const roots: string[] = [];
const services: NativeCodexWorkerService[] = [];

afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.close()));
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function setup(entrySource = "setInterval(() => {}, 1000);") {
  const root = mkdtempSync(path.join(os.tmpdir(), "homerail-native-worker-"));
  roots.push(root);
  const home = path.join(root, "homerail");
  const codexHome = path.join(root, "native-codex");
  mkdirSync(codexHome);
  writeFileSync(path.join(codexHome, "history.jsonl"), "native-history-retained\n");
  const workerEntry = path.join(root, "worker.mjs");
  writeFileSync(workerEntry, entrySource);
  vi.stubEnv("HOMERAIL_HOME", home);
  const env = {
    ...process.env,
    HOMERAIL_HOME: home,
    HOMERAIL_CODEX_SUBSCRIPTION_ENABLED: "1",
    HOMERAIL_CODEX_SUBSCRIPTION_HOME: codexHome,
    HOMERAIL_CODEX_SUBSCRIPTION_BIN: process.execPath,
    HOMERAIL_CODEX_SUBSCRIPTION_WORKER_ENTRY: workerEntry,
    HOMERAIL_MANAGER_ADMIN_TOKEN: "must-not-reach-worker",
    OPENAI_API_KEY: "must-not-reach-worker",
    NODE_OPTIONS: "--not-a-real-node-option",
  };
  const options = { managerUrl: "ws://127.0.0.1:19191", projectId: "p1", env };
  return { root, home, codexHome, workerEntry, env, options };
}

function spec(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    execution_mode: "native_codex_subscription",
    workspace_id: "run-one",
    workspace_read_only: true,
    workspace_access: { writable_paths: [] },
    env: { HOMERAIL_WORKER_ID: "worker-one", MANAGER_WORKER_WS_URL: "ws://127.0.0.1:19191/ws/projects/p1/workers/worker-one" },
    ...overrides,
  };
}

function serviceFor(options: ConstructorParameters<typeof NativeCodexWorkerService>[0]) {
  const service = new NativeCodexWorkerService(options);
  services.push(service);
  return service;
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("test child did not reach expected state");
}

describe.skipIf(process.platform === "win32")("native Codex Worker opt-in boundary", () => {
  it("does not enable or advertise host execution without valid local configuration", () => {
    expect(resolveNativeCodexWorkerService({ managerUrl: "ws://127.0.0.1:19191", projectId: "p1", env: {} })).toBeUndefined();
    expect(() => new NativeCodexWorkerService({ managerUrl: "ws://127.0.0.1:19191", projectId: "p1", env: {} })).toThrow("not enabled");
    expect(() => createNodeClient({ managerUrl: "ws://127.0.0.1:19191", projectId: "p1", nodeId: "node-one", provider: new MockProvider(), capabilities: [NATIVE_CODEX_CAPABILITY] })).toThrow("locally configured");
  });

  it("rejects credentials/history state inside model workspaces and symlinked state directories", () => {
    const { options, home, root } = setup();
    expect(() => serviceFor({ ...options, env: { ...options.env, HOMERAIL_CODEX_SUBSCRIPTION_STATE_DIR: path.join(home, "workspace", "state") } })).toThrow("outside Worker workspaces");
    const alias = path.join(root, "alias");
    symlinkSync(root, alias);
    expect(() => serviceFor({ ...options, env: { ...options.env, HOMERAIL_CODEX_SUBSCRIPTION_STATE_DIR: path.join(alias, "state") } })).toThrow("symlinks");
    const sharedState = path.join(root, "shared-state");
    mkdirSync(sharedState);
    chmodSync(sharedState, 0o777);
    expect(() => serviceFor({ ...options, env: { ...options.env, HOMERAIL_CODEX_SUBSCRIPTION_STATE_DIR: sharedState } })).toThrow("private and owned");
  });

  it.each([
    { image: "arbitrary-image" }, { command: ["touch", "/tmp/no"] }, { workdir: "/" },
    { workspace_id: "../escaped" }, { workspace_read_only: false },
    { workspace_access: { writable_paths: ["repo"] } },
    { workspace: { mode: "local_copy", source_path: "/home" } },
    { env: { HOMERAIL_WORKER_ID: "worker-one", MANAGER_WORKER_WS_URL: "ws://other-host/ws/projects/p1/workers/worker-one" } },
    { env: { HOMERAIL_WORKER_ID: "worker-one", MANAGER_WORKER_WS_URL: "ws://127.0.0.1:19191/ws/projects/p1/workers/worker-one", CODEX_HOME: "/tmp/injected" } },
    { env: { HOMERAIL_WORKER_ID: "worker-one", MANAGER_WORKER_WS_URL: "ws://127.0.0.1:19191/ws/projects/p1/workers/worker-one", NODE_OPTIONS: "--import=bad" } },
  ])("rejects remote authority or writable workspace: %j", async (override) => {
    const { options, home } = setup();
    const service = serviceFor(options);
    await expect(service.create(spec(override))).rejects.toThrow();
    expect(existsSync(path.join(home, "workspace", "run-one"))).toBe(false);
  });

  it("fails closed on unconfigured/unknown native execution and leaves Docker unchanged", async () => {
    const provider = new MockProvider();
    const responses: LifecycleResponse[] = [];
    for (const value of [spec(), spec({ execution_mode: "unknown" }), { workspace_id: "ordinary-run" }]) {
      await handleLifecycleRequest({ type: "lifecycle_request", request_id: "r1", resource_type: "worker", operation: "create", spec: value }, provider, (response) => responses.push(response));
    }
    expect(responses.map((response) => response.status)).toEqual(["error", "error", "success"]);
    expect(provider.containers.size).toBe(1);
  });
});

describe.skipIf(process.platform === "win32")("native Codex Worker process lifecycle", () => {
  it("lets the Worker release its session lease before terminating descendants", async () => {
    const fixture = setup(`
      import fs from 'node:fs';
      import path from 'node:path';
      import { spawn } from 'node:child_process';
      const state = process.env.HOMERAIL_CODEX_SUBSCRIPTION_STATE_DIR;
      const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
      const lease = path.join(state, 'fixture.lock');
      fs.writeFileSync(lease, 'locked');
      process.on('SIGTERM', () => setTimeout(() => {
        process.kill(child.pid, 0);
        fs.unlinkSync(lease);
        fs.writeFileSync(path.join(state, 'released'), 'released');
        process.exit(0);
      }, 80));
      fs.writeFileSync(path.join(state, 'ready'), 'ready');
      setInterval(() => {}, 1000);
    `);
    const service = serviceFor(fixture.options);
    const created = await service.create(spec());
    await service.start(created.id);
    const state = path.join(fixture.home, 'node', 'runtime', 'native_codex_subscription', 'sessions');
    await waitFor(() => existsSync(path.join(state, 'ready')));
    await service.stop(created.id);
    expect(existsSync(path.join(state, 'released'))).toBe(true);
    expect(existsSync(path.join(state, 'fixture.lock'))).toBe(false);
    expect(service.inspect(created.id)).toMatchObject({ status: 'stopped', exitCode: 0 });
  });

  it("starts the fixed entry with filtered env, stops its process group, and retains native history/state", async () => {
    const fixture = setup(`
      import fs from 'node:fs';
      import path from 'node:path';
      import { spawn } from 'node:child_process';
      const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
      fs.writeFileSync(path.join(process.env.HOMERAIL_CODEX_SUBSCRIPTION_STATE_DIR, 'fixture.json'), JSON.stringify({ env: process.env, cwd: process.cwd(), pid: process.pid, childPid: child.pid }));
      setInterval(() => {}, 1000);
    `);
    const service = serviceFor(fixture.options);
    const provider = new MockProvider();
    const invoke = async (operation: string, value: Record<string, unknown>) => {
      let response: LifecycleResponse | undefined;
      await handleLifecycleRequest({ type: "lifecycle_request", request_id: "lifecycle-one", resource_type: "worker", operation, spec: value }, provider, (result) => { response = result; }, { nativeCodexWorker: service });
      return response!;
    };
    const created = await invoke("create", spec({ env: { ...(spec().env as Record<string, string>), HOMERAIL_WORKER_TOKEN: "worker-control-token" } }));
    expect(created.status).toBe("success");
    const id = String(created.resource_data!.id);
    expect(id).toMatch(/^native-codex-worker-/);
    const started = await invoke("start", { container_id: id });
    expect(started.status).toBe("success");
    const stateFile = path.join(fixture.home, "node", "runtime", "native_codex_subscription", "sessions", "fixture.json");
    await waitFor(() => existsSync(stateFile));
    const childState = JSON.parse(readFileSync(stateFile, "utf8")) as { env: Record<string, string>; cwd: string; pid: number; childPid: number };
    expect(childState.env).toMatchObject({ HOMERAIL_CODEX_SUBSCRIPTION_HOME: fixture.codexHome, HOMERAIL_WORKER_TOKEN: "worker-control-token", AGENT_BACKEND: "codex_appserver", HOMERAIL_WORKER_CAPABILITIES: NATIVE_CODEX_CAPABILITY });
    for (const key of ["NODE_OPTIONS", "OPENAI_API_KEY", "HOMERAIL_MANAGER_ADMIN_TOKEN"]) expect(childState.env[key]).toBeUndefined();
    expect(childState.cwd).toBe(path.join(fixture.home, "workspace", "run-one"));
    expect((await invoke("exec", { container_id: id, cmd: ["whoami"] })).status).toBe("error");
    expect((await invoke("remove", { container_id: id })).status).toBe("success");
    expect(() => process.kill(childState.pid, 0)).toThrow();
    // Linux can retain a reparented zombie until init reaps it; it cannot run.
    await waitFor(() => {
      if (process.platform === "linux" && existsSync(`/proc/${childState.childPid}/stat`)) {
        return readFileSync(`/proc/${childState.childPid}/stat`, "utf8").split(") ")[1]![0] === "Z";
      }
      try { process.kill(childState.childPid, 0); return false; } catch { return true; }
    });
    expect(readFileSync(path.join(fixture.codexHome, "history.jsonl"), "utf8")).toBe("native-history-retained\n");
    expect(existsSync(stateFile)).toBe(true);
    expect(provider.containers.size).toBe(0);
  });
});
