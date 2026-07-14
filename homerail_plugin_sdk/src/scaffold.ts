import * as fs from "node:fs";
import * as path from "node:path";
import { isHomerailPluginId } from "homerail-protocol";
import { validatePluginFiles } from "./project.js";

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function titleFromId(pluginId: string): string {
  return pluginId.split(/[.-]/).at(-1)!
    .split("-")
    .map((part) => part ? `${part[0].toUpperCase()}${part.slice(1)}` : "")
    .join(" ");
}

export interface ScaffoldPluginOptions {
  name?: string;
  version?: string;
}

export function scaffoldPluginProject(
  destinationValue: string,
  pluginId: string,
  options: ScaffoldPluginOptions = {},
): { root: string; files: string[] } {
  if (!isHomerailPluginId(pluginId)) throw new Error(`Invalid HomeRail plugin id: ${pluginId}`);
  const root = path.resolve(destinationValue);
  const rootExisted = fs.existsSync(root);
  if (fs.existsSync(root)) {
    const stat = fs.lstatSync(root);
    if (stat.isSymbolicLink() || !stat.isDirectory() || fs.readdirSync(root).length) {
      throw new Error("Plugin scaffold destination must be a real empty directory");
    }
  }
  const name = options.name?.trim() || titleFromId(pluginId);
  const version = options.version ?? "0.1.0";
  const kind = `${pluginId}/card`;
  const files = new Map<string, string>([
    ["homerail.plugin.json", json({
      manifest_version: 1,
      id: pluginId,
      version,
      name,
      publisher: {
        id: pluginId.split(".").length > 2 ? pluginId.split(".").slice(0, -1).join(".") : pluginId,
        name: "Local Developer",
      },
      license: "MIT",
      compatibility: {
        homerail: { min: "0.1.0", max_exclusive: "0.2.0" },
        plugin_api: [1], ui_ir: [1], renderer_api: [1],
      },
      capabilities: [{
        id: "compose-card",
        summary: `Create and revise a ${name} card.`,
        intents: [`create a ${name.toLowerCase()} card`, `update the ${name.toLowerCase()} card`],
        tags: ["card", "data-only"],
        modalities: ["voice", "text", "touch"],
        required_inputs: ["title"],
        skill: "compose-card",
        tools: ["upsert_card"], workflows: [], actions: [],
      }],
      skills: [{
        id: "compose-card",
        path: "skills/compose-card/SKILL.md",
        description: `Create and revise a ${name} semantic card.`,
      }],
      schemas: [
        { id: "card-input-v1", file: "schemas/card-input.v1.schema.json" },
        { id: "card-content-v1", file: "schemas/card-content.v1.schema.json" },
      ],
      kinds: [{
        kind,
        current_version: 1,
        versions: [{
          version: 1,
          content_schema: "card-content-v1",
          allowed_surfaces: ["task", "result"],
          default_surface: "task",
          default_variant: "detail",
          max_content_bytes: 32768,
          preferred_visuals: ["card"],
          fallback: "portable_required",
          actions: [],
        }],
        migrations: [],
      }],
      tools: [{
        id: "upsert_card",
        description: "Create or replace the complete current card using one stable plugin-owned id.",
        exposure: ["agent"],
        input_schema: "card-input-v1",
        output_schema: "card-content-v1",
        effect: "write",
        permissions: [],
        confirmation: "never",
        handler: { type: "projection", file: "ui/projectors/card.v1.json" },
      }],
      workflows: [],
      renderers: [{
        id: "card-main",
        kind,
        kind_version: 1,
        renderer_api: 1,
        mode: "declarative",
        surfaces: ["task", "result"],
        devices: ["phone", "desktop", "tv"],
        source: { type: "declarative", file: "ui/views/card.v1.json" },
        fallback: { type: "portable" },
      }],
      actions: [],
      runtime: { trust: "data_only", plugin_api: 1 },
      permissions: { required: [], optional: [] },
      state: { schema_version: 1, migrations: [] },
    })],
    ["schemas/card-input.v1.schema.json", json({
      $schema: "http://json-schema.org/draft-07/schema#",
      type: "object",
      properties: {
        id: { type: "string", minLength: pluginId.length + 2, maxLength: 256 },
        title: { type: "string", minLength: 1, maxLength: 120 },
        summary: { type: "string", maxLength: 2000 },
        items: { type: "array", maxItems: 16, items: { type: "string", minLength: 1, maxLength: 240 } },
      },
      required: ["id", "title"],
      additionalProperties: false,
    })],
    ["schemas/card-content.v1.schema.json", json({
      $schema: "http://json-schema.org/draft-07/schema#",
      type: "object",
      properties: {
        title: { type: "string", minLength: 1, maxLength: 120 },
        summary: { type: "string", maxLength: 2000 },
        items: { type: "array", maxItems: 16, items: { type: "string", minLength: 1, maxLength: 240 } },
      },
      required: ["title"],
      additionalProperties: false,
    })],
    ["ui/projectors/card.v1.json", json({
      projection_version: 1,
      type: "direct_ui_node",
      kind,
      kind_version: 1,
      node_id_pointer: "/id",
      content_pointer: "",
      omit_content_fields: ["id"],
      fallback: { title_pointer: "/title", summary_pointer: "/summary", items_pointer: "/items" },
      defaults: { surface: "task", importance: "primary", density: "detail", persistence: "session" },
    })],
    ["ui/views/card.v1.json", json({
      renderer_version: 1,
      type: "card",
      title_pointer: "/title",
      subtitle_pointer: "/summary",
      empty_message: "No details yet.",
      sections: [{
        id: "items",
        type: "list",
        label: "Items",
        pointer: "/items",
        item_title_pointer: "",
        max_items: 16,
      }],
    })],
    ["skills/compose-card/SKILL.md", `---\nname: compose-card\ndescription: Create and revise the complete ${name} card.\n---\n\n# ${name}\n\nUse the current qualified Tool for \`${pluginId}:upsert_card\`. Reuse a stable id such as \`${pluginId}:current\` and send the complete current card. Never route around a missing Tool with a generic Widget.\n`],
    ["fixtures/basic.json", json({
      tool: "upsert_card",
      arguments: {
        id: `${pluginId}:current`,
        title: `${name} example`,
        summary: "Generated by the HomeRail plugin scaffold.",
        items: ["Validate", "Pack", "Install"],
      },
      expect: { title: `${name} example` },
    })],
    ["README.md", `# ${name}\n\nGenerated with \`hr plugin init ${pluginId}\`.\n`],
  ]);
  const packageFiles = new Map([...files.entries()]
    .filter(([relativePath]) => relativePath !== "README.md" && !relativePath.startsWith("fixtures/"))
    .map(([relativePath, content]) => [relativePath, Buffer.from(content, "utf8")]));
  const validation = validatePluginFiles(packageFiles);
  if (!validation.valid || !validation.m4_data_only_eligible) {
    throw new Error(`Generated plugin scaffold is invalid: ${JSON.stringify(validation.issues)}`);
  }

  const parent = path.dirname(root);
  fs.mkdirSync(parent, { recursive: true });
  const staging = fs.mkdtempSync(path.join(parent, `.${path.basename(root)}.homerail-scaffold-`));
  let removedEmptyDestination = false;
  try {
    for (const [relativePath, content] of files) {
      const target = path.join(staging, ...relativePath.split("/"));
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, content, { encoding: "utf8", flag: "wx" });
    }
    if (rootExisted) {
      fs.rmdirSync(root);
      removedEmptyDestination = true;
    }
    fs.renameSync(staging, root);
  } catch (cause) {
    fs.rmSync(staging, { recursive: true, force: true });
    if (removedEmptyDestination && !fs.existsSync(root)) fs.mkdirSync(root, { recursive: true });
    throw cause;
  }
  return { root, files: [...files.keys()].sort() };
}
