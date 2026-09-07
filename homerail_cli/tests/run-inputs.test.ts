import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { HomeRailClient } from "../src/client.js";
import { stageRunInputFiles } from "../src/commands/run.js";

describe("CLI immutable run inputs", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  });

  it("stages local text files before returning scoped run bindings", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "homerail-cli-inputs-"));
    roots.push(root);
    const task = path.join(root, "design.md");
    const pr = path.join(root, "pr.json");
    fs.writeFileSync(task, "# Plan\n");
    fs.writeFileSync(pr, '{"version":1}\n');
    const post = vi.fn()
      .mockResolvedValueOnce({ data: { artifact: { artifact_id: "artifact-task" } } })
      .mockResolvedValueOnce({ data: { artifact: { artifact_id: "artifact-pr" } } });
    const client = { post } as unknown as HomeRailClient;

    await expect(stageRunInputFiles(client, "pilot-172", [
      `task_document:input/task.md=${task}`,
      `pr_context:input/pr-context.json=${pr}`,
    ])).resolves.toEqual([
      { artifact_id: "artifact-task", logical_name: "task_document", mount_path: "input/task.md" },
      { artifact_id: "artifact-pr", logical_name: "pr_context", mount_path: "input/pr-context.json" },
    ]);
    expect(post).toHaveBeenNthCalledWith(1, "/api/run-inputs", expect.objectContaining({
      scope_id: "pilot-172",
      name: "task.md",
      media_type: "text/markdown",
      content: "# Plan\n",
    }));
    expect(post).toHaveBeenNthCalledWith(2, "/api/run-inputs", expect.objectContaining({
      name: "pr-context.json",
      media_type: "application/json",
    }));
  });

  it("derives and validates media type from the declared mount path", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "homerail-cli-inputs-"));
    roots.push(root);
    const source = path.join(root, "payload.txt");
    fs.writeFileSync(source, '{"version":1}\n');
    const post = vi.fn().mockResolvedValue({ data: { artifact: { artifact_id: "artifact-json" } } });
    const client = { post } as unknown as HomeRailClient;

    await expect(stageRunInputFiles(client, "pilot", [
      `pr_context:input/pr-context.json=${source}`,
    ])).resolves.toEqual([{
      artifact_id: "artifact-json",
      logical_name: "pr_context",
      mount_path: "input/pr-context.json",
    }]);
    expect(post).toHaveBeenCalledWith("/api/run-inputs", {
      scope_id: "pilot",
      name: "pr-context.json",
      media_type: "application/json",
      content: '{"version":1}\n',
    });

    fs.writeFileSync(source, "not-json");
    post.mockClear();
    await expect(stageRunInputFiles(client, "pilot", [
      `pr_context:input/pr-context.json=${source}`,
    ])).rejects.toThrow("must contain valid JSON");
    expect(post).not.toHaveBeenCalled();
  });

  it("requires an explicit scope and safe unique mount paths", async () => {
    const client = { post: vi.fn() } as unknown as HomeRailClient;
    await expect(stageRunInputFiles(client, undefined, ["task=input/task.md"]))
      .rejects.toThrow("--input-scope");
    await expect(stageRunInputFiles(client, "pilot", ["task:../escape=/tmp/task.md"]))
      .rejects.toThrow("invalid input mount path");
  });
});
