import * as path from "node:path";
import * as fs from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  applyHomerailDirectUiProjection,
  validateHomerailViewSpec,
} from "homerail-protocol";
import {
  buildHrpArchive,
  runPluginFixtureMatrix,
  scanPluginSource,
  sourceFilesForPack,
  verifyPluginArchive,
} from "../src/index.js";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../plugins/builtin/core-generative-ui",
);

describe("Core generated ViewSpec capability", () => {
  it("validates, projects, previews, and packages the runtime-authored DSL", () => {
    const snapshot = scanPluginSource(root);
    expect(snapshot.valid).toBe(true);
    expect(snapshot.issues.filter(issue => issue.severity === "error")).toEqual([]);
    expect(snapshot.manifest.id).toBe("com.homerail.core");
    expect(snapshot.manifest.tools.find(tool => tool.id === "upsert_generated_view"))
      .toMatchObject({ handler: { type: "projection" } });
    expect(snapshot.manifest.kinds.find(kind => kind.kind === "com.homerail.core/generated_view")).toBeDefined();
    expect(snapshot.manifest.renderers.find(renderer => renderer.id === "core-generated-view"))
      .toMatchObject({ source: { type: "builtin", id: "view-spec" } });

    const matrix = runPluginFixtureMatrix(root);
    expect(matrix.valid).toBe(true);
    expect(matrix.fixtures).toEqual([expect.objectContaining({
      file: "generated-view.json",
      passed: true,
      view_model: expect.objectContaining({
        view_version: 1,
        root: expect.objectContaining({ type: "stack" }),
      }),
    })]);

    const fixture = JSON.parse(fs.readFileSync(path.join(root, "fixtures/generated-view.json"), "utf8"));
    const projector = JSON.parse(snapshot.files.get("ui/projectors/generated-view.v1.json")!.toString("utf8"));
    const projected = applyHomerailDirectUiProjection({
      projection: projector,
      plugin: { id: snapshot.manifest.id, version: snapshot.manifest.version },
      arguments: fixture.arguments,
    });
    expect(projected.node).toMatchObject({
      kind: "com.homerail.core/generated_view",
      surface: "result",
      presentation: { density: "detail" },
      content: { data: { title: "Release readiness" } },
    });
    expect(validateHomerailViewSpec(projected.node.view).valid).toBe(true);

    const first = buildHrpArchive(sourceFilesForPack(snapshot));
    const second = buildHrpArchive(sourceFilesForPack(scanPluginSource(root)));
    expect(first.archive.equals(second.archive)).toBe(true);
    expect(verifyPluginArchive(first.archive).snapshot.valid).toBe(true);
  });
});
