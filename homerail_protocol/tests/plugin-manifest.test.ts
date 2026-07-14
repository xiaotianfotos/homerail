import { describe, expect, it } from "vitest";
import {
  HOMERAIL_PLUGIN_API_VERSION,
  HOMERAIL_PLUGIN_MANIFEST_VERSION,
  HOMERAIL_RENDERER_API_VERSION,
  collectHomerailPluginFileReferences,
  isSafeHomerailPluginPackagePath,
  validateHomerailPluginCompatibility,
  validateHomerailPluginManifest,
  type HomerailPluginManifestV1,
} from "../src/plugins/index.js";
import { validateMessage } from "../src/validation.js";

function manifest(): HomerailPluginManifestV1 {
  return {
    manifest_version: HOMERAIL_PLUGIN_MANIFEST_VERSION,
    id: "com.homerail.topic-outline",
    version: "1.0.0",
    name: "Topic Outline",
    publisher: { id: "com.homerail", name: "HomeRail" },
    license: "MIT",
    compatibility: {
      homerail: { min: "0.1.0", max_exclusive: "0.2.0" },
      plugin_api: [HOMERAIL_PLUGIN_API_VERSION],
      ui_ir: [1],
      renderer_api: [HOMERAIL_RENDERER_API_VERSION],
    },
    capabilities: [{
      id: "compose",
      summary: "Turn a topic brief into a structured outline.",
      intents: ["outline a topic", "整理选题大纲"],
      tags: ["content", "outline"],
      modalities: ["voice", "text"],
      required_inputs: ["title"],
      skill: "topic-outline",
      tools: ["upsert_topic_outline"],
      workflows: [],
      actions: [],
    }],
    skills: [{
      id: "topic-outline",
      path: "skills/topic-outline/SKILL.md",
      description: "Compose and revise a topic outline.",
    }],
    schemas: [
      { id: "topic-input-v1", file: "schemas/topic-input.v1.schema.json" },
      { id: "outline-content-v1", file: "schemas/outline-content.v1.schema.json" },
    ],
    kinds: [{
      kind: "com.homerail.topic-outline/outline",
      current_version: 1,
      versions: [{
        version: 1,
        content_schema: "outline-content-v1",
        allowed_surfaces: ["task", "result"],
        default_surface: "task",
        default_variant: "detail",
        max_content_bytes: 32 * 1024,
        preferred_visuals: ["outline"],
        fallback: "portable_required",
        actions: [],
      }],
      migrations: [],
    }],
    tools: [{
      id: "upsert_topic_outline",
      description: "Create or replace a semantic topic outline.",
      exposure: ["agent"],
      input_schema: "topic-input-v1",
      output_schema: "outline-content-v1",
      effect: "write",
      permissions: [],
      confirmation: "never",
      handler: { type: "projection", file: "ui/projectors/topic-outline.v1.json" },
    }],
    workflows: [],
    renderers: [{
      id: "topic-outline",
      kind: "com.homerail.topic-outline/outline",
      kind_version: 1,
      renderer_api: HOMERAIL_RENDERER_API_VERSION,
      mode: "builtin",
      surfaces: ["task", "result"],
      devices: ["phone", "desktop", "tv"],
      source: { type: "builtin", id: "topic-outline" },
      fallback: { type: "portable" },
    }],
    actions: [],
    runtime: { trust: "data_only", plugin_api: HOMERAIL_PLUGIN_API_VERSION },
    permissions: { required: [], optional: [] },
    state: { schema_version: 1, migrations: [] },
  };
}

describe("HomeRail Plugin Manifest V1", () => {
  it("accepts a strict vertical capability manifest without mutating it", () => {
    const input = manifest();
    const before = structuredClone(input);
    expect(validateHomerailPluginManifest(input)).toEqual({
      valid: true,
      value: before,
      errors: [],
    });
    expect(input).toEqual(before);
  });

  it("rejects unknown fields and malformed semantic versions", () => {
    expect(validateHomerailPluginManifest({ ...manifest(), surprise: true }).valid).toBe(false);
    expect(validateHomerailPluginManifest({ ...manifest(), version: "v1" }).valid).toBe(false);
    expect(validateHomerailPluginManifest({ ...manifest(), version: "1.0.0-01" }).valid).toBe(false);

    const invalidRange = manifest();
    invalidRange.compatibility.homerail.max_exclusive = "0.1.0";
    expect(validateHomerailPluginManifest(invalidRange).errors).toContainEqual(expect.objectContaining({
      keyword: "compatibilityRange",
    }));
  });

  it("normalizes paths and enforces minimum side-effect policy", () => {
    expect(isSafeHomerailPluginPackagePath("skills/valid/SKILL.md")).toBe(true);
    expect(isSafeHomerailPluginPackagePath("skills/bad\nname/SKILL.md")).toBe(false);
    expect(isSafeHomerailPluginPackagePath("skills/bad\0name/SKILL.md")).toBe(false);

    const destructive = manifest();
    destructive.tools[0].effect = "destructive";
    expect(validateHomerailPluginManifest(destructive).errors).toContainEqual(expect.objectContaining({
      keyword: "effectConfirmation",
    }));

    const network = manifest();
    network.permissions.optional = [{ permission: "network.connect" }];
    network.tools[0].permissions = ["network.connect"];
    expect(validateHomerailPluginManifest(network).errors).toContainEqual(expect.objectContaining({
      keyword: "networkAllowlist",
    }));
  });

  it("rejects duplicate declarations, dangling references, and foreign namespaces", () => {
    const duplicate = manifest();
    duplicate.skills.push(structuredClone(duplicate.skills[0]));
    expect(validateHomerailPluginManifest(duplicate).errors).toContainEqual(expect.objectContaining({
      keyword: "uniqueDeclaration",
    }));

    const dangling = manifest();
    dangling.capabilities[0].tools = ["missing_tool"];
    expect(validateHomerailPluginManifest(dangling).errors).toContainEqual(expect.objectContaining({
      keyword: "toolReference",
    }));

    const foreign = manifest();
    foreign.kinds[0].kind = "com.example.other/outline";
    expect(validateHomerailPluginManifest(foreign).errors).toContainEqual(expect.objectContaining({
      keyword: "pluginNamespace",
    }));
  });

  it("rejects duplicate workflow URI ownership before package installation", () => {
    const value = manifest();
    value.workflows = [
      {
        id: "publish-outline",
        uri: "plugin://com.example.topic-outline/workflows/publish",
        file: "workflows/publish.md",
        effect: "write",
        permissions: [],
        confirmation: "policy",
      },
      {
        id: "publish-outline-again",
        uri: "plugin://com.example.topic-outline/workflows/publish",
        file: "workflows/publish-again.md",
        effect: "write",
        permissions: [],
        confirmation: "policy",
      },
    ];
    expect(validateHomerailPluginManifest(value).errors).toContainEqual(expect.objectContaining({
      path: "/workflows/1",
      keyword: "uniqueDeclaration",
      message: expect.stringContaining("plugin://com.example.topic-outline/workflows/publish"),
    }));
  });

  it("requires contiguous kind versions and adjacent migrations", () => {
    const input = manifest();
    input.kinds[0].current_version = 2;
    input.kinds[0].versions.push({ ...structuredClone(input.kinds[0].versions[0]), version: 3 });
    expect(validateHomerailPluginManifest(input).errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ keyword: "kindVersionSequence" }),
      expect.objectContaining({ keyword: "kindMigrationSequence" }),
    ]));
  });

  it("bounds version axes without allocating from hostile values", () => {
    const hostile = manifest();
    hostile.kinds[0].current_version = 4_294_967_296;
    expect(() => validateHomerailPluginManifest(hostile)).not.toThrow();
    expect(validateHomerailPluginManifest(hostile).valid).toBe(false);

    const hostileState = manifest();
    hostileState.state.schema_version = Number.MAX_SAFE_INTEGER;
    expect(() => validateHomerailPluginManifest(hostileState)).not.toThrow();
    expect(validateHomerailPluginManifest(hostileState).valid).toBe(false);
  });

  it("checks renderer kind, surface, mode, and exact resolution keys", () => {
    const input = manifest();
    input.renderers[0].surfaces = ["execution"];
    input.renderers[0].mode = "declarative";
    expect(validateHomerailPluginManifest(input).errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ keyword: "surfaceReference" }),
      expect.objectContaining({ keyword: "rendererMode" }),
    ]));

    const duplicate = manifest();
    duplicate.renderers.push({ ...structuredClone(duplicate.renderers[0]), id: "topic-outline-alt" });
    expect(validateHomerailPluginManifest(duplicate).errors).toContainEqual(expect.objectContaining({
      keyword: "uniqueRendererKey",
    }));
  });

  it("requires permissions to be declared and handlers to match the trust tier", () => {
    const permission = manifest();
    permission.tools[0].permissions = ["workspace.write"];
    expect(validateHomerailPluginManifest(permission).errors).toContainEqual(expect.objectContaining({
      keyword: "permissionReference",
    }));

    const runtime = manifest();
    runtime.tools[0].handler = { type: "runtime", method: "compose" };
    expect(validateHomerailPluginManifest(runtime).errors).toContainEqual(expect.objectContaining({
      keyword: "runtimeTrust",
    }));

    const trustedRuntime = manifest();
    trustedRuntime.runtime.trust = "trusted_builtin";
    trustedRuntime.tools[0].handler = { type: "runtime", method: "compose" };
    expect(validateHomerailPluginManifest(trustedRuntime).errors)
      .not.toContainEqual(expect.objectContaining({ keyword: "runtimeTrust" }));
  });

  it("rejects unsafe package paths and collects the complete deterministic file set", () => {
    const unsafe = manifest();
    unsafe.skills[0].path = "../outside/SKILL.md";
    expect(validateHomerailPluginManifest(unsafe).valid).toBe(false);

    expect(collectHomerailPluginFileReferences(manifest())).toEqual([
      "schemas/outline-content.v1.schema.json",
      "schemas/topic-input.v1.schema.json",
      "skills/topic-outline/SKILL.md",
      "ui/projectors/topic-outline.v1.json",
    ]);
  });

  it("does not let the generic schema entrypoint bypass manifest semantics", () => {
    const unsafe = manifest();
    unsafe.skills[0].path = "../outside/SKILL.md";
    expect(validateMessage(unsafe, "homerail-plugin-manifest-v1")).toMatchObject({
      valid: false,
      errors: [expect.objectContaining({ keyword: "skillPath" })],
    });
  });

  it("evaluates every compatibility axis independently", () => {
    const input = manifest();
    expect(validateHomerailPluginCompatibility(input, {
      homerail: "0.1.0",
      plugin_api: 1,
      ui_ir: 1,
      renderer_api: 1,
    })).toEqual([]);
    expect(validateHomerailPluginCompatibility(input, {
      homerail: "0.2.0",
      plugin_api: 2,
      ui_ir: 2,
      renderer_api: 2,
    }).map((entry) => entry.path)).toEqual([
      "/compatibility/homerail",
      "/compatibility/plugin_api",
      "/compatibility/ui_ir",
      "/compatibility/renderer_api",
    ]);
  });

  it("fails safely for cyclic, accessor-backed, and oversized inputs", () => {
    const cyclic = manifest() as unknown as Record<string, unknown>;
    cyclic.self = cyclic;
    expect(validateHomerailPluginManifest(cyclic).errors[0]?.keyword).toBe("jsonValue");

    const accessor = manifest() as unknown as Record<string, unknown>;
    Object.defineProperty(accessor, "name", { enumerable: true, get: () => "unsafe" });
    expect(validateHomerailPluginManifest(accessor).errors[0]?.keyword).toBe("jsonValue");

    const oversized = manifest();
    oversized.capabilities[0].summary = "x".repeat(600 * 1024);
    expect(validateHomerailPluginManifest(oversized).errors[0]?.keyword).toBe("maxPayloadBytes");
  });
});
