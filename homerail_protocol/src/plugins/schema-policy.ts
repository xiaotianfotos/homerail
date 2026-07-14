import { analyzeGenerativeUiJsonValue } from "../generative-ui/json-value.js";

export const HOMERAIL_PLUGIN_SCHEMA_MAX_BYTES = 256 * 1024;
export const HOMERAIL_PLUGIN_SKILL_MAX_BYTES = 256 * 1024;
export const HOMERAIL_PLUGIN_DESCRIPTOR_MAX_BYTES = 4 * 1024 * 1024;
export const HOMERAIL_PLUGIN_SCHEMA_MAX_DEPTH = 32;
export const HOMERAIL_PLUGIN_SCHEMA_MAX_VALUES = 20_000;
export const HOMERAIL_PLUGIN_SCHEMA_MAX_ARRAY_ITEMS = 256;
export const HOMERAIL_PLUGIN_SCHEMA_MAX_STRING_LENGTH = 16_384;
export const HOMERAIL_PLUGIN_SCHEMA_MAX_PROPERTIES = 128;
export const HOMERAIL_PLUGIN_SCHEMA_MAX_ENUM_VALUES = 64;

export interface HomerailPluginSchemaPolicyIssue {
  path: string;
  message: string;
  keyword: "schemaBudget" | "schemaRef" | "safePattern" | "schemaComplexity";
}

export function decodeHomerailPluginUtf8(value: Uint8Array, label = "plugin text file"): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(value);
  } catch {
    throw new Error(`${label} is not valid UTF-8`);
  }
}

function pointerToken(value: string): string {
  return value.replace(/~/g, "~0").replace(/\//g, "~1");
}

export function analyzeHomerailPluginSchemaPolicy(schema: unknown): HomerailPluginSchemaPolicyIssue[] {
  const issues: HomerailPluginSchemaPolicyIssue[] = [];
  const analysis = analyzeGenerativeUiJsonValue(schema, {
    limits: {
      max_bytes: HOMERAIL_PLUGIN_SCHEMA_MAX_BYTES,
      max_depth: HOMERAIL_PLUGIN_SCHEMA_MAX_DEPTH,
      max_values: HOMERAIL_PLUGIN_SCHEMA_MAX_VALUES,
    },
  });
  if (!analysis.valid) {
    issues.push({
      path: analysis.error?.path ?? "",
      message: analysis.error?.message ?? "schema exceeds its static budget",
      keyword: "schemaBudget",
    });
    return issues;
  }
  const allowedKeywords = new Set([
    "$schema", "$id", "$comment", "$ref", "definitions",
    "title", "description", "default", "examples",
    "type", "properties", "required", "additionalProperties", "minProperties", "maxProperties",
    "items", "minItems", "maxItems",
    "minLength", "maxLength",
    "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf",
    "enum", "const",
  ]);
  const scalarTypes = new Set(["object", "array", "string", "number", "integer", "boolean", "null"]);
  const complexity = (path: string, message: string): void => {
    issues.push({ path, message, keyword: "schemaComplexity" });
  };
  const visit = (value: unknown, pointer: string): void => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      complexity(pointer, "every plugin subschema must be an object with an explicit bounded profile");
      return;
    }
    const object = value as Record<string, unknown>;
    for (const key of Object.keys(object)) {
      if (key === "pattern" || key === "patternProperties") {
        issues.push({
          path: `${pointer}/${pointerToken(key)}`,
          message: "regular-expression schema keywords are forbidden until a linear-time engine is available",
          keyword: "safePattern",
        });
      } else if (!allowedKeywords.has(key)) {
        complexity(`${pointer}/${pointerToken(key)}`, `${key} is outside the bounded M4 plugin schema profile`);
      }
    }
    const hasTerminal = Array.isArray(object.enum) || "const" in object || "$ref" in object;
    if (object.type !== undefined && (typeof object.type !== "string" || !scalarTypes.has(object.type))) {
      complexity(`${pointer}/type`, "type must be one explicit JSON Schema scalar type, never an array");
    } else if (object.type === undefined && !hasTerminal) {
      complexity(`${pointer}/type`, "each subschema requires one explicit type, enum, const, or local $ref");
    }
    if ("$ref" in object && (typeof object.$ref !== "string" || !object.$ref.startsWith("#"))) {
      issues.push({ path: `${pointer}/$ref`, message: "only package-local fragment $ref values are allowed", keyword: "schemaRef" });
    }
    if (object.type === "array" && (
      !Number.isSafeInteger(object.maxItems)
      || Number(object.maxItems) < 0
      || Number(object.maxItems) > HOMERAIL_PLUGIN_SCHEMA_MAX_ARRAY_ITEMS
    )) issues.push({
      path: `${pointer}/maxItems`,
      message: `arrays require maxItems <= ${HOMERAIL_PLUGIN_SCHEMA_MAX_ARRAY_ITEMS}`,
      keyword: "schemaComplexity",
    });
    if (object.type === "string" && !Array.isArray(object.enum) && !("const" in object) && (
      !Number.isSafeInteger(object.maxLength)
      || Number(object.maxLength) < 0
      || Number(object.maxLength) > HOMERAIL_PLUGIN_SCHEMA_MAX_STRING_LENGTH
    )) issues.push({
      path: `${pointer}/maxLength`,
      message: `strings require maxLength <= ${HOMERAIL_PLUGIN_SCHEMA_MAX_STRING_LENGTH}`,
      keyword: "schemaComplexity",
    });
    if (object.type === "object") {
      if (
        object.additionalProperties !== false
        && !(
          object.additionalProperties === true
          && Number.isSafeInteger(object.maxProperties)
          && Number(object.maxProperties) >= 0
          && Number(object.maxProperties) <= HOMERAIL_PLUGIN_SCHEMA_MAX_PROPERTIES
        )
      ) issues.push({
        path: `${pointer}/additionalProperties`,
        message: `objects must be closed or bound maxProperties <= ${HOMERAIL_PLUGIN_SCHEMA_MAX_PROPERTIES}`,
        keyword: "schemaComplexity",
      });
      const propertyCount = object.properties && typeof object.properties === "object" && !Array.isArray(object.properties)
        ? Object.keys(object.properties as Record<string, unknown>).length
        : 0;
      if (propertyCount > HOMERAIL_PLUGIN_SCHEMA_MAX_PROPERTIES) issues.push({
        path: `${pointer}/properties`,
        message: `objects may declare at most ${HOMERAIL_PLUGIN_SCHEMA_MAX_PROPERTIES} properties`,
        keyword: "schemaComplexity",
      });
      if (Array.isArray(object.required) && object.required.length > HOMERAIL_PLUGIN_SCHEMA_MAX_PROPERTIES) {
        complexity(`${pointer}/required`, `required may contain at most ${HOMERAIL_PLUGIN_SCHEMA_MAX_PROPERTIES} fields`);
      }
      if (object.additionalProperties !== undefined && typeof object.additionalProperties !== "boolean") {
        complexity(`${pointer}/additionalProperties`, "additionalProperties must be a boolean in the M4 profile");
      }
    }
    if (Array.isArray(object.enum) && object.enum.length > HOMERAIL_PLUGIN_SCHEMA_MAX_ENUM_VALUES) issues.push({
      path: `${pointer}/enum`,
      message: `enum may contain at most ${HOMERAIL_PLUGIN_SCHEMA_MAX_ENUM_VALUES} values`,
      keyword: "schemaComplexity",
    });
    if (object.properties && typeof object.properties === "object" && !Array.isArray(object.properties)) {
      for (const [key, child] of Object.entries(object.properties as Record<string, unknown>)) {
        visit(child, `${pointer}/properties/${pointerToken(key)}`);
      }
    }
    if (object.items !== undefined) {
      if (Array.isArray(object.items)) complexity(`${pointer}/items`, "tuple schemas are outside the bounded M4 profile");
      else visit(object.items, `${pointer}/items`);
    }
    if (object.definitions && typeof object.definitions === "object" && !Array.isArray(object.definitions)) {
      const definitions = Object.entries(object.definitions as Record<string, unknown>);
      if (definitions.length > HOMERAIL_PLUGIN_SCHEMA_MAX_PROPERTIES) {
        complexity(`${pointer}/definitions`, `definitions may contain at most ${HOMERAIL_PLUGIN_SCHEMA_MAX_PROPERTIES} schemas`);
      }
      for (const [key, child] of definitions) visit(child, `${pointer}/definitions/${pointerToken(key)}`);
    }
  };
  visit(schema, "");
  return issues;
}
