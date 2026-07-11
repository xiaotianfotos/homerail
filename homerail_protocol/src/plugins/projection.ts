import AjvModule, { type ErrorObject } from "ajv";
import {
  GENERATIVE_UI_IR_VERSION,
  GenerativeUiActorType,
  analyzeGenerativeUiJsonValue,
  validateGenerativeUiNode,
} from "../generative-ui/index.js";
import {
  validateHomerailDirectUiProjection,
  validateHomerailPluginToolExecutionEnvelope,
} from "./validation.js";
import type {
  HomerailDirectUiProjectionResultV1,
  HomerailDirectUiProjectionV1,
  HomerailPluginValidationError,
  HomerailPluginValidationResult,
  HomerailPluginToolDescriptorV1,
  HomerailPluginToolExecutionEnvelopeV1,
} from "./types.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const AjvClass = (AjvModule as any).default || AjvModule;

function normalizedAjvErrors(errors: ErrorObject[] | null | undefined): HomerailPluginValidationError[] {
  return (errors ?? []).map((entry) => ({
    path: entry.instancePath || "",
    message: entry.message || "Tool input is invalid",
    keyword: entry.keyword || "toolInputSchema",
  }));
}

export function validateHomerailPluginToolInput(
  schema: Record<string, unknown>,
  value: unknown,
): HomerailPluginValidationResult<Record<string, unknown>> {
  const analysis = analyzeGenerativeUiJsonValue(value, {
    limits: { max_bytes: 128 * 1024, max_depth: 32, max_values: 100_000 },
  });
  if (!analysis.valid) {
    return { valid: false, errors: [analysis.error ?? { path: "", message: "invalid Tool input", keyword: "jsonValue" }] };
  }
  let stable: unknown;
  try {
    stable = structuredClone(value);
  } catch {
    return { valid: false, errors: [{ path: "", message: "Tool input could not be snapshotted", keyword: "jsonSnapshot" }] };
  }
  if (!stable || typeof stable !== "object" || Array.isArray(stable)) {
    return { valid: false, errors: [{ path: "", message: "Tool input must be an object", keyword: "type" }] };
  }
  try {
    const ajv = new AjvClass({ allErrors: true, strict: false, coerceTypes: false });
    const validate = ajv.compile(schema);
    if (!validate(stable)) return { valid: false, errors: normalizedAjvErrors(validate.errors) };
  } catch {
    return { valid: false, errors: [{ path: "", message: "Tool input schema failed safely", keyword: "toolInputSchema" }] };
  }
  return { valid: true, value: stable as Record<string, unknown>, errors: [] };
}

function decodePointerSegment(value: string): string {
  return value.replace(/~1/g, "/").replace(/~0/g, "~");
}

function pointer(value: unknown, path: string): unknown {
  if (path === "") return value;
  let current = value;
  for (const encoded of path.slice(1).split("/")) {
    const segment = decodePointerSegment(encoded);
    if (!current || typeof current !== "object" || !Object.prototype.hasOwnProperty.call(current, segment)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function boundedText(value: unknown, limit: number): string {
  if (typeof value !== "string" && typeof value !== "number") return "";
  return String(value).replace(/\s+/g, " ").trim().slice(0, limit);
}

function fallbackItems(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => boundedText(entry, 500)).filter(Boolean).slice(0, 16);
}

function projectedFallbackItems(
  value: unknown,
  projections: HomerailDirectUiProjectionV1["fallback"]["item_projections"],
): string[] {
  const items: string[] = [];
  const add = (textValue: unknown, prefix = "") => {
    if (items.length >= 16) return;
    const rendered = boundedText(textValue, 500 - prefix.length);
    const item = rendered ? `${prefix}${rendered}`.slice(0, 500) : "";
    if (item && !items.includes(item)) items.push(item);
  };
  for (const projection of projections ?? []) {
    if (items.length >= 16) break;
    const source = pointer(value, projection.pointer);
    const prefix = projection.prefix ?? "";
    if (projection.mode === "scalar") {
      add(source, prefix);
      continue;
    }
    if (projection.mode === "strings") {
      for (const entry of Array.isArray(source) ? source : []) {
        add(entry, prefix);
        if (items.length >= 16) break;
      }
      continue;
    }
    for (const entry of Array.isArray(source) ? source : []) {
      if (items.length >= 16) break;
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
      const title = boundedText(pointer(entry, projection.title_pointer ?? ""), 240);
      if (!title) continue;
      const details = [
        boundedText(projection.detail_pointer ? pointer(entry, projection.detail_pointer) : undefined, 240),
        ...fallbackItems(projection.items_pointer ? pointer(entry, projection.items_pointer) : undefined),
      ].filter(Boolean);
      add(details.length ? `${title}: ${details.join("; ")}` : title, prefix);
    }
  }
  return items.slice(0, 16);
}

function legacyPriority(importance: HomerailDirectUiProjectionV1["defaults"]["importance"]): string {
  if (importance === "critical" || importance === "primary") return "high";
  if (importance === "ambient") return "low";
  return "normal";
}

export function applyHomerailDirectUiProjection(input: {
  projection: unknown;
  plugin: { id: string; version: string };
  arguments: Record<string, unknown>;
}): HomerailDirectUiProjectionResultV1 {
  const projectionValidation = validateHomerailDirectUiProjection(input.projection);
  if (!projectionValidation.valid || !projectionValidation.value) {
    throw new Error(`Invalid direct UI projection: ${JSON.stringify(projectionValidation.errors)}`);
  }
  const projection = projectionValidation.value;
  if (!projection.kind.startsWith(`${input.plugin.id}/`)) {
    throw new Error(`Projection kind is not owned by ${input.plugin.id}: ${projection.kind}`);
  }
  const nodeId = boundedText(pointer(input.arguments, projection.node_id_pointer), 256);
  if (!nodeId) throw new Error(`Projection node id pointer did not resolve: ${projection.node_id_pointer}`);
  const rawContent = pointer(input.arguments, projection.content_pointer);
  if (!rawContent || typeof rawContent !== "object" || Array.isArray(rawContent)) {
    throw new Error(`Projection content pointer must resolve to an object: ${projection.content_pointer}`);
  }
  const content = structuredClone(rawContent) as Record<string, unknown>;
  projection.omit_content_fields.forEach((field) => delete content[field]);
  const title = boundedText(pointer(input.arguments, projection.fallback.title_pointer), 200);
  if (!title) throw new Error(`Projection fallback title did not resolve: ${projection.fallback.title_pointer}`);
  const summary = projection.fallback.summary_pointer
    ? boundedText(pointer(input.arguments, projection.fallback.summary_pointer), 4000)
    : "";
  const legacyItems = projection.fallback.items_pointer
    ? fallbackItems(pointer(input.arguments, projection.fallback.items_pointer))
    : [];
  const items = [...legacyItems, ...projectedFallbackItems(
    input.arguments,
    projection.fallback.item_projections,
  )].filter((entry, index, values) => values.indexOf(entry) === index).slice(0, 16);
  const node = {
    ir_version: GENERATIVE_UI_IR_VERSION,
    id: nodeId,
    kind: projection.kind,
    kind_version: projection.kind_version,
    owner: structuredClone(input.plugin),
    surface: projection.defaults.surface,
    importance: projection.defaults.importance,
    content,
    presentation: { density: projection.defaults.density },
    lifecycle: { persistence: projection.defaults.persistence },
    fallback: {
      title,
      ...(summary ? { summary } : {}),
      ...(items.length ? { items } : {}),
    },
    provenance: {
      actor: GenerativeUiActorType.PLUGIN,
      plugin: structuredClone(input.plugin),
    },
  } as const;
  const validation = validateGenerativeUiNode(node);
  if (!validation.valid || !validation.value) {
    throw new Error(`Projected UI node is invalid: ${JSON.stringify(validation.errors)}`);
  }
  const bridge = projection.legacy_bridge;
  return {
    projection_version: 1,
    node: validation.value,
    ...(bridge ? {
      legacy_widget: {
        id: nodeId,
        type: bridge.widget_type,
        title,
        body: summary,
        priority: legacyPriority(projection.defaults.importance),
        status: null,
        items: [],
        steps: [],
        active_step: null,
        data: { ...structuredClone(content), visual: bridge.visual },
      },
    } : {}),
  };
}

export function executeHomerailPluginTool(
  descriptor: HomerailPluginToolDescriptorV1,
  argumentsValue: unknown,
): HomerailPluginToolExecutionEnvelopeV1 {
  if (
    descriptor.handler.type !== "projection"
    || descriptor.effect !== "write"
    || descriptor.permissions.length !== 0
    || descriptor.confirmation !== "never"
    || !descriptor.output_schema
  ) {
    throw new Error(`Plugin Tool is not allowed by the M3 data-only execution policy: ${descriptor.qualified_id}`);
  }
  const input = validateHomerailPluginToolInput(descriptor.input_schema, argumentsValue);
  if (!input.valid || !input.value) {
    throw new Error(`Plugin Tool input is invalid: ${JSON.stringify(input.errors)}`);
  }
  const projection = applyHomerailDirectUiProjection({
    projection: descriptor.handler.document,
    plugin: { id: descriptor.plugin_id, version: descriptor.plugin_version },
    arguments: input.value,
  });
  const output = validateHomerailPluginToolInput(descriptor.output_schema, projection.node.content);
  if (!output.valid) {
    throw new Error(`Plugin Tool output is invalid: ${JSON.stringify(output.errors)}`);
  }
  const envelope: HomerailPluginToolExecutionEnvelopeV1 = {
    execution_version: 1,
    status: "projected",
    committed: false,
    plugin: { id: descriptor.plugin_id, version: descriptor.plugin_version },
    tool: {
      local_id: descriptor.local_id,
      qualified_id: descriptor.qualified_id,
      wire_id: descriptor.wire_id,
      handler_digest: descriptor.handler.digest,
    },
    arguments: structuredClone(input.value),
    projection,
  };
  const validation = validateHomerailPluginToolExecutionEnvelope(envelope);
  if (!validation.valid || !validation.value) {
    throw new Error(`Plugin Tool execution envelope is invalid: ${JSON.stringify(validation.errors)}`);
  }
  return validation.value;
}
