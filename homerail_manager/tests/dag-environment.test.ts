import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  HOMERAIL_WORKER_PROTOCOL_LABEL,
  HOMERAIL_WORKER_SOURCE_LABEL,
  HOMERAIL_WORKER_VERSION_LABEL,
  PROTOCOL_VERSION,
} from "homerail-protocol";
import {
  DagEnvironmentController,
  dagWorkerSourceFingerprint,
  type DagEnvironmentCommandRunner,
} from "../src/server/dag-environment.js";
import { subscribe } from "../src/events/bus.js";
import { _clearWorkers, registerWorker } from "../src/worker/registry.js";

const tempDirs: string[] = [];

afterEach(() => {
  vi.useRealTimers();
  _clearWorkers();
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function statusPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "homerail-dag-environment-"));
  tempDirs.push(dir);
  return path.join(dir, "dag-resources.json");
}

function currentRepoRoot(): string {
  return path.resolve(import.meta.dirname, "../..");
}

function currentWorkerVersion(): string {
  const packageJson = JSON.parse(
    fs.readFileSync(
      path.join(currentRepoRoot(), "homerail_worker", "package.json"),
      "utf8",
    ),
  ) as { version: string };
  return packageJson.version;
}

function dockerVersion() {
  return {
    stdout: JSON.stringify({
      Client: { Version: "28.1.0" },
      Server: { Version: "28.1.0", Os: "linux", Arch: "amd64" },
    }),
    stderr: "",
  };
}

function dockerInfo() {
  return {
    stdout: JSON.stringify({ OSType: "linux", Architecture: "amd64" }),
    stderr: "",
  };
}

function imageInspection(
  fingerprint: string,
  protocol = PROTOCOL_VERSION,
  workerVersion = currentWorkerVersion(),
) {
  return {
    stdout: JSON.stringify([{
      Id: "sha256:abc123",
      RepoTags: ["homerail-worker:latest"],
      Created: "2026-07-25T00:00:00Z",
      Size: 123456,
      Os: "linux",
      Architecture: "amd64",
      Config: {
        Labels: {
          [HOMERAIL_WORKER_SOURCE_LABEL]: fingerprint,
          [HOMERAIL_WORKER_PROTOCOL_LABEL]: protocol,
          [HOMERAIL_WORKER_VERSION_LABEL]: workerVersion,
        },
      },
    }]),
    stderr: "",
  };
}

it("classifies a missing Docker CLI without throwing or blocking Manager startup", async () => {
  const runner: DagEnvironmentCommandRunner = vi.fn(async () => {
    const error = Object.assign(new Error("spawn docker ENOENT"), { code: "ENOENT" });
    throw error;
  });
  const controller = new DagEnvironmentController({
    commandRunner: runner,
    platform: "win32",
    repoRoot: currentRepoRoot(),
    statusPath: statusPath(),
  });

  const status = await controller.check();

  expect(status.docker).toMatchObject({
    status: "error",
    reason_code: "docker_cli_missing",
  });
  expect(status.worker_image.reason_code).toBe("docker_cli_missing");
  expect(status.revision).toBeGreaterThan(0);
});

it("classifies platform permission error codes without relying on localized text", async () => {
  const runner: DagEnvironmentCommandRunner = vi.fn(async () => {
    throw Object.assign(new Error("localized Docker error"), { code: "EACCES" });
  });
  const controller = new DagEnvironmentController({
    commandRunner: runner,
    repoRoot: currentRepoRoot(),
    statusPath: statusPath(),
  });

  const status = await controller.check();

  expect(status.docker).toMatchObject({
    status: "error",
    reason_code: "docker_permission_denied",
  });
});

it("probes Docker from a stable temporary cwd when Worker source is absent", async () => {
  const calls: Array<{ cwd?: string }> = [];
  const runner: DagEnvironmentCommandRunner = vi.fn(async (_command, args, options) => {
    calls.push(options);
    if (args[0] === "version") return dockerVersion();
    if (args[0] === "info") return dockerInfo();
    if (args[1] === "ls") return { stdout: "", stderr: "" };
    if (args[1] === "inspect") throw new Error("No such image");
    throw new Error(`Unexpected Docker arguments: ${args.join(" ")}`);
  });
  const controller = new DagEnvironmentController({
    commandRunner: runner,
    repoRoot: path.join(os.tmpdir(), "missing-homerail-worker-source"),
    statusPath: statusPath(),
  });

  const status = await controller.check();

  expect(status.docker.status).toBe("ready");
  expect(status.source.available).toBe(false);
  expect(calls.length).toBeGreaterThan(0);
  expect(calls.every((call) => call.cwd === os.tmpdir())).toBe(true);
});

it("reports image inventory failures instead of leaving the check pending", async () => {
  const runner: DagEnvironmentCommandRunner = vi.fn(async (_command, args) => {
    if (args[0] === "version") return dockerVersion();
    if (args[0] === "info") return dockerInfo();
    throw new Error("image inventory unavailable");
  });
  const controller = new DagEnvironmentController({
    commandRunner: runner,
    repoRoot: currentRepoRoot(),
    statusPath: statusPath(),
  });

  const status = await controller.check();

  expect(status.docker.status).toBe("ready");
  expect(status.worker_image).toMatchObject({
    status: "error",
    reason_code: "docker_check_failed",
    compatibility: "unknown",
  });
  expect(status.images).toEqual([]);
});

it("keeps Docker ready when info is unavailable but version reports a Linux daemon", async () => {
  const fingerprint = dagWorkerSourceFingerprint(currentRepoRoot())!;
  const runner: DagEnvironmentCommandRunner = vi.fn(async (_command, args) => {
    if (args[0] === "version") return dockerVersion();
    if (args[0] === "info") throw new Error("docker info unavailable");
    if (args[1] === "ls") {
      return {
        stdout: JSON.stringify({ Repository: "homerail-worker", Tag: "latest", Labels: "" }),
        stderr: "",
      };
    }
    if (args[1] === "inspect") return imageInspection(fingerprint);
    throw new Error(`Unexpected Docker arguments: ${args.join(" ")}`);
  });
  const controller = new DagEnvironmentController({
    commandRunner: runner,
    repoRoot: currentRepoRoot(),
    statusPath: statusPath(),
  });

  const status = await controller.check();

  expect(status.docker).toMatchObject({
    status: "ready",
    os_type: "linux",
    architecture: "amd64",
  });
  expect(status.worker_image.status).toBe("ready");
});

it("requires Docker's Linux engine when the daemon reports Windows containers", async () => {
  const runner: DagEnvironmentCommandRunner = vi.fn(async (_command, args) => {
    if (args[0] === "version") {
      return {
        stdout: JSON.stringify({
          Client: { Version: "28.1.0" },
          Server: { Version: "28.1.0", Os: "windows", Arch: "amd64" },
        }),
        stderr: "",
      };
    }
    if (args[0] === "info") {
      return {
        stdout: JSON.stringify({ OSType: "windows", Architecture: "amd64" }),
        stderr: "",
      };
    }
    throw new Error(`Unexpected Docker arguments: ${args.join(" ")}`);
  });
  const controller = new DagEnvironmentController({
    commandRunner: runner,
    platform: "win32",
    repoRoot: currentRepoRoot(),
    statusPath: statusPath(),
  });

  const status = await controller.check();

  expect(status.docker).toMatchObject({
    status: "error",
    reason_code: "docker_linux_engine_required",
    os_type: "windows",
  });
  expect(status.worker_image.reason_code).toBe("docker_linux_engine_required");
});

it("lists only HomeRail images and marks the selected image current", async () => {
  const fingerprint = dagWorkerSourceFingerprint(currentRepoRoot());
  expect(fingerprint).toBeTruthy();
  const spawnImpl = vi.fn();
  const runner: DagEnvironmentCommandRunner = vi.fn(async (_command, args) => {
    if (args[0] === "version") return dockerVersion();
    if (args[0] === "info") return dockerInfo();
    if (args[1] === "ls") {
      return {
        stdout: [
          JSON.stringify({ Repository: "homerail-worker", Tag: "latest", Labels: `${HOMERAIL_WORKER_SOURCE_LABEL}=${fingerprint}` }),
          JSON.stringify({ Repository: "postgres", Tag: "16", Labels: "" }),
          JSON.stringify({ Repository: "unrelated", Tag: "latest", Labels: "org.homerail.worker.example=true" }),
          JSON.stringify({ Repository: "versioned-unrelated", Tag: "latest", Labels: `${HOMERAIL_WORKER_VERSION_LABEL}=1.2.3` }),
        ].join("\n"),
        stderr: "",
      };
    }
    if (args[1] === "inspect") return imageInspection(fingerprint!);
    throw new Error(`Unexpected Docker arguments: ${args.join(" ")}`);
  });
  const controller = new DagEnvironmentController({
    commandRunner: runner,
    spawnImpl: spawnImpl as never,
    repoRoot: currentRepoRoot(),
    statusPath: statusPath(),
  });

  const status = await controller.check();

  expect(status.docker.status).toBe("ready");
  expect(status.images).toHaveLength(1);
  expect(status.images[0]).toMatchObject({
    tags: ["homerail-worker:latest"],
    compatibility: "current",
    selected: true,
  });
  expect(status.worker_image).toMatchObject({ status: "ready", compatibility: "current" });
  expect(spawnImpl).not.toHaveBeenCalled();
  expect(runner).not.toHaveBeenCalledWith(
    "docker",
    ["image", "inspect", "unrelated:latest"],
    expect.anything(),
  );
  expect(runner).not.toHaveBeenCalledWith(
    "docker",
    ["image", "inspect", "versioned-unrelated:latest"],
    expect.anything(),
  );
});

it("reports image and connected Worker compatibility independently", async () => {
  const fingerprint = dagWorkerSourceFingerprint(currentRepoRoot())!;
  const runner: DagEnvironmentCommandRunner = vi.fn(async (_command, args) => {
    if (args[0] === "version") return dockerVersion();
    if (args[0] === "info") return dockerInfo();
    if (args[1] === "ls") {
      return { stdout: JSON.stringify({ Repository: "homerail-worker", Tag: "latest", Labels: "" }), stderr: "" };
    }
    if (args[1] === "inspect") return imageInspection("older-source");
    throw new Error(`Unexpected Docker arguments: ${args.join(" ")}`);
  });
  registerWorker({
    worker_id: "old-worker",
    project_id: "p1",
    socket: {} as never,
    status: "idle",
    capabilities: [],
    runtime_identity: {
      worker_version: "0.0.9",
      protocol_version: "0.0.1",
      source_fingerprint: fingerprint,
    },
    registered_at: Date.now(),
    last_heartbeat: Date.now(),
  });
  const controller = new DagEnvironmentController({
    commandRunner: runner,
    repoRoot: currentRepoRoot(),
    statusPath: statusPath(),
  });

  const status = await controller.check();

  expect(status.worker_image).toMatchObject({
    status: "error",
    reason_code: "worker_image_stale",
  });
  expect(status.workers[0]).toMatchObject({
    worker_id: "old-worker",
    compatibility: "incompatible",
  });
});

it("marks matching-protocol Workers with an older package version as stale", () => {
  const fingerprint = dagWorkerSourceFingerprint(currentRepoRoot())!;
  registerWorker({
    worker_id: "older-version-worker",
    project_id: "p1",
    socket: {} as never,
    status: "idle",
    capabilities: [],
    runtime_identity: {
      worker_version: "0.0.9",
      protocol_version: PROTOCOL_VERSION,
      source_fingerprint: fingerprint,
    },
    registered_at: Date.now(),
    last_heartbeat: Date.now(),
  });
  const controller = new DagEnvironmentController({
    repoRoot: currentRepoRoot(),
    statusPath: statusPath(),
  });

  expect(controller.getStatus().workers[0]).toMatchObject({
    worker_id: "older-version-worker",
    worker_version: "0.0.9",
    compatibility: "stale",
  });
});

it("queues one asynchronous build, streams output, and probes the resulting image", async () => {
  const fingerprint = dagWorkerSourceFingerprint(currentRepoRoot())!;
  let built = false;
  const runner: DagEnvironmentCommandRunner = vi.fn(async (_command, args) => {
    if (args[0] === "version") return dockerVersion();
    if (args[0] === "info") return dockerInfo();
    if (args[1] === "ls") {
      return {
        stdout: built
          ? JSON.stringify({ Repository: "homerail-worker", Tag: "latest", Labels: `${HOMERAIL_WORKER_SOURCE_LABEL}=${fingerprint}` })
          : "",
        stderr: "",
      };
    }
    if (args[1] === "inspect" && built) return imageInspection(fingerprint);
    if (args[1] === "inspect") throw new Error("No such image");
    throw new Error(`Unexpected Docker arguments: ${args.join(" ")}`);
  });
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const child = Object.assign(new EventEmitter(), { stdout, stderr });
  const spawnImpl = vi.fn(() => child as never);
  const controller = new DagEnvironmentController({
    commandRunner: runner,
    spawnImpl,
    repoRoot: currentRepoRoot(),
    statusPath: statusPath(),
  });

  const first = controller.startBuild();
  const second = controller.startBuild();
  expect(["queued", "running"]).toContain(first.build?.status);
  expect(second.build?.operation_id).toBe(first.build?.operation_id);

  await vi.waitFor(() => expect(spawnImpl).toHaveBeenCalledTimes(1));
  stdout.write("step one\n");
  built = true;
  child.emit("close", 0, null);

  await vi.waitFor(() => expect(controller.getStatus().worker_image.status).toBe("ready"));
  child.emit("error", new Error("late child error"));
  const status = controller.getStatus();
  expect(status.build?.status).toBe("succeeded");
  expect(status.build?.logs.join("\n")).toContain("step one");
  expect(status.images[0]?.compatibility).toBe("current");
});

it("fails a queued build immediately when Docker is unavailable", async () => {
  const runner: DagEnvironmentCommandRunner = vi.fn(async () => {
    const error = Object.assign(new Error("spawn docker ENOENT"), { code: "ENOENT" });
    throw error;
  });
  const spawnImpl = vi.fn();
  const controller = new DagEnvironmentController({
    commandRunner: runner,
    spawnImpl: spawnImpl as never,
    repoRoot: currentRepoRoot(),
    statusPath: statusPath(),
  });

  controller.startBuild();

  await vi.waitFor(() => expect(controller.getStatus().build?.status).toBe("failed"));
  expect(controller.getStatus().worker_image.reason_code).toBe("worker_image_build_failed");
  expect(spawnImpl).not.toHaveBeenCalled();
});

it("times out a stuck Docker build and preserves the failed terminal state", async () => {
  const runner: DagEnvironmentCommandRunner = vi.fn(async (_command, args) => {
    if (args[0] === "version") return dockerVersion();
    if (args[0] === "info") return dockerInfo();
    if (args[1] === "ls") return { stdout: "", stderr: "" };
    if (args[1] === "inspect") throw new Error("No such image");
    throw new Error(`Unexpected Docker arguments: ${args.join(" ")}`);
  });
  const child = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(() => true),
  });
  const controller = new DagEnvironmentController({
    commandRunner: runner,
    spawnImpl: vi.fn(() => child as never),
    buildTimeoutMs: 10,
    repoRoot: currentRepoRoot(),
    statusPath: statusPath(),
  });

  controller.startBuild();

  await vi.waitFor(() => expect(controller.getStatus().build?.status).toBe("failed"));
  expect(controller.getStatus().build?.error).toContain("timed out");
  expect(child.kill).toHaveBeenCalledTimes(1);
  child.emit("close", 0, null);
  expect(controller.getStatus().build?.status).toBe("failed");
});

it("interrupts and persists an active Docker build during Manager shutdown", async () => {
  const runner: DagEnvironmentCommandRunner = vi.fn(async (_command, args) => {
    if (args[0] === "version") return dockerVersion();
    if (args[0] === "info") return dockerInfo();
    if (args[1] === "ls") return { stdout: "", stderr: "" };
    if (args[1] === "inspect") throw new Error("No such image");
    throw new Error(`Unexpected Docker arguments: ${args.join(" ")}`);
  });
  const child = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(() => true),
  });
  const spawnImpl = vi.fn(() => child as never);
  const persistedPath = statusPath();
  const controller = new DagEnvironmentController({
    commandRunner: runner,
    spawnImpl,
    repoRoot: currentRepoRoot(),
    statusPath: persistedPath,
  });

  controller.startBuild();
  await vi.waitFor(() => expect(spawnImpl).toHaveBeenCalledTimes(1));
  child.stderr.write("last buffered build line\n");
  controller.shutdown();

  expect(child.kill).toHaveBeenCalledWith("SIGTERM");
  expect(controller.getStatus()).toMatchObject({
    build: {
      status: "failed",
      error: "Manager shutdown interrupted the Docker build.",
    },
    worker_image: {
      status: "error",
      reason_code: "worker_image_build_failed",
    },
  });
  const recovered = new DagEnvironmentController({
    repoRoot: currentRepoRoot(),
    statusPath: persistedPath,
  });
  expect(recovered.getStatus().build?.logs.join("\n")).toContain("last buffered build line");
  child.emit("close", 0, null);
  expect(controller.getStatus().build?.status).toBe("failed");
});

it("does not spawn Docker when shutdown interrupts a pre-build environment check", async () => {
  let resolveVersion!: (value: ReturnType<typeof dockerVersion>) => void;
  const version = new Promise<ReturnType<typeof dockerVersion>>((resolve) => {
    resolveVersion = resolve;
  });
  const runner: DagEnvironmentCommandRunner = vi.fn(async (_command, args) => {
    if (args[0] === "version") return version;
    throw new Error(`Unexpected Docker arguments: ${args.join(" ")}`);
  });
  const spawnImpl = vi.fn();
  const controller = new DagEnvironmentController({
    commandRunner: runner,
    spawnImpl: spawnImpl as never,
    repoRoot: currentRepoRoot(),
    statusPath: statusPath(),
  });

  controller.startBuild();
  await vi.waitFor(() => expect(runner).toHaveBeenCalled());
  const pendingCheck = (controller as unknown as {
    checkPromise: Promise<unknown> | null;
  }).checkPromise;
  if (!pendingCheck) throw new Error("expected a pending environment check");
  controller.shutdown();
  resolveVersion(dockerVersion());
  await pendingCheck;
  await Promise.resolve();

  expect(controller.getStatus().build?.status).toBe("failed");
  expect(spawnImpl).not.toHaveBeenCalled();
});

it("does not let an older check overwrite a build started during image inspection", async () => {
  const fingerprint = dagWorkerSourceFingerprint(currentRepoRoot())!;
  let inspectStarted = false;
  let resolveInspection!: (value: ReturnType<typeof imageInspection>) => void;
  const inspection = new Promise<ReturnType<typeof imageInspection>>((resolve) => {
    resolveInspection = resolve;
  });
  const runner: DagEnvironmentCommandRunner = vi.fn(async (_command, args) => {
    if (args[0] === "version") return dockerVersion();
    if (args[0] === "info") return dockerInfo();
    if (args[1] === "ls") {
      return {
        stdout: JSON.stringify({ Repository: "homerail-worker", Tag: "latest", Labels: "" }),
        stderr: "",
      };
    }
    if (args[1] === "inspect") {
      inspectStarted = true;
      return inspection;
    }
    throw new Error(`Unexpected Docker arguments: ${args.join(" ")}`);
  });
  const child = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(() => true),
  });
  const controller = new DagEnvironmentController({
    commandRunner: runner,
    spawnImpl: vi.fn(() => child as never),
    repoRoot: currentRepoRoot(),
    statusPath: statusPath(),
  });

  const check = controller.check();
  await vi.waitFor(() => expect(inspectStarted).toBe(true));
  controller.startBuild();
  resolveInspection(imageInspection(fingerprint));
  await check;
  await vi.waitFor(() => expect(controller.getStatus().build?.status).toBe("running"));

  expect(controller.getStatus().worker_image).toMatchObject({
    status: "building",
    reason: "requested",
  });
  controller.shutdown();
});

it("persists a failed build and accepts a later retry that reaches ready", async () => {
  const fingerprint = dagWorkerSourceFingerprint(currentRepoRoot())!;
  let built = false;
  const runner: DagEnvironmentCommandRunner = vi.fn(async (_command, args) => {
    if (args[0] === "version") return dockerVersion();
    if (args[0] === "info") return dockerInfo();
    if (args[1] === "ls") {
      return {
        stdout: built
          ? JSON.stringify({ Repository: "homerail-worker", Tag: "latest", Labels: "" })
          : "",
        stderr: "",
      };
    }
    if (args[1] === "inspect" && built) return imageInspection(fingerprint);
    if (args[1] === "inspect") throw new Error("No such image");
    throw new Error(`Unexpected Docker arguments: ${args.join(" ")}`);
  });
  const children: Array<EventEmitter & { stdout: PassThrough; stderr: PassThrough }> = [];
  const spawnImpl = vi.fn(() => {
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
    });
    children.push(child);
    return child as never;
  });
  const persistedPath = statusPath();
  const controller = new DagEnvironmentController({
    commandRunner: runner,
    spawnImpl,
    repoRoot: currentRepoRoot(),
    statusPath: persistedPath,
  });

  const first = controller.startBuild();
  await vi.waitFor(() => expect(children).toHaveLength(1));
  children[0]!.stderr.write("first build failed\n");
  children[0]!.emit("close", 1, null);
  await vi.waitFor(() => expect(controller.getStatus().build?.status).toBe("failed"));

  const restarted = new DagEnvironmentController({
    commandRunner: runner,
    spawnImpl,
    repoRoot: currentRepoRoot(),
    statusPath: persistedPath,
  });
  expect(restarted.getStatus()).toMatchObject({
    build: {
      operation_id: first.build?.operation_id,
      status: "failed",
    },
    worker_image: {
      status: "error",
      reason_code: "worker_image_build_failed",
    },
  });

  const retry = controller.startBuild();
  expect(retry.build?.operation_id).not.toBe(first.build?.operation_id);
  await vi.waitFor(() => expect(children).toHaveLength(2));
  built = true;
  children[1]!.emit("close", 0, null);

  await vi.waitFor(() => expect(controller.getStatus().worker_image.status).toBe("ready"));
  expect(controller.getStatus()).toMatchObject({
    build: { status: "succeeded" },
    worker_image: { status: "ready", compatibility: "current" },
  });
});

it("publishes each persisted revision on the existing DAG event bus", async () => {
  const fingerprint = dagWorkerSourceFingerprint(currentRepoRoot())!;
  const runner: DagEnvironmentCommandRunner = vi.fn(async (_command, args) => {
    if (args[0] === "version") return dockerVersion();
    if (args[0] === "info") return dockerInfo();
    if (args[1] === "ls") {
      return {
        stdout: JSON.stringify({ Repository: "homerail-worker", Tag: "latest", Labels: "" }),
        stderr: "",
      };
    }
    if (args[1] === "inspect") return imageInspection(fingerprint);
    throw new Error(`Unexpected Docker arguments: ${args.join(" ")}`);
  });
  const events: Array<{ revision?: number; status?: { revision?: number } }> = [];
  const unsubscribe = subscribe("dag:resource_status_updated", (payload) => {
    events.push(payload as { revision?: number; status?: { revision?: number } });
  });
  const controller = new DagEnvironmentController({
    commandRunner: runner,
    repoRoot: currentRepoRoot(),
    statusPath: statusPath(),
  });

  try {
    const status = await controller.check();
    expect(events.length).toBeGreaterThanOrEqual(2);
    expect(events.at(-1)).toMatchObject({
      revision: status.revision,
      status: { revision: status.revision },
    });
  } finally {
    unsubscribe();
  }
});

it.each(["queued", "running"] as const)(
  "marks a persisted %s build failed after Manager restart",
  (buildStatus) => {
    const persistedPath = statusPath();
    const controller = new DagEnvironmentController({
      repoRoot: currentRepoRoot(),
      statusPath: persistedPath,
    });
    const persisted = controller.getStatus();
    persisted.revision = 7;
    persisted.build = {
      operation_id: `interrupted-${buildStatus}`,
      status: buildStatus,
      started_at: 100,
      logs: ["before restart"],
    };
    fs.writeFileSync(persistedPath, JSON.stringify(persisted), "utf8");

    const recovered = new DagEnvironmentController({
      repoRoot: currentRepoRoot(),
      statusPath: persistedPath,
      now: () => 200,
    }).getStatus();

    expect(recovered.build).toMatchObject({
      operation_id: `interrupted-${buildStatus}`,
      status: "failed",
      finished_at: 200,
      error: "Manager restarted while the image build was running.",
    });
    expect(recovered.build?.logs.at(-1)).toBe("Build interrupted by Manager restart.");
  },
);

it("preserves a succeeded build and falls back safely from corrupt persisted state", () => {
  const persistedPath = statusPath();
  const controller = new DagEnvironmentController({
    repoRoot: currentRepoRoot(),
    statusPath: persistedPath,
  });
  const persisted = controller.getStatus();
  persisted.revision = 9;
  persisted.build = {
    operation_id: "completed-build",
    status: "succeeded",
    started_at: 100,
    finished_at: 150,
    logs: ["complete"],
  };
  fs.writeFileSync(persistedPath, JSON.stringify(persisted), "utf8");

  const recovered = new DagEnvironmentController({
    repoRoot: currentRepoRoot(),
    statusPath: persistedPath,
  }).getStatus();
  expect(recovered.build).toEqual(persisted.build);

  fs.writeFileSync(persistedPath, "{not-json", "utf8");
  const fallback = new DagEnvironmentController({
    repoRoot: currentRepoRoot(),
    statusPath: persistedPath,
  }).getStatus();
  expect(fallback).toMatchObject({
    revision: 0,
    docker: { status: "unknown" },
    worker_image: { status: "unknown" },
  });
  expect(fallback.build).toBeUndefined();
});

it("checks immediately and then at the configured monitoring interval", async () => {
  vi.useFakeTimers();
  let versionChecks = 0;
  const runner: DagEnvironmentCommandRunner = vi.fn(async (_command, args) => {
    if (args[0] === "version") {
      versionChecks += 1;
      return dockerVersion();
    }
    if (args[0] === "info") return dockerInfo();
    if (args[1] === "ls") return { stdout: "", stderr: "" };
    if (args[1] === "inspect") throw new Error("No such image");
    throw new Error(`Unexpected Docker arguments: ${args.join(" ")}`);
  });
  const controller = new DagEnvironmentController({
    commandRunner: runner,
    repoRoot: currentRepoRoot(),
    statusPath: statusPath(),
  });

  controller.startMonitoring(1_000);
  await vi.waitFor(() => expect(versionChecks).toBe(1));
  await vi.advanceTimersByTimeAsync(1_000);
  await vi.waitFor(() => expect(versionChecks).toBe(2));
  controller.stopMonitoring();
});
