import { stableStringify } from "./codec.js";
import {
  validateHomerailA2uiSurface,
} from "./generative-ui/validation.js";
import type { HomerailA2uiSurfaceV1 } from "./generative-ui/a2ui.js";
import { HOMERAIL_PLUGIN_ID_PATTERN } from "./plugins/types.js";
import {
  DAG_ACTOR_SURFACE_PATCH_PHASES,
  type DagActorSurfacePatchPhaseV1,
} from "./dag-actor-surface-patch.js";

/** @version 1 */
export const DAG_WORKER_SKILL_CONTEXT_VERSION = 1 as const;
export const DAG_WORKER_SKILL_MAX_COUNT = 8;
export const DAG_WORKER_SKILL_MAX_BYTES = 32 * 1024;
export const DAG_WORKER_SKILL_CONTEXT_MAX_BYTES = 64 * 1024;
export const DAG_WORKER_SKILL_RUN_MAX_BYTES = 1024 * 1024;

export const DAG_WORKER_SKILL_SOURCES = ["home", "repo", "plugin"] as const;
export type DagWorkerSkillSource = (typeof DAG_WORKER_SKILL_SOURCES)[number];

export interface DagWorkerSkillPluginV1 {
  id: string;
  version: string;
}

export const DAG_WORKER_SKILL_VISUAL_DATA_FIELD_MODES = [
  "source",
  "source_prefix",
  "presentation",
] as const;
export type DagWorkerSkillVisualDataFieldMode =
  (typeof DAG_WORKER_SKILL_VISUAL_DATA_FIELD_MODES)[number];

export const DAG_WORKER_SKILL_VISUAL_PRESENTATION_VALUE_TYPES = [
  "string",
  "number",
  "integer",
  "boolean",
] as const;
export type DagWorkerSkillVisualPresentationValueType =
  (typeof DAG_WORKER_SKILL_VISUAL_PRESENTATION_VALUE_TYPES)[number];

export interface DagWorkerSkillVisualPresentationValueSchemaV1 {
  type: DagWorkerSkillVisualPresentationValueType;
  enum?: Array<string | number | boolean>;
  /** String-only upper bound. */
  max_length?: number;
}

export interface DagWorkerSkillVisualDataSourceV1 {
  /** Dispatch input port containing the immutable source value. */
  input_port: string;
  /** Deterministic value within the port mailbox; defaults to zero. */
  value_index?: number;
  /** Parse a string input as JSON before resolving pointer. */
  encoding?: "value" | "json";
  /** Optional exact prefix stripped before JSON parsing. */
  json_prefix?: string;
  /** RFC 6901 pointer within the decoded input value; defaults to the root. */
  pointer?: string;
}

export interface DagWorkerSkillVisualFinalCountV1 {
  /** Trusted dispatch or live-command field that selects the final prefix length. */
  source: DagWorkerSkillVisualDataSourceV1;
  /** Used when the source is absent, including the first round before any command. */
  default: number | "source_length";
}

export interface DagWorkerSkillVisualDataFieldV1 {
  /** Top-level body.data field materialized by the Worker. */
  field: string;
  mode: DagWorkerSkillVisualDataFieldMode;
  /** RFC 6901 pointer relative to the data contract source. */
  source_pointer?: string;
  /** Maximum source prefix exposed by a source_prefix field. */
  max_items?: number;
  /** Optional Worker-owned final prefix length derived from trusted input. */
  final_count?: DagWorkerSkillVisualFinalCountV1;
  /** Provider-facing scalar schema for model-owned presentation values. */
  value_schema?: DagWorkerSkillVisualPresentationValueSchemaV1;
}

export interface DagWorkerSkillVisualDataContractV1 {
  source: DagWorkerSkillVisualDataSourceV1;
  fields: DagWorkerSkillVisualDataFieldV1[];
  /** Optional runtime-enforced update cadence for one active turn. */
  required_phases?: DagActorSurfacePatchPhaseV1[];
}

export interface DagWorkerSkillVisualProfileV1 {
  profile_version: 1;
  views?: Array<{
    id: string;
    a2ui: HomerailA2uiSurfaceV1;
    /** Optional deterministic projection from trusted dispatch input to body.data. */
    data_contract?: DagWorkerSkillVisualDataContractV1;
  }>;
  data_fields?: string[];
  media_roles?: string[];
  recommended_size?: {
    width: number;
    height: number;
  };
  mobile_fallback?: "compact" | "stack" | "summary" | "text";
}

export interface DagWorkerSkillV1 {
  id: string;
  source: DagWorkerSkillSource;
  digest: string;
  content: string;
  plugin?: DagWorkerSkillPluginV1;
  visual_profile?: DagWorkerSkillVisualProfileV1;
}

export interface DagWorkerSkillContextV1 {
  context_version: typeof DAG_WORKER_SKILL_CONTEXT_VERSION;
  context_digest: string;
  total_bytes: number;
  skills: DagWorkerSkillV1[];
}

export interface DagWorkerSkillContextSummaryV1 {
  context_version: typeof DAG_WORKER_SKILL_CONTEXT_VERSION;
  context_digest: string;
  total_bytes: number;
  skills: Array<{
    id: string;
    digest: string;
    bytes: number;
  }>;
}

export interface DagWorkerSkillContextValidationIssue {
  path: string;
  message: string;
  keyword: string;
}

export interface DagWorkerSkillContextValidationResult {
  valid: boolean;
  value?: DagWorkerSkillContextV1;
  errors: DagWorkerSkillContextValidationIssue[];
}

export class DagWorkerSkillContextValidationError extends Error {
  constructor(public readonly errors: DagWorkerSkillContextValidationIssue[]) {
    super(errors.map((error) => `${error.path || "/"}: ${error.message}`).join("; "));
    this.name = "DagWorkerSkillContextValidationError";
  }
}

export type DagWorkerSkillInputV1 = Omit<DagWorkerSkillV1, "digest"> & {
  digest?: string;
};

const SHA256 = /^[a-f0-9]{64}$/;
const SKILL_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const PLUGIN_VERSION = /^[0-9A-Za-z][0-9A-Za-z.+_-]{0,63}$/;
const PROFILE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const PROFILE_FIELD = /^[A-Za-z0-9_./-]{1,128}$/;
const PROFILE_TOP_LEVEL_FIELD = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/;
const RESERVED_SURFACE_TOOL_INPUT_FIELDS = new Set([
  "body",
  "canvas_size",
  "data",
  "density",
  "fallback",
  "op",
  "patch_id",
  "patch_sequence",
  "phase",
  "preferred_visual",
  "presentation_hint",
  "view_id",
]);
const MAX_VISUAL_PROFILE_BYTES = 64 * 1024;

const SHA256_INITIAL = new Uint32Array([
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
  0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
]);
const SHA256_ROUND = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5,
  0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc,
  0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
  0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3,
  0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5,
  0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const FIXED_CREDENTIAL_PATTERNS: Array<[RegExp, string]> = [
  [/-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/i, "private key"],
  [/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/, "AWS access key"],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}\b/, "GitHub token"],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}\b/, "GitHub token"],
  [/\bxox[baprs]-[A-Za-z0-9-]{16,}\b/, "Slack token"],
  [/\bsk-(?:proj-)?[A-Za-z0-9_-]{16,}\b/, "API key"],
  [/\bAuthorization\s*:\s*(?:Bearer|Basic)\s+[A-Za-z0-9._~+\/=:-]{12,}/i, "authorization credential"],
  [/\bBearer\s+[A-Za-z0-9._~+\/-]{16,}\b/i, "bearer token"],
  [/\b[A-Za-z][A-Za-z0-9+.-]{0,31}:\/\/[^\s/:@]+:[^\s/@]+@/, "URL credential"],
];

const SECRET_ASSIGNMENT = /\b(api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|token|secret|password|credential|authorization)\b\s*[:=]\s*(?:"([^"\r\n]+)"|'([^'\r\n]+)'|([^\s#;,]+))/gi;

function issue(path: string, message: string, keyword: string): never {
  throw new DagWorkerSkillContextValidationError([{ path, message, keyword }]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
): void {
  const allowedKeys = new Set(allowed);
  const unexpected = Object.keys(value).filter((key) => !allowedKeys.has(key));
  if (unexpected.length > 0) {
    issue(path, `unexpected field '${unexpected.sort()[0]}'`, "additionalProperties");
  }
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function rotateRight(value: number, shift: number): number {
  return (value >>> shift) | (value << (32 - shift));
}

/** Browser-safe synchronous SHA-256 for bounded protocol payloads. */
function sha256Utf8(value: string): string {
  const input = new TextEncoder().encode(value);
  const paddedLength = Math.ceil((input.length + 9) / 64) * 64;
  const padded = new Uint8Array(paddedLength);
  padded.set(input);
  padded[input.length] = 0x80;
  const bitLength = BigInt(input.length) * 8n;
  const view = new DataView(padded.buffer);
  view.setUint32(paddedLength - 8, Number(bitLength >> 32n), false);
  view.setUint32(paddedLength - 4, Number(bitLength & 0xffff_ffffn), false);

  const state = new Uint32Array(SHA256_INITIAL);
  const words = new Uint32Array(64);
  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let index = 0; index < 16; index += 1) {
      words[index] = view.getUint32(offset + index * 4, false);
    }
    for (let index = 16; index < 64; index += 1) {
      const previous15 = words[index - 15]!;
      const previous2 = words[index - 2]!;
      const sigma0 = rotateRight(previous15, 7) ^ rotateRight(previous15, 18) ^ (previous15 >>> 3);
      const sigma1 = rotateRight(previous2, 17) ^ rotateRight(previous2, 19) ^ (previous2 >>> 10);
      words[index] = (words[index - 16]! + sigma0 + words[index - 7]! + sigma1) >>> 0;
    }

    let a = state[0]!;
    let b = state[1]!;
    let c = state[2]!;
    let d = state[3]!;
    let e = state[4]!;
    let f = state[5]!;
    let g = state[6]!;
    let h = state[7]!;
    for (let index = 0; index < 64; index += 1) {
      const sum1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
      const choice = (e & f) ^ (~e & g);
      const temp1 = (h + sum1 + choice + SHA256_ROUND[index]! + words[index]!) >>> 0;
      const sum0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (sum0 + majority) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }
    state[0] = (state[0]! + a) >>> 0;
    state[1] = (state[1]! + b) >>> 0;
    state[2] = (state[2]! + c) >>> 0;
    state[3] = (state[3]! + d) >>> 0;
    state[4] = (state[4]! + e) >>> 0;
    state[5] = (state[5]! + f) >>> 0;
    state[6] = (state[6]! + g) >>> 0;
    state[7] = (state[7]! + h) >>> 0;
  }
  return Array.from(state, (word) => word.toString(16).padStart(8, "0")).join("");
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function looksLikePlaceholder(value: string): boolean {
  const normalized = value.trim();
  if (!normalized) return true;
  if (/^(?:<[^>]+>|\[[^\]]+\]|\$\{[^}]+\}|\$[A-Z_][A-Z0-9_]*|\*+|x{4,})$/i.test(normalized)) return true;
  if (/^(?:example|placeholder|redacted|replace[_-]?me|your[_-]?|test[_-]?|dummy[_-]?)/i.test(normalized)) return true;
  if (/^(?:process\.)?env\.[A-Z_][A-Z0-9_]*$/i.test(normalized)) return true;
  return false;
}

export function detectObviousCredential(content: string): string | undefined {
  for (const [pattern, label] of FIXED_CREDENTIAL_PATTERNS) {
    if (pattern.test(content)) return label;
  }
  SECRET_ASSIGNMENT.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = SECRET_ASSIGNMENT.exec(content)) !== null) {
    const candidate = (match[2] ?? match[3] ?? match[4] ?? "").trim();
    if (!looksLikePlaceholder(candidate) && utf8Bytes(candidate) >= 8) {
      return `${match[1].toLowerCase()} assignment`;
    }
  }
  return undefined;
}

export function digestDagWorkerSkillContent(content: string): string {
  return sha256Utf8(content);
}

function assertString(value: unknown, path: string, minLength: number, maxLength: number): string {
  if (typeof value !== "string" || value.length < minLength || value.length > maxLength || value.includes("\0")) {
    issue(path, `must be a string between ${minLength} and ${maxLength} characters without NUL bytes`, "type");
  }
  return value;
}

function assertStringArray(
  value: unknown,
  path: string,
  maxItems: number,
  pattern: RegExp,
): string[] {
  if (!Array.isArray(value) || value.length > maxItems) {
    issue(path, `must be an array with at most ${maxItems} items`, "maxItems");
  }
  const result = value.map((entry, index) => {
    const text = assertString(entry, `${path}/${index}`, 1, 128);
    if (!pattern.test(text) || text.includes("..")) issue(`${path}/${index}`, "has an invalid identifier", "pattern");
    return text;
  });
  if (new Set(result).size !== result.length) issue(path, "must not contain duplicate items", "uniqueItems");
  return result;
}

function assertJsonPointer(value: unknown, path: string): string {
  const pointer = assertString(value, path, 0, 512);
  if (pointer && !pointer.startsWith("/")) {
    issue(path, "must be an RFC 6901 JSON Pointer", "format");
  }
  for (let index = 0; index < pointer.length; index += 1) {
    if (pointer[index] !== "~") continue;
    const escaped = pointer[index + 1];
    if (escaped !== "0" && escaped !== "1") {
      issue(path, "contains an invalid RFC 6901 escape", "format");
    }
    index += 1;
  }
  return pointer;
}

function parseVisualDataSource(value: unknown, path: string): DagWorkerSkillVisualDataSourceV1 {
  if (!isRecord(value)) issue(path, "must be an object", "type");
  exactKeys(value, ["input_port", "value_index", "encoding", "json_prefix", "pointer"], path);
  const inputPort = assertString(value.input_port, `${path}/input_port`, 1, 128);
  if (!PROFILE_ID.test(inputPort)) issue(`${path}/input_port`, "has an invalid port identifier", "pattern");
  const encoding = value.encoding === undefined ? "value" : value.encoding;
  if (encoding !== "value" && encoding !== "json") {
    issue(`${path}/encoding`, "must be value or json", "enum");
  }
  let valueIndex: number | undefined;
  if (value.value_index !== undefined) {
    if (!Number.isSafeInteger(value.value_index) || Number(value.value_index) < 0 || Number(value.value_index) > 31) {
      issue(`${path}/value_index`, "must be an integer between 0 and 31", "maximum");
    }
    valueIndex = Number(value.value_index);
  }
  let jsonPrefix: string | undefined;
  if (value.json_prefix !== undefined) {
    jsonPrefix = assertString(value.json_prefix, `${path}/json_prefix`, 1, 256);
    if (encoding !== "json") issue(`${path}/json_prefix`, "requires encoding json", "dependentRequired");
  }
  const pointer = value.pointer === undefined ? undefined : assertJsonPointer(value.pointer, `${path}/pointer`);
  return {
    input_port: inputPort,
    ...(valueIndex === undefined ? {} : { value_index: valueIndex }),
    ...(value.encoding === undefined ? {} : { encoding }),
    ...(jsonPrefix === undefined ? {} : { json_prefix: jsonPrefix }),
    ...(pointer === undefined ? {} : { pointer }),
  };
}

function parseVisualPresentationValueSchema(
  value: unknown,
  path: string,
): DagWorkerSkillVisualPresentationValueSchemaV1 {
  if (!isRecord(value)) issue(path, "must be an object", "type");
  exactKeys(value, ["type", "enum", "max_length"], path);
  if (!DAG_WORKER_SKILL_VISUAL_PRESENTATION_VALUE_TYPES.includes(
    value.type as DagWorkerSkillVisualPresentationValueType,
  )) {
    issue(`${path}/type`, "must be string, number, integer, or boolean", "enum");
  }
  const type = value.type as DagWorkerSkillVisualPresentationValueType;
  let maxLength: number | undefined;
  if (value.max_length !== undefined) {
    if (type !== "string") issue(`${path}/max_length`, "is only allowed for string values", "forbidden");
    if (!Number.isSafeInteger(value.max_length) || Number(value.max_length) < 1 || Number(value.max_length) > 4_000) {
      issue(`${path}/max_length`, "must be an integer between 1 and 4000", "maximum");
    }
    maxLength = Number(value.max_length);
  }
  let allowedValues: Array<string | number | boolean> | undefined;
  if (value.enum !== undefined) {
    if (!Array.isArray(value.enum) || value.enum.length < 1 || value.enum.length > 32) {
      issue(`${path}/enum`, "must contain between 1 and 32 scalar values", "maxItems");
    }
    allowedValues = value.enum.map((entry, index) => {
      const matches = type === "string"
        ? typeof entry === "string" && (maxLength === undefined || entry.length <= maxLength)
        : type === "boolean"
          ? typeof entry === "boolean"
          : type === "integer"
            ? Number.isSafeInteger(entry)
            : typeof entry === "number" && Number.isFinite(entry);
      if (!matches) issue(`${path}/enum/${index}`, `must match presentation value type ${type}`, "type");
      return entry as string | number | boolean;
    });
    if (new Set(allowedValues.map((entry) => stableStringify(entry))).size !== allowedValues.length) {
      issue(`${path}/enum`, "must not contain duplicate values", "uniqueItems");
    }
  }
  return {
    type,
    ...(allowedValues === undefined ? {} : { enum: allowedValues }),
    ...(maxLength === undefined ? {} : { max_length: maxLength }),
  };
}

function parseVisualDataField(value: unknown, path: string): DagWorkerSkillVisualDataFieldV1 {
  if (!isRecord(value)) issue(path, "must be an object", "type");
  exactKeys(value, ["field", "mode", "source_pointer", "max_items", "final_count", "value_schema"], path);
  const field = assertString(value.field, `${path}/field`, 1, 128);
  if (!PROFILE_TOP_LEVEL_FIELD.test(field)) {
    issue(`${path}/field`, "must be a top-level data field identifier", "pattern");
  }
  if (!DAG_WORKER_SKILL_VISUAL_DATA_FIELD_MODES.includes(value.mode as DagWorkerSkillVisualDataFieldMode)) {
    issue(`${path}/mode`, "must be source, source_prefix, or presentation", "enum");
  }
  const mode = value.mode as DagWorkerSkillVisualDataFieldMode;
  const sourcePointer = value.source_pointer === undefined
    ? undefined
    : assertJsonPointer(value.source_pointer, `${path}/source_pointer`);
  if (mode === "presentation") {
    if (sourcePointer !== undefined) issue(`${path}/source_pointer`, "is forbidden for presentation fields", "forbidden");
    if (value.max_items !== undefined) issue(`${path}/max_items`, "is forbidden for presentation fields", "forbidden");
    if (value.final_count !== undefined) issue(`${path}/final_count`, "is forbidden for presentation fields", "forbidden");
    const valueSchema = value.value_schema === undefined
      ? undefined
      : parseVisualPresentationValueSchema(value.value_schema, `${path}/value_schema`);
    return { field, mode, ...(valueSchema === undefined ? {} : { value_schema: valueSchema }) };
  }
  if (value.value_schema !== undefined) issue(`${path}/value_schema`, "is only allowed for presentation fields", "forbidden");
  if (sourcePointer === undefined) issue(`${path}/source_pointer`, "is required for source fields", "required");
  let maxItems: number | undefined;
  if (value.max_items !== undefined) {
    if (mode !== "source_prefix") issue(`${path}/max_items`, "is only allowed for source_prefix", "forbidden");
    if (!Number.isSafeInteger(value.max_items) || Number(value.max_items) < 1 || Number(value.max_items) > 100) {
      issue(`${path}/max_items`, "must be an integer between 1 and 100", "maximum");
    }
    maxItems = Number(value.max_items);
  }
  let finalCount: DagWorkerSkillVisualFinalCountV1 | undefined;
  if (value.final_count !== undefined) {
    if (mode !== "source_prefix") issue(`${path}/final_count`, "is only allowed for source_prefix", "forbidden");
    if (!isRecord(value.final_count)) issue(`${path}/final_count`, "must be an object", "type");
    exactKeys(value.final_count, ["source", "default"], `${path}/final_count`);
    const fallback = value.final_count.default;
    if (fallback !== "source_length"
      && (!Number.isSafeInteger(fallback) || Number(fallback) < 0 || Number(fallback) > 100)) {
      issue(`${path}/final_count/default`, "must be source_length or an integer between 0 and 100", "maximum");
    }
    finalCount = {
      source: parseVisualDataSource(value.final_count.source, `${path}/final_count/source`),
      default: fallback === "source_length" ? fallback : Number(fallback),
    };
  }
  return {
    field,
    mode,
    source_pointer: sourcePointer,
    ...(maxItems === undefined ? {} : { max_items: maxItems }),
    ...(finalCount === undefined ? {} : { final_count: finalCount }),
  };
}

function parseVisualDataContract(value: unknown, path: string): DagWorkerSkillVisualDataContractV1 {
  if (!isRecord(value)) issue(path, "must be an object", "type");
  exactKeys(value, ["source", "fields", "required_phases"], path);
  if (!Array.isArray(value.fields) || value.fields.length < 1 || value.fields.length > 64) {
    issue(`${path}/fields`, "must contain between 1 and 64 fields", "maxItems");
  }
  const fields = value.fields.map((entry, index) => parseVisualDataField(entry, `${path}/fields/${index}`));
  if (new Set(fields.map((field) => field.field)).size !== fields.length) {
    issue(`${path}/fields`, "must not contain duplicate field names", "uniqueItems");
  }
  fields.forEach((field, index) => {
    if (field.mode !== "source" && RESERVED_SURFACE_TOOL_INPUT_FIELDS.has(field.field)) {
      issue(
        `${path}/fields/${index}/field`,
        "must not collide with a reserved report_surface_state input field",
        "reserved",
      );
    }
  });
  let requiredPhases: DagActorSurfacePatchPhaseV1[] | undefined;
  if (value.required_phases !== undefined) {
    if (!Array.isArray(value.required_phases) || value.required_phases.length < 2
      || value.required_phases.length > DAG_ACTOR_SURFACE_PATCH_PHASES.length) {
      issue(`${path}/required_phases`, "must contain between 2 and 5 phases", "maxItems");
    }
    requiredPhases = value.required_phases.map((phase, index) => {
      if (!DAG_ACTOR_SURFACE_PATCH_PHASES.includes(phase as DagActorSurfacePatchPhaseV1)) {
        issue(`${path}/required_phases/${index}`, "has an unsupported phase", "enum");
      }
      return phase as DagActorSurfacePatchPhaseV1;
    });
    if (new Set(requiredPhases).size !== requiredPhases.length) {
      issue(`${path}/required_phases`, "must not contain duplicate phases", "uniqueItems");
    }
    if (requiredPhases[0] !== "started" || requiredPhases.at(-1) !== "final") {
      issue(`${path}/required_phases`, "must start with started and end with final", "sequence");
    }
    for (let index = 1; index < requiredPhases.length; index += 1) {
      if (DAG_ACTOR_SURFACE_PATCH_PHASES.indexOf(requiredPhases[index]!)
        <= DAG_ACTOR_SURFACE_PATCH_PHASES.indexOf(requiredPhases[index - 1]!)) {
        issue(`${path}/required_phases`, "must be strictly monotonic", "sequence");
      }
    }
  }
  return {
    source: parseVisualDataSource(value.source, `${path}/source`),
    fields,
    ...(requiredPhases ? { required_phases: requiredPhases } : {}),
  };
}

function visualDataKeys(a2ui: HomerailA2uiSurfaceV1): string[] {
  const keys = new Set<string>();
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (!isRecord(value)) return;
    if (typeof value.path === "string" && value.path.startsWith("/actor_view/data/")) {
      const encoded = value.path.slice("/actor_view/data/".length).split("/", 1)[0];
      const key = encoded?.replace(/~1/g, "/").replace(/~0/g, "~");
      if (key) keys.add(key);
    }
    Object.values(value).forEach(visit);
  };
  visit(a2ui);
  return [...keys].sort();
}

function parseVisualProfile(value: unknown, path: string): DagWorkerSkillVisualProfileV1 {
  if (!isRecord(value)) issue(path, "must be an object", "type");
  exactKeys(value, [
    "profile_version",
    "views",
    "data_fields",
    "media_roles",
    "recommended_size",
    "mobile_fallback",
  ], path);
  if (value.profile_version !== 1) issue(`${path}/profile_version`, "must equal 1", "const");

  const profile: DagWorkerSkillVisualProfileV1 = { profile_version: 1 };
  if (value.views !== undefined) {
    if (!Array.isArray(value.views) || value.views.length > 8) {
      issue(`${path}/views`, "must be an array with at most 8 items", "maxItems");
    }
    const ids = new Set<string>();
    profile.views = value.views.map((entry, index) => {
      const entryPath = `${path}/views/${index}`;
      if (!isRecord(entry)) issue(entryPath, "must be an object", "type");
      exactKeys(entry, ["id", "a2ui", "data_contract"], entryPath);
      const id = assertString(entry.id, `${entryPath}/id`, 1, 128);
      if (!PROFILE_ID.test(id)) issue(`${entryPath}/id`, "has an invalid identifier", "pattern");
      if (ids.has(id)) issue(`${path}/views`, `contains duplicate view id '${id}'`, "uniqueItems");
      ids.add(id);
      const validation = validateHomerailA2uiSurface(entry.a2ui);
      if (!validation.valid || !validation.value) {
        issue(`${entryPath}/a2ui`, "failed HomeRail A2UI surface validation", "a2ui");
      }
      const dataContract = entry.data_contract === undefined
        ? undefined
        : parseVisualDataContract(entry.data_contract, `${entryPath}/data_contract`);
      if (dataContract) {
        const declared = new Set(dataContract.fields.map((field) => field.field));
        const missing = visualDataKeys(validation.value).filter((field) => !declared.has(field));
        if (missing.length > 0) {
          issue(
            `${entryPath}/data_contract/fields`,
            `does not cover A2UI data field '${missing[0]}'`,
            "required",
          );
        }
      }
      return {
        id,
        a2ui: clone(validation.value),
        ...(dataContract ? { data_contract: dataContract } : {}),
      };
    });
  }
  if (value.data_fields !== undefined) {
    profile.data_fields = assertStringArray(value.data_fields, `${path}/data_fields`, 64, PROFILE_FIELD);
  }
  if (value.media_roles !== undefined) {
    profile.media_roles = assertStringArray(value.media_roles, `${path}/media_roles`, 32, PROFILE_FIELD);
  }
  if (value.recommended_size !== undefined) {
    if (!isRecord(value.recommended_size)) issue(`${path}/recommended_size`, "must be an object", "type");
    exactKeys(value.recommended_size, ["width", "height"], `${path}/recommended_size`);
    const width = value.recommended_size.width;
    const height = value.recommended_size.height;
    if (!Number.isSafeInteger(width) || Number(width) < 1 || Number(width) > 8192) {
      issue(`${path}/recommended_size/width`, "must be an integer between 1 and 8192", "maximum");
    }
    if (!Number.isSafeInteger(height) || Number(height) < 1 || Number(height) > 8192) {
      issue(`${path}/recommended_size/height`, "must be an integer between 1 and 8192", "maximum");
    }
    profile.recommended_size = { width: Number(width), height: Number(height) };
  }
  if (value.mobile_fallback !== undefined) {
    if (!["compact", "stack", "summary", "text"].includes(String(value.mobile_fallback))) {
      issue(`${path}/mobile_fallback`, "has an unsupported fallback", "enum");
    }
    profile.mobile_fallback = value.mobile_fallback as DagWorkerSkillVisualProfileV1["mobile_fallback"];
  }
  if (Object.keys(profile).length === 1) issue(path, "must declare at least one visual metadata field", "minProperties");
  const encoded = stableStringify(profile);
  if (utf8Bytes(encoded) > MAX_VISUAL_PROFILE_BYTES) {
    issue(path, `exceeds ${MAX_VISUAL_PROFILE_BYTES} UTF-8 bytes`, "maxBytes");
  }
  const credential = detectObviousCredential(encoded);
  if (credential) issue(path, `contains an obvious ${credential}`, "credential");
  return profile;
}

/** Parse one standalone, bounded Worker visual profile from a trusted package asset. */
export function parseDagWorkerSkillVisualProfileV1(
  value: unknown,
): DagWorkerSkillVisualProfileV1 {
  return parseVisualProfile(value, "/visual_profile");
}

function parsePlugin(value: unknown, path: string): DagWorkerSkillPluginV1 {
  if (!isRecord(value)) issue(path, "must be an object", "type");
  exactKeys(value, ["id", "version"], path);
  const id = assertString(value.id, `${path}/id`, 1, 160);
  const version = assertString(value.version, `${path}/version`, 1, 64);
  if (!HOMERAIL_PLUGIN_ID_PATTERN.test(id)) issue(`${path}/id`, "has an invalid plugin id", "pattern");
  if (!PLUGIN_VERSION.test(version)) issue(`${path}/version`, "has an invalid plugin version", "pattern");
  return { id, version };
}

function parseSkill(value: unknown, path: string): DagWorkerSkillV1 {
  if (!isRecord(value)) issue(path, "must be an object", "type");
  exactKeys(value, ["id", "source", "digest", "content", "plugin", "visual_profile"], path);
  const id = assertString(value.id, `${path}/id`, 1, 256);
  if (!SKILL_ID.test(id)) issue(`${path}/id`, "has an invalid Skill id", "pattern");
  if (!DAG_WORKER_SKILL_SOURCES.includes(value.source as DagWorkerSkillSource)) {
    issue(`${path}/source`, "must be home, repo, or plugin", "enum");
  }
  const source = value.source as DagWorkerSkillSource;
  const content = assertString(value.content, `${path}/content`, 1, Number.MAX_SAFE_INTEGER);
  const bytes = utf8Bytes(content);
  if (bytes > DAG_WORKER_SKILL_MAX_BYTES) {
    issue(`${path}/content`, `exceeds ${DAG_WORKER_SKILL_MAX_BYTES} UTF-8 bytes`, "maxBytes");
  }
  const credential = detectObviousCredential(content);
  if (credential) issue(`${path}/content`, `contains an obvious ${credential}`, "credential");
  const digest = assertString(value.digest, `${path}/digest`, 64, 64);
  if (!SHA256.test(digest)) issue(`${path}/digest`, "must be a lowercase SHA-256 digest", "pattern");
  const expectedDigest = digestDagWorkerSkillContent(content);
  if (digest !== expectedDigest) issue(`${path}/digest`, "does not match the Skill content", "digest");
  const plugin = value.plugin === undefined ? undefined : parsePlugin(value.plugin, `${path}/plugin`);
  if (source === "plugin" && !plugin) issue(`${path}/plugin`, "is required for plugin Skills", "required");
  if (source !== "plugin" && plugin) issue(`${path}/plugin`, "is only allowed for plugin Skills", "forbidden");
  if (plugin) {
    const prefix = `${plugin.id}:`;
    const localId = id.startsWith(prefix) ? id.slice(prefix.length) : "";
    if (!localId || localId.includes(":") || id !== `${plugin.id}:${localId}`) {
      issue(`${path}/id`, "must be qualified exactly once by plugin.id", "pluginIdentity");
    }
  }
  const visualProfile = value.visual_profile === undefined
    ? undefined
    : parseVisualProfile(value.visual_profile, `${path}/visual_profile`);
  return {
    id,
    source,
    digest,
    content,
    ...(plugin ? { plugin } : {}),
    ...(visualProfile ? { visual_profile: visualProfile } : {}),
  };
}

function sortedSkills(skills: readonly DagWorkerSkillV1[]): DagWorkerSkillV1[] {
  return [...skills]
    .map((skill) => clone(skill))
    .sort((left, right) => left.id.localeCompare(right.id) || left.source.localeCompare(right.source));
}

function canonicalContext(
  skills: readonly DagWorkerSkillV1[],
  totalBytes: number,
): DagWorkerSkillContextV1 {
  const unsigned = {
    context_version: DAG_WORKER_SKILL_CONTEXT_VERSION,
    total_bytes: totalBytes,
    skills: sortedSkills(skills),
  };
  return {
    ...unsigned,
    context_digest: digestDagWorkerSkillContext(unsigned),
  };
}

function finalizeCanonicalContext(skills: readonly DagWorkerSkillV1[]): DagWorkerSkillContextV1 {
  let totalBytes = 0;
  for (let iteration = 0; iteration < 8; iteration += 1) {
    const context = canonicalContext(skills, totalBytes);
    const wireBytes = utf8Bytes(stableStringify(context));
    if (wireBytes === totalBytes) return context;
    totalBytes = wireBytes;
  }
  issue("/total_bytes", "canonical Skill Context byte size did not stabilize", "canonicalBytes");
}

export function dagWorkerSkillContextDigestInput(
  context: Pick<DagWorkerSkillContextV1, "context_version" | "total_bytes" | "skills">,
): Omit<DagWorkerSkillContextV1, "context_digest"> {
  return {
    context_version: DAG_WORKER_SKILL_CONTEXT_VERSION,
    total_bytes: context.total_bytes,
    skills: sortedSkills(context.skills),
  };
}

export function digestDagWorkerSkillContext(
  context: Pick<DagWorkerSkillContextV1, "context_version" | "total_bytes" | "skills">,
): string {
  return sha256Utf8(stableStringify(dagWorkerSkillContextDigestInput(context)));
}

export function createDagWorkerSkillContextV1(
  inputs: readonly DagWorkerSkillInputV1[],
): DagWorkerSkillContextV1 {
  if (!Array.isArray(inputs)) issue("/skills", "must be an array", "type");
  if (inputs.length > DAG_WORKER_SKILL_MAX_COUNT) {
    issue("/skills", `contains more than ${DAG_WORKER_SKILL_MAX_COUNT} Skills`, "maxItems");
  }
  const skills = sortedSkills(inputs.map((input, index) => {
    const digest = digestDagWorkerSkillContent(input.content);
    if (input.digest !== undefined && input.digest !== digest) {
      issue(`/skills/${index}/digest`, "does not match the Skill content", "digest");
    }
    return parseSkill({ ...input, digest }, `/skills/${index}`);
  }));
  if (new Set(skills.map((skill) => skill.id)).size !== skills.length) {
    issue("/skills", "contains duplicate Skill ids", "uniqueItems");
  }
  const context = finalizeCanonicalContext(skills);
  if (context.total_bytes > DAG_WORKER_SKILL_CONTEXT_MAX_BYTES) {
    issue("/total_bytes", `exceeds ${DAG_WORKER_SKILL_CONTEXT_MAX_BYTES} UTF-8 bytes`, "maxBytes");
  }
  return context;
}

export function parseDagWorkerSkillContextV1(value: unknown): DagWorkerSkillContextV1 {
  if (!isRecord(value)) issue("", "must be an object", "type");
  exactKeys(value, ["context_version", "context_digest", "total_bytes", "skills"], "");
  if (value.context_version !== DAG_WORKER_SKILL_CONTEXT_VERSION) {
    issue("/context_version", `must equal ${DAG_WORKER_SKILL_CONTEXT_VERSION}`, "const");
  }
  if (!Array.isArray(value.skills)) issue("/skills", "must be an array", "type");
  if (value.skills.length > DAG_WORKER_SKILL_MAX_COUNT) {
    issue("/skills", `contains more than ${DAG_WORKER_SKILL_MAX_COUNT} Skills`, "maxItems");
  }
  const skills = value.skills.map((skill, index) => parseSkill(skill, `/skills/${index}`));
  const canonicalSkills = sortedSkills(skills);
  if (new Set(canonicalSkills.map((skill) => skill.id)).size !== canonicalSkills.length) {
    issue("/skills", "contains duplicate Skill ids", "uniqueItems");
  }
  if (skills.some((skill, index) => skill.id !== canonicalSkills[index]?.id || skill.source !== canonicalSkills[index]?.source)) {
    issue("/skills", "must use canonical Skill id ordering", "canonicalOrder");
  }
  if (!Number.isSafeInteger(value.total_bytes) || Number(value.total_bytes) < 0) {
    issue("/total_bytes", "must be a non-negative safe integer", "type");
  }
  const contextDigest = assertString(value.context_digest, "/context_digest", 64, 64);
  if (!SHA256.test(contextDigest)) issue("/context_digest", "must be a lowercase SHA-256 digest", "pattern");
  const context: DagWorkerSkillContextV1 = {
    context_version: DAG_WORKER_SKILL_CONTEXT_VERSION,
    context_digest: contextDigest,
    total_bytes: Number(value.total_bytes),
    skills: canonicalSkills,
  };
  const wireBytes = utf8Bytes(stableStringify(context));
  if (context.total_bytes !== wireBytes) {
    issue("/total_bytes", "does not match the canonical Skill Context wire bytes", "bytes");
  }
  if (wireBytes > DAG_WORKER_SKILL_CONTEXT_MAX_BYTES) {
    issue("/total_bytes", `exceeds ${DAG_WORKER_SKILL_CONTEXT_MAX_BYTES} UTF-8 bytes`, "maxBytes");
  }
  if (digestDagWorkerSkillContext(context) !== contextDigest) {
    issue("/context_digest", "does not match the canonical Skill Context", "digest");
  }
  return context;
}

export function validateDagWorkerSkillContextV1(value: unknown): DagWorkerSkillContextValidationResult {
  try {
    return { valid: true, value: parseDagWorkerSkillContextV1(value), errors: [] };
  } catch (error) {
    if (error instanceof DagWorkerSkillContextValidationError) {
      return { valid: false, errors: error.errors };
    }
    return {
      valid: false,
      errors: [{ path: "", message: "Skill Context validation failed", keyword: "validation" }],
    };
  }
}

export function encodeDagWorkerSkillContextV1(value: DagWorkerSkillContextV1): string {
  return stableStringify(parseDagWorkerSkillContextV1(value));
}

export function summarizeDagWorkerSkillContextV1(
  value: DagWorkerSkillContextV1,
): DagWorkerSkillContextSummaryV1 {
  const context = parseDagWorkerSkillContextV1(value);
  return {
    context_version: context.context_version,
    context_digest: context.context_digest,
    total_bytes: context.total_bytes,
    skills: context.skills.map((skill) => ({
      id: skill.id,
      digest: skill.digest,
      bytes: utf8Bytes(stableStringify(skill)),
    })),
  };
}
