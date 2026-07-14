import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { HomerailPluginManifestV1 } from "homerail-protocol";
import { repoRoot } from "../src/assets/root.js";
import { GenerativeUiKindRegistry } from "../src/generative-ui/kind-registry.js";
import { closeDb, getDb } from "../src/persistence/db.js";
import {
  getPluginRegistryState,
  listPluginPackages,
  setPluginEnabled,
  syncPluginPackage,
} from "../src/persistence/plugins.js";
import { pluginDescriptorPackageDigest } from "../src/plugins/descriptor.js";
import { loadPluginPackage } from "../src/plugins/manifest-loader.js";
import {
  CORE_PLUGIN_ID,
  HomerailPluginRegistry,
  M3_BUILTIN_RENDERER_IDS,
  M3_LEGACY_BRIDGE_PLUGIN_IDS,
} from "../src/plugins/registry.js";

const corePackage = () => path.join(repoRoot(), "plugins", "builtin", "core-generative-ui");
const prCloseoutPackage = () => path.join(repoRoot(), "plugins", "builtin", "pr-closeout");
const topicPackage = () => path.join(repoRoot(), "plugins", "builtin", "topic-outline");

function writeAccidentalA2uiV1Core(root: string): string {
  const packageRoot = path.join(root, "core-generative-ui-0.1.7");
  fs.cpSync(corePackage(), packageRoot, { recursive: true });
  const manifestFile = path.join(packageRoot, "homerail.plugin.json");
  const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8")) as HomerailPluginManifestV1;
  manifest.version = "0.1.7";

  const generatedView = manifest.kinds.find((kind) => kind.kind === "com.homerail.core/generated_view");
  const a2uiVersion = generatedView?.versions.find((version) => version.version === 2);
  if (!generatedView || !a2uiVersion) throw new Error("Current Core package does not declare A2UI v2");
  generatedView.current_version = 1;
  generatedView.versions = [{ ...a2uiVersion, version: 1 }];
  generatedView.migrations = [];
  manifest.renderers = manifest.renderers
    .filter((renderer) => renderer.kind !== generatedView.kind || renderer.id === "core-generated-view")
    .map((renderer) => renderer.id === "core-generated-view"
      ? { ...renderer, kind_version: 1 }
      : renderer);

  const projectorFile = path.join(packageRoot, "ui", "projectors", "generated-view.v1.json");
  const projector = JSON.parse(fs.readFileSync(projectorFile, "utf8")) as Record<string, unknown>;
  projector.kind_version = 1;
  fs.writeFileSync(projectorFile, JSON.stringify(projector, null, 2));
  fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2));
  return packageRoot;
}

function writeMinimalPlugin(root: string, id = "com.example.notes", version = "1.0.0"): string {
  const packageRoot = path.join(root, `${id}-${version}`);
  fs.mkdirSync(path.join(packageRoot, "skills", "notes"), { recursive: true });
  fs.mkdirSync(path.join(packageRoot, "schemas"), { recursive: true });
  const manifest: HomerailPluginManifestV1 = {
    manifest_version: 1,
    id,
    version,
    name: "Notes",
    publisher: { id: "com.example", name: "Example" },
    license: "MIT",
    compatibility: {
      homerail: { min: "0.1.0", max_exclusive: "0.2.0" },
      plugin_api: [1], ui_ir: [1], renderer_api: [1],
    },
    capabilities: [{
      id: "notes", summary: "Keep notes.", intents: ["keep a note"],
      modalities: ["text"], required_inputs: [], skill: "notes",
      tools: [], workflows: [], actions: [],
    }],
    skills: [{ id: "notes", path: "skills/notes/SKILL.md", description: "Keep notes." }],
    schemas: [{ id: "notes-v1", file: "schemas/notes.v1.schema.json" }],
    kinds: [], tools: [], workflows: [], renderers: [], actions: [],
    runtime: { trust: "data_only", plugin_api: 1 },
    permissions: { required: [], optional: [] },
    state: { schema_version: 1, migrations: [] },
  };
  fs.writeFileSync(path.join(packageRoot, "homerail.plugin.json"), JSON.stringify(manifest, null, 2));
  fs.writeFileSync(path.join(packageRoot, "skills", "notes", "SKILL.md"), [
    "---", "name: notes", "description: Keep concise notes.", "---", "", "# Notes", "", "Keep only useful notes.", "",
  ].join("\n"));
  fs.writeFileSync(path.join(packageRoot, "schemas", "notes.v1.schema.json"), JSON.stringify({
    type: "object", properties: { note: { type: "string", maxLength: 2000 } }, required: ["note"], additionalProperties: false,
  }, null, 2));
  return packageRoot;
}

function writeActionPlugin(root: string): string {
  const packageRoot = writeMinimalPlugin(root, "com.example.actions", "1.0.0");
  const manifestFile = path.join(packageRoot, "homerail.plugin.json");
  const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8")) as HomerailPluginManifestV1;
  manifest.capabilities[0].actions = ["pin_note"];
  manifest.kinds = [{
    kind: "com.example.actions/note",
    current_version: 1,
    versions: [{
      version: 1,
      content_schema: "notes-v1",
      allowed_surfaces: ["task"],
      default_surface: "task",
      default_variant: "summary",
      max_content_bytes: 4096,
      preferred_visuals: ["note"],
      fallback: "portable_required",
      actions: ["pin_note"],
    }],
    migrations: [],
  }];
  manifest.tools = [{
    id: "pin_note_tool",
    description: "Pin the selected note through an Action-bound Tool.",
    exposure: ["action"],
    input_schema: "notes-v1",
    output_schema: "notes-v1",
    effect: "write",
    permissions: [],
    confirmation: "never",
    handler: { type: "projection", file: "ui/pin-note.v1.json" },
  }];
  manifest.actions = [{
    id: "pin_note",
    intent: "com.example.actions:pin_note",
    tool: "pin_note_tool",
  }];
  fs.mkdirSync(path.join(packageRoot, "ui"), { recursive: true });
  fs.writeFileSync(path.join(packageRoot, "ui", "pin-note.v1.json"), JSON.stringify({
    projection_version: 1,
    type: "direct_ui_node",
    kind: "com.example.actions/note",
    kind_version: 1,
    node_id_pointer: "/note",
    content_pointer: "",
    omit_content_fields: [],
    fallback: { title_pointer: "/note" },
    defaults: { surface: "task", importance: "primary", density: "summary", persistence: "session" },
  }, null, 2));
  fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2));
  return packageRoot;
}

describe("HomeRail plugin archive and activation registry", () => {
  let previousHome: string | undefined;
  let tmpHome: string;

  beforeEach(() => {
    closeDb();
    previousHome = process.env.HOMERAIL_HOME;
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "homerail-plugin-registry-"));
    process.env.HOMERAIL_HOME = tmpHome;
  });

  afterEach(() => {
    closeDb();
    if (previousHome === undefined) delete process.env.HOMERAIL_HOME;
    else process.env.HOMERAIL_HOME = previousHome;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it("loads the bundled Core package into a deterministic immutable descriptor", () => {
    const options = {
      source: "builtin" as const,
      trusted_builtin_ids: new Set([CORE_PLUGIN_ID]),
      builtin_renderer_ids: M3_BUILTIN_RENDERER_IDS,
    };
    const first = loadPluginPackage(corePackage(), options);
    const second = loadPluginPackage(corePackage(), options);
    expect(second).toEqual(first);
    expect(first).toMatchObject({
      descriptor_version: 1,
      manifest: { id: CORE_PLUGIN_ID, version: "0.1.8" },
      skills: [{ id: "voice-generative-ui" }],
    });
    expect(first.schemas.map((schema) => schema.id)).toEqual([
      "legacy-widget-content-v1",
      "generated-view-input-v1",
      "generated-view-content-v1",
    ]);
    expect(first.manifest.tools).toEqual([expect.objectContaining({ id: "upsert_generated_view" })]);
    expect(first.manifest.renderers).toContainEqual(expect.objectContaining({
      id: "core-generated-view",
      source: { type: "builtin", id: "a2ui" },
    }));
    expect(first.package_digest).toMatch(/^[a-f0-9]{64}$/);
  });

  it("keeps the accidental builtin Core 0.1.7 generated_view v1 package readable", () => {
    const options = {
      source: "builtin" as const,
      trusted_builtin_ids: new Set([CORE_PLUGIN_ID]),
      builtin_renderer_ids: M3_BUILTIN_RENDERER_IDS,
    };
    const legacyA2ui = loadPluginPackage(writeAccidentalA2uiV1Core(tmpHome), options);
    syncPluginPackage({
      descriptor: legacyA2ui,
      source: "builtin",
      locked: true,
      default_enabled: true,
    });
    const current = loadPluginPackage(corePackage(), options);
    syncPluginPackage({
      descriptor: current,
      source: "builtin",
      locked: true,
      default_enabled: true,
    });

    const registry = new GenerativeUiKindRegistry();
    expect(registry.getDefinition({
      owner: { id: CORE_PLUGIN_ID, version: "0.1.7" },
      kind: "com.homerail.core/generated_view",
      kind_version: 1,
    })).toBeDefined();
    expect(registry.compositionMetadata().filter((kind) => kind.kind === "com.homerail.core/generated_view"))
      .toEqual([expect.objectContaining({ kind_version: 2 })]);
    expect(registry.uiProjection().kinds
      .filter((kind) => kind.kind === "com.homerail.core/generated_view")
      .map((kind) => kind.kind_version)).toEqual([1, 2]);
  });

  it("rejects symlink escapes and non-local schema references", () => {
    const copy = path.join(tmpHome, "core-copy");
    fs.cpSync(corePackage(), copy, { recursive: true });
    const skill = path.join(copy, "skills", "voice-generative-ui", "SKILL.md");
    fs.rmSync(skill);
    fs.symlinkSync(path.join(corePackage(), "skills", "voice-generative-ui", "SKILL.md"), skill);
    expect(() => loadPluginPackage(copy, {
      source: "builtin",
      builtin_renderer_ids: M3_BUILTIN_RENDERER_IDS,
    })).toThrow(/symlink/i);

    const minimal = writeMinimalPlugin(tmpHome);
    fs.writeFileSync(path.join(minimal, "schemas", "notes.v1.schema.json"), JSON.stringify({
      type: "object",
      properties: { note: { $ref: "https://example.invalid/schema.json" } },
      additionalProperties: false,
    }));
    expect(() => loadPluginPackage(minimal, { source: "development" })).toThrow(/fragment \$ref/i);
  });

  it("allows legacy UI bridges only for explicitly approved builtin migrations", () => {
    expect(() => loadPluginPackage(topicPackage(), {
      source: "builtin",
      builtin_renderer_ids: M3_BUILTIN_RENDERER_IDS,
    })).toThrow(/restricted to approved builtin migrations/);
    expect(loadPluginPackage(topicPackage(), {
      source: "builtin",
      builtin_renderer_ids: M3_BUILTIN_RENDERER_IDS,
      legacy_bridge_plugin_ids: M3_LEGACY_BRIDGE_PLUGIN_IDS,
    }).manifest.id).toBe("com.homerail.topic-outline");
  });

  it("loads the PR closeout capability as a data-only builtin with a trusted renderer id", () => {
    const descriptor = loadPluginPackage(prCloseoutPackage(), {
      source: "builtin",
      builtin_renderer_ids: M3_BUILTIN_RENDERER_IDS,
    });
    expect(descriptor).toMatchObject({
      manifest: {
        id: "com.homerail.pr-closeout",
        runtime: { trust: "data_only" },
        kinds: [{ versions: [{ default_variant: "detail" }] }],
        tools: [{ id: "upsert_pr_closeout", handler: { type: "projection" } }],
        renderers: [{ id: "pr-closeout-main", source: { type: "builtin", id: "pr-closeout" } }],
      },
      skills: [{ id: "pr-closeout" }],
    });
  });

  it("keeps Core locked and preserves an optional plugin disable across resync", () => {
    const registry = new HomerailPluginRegistry();
    const first = registry.snapshot();
    expect(first.plugins.map((plugin) => plugin.plugin_id)).toEqual([
      CORE_PLUGIN_ID,
      "com.homerail.pr-closeout",
      "com.homerail.topic-outline",
    ]);
    expect(first.plugins.find((plugin) => plugin.plugin_id === CORE_PLUGIN_ID)?.activation)
      .toMatchObject({ enabled: true, locked: true, revision: 1 });
    expect(first.plugins.find((plugin) => plugin.plugin_id === "com.homerail.topic-outline")?.activation)
      .toMatchObject({ enabled: true, locked: false, revision: 1 });
    expect(() => registry.setEnabled(CORE_PLUGIN_ID, false)).toThrow(/locked/);
    expect(registry.snapshot()).toMatchObject({ revision: first.revision, fingerprint: first.fingerprint });

    expect(setPluginEnabled("com.homerail.topic-outline", false, { timestamp: "2026-07-11T12:01:00.000Z" }))
      .toMatchObject({ enabled: false, revision: 2 });
    registry.syncBuiltins();
    expect(getPluginRegistryState().plugins.find((plugin) => plugin.plugin_id === "com.homerail.topic-outline")?.activation)
      .toMatchObject({ enabled: false, revision: 2 });
  });

  it("archives versions side by side and rejects same-version content drift", () => {
    const firstRoot = writeMinimalPlugin(tmpHome, "com.example.notes", "1.0.0");
    const first = loadPluginPackage(firstRoot, { source: "development" });
    syncPluginPackage({ descriptor: first, source: "development", default_enabled: true });

    const driftRoot = path.join(tmpHome, "drift");
    fs.cpSync(firstRoot, driftRoot, { recursive: true });
    fs.appendFileSync(path.join(driftRoot, "skills", "notes", "SKILL.md"), "\nUse a stable id.\n");
    const drift = loadPluginPackage(driftRoot, { source: "development" });
    expect(drift.package_digest).not.toBe(first.package_digest);
    expect(() => syncPluginPackage({ descriptor: drift, source: "development" })).toThrow(/digest collision/);

    const second = loadPluginPackage(writeMinimalPlugin(tmpHome, "com.example.notes", "1.1.0"), {
      source: "development",
    });
    const activated = syncPluginPackage({ descriptor: second, source: "development" });
    expect(activated.activation).toMatchObject({ active_version: "1.1.0", enabled: true, revision: 2 });
    expect(listPluginPackages().map((entry) => entry.plugin_version)).toEqual(["1.0.0", "1.1.0"]);
    expect(() => getDb().prepare(`
      DELETE FROM plugin_packages WHERE plugin_id = ? AND plugin_version = ?
    `).run("com.example.notes", "1.1.0")).toThrow(/foreign key/i);
  });

  it("refreshes only application-bundled same-version packages", () => {
    const firstRoot = writeMinimalPlugin(tmpHome, "com.example.builtin", "0.1.0");
    const first = loadPluginPackage(firstRoot, { source: "builtin" });
    syncPluginPackage({ descriptor: first, source: "builtin", default_enabled: true });

    const driftRoot = path.join(tmpHome, "builtin-drift");
    fs.cpSync(firstRoot, driftRoot, { recursive: true });
    fs.appendFileSync(path.join(driftRoot, "skills", "notes", "SKILL.md"), "\nUse the current host contract.\n");
    const drift = loadPluginPackage(driftRoot, { source: "builtin" });
    expect(drift.package_digest).not.toBe(first.package_digest);
    expect(() => syncPluginPackage({ descriptor: drift, source: "builtin" })).toThrow(/digest collision/);

    const refreshed = syncPluginPackage({
      descriptor: drift,
      source: "builtin",
      refresh_builtin: true,
    });
    expect(refreshed).toMatchObject({
      package_digest: drift.package_digest,
      source: "builtin",
      activation: { active_version: "0.1.0", enabled: true, revision: 2 },
    });
    expect(listPluginPackages()).toHaveLength(1);
    expect(() => syncPluginPackage({
      descriptor: drift,
      source: "development",
      refresh_builtin: true,
    })).toThrow(/Only builtin plugins/);
  });

  it("qualifies Action capability identities in the UI registry projection", () => {
    const descriptor = loadPluginPackage(writeActionPlugin(tmpHome), { source: "development" });
    syncPluginPackage({ descriptor, source: "development", default_enabled: true });
    expect(new GenerativeUiKindRegistry().uiProjection().actions).toContainEqual({
      plugin_id: "com.example.actions",
      plugin_version: "1.0.0",
      local_id: "pin_note",
      qualified_id: "com.example.actions:pin_note",
      capability_ids: ["com.example.actions:notes"],
      intent: "com.example.actions:pin_note",
    });
  });

  it("fails closed when a persisted descriptor is corrupted", () => {
    const descriptor = loadPluginPackage(writeMinimalPlugin(tmpHome), { source: "development" });
    syncPluginPackage({ descriptor, source: "development", default_enabled: true });
    const broken = structuredClone(descriptor);
    broken.schemas[0].schema = { type: "object", additionalProperties: true };
    const { package_digest: _digest, ...unsigned } = broken;
    broken.package_digest = pluginDescriptorPackageDigest(unsigned);
    getDb().prepare(`
      UPDATE plugin_packages SET resolved_descriptor_json = ? WHERE plugin_id = ?
    `).run(JSON.stringify(broken), descriptor.manifest.id);
    expect(() => getPluginRegistryState()).toThrow(/Invalid persisted plugin package/);
  });
});
