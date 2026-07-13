import { describe, it, expect, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { normalizePath } from "../../platform/paths.js";
import { MockProvider } from "../../providers/mock-provider.js";
import {
  handleLifecycleRequest,
  type LifecycleRequest,
  type LifecycleResponse,
} from "../lifecycle-handler.js";

function makeRequest(
  overrides: Partial<LifecycleRequest> = {},
): LifecycleRequest {
  return {
    type: "lifecycle_request",
    request_id: "req-1",
    resource_type: "container",
    operation: "create",
    spec: { image: "alpine:latest" },
    ...overrides,
  };
}

describe("handleLifecycleRequest", () => {
  it("create -> returns container info", async () => {
    const provider = new MockProvider();
    const responses: LifecycleResponse[] = [];
    const send = (msg: LifecycleResponse) => responses.push(msg);

    await handleLifecycleRequest(
      makeRequest({ operation: "create", spec: { image: "alpine:latest" } }),
      provider,
      send,
    );

    expect(responses).toHaveLength(1);
    expect(responses[0]!.status).toBe("success");
    expect(responses[0]!.resource_data).toBeDefined();
    expect(responses[0]!.resource_data!.id).toMatch(/^mock-/);
    expect(responses[0]!.resource_data!.status).toBe("created");
  });

  it("container create validates caller supplied mounts", async () => {
    const previousHome = process.env.HOMERAIL_HOME;
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "homerail-node-mount-policy-"));
    process.env["HOMERAIL_HOME"] = tempHome;
    const provider = new MockProvider();
    const responses: LifecycleResponse[] = [];
    const send = (msg: LifecycleResponse) => responses.push(msg);

    try {
      await handleLifecycleRequest(
        makeRequest({
          operation: "create",
          spec: {
            image: "alpine:latest",
            mounts: [{ host: "/var/run/docker.sock", container: "/var/run/docker.sock" }],
          },
        }),
        provider,
        send,
      );
    } finally {
      if (previousHome === undefined) {
        delete process.env.HOMERAIL_HOME;
      } else {
        process.env.HOMERAIL_HOME = previousHome;
      }
      fs.rmSync(tempHome, { recursive: true, force: true });
    }

    expect(responses).toHaveLength(1);
    expect(responses[0]!.status).toBe("error");
    expect(responses[0]!.error!.message).toContain("Docker socket mount requires allowDockerSocket");
    expect(provider.containers.size).toBe(0);
  });

  it("container create accepts a caller supplied project mount when policy allows that root", async () => {
    const previousHome = process.env.HOMERAIL_HOME;
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "homerail-node-mount-home-"));
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "homerail-node-project-"));
    process.env["HOMERAIL_HOME"] = tempHome;
    const provider = new MockProvider();
    const responses: LifecycleResponse[] = [];
    const send = (msg: LifecycleResponse) => responses.push(msg);

    try {
      await handleLifecycleRequest(
        makeRequest({
          operation: "create",
          spec: {
            image: "alpine:latest",
            mounts: [{ host: projectRoot, container: "/workspace/project", mode: "rw" }],
            mount_policy: { allowed_host_roots: [projectRoot] },
          },
        }),
        provider,
        send,
      );
    } finally {
      if (previousHome === undefined) {
        delete process.env.HOMERAIL_HOME;
      } else {
        process.env.HOMERAIL_HOME = previousHome;
      }
      fs.rmSync(tempHome, { recursive: true, force: true });
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }

    expect(responses).toHaveLength(1);
    expect(responses[0]!.status).toBe("success");
    expect([...provider.containers.values()][0]!.config.mounts).toContainEqual(
      expect.objectContaining({ host: projectRoot, container: "/workspace/project", mode: "rw" }),
    );
  });

  it("start -> success", async () => {
    const provider = new MockProvider();
    const info = await provider.create({ image: "alpine:latest" });
    const responses: LifecycleResponse[] = [];
    const send = (msg: LifecycleResponse) => responses.push(msg);

    await handleLifecycleRequest(
      makeRequest({ operation: "start", spec: { container_id: info.id } }),
      provider,
      send,
    );

    expect(responses).toHaveLength(1);
    expect(responses[0]!.status).toBe("success");

    const inspected = await provider.inspect(info.id);
    expect(inspected.status).toBe("running");
  });

  it("stop -> success", async () => {
    const provider = new MockProvider();
    const info = await provider.create({ image: "alpine:latest" });
    await provider.start(info.id);
    const responses: LifecycleResponse[] = [];
    const send = (msg: LifecycleResponse) => responses.push(msg);

    await handleLifecycleRequest(
      makeRequest({ operation: "stop", spec: { container_id: info.id } }),
      provider,
      send,
    );

    expect(responses).toHaveLength(1);
    expect(responses[0]!.status).toBe("success");

    const inspected = await provider.inspect(info.id);
    expect(inspected.status).toBe("stopped");
  });

  it("inspect -> returns container info", async () => {
    const provider = new MockProvider();
    const info = await provider.create({ image: "alpine:latest" });
    const responses: LifecycleResponse[] = [];
    const send = (msg: LifecycleResponse) => responses.push(msg);

    await handleLifecycleRequest(
      makeRequest({ operation: "inspect", spec: { container_id: info.id } }),
      provider,
      send,
    );

    expect(responses).toHaveLength(1);
    expect(responses[0]!.status).toBe("success");
    expect(responses[0]!.resource_data!.id).toBe(info.id);
  });

  it("logs -> returns log lines", async () => {
    const provider = new MockProvider();
    const info = await provider.create({ image: "alpine:latest" });
    await provider.start(info.id);
    await provider.exec(info.id, ["echo", "hello"]);
    const responses: LifecycleResponse[] = [];
    const send = (msg: LifecycleResponse) => responses.push(msg);

    await handleLifecycleRequest(
      makeRequest({ operation: "logs", spec: { container_id: info.id } }),
      provider,
      send,
    );

    expect(responses).toHaveLength(1);
    expect(responses[0]!.status).toBe("success");
    expect(responses[0]!.resource_data!.lines).toContain("hello\n");
  });

  it("list -> returns containers", async () => {
    const provider = new MockProvider();
    await provider.create({ image: "alpine:latest" });
    await provider.create({ image: "node:20" });
    const responses: LifecycleResponse[] = [];
    const send = (msg: LifecycleResponse) => responses.push(msg);

    await handleLifecycleRequest(
      makeRequest({ operation: "list", spec: {} }),
      provider,
      send,
    );

    expect(responses).toHaveLength(1);
    expect(responses[0]!.status).toBe("success");
    expect(responses[0]!.resource_data!.containers).toHaveLength(2);
  });

  it("remove -> success", async () => {
    const provider = new MockProvider();
    const info = await provider.create({ image: "alpine:latest" });
    const responses: LifecycleResponse[] = [];
    const send = (msg: LifecycleResponse) => responses.push(msg);

    await handleLifecycleRequest(
      makeRequest({ operation: "remove", spec: { container_id: info.id } }),
      provider,
      send,
    );

    expect(responses).toHaveLength(1);
    expect(responses[0]!.status).toBe("success");
    expect(provider.containers.has(info.id)).toBe(false);
  });

  it("exec -> returns exitCode/stdout/stderr", async () => {
    const provider = new MockProvider();
    const info = await provider.create({ image: "alpine:latest" });
    await provider.start(info.id);
    const responses: LifecycleResponse[] = [];
    const send = (msg: LifecycleResponse) => responses.push(msg);

    await handleLifecycleRequest(
      makeRequest({ operation: "exec", spec: { container_id: info.id, cmd: ["echo", "exec-ok"] } }),
      provider,
      send,
    );

    expect(responses).toHaveLength(1);
    expect(responses[0]!.status).toBe("success");
    expect(responses[0]!.resource_data!.stdout).toContain("exec-ok");
    expect(responses[0]!.resource_data!.exitCode).toBe(0);
  });

  it("exec without container_id -> error", async () => {
    const provider = new MockProvider();
    const responses: LifecycleResponse[] = [];
    const send = (msg: LifecycleResponse) => responses.push(msg);

    await handleLifecycleRequest(
      makeRequest({ operation: "exec", spec: { cmd: ["echo", "hello"] } }),
      provider,
      send,
    );

    expect(responses).toHaveLength(1);
    expect(responses[0]!.status).toBe("error");
    expect(responses[0]!.error!.message).toContain("container_id is required");
  });

  it("exec without cmd -> error", async () => {
    const provider = new MockProvider();
    const info = await provider.create({ image: "alpine:latest" });
    await provider.start(info.id);
    const responses: LifecycleResponse[] = [];
    const send = (msg: LifecycleResponse) => responses.push(msg);

    await handleLifecycleRequest(
      makeRequest({ operation: "exec", spec: { container_id: info.id } }),
      provider,
      send,
    );

    expect(responses).toHaveLength(1);
    expect(responses[0]!.status).toBe("error");
    expect(responses[0]!.error!.message).toContain("spec.cmd");
  });

  it("exec with non-string cmd element -> error", async () => {
    const provider = new MockProvider();
    const info = await provider.create({ image: "alpine:latest" });
    await provider.start(info.id);
    const responses: LifecycleResponse[] = [];
    const send = (msg: LifecycleResponse) => responses.push(msg);

    await handleLifecycleRequest(
      makeRequest({ operation: "exec", spec: { container_id: info.id, cmd: ["echo", 123] } }),
      provider,
      send,
    );

    expect(responses).toHaveLength(1);
    expect(responses[0]!.status).toBe("error");
    expect(responses[0]!.error!.message).toContain("spec.cmd");
  });

  it("unsupported resource_type -> error response", async () => {
    const provider = new MockProvider();
    const responses: LifecycleResponse[] = [];
    const send = (msg: LifecycleResponse) => responses.push(msg);

    await handleLifecycleRequest(
      makeRequest({ resource_type: "volume" }),
      provider,
      send,
    );

    expect(responses).toHaveLength(1);
    expect(responses[0]!.status).toBe("error");
    expect(responses[0]!.error!.message).toContain("unsupported resource_type");
  });

  describe("worker resource_type", () => {
    it("create worker -> returns container info with default image", async () => {
      process.env["HOMERAIL_HOME"] = "/home/user/.homerail";
      const provider = new MockProvider();
      const responses: LifecycleResponse[] = [];
      const send = (msg: LifecycleResponse) => responses.push(msg);

      await handleLifecycleRequest(
        makeRequest({ resource_type: "worker", operation: "create", spec: { workspace_id: "ws-1" } }),
        provider,
        send,
      );

      expect(responses).toHaveLength(1);
      expect(responses[0]!.status).toBe("success");
      expect(responses[0]!.resource_data).toBeDefined();
      const data = responses[0]!.resource_data!;
      expect(data.id).toMatch(/^mock-/);
      expect(data.status).toBe("created");

      const container = provider.containers.get(String(data.id));
      expect(container!.config.workdir).toBe("/workspace");
      expect(container!.config.mounts).toHaveLength(1);
      expect(container!.config.mounts![0]!.host).toBe("/home/user/.homerail/workspace/ws-1");
    });

    it("create worker preserves extra host mappings", async () => {
      process.env["HOMERAIL_HOME"] = "/home/user/.homerail";
      const provider = new MockProvider();
      const responses: LifecycleResponse[] = [];
      const send = (msg: LifecycleResponse) => responses.push(msg);

      await handleLifecycleRequest(
        makeRequest({
          resource_type: "worker",
          operation: "create",
          spec: {
            workspace_id: "ws-extra-hosts",
            extra_hosts: ["host.docker.internal:host-gateway"],
          },
        }),
        provider,
        send,
      );

      expect(responses).toHaveLength(1);
      expect(responses[0]!.status).toBe("success");
      const data = responses[0]!.resource_data!;
      const container = provider.containers.get(String(data.id));
      expect(container!.config.extraHosts).toEqual(["host.docker.internal:host-gateway"]);
    });

    it("create worker enforces a read-only workspace mount", async () => {
      process.env["HOMERAIL_HOME"] = "/home/user/.homerail";
      const provider = new MockProvider();
      const responses: LifecycleResponse[] = [];

      await handleLifecycleRequest(
        makeRequest({
          resource_type: "worker",
          operation: "create",
          spec: { workspace_id: "ws-readonly", workspace_read_only: true },
        }),
        provider,
        (message) => responses.push(message),
      );

      expect(responses[0]!.status).toBe("success");
      const container = provider.containers.get(String(responses[0]!.resource_data!.id));
      expect(container!.config.mounts![0]!.mode).toBe("ro");
    });

    it("create worker without workspace_id -> error", async () => {
      const provider = new MockProvider();
      const responses: LifecycleResponse[] = [];
      const send = (msg: LifecycleResponse) => responses.push(msg);

      await handleLifecycleRequest(
        makeRequest({ resource_type: "worker", operation: "create", spec: {} }),
        provider,
        send,
      );

      expect(responses).toHaveLength(1);
      expect(responses[0]!.status).toBe("error");
      expect(responses[0]!.error!.message).toContain("workspace_id is required");
    });

    it("create worker accepts isolated workspace mode", async () => {
      const previousHome = process.env.HOMERAIL_HOME;
      const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "homerail-node-isolated-"));
      process.env["HOMERAIL_HOME"] = tempHome;
      const provider = new MockProvider();
      const responses: LifecycleResponse[] = [];
      const send = (msg: LifecycleResponse) => responses.push(msg);

      try {
        await handleLifecycleRequest(
          makeRequest({
            resource_type: "worker",
            operation: "create",
            spec: { workspace_id: "run-isolated", workspace: { mode: "isolated" } },
          }),
          provider,
          send,
        );
      } finally {
        if (previousHome === undefined) {
          delete process.env.HOMERAIL_HOME;
        } else {
          process.env.HOMERAIL_HOME = previousHome;
        }
        fs.rmSync(tempHome, { recursive: true, force: true });
      }

      expect(responses).toHaveLength(1);
      expect(responses[0]!.status).toBe("success");
      expect(provider.containers.size).toBe(1);
      const data = responses[0]!.resource_data!;
      const container = provider.containers.get(String(data.id));
      expect(container!.config.mounts![0]!.host).toBe(
        normalizePath(path.join(tempHome, "workspace", "run-isolated")),
      );
    });

    it("create worker accepts shared workspace mode", async () => {
      const previousHome = process.env.HOMERAIL_HOME;
      const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "homerail-node-shared-"));
      process.env["HOMERAIL_HOME"] = tempHome;
      const provider = new MockProvider();
      const responses: LifecycleResponse[] = [];

      try {
        await handleLifecycleRequest(
          makeRequest({
            resource_type: "worker",
            operation: "create",
            spec: { workspace_id: "run-shared", workspace: { mode: "shared" } },
          }),
          provider,
          (message) => responses.push(message),
        );
      } finally {
        if (previousHome === undefined) delete process.env.HOMERAIL_HOME;
        else process.env.HOMERAIL_HOME = previousHome;
        fs.rmSync(tempHome, { recursive: true, force: true });
      }

      expect(responses[0]!.status).toBe("success");
      const container = provider.containers.get(String(responses[0]!.resource_data!.id));
      expect(container!.config.mounts![0]!.host).toBe(
        normalizePath(path.join(tempHome, "workspace", "run-shared")),
      );
    });

    it("create worker rejects unsupported workspace preparation modes", async () => {
      process.env["HOMERAIL_HOME"] = "/home/user/.homerail";
      const provider = new MockProvider();
      const responses: LifecycleResponse[] = [];
      const send = (msg: LifecycleResponse) => responses.push(msg);

      await handleLifecycleRequest(
        makeRequest({
          resource_type: "worker",
          operation: "create",
          spec: { workspace_id: "ws-unsupported", workspace: { mode: "host_mount" } },
        }),
        provider,
        send,
      );

      expect(responses).toHaveLength(1);
      expect(responses[0]!.status).toBe("error");
      expect(responses[0]!.error!.message).toContain("unsupported workspace mode");
      expect(provider.containers.size).toBe(0);
    });

    it("start worker -> success", async () => {
      process.env["HOMERAIL_HOME"] = "/home/user/.homerail";
      const provider = new MockProvider();
      const created = await provider.create({ image: "homerail-worker:latest" });
      const responses: LifecycleResponse[] = [];
      const send = (msg: LifecycleResponse) => responses.push(msg);

      await handleLifecycleRequest(
        makeRequest({ resource_type: "worker", operation: "start", spec: { container_id: created.id } }),
        provider,
        send,
      );

      expect(responses).toHaveLength(1);
      expect(responses[0]!.status).toBe("success");
      const inspected = await provider.inspect(created.id);
      expect(inspected.status).toBe("running");
    });

    it("stop worker -> success", async () => {
      process.env["HOMERAIL_HOME"] = "/home/user/.homerail";
      const provider = new MockProvider();
      const created = await provider.create({ image: "homerail-worker:latest" });
      await provider.start(created.id);
      const responses: LifecycleResponse[] = [];
      const send = (msg: LifecycleResponse) => responses.push(msg);

      await handleLifecycleRequest(
        makeRequest({ resource_type: "worker", operation: "stop", spec: { container_id: created.id } }),
        provider,
        send,
      );

      expect(responses).toHaveLength(1);
      expect(responses[0]!.status).toBe("success");
      const inspected = await provider.inspect(created.id);
      expect(inspected.status).toBe("stopped");
    });

    it("logs worker -> returns log lines", async () => {
      process.env["HOMERAIL_HOME"] = "/home/user/.homerail";
      const provider = new MockProvider();
      const created = await provider.create({ image: "homerail-worker:latest" });
      await provider.start(created.id);
      await provider.exec(created.id, ["echo", "worker-log"]);
      const responses: LifecycleResponse[] = [];
      const send = (msg: LifecycleResponse) => responses.push(msg);

      await handleLifecycleRequest(
        makeRequest({ resource_type: "worker", operation: "logs", spec: { container_id: created.id } }),
        provider,
        send,
      );

      expect(responses).toHaveLength(1);
      expect(responses[0]!.status).toBe("success");
      expect(responses[0]!.resource_data!.lines).toContain("worker-log\n");
    });
  });

  it("unsupported operation -> error response", async () => {
    const provider = new MockProvider();
    const responses: LifecycleResponse[] = [];
    const send = (msg: LifecycleResponse) => responses.push(msg);

    await handleLifecycleRequest(
      makeRequest({ operation: "deploy" }),
      provider,
      send,
    );

    expect(responses).toHaveLength(1);
    expect(responses[0]!.status).toBe("error");
    expect(responses[0]!.error!.message).toContain("unsupported operation");
  });

  it("delegates deterministic workspace archive uploads to the configured uploader", async () => {
    const provider = new MockProvider();
    const responses: LifecycleResponse[] = [];
    const uploader = vi.fn(async () => ({
      sha256: "a".repeat(64),
      size_bytes: 42,
      uncompressed_bytes: 100,
      file_count: 2,
      entry_count: 3,
    }));

    await handleLifecycleRequest(
      makeRequest({
        resource_type: "workspace_artifact",
        operation: "archive_upload",
        spec: {
          workspace_id: "run-1",
          path: "evidence",
          archive: { format: "tar.gz", deterministic: true },
          limits: {
            max_files: 100,
            max_uncompressed_bytes: 1_000,
            max_compressed_bytes: 1_000,
            timeout_ms: 10_000,
          },
          media_type: "application/gzip",
          upload_url: "/api/runs/run-1/artifacts/evidence.tar.gz/upload",
          upload_token: "one-time-token",
        },
      }),
      provider,
      (response) => responses.push(response),
      { workspaceArtifactUploader: uploader },
    );

    expect(uploader).toHaveBeenCalledWith(expect.objectContaining({
      workspace_id: "run-1",
      path: "evidence",
      media_type: "application/gzip",
    }));
    expect(responses).toEqual([
      expect.objectContaining({ status: "success", resource_data: expect.objectContaining({ size_bytes: 42 }) }),
    ]);
  });

  it("missing container_id for inspect -> error response", async () => {
    const provider = new MockProvider();
    const responses: LifecycleResponse[] = [];
    const send = (msg: LifecycleResponse) => responses.push(msg);

    await handleLifecycleRequest(
      makeRequest({ operation: "inspect", spec: {} }),
      provider,
      send,
    );

    expect(responses).toHaveLength(1);
    expect(responses[0]!.status).toBe("error");
    expect(responses[0]!.error!.message).toContain("container_id is required");
  });

  it("start non-existent container -> error response", async () => {
    const provider = new MockProvider();
    const responses: LifecycleResponse[] = [];
    const send = (msg: LifecycleResponse) => responses.push(msg);

    await handleLifecycleRequest(
      makeRequest({ operation: "start", spec: { container_id: "nonexistent" } }),
      provider,
      send,
    );

    expect(responses).toHaveLength(1);
    expect(responses[0]!.status).toBe("error");
    expect(responses[0]!.error!.message).toContain("not found");
  });
});
