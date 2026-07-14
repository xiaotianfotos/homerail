import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  DockerCliProvider,
  DockerNotFoundError,
  DockerDaemonError,
  DockerPermissionError,
  resolveDockerCliPath,
} from "../docker-cli-provider.js";

const { mockExecFileCb, mockSpawn } = vi.hoisted(() => ({
  mockExecFileCb: vi.fn((...args: unknown[]) => {
    const cb = args[args.length - 1] as ((...a: unknown[]) => void) | undefined;
    if (typeof cb === "function") {
      cb(null, "", "");
    }
  }),
  mockSpawn: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  execFile: mockExecFileCb,
  spawn: mockSpawn,
}));

describe("resolveDockerCliPath", () => {
  it("uses HOMERAIL_DOCKER_BIN when configured", () => {
    expect(resolveDockerCliPath({
      env: { HOMERAIL_DOCKER_BIN: "\"C:\\Docker\\docker.exe\"" } as NodeJS.ProcessEnv,
      platform: "win32",
      existsSync: () => false,
    })).toBe("C:\\Docker\\docker.exe");
  });

  it("finds the Docker Desktop CLI in the default Windows install path", () => {
    const expected = "C:\\Program Files\\Docker\\Docker\\resources\\bin\\docker.exe";
    expect(resolveDockerCliPath({
      env: { ProgramFiles: "C:\\Program Files" } as NodeJS.ProcessEnv,
      platform: "win32",
      existsSync: (candidate) => candidate === expected,
    })).toBe(expected);
  });

  it("falls back to docker when no configured or default binary exists", () => {
    expect(resolveDockerCliPath({
      env: {} as NodeJS.ProcessEnv,
      platform: "linux",
      existsSync: () => false,
    })).toBe("docker");
  });
});

function resolveWith(stdout: string, stderr?: string) {
  return vi.fn((...args: unknown[]) => {
    const cb = args[args.length - 1] as (
      err: Error | null,
      out: string,
      errOut: string,
    ) => void;
    if (typeof cb === "function") {
      cb(null, stdout, stderr ?? "");
    }
  });
}

function rejectWith(err: Error) {
  return vi.fn((...args: unknown[]) => {
    const cb = args[args.length - 1] as (
      err: Error | null,
      out: string,
      errOut: string,
    ) => void;
    if (typeof cb === "function") {
      cb(err, "", "");
    }
  });
}

function execFileOptions(callIndex: number): Record<string, unknown> {
  return mockExecFileCb.mock.calls[callIndex]?.[2] as Record<string, unknown>;
}

function makeInspectJson(
  id: string,
  status: string,
  exitCode?: number,
): string {
  return JSON.stringify([
    {
      Id: id,
      Name: "/test-container",
      Config: { Image: "node:20-alpine" },
      State: {
        Status: status,
        ExitCode: exitCode ?? 0,
        StartedAt: "2026-01-01T00:00:00Z",
        FinishedAt: "2026-01-01T00:01:00Z",
        Error: "",
      },
    },
  ]);
}

describe("DockerCliProvider (unit, mocked)", () => {
  let provider: DockerCliProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new DockerCliProvider({
      env: {} as NodeJS.ProcessEnv,
      platform: "linux",
      existsSync: () => false,
    });
  });

  describe("create", () => {
    it("calls docker create with image only", async () => {
      mockExecFileCb.mockImplementationOnce(resolveWith("abc123\n"));
      mockExecFileCb.mockImplementationOnce(
        resolveWith(makeInspectJson("abc123", "created")),
      );

      const info = await provider.create({ image: "node:20-alpine" });
      expect(info.id).toBe("abc123");
      expect(info.status).toBe("created");
    });

    it("includes name and env when provided", async () => {
      mockExecFileCb.mockImplementationOnce(resolveWith("abc123\n"));
      mockExecFileCb.mockImplementationOnce(
        resolveWith(makeInspectJson("abc123", "created")),
      );

      await provider.create({
        image: "node:20-alpine",
        name: "mycont",
        env: { FOO: "bar" },
      });

      const createArgs = mockExecFileCb.mock.calls[0]![1] as string[];
      expect(createArgs).toContain("--name");
      expect(createArgs).toContain("mycont");
      expect(createArgs).toContain("-e");
      expect(createArgs).toContain("FOO=bar");
    });

    it("passes the Manager credential by inherited env without exposing its value in argv", async () => {
      mockExecFileCb.mockImplementationOnce(resolveWith("abc123\n"));
      mockExecFileCb.mockImplementationOnce(
        resolveWith(makeInspectJson("abc123", "created")),
      );
      const token = "node-manager-admin-token-0123456789abcdef";

      await provider.create({
        image: "node:20-alpine",
        env: { HOMERAIL_MANAGER_ADMIN_TOKEN: token },
      });

      const createArgs = mockExecFileCb.mock.calls[0]![1] as string[];
      const createOptions = mockExecFileCb.mock.calls[0]![2] as { env?: NodeJS.ProcessEnv };
      expect(createArgs).toContain("HOMERAIL_MANAGER_ADMIN_TOKEN");
      expect(createArgs.join(" ")).not.toContain(token);
      expect(createOptions.env?.HOMERAIL_MANAGER_ADMIN_TOKEN).toBe(token);
    });

    it("renders the attested non-root sandbox profile without putting secrets in argv", async () => {
      mockExecFileCb.mockImplementationOnce(resolveWith("abc123\n"));
      mockExecFileCb.mockImplementationOnce(
        resolveWith(makeInspectJson("abc123", "created")),
      );
      const capabilitySecret = "runtime-capability-secret-0123456789abcdef";

      await provider.create({
        image: "plugin-runtime:latest",
        user: "65532:65532",
        readOnlyRootfs: true,
        noNewPrivileges: true,
        capDrop: ["ALL"],
        securityOpts: ["seccomp=/profiles/plugin-runtime.json"],
        network: "none",
        devices: [{ host: "/dev/dri/renderD128", permissions: "r" }],
        gpus: ["0"],
        env: { HOMERAIL_PLUGIN_CAPABILITY_SECRET: capabilitySecret },
      });

      const createArgs = mockExecFileCb.mock.calls[0]![1] as string[];
      const createOptions = mockExecFileCb.mock.calls[0]![2] as { env?: NodeJS.ProcessEnv };
      expect(createArgs).toEqual(expect.arrayContaining([
        "--user", "65532:65532",
        "--read-only",
        "--security-opt", "no-new-privileges:true",
        "--cap-drop", "ALL",
        "seccomp=/profiles/plugin-runtime.json",
        "--network", "none",
        "--device", "/dev/dri/renderD128:/dev/dri/renderD128:r",
        "--gpus", "device=0",
        "HOMERAIL_PLUGIN_CAPABILITY_SECRET",
      ]));
      expect(createArgs.join(" ")).not.toContain(capabilitySecret);
      expect(createOptions.env?.HOMERAIL_PLUGIN_CAPABILITY_SECRET).toBe(capabilitySecret);
    });

    it("includes mounts in create args", async () => {
      mockExecFileCb.mockImplementationOnce(resolveWith("abc123\n"));
      mockExecFileCb.mockImplementationOnce(
        resolveWith(makeInspectJson("abc123", "created")),
      );

      await provider.create({
        image: "node:20-alpine",
        mounts: [{ host: "/host/path", container: "/data", mode: "ro" }],
      });

      const createArgs = mockExecFileCb.mock.calls[0]![1] as string[];
      expect(createArgs).toContain("--mount");
      expect(createArgs).toContain("type=bind,source=/host/path,target=/data,readonly");
    });

    it("uses --mount so Windows drive paths are not split on the drive colon", async () => {
      mockExecFileCb.mockImplementationOnce(resolveWith("abc123\n"));
      mockExecFileCb.mockImplementationOnce(
        resolveWith(makeInspectJson("abc123", "created")),
      );

      await provider.create({
        image: "node:20-alpine",
        mounts: [{
          host: "D:/work/HomeRail/.homerail/workspaces/run-1",
          container: "/workspace",
          mode: "rw",
        }],
      });

      const createArgs = mockExecFileCb.mock.calls[0]![1] as string[];
      const mountIndex = createArgs.indexOf("--mount");
      expect(mountIndex).toBeGreaterThan(-1);
      expect(createArgs[mountIndex + 1]).toBe(
        "type=bind,source=D:/work/HomeRail/.homerail/workspaces/run-1,target=/workspace",
      );
    });

    it("keeps Windows paths with spaces as one --mount argument", async () => {
      mockExecFileCb.mockImplementationOnce(resolveWith("abc123\n"));
      mockExecFileCb.mockImplementationOnce(
        resolveWith(makeInspectJson("abc123", "created")),
      );

      await provider.create({
        image: "node:20-alpine",
        mounts: [{
          host: "D:/HomeRail Data/workspaces/run 1",
          container: "/workspace",
          mode: "rw",
        }],
      });

      const createArgs = mockExecFileCb.mock.calls[0]![1] as string[];
      const mountIndex = createArgs.indexOf("--mount");
      expect(createArgs[mountIndex + 1]).toBe(
        "type=bind,source=D:/HomeRail Data/workspaces/run 1,target=/workspace",
      );
    });

    it("keeps UNC paths as one --mount argument", async () => {
      mockExecFileCb.mockImplementationOnce(resolveWith("abc123\n"));
      mockExecFileCb.mockImplementationOnce(
        resolveWith(makeInspectJson("abc123", "created")),
      );

      await provider.create({
        image: "node:20-alpine",
        mounts: [{
          host: "//server/share/HomeRail/workspaces/run-1",
          container: "/workspace",
          mode: "ro",
        }],
      });

      const createArgs = mockExecFileCb.mock.calls[0]![1] as string[];
      const mountIndex = createArgs.indexOf("--mount");
      expect(createArgs[mountIndex + 1]).toBe(
        "type=bind,source=//server/share/HomeRail/workspaces/run-1,target=/workspace,readonly",
      );
    });

    it("includes port bindings in create args", async () => {
      mockExecFileCb.mockImplementationOnce(resolveWith("abc123\n"));
      mockExecFileCb.mockImplementationOnce(
        resolveWith(makeInspectJson("abc123", "created")),
      );

      await provider.create({
        image: "node:20-alpine",
        ports: [{ hostIp: "127.0.0.1", hostPort: 39001, containerPort: 9001 }],
      });

      const createArgs = mockExecFileCb.mock.calls[0]![1] as string[];
      expect(createArgs).toContain("-p");
      expect(createArgs).toContain("127.0.0.1:39001:9001/tcp");
    });

    it("includes labels when provided", async () => {
      mockExecFileCb.mockImplementationOnce(resolveWith("abc123\n"));
      mockExecFileCb.mockImplementationOnce(
        resolveWith(makeInspectJson("abc123", "created")),
      );

      await provider.create({
        image: "node:20-alpine",
        labels: { app: "homerail", run: "test" },
      });

      const createArgs = mockExecFileCb.mock.calls[0]![1] as string[];
      expect(createArgs).toContain("--label");
      expect(createArgs).toContain("app=homerail");
    });

    it("includes extra hosts when provided", async () => {
      mockExecFileCb.mockImplementationOnce(resolveWith("abc123\n"));
      mockExecFileCb.mockImplementationOnce(
        resolveWith(makeInspectJson("abc123", "created")),
      );

      await provider.create({
        image: "node:20-alpine",
        extraHosts: ["host.docker.internal:host-gateway"],
      });

      const createArgs = mockExecFileCb.mock.calls[0]![1] as string[];
      expect(createArgs).toContain("--add-host");
      expect(createArgs).toContain("host.docker.internal:host-gateway");
    });

    it("does not use --privileged", async () => {
      mockExecFileCb.mockImplementationOnce(resolveWith("abc123\n"));
      mockExecFileCb.mockImplementationOnce(
        resolveWith(makeInspectJson("abc123", "created")),
      );

      await provider.create({ image: "node:20-alpine" });

      const createArgs = mockExecFileCb.mock.calls[0]![1] as string[];
      expect(createArgs).not.toContain("--privileged");
    });

    it("orders multi-argument command as --entrypoint <entry> <image> <args...>", async () => {
      mockExecFileCb.mockImplementationOnce(resolveWith("abc123\n"));
      mockExecFileCb.mockImplementationOnce(
        resolveWith(makeInspectJson("abc123", "created")),
      );

      await provider.create({
        image: "node:20-alpine",
        command: ["node", "dist/index.js"],
      });

      const createArgs = mockExecFileCb.mock.calls[0]![1] as string[];
      // verify order: --entrypoint node node:20-alpine dist/index.js
      const entryIdx = createArgs.indexOf("--entrypoint");
      const imgIdx = createArgs.indexOf("node:20-alpine");
      expect(entryIdx).toBeGreaterThan(-1);
      expect(imgIdx).toBeGreaterThan(entryIdx);
      // image must appear before any extra command args
      expect(createArgs[entryIdx + 1]).toBe("node");
      expect(createArgs[entryIdx + 2]).toBe("node:20-alpine");
      expect(createArgs[entryIdx + 3]).toBe("dist/index.js");
    });

    it("orders single-argument command as --entrypoint <entry> <image>", async () => {
      mockExecFileCb.mockImplementationOnce(resolveWith("abc123\n"));
      mockExecFileCb.mockImplementationOnce(
        resolveWith(makeInspectJson("abc123", "created")),
      );

      await provider.create({
        image: "node:20-alpine",
        command: ["/bin/sh"],
      });

      const createArgs = mockExecFileCb.mock.calls[0]![1] as string[];
      const entryIdx = createArgs.indexOf("--entrypoint");
      const imgIdx = createArgs.indexOf("node:20-alpine");
      expect(entryIdx).toBeGreaterThan(-1);
      expect(imgIdx).toBeGreaterThan(entryIdx);
      expect(createArgs[entryIdx + 1]).toBe("/bin/sh");
      expect(createArgs[entryIdx + 2]).toBe("node:20-alpine");
      // no extra args beyond image
      expect(createArgs.length).toBe(imgIdx + 1);
    });

    it("does not mount docker.sock", async () => {
      mockExecFileCb.mockImplementationOnce(resolveWith("abc123\n"));
      mockExecFileCb.mockImplementationOnce(
        resolveWith(makeInspectJson("abc123", "created")),
      );

      await provider.create({ image: "node:20-alpine" });

      const createArgs = mockExecFileCb.mock.calls[0]![1] as string[];
      const joined = createArgs.join(" ");
      expect(joined).not.toContain("docker.sock");
    });
  });

  describe("start", () => {
    it("calls docker start", async () => {
      mockExecFileCb.mockImplementationOnce(resolveWith(""));
      await provider.start("abc123");
      expect(mockExecFileCb).toHaveBeenCalledWith(
        "docker",
        ["start", "abc123"],
        expect.objectContaining({ windowsHide: true }),
        expect.any(Function),
      );
    });

    it("uses a configured Docker executable path", async () => {
      provider = new DockerCliProvider({ dockerPath: "C:/Docker/docker.exe" });
      mockExecFileCb.mockImplementationOnce(resolveWith(""));
      await provider.start("abc123");
      expect(mockExecFileCb).toHaveBeenCalledWith(
        "C:/Docker/docker.exe",
        ["start", "abc123"],
        expect.objectContaining({ windowsHide: true }),
        expect.any(Function),
      );
    });
  });

  describe("stop", () => {
    it("calls docker stop", async () => {
      mockExecFileCb.mockImplementationOnce(resolveWith(""));
      await provider.stop("abc123");
      expect(mockExecFileCb).toHaveBeenCalledWith(
        "docker",
        ["stop", "abc123"],
        expect.objectContaining({ windowsHide: true }),
        expect.any(Function),
      );
    });
  });

  describe("remove", () => {
    it("calls docker rm -f", async () => {
      mockExecFileCb.mockImplementationOnce(resolveWith(""));
      await provider.remove("abc123");
      expect(mockExecFileCb).toHaveBeenCalledWith(
        "docker",
        ["rm", "-f", "abc123"],
        expect.objectContaining({ windowsHide: true }),
        expect.any(Function),
      );
    });
  });

  describe("exec", () => {
    it("executes command in container and returns stdout/stderr", async () => {
      mockExecFileCb.mockImplementationOnce(resolveWith("hello\n"));
      const result = await provider.exec("abc123", ["echo", "hello"]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("hello");
      expect(execFileOptions(0)).toMatchObject({ windowsHide: true });
    });

    it("returns non-zero exit code from exec failure", async () => {
      const err = Object.assign(new Error("exec failed"), { code: 127 });
      mockExecFileCb.mockImplementationOnce(rejectWith(err));
      const result = await provider.exec("abc123", ["nonexistent"]);
      expect(result.exitCode).toBe(127);
      expect(result.stderr).toContain("exec failed");
    });
  });

  describe("inspect", () => {
    it("returns container info with normalized status", async () => {
      mockExecFileCb.mockImplementationOnce(
        resolveWith(makeInspectJson("abc123", "running", 0)),
      );
      const info = await provider.inspect("abc123");
      expect(info.status).toBe("running");
      expect(info.exitCode).toBe(0);
    });

    it("normalizes 'exited' to 'stopped'", async () => {
      mockExecFileCb.mockImplementationOnce(
        resolveWith(makeInspectJson("abc123", "exited", 1)),
      );
      const info = await provider.inspect("abc123");
      expect(info.status).toBe("stopped");
      expect(info.exitCode).toBe(1);
    });
  });

  describe("list", () => {
    it("returns list of containers", async () => {
      const dockerPsOutput = [
        JSON.stringify({
          ID: "abc123",
          State: "running",
          ExitCode: 0,
          StartedAt: "2026-01-01T00:00:00Z",
          FinishedAt: "",
          Error: "",
        }),
        JSON.stringify({
          ID: "def456",
          State: "exited",
          ExitCode: 1,
          StartedAt: "2026-01-01T00:00:00Z",
          FinishedAt: "2026-01-01T00:01:00Z",
          Error: "",
        }),
      ].join("\n");

      mockExecFileCb.mockImplementationOnce(resolveWith(dockerPsOutput));

      const containers = await provider.list();
      expect(containers).toHaveLength(2);
      expect(containers[0]!.id).toBe("abc123");
      expect(containers[0]!.status).toBe("running");
      expect(containers[1]!.id).toBe("def456");
      expect(containers[1]!.status).toBe("stopped");
    });

    it("returns empty list when no containers", async () => {
      mockExecFileCb.mockImplementationOnce(resolveWith(""));
      const containers = await provider.list();
      expect(containers).toHaveLength(0);
    });
  });

  describe("error handling", () => {
    it("throws DockerNotFoundError on ENOENT", async () => {
      const err = Object.assign(new Error("command not found"), { code: "ENOENT" });
      mockExecFileCb.mockImplementationOnce(rejectWith(err));
      await expect(provider.start("abc123")).rejects.toThrow(DockerNotFoundError);
    });

    it("throws DockerPermissionError on EACCES", async () => {
      const err = Object.assign(new Error("permission denied"), { code: "EACCES" });
      mockExecFileCb.mockImplementationOnce(rejectWith(err));
      await expect(provider.start("abc123")).rejects.toThrow(DockerPermissionError);
    });

    it("throws DockerDaemonError when daemon is unreachable", async () => {
      const err = new Error("Cannot connect to the Docker daemon");
      mockExecFileCb.mockImplementationOnce(rejectWith(err));
      await expect(provider.start("abc123")).rejects.toThrow(DockerDaemonError);
    });
  });
});
