import * as path from "node:path";
import * as fs from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  applyHomerailDirectUiProjection,
  homerailA2uiComponentSchema,
  validateHomerailA2uiSurface,
} from "homerail-protocol";
import {
  buildHrpArchive,
  parseHomerailKindMigrationV1,
  runPluginFixtureMatrix,
  scanPluginSource,
  sourceFilesForPack,
  verifyPluginArchive,
} from "../src/index.js";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../plugins/builtin/core-generative-ui",
);

describe("Core generated A2UI capability", () => {
  it("validates, projects, previews, and packages the runtime-authored surface", () => {
    const snapshot = scanPluginSource(root);
    expect(snapshot.valid).toBe(true);
    expect(snapshot.issues.filter(issue => issue.severity === "error")).toEqual([]);
    expect(snapshot.manifest.id).toBe("com.homerail.core");
    expect(snapshot.manifest.version).toBe("0.1.8");
    expect(snapshot.manifest.tools.find(tool => tool.id === "upsert_generated_view"))
      .toMatchObject({
        description: expect.stringContaining("canvas_size 1x1, 1x2, 2x2, or 3x3"),
        handler: { type: "projection" },
      });
    const coreSkill = snapshot.files.get("skills/voice-generative-ui/SKILL.md")!.toString("utf8");
    expect(coreSkill).toContain("Never use four columns");
    expect(coreSkill).toContain("Use `detail` for dashboards");
    expect(coreSkill).toContain("Components form one flat adjacency list");
    expect(coreSkill).toContain("itemDependsOnPath");
    expect(coreSkill).toContain("store `78` for 78%, never `0.78`");
    expect(coreSkill).toContain("Prefer imagery, metrics, progress, compact diagrams");
    expect(coreSkill).toContain("Default to one coherent Block for one user intent or outcome");
    expect(coreSkill).toContain("Never split one report into top-level Blocks");
    expect(coreSkill).toContain("the host opens disclosures when the user expands the Block");
    expect(coreSkill).toContain("Choose `canvas_size` for the collapsed summary");
    expect(coreSkill).toContain("Never request horizontal `2x1` or `3x1` strips");
    expect(coreSkill).toContain("`publish_artifact`");
    expect(coreSkill).toContain("reuse `selected_node_id` exactly");
    const generatedViewInputSchema = JSON.parse(
      snapshot.files.get("schemas/generated-view-input.v1.schema.json")!.toString("utf8"),
    );
    const catalogComponents = homerailA2uiComponentSchema.oneOf.map(schema => (
      (schema.properties.component as { const: string }).const
    ));
    expect(generatedViewInputSchema.properties.a2ui.properties.components.items.properties.component.enum)
      .toEqual(catalogComponents);
    expect(generatedViewInputSchema).toMatchObject({
      properties: {
        id: { description: expect.stringContaining("reuse that exact id") },
        canvas_size: { enum: ["1x1", "1x2", "2x2", "3x3"] },
      },
      required: expect.arrayContaining(["canvas_size"]),
    });
    expect(snapshot.manifest.kinds.find(kind => kind.kind === "com.homerail.core/generated_view"))
      .toMatchObject({
        current_version: 2,
        versions: [
          { version: 1, preferred_visuals: expect.arrayContaining(["view_spec"]) },
          { version: 2, preferred_visuals: expect.arrayContaining(["a2ui"]) },
        ],
        migrations: [{ from: 1, to: 2, file: "migrations/generated-view-content-1-2.json" }],
      });
    expect(snapshot.manifest.renderers.find(renderer => renderer.id === "core-generated-view-v1"))
      .toMatchObject({ kind_version: 1, source: { type: "builtin", id: "view-spec" } });
    expect(snapshot.manifest.renderers.find(renderer => renderer.id === "core-generated-view"))
      .toMatchObject({ kind_version: 2, source: { type: "builtin", id: "a2ui" } });
    expect(parseHomerailKindMigrationV1(
      snapshot.files.get("migrations/generated-view-content-1-2.json")!,
      { from: 1, to: 2 },
    )).toMatchObject({ migration_version: 1, type: "declarative_kind_content" });

    const matrix = runPluginFixtureMatrix(root);
    expect(matrix.valid).toBe(true);
    expect(matrix.fixtures).toEqual([expect.objectContaining({
      file: "generated-view.json",
      passed: true,
      a2ui_surface: expect.objectContaining({
        version: "v1.0",
        catalogId: "https://homerail.dev/a2ui/catalogs/core/v1",
        components: expect.arrayContaining([
          expect.objectContaining({ id: "root", component: "Column" }),
        ]),
      }),
    })]);

    const fixture = JSON.parse(fs.readFileSync(path.join(root, "fixtures/generated-view.json"), "utf8"));
    const projector = JSON.parse(snapshot.files.get("ui/projectors/generated-view.v1.json")!.toString("utf8"));
    expect(projector).toMatchObject({ kind_version: 2, a2ui_pointer: "/a2ui" });
    expect(projector).not.toHaveProperty("view_pointer");
    const projected = applyHomerailDirectUiProjection({
      projection: projector,
      plugin: { id: snapshot.manifest.id, version: snapshot.manifest.version },
      arguments: fixture.arguments,
    });
    expect(projected.node).toMatchObject({
      kind: "com.homerail.core/generated_view",
      surface: "result",
      presentation: { density: "detail", canvas_size: "2x2", motion_profile: "standard" },
      content: { data: { title: "Release readiness" } },
    });
    expect(validateHomerailA2uiSurface(projected.node.a2ui).valid).toBe(true);

    const localIdProjection = applyHomerailDirectUiProjection({
      projection: projector,
      plugin: { id: snapshot.manifest.id, version: snapshot.manifest.version },
      arguments: { ...fixture.arguments, id: "generated-local-overview" },
    });
    expect(localIdProjection.node.id).toBe("com.homerail.core:generated-local-overview");

    const first = buildHrpArchive(sourceFilesForPack(snapshot));
    const second = buildHrpArchive(sourceFilesForPack(scanPluginSource(root)));
    expect(first.archive.equals(second.archive)).toBe(true);
    expect(verifyPluginArchive(first.archive).snapshot.valid).toBe(true);
  });
});
