import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { validateMounts, allowedMounts, workerAllowedMounts, MountPolicyError } from "../mount-policy.js";

describe("mount-policy", () => {
  const originalHome = process.env["HOMERAIL_HOME"];

  afterEach(() => {
    if (originalHome === undefined) {
      delete process.env["HOMERAIL_HOME"];
    } else {
      process.env["HOMERAIL_HOME"] = originalHome;
    }
  });

  describe("validateMounts", () => {
    beforeEach(() => {
      process.env["HOMERAIL_HOME"] = "/home/user/.homerail";
    });

    it("allows mounts within .homerail tree", () => {
      expect(() =>
        validateMounts([
          { host: "/home/user/.homerail/node/volumes/abc", container: "/workspace" },
        ]),
      ).not.toThrow();
    });

    it("denies mounts outside .homerail tree", () => {
      expect(() =>
        validateMounts([
          { host: "/etc/passwd", container: "/etc/passwd" },
        ]),
      ).toThrow(MountPolicyError);
      expect(() =>
        validateMounts([
          { host: "/etc/passwd", container: "/etc/passwd" },
        ]),
      ).toThrow(/outside .homerail tree/);
    });

    it("denies system directory mounts", () => {
      expect(() =>
        validateMounts([
          { host: "/etc", container: "/etc" },
        ]),
      ).toThrow(MountPolicyError);
      expect(() =>
        validateMounts([
          { host: "/proc", container: "/proc" },
        ]),
      ).toThrow(MountPolicyError);
    });

    it("denies docker socket by default", () => {
      expect(() =>
        validateMounts([
          { host: "/var/run/docker.sock", container: "/var/run/docker.sock" },
        ]),
      ).toThrow(/Docker socket/);
    });

    it("allows docker socket when opted in", () => {
      expect(() =>
        validateMounts(
          [{ host: "/var/run/docker.sock", container: "/var/run/docker.sock" }],
          { allowDockerSocket: true },
        ),
      ).not.toThrow();
    });

    it("rejects mount if path does not start with homerailHome even if inside it partially", () => {
      process.env["HOMERAIL_HOME"] = "/home/user/.homerail";
      expect(() =>
        validateMounts([
          { host: "/home/user/.homerail-other/vol", container: "/mnt" },
        ]),
      ).toThrow(MountPolicyError);
    });

    it("allows explicit project roots outside .homerail without opening unrelated paths", () => {
      expect(() =>
        validateMounts(
          [{ host: "/path/to/storage/Temp", container: "/workspace/project" }],
          { allowedHostRoots: ["/path/to/storage/Temp"] },
        ),
      ).not.toThrow();
      expect(() =>
        validateMounts(
          [{ host: "/path/to/storage/Other", container: "/workspace/project" }],
          { allowedHostRoots: ["/path/to/storage/Temp"] },
        ),
      ).toThrow(MountPolicyError);
    });

    it("normalizes Windows backslashes before checking", () => {
      process.env["HOMERAIL_HOME"] = "C:/Users/test/.homerail";
      expect(() =>
        validateMounts([
          { host: "C:\\Users\\test\\.homerail\\node\\volumes\\x", container: "/ws" },
        ]),
      ).not.toThrow();
    });
  });

  describe("allowedMounts", () => {
    beforeEach(() => {
      process.env["HOMERAIL_HOME"] = "/home/user/.homerail";
    });

    it("returns default workspace and home mounts for a volume ID", () => {
      const mounts = allowedMounts("vol-001");
      expect(mounts).toHaveLength(2);

      const workspace = mounts[0]!;
      expect(workspace.host).toBe("/home/user/.homerail/node/volumes/vol-001");
      expect(workspace.container).toBe("/workspace");
      expect(workspace.mode).toBe("rw");

      const home = mounts[1]!;
      expect(home.host).toBe("/home/user/.homerail/home");
      expect(home.container).toBe("/home/node");
      expect(home.mode).toBe("rw");
    });
  });

  describe("workerAllowedMounts", () => {
    beforeEach(() => {
      process.env["HOMERAIL_HOME"] = "/home/user/.homerail";
    });

    it("returns exactly one mount inside .homerail/workspace", () => {
      const mounts = workerAllowedMounts("ws-abc");
      expect(mounts).toHaveLength(1);
      expect(mounts[0]!.host).toBe("/home/user/.homerail/workspace/ws-abc");
      expect(mounts[0]!.container).toBe("/workspace");
      expect(mounts[0]!.mode).toBe("rw");
    });

    it("can make the worker workspace mount read-only", () => {
      expect(workerAllowedMounts("ws-readonly", true)[0]).toMatchObject({
        host: "/home/user/.homerail/workspace/ws-readonly",
        container: "/workspace",
        mode: "ro",
      });
    });

    it("supports run/node workspace IDs", () => {
      const mounts = workerAllowedMounts("run-1/node-1");
      expect(mounts).toHaveLength(1);
      expect(mounts[0]!.host).toBe("/home/user/.homerail/workspace/run-1/node-1");
    });

    it("rejects workspace path traversal", () => {
      expect(() => workerAllowedMounts("../repo")).toThrow(/unsafe path segment/);
      expect(() => workerAllowedMounts("/tmp/repo")).toThrow(/relative .homerail path segment/);
    });
  });

  describe("worker mount invariants", () => {
    beforeEach(() => {
      process.env["HOMERAIL_HOME"] = "/home/user/.homerail";
    });

    it("accepts workerAllowedMounts through validateMounts", () => {
      const mounts = workerAllowedMounts("ws-safe");
      expect(() => validateMounts(mounts)).not.toThrow();
    });

    it("rejects a repo-like mount manually injected alongside worker mount", () => {
      expect(() =>
        validateMounts([
          { host: "/home/user/.homerail/workspace/ws-safe", container: "/workspace" },
          { host: "/workspace/repo", container: "/repo" },
        ]),
      ).toThrow(MountPolicyError);
      expect(() =>
        validateMounts([
          { host: "/home/user/.homerail/workspace/ws-safe", container: "/workspace" },
          { host: "/workspace/repo", container: "/repo" },
        ]),
      ).toThrow(/outside .homerail tree/);
    });
  });
});
