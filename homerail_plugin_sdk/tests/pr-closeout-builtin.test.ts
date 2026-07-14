import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  buildHrpArchive,
  runPluginFixtureMatrix,
  scanPluginSource,
  sourceFilesForPack,
  verifyPluginArchive,
} from "../src/index.js";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../plugins/builtin/pr-closeout",
);

describe("PR Closeout builtin capability", () => {
  it("validates projection fixtures and packages reproducibly", () => {
    const snapshot = scanPluginSource(root);
    expect(snapshot.issues.filter((issue) => issue.severity === "error")).toEqual([]);
    expect(snapshot.valid).toBe(true);
    expect(snapshot).toMatchObject({
      m4_data_only_eligible: false,
      manifest: {
        id: "com.homerail.pr-closeout",
        runtime: { trust: "data_only" },
        tools: [{ id: "upsert_pr_closeout", handler: { type: "projection" } }],
        kinds: [{ versions: [{ default_variant: "detail" }] }],
        renderers: [{ id: "pr-closeout-main", source: { type: "builtin", id: "pr-closeout" } }],
      },
    });

    const matrix = runPluginFixtureMatrix(root);
    expect(matrix.fixtures).toEqual([
      expect.objectContaining({ file: "blocked.json", passed: true }),
      expect.objectContaining({ file: "success.json", passed: true }),
    ]);
    expect(matrix.valid).toBe(true);
    expect(matrix.renderer_matrix).toHaveLength(2 * 3 * 6);

    const first = buildHrpArchive(sourceFilesForPack(snapshot));
    const second = buildHrpArchive(sourceFilesForPack(scanPluginSource(root)));
    expect(first.archive.equals(second.archive)).toBe(true);
    expect(verifyPluginArchive(first.archive).snapshot).toMatchObject({
      valid: true,
      manifest: { id: "com.homerail.pr-closeout", version: "1.0.0" },
    });
  });
});
