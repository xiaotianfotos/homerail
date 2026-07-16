/**
 * Schema validation using ajv (Draft-07).
 * @version 0.1.0
 */

import AjvModule from "ajv";
import type { ErrorObject, ValidateFunction } from "ajv";
import { allSchemas } from "./schemas.js";
import { DAG_ACTIVITY_EVENT_V1_SCHEMA_ID } from "./dag-activity.js";
import {
  DAG_ACTOR_LIVE_COMMAND_SCHEMA_ID,
  DAG_ACTOR_LIVE_COMMAND_STATUS_SCHEMA_ID,
} from "./types.js";
import {
  DAG_ACTOR_SURFACE_PATCH_MAX_BYTES,
  DAG_ACTOR_SURFACE_PATCH_MAX_COMPONENTS,
  DAG_ACTOR_SURFACE_PATCH_MAX_DEPTH,
  DAG_ACTOR_SURFACE_PATCH_MAX_DIRECT_CHILDREN,
  DAG_ACTOR_SURFACE_PATCH_V1_SCHEMA_ID,
  type DagActorSurfacePatchV1,
} from "./dag-actor-surface-patch.js";
import {
  validateHomerailA2uiSurface,
  type A2uiComponentV1,
} from "./generative-ui/index.js";
import {
  validateHomerailPluginManifest,
  validateHomerailPluginTurnContext,
  validateHomerailPluginUiProjection,
  validateHomerailResolvedPluginDescriptorWire,
  validateHomerailDirectUiProjection,
} from "./plugins/validation.js";

// ajv ships CJS types that aren't directly constructable under NodeNext module resolution.
// At runtime the default export is the Ajv class; we bypass the type checker here.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const AjvClass = (AjvModule as any).default || AjvModule;

export interface ValidationError {
  path: string;
  message: string;
  keyword: string;
}

export interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
}

function normalizeErrors(errors: ErrorObject[] | null | undefined): ValidationError[] {
  if (!errors) return [];
  return errors.map((e) => ({
    path: e.instancePath || "",
    message: e.message || "unknown error",
    keyword: e.keyword || "",
  }));
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _ajv: any = null;

export function createValidator() {
  const ajv = new AjvClass({
    allErrors: true,
    strict: false,
    coerceTypes: false,
  });

  for (const [name, schema] of Object.entries(allSchemas)) {
    ajv.addSchema(schema, name);
  }

  return ajv;
}

function getAjv() {
  if (!_ajv) {
    _ajv = createValidator();
  }
  return _ajv;
}

export function resetValidator(): void {
  _ajv = null;
}

export function validateMessage(data: unknown, schemaName: string): ValidationResult {
  if (schemaName === "homerail-plugin-manifest-v1") {
    const result = validateHomerailPluginManifest(data);
    return { valid: result.valid, errors: result.errors };
  }
  if (schemaName === "homerail-plugin-turn-context-v1") {
    const result = validateHomerailPluginTurnContext(data);
    return { valid: result.valid, errors: result.errors };
  }
  if (schemaName === "homerail-plugin-ui-projection-v1") {
    const result = validateHomerailPluginUiProjection(data);
    return { valid: result.valid, errors: result.errors };
  }
  if (schemaName === "homerail-resolved-plugin-descriptor-v1") {
    const result = validateHomerailResolvedPluginDescriptorWire(data);
    return { valid: result.valid, errors: result.errors };
  }
  if (schemaName === "homerail-direct-ui-projection-v1") {
    const result = validateHomerailDirectUiProjection(data);
    return { valid: result.valid, errors: result.errors };
  }
  const ajv = getAjv();
  const validateFn: ValidateFunction | undefined = ajv.getSchema(schemaName);

  if (!validateFn) {
    return {
      valid: false,
      errors: [{ path: "", message: `Schema not found: ${schemaName}`, keyword: "unknown" }],
    };
  }

  const valid = validateFn(data);
  return {
    valid: valid as boolean,
    errors: normalizeErrors(validateFn.errors),
  };
}

export function validateDagActivityEventV1(value: unknown): ValidationResult {
  return validateMessage(value, DAG_ACTIVITY_EVENT_V1_SCHEMA_ID);
}

export function validateDagActorLiveCommandMessage(value: unknown): ValidationResult {
  return validateMessage(value, DAG_ACTOR_LIVE_COMMAND_SCHEMA_ID);
}

export function validateDagActorLiveCommandStatusMessage(value: unknown): ValidationResult {
  return validateMessage(value, DAG_ACTOR_LIVE_COMMAND_STATUS_SCHEMA_ID);
}

const ACTOR_SURFACE_PASSIVE_COMPONENTS = new Set<A2uiComponentV1["component"]>([
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
]);

function actorSurfaceChildIds(component: A2uiComponentV1): string[] {
  switch (component.component) {
    case "Row":
    case "Column":
    case "List":
    case "HrGrid":
    case "HrSection":
    case "HrDisclosure":
    case "HrIf":
      return Array.isArray(component.children) ? component.children : [component.children.componentId];
    case "Card":
    case "Button":
    case "HrGridItem":
    case "HrStep":
      return [component.child];
    case "Tabs":
      return component.tabs.map((tab) => tab.child);
    case "Modal":
      return [component.trigger, component.content];
    default:
      return [];
  }
}

function actorSurfaceSemanticErrors(patch: DagActorSurfacePatchV1): ValidationError[] {
  if (patch.op === "clear_body") return [];
  const errors: ValidationError[] = [];
  const surface = patch.body.a2ui;
  if (surface.components.length > DAG_ACTOR_SURFACE_PATCH_MAX_COMPONENTS) {
    errors.push({
      path: "/body/a2ui/components",
      message: `must contain at most ${DAG_ACTOR_SURFACE_PATCH_MAX_COMPONENTS} components`,
      keyword: "maxActorSurfaceComponents",
    });
  }
  if (surface.surfaceProperties !== undefined) {
    errors.push({
      path: "/body/a2ui/surfaceProperties",
      message: "surface properties are projector-owned",
      keyword: "actorSurfaceOwnership",
    });
  }

  const byId = new Map(surface.components.map((component) => [component.id, component]));
  for (const [index, component] of surface.components.entries()) {
    if (!ACTOR_SURFACE_PASSIVE_COMPONENTS.has(component.component)) {
      errors.push({
        path: `/body/a2ui/components/${index}/component`,
        message: `component is not in the passive Actor catalog: ${component.component}`,
        keyword: "actorSurfacePassiveCatalog",
      });
    }
    if (component.component === "HrArtifact" && component.kind === "html") {
      errors.push({
        path: `/body/a2ui/components/${index}/kind`,
        message: "HTML artifacts are not allowed in Actor surfaces",
        keyword: "actorSurfaceHtml",
      });
    }
    const children = actorSurfaceChildIds(component);
    if (children.length > DAG_ACTOR_SURFACE_PATCH_MAX_DIRECT_CHILDREN) {
      errors.push({
        path: `/body/a2ui/components/${index}`,
        message: `direct child count exceeds ${DAG_ACTOR_SURFACE_PATCH_MAX_DIRECT_CHILDREN}`,
        keyword: "maxActorSurfaceDirectChildren",
      });
    }
  }

  const seenDepth = new Map<string, number>();
  const visit = (id: string, depth: number, ancestors: ReadonlySet<string>): void => {
    const component = byId.get(id);
    if (!component || ancestors.has(id) || (seenDepth.get(id) ?? 0) >= depth) return;
    seenDepth.set(id, depth);
    if (depth > DAG_ACTOR_SURFACE_PATCH_MAX_DEPTH) {
      errors.push({
        path: `/body/a2ui/components/${surface.components.indexOf(component)}`,
        message: `component depth exceeds ${DAG_ACTOR_SURFACE_PATCH_MAX_DEPTH}`,
        keyword: "maxActorSurfaceDepth",
      });
      return;
    }
    const next = new Set(ancestors);
    next.add(id);
    for (const child of actorSurfaceChildIds(component)) visit(child, depth + 1, next);
  };
  visit("root", 1, new Set());

  const inspectBindings = (value: unknown, path: string): void => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      value.forEach((entry, index) => inspectBindings(entry, `${path}/${index}`));
      return;
    }
    const record = value as Record<string, unknown>;
    if (Object.keys(record).length === 1 && typeof record.path === "string" && record.path.startsWith("/")) {
      if (record.path !== "/actor_view/data" && !record.path.startsWith("/actor_view/data/")) {
        errors.push({
          path: `${path}/path`,
          message: "absolute Actor bindings must stay under /actor_view/data",
          keyword: "actorSurfaceDataOwnership",
        });
      }
    }
    for (const [key, nested] of Object.entries(record)) inspectBindings(nested, `${path}/${key}`);
  };
  inspectBindings(surface.components, "/body/a2ui/components");
  return errors;
}

export function validateDagActorSurfacePatchV1(value: unknown): ValidationResult {
  let encoded: string;
  try {
    encoded = JSON.stringify(value);
  } catch {
    return {
      valid: false,
      errors: [{ path: "", message: "patch must be JSON serializable", keyword: "jsonSerializable" }],
    };
  }
  if (encoded === undefined || new TextEncoder().encode(encoded).byteLength > DAG_ACTOR_SURFACE_PATCH_MAX_BYTES) {
    return {
      valid: false,
      errors: [{
        path: "",
        message: `patch exceeds ${DAG_ACTOR_SURFACE_PATCH_MAX_BYTES} bytes`,
        keyword: "maxPayloadBytes",
      }],
    };
  }
  const structural = validateMessage(value, DAG_ACTOR_SURFACE_PATCH_V1_SCHEMA_ID);
  if (!structural.valid) return structural;
  const patch = value as DagActorSurfacePatchV1;
  if (patch.op === "clear_body") return structural;
  const a2ui = validateHomerailA2uiSurface(patch.body.a2ui, {
    data_model: { actor_view: { data: patch.body.data } },
  });
  const semantic = [
    ...a2ui.errors.map((error) => ({ ...error, path: `/body/a2ui${error.path}` })),
    ...actorSurfaceSemanticErrors(patch),
  ];
  return { valid: semantic.length === 0, errors: semantic };
}
