import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { createWorkspaceReadToolHook } from "../agent/workspace-read-policy.js";

describe("Claude workspace read tool policy", () => {
  let workspace: string;
  let outside: string;

  beforeEach(() => {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), "homerail-read-policy-workspace-"));
    outside = fs.mkdtempSync(path.join(os.tmpdir(), "homerail-read-policy-outside-"));
    fs.mkdirSync(path.join(workspace, "repository"));
    fs.writeFileSync(path.join(workspace, "repository", "safe.txt"), "safe");
    fs.writeFileSync(path.join(outside, "secret.txt"), "secret");
    fs.symlinkSync(
      outside,
      path.join(workspace, "repository", "escape"),
      process.platform === "win32" ? "junction" : "dir",
    );
  });

  afterEach(() => {
    fs.rmSync(workspace, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  });

  async function decide(toolName: string, toolInput: Record<string, unknown>) {
    const hook = createWorkspaceReadToolHook(workspace, {
      writable_paths: [],
      readonly_paths: ["repository"],
    });
    return hook({
      hook_event_name: "PreToolUse",
      tool_name: toolName,
      tool_input: toolInput,
      tool_use_id: "tool-1",
    } as never, "tool-1", { signal: new AbortController().signal });
  }

  it("allows explicit files and search roots inside declared workspace roots", async () => {
    await expect(decide("Read", {
      file_path: path.join(workspace, "repository", "safe.txt"),
    })).resolves.toMatchObject({
      hookSpecificOutput: { permissionDecision: "allow" },
    });
    await expect(decide("Grep", { pattern: "safe", path: "repository" })).resolves.toMatchObject({
      hookSpecificOutput: { permissionDecision: "allow" },
    });
    await expect(decide("Glob", { pattern: "**/*.txt", path: "repository" })).resolves.toMatchObject({
      hookSpecificOutput: { permissionDecision: "allow" },
    });
  });

  it("denies absolute, traversal, omitted, and symlink-escaped read targets", async () => {
    for (const [toolName, toolInput] of [
      ["Read", { file_path: path.join(outside, "secret.txt") }],
      ["Read", { file_path: path.join("repository", "..", "..", path.basename(outside), "secret.txt") }],
      ["Read", { file_path: path.join("repository", "escape", "secret.txt") }],
      ["Grep", { pattern: "secret" }],
      ["LS", { path: outside }],
    ] as const) {
      await expect(decide(toolName, toolInput)).resolves.toMatchObject({
        hookSpecificOutput: { permissionDecision: "deny" },
      });
    }
  });

  it("denies Glob traversal independently of its safe root", async () => {
    await expect(decide("Glob", { pattern: "../../**/*", path: "repository" })).resolves.toMatchObject({
      hookSpecificOutput: {
        permissionDecision: "deny",
        permissionDecisionReason: "Glob.pattern must be relative and traversal-free",
      },
    });
  });

  it("does not change policy for non-read built-in tools", async () => {
    await expect(decide("Write", { file_path: "/outside", content: "x" })).resolves.toEqual({
      continue: true,
    });
  });
});

