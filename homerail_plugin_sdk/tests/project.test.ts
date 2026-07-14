import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  HOMERAIL_PLUGIN_SCHEMA_MAX_BYTES,
  HOMERAIL_PLUGIN_SKILL_MAX_BYTES,
} from "homerail-protocol";
import {
  buildHrpArchive,
  generatePluginTypes,
  HOMERAIL_CUSTOM_RENDERER_SOURCE_MAX_BYTES,
  runPluginFixtureMatrix,
  scaffoldPluginProject,
  scanPluginSource,
  sourceFilesForPack,
  validatePluginCustomRendererSource,
  validatePluginFiles,
  verifyPluginArchive,
} from "../src/index.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function temp(name: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `${name}-`));
  roots.push(root);
  return root;
}

function addProjectionAction(root: string): void {
  const manifestFile = path.join(root, "homerail.plugin.json");
  const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8")) as {
    id: string;
    capabilities: Array<{ actions: string[]; tools: string[] }>;
    schemas: Array<{ id: string; file: string }>;
    kinds: Array<{ versions: Array<{ actions: string[] }> }>;
    tools: Array<Record<string, unknown>>;
    actions: Array<Record<string, unknown>>;
    permissions: { optional: Array<Record<string, unknown>> };
  };
  const contentSchema = JSON.parse(
    fs.readFileSync(path.join(root, "schemas/card-content.v1.schema.json"), "utf8"),
  ) as Record<string, unknown>;
  fs.writeFileSync(path.join(root, "schemas/card-action.v1.schema.json"), `${JSON.stringify({
    $schema: "http://json-schema.org/draft-07/schema#",
    type: "object",
    properties: {
      id: { type: "string", minLength: manifest.id.length + 2, maxLength: 256 },
      content: contentSchema,
    },
    required: ["id", "content"],
    additionalProperties: false,
  }, null, 2)}\n`);
  fs.writeFileSync(path.join(root, "ui/projectors/card-action.v1.json"), `${JSON.stringify({
    projection_version: 1,
    type: "direct_ui_node",
    kind: `${manifest.id}/card`,
    kind_version: 1,
    node_id_pointer: "/id",
    content_pointer: "/content",
    omit_content_fields: [],
    fallback: { title_pointer: "/content/title", summary_pointer: "/content/summary" },
    defaults: { surface: "task", importance: "primary", density: "detail", persistence: "session" },
  }, null, 2)}\n`);
  manifest.schemas.push({ id: "card-action-v1", file: "schemas/card-action.v1.schema.json" });
  manifest.capabilities[0].actions.push("replace_card");
  manifest.kinds[0].versions[0].actions.push("replace_card");
  manifest.tools.push({
    id: "replace_card_tool",
    description: "Replace the selected card through an Action-bound Tool.",
    exposure: ["action"],
    input_schema: "card-action-v1",
    output_schema: "card-content-v1",
    effect: "write",
    permissions: ["artifact.write"],
    confirmation: "always",
    handler: { type: "projection", file: "ui/projectors/card-action.v1.json" },
  });
  manifest.permissions.optional.push({ permission: "artifact.write" });
  manifest.actions.push({
    id: "replace_card",
    intent: `${manifest.id}.replace_card`,
    tool: "replace_card_tool",
  });
  fs.writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
}

function addWorkflow(root: string, options: { reachable?: boolean; runtime?: boolean } = {}): void {
  const manifestFile = path.join(root, "homerail.plugin.json");
  const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8")) as {
    id: string;
    capabilities: Array<{ tools: string[]; workflows: string[] }>;
    tools: Array<Record<string, unknown>>;
    workflows: Array<Record<string, unknown>>;
    runtime: Record<string, unknown>;
  };
  manifest.capabilities[0].tools = [];
  manifest.capabilities[0].workflows = options.reachable === false ? [] : ["compose-workflow"];
  manifest.tools = [];
  manifest.workflows = [{
    id: "compose-workflow",
    uri: `plugin://${manifest.id}/workflows/compose-workflow`,
    file: "workflows/compose-workflow.yaml",
    effect: "read",
    permissions: [],
    confirmation: "never",
  }];
  fs.mkdirSync(path.join(root, "workflows"), { recursive: true });
  fs.writeFileSync(path.join(root, "workflows/compose-workflow.yaml"), "workflow_version: 1\nid: compose-workflow\n");
  fs.rmSync(path.join(root, "ui/projectors/card.v1.json"));
  if (options.runtime) {
    manifest.runtime = {
      trust: "sandboxed_runtime",
      plugin_api: 1,
      entrypoint: { file: "runtime/index.js", args: [] },
    };
    fs.mkdirSync(path.join(root, "runtime"), { recursive: true });
    fs.writeFileSync(path.join(root, "runtime/index.js"), "export {};\n");
  }
  fs.writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
}

function addCustomRenderer(root: string, source: string): void {
  const manifestFile = path.join(root, "homerail.plugin.json");
  const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8")) as {
    renderers: Array<Record<string, unknown>>;
  };
  manifest.renderers[0] = {
    ...manifest.renderers[0],
    mode: "custom",
    source: { type: "custom", file: "ui/views/custom.mjs" },
  };
  fs.writeFileSync(path.join(root, "ui/views/custom.mjs"), source);
  fs.writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
}

describe("HomeRail plugin project SDK", () => {
  it("runs empty directory -> scaffold -> codegen -> fixture matrix -> pack -> verify", () => {
    const root = temp("homerail-plugin-scaffold");
    const scaffold = scaffoldPluginProject(root, "com.example.release-notes", { name: "Release Notes" });
    expect(scaffold.files).toContain("homerail.plugin.json");

    const snapshot = scanPluginSource(root);
    expect(snapshot).toMatchObject({
      valid: true,
      m4_data_only_eligible: true,
      m5_projection_action_eligible: false,
      m5_projection_action_eligibility_reasons: ["projection_action_required"],
    });
    expect(snapshot.issues).toEqual([]);

    expect(() => generatePluginTypes(root, { check: true })).toThrow(/types are stale/);
    expect(fs.existsSync(path.join(root, ".homerail"))).toBe(false);
    const generated = generatePluginTypes(root);
    expect(generated.changed).toBe(true);
    expect(fs.readFileSync(generated.output, "utf8")).toContain("export type CardInputV1");
    expect(fs.readdirSync(path.dirname(generated.output))).toEqual(["plugin-types.d.ts"]);
    expect(generatePluginTypes(root, { check: true }).changed).toBe(false);

    const matrix = runPluginFixtureMatrix(root);
    expect(matrix.valid).toBe(true);
    expect(matrix.fixtures).toEqual([expect.objectContaining({ passed: true, tool: "upsert_card" })]);
    expect(matrix.renderer_matrix).toHaveLength(2 * 3 * 6);

    const first = buildHrpArchive(sourceFilesForPack(snapshot));
    fs.utimesSync(path.join(root, "homerail.plugin.json"), new Date(2030, 1, 1), new Date(2030, 1, 1));
    const second = buildHrpArchive(sourceFilesForPack(scanPluginSource(root)));
    expect(first.archive.equals(second.archive)).toBe(true);
    expect(verifyPluginArchive(first.archive).snapshot).toMatchObject({
      valid: true,
      m4_data_only_eligible: true,
      m5_projection_action_eligible: false,
      m5_projection_action_eligibility_reasons: ["projection_action_required"],
      manifest: { id: "com.example.release-notes", version: "0.1.0" },
    });
  });

  it("snapshots, packs, and verifies an M5 data-only projection Action without changing M4 eligibility", () => {
    const root = temp("homerail-plugin-action");
    scaffoldPluginProject(root, "com.example.action-card");
    addProjectionAction(root);

    const snapshot = scanPluginSource(root);
    expect(snapshot.issues).toEqual([expect.objectContaining({
      severity: "warning",
      message: expect.stringContaining("M4 data-only"),
    })]);
    expect(snapshot).toMatchObject({
      valid: true,
      m4_data_only_eligible: false,
      m5_projection_action_eligible: true,
      m5_projection_action_eligibility_reasons: [],
    });
    const built = buildHrpArchive(sourceFilesForPack(snapshot));
    expect(verifyPluginArchive(built.archive).snapshot).toMatchObject({
      valid: true,
      m4_data_only_eligible: false,
      m5_projection_action_eligible: true,
      m5_projection_action_eligibility_reasons: [],
    });
  });

  it("classifies immutable data-only Workflows for the M5 resolution-only tier", () => {
    const root = temp("homerail-plugin-workflow");
    scaffoldPluginProject(root, "com.example.workflow-card");
    addWorkflow(root);

    const snapshot = scanPluginSource(root);
    expect(snapshot).toMatchObject({
      valid: true,
      m4_data_only_eligible: false,
      m5_projection_action_eligible: false,
      m5_workflow_resolution_eligible: true,
      m5_workflow_resolution_eligibility_reasons: [],
    });
    const verified = verifyPluginArchive(
      buildHrpArchive(sourceFilesForPack(snapshot)).archive,
    ).snapshot;
    expect(verified).toMatchObject({
      m5_workflow_resolution_eligible: true,
      m5_workflow_resolution_eligibility_reasons: [],
    });

    const unreachable = temp("homerail-plugin-unreachable-workflow");
    scaffoldPluginProject(unreachable, "com.example.unreachable-workflow");
    addWorkflow(unreachable, { reachable: false });
    expect(scanPluginSource(unreachable)).toMatchObject({
      valid: true,
      m5_workflow_resolution_eligible: false,
      m5_workflow_resolution_eligibility_reasons: ["unreachable_workflow"],
    });

    const executable = temp("homerail-plugin-runtime-workflow");
    scaffoldPluginProject(executable, "com.example.runtime-workflow");
    addWorkflow(executable, { runtime: true });
    expect(scanPluginSource(executable)).toMatchObject({
      valid: true,
      m5_workflow_resolution_eligible: false,
      m5_workflow_resolution_eligibility_reasons: expect.arrayContaining([
        "runtime_trust_not_data_only",
        "runtime_entrypoint_present",
      ]),
    });
  });

  it("rejects unsafe Action projections and reports runtime Actions as M6-only", () => {
    const invalidProjection = temp("homerail-plugin-invalid-action-projection");
    scaffoldPluginProject(invalidProjection, "com.example.invalid-action");
    addProjectionAction(invalidProjection);
    const projectionFile = path.join(invalidProjection, "ui/projectors/card-action.v1.json");
    const projection = JSON.parse(fs.readFileSync(projectionFile, "utf8")) as Record<string, unknown>;
    projection.node_id_pointer = "/input/id";
    projection.content_pointer = "/node/content";
    fs.writeFileSync(projectionFile, `${JSON.stringify(projection, null, 2)}\n`);
    expect(scanPluginSource(invalidProjection)).toMatchObject({
      valid: false,
      m4_data_only_eligible: false,
      m5_projection_action_eligible: false,
      m5_projection_action_eligibility_reasons: expect.arrayContaining(["package_validation_failed"]),
      issues: expect.arrayContaining([
        expect.objectContaining({ severity: "error", message: expect.stringContaining("selected node id") }),
      ]),
    });

    const schemaMismatch = temp("homerail-plugin-action-schema-mismatch");
    scaffoldPluginProject(schemaMismatch, "com.example.action-schema-mismatch");
    addProjectionAction(schemaMismatch);
    const actionSchemaFile = path.join(schemaMismatch, "schemas/card-action.v1.schema.json");
    const actionSchema = JSON.parse(fs.readFileSync(actionSchemaFile, "utf8")) as {
      properties: { content: { properties: { title: Record<string, unknown> } } };
    };
    actionSchema.properties.content.properties.title = { type: "number" };
    fs.writeFileSync(actionSchemaFile, `${JSON.stringify(actionSchema, null, 2)}\n`);
    expect(scanPluginSource(schemaMismatch)).toMatchObject({
      valid: false,
      m5_projection_action_eligible: false,
      issues: expect.arrayContaining([
        expect.objectContaining({
          severity: "error",
          message: expect.stringContaining("exactly match its exposing Kind content schema"),
        }),
      ]),
    });

    const runtimeAction = temp("homerail-plugin-runtime-action");
    scaffoldPluginProject(runtimeAction, "com.example.runtime-action");
    addProjectionAction(runtimeAction);
    const manifestFile = path.join(runtimeAction, "homerail.plugin.json");
    const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8")) as {
      runtime: Record<string, unknown>;
      tools: Array<{ id: string; handler: Record<string, unknown> }>;
    };
    manifest.runtime = {
      trust: "sandboxed_runtime",
      plugin_api: 1,
      entrypoint: { file: "runtime/index.js", args: [] },
    };
    manifest.tools.find((tool) => tool.id === "replace_card_tool")!.handler = {
      type: "runtime",
      method: "replace_card",
    };
    fs.mkdirSync(path.join(runtimeAction, "runtime"));
    fs.writeFileSync(path.join(runtimeAction, "runtime/index.js"), "export {};\n");
    fs.writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
    expect(scanPluginSource(runtimeAction)).toMatchObject({
      valid: true,
      m4_data_only_eligible: false,
      m5_projection_action_eligible: false,
      m5_projection_action_eligibility_reasons: expect.arrayContaining([
        "runtime_trust_not_data_only",
        "runtime_entrypoint_present",
        "runtime_handler_present",
      ]),
    });

    const customRenderer = temp("homerail-plugin-custom-action-renderer");
    scaffoldPluginProject(customRenderer, "com.example.custom-action");
    addProjectionAction(customRenderer);
    addCustomRenderer(customRenderer, [
      "export function render(payload) {",
      "  const title = typeof payload.node?.fallback?.title === 'string'",
      "    ? payload.node.fallback.title.slice(0, 120)",
      "    : 'Custom card';",
      "  return { version: 'v1.0', catalogId: 'https://homerail.dev/a2ui/catalogs/core/v1', components: [{ id: 'root', component: 'Text', text: title }] };",
      "}",
      "",
    ].join("\n"));
    expect(scanPluginSource(customRenderer)).toMatchObject({
      valid: true,
      m5_projection_action_eligible: false,
      m5_projection_action_eligibility_reasons: expect.arrayContaining(["custom_renderer_present"]),
      m6_custom_renderer_eligible: true,
      m6_custom_renderer_eligibility_reasons: [],
    });

    const builtinAction = temp("homerail-plugin-builtin-action");
    scaffoldPluginProject(builtinAction, "com.example.builtin-action");
    addProjectionAction(builtinAction);
    const builtinManifestFile = path.join(builtinAction, "homerail.plugin.json");
    const builtinManifest = JSON.parse(fs.readFileSync(builtinManifestFile, "utf8")) as {
      runtime: Record<string, unknown>;
      tools: Array<{ id: string; handler: Record<string, unknown> }>;
    };
    builtinManifest.runtime = { trust: "trusted_builtin", plugin_api: 1 };
    builtinManifest.tools.find((tool) => tool.id === "replace_card_tool")!.handler = {
      type: "builtin",
      id: "replace_card",
    };
    fs.writeFileSync(builtinManifestFile, `${JSON.stringify(builtinManifest, null, 2)}\n`);
    expect(scanPluginSource(builtinAction)).toMatchObject({
      valid: true,
      m5_projection_action_eligible: false,
      m5_projection_action_eligibility_reasons: expect.arrayContaining([
        "runtime_trust_not_data_only",
        "builtin_handler_present",
      ]),
    });
  });

  it("enforces the single-file Worker Renderer contract in validate, pack, and verify", () => {
    const invalidSources = [
      {
        name: "legacy DOM bridge",
        source: [
          "export function render({ root, node }, bridge) {",
          "  root.textContent = node.fallback.title;",
          "  root.onclick = () => bridge.action('approve');",
          "}",
        ].join("\n"),
        message: "exactly one export",
      },
      {
        name: "module import",
        source: [
          "import { helper } from './helper.mjs';",
          "export function render(payload) {",
          "  return helper(payload);",
          "}",
        ].join("\n"),
        message: "imports are forbidden",
      },
      {
        name: "additional export",
        source: [
          "export const helper = () => 'not allowed';",
          "export function render(payload) {",
          "  return { version: 'v1.0', catalogId: 'https://homerail.dev/a2ui/catalogs/core/v1', components: [{ id: 'root', component: 'Text', text: helper(payload) }] };",
          "}",
        ].join("\n"),
        message: "exactly one export",
      },
    ];

    for (const invalid of invalidSources) {
      const root = temp(`homerail-plugin-custom-${invalid.name.replaceAll(" ", "-")}`);
      scaffoldPluginProject(root, "com.example.invalid-custom");
      addCustomRenderer(root, invalid.source);

      const snapshot = scanPluginSource(root);
      expect(snapshot).toMatchObject({
        valid: false,
        m6_custom_renderer_eligible: false,
        m6_custom_renderer_eligibility_reasons: expect.arrayContaining(["package_validation_failed"]),
      });
      expect(snapshot.issues).toEqual(expect.arrayContaining([
        expect.objectContaining({
          path: "ui/views/custom.mjs",
          severity: "error",
          message: expect.stringContaining(invalid.message),
        }),
      ]));
      expect(() => sourceFilesForPack(snapshot)).toThrow(/Cannot pack invalid plugin source/);

      const archive = buildHrpArchive([...snapshot.files.entries()].map(([filePath, content]) => ({
        path: filePath,
        content,
      }))).archive;
      expect(() => verifyPluginArchive(archive)).toThrow(invalid.message);
    }
  });

  it("bounds Worker Renderer source bytes and requires fatal UTF-8 decoding", () => {
    const validPrefix = Buffer.from([
      "export async function render(payload) {",
      "  return { version: 'v1.0', catalogId: 'https://homerail.dev/a2ui/catalogs/core/v1', components: [{ id: 'root', component: 'Text', text: 'bounded' }] };",
      "}",
      "",
    ].join("\n"));
    const atLimit = Buffer.concat([
      validPrefix,
      Buffer.alloc(HOMERAIL_CUSTOM_RENDERER_SOURCE_MAX_BYTES - validPrefix.byteLength, 0x20),
    ]);
    expect(validatePluginCustomRendererSource(atLimit)).toContain("async function render(payload)");
    expect(() => validatePluginCustomRendererSource(Buffer.concat([atLimit, Buffer.from(" ")])))
      .toThrow(`exceeds ${HOMERAIL_CUSTOM_RENDERER_SOURCE_MAX_BYTES} bytes`);
    expect(() => validatePluginCustomRendererSource(Buffer.from([0xff])))
      .toThrow(/valid UTF-8/);
  });

  it("rejects symbolic-link and non-directory codegen parents component by component", () => {
    const root = temp("homerail-plugin-codegen-parent");
    const outside = temp("homerail-plugin-codegen-outside");
    scaffoldPluginProject(root, "com.example.codegen-parent");

    fs.symlinkSync(outside, path.join(root, ".homerail"), "dir");
    expect(() => generatePluginTypes(root)).toThrow(/output parent must not be a symbolic link/);
    expect(() => generatePluginTypes(root, { check: true })).toThrow(/output parent must not be a symbolic link/);
    expect(fs.readdirSync(outside)).toEqual([]);

    fs.rmSync(path.join(root, ".homerail"));
    fs.mkdirSync(path.join(root, ".homerail"));
    fs.symlinkSync(outside, path.join(root, ".homerail", "generated"), "dir");
    expect(() => generatePluginTypes(root)).toThrow(/output parent must not be a symbolic link/);
    expect(fs.readdirSync(outside)).toEqual([]);

    fs.rmSync(path.join(root, ".homerail", "generated"));
    fs.writeFileSync(path.join(root, ".homerail", "generated"), "not a directory");
    expect(() => generatePluginTypes(root)).toThrow(/output parent must be a directory/);
  });

  it("never follows an existing codegen target symlink for check or write", () => {
    const root = temp("homerail-plugin-codegen-target");
    const outside = temp("homerail-plugin-codegen-victim");
    scaffoldPluginProject(root, "com.example.codegen-target");
    const generatedDirectory = path.join(root, ".homerail", "generated");
    fs.mkdirSync(generatedDirectory, { recursive: true });
    const victim = path.join(outside, "victim.d.ts");
    const output = path.join(generatedDirectory, "plugin-types.d.ts");
    fs.writeFileSync(victim, "do not overwrite\n");
    fs.symlinkSync(victim, output, "file");

    expect(() => generatePluginTypes(root, { check: true }))
      .toThrow(/output file must not be a symbolic link/);
    expect(() => generatePluginTypes(root))
      .toThrow(/output file must not be a symbolic link/);
    expect(fs.readFileSync(victim, "utf8")).toBe("do not overwrite\n");
    expect(fs.lstatSync(output).isSymbolicLink()).toBe(true);
  });

  it("refuses to scaffold into non-empty or aliased roots", () => {
    const root = temp("homerail-plugin-nonempty");
    fs.writeFileSync(path.join(root, "keep.txt"), "mine");
    expect(() => scaffoldPluginProject(root, "com.example.card")).toThrow(/empty directory/);
    expect(() => scaffoldPluginProject(path.join(root, "child"), "invalid")).toThrow(/Invalid/);
  });

  it("prevalidates scaffold identities and leaves an empty destination untouched on failure", () => {
    const valid = temp("homerail-plugin-short-publisher");
    scaffoldPluginProject(valid, "com.plugin");
    expect(scanPluginSource(valid)).toMatchObject({ valid: true, m4_data_only_eligible: true });

    const invalid = temp("homerail-plugin-invalid-version");
    expect(() => scaffoldPluginProject(invalid, "com.example.invalid", { version: "not-semver" }))
      .toThrow(/scaffold is invalid/);
    expect(fs.readdirSync(invalid)).toEqual([]);
  });

  it("rejects manifest and parent-directory symlinks before reading source bytes", () => {
    const root = temp("homerail-plugin-symlink-source");
    const outside = temp("homerail-plugin-symlink-outside");
    scaffoldPluginProject(root, "com.example.symlinks");

    fs.renameSync(path.join(root, "schemas"), path.join(outside, "schemas"));
    fs.symlinkSync(path.join(outside, "schemas"), path.join(root, "schemas"), "dir");
    expect(() => scanPluginSource(root)).toThrow(/traverses a symlink/);

    fs.rmSync(path.join(root, "schemas"));
    fs.renameSync(path.join(outside, "schemas"), path.join(root, "schemas"));
    fs.renameSync(path.join(root, "homerail.plugin.json"), path.join(outside, "manifest.json"));
    fs.symlinkSync(path.join(outside, "manifest.json"), path.join(root, "homerail.plugin.json"), "file");
    expect(() => scanPluginSource(root)).toThrow(/traverses a symlink/);
  });

  it("rejects undeclared payloads and malformed declarative renderer documents", () => {
    const root = temp("homerail-plugin-invalid-renderer");
    scaffoldPluginProject(root, "com.example.cards");
    const snapshot = scanPluginSource(root);
    const files = new Map(snapshot.files);
    files.set("hidden/code.js", Buffer.from("process.exit(0)"));
    expect(validatePluginFiles(files).issues).toContainEqual(expect.objectContaining({
      message: expect.stringContaining("exactly the manifest"),
      severity: "error",
    }));

    const rendererPath = "ui/views/card.v1.json";
    files.delete("hidden/code.js");
    files.set(rendererPath, Buffer.from(JSON.stringify({
      renderer_version: 1,
      type: "card",
      title_pointer: "/title",
      sections: [
        { id: "same", type: "text", pointer: "/summary" },
        { id: "same", type: "text", pointer: "/summary" },
      ],
    })));
    expect(validatePluginFiles(files).issues).toContainEqual(expect.objectContaining({
      path: rendererPath,
      severity: "error",
    }));
  });

  it("applies the same strict Skill and local-schema policy used by installation", () => {
    const root = temp("homerail-plugin-static-policy");
    scaffoldPluginProject(root, "com.example.static-policy");
    const snapshot = scanPluginSource(root);
    const files = new Map(snapshot.files);
    files.set("skills/compose-card/SKILL.md", Buffer.from(`---\nname: another-skill\ndescription: Invalid identity.\n---\n\n# Instructions\n`));
    expect(validatePluginFiles(files)).toMatchObject({
      valid: false,
      issues: [expect.objectContaining({ message: expect.stringContaining("name must match") })],
    });

    const schemaPath = "schemas/card-input.v1.schema.json";
    const schema = JSON.parse(snapshot.files.get(schemaPath)!.toString("utf8")) as Record<string, unknown>;
    schema.properties = {
      ...(schema.properties as Record<string, unknown>),
      remote: { $ref: "https://example.com/untrusted.schema.json" },
    };
    files.set("skills/compose-card/SKILL.md", snapshot.files.get("skills/compose-card/SKILL.md")!);
    files.set(schemaPath, Buffer.from(JSON.stringify(schema)));
    expect(validatePluginFiles(files)).toMatchObject({
      valid: false,
      issues: [expect.objectContaining({ message: expect.stringContaining("$ref") })],
    });

    const migrationFiles = new Map(snapshot.files);
    const manifest = JSON.parse(snapshot.files.get("homerail.plugin.json")!.toString("utf8")) as {
      kinds: Array<{
        current_version: number;
        versions: Array<Record<string, unknown>>;
        migrations: Array<Record<string, unknown>>;
      }>;
    };
    manifest.kinds[0].current_version = 2;
    manifest.kinds[0].versions.push({ ...manifest.kinds[0].versions[0], version: 2 });
    manifest.kinds[0].migrations.push({ from: 1, to: 2, file: "migrations/card-1-2.json" });
    migrationFiles.set("homerail.plugin.json", Buffer.from(JSON.stringify(manifest)));
    migrationFiles.set("migrations/card-1-2.json", Buffer.from("arbitrary executable semantics are not an M4 DSL"));
    expect(validatePluginFiles(migrationFiles)).toMatchObject({
      valid: true,
      m4_data_only_eligible: false,
      issues: [expect.objectContaining({ severity: "warning" })],
    });
  });

  it("rejects invalid UTF-8 consistently in source validation and packed archives", () => {
    const root = temp("homerail-plugin-invalid-utf8");
    scaffoldPluginProject(root, "com.example.invalid-utf8");
    const files = new Map(scanPluginSource(root).files);
    files.set("skills/compose-card/SKILL.md", Buffer.from([0x2d, 0x2d, 0x2d, 0x0a, 0xff]));
    expect(validatePluginFiles(files)).toMatchObject({
      valid: false,
      issues: [expect.objectContaining({ message: expect.stringContaining("valid UTF-8") })],
    });
    const archive = buildHrpArchive([...files.entries()].map(([filePath, content]) => ({ path: filePath, content }))).archive;
    expect(() => verifyPluginArchive(archive)).toThrow(/valid UTF-8/);
  });

  it("aligns per-file and resolved-descriptor budgets with Manager installation", () => {
    const root = temp("homerail-plugin-static-budgets");
    scaffoldPluginProject(root, "com.example.static-budgets");
    const snapshot = scanPluginSource(root);

    const skillFiles = new Map(snapshot.files);
    const skillPrefix = Buffer.from("---\nname: compose-card\ndescription: Bounded Skill.\n---\n\n");
    skillFiles.set("skills/compose-card/SKILL.md", Buffer.concat([
      skillPrefix,
      Buffer.alloc(HOMERAIL_PLUGIN_SKILL_MAX_BYTES - skillPrefix.byteLength, 0x61),
    ]));
    expect(validatePluginFiles(skillFiles).valid).toBe(true);
    skillFiles.set("skills/compose-card/SKILL.md", Buffer.concat([
      skillPrefix,
      Buffer.alloc(HOMERAIL_PLUGIN_SKILL_MAX_BYTES - skillPrefix.byteLength + 1, 0x61),
    ]));
    expect(validatePluginFiles(skillFiles).issues).toContainEqual(expect.objectContaining({
      message: expect.stringContaining(`exceeds ${HOMERAIL_PLUGIN_SKILL_MAX_BYTES} bytes`),
    }));

    const schemaFiles = new Map(snapshot.files);
    const schemaBase = Buffer.from('{"type":"object","properties":{},"additionalProperties":false}');
    schemaFiles.set("schemas/card-input.v1.schema.json", Buffer.concat([
      schemaBase,
      Buffer.alloc(HOMERAIL_PLUGIN_SCHEMA_MAX_BYTES - schemaBase.byteLength, 0x20),
    ]));
    expect(validatePluginFiles(schemaFiles).valid).toBe(true);
    schemaFiles.set("schemas/card-input.v1.schema.json", Buffer.concat([
      schemaBase,
      Buffer.alloc(HOMERAIL_PLUGIN_SCHEMA_MAX_BYTES - schemaBase.byteLength + 1, 0x20),
    ]));
    expect(validatePluginFiles(schemaFiles).issues).toContainEqual(expect.objectContaining({
      message: expect.stringContaining(`exceeds ${HOMERAIL_PLUGIN_SCHEMA_MAX_BYTES} bytes`),
    }));

    const descriptorFiles = new Map(snapshot.files);
    const manifest = JSON.parse(snapshot.files.get("homerail.plugin.json")!.toString("utf8")) as {
      schemas: Array<{ id: string; file: string }>;
    };
    for (let index = 0; index < 13; index += 1) {
      const file = `schemas/padding-${index}.schema.json`;
      manifest.schemas.push({ id: `padding-${index}`, file });
      descriptorFiles.set(file, Buffer.concat([
        schemaBase,
        Buffer.alloc(250 * 1024 - schemaBase.byteLength, 0x20),
      ]));
    }
    descriptorFiles.set("homerail.plugin.json", Buffer.from(JSON.stringify(manifest)));
    expect(validatePluginFiles(descriptorFiles).issues).toContainEqual(expect.objectContaining({
      message: expect.stringContaining("Resolved plugin descriptor exceeds"),
    }));
  });
});
