import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDeepSeekHarnessReadTools } from "../agent/deepseek-harness-read-tools.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const workspace = mkdtempSync(join(tmpdir(), "homerail-dsh-read-tools-"));
  roots.push(workspace);
  mkdirSync(join(workspace, "repository", "src"), { recursive: true });
  mkdirSync(join(workspace, "outside"), { recursive: true });
  writeFileSync(join(workspace, "repository", "src", "alpha.ts"), "export const alpha = true;\nsecond line\n");
  writeFileSync(join(workspace, "repository", "README.md"), "alpha docs\n");
  writeFileSync(join(workspace, "outside", "secret.txt"), "do not read\n");
  return workspace;
}

function tools(workspace: string, maxCalls?: number, grepTimeoutMs?: number) {
  return new Map(createDeepSeekHarnessReadTools({
    workspace,
    workspaceAccess: { writable_paths: [], readonly_paths: ["repository"] },
    allowedTools: ["Read", "Grep", "Glob", "LS"],
    maxCalls,
    grepTimeoutMs,
  }).map((tool) => [tool.name, tool]));
}

describe("DeepSeek Harness HomeRail-managed read tools", () => {
  it("reads, searches, globs, and lists only declared workspace roots", async () => {
    const workspace = fixture();
    const available = tools(workspace);

    await expect(available.get("Read")!.handler({
      file_path: "repository/src/alpha.ts",
      offset: 1,
      limit: 1,
    })).resolves.toMatchObject({
      content: [{ text: expect.stringContaining("1\texport const alpha = true;") }],
    });
    await expect(available.get("Grep")!.handler({
      pattern: "alpha",
      path: "repository",
      glob: "**/*.ts",
    })).resolves.toMatchObject({
      content: [{ text: "src/alpha.ts:1:export const alpha = true;" }],
    });
    await expect(available.get("Glob")!.handler({
      pattern: "**/*.ts",
      path: "repository",
    })).resolves.toMatchObject({ content: [{ text: "src/alpha.ts" }] });
    await expect(available.get("LS")!.handler({ path: "repository" }))
      .resolves.toMatchObject({ content: [{ text: "README.md\nsrc/" }] });

    await expect(available.get("Read")!.handler({ file_path: "outside/secret.txt" }))
      .resolves.toMatchObject({ is_error: true, content: [{ text: expect.stringContaining("outside") }] });
    await expect(available.get("Read")!.handler({ file_path: "../etc/passwd" }))
      .resolves.toMatchObject({ is_error: true, content: [{ text: expect.stringContaining("traversal-free") }] });
  });

  it("rejects symlink escapes and enforces a shared built-in call budget", async () => {
    const workspace = fixture();
    symlinkSync(join(workspace, "outside", "secret.txt"), join(workspace, "repository", "escape"));
    const available = tools(workspace, 1);

    await expect(available.get("Read")!.handler({ file_path: "repository/escape" }))
      .resolves.toMatchObject({ is_error: true, content: [{ text: expect.stringContaining("outside") }] });
    await expect(available.get("LS")!.handler({ path: "repository" }))
      .resolves.toMatchObject({
        is_error: true,
        content: [{ text: expect.stringContaining("Built-in tool budget exhausted (1/1)") }],
      });
  });

  it("allows a declared root to be created after tool initialization and still resolves it safely", async () => {
    const workspace = fixture();
    const available = new Map(createDeepSeekHarnessReadTools({
      workspace,
      workspaceAccess: { writable_paths: ["generated"], readonly_paths: ["future-link"] },
      allowedTools: ["Read", "LS"],
    }).map((tool) => [tool.name, tool]));

    await expect(available.get("LS")!.handler({ path: "generated" }))
      .resolves.toMatchObject({ is_error: true });
    mkdirSync(join(workspace, "generated"));
    writeFileSync(join(workspace, "generated", "result.txt"), "ready\n");
    await expect(available.get("Read")!.handler({ file_path: "generated/result.txt" }))
      .resolves.toMatchObject({ content: [{ text: expect.stringContaining("ready") }] });

    const escapedRoot = mkdtempSync(join(tmpdir(), "homerail-dsh-read-tools-outside-"));
    roots.push(escapedRoot);
    writeFileSync(join(escapedRoot, "secret.txt"), "do not read\n");
    symlinkSync(escapedRoot, join(workspace, "future-link"), "dir");
    await expect(available.get("LS")!.handler({ path: "future-link" }))
      .resolves.toMatchObject({
        is_error: true,
        content: [{ text: expect.stringContaining("outside the declared workspace roots") }],
      });
  });

  it("bounds model-controlled regular expressions outside the Worker event loop", async () => {
    const workspace = fixture();
    writeFileSync(join(workspace, "repository", "pathological.txt"), `${"a".repeat(100_000)}X\n`);
    const available = tools(workspace, undefined, 100);

    await expect(available.get("Grep")!.handler({ pattern: "[", path: "repository" }))
      .resolves.toMatchObject({
        is_error: true,
        content: [{ text: expect.stringContaining("invalid Grep regular expression") }],
      });

    const startedAt = Date.now();
    await expect(available.get("Grep")!.handler({
      pattern: "^(a+)+$",
      path: "repository/pathological.txt",
    })).resolves.toMatchObject({
      is_error: true,
      content: [{ text: expect.stringContaining("Grep search timed out after 100ms") }],
    });
    expect(Date.now() - startedAt).toBeLessThan(2_000);
  });

  it("refuses mutating or shell built-ins", () => {
    const workspace = fixture();
    expect(() => createDeepSeekHarnessReadTools({
      workspace,
      workspaceAccess: { writable_paths: [], readonly_paths: ["repository"] },
      allowedTools: ["Read", "Write"],
    })).toThrow(/only supports HomeRail-managed read tools/);
  });
});
