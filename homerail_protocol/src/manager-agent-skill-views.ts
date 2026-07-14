/**
 * Manager Agent Skill visual template contract.
 * @version 0.1.0
 */

import {
  validateHomerailA2uiSurface,
  type HomerailA2uiSurfaceV1,
} from "./generative-ui/index.js";
import { validateHomerailPluginToolInput } from "./plugins/projection.js";

export type ManagerAgentSkillViewSurfaceV1 = "task" | "execution" | "result" | "ambient";
export type ManagerAgentSkillViewImportanceV1 = "critical" | "primary" | "secondary" | "ambient";
export type ManagerAgentSkillViewDensityV1 = "glance" | "summary" | "detail";
export type ManagerAgentSkillViewCanvasSizeV1 = "1x1" | "1x2" | "2x2" | "3x3";
export type ManagerAgentSkillViewPersistenceV1 = "turn" | "session" | "project";

export interface ManagerAgentSkillViewDefaultsV1 {
  surface: ManagerAgentSkillViewSurfaceV1;
  importance: ManagerAgentSkillViewImportanceV1;
  density: ManagerAgentSkillViewDensityV1;
  canvas_size: ManagerAgentSkillViewCanvasSizeV1;
  persistence: ManagerAgentSkillViewPersistenceV1;
}

/** A trusted visual grammar shipped beside one selected local Skill. */
export interface ManagerAgentSkillViewTemplateV1 {
  id: string;
  description: string;
  data_schema: Record<string, unknown>;
  a2ui: HomerailA2uiSurfaceV1;
  defaults: ManagerAgentSkillViewDefaultsV1;
  allowed_canvas_sizes?: ManagerAgentSkillViewCanvasSizeV1[];
}

export interface ManagerAgentSkillViewToolDefinitionV1 {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
  skill_id: string;
  template: ManagerAgentSkillViewTemplateV1;
}

export interface ManagerAgentSkillWithViewsV1 {
  id: string;
  content?: string;
  view_templates?: ManagerAgentSkillViewTemplateV1[];
}

function toolSlug(value: string, maxLength: number): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/[^a-z0-9_-]+/g, "_")
    .replace(/^[_-]+|[_-]+$/g, "")
    .slice(0, maxLength) || "view";
}

function stableToolSuffix(value: string): string {
  let hash = 0x811c9dc5;
  for (const character of value) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

export function managerAgentSkillViewToolName(skillId: string, templateId: string): string {
  const identity = `${skillId}\0${templateId}`;
  return `skill_view_${toolSlug(skillId, 16)}_${toolSlug(templateId, 20)}_${stableToolSuffix(identity)}`;
}

function canvasSizes(template: ManagerAgentSkillViewTemplateV1): ManagerAgentSkillViewCanvasSizeV1[] {
  const values = template.allowed_canvas_sizes?.length
    ? template.allowed_canvas_sizes
    : [template.defaults.canvas_size];
  return Array.from(new Set(values));
}

function templateToolInputSchema(template: ManagerAgentSkillViewTemplateV1): Record<string, unknown> {
  const dataSchema = structuredClone(template.data_schema);
  const definitions = dataSchema.definitions;
  delete dataSchema.definitions;
  const allowedSizes = canvasSizes(template);
  return {
    type: "object",
    properties: {
      id: {
        type: "string",
        minLength: 1,
        maxLength: 200,
        description: "Stable Block id. Reuse the selected full id when updating an existing Block.",
      },
      data: dataSchema,
      canvas_size: {
        type: "string",
        enum: allowedSizes,
        description: `Optional footprint override; defaults to ${template.defaults.canvas_size}.`,
      },
    },
    required: ["id", "data"],
    additionalProperties: false,
    ...(definitions && typeof definitions === "object" && !Array.isArray(definitions)
      ? { definitions: structuredClone(definitions) }
      : {}),
  };
}

export function managerAgentSkillViewToolDefinitions(
  skills: readonly ManagerAgentSkillWithViewsV1[],
): ManagerAgentSkillViewToolDefinitionV1[] {
  const definitions: ManagerAgentSkillViewToolDefinitionV1[] = [];
  const names = new Set<string>();
  for (const skill of skills) {
    if (!skill.content?.trim()) continue;
    for (const template of skill.view_templates ?? []) {
      const name = managerAgentSkillViewToolName(skill.id, template.id);
      if (names.has(name)) throw new Error(`Skill view Tool name collision: ${name}`);
      names.add(name);
      definitions.push({
        name,
        description: [
          `Render or update the selected ${skill.id} result with its validated '${template.id}' visual template.`,
          template.description,
          "Provide semantic data only; HomeRail owns the layout. data.title is used as the Block title.",
          "HomeRail A2UI formatString accepts only ${/absolute/pointer} and template-relative ${pointer} interpolation; escape a literal opener as \\${. Nested functions and other expressions are rejected.",
          "Reuse the current selected Block id for follow-up updates. When this schema matches, use this Tool; the raw generated-view Tool rejects matching data so HomeRail can preserve this layout.",
        ].join(" "),
        input_schema: templateToolInputSchema(template),
        skill_id: skill.id,
        template,
      });
    }
  }
  return definitions;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

/**
 * Detects when a raw generated-view submission is carrying data already owned
 * by a loaded Skill template. Callers can reject that raw submission and make
 * the model use the trusted template Tool instead of recreating its layout.
 */
export function matchingManagerAgentSkillViewToolDefinition(
  definitions: readonly ManagerAgentSkillViewToolDefinitionV1[],
  generatedViewInput: Record<string, unknown>,
): ManagerAgentSkillViewToolDefinitionV1 | undefined {
  const content = record(generatedViewInput.content);
  const data = record(content?.data);
  const id = typeof generatedViewInput.id === "string" ? generatedViewInput.id.trim() : "";
  if (!id || !data) return undefined;
  const candidate = { id, data };
  return definitions.find((definition) =>
    validateHomerailPluginToolInput(definition.input_schema, candidate).valid
  );
}

function validationMessage(errors: Array<{ path?: string; message?: string }>): string {
  return errors
    .slice(0, 4)
    .map((error) => `${error.path || "/"} ${error.message || "is invalid"}`)
    .join("; ");
}

export function materializeManagerAgentSkillViewInput(
  definition: ManagerAgentSkillViewToolDefinitionV1,
  input: Record<string, unknown>,
): Record<string, unknown> {
  const validation = validateHomerailPluginToolInput(definition.input_schema, input);
  if (!validation.valid || !validation.value) {
    throw new Error(`Skill view input is invalid: ${validationMessage(validation.errors)}`);
  }
  const data = validation.value.data as Record<string, unknown>;
  const title = typeof data.title === "string" ? data.title.trim() : "";
  if (!title) throw new Error("Skill view data.title must be a non-empty string");
  const summary = typeof data.summary === "string" ? data.summary.trim() : "";
  const content = { data };
  const a2uiValidation = validateHomerailA2uiSurface(definition.template.a2ui, {
    action_ids: new Set(),
    data_model: content,
  });
  if (!a2uiValidation.valid || !a2uiValidation.value) {
    throw new Error(`Skill A2UI surface is invalid: ${validationMessage(a2uiValidation.errors)}`);
  }
  return {
    id: validation.value.id,
    title,
    ...(summary ? { summary } : {}),
    surface: definition.template.defaults.surface,
    importance: definition.template.defaults.importance,
    density: definition.template.defaults.density,
    canvas_size: validation.value.canvas_size ?? definition.template.defaults.canvas_size,
    persistence: definition.template.defaults.persistence,
    content,
    a2ui: structuredClone(a2uiValidation.value),
  };
}
