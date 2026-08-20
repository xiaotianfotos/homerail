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
  WORKER_CONTRACT_VERSION,
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

function fingerprintFixture(): string {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "homerail-worker-fingerprint-"));
  tempDirs.push(repoRoot);
  const files: Record<string, string> = {
    "homerail_worker/Dockerfile": "FROM node:22\n",
    "homerail_worker/native/codex-secret-guard.c": "int homerail_guard(void) { return 0; }\n",
    "homerail_worker/scripts/configure-apt-sources.mjs": "export const configureAptSources = true;\n",
    "homerail_worker/package.json": JSON.stringify({
      name: "homerail-worker",
      version: "0.1.0-alpha.1",
      dependencies: { "homerail-protocol": "file:../homerail_protocol" },
    }),
    "homerail_worker/package-lock.json": JSON.stringify({
      name: "homerail-worker",
      version: "0.1.0-alpha.1",
      lockfileVersion: 3,
      packages: {
        "": { name: "homerail-worker", version: "0.1.0-alpha.1" },
        "../homerail_protocol": { name: "homerail-protocol", version: "0.1.0-alpha.1" },
      },
    }),
    "homerail_worker/tsconfig.json": JSON.stringify({ compilerOptions: { strict: true } }),
    "homerail_worker/dsh/homerail.cordis.yml": "name: homerail-dsh-test\n",
    "homerail_worker/src/index.ts": "export const worker = true;\n",
    "homerail_protocol/package.json": JSON.stringify({
      name: "homerail-protocol",
      version: "0.1.0-alpha.1",
    }),
    "homerail_protocol/package-lock.json": JSON.stringify({
      name: "homerail-protocol",
      version: "0.1.0-alpha.1",
      lockfileVersion: 3,
      packages: {
        "": { name: "homerail-protocol", version: "0.1.0-alpha.1" },
      },
    }),
    "homerail_protocol/tsconfig.json": JSON.stringify({ compilerOptions: { strict: true } }),
    "homerail_protocol/src/index.ts": "export const contract = 1;\n",
    "homerail_plugin_sdk/package.json": JSON.stringify({
      name: "homerail-plugin-sdk",
      version: "0.1.0-alpha.1",
      dependencies: { "homerail-protocol": "file:../homerail_protocol" },
    }),
    "homerail_plugin_sdk/package-lock.json": JSON.stringify({
      name: "homerail-plugin-sdk",
      version: "0.1.0-alpha.1",
      lockfileVersion: 3,
      packages: {
        "": { name: "homerail-plugin-sdk", version: "0.1.0-alpha.1" },
        "../homerail_protocol": { name: "homerail-protocol", version: "0.1.0-alpha.1" },
      },
    }),
    "homerail_manager/package.json": JSON.stringify({
      name: "homerail-manager",
      version: "0.1.0-alpha.1",
      dependencies: {
        "homerail-plugin-sdk": "file:../homerail_plugin_sdk",
        "homerail-protocol": "file:../homerail_protocol",
      },
    }),
    "homerail_manager/package-lock.json": JSON.stringify({
      name: "homerail-manager",
      version: "0.1.0-alpha.1",
      lockfileVersion: 3,
      packages: {
        "": { name: "homerail-manager", version: "0.1.0-alpha.1" },
        "../homerail_plugin_sdk": { name: "homerail-plugin-sdk", version: "0.1.0-alpha.1" },
        "../homerail_protocol": { name: "homerail-protocol", version: "0.1.0-alpha.1" },
      },
    }),
    "homerail_node/package.json": JSON.stringify({
      name: "homerail-node",
      version: "0.1.0-alpha.1",
      dependencies: { "homerail-protocol": "file:../homerail_protocol" },
    }),
    "homerail_node/package-lock.json": JSON.stringify({
      name: "homerail-node",
      version: "0.1.0-alpha.1",
      lockfileVersion: 3,
      packages: {
        "": { name: "homerail-node", version: "0.1.0-alpha.1" },
        "../homerail_protocol": { name: "homerail-protocol", version: "0.1.0-alpha.1" },
      },
    }),
    "homerail_cli/package.json": JSON.stringify({
      name: "homerail-cli",
      version: "0.1.0-alpha.1",
      dependencies: {
        "homerail-plugin-sdk": "file:../homerail_plugin_sdk",
        "homerail-protocol": "file:../homerail_protocol",
      },
    }),
    "homerail_cli/package-lock.json": JSON.stringify({
      name: "homerail-cli",
      version: "0.1.0-alpha.1",
      lockfileVersion: 3,
      packages: {
        "": { name: "homerail-cli", version: "0.1.0-alpha.1" },
        "../homerail_plugin_sdk": { name: "homerail-plugin-sdk", version: "0.1.0-alpha.1" },
        "../homerail_protocol": { name: "homerail-protocol", version: "0.1.0-alpha.1" },
      },
    }),
    "agent-ui/package.json": JSON.stringify({
      name: "homerail-agent-ui",
      version: "0.1.0-alpha.1",
      dependencies: { "homerail-protocol": "file:../homerail_protocol" },
    }),
    "agent-ui/package-lock.json": JSON.stringify({
      name: "homerail-agent-ui",
      version: "0.1.0-alpha.1",
      lockfileVersion: 3,
      packages: {
        "": { name: "homerail-agent-ui", version: "0.1.0-alpha.1" },
        "../homerail_protocol": { name: "homerail-protocol", version: "0.1.0-alpha.1" },
      },
    }),
  };
  for (const [relativePath, content] of Object.entries(files)) {
    const target = path.join(repoRoot, relativePath);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content, "utf8");
  }
  return repoRoot;
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
  protocol = WORKER_CONTRACT_VERSION,
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

it("ignores release-only package metadata in the Worker source fingerprint", () => {
  const repoRoot = fingerprintFixture();
  const original = dagWorkerSourceFingerprint(repoRoot);

  for (const relativePath of [
    "homerail_worker/package.json",
    "homerail_worker/package-lock.json",
    "homerail_protocol/package.json",
    "homerail_protocol/package-lock.json",
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
  ]) {
    const filePath = path.join(repoRoot, relativePath);
    const metadata = JSON.parse(fs.readFileSync(filePath, "utf8")) as {
      version?: string;
      packages?: Record<string, { version?: string }>;
    };
    metadata.version = "0.1.0-beta.99";
    if (metadata.packages?.[""]) metadata.packages[""].version = "0.1.0-beta.99";
    if (metadata.packages?.["../homerail_protocol"]) {
      metadata.packages["../homerail_protocol"].version = "0.1.0-beta.99";
    }
    if (metadata.packages?.["../homerail_plugin_sdk"]) {
      metadata.packages["../homerail_plugin_sdk"].version = "0.1.0-beta.99";
    }
    fs.writeFileSync(filePath, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
  }

  expect(dagWorkerSourceFingerprint(repoRoot)).toBe(original);
});

it("changes the Worker source fingerprint when build-relevant content changes", () => {
  const repoRoot = fingerprintFixture();
  const original = dagWorkerSourceFingerprint(repoRoot);
  fs.appendFileSync(
    path.join(repoRoot, "homerail_worker", "src", "index.ts"),
    "export const changed = true;\n",
  );

  expect(dagWorkerSourceFingerprint(repoRoot)).not.toBe(original);
});

it("changes the Worker source fingerprint when the DSH composition changes", () => {
  const repoRoot = fingerprintFixture();
  const original = dagWorkerSourceFingerprint(repoRoot);
  fs.appendFileSync(
    path.join(repoRoot, "homerail_worker", "dsh", "homerail.cordis.yml"),
    "changed: true\n",
  );

  expect(dagWorkerSourceFingerprint(repoRoot)).not.toBe(original);
});

it("changes the Worker source fingerprint when the native secret guard changes", () => {
  const repoRoot = fingerprintFixture();
  const original = dagWorkerSourceFingerprint(repoRoot);
  fs.appendFileSync(
    path.join(repoRoot, "homerail_worker", "native", "codex-secret-guard.c"),
    "int homerail_guard_changed(void) { return 1; }\n",
  );

  expect(dagWorkerSourceFingerprint(repoRoot)).not.toBe(original);
});

it("changes the Worker source fingerprint when build dependencies change", () => {
  const repoRoot = fingerprintFixture();
  const original = dagWorkerSourceFingerprint(repoRoot);
  const packagePath = path.join(repoRoot, "homerail_worker", "package.json");
  const metadata = JSON.parse(fs.readFileSync(packagePath, "utf8")) as {
    dependencies: Record<string, string>;
  };
  metadata.dependencies.zod = "^4.0.0";
  fs.writeFileSync(packagePath, JSON.stringify(metadata), "utf8");

  expect(dagWorkerSourceFingerprint(repoRoot)).not.toBe(original);
});

it("changes the Worker source fingerprint when projected Node dependencies change", () => {
  const repoRoot = fingerprintFixture();
  const original = dagWorkerSourceFingerprint(repoRoot);
  const packagePath = path.join(repoRoot, "homerail_node", "package.json");
  const metadata = JSON.parse(fs.readFileSync(packagePath, "utf8")) as {
    dependencies: Record<string, string>;
  };
  metadata.dependencies.dockerode = "^6.0.0";
  fs.writeFileSync(packagePath, JSON.stringify(metadata), "utf8");

  expect(dagWorkerSourceFingerprint(repoRoot)).not.toBe(original);
});

it("changes the Worker source fingerprint when projected Agent UI dependencies change", () => {
  const repoRoot = fingerprintFixture();
  const original = dagWorkerSourceFingerprint(repoRoot);
  const packagePath = path.join(repoRoot, "agent-ui", "package.json");
  const metadata = JSON.parse(fs.readFileSync(packagePath, "utf8")) as {
    dependencies: Record<string, string>;
  };
  metadata.dependencies.vue = "^4.0.0";
  fs.writeFileSync(packagePath, JSON.stringify(metadata), "utf8");

  expect(dagWorkerSourceFingerprint(repoRoot)).not.toBe(original);
});

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

it("does not rebuild a matching-contract Worker for a release-only version difference", () => {
  const fingerprint = dagWorkerSourceFingerprint(currentRepoRoot())!;
  registerWorker({
    worker_id: "older-version-worker",
    project_id: "p1",
    socket: {} as never,
    status: "idle",
    capabilities: [],
    runtime_identity: {
      worker_version: "0.0.9",
      protocol_version: WORKER_CONTRACT_VERSION,
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
    compatibility: "current",
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
  expect(spawnImpl.mock.calls[0]?.[1]).toEqual(expect.arrayContaining([
    "--build-arg", `HOMERAIL_WORKER_PROTOCOL_VERSION=${WORKER_CONTRACT_VERSION}`,
    "--build-arg", `HOMERAIL_WORKER_VERSION=${currentWorkerVersion()}`,
  ]));
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

function readyDockerRunner(fingerprint: string): {
  runner: DagEnvironmentCommandRunner;
  markBuilt: () => void;
} {
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
  return { runner, markBuilt: () => { built = true; } };
}

function buildChild() {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const child = Object.assign(new EventEmitter(), {
    stdout,
    stderr,
    kill: vi.fn(() => true),
  });
  return { child, stdout };
}

it("forwards validated build-network sources and proxy names to the Docker build", async () => {
  const fingerprint = dagWorkerSourceFingerprint(currentRepoRoot())!;
  const { runner, markBuilt } = readyDockerRunner(fingerprint);
  const { child, stdout } = buildChild();
  const spawnImpl = vi.fn(() => child as never);
  const persistedPath = statusPath();
  const controller = new DagEnvironmentController({
    commandRunner: runner,
    spawnImpl,
    repoRoot: currentRepoRoot(),
    statusPath: persistedPath,
    env: {
      HOMERAIL_WORKER_BUILD_APT_MIRROR: "https://mirrors.example.com/debian/",
      HOMERAIL_WORKER_BUILD_NPM_REGISTRY: "https://registry.example.com",
      HOMERAIL_WORKER_BUILD_DSH_GIT_REMOTE: "https://git.example.com/deepseek-harness.git",
      HTTPS_PROXY: "http://proxy.internal:3128",
      http_proxy: "",
    },
  });

  controller.startBuild();

  await vi.waitFor(() => expect(spawnImpl).toHaveBeenCalledTimes(1));
  const args = spawnImpl.mock.calls[0]?.[1] as string[];
  const options = spawnImpl.mock.calls[0]?.[2] as { env: Record<string, string | undefined> };
  expect(args).toEqual(expect.arrayContaining([
    "--build-arg", "HOMERAIL_WORKER_BUILD_APT_MIRROR=https://mirrors.example.com/debian",
    "--build-arg", "NPM_CONFIG_REGISTRY=https://registry.example.com",
    "--build-arg", "HOMERAIL_DSH_FORK_REPOSITORY=https://git.example.com/deepseek-harness.git",
    "--build-arg", "HTTPS_PROXY",
  ]));
  // The trailing-slash variant must normalize to the same argument value.
  expect(args.join("\u0000")).not.toContain("debian/\u0000");
  expect(args).not.toContain("http_proxy");
  // Proxy arguments carry names only; values remain in the child environment.
  const proxyIndex = args.indexOf("HTTPS_PROXY");
  expect(proxyIndex).toBeGreaterThan(0);
  expect(args[proxyIndex - 1]).toBe("--build-arg");
  expect(args[proxyIndex + 1]).not.toContain("proxy.internal");
  expect(args.join("\u0000")).not.toContain("proxy.internal");
  expect(options.env.HTTPS_PROXY).toBe("http://proxy.internal:3128");

  markBuilt();
  stdout.write("step one\n");
  child.emit("close", 0, null);
  await vi.waitFor(() => expect(controller.getStatus().worker_image.status).toBe("ready"));

  const status = controller.getStatus();
  expect(status.worker_image.build_network).toEqual({
    apt_main: "custom",
    apt_security: "default",
    npm: "custom",
    dsh_git: "custom",
    proxy: "environment",
  });
  const logs = status.build?.logs.join("\n") ?? "";
  expect(logs).toContain("Worker build network: apt_main=custom apt_security=default npm=custom dsh_git=custom proxy=environment");
  expect(logs).not.toContain("mirrors.example.com");
  expect(logs).not.toContain("registry.example.com");
  expect(logs).not.toContain("git.example.com");
  expect(logs).not.toContain("proxy.internal");
  const persisted = fs.readFileSync(persistedPath, "utf8");
  expect(persisted).toContain("\"build_network\"");
  expect(persisted).not.toContain("mirrors.example.com");
  expect(persisted).not.toContain("registry.example.com");
  expect(persisted).not.toContain("git.example.com");
  expect(persisted).not.toContain("proxy.internal");
});

it("keeps default build arguments and docker-managed proxy mode without configuration", async () => {
  const fingerprint = dagWorkerSourceFingerprint(currentRepoRoot())!;
  const { runner, markBuilt } = readyDockerRunner(fingerprint);
  const { child, stdout } = buildChild();
  const spawnImpl = vi.fn(() => child as never);
  const persistedPath = statusPath();
  const controller = new DagEnvironmentController({
    commandRunner: runner,
    spawnImpl,
    repoRoot: currentRepoRoot(),
    statusPath: persistedPath,
    env: {},
  });

  controller.startBuild();

  await vi.waitFor(() => expect(spawnImpl).toHaveBeenCalledTimes(1));
  const argText = (spawnImpl.mock.calls[0]?.[1] as string[]).join("\n");
  for (const forbidden of [
    "HOMERAIL_WORKER_BUILD_APT_MIRROR",
    "HOMERAIL_WORKER_BUILD_APT_SECURITY_MIRROR",
    "NPM_CONFIG_REGISTRY",
    "HOMERAIL_DSH_FORK_REPOSITORY",
    "HTTP_PROXY",
    "http_proxy",
    "HTTPS_PROXY",
    "https_proxy",
    "NO_PROXY",
    "no_proxy",
  ]) {
    expect(argText).not.toContain(forbidden);
  }

  markBuilt();
  stdout.write("step one\n");
  child.emit("close", 0, null);
  await vi.waitFor(() => expect(controller.getStatus().worker_image.status).toBe("ready"));

  const status = controller.getStatus();
  expect(status.worker_image.build_network).toEqual({
    apt_main: "default",
    apt_security: "default",
    npm: "default",
    dsh_git: "default",
    proxy: "docker-managed",
  });
  expect(status.build?.logs.join("\n")).toContain(
    "Worker build network: apt_main=default apt_security=default npm=default dsh_git=default proxy=docker-managed",
  );
});

it("reports invalid build-network configuration before a build is requested", () => {
  const runner: DagEnvironmentCommandRunner = vi.fn(async () => dockerVersion());
  const spawnImpl = vi.fn();
  const controller = new DagEnvironmentController({
    commandRunner: runner,
    spawnImpl: spawnImpl as never,
    repoRoot: currentRepoRoot(),
    statusPath: statusPath(),
    env: {
      HOMERAIL_WORKER_BUILD_APT_MIRROR: "https://user:secret@mirrors.example.com/debian",
    },
  });

  const status = controller.getStatus();
  expect(status.build).toBeUndefined();
  expect(status.worker_image).toMatchObject({
    status: "error",
    reason: "worker_build_network_invalid",
    reason_code: "worker_build_network_invalid",
  });
  expect(status.worker_image.message).toContain("HOMERAIL_WORKER_BUILD_APT_MIRROR");
  expect(status.worker_image.error).toContain("HOMERAIL_WORKER_BUILD_APT_MIRROR");
  expect(status.worker_image.message).not.toContain("secret");
  expect(status.worker_image.message).not.toContain("mirrors.example.com");
  expect(status.worker_image.build_network).toBeUndefined();
  expect(spawnImpl).not.toHaveBeenCalled();
  expect(runner).not.toHaveBeenCalled();
});

it("fails the build before Docker starts when build-network configuration is invalid", async () => {
  const runner: DagEnvironmentCommandRunner = vi.fn(async () => dockerVersion());
  const spawnImpl = vi.fn();
  const controller = new DagEnvironmentController({
    commandRunner: runner,
    spawnImpl: spawnImpl as never,
    repoRoot: currentRepoRoot(),
    statusPath: statusPath(),
    env: {
      HOMERAIL_WORKER_BUILD_APT_MIRROR: "https://user:secret@mirrors.example.com/debian",
    },
  });

  controller.startBuild();

  await vi.waitFor(() => expect(controller.getStatus().build?.status).toBe("failed"));
  const status = controller.getStatus();
  expect(status.build?.error).toContain("HOMERAIL_WORKER_BUILD_APT_MIRROR");
  expect(status.build?.error).not.toContain("secret");
  expect(status.build?.error).not.toContain("mirrors.example.com");
  expect(status.build?.logs.join("\n")).not.toContain("secret");
  expect(status.worker_image.status).toBe("error");
  expect(status.worker_image.reason_code).toBe("worker_build_network_invalid");
  expect(status.worker_image.error).toContain("HOMERAIL_WORKER_BUILD_APT_MIRROR");
  expect(status.worker_image.build_network).toBeUndefined();
  expect(spawnImpl).not.toHaveBeenCalled();
  expect(runner).not.toHaveBeenCalled();
});

it("normalizes persisted worker_image status that predates build_network", () => {
  const persistedPath = statusPath();
  const first = new DagEnvironmentController({
    repoRoot: currentRepoRoot(),
    statusPath: persistedPath,
    env: {},
  });
  const snapshot = first.getStatus();
  snapshot.revision = 7;
  snapshot.build = {
    operation_id: "older-build",
    status: "succeeded",
    started_at: 100,
    finished_at: 200,
    logs: ["complete"],
  };
  // Simulate a Manager version that never wrote build_network.
  delete snapshot.worker_image.build_network;
  fs.writeFileSync(persistedPath, JSON.stringify(snapshot), "utf8");

  const recovered = new DagEnvironmentController({
    repoRoot: currentRepoRoot(),
    statusPath: persistedPath,
    env: { HOMERAIL_WORKER_BUILD_NPM_REGISTRY: "https://registry.example.com" },
  }).getStatus();
  expect(recovered.revision).toBe(7);
  expect(recovered.build?.operation_id).toBe("older-build");
  expect(recovered.worker_image.build_network).toEqual({
    apt_main: "default",
    apt_security: "default",
    npm: "custom",
    dsh_git: "default",
    proxy: "docker-managed",
  });
});

it("normalizes malformed persisted build_network values safely", () => {
  const persistedPath = statusPath();
  const first = new DagEnvironmentController({
    repoRoot: currentRepoRoot(),
    statusPath: persistedPath,
    env: {},
  });
  const snapshot = first.getStatus();
  snapshot.revision = 3;
  (snapshot.worker_image as { build_network?: unknown }).build_network = {
    apt_main: "weird",
    apt_security: ["custom"],
    npm: 1,
    dsh_git: ["custom"],
    proxy: "none",
  };
  fs.writeFileSync(persistedPath, JSON.stringify(snapshot), "utf8");

  const recovered = new DagEnvironmentController({
    repoRoot: currentRepoRoot(),
    statusPath: persistedPath,
    env: {},
  }).getStatus();
  expect(recovered.revision).toBe(3);
  expect(recovered.worker_image.build_network).toEqual({
    apt_main: "default",
    apt_security: "default",
    npm: "default",
    dsh_git: "default",
    proxy: "docker-managed",
  });
});
