import {
  DAG_ACTOR_SURFACE_PATCH_MAX_BYTES,
  DAG_ACTOR_SURFACE_PATCH_MAX_COMPONENTS,
  DAG_ACTOR_SURFACE_PATCH_PHASES,
  DAG_ACTOR_SURFACE_PATCH_SCHEMA_VERSION,
  DAG_ACTOR_SURFACE_PATCH_V1_SCHEMA_ID,
  HOMERAIL_A2UI_CATALOG_ID,
  HOMERAIL_A2UI_VERSION,
  analyzeGenerativeUiJsonValue,
  redactTelemetry,
  validateDagActorSurfacePatchV1,
  type DagActorSurfaceBodyV1,
  type DagActorSurfacePatchPhaseV1,
  type DagActorSurfacePatchV1,
} from "homerail-protocol";
import type { DagToolDefinition } from "../agent/types.js";
import type { DagToolsState } from "./index.js";

export const REPORT_SURFACE_STATE_TOOL_NAME = "report_surface_state" as const;
export const DAG_ACTOR_SURFACE_PATCH_V1_CAPABILITY = DAG_ACTOR_SURFACE_PATCH_V1_SCHEMA_ID;

export const MAX_SURFACE_PATCH_BODY_BYTES = 56 * 1024;
export const MAX_SURFACE_PATCH_BYTES = DAG_ACTOR_SURFACE_PATCH_MAX_BYTES;
export const MAX_SURFACE_PATCH_COMPONENTS = DAG_ACTOR_SURFACE_PATCH_MAX_COMPONENTS;

const PATCH_ID_PATTERN = /^(?!\s*$)[^\u0000-\u001F\u007F]{1,256}$/u;
const MAX_REDACTION_DEPTH = 8;
const MAX_REDACTION_COLLECTION_SIZE = 100;
const MAX_REDACTION_STRING_LENGTH = 4_000;

/** The protocol validator applies the same passive catalog authoritatively. */
export const PASSIVE_A2UI_COMPONENTS = [
  "Text",
  "Image",
  "Icon",
  "Video",
  "AudioPlayer",
  "Row",
  "Column",
  "List",
  "Card",
  "Tabs",
  "Divider",
  "HrGrid",
  "HrGridItem",
  "HrSection",
  "HrMetric",
  "HrStatusBadge",
  "HrProgress",
  "HrStep",
  "HrList",
  "HrTable",
  "HrTimeline",
  "HrBarChart",
  "HrDag",
  "HrDisclosure",
  "HrLink",
  "HrArtifact",
  "HrIf",
] as const;

const IDENTITY_KEYS = new Set([
  "schema_version",
  "run_id", "runId",
  "node_id", "nodeId",
  "session_id", "sessionId",
  "round_id", "roundId",
  "actor_id", "actorId",
  "generation",
  "lease_generation", "leaseGeneration",
  "surface_id", "surfaceId", "surface",
  "timestamp",
]);
const TOOL_INPUT_KEYS = new Set(["patch_id", "patch_sequence", "phase", "op", "body"]);
const EXECUTABLE_A2UI_FIELD_NAMES = [
  "action",
  "actions",
  "functionCall",
  "function_call",
  "html",
  "onClick",
  "onSubmit",
  "script",
  "srcdoc",
] as const;
const EXECUTABLE_A2UI_KEYS = new Set<string>(EXECUTABLE_A2UI_FIELD_NAMES);

export interface DagActorSurfacePatchProposalV1 {
  /** Projector routing identity locked from the dispatch, not model input. */
  surface_id: string;
  patch: DagActorSurfacePatchV1;
}

export type SurfacePatchEmitter = (proposal: DagActorSurfacePatchProposalV1) => void;

export const REPORT_SURFACE_STATE_PROMPT = [
  "RICH SURFACE REPORTING CAPABILITY.",
  "report_surface_state submits a bounded passive A2UI proposal for this Actor's existing Surface; it never mutates the Canvas directly.",
  "Use op=replace_body with body.a2ui, body.data, and body.fallback. Keep component ids stable across patch_sequence revisions; use clear_body only to remove the proposed body.",
  "A2UI data bindings must stay under /actor_view/data, which resolves against body.data.",
  "Always provide a readable fallback for replace_body. Image, Video, AudioPlayer, metrics, comparisons, routes/DAGs, and timelines are allowed passive expressions.",
  "Button, form/input components, arbitrary HTML, scripts, action fields, and function actions are forbidden.",
  "Run, node, session, round, actor, generation, lease, surface, schema, and timestamp identity are injected and locked by the Worker; never include them in tool arguments.",
  "A submitted result means Manager validation is pending. It never means a Surface revision was applied.",
].join("\n");

const componentSchema = {
  type: "object",
  properties: {
    id: { type: "string", minLength: 1, maxLength: 128 },
    component: { type: "string", enum: [...PASSIVE_A2UI_COMPONENTS] },
  },
  required: ["id", "component"],
  propertyNames: { not: { enum: [...EXECUTABLE_A2UI_FIELD_NAMES] } },
  allOf: [{
    not: {
      properties: {
        component: { const: "HrArtifact" },
        kind: { const: "html" },
      },
      required: ["component", "kind"],
    },
  }],
  additionalProperties: true,
} as const;

const fallbackSchema = {
  type: "object",
  properties: {
    title: { type: "string", minLength: 1, maxLength: 200 },
    summary: { type: "string", maxLength: 4_000 },
    items: { type: "array", maxItems: 16, items: { type: "string", maxLength: 500 } },
    artifact_refs: {
      type: "array",
      maxItems: 16,
      items: {
        type: "object",
        properties: {
          label: { type: "string", minLength: 1, maxLength: 200 },
          uri: { type: "string", minLength: 1, maxLength: 2_048 },
          media_type: { type: "string", minLength: 1, maxLength: 160 },
        },
        required: ["label", "uri"],
        additionalProperties: false,
      },
    },
  },
  required: ["title"],
  additionalProperties: false,
} as const;

const bodySchema = {
  type: "object",
  properties: {
    a2ui: {
      type: "object",
      properties: {
        version: { const: HOMERAIL_A2UI_VERSION },
        catalogId: { const: HOMERAIL_A2UI_CATALOG_ID },
        components: {
          type: "array",
          minItems: 1,
          maxItems: MAX_SURFACE_PATCH_COMPONENTS,
          items: componentSchema,
        },
      },
      required: ["version", "catalogId", "components"],
      additionalProperties: false,
    },
    data: {
      type: "object",
      maxProperties: MAX_REDACTION_COLLECTION_SIZE,
      additionalProperties: true,
    },
    fallback: fallbackSchema,
    presentation_hint: {
      type: "object",
      properties: {
        density: { type: "string", enum: ["glance", "summary", "detail"] },
        canvas_size: { type: "string", enum: ["1x1", "1x2", "2x2", "3x3"] },
        preferred_visual: { type: "string", minLength: 1, maxLength: 120 },
      },
      additionalProperties: false,
    },
  },
  required: ["a2ui", "data", "fallback"],
  additionalProperties: false,
} as const;

export const REPORT_SURFACE_STATE_INPUT_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    patch_id: {
      type: "string",
      minLength: 1,
      maxLength: 256,
      pattern: "^(?!\\s*$)[^\\u0000-\\u001F\\u007F]+$",
      description: "Unique proposal id within this Actor generation.",
    },
    patch_sequence: {
      type: "integer",
      minimum: 1,
      maximum: Number.MAX_SAFE_INTEGER,
      description: "Next contiguous body revision for this Actor generation.",
    },
    phase: { type: "string", enum: [...DAG_ACTOR_SURFACE_PATCH_PHASES] },
    op: { type: "string", enum: ["replace_body", "clear_body"] },
    body: bodySchema,
  },
  required: ["patch_id", "patch_sequence", "phase", "op"],
  oneOf: [
    {
      properties: { op: { const: "replace_body" } },
      required: ["body"],
    },
    {
      properties: { op: { const: "clear_body" } },
      not: { required: ["body"] },
    },
  ],
  additionalProperties: false,
};

interface RejectionDetails {
  expected_patch_sequence?: number;
  issues?: string[];
}

function rejected(code: string, message: string, details: RejectionDetails = {}) {
  return {
    content: [{
      type: "text" as const,
      text: JSON.stringify({ status: "rejected", code, message, ...details }),
    }],
    is_error: true,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function unexpectedKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): string[] {
  return Object.keys(value).filter((key) => !allowed.has(key));
}

function redactionStableShapeError(value: unknown, depth = 0, path = "body"): string | undefined {
  if (depth > MAX_REDACTION_DEPTH) return `${path} exceeds redaction depth ${MAX_REDACTION_DEPTH}`;
  if (typeof value === "string" && value.length > MAX_REDACTION_STRING_LENGTH) {
    return `${path} exceeds redaction string limit ${MAX_REDACTION_STRING_LENGTH}`;
  }
  if (Array.isArray(value)) {
    if (value.length > MAX_REDACTION_COLLECTION_SIZE) {
      return `${path} exceeds redaction collection limit ${MAX_REDACTION_COLLECTION_SIZE}`;
    }
    for (const [index, entry] of value.entries()) {
      const issue = redactionStableShapeError(entry, depth + 1, `${path}/${index}`);
      if (issue) return issue;
    }
    return undefined;
  }
  if (isRecord(value)) {
    const entries = Object.entries(value);
    if (entries.length > MAX_REDACTION_COLLECTION_SIZE) {
      return `${path} exceeds redaction collection limit ${MAX_REDACTION_COLLECTION_SIZE}`;
    }
    for (const [key, entry] of entries) {
      const issue = redactionStableShapeError(entry, depth + 1, `${path}/${key}`);
      if (issue) return issue;
    }
  }
  return undefined;
}

function executableA2uiField(value: unknown, path = "body/a2ui"): string | undefined {
  if (Array.isArray(value)) {
    for (const [index, entry] of value.entries()) {
      const issue = executableA2uiField(entry, `${path}/${index}`);
      if (issue) return issue;
    }
    return undefined;
  }
  if (!isRecord(value)) return undefined;
  for (const [key, entry] of Object.entries(value)) {
    if (EXECUTABLE_A2UI_KEYS.has(key)) return `${path}/${key}`;
    const issue = executableA2uiField(entry, `${path}/${key}`);
    if (issue) return issue;
  }
  return undefined;
}

function protocolIssues(patch: unknown): string[] {
  return validateDagActorSurfacePatchV1(patch).errors
    .slice(0, 5)
    .map((error) => `${error.path || "/"}: ${error.message}`);
}

interface LockedIdentity {
  run_id: string;
  node_id: string;
  session_id: string;
  round_id: string;
  actor_id: string;
  generation: number;
  lease_generation: number;
  surface_id: string;
}

function lockedIdentity(state: DagToolsState): LockedIdentity | undefined {
  if (!state.runId.trim() || !state.nodeId.trim() || !state.sessionId.trim()
    || !state.roundId?.trim() || !state.actorId?.trim() || !state.surfaceId?.trim()
    || !Number.isSafeInteger(state.generation) || (state.generation ?? 0) < 1
    || !Number.isSafeInteger(state.leaseGeneration) || (state.leaseGeneration ?? 0) < 1) {
    return undefined;
  }
  return {
    run_id: state.runId,
    node_id: state.nodeId,
    session_id: state.sessionId,
    round_id: state.roundId,
    actor_id: state.actorId,
    generation: state.generation as number,
    lease_generation: state.leaseGeneration as number,
    surface_id: state.surfaceId,
  };
}

export function createReportSurfaceStateTool(
  state: DagToolsState,
  emit: SurfacePatchEmitter,
): DagToolDefinition {
  return {
    name: REPORT_SURFACE_STATE_TOOL_NAME,
    description: [
      "Submit a bounded passive A2UI body and readable fallback for this Actor's stable Surface.",
      "The Worker injects immutable run/node/session/round/actor/generation/lease/surface identity and timestamp.",
      "This is a proposal to the Manager projector, never a direct Canvas mutation; submitted does not mean applied.",
    ].join(" "),
    input_schema: REPORT_SURFACE_STATE_INPUT_SCHEMA,
    async handler(args: Record<string, unknown>) {
      if (!isRecord(args)) {
        return rejected("invalid_arguments", "tool arguments must be an object", {
          expected_patch_sequence: state.surfacePatchSequence + 1,
        });
      }
      const extras = unexpectedKeys(args, TOOL_INPUT_KEYS);
      if (extras.length) {
        const identitySpoof = extras.some((key) => IDENTITY_KEYS.has(key));
        return rejected(
          identitySpoof ? "identity_spoof" : "invalid_arguments",
          identitySpoof
            ? `identity is Worker-owned and cannot be supplied: ${extras.join(", ")}`
            : `unsupported tool fields: ${extras.join(", ")}`,
          { expected_patch_sequence: state.surfacePatchSequence + 1 },
        );
      }

      const identity = lockedIdentity(state);
      if (!identity) {
        return rejected(
          "identity_unavailable",
          "dispatch is missing a locked round, actor, generation, lease, or surface identity",
          { expected_patch_sequence: state.surfacePatchSequence + 1 },
        );
      }

      const patchId = typeof args.patch_id === "string" ? args.patch_id.trim() : "";
      if (!PATCH_ID_PATTERN.test(patchId)) {
        return rejected("invalid_patch_id", "patch_id must be a bounded opaque identifier", {
          expected_patch_sequence: state.surfacePatchSequence + 1,
        });
      }
      if (state.surfacePatchIds.has(patchId)) {
        return rejected("duplicate_patch_id", "patch_id was already submitted in this Actor generation", {
          expected_patch_sequence: state.surfacePatchSequence + 1,
        });
      }

      const expectedSequence = state.surfacePatchSequence + 1;
      if (!Number.isSafeInteger(args.patch_sequence) || Number(args.patch_sequence) !== expectedSequence) {
        return rejected("sequence_conflict", `patch_sequence must equal ${expectedSequence}`, {
          expected_patch_sequence: expectedSequence,
        });
      }
      if (!DAG_ACTOR_SURFACE_PATCH_PHASES.includes(args.phase as DagActorSurfacePatchPhaseV1)) {
        return rejected("invalid_phase", `phase must be one of ${DAG_ACTOR_SURFACE_PATCH_PHASES.join(", ")}`, {
          expected_patch_sequence: expectedSequence,
        });
      }
      if (args.op !== "replace_body" && args.op !== "clear_body") {
        return rejected("invalid_operation", "op must be replace_body or clear_body", {
          expected_patch_sequence: expectedSequence,
        });
      }
      if (args.op === "clear_body" && args.body !== undefined) {
        return rejected("invalid_body", "clear_body must not include body", {
          expected_patch_sequence: expectedSequence,
        });
      }
      if (args.op === "replace_body" && !isRecord(args.body)) {
        return rejected("invalid_body", "replace_body requires an object body", {
          expected_patch_sequence: expectedSequence,
        });
      }

      const replaceBody = args.op === "replace_body"
        ? args.body as Record<string, unknown>
        : undefined;
      if (args.op === "replace_body") {
        const shapeIssue = redactionStableShapeError(replaceBody);
        if (shapeIssue) {
          return rejected("payload_budget", shapeIssue, { expected_patch_sequence: expectedSequence });
        }
        const bodyAnalysis = analyzeGenerativeUiJsonValue(replaceBody, {
          path: "/body",
          limits: {
            max_depth: MAX_REDACTION_DEPTH,
            max_values: 4_000,
            max_bytes: MAX_SURFACE_PATCH_BODY_BYTES,
          },
        });
        if (!bodyAnalysis.valid) {
          return rejected(
            "payload_budget",
            bodyAnalysis.error?.message ?? "body exceeds its JSON budget",
            { expected_patch_sequence: expectedSequence },
          );
        }
        const executable = executableA2uiField(replaceBody?.a2ui);
        if (executable) {
          return rejected("active_content", `passive A2UI cannot contain executable field ${executable}`, {
            expected_patch_sequence: expectedSequence,
          });
        }
      }

      const timestamp = Date.now();
      const patchBase = {
        schema_version: DAG_ACTOR_SURFACE_PATCH_SCHEMA_VERSION,
        run_id: identity.run_id,
        node_id: identity.node_id,
        session_id: identity.session_id,
        round_id: identity.round_id,
        actor_id: identity.actor_id,
        generation: identity.generation,
        lease_generation: identity.lease_generation,
        patch_id: patchId,
        patch_sequence: expectedSequence,
        timestamp,
        phase: args.phase as DagActorSurfacePatchPhaseV1,
      };
      const rawPatch: DagActorSurfacePatchV1 = args.op === "clear_body"
        ? { ...patchBase, op: "clear_body" as const }
        : {
            ...patchBase,
            op: "replace_body" as const,
            body: structuredClone(replaceBody) as unknown as DagActorSurfaceBodyV1,
          };
      const rawIssues = protocolIssues(rawPatch);
      if (rawIssues.length) {
        return rejected("invalid_patch", "proposal failed the Actor Surface protocol", {
          expected_patch_sequence: expectedSequence,
          issues: rawIssues,
        });
      }

      const patch: DagActorSurfacePatchV1 = args.op === "clear_body"
        ? rawPatch
        : {
            ...patchBase,
            op: "replace_body",
            body: redactTelemetry(replaceBody) as DagActorSurfaceBodyV1,
          };
      const redactedIssues = protocolIssues(patch);
      if (redactedIssues.length) {
        return rejected("redaction_invalid", "redaction made the proposal protocol-invalid", {
          expected_patch_sequence: expectedSequence,
          issues: redactedIssues,
        });
      }

      try {
        emit({ surface_id: identity.surface_id, patch });
      } catch {
        return rejected("transport_rejected", "Worker could not submit the proposal to Manager transport", {
          expected_patch_sequence: expectedSequence,
        });
      }
      state.surfacePatchSequence = expectedSequence;
      state.surfacePatchIds.add(patchId);
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            status: "submitted",
            patch_id: patchId,
            patch_sequence: expectedSequence,
            surface_id: identity.surface_id,
            manager_validation: "pending",
            canvas_mutated: false,
          }),
        }],
      };
    },
  };
}
