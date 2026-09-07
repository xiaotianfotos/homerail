import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { workerAllowedMounts } from "../mount-policy.js";
import { materializeWorkspaceInputs } from "../workspace-inputs.js";
import { normalizePath } from "../../platform/paths.js";

describe("trusted workspace input projection", () => {
  let home: string;
  let previousHome: string | undefined;

  beforeEach(() => {
    previousHome = process.env.HOMERAIL_HOME;
    home = fs.mkdtempSync(path.join(os.tmpdir(), "homerail-node-inputs-"));
    process.env.HOMERAIL_HOME = home;
  });

  afterEach(() => {
    if (previousHome === undefined) delete process.env.HOMERAIL_HOME;
    else process.env.HOMERAIL_HOME = previousHome;
    const inputRoot = path.join(home, "workspace", "run-one", "input");
    if (fs.existsSync(inputRoot)) fs.chmodSync(inputRoot, 0o700);
    fs.rmSync(home, { recursive: true, force: true });
  });

  function projection(content = "# task\n") {
    const bytes = Buffer.from(content);
    return {
      logical_name: "task_document",
      mount_path: "input/task.md",
      media_type: "text/markdown",
      sha256: createHash("sha256").update(bytes).digest("hex"),
      size_bytes: bytes.byteLength,
      content_base64: bytes.toString("base64"),
    };
  }

  it("materializes verified bytes and adds a nested read-only container mount", () => {
    expect(materializeWorkspaceInputs("run-one", [projection()])).toBe(1);
    const target = path.join(home, "workspace", "run-one", "input", "task.md");
    expect(fs.readFileSync(target, "utf8")).toBe("# task\n");
    if (process.platform !== "win32") expect(fs.statSync(target).mode & 0o222).toBe(0);
    expect(workerAllowedMounts("run-one", false, true)).toEqual([
      { host: normalizePath(path.join(home, "workspace", "run-one")), container: "/workspace", mode: "rw" },
      { host: normalizePath(path.join(home, "workspace", "run-one", "input")), container: "/workspace/input", mode: "ro" },
    ]);
  });

  it("rejects digest mismatch, traversal, symlinks, and unstaged files", () => {
    expect(() => materializeWorkspaceInputs("run-digest", [{
      ...projection(),
      sha256: "0".repeat(64),
    }])).toThrow("does not match");
    expect(() => materializeWorkspaceInputs("run-traversal", [{
      ...projection(),
      mount_path: "input/../task.md",
    }])).toThrow("below input/");

    const symlinkRoot = path.join(home, "workspace", "run-symlink");
    fs.mkdirSync(symlinkRoot, { recursive: true });
    fs.symlinkSync(home, path.join(symlinkRoot, "input"));
    expect(() => materializeWorkspaceInputs("run-symlink", [projection()])).toThrow("symlink");

    const extraRoot = path.join(home, "workspace", "run-extra", "input");
    fs.mkdirSync(extraRoot, { recursive: true });
    fs.writeFileSync(path.join(extraRoot, "unstaged.txt"), "secret");
    expect(() => materializeWorkspaceInputs("run-extra", [projection()])).toThrow("unstaged file");
  });
});
