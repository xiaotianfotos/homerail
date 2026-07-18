/**
 * Manager Agent Skill visual template contract.
 * @version 0.1.0
 */

import {
  validateHomerailA2uiSurface,
  type HomerailA2uiSurfaceV1,
} from "./generative-ui/index.js";
import { validateHomerailPluginToolInput } from "./plugins/projection.js";
import type { AgentToolDefinition } from "./types.js";

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

export const MANAGER_AGENT_SKILL_VIEW_RENDER_TOOL_NAME = "skill_view_render";
export const MANAGER_AGENT_SKILL_VIEW_PRESENT_TOOL_NAME = "skill_view_present";

export function managerAgentSkillViewPresentToolDefinition(): AgentToolDefinition {
  return {
    name: MANAGER_AGENT_SKILL_VIEW_PRESENT_TOOL_NAME,
    description: [
      "Run the trusted presenter shipped by an enabled local HomeRail Skill and publish its validated visual or start its supervised DAG in one call.",
      "Use this instead of a native shell when the Skill gives a present command; pass only the argv tokens after the Skill's trusted base command.",
      "Example: a Skill instruction 'present route A B --limit 4' becomes {skill_id:'catalog', argv:['present','route','A','B','--limit','4']}.",
      "HomeRail executes without a shell. Visual results are validated and committed; supervised DAG results may load only Workflow/Profile assets inside that Skill before the run starts.",
      "After success, use the returned response_text as the short final answer; do not call skill_view_render or start_supervised_dag again.",
    ].join(" "),
    input_schema: {
      type: "object",
      properties: {
        skill_id: {
          type: "string",
          minLength: 1,
          maxLength: 200,
          description: "Enabled local Skill id that owns the trusted presenter and view templates.",
        },
        argv: {
          type: "array",
          minItems: 1,
          maxItems: 32,
          items: {
            type: "string",
            minLength: 1,
            maxLength: 512,
          },
          description: "Presenter arguments exactly as specified by the loaded Skill, excluding its trusted base command.",
        },
      },
      required: ["skill_id", "argv"],
      additionalProperties: false,
    },
  };
}

export interface ManagerAgentSkillSupervisedDagLaunchV1 {
  workflow_id: string;
  prompt: string;
  workflow_revision: number;
  canonical_hash: string;
  profile?: string;
  profile_updated_at?: string;
}

export function normalizeManagerAgentSkillSupervisedDagLaunch(
  value: Record<string, unknown>,
): ManagerAgentSkillSupervisedDagLaunchV1 | undefined {
  if (value.mode !== "supervised_dag") return undefined;
  const launch = record(value.launch);
  const workflowId = typeof launch?.workflow_id === "string" ? launch.workflow_id.trim() : "";
  const prompt = typeof launch?.prompt === "string" ? launch.prompt : "";
  const profile = typeof launch?.profile === "string" ? launch.profile.trim() : "";
  const workflowRevision = Number(launch?.workflow_revision);
  const canonicalHash = typeof launch?.canonical_hash === "string" ? launch.canonical_hash.trim() : "";
  const profileUpdatedAt = typeof launch?.profile_updated_at === "string" ? launch.profile_updated_at.trim() : "";
  if (
    !workflowId
    || workflowId.length > 200
    || !prompt.trim()
    || prompt.length > 24_000
    || !Number.isSafeInteger(workflowRevision)
    || workflowRevision < 1
    || !/^[a-f0-9]{64}$/.test(canonicalHash)
    || profile.length > 200
    || Boolean(profile) !== Boolean(profileUpdatedAt)
  ) {
    throw new Error("Manager returned an invalid supervised Skill DAG launch");
  }
  return {
    workflow_id: workflowId,
    prompt,
    workflow_revision: workflowRevision,
    canonical_hash: canonicalHash,
    ...(profile ? { profile } : {}),
    ...(profileUpdatedAt ? { profile_updated_at: profileUpdatedAt } : {}),
  };
}

export function compactManagerAgentSkillSupervisedDagResult(
  result: Record<string, unknown>,
  launch: ManagerAgentSkillSupervisedDagLaunchV1,
  responseText = "",
): Record<string, unknown> {
  const data = record(result.data) ?? result;
  const runId = typeof data.run_id === "string" && data.run_id.trim()
    ? data.run_id.trim()
    : typeof data.runId === "string" && data.runId.trim()
      ? data.runId.trim()
      : "";
  if (!runId) throw new Error("Manager did not return a supervised DAG run id");
  const normalizedResponse = responseText.trim();
  return {
    mode: "supervised_dag",
    run_id: runId,
    workflow_id: launch.workflow_id,
    workflow_revision: launch.workflow_revision,
    canonical_hash: launch.canonical_hash,
    ...(launch.profile ? { profile: launch.profile } : {}),
    ...(normalizedResponse ? { response_text: normalizedResponse } : {}),
  };
}

export function managerAgentSkillViewRenderToolDefinition(): AgentToolDefinition {
  return {
    name: MANAGER_AGENT_SKILL_VIEW_RENDER_TOOL_NAME,
    description: [
      "Render or update a validated visual template owned by an enabled local HomeRail Skill.",
      "Use the skill_id and template_id returned by the natively loaded Skill or its presenter,",
      "and pass the presenter's semantic data unchanged. HomeRail owns and validates the A2UI layout.",
      "A presenter result with template, id, and data is incomplete until this Tool succeeds.",
      "Example: presenter {template:'route', id:'route-1', canvas_size:'1x2', data:X} from Skill 'catalog' becomes {skill_id:'catalog', template_id:'route', id:'route-1', canvas_size:'1x2', data:X}.",
      "Do not answer it as Markdown or copy A2UI into the raw generated-view Tool.",
    ].join(" "),
    input_schema: {
      type: "object",
      properties: {
        skill_id: {
          type: "string",
          minLength: 1,
          maxLength: 200,
          description: "Enabled local Skill id, for example the id shown in the HomeRail Skill catalog.",
        },
        template_id: {
          type: "string",
          pattern: "^[a-z0-9][a-z0-9_-]{0,63}$",
          description: "Stable template id returned by the Skill presenter.",
        },
        id: {
          type: "string",
          minLength: 1,
          maxLength: 200,
          description: "Stable Block id. Reuse it for follow-up updates.",
        },
        data: {
          type: "object",
          maxProperties: 128,
          additionalProperties: true,
          description: "Semantic presenter data. Do not add, remove, recompute, or rearrange its fields.",
        },
        canvas_size: {
          type: "string",
          enum: ["1x1", "1x2", "2x2", "3x3"],
          description: "Optional footprint override allowed by the selected template.",
        },
      },
      required: ["skill_id", "template_id", "id", "data"],
      additionalProperties: false,
    },
  };
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

function skillViewToolDefinition(
  skillId: string,
  template: ManagerAgentSkillViewTemplateV1,
): ManagerAgentSkillViewToolDefinitionV1 {
  return {
    name: managerAgentSkillViewToolName(skillId, template.id),
    description: [
      `Render or update the selected ${skillId} result with its validated '${template.id}' visual template.`,
      template.description,
      "Provide semantic data only; HomeRail owns the layout. data.title is used as the Block title.",
      "HomeRail A2UI formatString accepts only ${/absolute/pointer} and template-relative ${pointer} interpolation; escape a literal opener as \\${. Nested functions and other expressions are rejected.",
      "Reuse the current selected Block id for follow-up updates. When this schema matches, use this Tool; the raw generated-view Tool rejects matching data so HomeRail can preserve this layout.",
    ].join(" "),
    input_schema: templateToolInputSchema(template),
    skill_id: skillId,
    template,
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
      const definition = skillViewToolDefinition(skill.id, template);
      const name = definition.name;
      if (names.has(name)) throw new Error(`Skill view Tool name collision: ${name}`);
      names.add(name);
      definitions.push(definition);
    }
  }
  return definitions;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

export function compactManagerAgentSkillViewPresentResult(
  pluginResult: Record<string, unknown>,
  responseText = "",
): Record<string, unknown> {
  const normalizedResponse = responseText.trim();
  const projected = record(pluginResult.projection);
  const projectedNode = record(projected?.node);
  if (
    pluginResult.execution_version === 1
    && pluginResult.status === "projected"
    && pluginResult.committed === false
    && typeof projectedNode?.id === "string"
  ) {
    return {
      execution_version: 1,
      status: "projected",
      committed: false,
      node_id: projectedNode.id,
      ...(normalizedResponse ? { response_text: normalizedResponse } : {}),
    };
  }
  const data = record(pluginResult.data) ?? pluginResult;
  const result = record(data.result);
  const revision = Number(result?.document_revision);
  if (
    data.status !== "committed"
    || result?.output_type !== "ui_transaction"
    || typeof result.document_id !== "string"
    || !Number.isSafeInteger(revision)
    || revision < 1
  ) throw new Error("Generated view Tool returned an invalid committed result");
  return {
    success: pluginResult.success !== false,
    data: {
      status: "committed",
      result: {
        output_type: "ui_transaction",
        document_id: result.document_id,
        document_revision: revision,
      },
      ...(normalizedResponse ? { response_text: normalizedResponse } : {}),
    },
  };
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

export function materializeManagerAgentSkillViewTemplateInput(
  skillId: string,
  template: ManagerAgentSkillViewTemplateV1,
  input: Record<string, unknown>,
): Record<string, unknown> {
  return materializeManagerAgentSkillViewInput(
    skillViewToolDefinition(skillId, template),
    input,
  );
}
