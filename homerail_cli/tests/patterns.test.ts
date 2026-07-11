import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { parsePatternParameters } from "../src/commands/patterns.js";
import { createProgram } from "../src/index.js";

function jsonResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => body,
  } as Response;
}

describe("patterns command", () => {
  let tmpDir: string;

  beforeEach(() => {
    vi.restoreAllMocks();
    process.exitCode = undefined;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "homerail-cli-patterns-"));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = undefined;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("parses repeated typed parameter overrides", () => {
    expect(parsePatternParameters([
      "workflow_id=release-quorum",
      "threshold=3",
      "enabled=true",
      "label=three voters",
    ])).toEqual({
      workflow_id: "release-quorum",
      threshold: 3,
      enabled: true,
      label: "three voters",
    });
    expect(() => parsePatternParameters(["missing-separator"])).toThrow("Expected key=value");
  });

  it("lists AI-readable built-in patterns from Manager", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({
      success: true,
      data: {
        patterns: [{
          id: "quorum",
          version: "1.0.0",
          name: "Quorum",
          summary: "Require independent agreement.",
          required_primitives: ["join_gateway n_of_m mode"],
          node_count: 8,
        }],
      },
    }));
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    await createProgram().parseAsync(["node", "hr", "--json", "patterns", "list"]);

    expect(globalThis.fetch).toHaveBeenCalledWith(
      "http://localhost:19191/api/dag/patterns",
      expect.objectContaining({ method: "GET" }),
    );
    expect(JSON.parse(String(log.mock.calls[0][0]))).toMatchObject([{ id: "quorum" }]);
  });

  it("instantiates, writes, and syncs the same validated workflow", async () => {
    const yamlText = "name: Release Quorum\nworkflow_id: release-quorum\npattern:\n  id: quorum\nnodes:\n  one:\n    outputs:\n      done:\n        to: \"\"\n";
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse({
        success: true,
        data: {
          pattern: { id: "quorum" },
          parameters: { workflow_id: "release-quorum", threshold: 3 },
          workflow: { workflow_id: "release-quorum", name: "Release Quorum" },
          yaml_text: yamlText,
          validation: { valid: true },
        },
      }))
      .mockResolvedValueOnce(jsonResponse({
        success: true,
        data: { workflow: { workflow_id: "release-quorum" }, created: true },
      }));
    vi.spyOn(console, "log").mockImplementation(() => {});
    const output = path.join(tmpDir, "release-quorum.yaml");

    await createProgram().parseAsync([
      "node",
      "hr",
      "patterns",
      "instantiate",
      "quorum",
      "--set",
      "workflow_id=release-quorum",
      "--set",
      "threshold=3",
      "--output",
      output,
      "--sync",
    ]);

    expect(fs.readFileSync(output, "utf8")).toBe(yamlText);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][0]).toBe("http://localhost:19191/api/dag/patterns/quorum/instantiate");
    expect(JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body))).toEqual({
      parameters: { workflow_id: "release-quorum", threshold: 3 },
    });
    expect(JSON.parse(String((fetchMock.mock.calls[1][1] as RequestInit).body))).toMatchObject({
      yaml_text: yamlText,
      source_path: output,
    });
  });
});
