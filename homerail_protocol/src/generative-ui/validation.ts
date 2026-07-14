/**
 * Runtime validation for Generative UI protocol values.
 * @version 0.1.0
 */

import AjvModule from "ajv";
import type { ErrorObject, ValidateFunction } from "ajv";
import { generativeUiSchemas } from "./schemas.js";
import { isSafeGenerativeUiArtifactUri } from "./artifact-uri.js";
import {
  GENERATIVE_UI_MAX_ACTION_ARGUMENT_BYTES,
  GENERATIVE_UI_MAX_DOCUMENT_BYTES,
  GENERATIVE_UI_MAX_MISC_ENVELOPE_BYTES,
  GENERATIVE_UI_MAX_NODE_CONTENT_BYTES,
  GENERATIVE_UI_MAX_NODE_ENVELOPE_BYTES,
  GENERATIVE_UI_MAX_TRANSACTION_BYTES,
  analyzeGenerativeUiJsonValue,
  type GenerativeUiJsonValueLimits,
} from "./json-value.js";
import type {
  GenerativeUiCompositionV1,
  GenerativeUiDocumentV1,
  GenerativeUiInteractionEventV1,
  GenerativeUiNodeV1,
  GenerativeUiStoredNodeV1,
  GenerativeUiTransactionV1,
  GenerativeUiSurfaceContextV1,
  GenerativeUiUserOverrideV1,
  GenerativeUiValidationError,
} from "./types.js";
import {
  HOMERAIL_A2UI_MAX_BYTES,
  analyzeHomerailA2uiSurfaceSemantics,
  type A2uiCreateSurfaceMessageV1,
  type HomerailA2uiSemanticOptionsV1,
  type HomerailA2uiSurfaceV1,
} from "./a2ui.js";
import {
  HOMERAIL_VIEW_SPEC_MAX_BYTES,
  analyzeHomerailViewSpecSemantics,
  type HomerailViewSpecV1,
} from "./view-spec.js";

const CORE_GENERATED_VIEW_KIND = "com.homerail.core/generated_view";
const LEGACY_VIEW_SPEC_KIND_VERSION = 1;
const NATIVE_A2UI_KIND_VERSION = 2;

// Ajv publishes CommonJS-compatible types under NodeNext. Resolve its runtime
// constructor without changing validation semantics.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const AjvClass = (AjvModule as any).default || AjvModule;

export interface GenerativeUiValidationResult<T> {
  valid: boolean;
  value?: T;
  errors: GenerativeUiValidationError[];
}

function normalizeErrors(errors: ErrorObject[] | null | undefined): GenerativeUiValidationError[] {
  if (!errors) return [];
  return errors.map((error) => ({
    path: error.instancePath || "",
    message: error.message || "unknown validation error",
    keyword: error.keyword || "",
  }));
}

function createGenerativeUiValidator() {
  const ajv = new AjvClass({
    allErrors: true,
    strict: false,
    coerceTypes: false,
  });
  for (const [name, schema] of Object.entries(generativeUiSchemas)) {
    ajv.addSchema(schema, name);
  }
  return ajv;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let validator: any;

function validate<T>(schemaName: string, value: unknown): GenerativeUiValidationResult<T> {
  const json = analyzeGenerativeUiJsonValue(value, {
    limits: jsonLimitsForSchema(schemaName),
  });
  if (!json.valid) {
    return { valid: false, errors: [json.error ?? { path: "", message: "invalid JSON value", keyword: "jsonValue" }] };
  }
  let stableValue: unknown;
  try {
    // Semantic validation must not re-read a hostile or late-changing object
    // after the JSON preflight. A wire-compatible snapshot also rejects Proxy
    // values, which structured clone cannot serialize.
    stableValue = structuredClone(value);
  } catch {
    return {
      valid: false,
      errors: [{ path: "", message: "JSON value could not be snapshotted safely", keyword: "jsonSnapshot" }],
    };
  }
  validator ??= createGenerativeUiValidator();
  const validateFn: ValidateFunction | undefined = validator.getSchema(schemaName);
  if (!validateFn) {
    return {
      valid: false,
      errors: [{ path: "", message: `Schema not found: ${schemaName}`, keyword: "unknown" }],
    };
  }
  try {
    if (!validateFn(stableValue)) {
      return { valid: false, errors: normalizeErrors(validateFn.errors) };
    }
  } catch {
    return { valid: false, errors: [{ path: "", message: "schema validation failed safely", keyword: "schemaValidation" }] };
  }
  return { valid: true, value: stableValue as T, errors: [] };
}

function jsonLimitsForSchema(schemaName: string): Partial<GenerativeUiJsonValueLimits> {
  if (schemaName === "homerail-view-spec-v1") return { max_bytes: HOMERAIL_VIEW_SPEC_MAX_BYTES };
  if (schemaName === "homerail-a2ui-surface-v1") return { max_bytes: HOMERAIL_A2UI_MAX_BYTES };
  if (schemaName === "generative-ui-document") return { max_bytes: GENERATIVE_UI_MAX_DOCUMENT_BYTES };
  if (schemaName === "generative-ui-transaction") return { max_bytes: GENERATIVE_UI_MAX_TRANSACTION_BYTES };
  if (schemaName === "generative-ui-node" || schemaName === "generative-ui-stored-node") {
    return { max_bytes: GENERATIVE_UI_MAX_NODE_ENVELOPE_BYTES };
  }
  return { max_bytes: GENERATIVE_UI_MAX_MISC_ENVELOPE_BYTES };
}

function withSemanticErrors<T>(
  validation: GenerativeUiValidationResult<T>,
  errors: GenerativeUiValidationError[],
): GenerativeUiValidationResult<T> {
  if (!validation.valid || !errors.length) return validation;
  return { valid: false, errors };
}

function contentSemanticErrors(
  content: Record<string, unknown>,
  path: string,
): GenerativeUiValidationError[] {
  const analysis = analyzeGenerativeUiJsonValue(content, {
    path,
    limits: { max_bytes: GENERATIVE_UI_MAX_NODE_CONTENT_BYTES },
  });
  return analysis.valid
    ? []
    : [{
        path: analysis.error?.path || path,
        message: analysis.error?.message || `content exceeds ${GENERATIVE_UI_MAX_NODE_CONTENT_BYTES} bytes`,
        keyword: analysis.error?.keyword || "maxPayloadBytes",
      }];
}

function fallbackSemanticErrors(
  fallback: GenerativeUiNodeV1["fallback"],
  path: string,
): GenerativeUiValidationError[] {
  const errors: GenerativeUiValidationError[] = [];
  fallback.artifact_refs?.forEach((artifact, index) => {
    if (!isSafeGenerativeUiArtifactUri(artifact.uri)) {
      errors.push({
        path: `${path}/artifact_refs/${index}/uri`,
        message: "must be a passive http(s), artifact, drive, or local path reference",
        keyword: "artifactUri",
      });
    }
  });
  return errors;
}

function actionSemanticErrors(
  actions: GenerativeUiNodeV1["actions"],
  path: string,
): GenerativeUiValidationError[] {
  const errors: GenerativeUiValidationError[] = [];
  const actionIds = new Set<string>();
  actions?.forEach((action, index) => {
    if (actionIds.has(action.id)) {
      errors.push({
        path: `${path}/${index}/id`,
        message: `duplicate action id: ${action.id}`,
        keyword: "uniqueActionId",
      });
    }
    const argumentsAnalysis = action.arguments
      ? analyzeGenerativeUiJsonValue(action.arguments, {
          path: `${path}/${index}/arguments`,
          limits: { max_bytes: GENERATIVE_UI_MAX_ACTION_ARGUMENT_BYTES },
        })
      : null;
    if (argumentsAnalysis && !argumentsAnalysis.valid) {
      errors.push({
        path: argumentsAnalysis.error?.path || `${path}/${index}/arguments`,
        message: argumentsAnalysis.error?.message || `arguments exceed ${GENERATIVE_UI_MAX_ACTION_ARGUMENT_BYTES} bytes`,
        keyword: argumentsAnalysis.error?.keyword || "maxPayloadBytes",
      });
    }
    actionIds.add(action.id);
  });
  return errors;
}

function nodeSemanticErrors(
  node: GenerativeUiNodeV1,
  path = "",
): GenerativeUiValidationError[] {
  const errors: GenerativeUiValidationError[] = [];
  if (!node.kind.startsWith(`${node.owner.id}/`)) {
    errors.push({
      path: `${path}/kind`,
      message: `kind must be namespaced by owner id ${node.owner.id}`,
      keyword: "ownerNamespace",
    });
  }
  errors.push(...contentSemanticErrors(node.content, `${path}/content`));
  errors.push(...fallbackSemanticErrors(node.fallback, `${path}/fallback`));
  if (node.lifecycle?.expires_at && !isValidGenerativeUiTimestamp(node.lifecycle.expires_at)) {
    errors.push({
      path: `${path}/lifecycle/expires_at`,
      message: "must be a valid RFC 3339 timestamp",
      keyword: "date-time",
    });
  }
  errors.push(...actionSemanticErrors(node.actions, `${path}/actions`));
  if (node.view && node.a2ui) {
    errors.push({
      path,
      message: "a node cannot contain both legacy ViewSpec and native A2UI presentation",
      keyword: "presentationConflict",
    });
  }
  if (node.view) {
    if (node.kind !== CORE_GENERATED_VIEW_KIND || node.kind_version !== LEGACY_VIEW_SPEC_KIND_VERSION) {
      errors.push({
        path: `${path}/view`,
        message: "legacy ViewSpec is supported only for com.homerail.core/generated_view@1",
        keyword: "legacyViewSpecVersion",
      });
    }
    const viewAnalysis = analyzeGenerativeUiJsonValue(node.view, {
      path: `${path}/view`,
      limits: { max_bytes: HOMERAIL_VIEW_SPEC_MAX_BYTES },
    });
    if (!viewAnalysis.valid) {
      errors.push({
        path: viewAnalysis.error?.path || `${path}/view`,
        message: viewAnalysis.error?.message || `view exceeds ${HOMERAIL_VIEW_SPEC_MAX_BYTES} bytes`,
        keyword: viewAnalysis.error?.keyword || "maxPayloadBytes",
      });
    } else {
      errors.push(...analyzeHomerailViewSpecSemantics(node.view, {
        action_ids: new Set((node.actions ?? []).map((action) => action.id)),
        path: `${path}/view`,
      }));
    }
  }
  if (node.a2ui) {
    if (node.kind === CORE_GENERATED_VIEW_KIND && node.kind_version !== NATIVE_A2UI_KIND_VERSION) {
      errors.push({
        path: `${path}/a2ui`,
        message: "native A2UI presentation for com.homerail.core/generated_view requires kind version 2",
        keyword: "nativeA2uiVersion",
      });
    }
    const a2uiAnalysis = analyzeGenerativeUiJsonValue(node.a2ui, {
      path: `${path}/a2ui`,
      limits: { max_bytes: HOMERAIL_A2UI_MAX_BYTES },
    });
    if (!a2uiAnalysis.valid) {
      errors.push({
        path: a2uiAnalysis.error?.path || `${path}/a2ui`,
        message: a2uiAnalysis.error?.message || `a2ui exceeds ${HOMERAIL_A2UI_MAX_BYTES} bytes`,
        keyword: a2uiAnalysis.error?.keyword || "maxPayloadBytes",
      });
    } else {
      errors.push(...analyzeHomerailA2uiSurfaceSemantics(node.a2ui, {
        action_ids: new Set((node.actions ?? []).map((action) => action.id)),
        data_model: node.content,
        path: `${path}/a2ui`,
      }));
    }
  }
  return errors;
}

export function isValidGenerativeUiTimestamp(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-](\d{2}):(\d{2}))$/.exec(value);
  if (!match) return false;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, offsetHourText, offsetMinuteText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const offsetHour = offsetHourText === undefined ? 0 : Number(offsetHourText);
  const offsetMinute = offsetMinuteText === undefined ? 0 : Number(offsetMinuteText);
  if (month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59) return false;
  if (offsetHour > 23 || offsetMinute > 59) return false;
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day >= 1 && day <= daysInMonth[month - 1];
}

function timestampError(path: string, value: string): GenerativeUiValidationError[] {
  return isValidGenerativeUiTimestamp(value)
    ? []
    : [{ path, message: "must be a valid RFC 3339 timestamp", keyword: "date-time" }];
}

export function resetGenerativeUiValidator(): void {
  validator = undefined;
}

export function validateHomerailViewSpec(
  value: unknown,
  options: { action_ids?: ReadonlySet<string> } = {},
): GenerativeUiValidationResult<HomerailViewSpecV1> {
  const validation = validate<HomerailViewSpecV1>("homerail-view-spec-v1", value);
  if (!validation.value) return validation;
  const analysis = analyzeGenerativeUiJsonValue(validation.value, {
    limits: { max_bytes: HOMERAIL_VIEW_SPEC_MAX_BYTES },
  });
  if (!analysis.valid) {
    return { valid: false, errors: [analysis.error ?? { path: "", message: "ViewSpec exceeds its budget", keyword: "maxPayloadBytes" }] };
  }
  return withSemanticErrors(validation, analyzeHomerailViewSpecSemantics(validation.value, options));
}

export function validateHomerailA2uiSurface(
  value: unknown,
  options: Omit<HomerailA2uiSemanticOptionsV1, "path"> = {},
): GenerativeUiValidationResult<HomerailA2uiSurfaceV1> {
  const validation = validate<HomerailA2uiSurfaceV1>("homerail-a2ui-surface-v1", value);
  if (!validation.value) return validation;
  const analysis = analyzeGenerativeUiJsonValue(validation.value, {
    limits: { max_bytes: HOMERAIL_A2UI_MAX_BYTES },
  });
  if (!analysis.valid) {
    return { valid: false, errors: [analysis.error ?? { path: "", message: "A2UI surface exceeds its budget", keyword: "maxPayloadBytes" }] };
  }
  return withSemanticErrors(validation, analyzeHomerailA2uiSurfaceSemantics(validation.value, options));
}

export function validateHomerailA2uiCreateSurfaceMessage(
  value: unknown,
): GenerativeUiValidationResult<A2uiCreateSurfaceMessageV1> {
  return validate<A2uiCreateSurfaceMessageV1>(
    "homerail-a2ui-create-surface-message-v1",
    value,
  );
}

export function validateGenerativeUiNode(
  value: unknown,
): GenerativeUiValidationResult<GenerativeUiNodeV1> {
  const validation = validate<GenerativeUiNodeV1>("generative-ui-node", value);
  return withSemanticErrors(
    validation,
    validation.value ? nodeSemanticErrors(validation.value) : [],
  );
}

export function validateGenerativeUiStoredNode(
  value: unknown,
): GenerativeUiValidationResult<GenerativeUiStoredNodeV1> {
  const validation = validate<GenerativeUiStoredNodeV1>("generative-ui-stored-node", value);
  return withSemanticErrors(
    validation,
    validation.value
      ? [
          ...nodeSemanticErrors(validation.value),
          ...timestampError("/updated_at", validation.value.updated_at),
        ]
      : [],
  );
}

export function validateGenerativeUiDocument(
  value: unknown,
): GenerativeUiValidationResult<GenerativeUiDocumentV1> {
  const validation = validate<GenerativeUiDocumentV1>("generative-ui-document", value);
  if (!validation.value) return validation;
  const errors: GenerativeUiValidationError[] = [];
  errors.push(...timestampError("/updated_at", validation.value.updated_at));
  const nodeIds = new Set<string>();
  validation.value.nodes.forEach((node, index) => {
    if (nodeIds.has(node.id)) {
      errors.push({
        path: `/nodes/${index}/id`,
        message: `duplicate node id: ${node.id}`,
        keyword: "uniqueNodeId",
      });
    }
    nodeIds.add(node.id);
    errors.push(...nodeSemanticErrors(node, `/nodes/${index}`));
    errors.push(...timestampError(`/nodes/${index}/updated_at`, node.updated_at));
  });
  return withSemanticErrors(validation, errors);
}

export function validateGenerativeUiTransaction(
  value: unknown,
): GenerativeUiValidationResult<GenerativeUiTransactionV1> {
  const validation = validate<GenerativeUiTransactionV1>("generative-ui-transaction", value);
  if (!validation.value) return validation;
  const errors: GenerativeUiValidationError[] = [
    ...timestampError("/created_at", validation.value.created_at),
  ];
  validation.value.operations.forEach((operation, index) => {
    if (operation.op === "put") {
      errors.push(...nodeSemanticErrors(operation.node, `/operations/${index}/node`));
    }
    if (operation.op === "patch") {
      const changesPath = `/operations/${index}/changes`;
      if (operation.changes.content) {
        errors.push(...contentSemanticErrors(operation.changes.content, `${changesPath}/content`));
      }
      if (operation.changes.view) {
        const viewAnalysis = analyzeGenerativeUiJsonValue(operation.changes.view, {
          path: `${changesPath}/view`,
          limits: { max_bytes: HOMERAIL_VIEW_SPEC_MAX_BYTES },
        });
        if (!viewAnalysis.valid) {
          errors.push({
            path: viewAnalysis.error?.path || `${changesPath}/view`,
            message: viewAnalysis.error?.message || `view exceeds ${HOMERAIL_VIEW_SPEC_MAX_BYTES} bytes`,
            keyword: viewAnalysis.error?.keyword || "maxPayloadBytes",
          });
        } else {
          errors.push(...analyzeHomerailViewSpecSemantics(operation.changes.view, {
            ...(operation.changes.actions
              ? { action_ids: new Set(operation.changes.actions.map((action) => action.id)) }
              : {}),
            path: `${changesPath}/view`,
          }));
        }
      }
      if (operation.changes.view && operation.changes.a2ui) {
        errors.push({
          path: changesPath,
          message: "a patch cannot set both legacy ViewSpec and native A2UI presentation",
          keyword: "presentationConflict",
        });
      }
      if (operation.changes.a2ui) {
        const a2uiAnalysis = analyzeGenerativeUiJsonValue(operation.changes.a2ui, {
          path: `${changesPath}/a2ui`,
          limits: { max_bytes: HOMERAIL_A2UI_MAX_BYTES },
        });
        if (!a2uiAnalysis.valid) {
          errors.push({
            path: a2uiAnalysis.error?.path || `${changesPath}/a2ui`,
            message: a2uiAnalysis.error?.message || `a2ui exceeds ${HOMERAIL_A2UI_MAX_BYTES} bytes`,
            keyword: a2uiAnalysis.error?.keyword || "maxPayloadBytes",
          });
        } else {
          errors.push(...analyzeHomerailA2uiSurfaceSemantics(operation.changes.a2ui, {
            ...(operation.changes.actions
              ? { action_ids: new Set(operation.changes.actions.map((action) => action.id)) }
              : { defer_action_references: true }),
            ...(operation.changes.content ? { data_model: operation.changes.content } : {}),
            path: `${changesPath}/a2ui`,
          }));
        }
      }
      if (operation.changes.fallback) {
        errors.push(...fallbackSemanticErrors(operation.changes.fallback, `${changesPath}/fallback`));
      }
      if (operation.changes.actions) {
        errors.push(...actionSemanticErrors(operation.changes.actions, `${changesPath}/actions`));
      }
      if (
        operation.changes.lifecycle?.expires_at
        && !isValidGenerativeUiTimestamp(operation.changes.lifecycle.expires_at)
      ) {
        errors.push({
          path: `${changesPath}/lifecycle/expires_at`,
          message: "must be a valid RFC 3339 timestamp",
          keyword: "date-time",
        });
      }
      for (const field of operation.changes.unset ?? []) {
        if (Object.prototype.hasOwnProperty.call(operation.changes, field)) {
          errors.push({
            path: `${changesPath}/unset`,
            message: `cannot both set and unset ${field}`,
            keyword: "patchConflict",
          });
        }
      }
    }
  });
  return withSemanticErrors(validation, errors);
}

export function validateGenerativeUiUserOverride(
  value: unknown,
): GenerativeUiValidationResult<GenerativeUiUserOverrideV1> {
  const validation = validate<GenerativeUiUserOverrideV1>("generative-ui-user-override", value);
  return withSemanticErrors(
    validation,
    validation.value ? timestampError("/updated_at", validation.value.updated_at) : [],
  );
}

export function validateGenerativeUiCompositionContext(
  value: unknown,
): GenerativeUiValidationResult<GenerativeUiSurfaceContextV1> {
  return validate<GenerativeUiSurfaceContextV1>("generative-ui-composition-context", value);
}

export function validateGenerativeUiComposition(
  value: unknown,
): GenerativeUiValidationResult<GenerativeUiCompositionV1> {
  const validation = validate<GenerativeUiCompositionV1>("generative-ui-composition", value);
  if (!validation.value) return validation;
  const errors: GenerativeUiValidationError[] = [];
  const itemIds = new Set<string>();
  validation.value.items.forEach((item, index) => {
    if (item.rank !== index + 1) {
      errors.push({
        path: `/items/${index}/rank`,
        message: `rank must be contiguous and equal ${index + 1}`,
        keyword: "compositionRank",
      });
    }
    if (itemIds.has(item.node_id)) {
      errors.push({
        path: `/items/${index}/node_id`,
        message: `duplicate composed node id: ${item.node_id}`,
        keyword: "uniqueNodeId",
      });
    }
    itemIds.add(item.node_id);
  });
  const hiddenIds = new Set<string>();
  validation.value.hidden_node_ids.forEach((nodeId, index) => {
    if (hiddenIds.has(nodeId) || itemIds.has(nodeId)) {
      errors.push({
        path: `/hidden_node_ids/${index}`,
        message: `node id must occur in exactly one composition partition: ${nodeId}`,
        keyword: "compositionPartition",
      });
    }
    hiddenIds.add(nodeId);
  });
  return withSemanticErrors(validation, errors);
}

export function validateGenerativeUiInteractionEvent(
  value: unknown,
): GenerativeUiValidationResult<GenerativeUiInteractionEventV1> {
  const validation = validate<GenerativeUiInteractionEventV1>("generative-ui-interaction-event", value);
  return withSemanticErrors(
    validation,
    validation.value ? timestampError("/created_at", validation.value.created_at) : [],
  );
}
