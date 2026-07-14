/**
 * Draft-07 JSON Schemas for the Generative UI semantic protocol.
 * @version 0.1.0
 */

import {
  GENERATIVE_UI_COMPOSITION_VERSION,
  GENERATIVE_UI_IR_VERSION,
  GenerativeUiActionStyle,
  GenerativeUiAttention,
  GenerativeUiActorType,
  GenerativeUiCanvasSize,
  GenerativeUiDensity,
  GenerativeUiDevice,
  GenerativeUiDocumentScopeType,
  GenerativeUiImportance,
  GenerativeUiInputModality,
  GenerativeUiMotionProfile,
  GenerativeUiPlacement,
  GenerativeUiPersistence,
  GenerativeUiPhase,
  GenerativeUiPatchUnsetField,
  GenerativeUiSurface,
  GenerativeUiViewport,
  GenerativeUiVisibility,
} from "./types.js";
import {
  HOMERAIL_A2UI_CATALOG_ID,
  HOMERAIL_A2UI_MAX_COMPONENTS,
  HOMERAIL_A2UI_MAX_DIRECT_CHILDREN,
  HOMERAIL_A2UI_MAX_SOURCE_ITEMS,
  HOMERAIL_A2UI_VERSION,
} from "./a2ui.js";
import { HOMERAIL_VIEW_SPEC_VERSION } from "./view-spec.js";

const opaqueId = {
  type: "string",
  minLength: 1,
  maxLength: 256,
  pattern: "^(?!\\s*$)[^\\u0000-\\u001F\\u007F]+$",
} as const;
const identifier = {
  type: "string",
  minLength: 1,
  maxLength: 160,
  pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]*$",
} as const;
const dateTime = {
  type: "string",
  maxLength: 40,
  pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d+)?(?:Z|[+-]\\d{2}:\\d{2})$",
} as const;
const pluginId = {
  type: "string",
  minLength: 3,
  maxLength: 160,
  pattern: "^[a-z0-9]+(?:[.-][a-z0-9]+)+$",
} as const;
const semanticKind = {
  type: "string",
  minLength: 5,
  maxLength: 200,
  pattern: "^[a-z0-9]+(?:[.-][a-z0-9]+)+/[a-z][a-z0-9._-]*$",
} as const;
const irVersion = { const: GENERATIVE_UI_IR_VERSION } as const;
const surface = { type: "string", enum: Object.values(GenerativeUiSurface) } as const;
const importance = { type: "string", enum: Object.values(GenerativeUiImportance) } as const;
const viewPointer = {
  type: "string",
  maxLength: 500,
  pattern: "^(?:/(?:[^~/]|~[01])*)*$",
} as const;
const viewValueSchema = {
  $id: "homerail-view-value-v1",
  oneOf: [
    {
      type: "object",
      properties: { literal: { type: ["string", "number", "boolean"] } },
      required: ["literal"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        path: viewPointer,
        format: { type: "string", enum: ["text", "number", "percent", "datetime", "duration", "status", "tone"] },
      },
      required: ["path"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        item_path: viewPointer,
        format: { type: "string", enum: ["text", "number", "percent", "datetime", "duration", "status", "tone"] },
      },
      required: ["item_path"],
      additionalProperties: false,
    },
  ],
} as const;
const viewToneSchema = {
  oneOf: [
    { type: "string", enum: ["neutral", "info", "positive", "warning", "critical"] },
    { $ref: "homerail-view-value-v1" },
  ],
} as const;
const viewPredicateSchema = {
  type: "object",
  properties: {
    path: viewPointer,
    item_path: viewPointer,
    operator: { type: "string", enum: ["exists", "not_empty", "equals", "not_equals", "gt", "gte", "lt", "lte"] },
    value: { type: ["string", "number", "boolean"] },
  },
  required: ["operator"],
  additionalProperties: false,
} as const;
const viewTableColumnSchema = {
  type: "object",
  properties: {
    id: identifier,
    label: { type: "string", minLength: 1, maxLength: 80 },
    path: viewPointer,
    format: { type: "string", enum: ["text", "number", "percent", "datetime", "duration", "status", "tone"] },
  },
  required: ["id", "label", "path"],
  additionalProperties: false,
} as const;

/** Historical closed primitive vocabulary for persisted generated_view@1 nodes. */
export const homerailViewNodeSchema = {
  $id: "homerail-view-node-v1",
  type: "object",
  properties: {
    id: identifier,
    type: { type: "string", enum: [
      "stack", "grid", "section", "heading", "text", "markdown", "icon", "badge", "divider",
      "metric", "progress", "list", "table", "timeline", "bar_chart", "dag", "action", "disclosure", "link", "artifact", "repeat",
    ] },
    span: { type: "integer", minimum: 1, maximum: 3 },
    when: viewPredicateSchema,
    children: { type: "array", minItems: 1, maxItems: 24, items: { $ref: "homerail-view-node-v1" } },
    item: { $ref: "homerail-view-node-v1" },
    gap: { type: "string", enum: ["none", "xs", "sm", "md", "lg"] },
    align: { type: "string", enum: ["start", "center", "end", "stretch"] },
    columns: {
      oneOf: [
        {
          type: "object",
          properties: {
            default: { type: "integer", minimum: 1, maximum: 3 },
            compact: { type: "integer", minimum: 1, maximum: 2 },
          },
          required: ["default"],
          additionalProperties: false,
        },
        { type: "array", minItems: 1, maxItems: 8, items: viewTableColumnSchema },
      ],
    },
    title: { $ref: "homerail-view-value-v1" },
    text: { $ref: "homerail-view-value-v1" },
    label: { $ref: "homerail-view-value-v1" },
    value: { $ref: "homerail-view-value-v1" },
    unit: { $ref: "homerail-view-value-v1" },
    uri: { $ref: "homerail-view-value-v1" },
    description: { $ref: "homerail-view-value-v1" },
    alt: { $ref: "homerail-view-value-v1" },
    kind: { type: "string", enum: ["image", "html", "file"] },
    layout: { type: "string", enum: ["fluid", "portrait"] },
    tone: viewToneSchema,
    level: { type: "integer", minimum: 1, maximum: 3 },
    max_lines: { type: "integer", minimum: 1, maximum: 24 },
    name: { type: "string", enum: [
      "activity", "alert", "check", "clock", "database", "external-link", "file", "git", "monitor",
      "pause", "play", "search", "server", "settings", "shield", "sparkles", "user", "x",
    ] },
    source: viewPointer,
    max_items: { type: "integer", minimum: 1, maximum: 50 },
    item_title_path: viewPointer,
    item_detail_path: viewPointer,
    item_badge_path: viewPointer,
    item_status_path: viewPointer,
    item_time_path: viewPointer,
    item_label_path: viewPointer,
    item_value_path: viewPointer,
    item_tone_path: viewPointer,
    item_id_path: viewPointer,
    item_progress_path: viewPointer,
    item_depends_on_path: viewPointer,
    action_id: identifier,
    style: { type: "string", enum: ["primary", "secondary", "danger"] },
    open: { type: "boolean" },
  },
  required: ["id", "type"],
  additionalProperties: false,
} as const;

export const homerailViewSpecSchema = {
  $id: "homerail-view-spec-v1",
  type: "object",
  properties: {
    view_version: { const: HOMERAIL_VIEW_SPEC_VERSION },
    root: { $ref: "homerail-view-node-v1" },
  },
  required: ["view_version", "root"],
  additionalProperties: false,
} as const;
const a2uiPath = {
  type: "string",
  maxLength: 500,
  pattern: "^(?:(?:/(?:[^~/]|~[01])*)*|(?:[^~/]|~[01])+(?:/(?:[^~/]|~[01])*)*)$",
} as const;
const a2uiItemPointer = {
  type: "string",
  maxLength: 500,
  pattern: "^(?:/(?:[^~/]|~[01])*)*$",
} as const;
const a2uiShortString = { type: "string", maxLength: 4_000 } as const;
const a2uiWeight = { type: "number", minimum: 0, maximum: 100 } as const;

export const homerailA2uiDataBindingSchema = {
  $id: "homerail-a2ui-data-binding-v1",
  type: "object",
  properties: { path: a2uiPath },
  required: ["path"],
  additionalProperties: false,
} as const;

const dynamicValueRef = { $ref: "homerail-a2ui-dynamic-value-v1" } as const;
const dynamicStringRef = { $ref: "homerail-a2ui-dynamic-string-v1" } as const;
const dynamicNumberRef = { $ref: "homerail-a2ui-dynamic-number-v1" } as const;
const dynamicBooleanRef = { $ref: "homerail-a2ui-dynamic-boolean-v1" } as const;
const A2UI_COMMON_TYPES_SCHEMA = "https://a2ui.org/specification/v1_0/common_types.json";

function functionVariant(
  call: string,
  properties: Record<string, unknown>,
  required: readonly string[],
  options: { argsRequired?: boolean; anyOf?: readonly Record<string, unknown>[] } = {},
): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      call: { const: call },
      args: {
        type: "object",
        properties,
        required,
        ...(options.anyOf ? { anyOf: options.anyOf } : {}),
        additionalProperties: false,
      },
    },
    required: options.argsRequired === false ? ["call"] : ["call", "args"],
    additionalProperties: false,
  };
}

export const homerailA2uiFunctionCallSchema = {
  $id: "homerail-a2ui-function-call-v1",
  oneOf: [
    functionVariant("@index", { offset: dynamicNumberRef }, [], { argsRequired: false }),
    functionVariant("required", { value: {} }, ["value"]),
    functionVariant("length", {
      value: dynamicStringRef,
      min: { type: "integer", minimum: 0, maximum: 100_000 },
      max: { type: "integer", minimum: 0, maximum: 100_000 },
    }, ["value"], { anyOf: [{ required: ["min"] }, { required: ["max"] }] }),
    functionVariant("numeric", {
      value: dynamicNumberRef,
      min: { type: "number" },
      max: { type: "number" },
    }, ["value"], { anyOf: [{ required: ["min"] }, { required: ["max"] }] }),
    functionVariant("email", { value: dynamicStringRef }, ["value"]),
    functionVariant("formatString", { value: dynamicStringRef }, ["value"]),
    functionVariant("formatNumber", {
      value: dynamicNumberRef,
      decimals: dynamicNumberRef,
      grouping: dynamicBooleanRef,
    }, ["value"]),
    functionVariant("formatCurrency", {
      value: dynamicNumberRef,
      currency: dynamicStringRef,
      decimals: dynamicNumberRef,
      grouping: dynamicBooleanRef,
    }, ["value", "currency"]),
    functionVariant("formatDate", {
      value: dynamicValueRef,
      format: dynamicStringRef,
    }, ["value", "format"]),
    functionVariant("pluralize", {
      value: dynamicNumberRef,
      zero: dynamicStringRef,
      one: dynamicStringRef,
      two: dynamicStringRef,
      few: dynamicStringRef,
      many: dynamicStringRef,
      other: dynamicStringRef,
    }, ["value", "other"]),
    functionVariant("and", {
      values: { type: "array", minItems: 2, maxItems: HOMERAIL_A2UI_MAX_DIRECT_CHILDREN, items: dynamicBooleanRef },
    }, ["values"]),
    functionVariant("or", {
      values: { type: "array", minItems: 2, maxItems: HOMERAIL_A2UI_MAX_DIRECT_CHILDREN, items: dynamicBooleanRef },
    }, ["values"]),
    functionVariant("not", { value: dynamicBooleanRef }, ["value"]),
  ],
} as const;

const catalogFunctionMetadata = {
  required: { returnType: "boolean", description: "Checks that a value is present and non-empty." },
  length: { returnType: "boolean", description: "Checks a string against minimum or maximum length bounds." },
  numeric: { returnType: "boolean", description: "Checks a number against minimum or maximum bounds." },
  email: { returnType: "boolean", description: "Checks whether a string has a valid email shape." },
  formatString: { returnType: "string", description: "Interpolates JSON Pointer values into a string." },
  formatNumber: { returnType: "string", description: "Formats a number for the active locale." },
  formatCurrency: { returnType: "string", description: "Formats a number as an ISO 4217 currency." },
  formatDate: { returnType: "string", description: "Formats an ISO date or timestamp for the active locale." },
  pluralize: { returnType: "string", description: "Selects localized plural text for a numeric value." },
  and: { returnType: "boolean", description: "Returns true when every input is true." },
  or: { returnType: "boolean", description: "Returns true when any input is true." },
  not: { returnType: "boolean", description: "Negates a boolean value." },
} as const;

function catalogCompatibleSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(catalogCompatibleSchema);
  if (!value || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  return Object.fromEntries(Object.entries(record).map(([key, entry]) => {
    if (key !== "$ref" || typeof entry !== "string") return [key, catalogCompatibleSchema(entry)];
    const commonType = {
      "homerail-a2ui-data-binding-v1": "DataBinding",
      "homerail-a2ui-dynamic-value-v1": "DynamicValue",
      "homerail-a2ui-dynamic-string-v1": "DynamicString",
      "homerail-a2ui-dynamic-number-v1": "DynamicNumber",
      "homerail-a2ui-dynamic-boolean-v1": "DynamicBoolean",
      "homerail-a2ui-child-list-v1": "ChildList",
      "homerail-a2ui-action-v1": "Action",
    }[entry];
    return [key, commonType ? `${A2UI_COMMON_TYPES_SCHEMA}#/$defs/${commonType}` : entry];
  }));
}

function catalogFunctionEntry(variant: Record<string, unknown>): [string, Record<string, unknown>] | undefined {
  const properties = variant.properties as Record<string, unknown> | undefined;
  const call = properties?.call as { const?: unknown } | undefined;
  if (typeof call?.const !== "string" || call.const === "@index") return undefined;
  const metadata = catalogFunctionMetadata[call.const as keyof typeof catalogFunctionMetadata];
  if (!metadata) return undefined;
  return [call.const, {
    ...catalogCompatibleSchema(variant) as Record<string, unknown>,
    description: metadata.description,
    returnType: metadata.returnType,
    callableFrom: "clientOnly",
  }];
}

export const homerailA2uiCatalogFunctionSchemas = Object.fromEntries(
  homerailA2uiFunctionCallSchema.oneOf
    .map((variant) => catalogFunctionEntry(variant as Record<string, unknown>))
    .filter((entry): entry is [string, Record<string, unknown>] => Boolean(entry)),
) as Readonly<Record<string, Record<string, unknown>>>;

export const homerailA2uiDynamicValueSchema = {
  $id: "homerail-a2ui-dynamic-value-v1",
  oneOf: [
    { type: "string" },
    { type: "number" },
    { type: "boolean" },
    { type: "array" },
    { $ref: "homerail-a2ui-data-binding-v1" },
    { $ref: "homerail-a2ui-function-call-v1" },
  ],
} as const;

export const homerailA2uiDynamicStringSchema = {
  $id: "homerail-a2ui-dynamic-string-v1",
  oneOf: [
    a2uiShortString,
    { $ref: "homerail-a2ui-data-binding-v1" },
    { $ref: "homerail-a2ui-function-call-v1" },
  ],
} as const;

export const homerailA2uiDynamicNumberSchema = {
  $id: "homerail-a2ui-dynamic-number-v1",
  oneOf: [
    { type: "number" },
    { $ref: "homerail-a2ui-data-binding-v1" },
    { $ref: "homerail-a2ui-function-call-v1" },
  ],
} as const;

export const homerailA2uiDynamicBooleanSchema = {
  $id: "homerail-a2ui-dynamic-boolean-v1",
  oneOf: [
    { type: "boolean" },
    { $ref: "homerail-a2ui-data-binding-v1" },
    { $ref: "homerail-a2ui-function-call-v1" },
  ],
} as const;

const a2uiDynamicStringListSchema = {
  oneOf: [
    { type: "array", items: { type: "string", maxLength: 500 } },
    { $ref: "homerail-a2ui-data-binding-v1" },
    { $ref: "homerail-a2ui-function-call-v1" },
  ],
} as const;

export const homerailA2uiChildListSchema = {
  $id: "homerail-a2ui-child-list-v1",
  oneOf: [
    {
      type: "array",
      maxItems: HOMERAIL_A2UI_MAX_DIRECT_CHILDREN,
      items: identifier,
    },
    {
      type: "object",
      properties: { componentId: identifier, path: a2uiPath },
      required: ["componentId", "path"],
      additionalProperties: false,
    },
  ],
} as const;

const a2uiAccessibilitySchema = {
  type: "object",
  properties: {
    label: dynamicStringRef,
    description: dynamicStringRef,
  },
  additionalProperties: false,
} as const;

const a2uiCheckRuleSchema = {
  type: "object",
  properties: {
    condition: dynamicBooleanRef,
    message: { type: "string", minLength: 1, maxLength: 1_000 },
  },
  required: ["condition", "message"],
  additionalProperties: false,
} as const;

export const homerailA2uiActionSchema = {
  $id: "homerail-a2ui-action-v1",
  oneOf: [
    {
      type: "object",
      properties: {
        event: {
          type: "object",
          properties: {
            name: identifier,
            context: {
              type: "object",
              maxProperties: 64,
              additionalProperties: dynamicValueRef,
            },
            wantResponse: { type: "boolean" },
            responsePath: a2uiPath,
          },
          required: ["name"],
          additionalProperties: false,
        },
      },
      required: ["event"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: { functionCall: { $ref: "homerail-a2ui-function-call-v1" } },
      required: ["functionCall"],
      additionalProperties: false,
    },
  ],
} as const;

const a2uiIconNames = [
  "accountCircle", "add", "arrowBack", "arrowForward", "attachFile", "calendarToday", "call",
  "camera", "check", "close", "delete", "download", "edit", "event", "error", "fastForward",
  "favorite", "favoriteOff", "folder", "help", "home", "info", "locationOn", "lock", "lockOpen",
  "mail", "menu", "moreVert", "moreHoriz", "notificationsOff", "notifications", "pause", "payment",
  "person", "phone", "photo", "play", "print", "refresh", "rewind", "search", "send", "settings",
  "share", "shoppingCart", "skipNext", "skipPrevious", "star", "starHalf", "starOff", "stop", "upload",
  "visibility", "visibilityOff", "volumeDown", "volumeMute", "volumeOff", "volumeUp", "warning",
] as const;
const a2uiTone = {
  oneOf: [
    { type: "string", enum: ["neutral", "info", "positive", "warning", "critical"] },
    { $ref: "homerail-a2ui-data-binding-v1" },
    { $ref: "homerail-a2ui-function-call-v1" },
  ],
} as const;
const a2uiChildrenRef = { $ref: "homerail-a2ui-child-list-v1" } as const;
const a2uiSourceRef = { $ref: "homerail-a2ui-data-binding-v1" } as const;
const a2uiChecks = {
  type: "array",
  maxItems: HOMERAIL_A2UI_MAX_DIRECT_CHILDREN,
  items: a2uiCheckRuleSchema,
} as const;

function componentSchema(
  name: string,
  properties: Record<string, unknown>,
  required: readonly string[],
  options: {
    weighted?: boolean;
    checkable?: boolean;
    constraints?: Record<string, unknown>;
  } = {},
): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      id: identifier,
      component: { const: name },
      accessibility: a2uiAccessibilitySchema,
      ...(options.weighted ? { weight: a2uiWeight } : {}),
      ...(options.checkable ? { checks: a2uiChecks } : {}),
      ...properties,
    },
    required: ["id", "component", ...required],
    additionalProperties: false,
    ...options.constraints,
  };
}

const basicComponentSchemas = [
  componentSchema("Text", {
    text: dynamicStringRef,
    variant: { type: "string", enum: ["caption", "body"] },
  }, ["text"], { weighted: true }),
  componentSchema("Image", {
    url: dynamicStringRef,
    description: dynamicStringRef,
    fit: { type: "string", enum: ["contain", "cover", "fill", "none", "scaleDown"] },
    variant: { type: "string", enum: ["icon", "avatar", "smallFeature", "mediumFeature", "largeFeature", "header"] },
  }, ["url"], { weighted: true }),
  componentSchema("Icon", {
    name: {
      oneOf: [
        { type: "string", enum: a2uiIconNames },
        { $ref: "homerail-a2ui-data-binding-v1" },
      ],
    },
  }, ["name"], { weighted: true }),
  componentSchema("Video", { url: dynamicStringRef, posterUrl: dynamicStringRef }, ["url"], { weighted: true }),
  componentSchema("AudioPlayer", { url: dynamicStringRef, description: dynamicStringRef }, ["url"], { weighted: true }),
  componentSchema("Row", {
    children: a2uiChildrenRef,
    justify: { type: "string", enum: ["center", "end", "spaceAround", "spaceBetween", "spaceEvenly", "start", "stretch"] },
    align: { type: "string", enum: ["start", "center", "end", "stretch"] },
  }, ["children"], { weighted: true }),
  componentSchema("Column", {
    children: a2uiChildrenRef,
    justify: { type: "string", enum: ["start", "center", "end", "spaceBetween", "spaceAround", "spaceEvenly", "stretch"] },
    align: { type: "string", enum: ["start", "center", "end", "stretch"] },
  }, ["children"], { weighted: true }),
  componentSchema("List", {
    children: a2uiChildrenRef,
    direction: { type: "string", enum: ["vertical", "horizontal"] },
    align: { type: "string", enum: ["start", "center", "end", "stretch"] },
  }, ["children"], { weighted: true }),
  componentSchema("Card", { child: identifier }, ["child"], { weighted: true }),
  componentSchema("Tabs", {
    tabs: {
      type: "array",
      minItems: 1,
      maxItems: HOMERAIL_A2UI_MAX_DIRECT_CHILDREN,
      items: {
        type: "object",
        properties: { title: dynamicStringRef, child: identifier },
        required: ["title", "child"],
        additionalProperties: false,
      },
    },
  }, ["tabs"], { weighted: true }),
  componentSchema("Modal", { trigger: identifier, content: identifier }, ["trigger", "content"], { weighted: true }),
  componentSchema("Divider", {
    axis: { type: "string", enum: ["horizontal", "vertical"] },
  }, [], { weighted: true }),
  componentSchema("Button", {
    child: identifier,
    variant: { type: "string", enum: ["default", "primary", "borderless"] },
    action: { $ref: "homerail-a2ui-action-v1" },
  }, ["child", "action"], { weighted: true, checkable: true }),
  componentSchema("TextField", {
    label: dynamicStringRef,
    value: dynamicStringRef,
    placeholder: dynamicStringRef,
    variant: { type: "string", enum: ["longText", "number", "shortText", "obscured"] },
  }, ["label"], { weighted: true, checkable: true }),
  componentSchema("CheckBox", {
    label: dynamicStringRef,
    value: dynamicBooleanRef,
  }, ["label", "value"], { weighted: true, checkable: true }),
  componentSchema("ChoicePicker", {
    label: dynamicStringRef,
    variant: { type: "string", enum: ["multipleSelection", "mutuallyExclusive"] },
    options: {
      type: "array",
      maxItems: HOMERAIL_A2UI_MAX_SOURCE_ITEMS,
      items: {
        type: "object",
        properties: { label: dynamicStringRef, value: { type: "string", maxLength: 500 } },
        required: ["label", "value"],
        additionalProperties: false,
      },
    },
    value: a2uiDynamicStringListSchema,
    displayStyle: { type: "string", enum: ["checkbox", "chips"] },
    filterable: { type: "boolean" },
  }, ["options", "value"], { weighted: true, checkable: true }),
  componentSchema("Slider", {
    label: dynamicStringRef,
    min: { type: "number" },
    max: { type: "number" },
    value: dynamicNumberRef,
    steps: { type: "integer", minimum: 1, maximum: 10_000 },
  }, ["max", "value"], { weighted: true, checkable: true }),
  componentSchema("DateTimeInput", {
    value: dynamicStringRef,
    enableDate: { type: "boolean" },
    enableTime: { type: "boolean" },
    min: dynamicStringRef,
    max: dynamicStringRef,
    label: dynamicStringRef,
  }, ["value"], {
    weighted: true,
    checkable: true,
    constraints: {
      anyOf: [
        { properties: { enableDate: { const: true } }, required: ["enableDate"] },
        { properties: { enableTime: { const: true } }, required: ["enableTime"] },
      ],
    },
  }),
];

const gridColumnsSchema = {
  type: "object",
  properties: {
    default: { type: "integer", minimum: 1, maximum: 3 },
    compact: { type: "integer", minimum: 1, maximum: 3 },
  },
  required: ["default", "compact"],
  additionalProperties: false,
} as const;
const gapSchema = { type: "string", enum: ["none", "xs", "sm", "md", "lg"] } as const;
const alignSchema = { type: "string", enum: ["start", "center", "end", "stretch"] } as const;
const maxItemsSchema = { type: "integer", minimum: 1, maximum: HOMERAIL_A2UI_MAX_SOURCE_ITEMS } as const;
const sourceProperties = { source: a2uiSourceRef, maxItems: maxItemsSchema } as const;
const tableColumnSchema = {
  type: "object",
  properties: {
    id: identifier,
    label: { type: "string", minLength: 1, maxLength: 80 },
    path: a2uiItemPointer,
    format: { type: "string", enum: ["text", "number", "percent", "datetime", "duration", "status", "tone"] },
  },
  required: ["id", "label", "path"],
  additionalProperties: false,
} as const;

const homerailComponentSchemas = [
  componentSchema("HrGrid", {
    children: a2uiChildrenRef,
    columns: gridColumnsSchema,
    gap: gapSchema,
    align: alignSchema,
  }, ["children", "columns"]),
  componentSchema("HrGridItem", {
    child: identifier,
    span: { type: "integer", minimum: 1, maximum: 3 },
  }, ["child", "span"]),
  componentSchema("HrSection", {
    title: dynamicStringRef,
    children: a2uiChildrenRef,
    tone: a2uiTone,
  }, ["children"]),
  componentSchema("HrMetric", {
    label: dynamicStringRef,
    value: dynamicValueRef,
    unit: dynamicStringRef,
    tone: a2uiTone,
  }, ["label", "value"]),
  componentSchema("HrStatusBadge", { text: dynamicStringRef, tone: a2uiTone }, ["text"]),
  componentSchema("HrProgress", {
    label: dynamicStringRef,
    value: dynamicNumberRef,
    tone: a2uiTone,
  }, ["value"]),
  componentSchema("HrStep", {
    index: dynamicValueRef,
    label: dynamicStringRef,
    detail: dynamicStringRef,
    tone: a2uiTone,
    child: identifier,
  }, ["index", "label", "child"]),
  componentSchema("HrList", {
    ...sourceProperties,
    itemTitlePath: a2uiItemPointer,
    itemDetailPath: a2uiItemPointer,
    itemBadgePath: a2uiItemPointer,
    itemStatusPath: a2uiItemPointer,
  }, ["source", "itemTitlePath"]),
  componentSchema("HrTable", {
    ...sourceProperties,
    columns: { type: "array", minItems: 1, maxItems: HOMERAIL_A2UI_MAX_DIRECT_CHILDREN, items: tableColumnSchema },
  }, ["source", "columns"]),
  componentSchema("HrTimeline", {
    ...sourceProperties,
    itemTitlePath: a2uiItemPointer,
    itemDetailPath: a2uiItemPointer,
    itemTimePath: a2uiItemPointer,
    itemStatusPath: a2uiItemPointer,
  }, ["source", "itemTitlePath"]),
  componentSchema("HrBarChart", {
    ...sourceProperties,
    itemLabelPath: a2uiItemPointer,
    itemValuePath: a2uiItemPointer,
    itemTonePath: a2uiItemPointer,
  }, ["source", "itemLabelPath", "itemValuePath"]),
  componentSchema("HrDag", {
    ...sourceProperties,
    itemIdPath: a2uiItemPointer,
    itemLabelPath: a2uiItemPointer,
    itemDetailPath: a2uiItemPointer,
    itemStatusPath: a2uiItemPointer,
    itemProgressPath: a2uiItemPointer,
    itemDependsOnPath: a2uiItemPointer,
  }, ["source", "itemIdPath", "itemLabelPath", "itemDependsOnPath"]),
  componentSchema("HrDisclosure", {
    title: dynamicStringRef,
    children: a2uiChildrenRef,
    open: dynamicBooleanRef,
  }, ["title", "children"]),
  componentSchema("HrLink", {
    label: dynamicStringRef,
    url: dynamicStringRef,
    description: dynamicStringRef,
  }, ["label", "url"]),
  componentSchema("HrArtifact", {
    kind: { type: "string", enum: ["image", "html", "file"] },
    uri: dynamicStringRef,
    title: dynamicStringRef,
    description: dynamicStringRef,
    alt: dynamicStringRef,
    layout: { type: "string", enum: ["fluid", "portrait"] },
  }, ["kind", "uri"]),
  componentSchema("HrIf", {
    condition: dynamicBooleanRef,
    children: a2uiChildrenRef,
  }, ["condition", "children"]),
];

const componentDescriptions: Readonly<Record<string, string>> = {
  HrGrid: "Responsive one-to-three column layout for a compact HomeRail Block.",
  HrGridItem: "One child placed in a bounded span of a HomeRail grid.",
  HrSection: "A titled semantic section with an optional status tone.",
  HrMetric: "A compact label, value, and optional unit for scannable facts.",
  HrStatusBadge: "A short status label using HomeRail semantic tones.",
  HrProgress: "A bounded zero-to-one-hundred progress indicator.",
  HrStep: "One ordered step with a connected marker and arbitrary rich child content.",
  HrList: "A dense data-bound list rendered without expanding a component template.",
  HrTable: "A compact data-bound table with typed column formatting.",
  HrTimeline: "A chronological data-bound sequence of events or steps.",
  HrBarChart: "A compact categorical bar chart for numeric comparisons.",
  HrDag: "A compact dependency graph for plans and execution state.",
  HrDisclosure: "A summary that reveals secondary detail on demand.",
  HrLink: "A labelled, credential-free HTTP(S) reference that opens outside HomeRail.",
  HrArtifact: "A passive preview reference to a HomeRail-published image, HTML page, or file.",
  HrIf: "Conditionally renders children from a deterministic boolean binding.",
};

function catalogComponentEntry(schema: Record<string, unknown>): [string, Record<string, unknown>] {
  const properties = schema.properties as Record<string, unknown>;
  const component = properties.component as { const: string };
  const checkable = Object.prototype.hasOwnProperty.call(properties, "checks");
  const bodyProperties = Object.fromEntries(Object.entries(properties)
    .filter(([name]) => name !== "id" && name !== "accessibility" && name !== "checks")
    .map(([name, value]) => [name, catalogCompatibleSchema(value)]));
  const bodyRequired = (schema.required as string[]).filter((name) => name !== "id" && name !== "checks");
  const bodyConstraints = Object.fromEntries(Object.entries(schema)
    .filter(([name]) => !["type", "properties", "required", "additionalProperties"].includes(name))
    .map(([name, value]) => [name, catalogCompatibleSchema(value)]));
  return [component.const, {
    type: "object",
    description: componentDescriptions[component.const] ?? `A2UI ${component.const} component.`,
    allOf: [
      { $ref: `${A2UI_COMMON_TYPES_SCHEMA}#/$defs/ComponentCommon` },
      ...(checkable ? [{ $ref: `${A2UI_COMMON_TYPES_SCHEMA}#/$defs/Checkable` }] : []),
      {
        type: "object",
        properties: bodyProperties,
        required: bodyRequired,
        ...bodyConstraints,
      },
    ],
    unevaluatedProperties: false,
  }];
}

export const homerailA2uiCatalogComponentSchemas = Object.fromEntries(
  [...basicComponentSchemas, ...homerailComponentSchemas]
    .map((schema) => catalogComponentEntry(schema as Record<string, unknown>)),
) as Readonly<Record<string, Record<string, unknown>>>;

export const homerailA2uiComponentSchema = {
  $id: "homerail-a2ui-component-v1",
  oneOf: [...basicComponentSchemas, ...homerailComponentSchemas],
} as const;

export const homerailA2uiSurfacePropertiesSchema = {
  $id: "homerail-a2ui-surface-properties-v1",
  type: "object",
  properties: {
    iconUrl: { type: "string", minLength: 1, maxLength: 2_048 },
    agentDisplayName: { type: "string", minLength: 1, maxLength: 200 },
  },
  additionalProperties: false,
} as const;

export const homerailA2uiCatalogDefinition = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: HOMERAIL_A2UI_CATALOG_ID,
  title: "HomeRail A2UI Core Catalog",
  description: "A2UI v1.0 Basic components plus bounded HomeRail components for dense, responsive agent interfaces.",
  catalogId: HOMERAIL_A2UI_CATALOG_ID,
  instructions: [
    "Use a flat A2UI component graph with exactly one root component.",
    "Prefer one coherent Block per user intent and use HomeRail components for metrics, status, progress, lists, tables, timelines, charts, DAGs, disclosures, safe source links, and published artifacts.",
    "Use only semantic tones and bounded grid spans; do not emit HTML, CSS, JavaScript, coordinates, or arbitrary style values.",
    "Action events must target host-registered HomeRail actions. The HomeRail host rejects local function actions, event context, response paths, and response requests.",
  ].join("\n\n"),
  $defs: {
    surfaceProperties: Object.fromEntries(Object.entries(homerailA2uiSurfacePropertiesSchema)
      .filter(([name]) => name !== "$id")),
    anyComponent: {
      oneOf: Object.keys(homerailA2uiCatalogComponentSchemas)
        .map((name) => ({ $ref: `#/components/${name}` })),
    },
    anyFunction: {
      oneOf: Object.keys(homerailA2uiCatalogFunctionSchemas)
        .map((name) => ({ $ref: `#/functions/${name}` })),
    },
  },
  components: homerailA2uiCatalogComponentSchemas,
  functions: homerailA2uiCatalogFunctionSchemas,
} as const;

export const homerailA2uiSurfaceSchema = {
  $id: "homerail-a2ui-surface-v1",
  type: "object",
  properties: {
    version: { const: HOMERAIL_A2UI_VERSION },
    catalogId: { const: HOMERAIL_A2UI_CATALOG_ID },
    components: {
      type: "array",
      minItems: 1,
      maxItems: HOMERAIL_A2UI_MAX_COMPONENTS,
      items: { $ref: "homerail-a2ui-component-v1" },
    },
    surfaceProperties: { $ref: "homerail-a2ui-surface-properties-v1" },
  },
  required: ["version", "catalogId", "components"],
  additionalProperties: false,
} as const;

export const homerailA2uiCreateSurfaceMessageSchema = {
  $id: "homerail-a2ui-create-surface-message-v1",
  type: "object",
  properties: {
    version: { const: HOMERAIL_A2UI_VERSION },
    createSurface: {
      type: "object",
      properties: {
        surfaceId: opaqueId,
        catalogId: { const: HOMERAIL_A2UI_CATALOG_ID },
        surfaceProperties: { $ref: "homerail-a2ui-surface-properties-v1" },
        sendDataModel: { type: "boolean" },
        components: {
          type: "array",
          minItems: 1,
          maxItems: HOMERAIL_A2UI_MAX_COMPONENTS,
          items: { $ref: "homerail-a2ui-component-v1" },
        },
        dataModel: { type: "object", maxProperties: 128, additionalProperties: true },
      },
      required: ["surfaceId", "catalogId"],
      additionalProperties: false,
    },
  },
  required: ["version", "createSurface"],
  additionalProperties: false,
} as const;

const pluginRefSchema = {
  type: "object",
  properties: {
    id: pluginId,
    version: { type: "string", minLength: 1, maxLength: 64 },
  },
  required: ["id", "version"],
  additionalProperties: false,
} as const;

const statusSchema = {
  type: "object",
  properties: {
    phase: { type: "string", enum: Object.values(GenerativeUiPhase) },
    label: { type: "string", maxLength: 160 },
    progress: { type: "number", minimum: 0, maximum: 100 },
  },
  required: ["phase"],
  additionalProperties: false,
} as const;

const presentationSchema = {
  type: "object",
  properties: {
    density: { type: "string", enum: Object.values(GenerativeUiDensity) },
    canvas_size: { type: "string", enum: Object.values(GenerativeUiCanvasSize) },
    motion_profile: { type: "string", enum: Object.values(GenerativeUiMotionProfile) },
    preferred_visual: { type: "string", minLength: 1, maxLength: 80 },
  },
  additionalProperties: false,
} as const;

const lifecycleSchema = {
  type: "object",
  properties: {
    persistence: { type: "string", enum: Object.values(GenerativeUiPersistence) },
    default_visibility: { type: "string", enum: Object.values(GenerativeUiVisibility) },
    expires_at: dateTime,
    removable: { type: "boolean" },
  },
  required: ["persistence"],
  additionalProperties: false,
} as const;

const artifactRefSchema = {
  type: "object",
  properties: {
    label: { type: "string", minLength: 1, maxLength: 200 },
    uri: {
      type: "string",
      minLength: 1,
      maxLength: 2048,
      pattern: "^(?![\\s])(?![\\\\/]{2})(?!\\\\)(?!.*[\\s]$)(?:[Hh][Tt][Tt][Pp][Ss]?://[^\\s\\\\\\u0000-\\u001F\\u007F]+|[Aa][Rr][Tt][Ii][Ff][Aa][Cc][Tt]:[A-Za-z0-9][A-Za-z0-9._~/%-]*|[A-Za-z]:[\\\\/](?![\\\\/])[^\\u0000-\\u001F\\u007F]*|[^:\\u0000-\\u001F\\u007F]+)$",
    },
    media_type: { type: "string", minLength: 1, maxLength: 160 },
  },
  required: ["label", "uri"],
  additionalProperties: false,
} as const;

const fallbackSchema = {
  type: "object",
  properties: {
    title: { type: "string", minLength: 1, maxLength: 200 },
    summary: { type: "string", maxLength: 4000 },
    items: { type: "array", maxItems: 16, items: { type: "string", maxLength: 500 } },
    artifact_refs: { type: "array", maxItems: 16, items: artifactRefSchema },
  },
  required: ["title"],
  additionalProperties: false,
} as const;

const confirmationSchema = {
  type: "object",
  properties: {
    required: { type: "boolean" },
    message: { type: "string", maxLength: 1000 },
  },
  required: ["required"],
  additionalProperties: false,
} as const;

const actionSchema = {
  type: "object",
  properties: {
    id: identifier,
    label: { type: "string", minLength: 1, maxLength: 120 },
    intent: identifier,
    arguments: { type: "object", maxProperties: 64, additionalProperties: true },
    style: { type: "string", enum: Object.values(GenerativeUiActionStyle) },
    confirmation: confirmationSchema,
  },
  required: ["id", "label", "intent"],
  additionalProperties: false,
} as const;

const provenanceSchema = {
  type: "object",
  properties: {
    actor: { type: "string", enum: Object.values(GenerativeUiActorType) },
    actor_id: opaqueId,
    plugin: pluginRefSchema,
    skill_id: identifier,
    turn_id: identifier,
    run_id: identifier,
  },
  required: ["actor"],
  additionalProperties: false,
} as const;

const nodeProperties = {
  ir_version: irVersion,
  id: opaqueId,
  kind: semanticKind,
  kind_version: { type: "integer", minimum: 1 },
  owner: pluginRefSchema,
  surface,
  importance,
  status: statusSchema,
  content: { type: "object", maxProperties: 128, additionalProperties: true },
  view: { $ref: "homerail-view-spec-v1" },
  a2ui: { $ref: "homerail-a2ui-surface-v1" },
  presentation: presentationSchema,
  lifecycle: lifecycleSchema,
  actions: { type: "array", maxItems: 12, items: actionSchema },
  fallback: fallbackSchema,
  provenance: provenanceSchema,
} as const;

const nodeRequired = [
  "ir_version",
  "id",
  "kind",
  "kind_version",
  "owner",
  "surface",
  "importance",
  "content",
  "fallback",
] as const;

export const generativeUiNodeSchema = {
  $id: "generative-ui-node",
  type: "object",
  properties: nodeProperties,
  required: nodeRequired,
  additionalProperties: false,
} as const;

export const generativeUiStoredNodeSchema = {
  $id: "generative-ui-stored-node",
  type: "object",
  properties: {
    ...nodeProperties,
    revision: { type: "integer", minimum: 1 },
    updated_at: dateTime,
  },
  required: [...nodeRequired, "revision", "updated_at"],
  additionalProperties: false,
} as const;

const documentScopeSchema = {
  type: "object",
  properties: {
    type: { type: "string", enum: Object.values(GenerativeUiDocumentScopeType) },
    id: opaqueId,
  },
  required: ["type", "id"],
  additionalProperties: false,
} as const;

export const generativeUiDocumentSchema = {
  $id: "generative-ui-document",
  type: "object",
  properties: {
    ir_version: irVersion,
    document_id: opaqueId,
    scope: documentScopeSchema,
    revision: { type: "integer", minimum: 0 },
    nodes: { type: "array", maxItems: 128, items: { $ref: "generative-ui-stored-node" } },
    updated_at: dateTime,
  },
  required: [
    "ir_version",
    "document_id",
    "scope",
    "revision",
    "nodes",
    "updated_at",
  ],
  additionalProperties: false,
} as const;

const patchSchema = {
  type: "object",
  properties: {
    surface,
    importance,
    status: statusSchema,
    content: { type: "object", maxProperties: 128, additionalProperties: true },
    view: { $ref: "homerail-view-spec-v1" },
    a2ui: { $ref: "homerail-a2ui-surface-v1" },
    presentation: presentationSchema,
    lifecycle: lifecycleSchema,
    actions: { type: "array", maxItems: 12, items: actionSchema },
    fallback: fallbackSchema,
    provenance: provenanceSchema,
    unset: {
      type: "array",
      minItems: 1,
      uniqueItems: true,
      items: { type: "string", enum: Object.values(GenerativeUiPatchUnsetField) },
    },
  },
  minProperties: 1,
  additionalProperties: false,
} as const;

const actorSchema = {
  type: "object",
  properties: {
    type: { type: "string", enum: Object.values(GenerativeUiActorType) },
    id: identifier,
    plugin: pluginRefSchema,
    skill_id: identifier,
    turn_id: identifier,
  },
  required: ["type"],
  additionalProperties: false,
} as const;

export const generativeUiTransactionSchema = {
  $id: "generative-ui-transaction",
  type: "object",
  properties: {
    ir_version: irVersion,
    transaction_id: identifier,
    document_id: opaqueId,
    base_revision: { type: "integer", minimum: 0 },
    actor: actorSchema,
    operations: {
      type: "array",
      minItems: 1,
      maxItems: 32,
      items: {
        oneOf: [
          {
            type: "object",
            properties: {
              op: { const: "put" },
              node: { $ref: "generative-ui-node" },
            },
            required: ["op", "node"],
            additionalProperties: false,
          },
          {
            type: "object",
            properties: {
              op: { const: "patch" },
              node_id: opaqueId,
              if_revision: { type: "integer", minimum: 1 },
              changes: patchSchema,
            },
            required: ["op", "node_id", "changes"],
            additionalProperties: false,
          },
          {
            type: "object",
            properties: {
              op: { const: "remove" },
              node_id: opaqueId,
              if_revision: { type: "integer", minimum: 1 },
            },
            required: ["op", "node_id"],
            additionalProperties: false,
          },
        ],
      },
    },
    created_at: dateTime,
  },
  required: [
    "ir_version",
    "transaction_id",
    "document_id",
    "base_revision",
    "actor",
    "operations",
    "created_at",
  ],
  additionalProperties: false,
} as const;

export const generativeUiUserOverrideSchema = {
  $id: "generative-ui-user-override",
  type: "object",
  properties: {
    document_id: opaqueId,
    node_id: opaqueId,
    visibility: { type: "string", enum: Object.values(GenerativeUiVisibility) },
    pinned: { type: "boolean" },
    preferred_surface: surface,
    updated_at: dateTime,
  },
  required: ["document_id", "node_id", "updated_at"],
  anyOf: [
    { required: ["visibility"] },
    { required: ["pinned"] },
    { required: ["preferred_surface"] },
  ],
  additionalProperties: false,
} as const;

const surfaceCapacitiesSchema = {
  type: "object",
  properties: Object.fromEntries(
    Object.values(GenerativeUiSurface).map((name) => [name, { type: "integer", minimum: 0, maximum: 128 }]),
  ),
  minProperties: 1,
  additionalProperties: false,
} as const;

export const generativeUiCompositionContextSchema = {
  $id: "generative-ui-composition-context",
  type: "object",
  properties: {
    device: { type: "string", enum: Object.values(GenerativeUiDevice) },
    input: { type: "string", enum: Object.values(GenerativeUiInputModality) },
    viewport: { type: "string", enum: Object.values(GenerativeUiViewport) },
    attention: { type: "string", enum: Object.values(GenerativeUiAttention) },
    active_run_id: identifier,
    active_session_id: opaqueId,
    surface_capacities: surfaceCapacitiesSchema,
  },
  required: ["device", "input", "viewport", "attention"],
  additionalProperties: false,
} as const;

const compositionItemSchema = {
  type: "object",
  properties: {
    node_id: opaqueId,
    node_revision: { type: "integer", minimum: 1 },
    surface,
    variant: { type: "string", enum: Object.values(GenerativeUiDensity) },
    rank: { type: "integer", minimum: 1, maximum: 128 },
    placement: { type: "string", enum: Object.values(GenerativeUiPlacement) },
    pinned: { type: "boolean" },
    visibility: {
      type: "string",
      enum: [GenerativeUiVisibility.VISIBLE, GenerativeUiVisibility.MINIMIZED],
    },
  },
  required: [
    "node_id",
    "node_revision",
    "surface",
    "variant",
    "rank",
    "placement",
    "pinned",
    "visibility",
  ],
  additionalProperties: false,
} as const;

export const generativeUiCompositionSchema = {
  $id: "generative-ui-composition",
  type: "object",
  properties: {
    composition_version: { const: GENERATIVE_UI_COMPOSITION_VERSION },
    document_id: opaqueId,
    document_revision: { type: "integer", minimum: 0 },
    context: { $ref: "generative-ui-composition-context" },
    items: { type: "array", maxItems: 128, items: compositionItemSchema },
    hidden_node_ids: { type: "array", maxItems: 128, items: opaqueId },
  },
  required: [
    "composition_version",
    "document_id",
    "document_revision",
    "context",
    "items",
    "hidden_node_ids",
  ],
  additionalProperties: false,
} as const;

export const generativeUiInteractionEventSchema = {
  $id: "generative-ui-interaction-event",
  type: "object",
  properties: {
    ir_version: irVersion,
    event_id: identifier,
    idempotency_key: identifier,
    document_id: opaqueId,
    node_id: opaqueId,
    node_revision: { type: "integer", minimum: 1 },
    action_id: identifier,
    input: { type: "object", maxProperties: 64, additionalProperties: true },
    created_at: dateTime,
  },
  required: [
    "ir_version",
    "event_id",
    "idempotency_key",
    "document_id",
    "node_id",
    "node_revision",
    "action_id",
    "created_at",
  ],
  additionalProperties: false,
} as const;

export const generativeUiSchemas: Record<string, Record<string, unknown>> = {
  "homerail-view-value-v1": viewValueSchema as Record<string, unknown>,
  "homerail-view-node-v1": homerailViewNodeSchema as Record<string, unknown>,
  "homerail-view-spec-v1": homerailViewSpecSchema as Record<string, unknown>,
  "homerail-a2ui-data-binding-v1": homerailA2uiDataBindingSchema as Record<string, unknown>,
  "homerail-a2ui-function-call-v1": homerailA2uiFunctionCallSchema as Record<string, unknown>,
  "homerail-a2ui-dynamic-value-v1": homerailA2uiDynamicValueSchema as Record<string, unknown>,
  "homerail-a2ui-dynamic-string-v1": homerailA2uiDynamicStringSchema as Record<string, unknown>,
  "homerail-a2ui-dynamic-number-v1": homerailA2uiDynamicNumberSchema as Record<string, unknown>,
  "homerail-a2ui-dynamic-boolean-v1": homerailA2uiDynamicBooleanSchema as Record<string, unknown>,
  "homerail-a2ui-child-list-v1": homerailA2uiChildListSchema as Record<string, unknown>,
  "homerail-a2ui-action-v1": homerailA2uiActionSchema as Record<string, unknown>,
  "homerail-a2ui-component-v1": homerailA2uiComponentSchema as Record<string, unknown>,
  "homerail-a2ui-surface-properties-v1": homerailA2uiSurfacePropertiesSchema as Record<string, unknown>,
  "homerail-a2ui-surface-v1": homerailA2uiSurfaceSchema as Record<string, unknown>,
  "homerail-a2ui-create-surface-message-v1": homerailA2uiCreateSurfaceMessageSchema as Record<string, unknown>,
  "generative-ui-node": generativeUiNodeSchema as Record<string, unknown>,
  "generative-ui-stored-node": generativeUiStoredNodeSchema as Record<string, unknown>,
  "generative-ui-document": generativeUiDocumentSchema as Record<string, unknown>,
  "generative-ui-transaction": generativeUiTransactionSchema as Record<string, unknown>,
  "generative-ui-user-override": generativeUiUserOverrideSchema as Record<string, unknown>,
  "generative-ui-composition-context": generativeUiCompositionContextSchema as Record<string, unknown>,
  "generative-ui-composition": generativeUiCompositionSchema as Record<string, unknown>,
  "generative-ui-interaction-event": generativeUiInteractionEventSchema as Record<string, unknown>,
};
