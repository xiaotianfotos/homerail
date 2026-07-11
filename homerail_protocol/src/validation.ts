/**
 * Schema validation using ajv (Draft-07).
 * @version 0.1.0
 */

import AjvModule from "ajv";
import type { ErrorObject, ValidateFunction } from "ajv";
import { allSchemas } from "./schemas.js";
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
