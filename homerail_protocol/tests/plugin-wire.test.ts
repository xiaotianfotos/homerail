import { describe, expect, it } from "vitest";
import {
  validateHomerailPluginTurnContext,
  validateHomerailPluginUiProjection,
  validateHomerailResolvedPluginDescriptorWire,
  applyHomerailDirectUiProjection,
  validateHomerailDirectUiProjection,
  validateHomerailPluginToolInput,
  type HomerailPluginManifestV1,
  type HomerailPluginTurnContextV1,
  type HomerailResolvedPluginDescriptorV1,
} from "../src/plugins/index.js";

const digest = "0".repeat(64);

function manifest(): HomerailPluginManifestV1 {
  return {
    manifest_version: 1,
    id: "com.example.notes",
    version: "1.0.0",
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
}

function descriptor(): HomerailResolvedPluginDescriptorV1 {
  return {
    descriptor_version: 1,
    manifest: manifest(),
    manifest_digest: digest,
    package_digest: digest,
    schemas: [{
      id: "notes-v1",
      file: "schemas/notes.v1.schema.json",
      digest,
      schema: { type: "object", additionalProperties: false },
    }],
    skills: [{
      id: "notes",
      path: "skills/notes/SKILL.md",
      digest,
      content: "---\nname: notes\ndescription: Keep notes.\n---\n\nKeep notes.",
    }],
    referenced_files: [
      { path: "schemas/notes.v1.schema.json", digest, encoding: "base64", content: "e30=" },
      { path: "skills/notes/SKILL.md", digest, encoding: "base64", content: "bm90ZXM=" },
    ],
  };
}

function context(): HomerailPluginTurnContextV1 {
  return {
    context_version: 1,
    registry_revision: 1,
    enabled_plugins: [{ id: "com.example.notes", version: "1.0.0", manifest_digest: digest }],
    skills: [{
      plugin_id: "com.example.notes",
      plugin_version: "1.0.0",
      local_id: "notes",
      qualified_id: "com.example.notes:notes",
      capability_ids: ["com.example.notes:notes"],
      description: "Keep notes.",
      digest,
    }],
    tools: [],
    actions: [],
    permission_revision: 0,
    context_digest: digest,
  };
}

describe("HomeRail plugin wire contracts", () => {
  it("validates an archived descriptor without following package paths", () => {
    expect(validateHomerailResolvedPluginDescriptorWire(descriptor())).toMatchObject({ valid: true });
    expect(validateHomerailResolvedPluginDescriptorWire({
      ...descriptor(),
      extra: true,
    }).valid).toBe(false);
  });

  it("requires canonical qualified identities and enabled plugin references", () => {
    expect(validateHomerailPluginTurnContext(context())).toMatchObject({ valid: true });
    const invalid = context();
    invalid.skills[0].qualified_id = "com.example.notes:other";
    expect(validateHomerailPluginTurnContext(invalid).errors).toContainEqual(expect.objectContaining({
      keyword: "qualifiedIdentity",
    }));
  });

  it("requires canonical ordering and unique harness wire ids", () => {
    const invalid = context();
    invalid.tools = [
      {
        plugin_id: "com.example.notes", plugin_version: "1.0.0", local_id: "write_note",
        qualified_id: "com.example.notes:write_note", wire_id: "write_note", capability_ids: [],
        description: "Write note.", input_schema: {}, effect: "write", permissions: [],
        confirmation: "never", handler: { type: "builtin", id: "write-note" },
      },
      {
        plugin_id: "com.example.notes", plugin_version: "1.0.0", local_id: "read_note",
        qualified_id: "com.example.notes:read_note", wire_id: "write_note", capability_ids: [],
        description: "Read note.", input_schema: {}, effect: "read", permissions: [],
        confirmation: "never", handler: { type: "builtin", id: "read-note" },
      },
    ];
    expect(validateHomerailPluginTurnContext(invalid).errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ keyword: "canonicalOrder" }),
      expect.objectContaining({ keyword: "uniqueDeclaration" }),
    ]));
  });

  it("validates a strict empty UI registry projection", () => {
    expect(validateHomerailPluginUiProjection({
      registry_revision: 0,
      registry_fingerprint: digest,
      kinds: [], renderers: [], actions: [],
    })).toMatchObject({ valid: true });
    expect(validateHomerailPluginUiProjection({
      registry_revision: 0,
      registry_fingerprint: digest,
      kinds: [], renderers: [], actions: [], unknown: true,
    }).valid).toBe(false);
  });

  it("applies a bounded declarative Domain-to-UI projection without code", () => {
    const projection = {
      projection_version: 1,
      type: "direct_ui_node",
      kind: "com.example.notes/note",
      kind_version: 1,
      node_id_pointer: "/id",
      content_pointer: "",
      omit_content_fields: ["id"],
      fallback: { title_pointer: "/title", summary_pointer: "/note", items_pointer: "/questions" },
      defaults: { surface: "task", importance: "primary", density: "detail", persistence: "session" },
      legacy_bridge: { widget_type: "note", visual: "note" },
    } as const;
    expect(validateHomerailDirectUiProjection(projection)).toMatchObject({ valid: true });
    expect(validateHomerailPluginToolInput({
      type: "object",
      properties: { id: { type: "string" }, title: { type: "string" } },
      required: ["id", "title"],
      additionalProperties: false,
    }, { id: "note-1", title: "One" })).toMatchObject({ valid: true });
    expect(applyHomerailDirectUiProjection({
      projection,
      plugin: { id: "com.example.notes", version: "1.0.0" },
      arguments: {
        id: "note-1",
        title: "Research notes",
        note: "Keep the ABI semantic.",
        questions: ["How is history replayed?"],
      },
    })).toMatchObject({
      node: {
        id: "note-1",
        kind: "com.example.notes/note",
        owner: { id: "com.example.notes", version: "1.0.0" },
        content: {
          title: "Research notes",
          note: "Keep the ABI semantic.",
          questions: ["How is history replayed?"],
        },
        fallback: {
          title: "Research notes",
          summary: "Keep the ABI semantic.",
          items: ["How is history replayed?"],
        },
      },
      legacy_widget: { id: "note-1", type: "note", data: { visual: "note" } },
    });
  });
});
