/**
 * Runtime validation for Generative UI protocol values.
 * @version 0.1.0
 */

import AjvModule from "ajv";
import type { ErrorObject, ValidateFunction } from "ajv";
import { generativeUiSchemas } from "./schemas.js";
import type {
  GenerativeUiDocumentV1,
  GenerativeUiInteractionEventV1,
  GenerativeUiNodeV1,
  GenerativeUiStoredNodeV1,
  GenerativeUiTransactionV1,
  GenerativeUiUserOverrideV1,
  GenerativeUiValidationError,
} from "./types.js";

// Ajv publishes CommonJS-compatible types under NodeNext. Resolve its runtime
// constructor without changing validation semantics.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const AjvClass = (AjvModule as any).default || AjvModule;

const MAX_NODE_CONTENT_BYTES = 128 * 1024;
const MAX_ACTION_ARGUMENT_BYTES = 32 * 1024;

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
  validator ??= createGenerativeUiValidator();
  const validateFn: ValidateFunction | undefined = validator.getSchema(schemaName);
  if (!validateFn) {
    return {
      valid: false,
      errors: [{ path: "", message: `Schema not found: ${schemaName}`, keyword: "unknown" }],
    };
  }
  if (!validateFn(value)) {
    return { valid: false, errors: normalizeErrors(validateFn.errors) };
  }
  return { valid: true, value: value as T, errors: [] };
}

function withSemanticErrors<T>(
  validation: GenerativeUiValidationResult<T>,
  errors: GenerativeUiValidationError[],
): GenerativeUiValidationResult<T> {
  if (!validation.valid || !errors.length) return validation;
  return { valid: false, errors };
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
  if (jsonByteLength(node.content) > MAX_NODE_CONTENT_BYTES) {
    errors.push({
      path: `${path}/content`,
      message: `content exceeds ${MAX_NODE_CONTENT_BYTES} bytes`,
      keyword: "maxPayloadBytes",
    });
  }
  if (node.lifecycle?.expires_at && !isValidTimestamp(node.lifecycle.expires_at)) {
    errors.push({
      path: `${path}/lifecycle/expires_at`,
      message: "must be a valid RFC 3339 timestamp",
      keyword: "date-time",
    });
  }
  const actionIds = new Set<string>();
  node.actions?.forEach((action, index) => {
    if (actionIds.has(action.id)) {
      errors.push({
        path: `${path}/actions/${index}/id`,
        message: `duplicate action id: ${action.id}`,
        keyword: "uniqueActionId",
      });
    }
    if (action.arguments && jsonByteLength(action.arguments) > MAX_ACTION_ARGUMENT_BYTES) {
      errors.push({
        path: `${path}/actions/${index}/arguments`,
        message: `arguments exceed ${MAX_ACTION_ARGUMENT_BYTES} bytes`,
        keyword: "maxPayloadBytes",
      });
    }
    actionIds.add(action.id);
  });
  return errors;
}

function jsonByteLength(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

function isValidTimestamp(value: string): boolean {
  return !Number.isNaN(Date.parse(value));
}

function timestampError(path: string, value: string): GenerativeUiValidationError[] {
  return isValidTimestamp(value)
    ? []
    : [{ path, message: "must be a valid RFC 3339 timestamp", keyword: "date-time" }];
}

export function resetGenerativeUiValidator(): void {
  validator = undefined;
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
    if (operation.op === "patch" && operation.changes.unset) {
      for (const field of operation.changes.unset) {
        if (Object.prototype.hasOwnProperty.call(operation.changes, field)) {
          errors.push({
            path: `/operations/${index}/changes/unset`,
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

export function validateGenerativeUiInteractionEvent(
  value: unknown,
): GenerativeUiValidationResult<GenerativeUiInteractionEventV1> {
  const validation = validate<GenerativeUiInteractionEventV1>("generative-ui-interaction-event", value);
  return withSemanticErrors(
    validation,
    validation.value ? timestampError("/created_at", validation.value.created_at) : [],
  );
}
