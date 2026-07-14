import type { GenerativeUiValidationError } from "./types.js";

export const GENERATIVE_UI_MAX_JSON_DEPTH = 64 as const;
export const GENERATIVE_UI_MAX_JSON_VALUES = 4_000_000 as const;
export const GENERATIVE_UI_MAX_NODE_CONTENT_BYTES = 128 * 1024;
export const GENERATIVE_UI_MAX_ACTION_ARGUMENT_BYTES = 32 * 1024;
export const GENERATIVE_UI_MAX_NODE_ENVELOPE_BYTES = 256 * 1024;
export const GENERATIVE_UI_MAX_MISC_ENVELOPE_BYTES = 512 * 1024;
export const GENERATIVE_UI_MAX_TRANSACTION_BYTES = 8 * 1024 * 1024;
export const GENERATIVE_UI_MAX_DOCUMENT_BYTES = 20 * 1024 * 1024;

export interface GenerativeUiJsonValueLimits {
  max_depth: number;
  max_values: number;
  max_bytes: number;
}

export interface AnalyzeGenerativeUiJsonValueOptions {
  limits?: Partial<GenerativeUiJsonValueLimits>;
  path?: string;
  /** Receives canonical UTF-16BE byte chunks without building one large string. */
  on_token?: (chunk: Uint8Array) => void;
}

export interface GenerativeUiJsonValueAnalysis {
  valid: boolean;
  byte_length: number;
  value_count: number;
  max_depth: number;
  error?: GenerativeUiValidationError;
}

interface WalkState {
  limits: GenerativeUiJsonValueLimits;
  bytes: number;
  values: number;
  deepest: number;
  ancestors: WeakSet<object>;
  onToken?: (chunk: Uint8Array) => void;
}

class JsonWalkError extends Error {
  readonly path: string;
  readonly keyword: string;

  constructor(path: string, message: string, keyword: string) {
    super(message);
    this.name = "JsonWalkError";
    this.path = path;
    this.keyword = keyword;
  }
}

const DEFAULT_LIMITS: GenerativeUiJsonValueLimits = {
  max_depth: GENERATIVE_UI_MAX_JSON_DEPTH,
  max_values: GENERATIVE_UI_MAX_JSON_VALUES,
  max_bytes: GENERATIVE_UI_MAX_DOCUMENT_BYTES,
};

function limitsFor(input?: Partial<GenerativeUiJsonValueLimits>): GenerativeUiJsonValueLimits {
  const limits = { ...DEFAULT_LIMITS, ...(input ?? {}) };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new JsonWalkError("", `${name} must be a positive safe integer`, "jsonLimits");
    }
  }
  return limits;
}

function addBytes(state: WalkState, count: number, path: string): void {
  state.bytes += count;
  if (state.bytes > state.limits.max_bytes) {
    throw new JsonWalkError(path, `JSON value exceeds ${state.limits.max_bytes} bytes`, "maxPayloadBytes");
  }
}

const TOKEN_CHUNK_CODE_UNITS = 2_048;
const MAX_POINTER_SEGMENT_CODE_UNITS = 80;

function token(state: WalkState, value: string): void {
  if (!state.onToken) return;
  for (let offset = 0; offset < value.length; offset += TOKEN_CHUNK_CODE_UNITS) {
    const length = Math.min(TOKEN_CHUNK_CODE_UNITS, value.length - offset);
    const bytes = new Uint8Array(length * 2);
    for (let index = 0; index < length; index += 1) {
      const codeUnit = value.charCodeAt(offset + index);
      bytes[index * 2] = codeUnit >>> 8;
      bytes[index * 2 + 1] = codeUnit & 0xff;
    }
    state.onToken(bytes);
  }
}

function walkStringBytes(value: string, state: WalkState, path: string): void {
  addBytes(state, 1, path);
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code === 0x22 || code === 0x5c) addBytes(state, 2, path);
    else if (code <= 0x1f) {
      addBytes(state, code === 0x08 || code === 0x09 || code === 0x0a || code === 0x0c || code === 0x0d ? 2 : 6, path);
    } else if (code <= 0x7f) addBytes(state, 1, path);
    else if (code <= 0x7ff) addBytes(state, 2, path);
    else if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        addBytes(state, 4, path);
        index += 1;
      } else addBytes(state, 6, path);
    } else if (code >= 0xdc00 && code <= 0xdfff) addBytes(state, 6, path);
    else addBytes(state, 3, path);
  }
  addBytes(state, 1, path);
}

function appendPointer(path: string, segment: string): string {
  const bounded = segment.length > MAX_POINTER_SEGMENT_CODE_UNITS
    ? `redacted-key-${segment.length}`
    : segment.replace(/~/g, "~0").replace(/\//g, "~1");
  return `${path}/${bounded}`;
}

function walk(value: unknown, state: WalkState, depth: number, path: string): void {
  if (depth > state.limits.max_depth) {
    throw new JsonWalkError(path, `JSON value exceeds depth ${state.limits.max_depth}`, "maxJsonDepth");
  }
  state.deepest = Math.max(state.deepest, depth);
  state.values += 1;
  if (state.values > state.limits.max_values) {
    throw new JsonWalkError(path, `JSON value exceeds ${state.limits.max_values} values`, "maxJsonValues");
  }

  if (value === null) {
    addBytes(state, 4, path);
    token(state, "z;");
    return;
  }
  if (typeof value === "boolean") {
    addBytes(state, value ? 4 : 5, path);
    token(state, value ? "b1;" : "b0;");
    return;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new JsonWalkError(path, "JSON numbers must be finite", "jsonValue");
    const encoded = Object.is(value, -0) ? "0" : JSON.stringify(value);
    addBytes(state, encoded.length, path);
    token(state, `n${encoded};`);
    return;
  }
  if (typeof value === "string") {
    walkStringBytes(value, state, path);
    token(state, `s${value.length}:`);
    token(state, value);
    return;
  }
  if (typeof value !== "object") {
    throw new JsonWalkError(path, `unsupported ${typeof value} in JSON value`, "jsonValue");
  }

  const object = value as object;
  if (state.ancestors.has(object)) throw new JsonWalkError(path, "cyclic JSON value", "jsonValue");
  state.ancestors.add(object);
  try {
    if (Array.isArray(value)) {
      const remainingValues = state.limits.max_values - state.values;
      if (value.length > remainingValues) {
        throw new JsonWalkError(path, `JSON value exceeds ${state.limits.max_values} values`, "maxJsonValues");
      }
      const arrayKeys = Reflect.ownKeys(value);
      if (arrayKeys.length - 1 > remainingValues) {
        throw new JsonWalkError(path, `JSON value exceeds ${state.limits.max_values} values`, "maxJsonValues");
      }
      const unexpectedKey = arrayKeys.find((key) => {
        if (key === "length") return false;
        if (typeof key !== "string" || !/^(?:0|[1-9]\d*)$/.test(key)) return true;
        const index = Number(key);
        return !Number.isSafeInteger(index) || index < 0 || index >= value.length;
      });
      if (unexpectedKey !== undefined) {
        throw new JsonWalkError(path, "JSON arrays cannot contain symbols or named properties", "jsonValue");
      }
      addBytes(state, 2, path);
      token(state, "a[");
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor) {
          throw new JsonWalkError(appendPointer(path, String(index)), "sparse arrays are not JSON wire values", "jsonValue");
        }
        if (!descriptor.enumerable || !("value" in descriptor)) {
          throw new JsonWalkError(
            appendPointer(path, String(index)),
            "JSON array elements must be enumerable data properties",
            "jsonValue",
          );
        }
        if (index > 0) addBytes(state, 1, path);
        walk(descriptor.value, state, depth + 1, appendPointer(path, String(index)));
      }
      token(state, "]");
      return;
    }

    const prototype = Object.getPrototypeOf(object);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new JsonWalkError(path, "JSON objects must be plain objects", "jsonValue");
    }
    const ownKeys = Reflect.ownKeys(object);
    if (ownKeys.length > state.limits.max_values - state.values) {
      throw new JsonWalkError(path, `JSON value exceeds ${state.limits.max_values} values`, "maxJsonValues");
    }
    if (ownKeys.some((key) => typeof key !== "string")) {
      throw new JsonWalkError(path, "JSON objects cannot contain symbol keys", "jsonValue");
    }
    const keys = (ownKeys as string[]).sort();
    addBytes(state, 2, path);
    token(state, "o{");
    keys.forEach((key, index) => {
      const descriptor = Object.getOwnPropertyDescriptor(object, key);
      if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) {
        throw new JsonWalkError(
          appendPointer(path, key),
          "JSON object properties must be enumerable data properties",
          "jsonValue",
        );
      }
      if (index > 0) addBytes(state, 1, path);
      // Charge the key before materializing its diagnostic path. Otherwise one
      // oversized key can bypass a tiny byte budget with a megabyte error path.
      walkStringBytes(key, state, path);
      const nextPath = appendPointer(path, key);
      addBytes(state, 1, nextPath);
      token(state, `k${key.length}:`);
      token(state, key);
      walk(descriptor.value, state, depth + 1, nextPath);
    });
    token(state, "}");
  } finally {
    state.ancestors.delete(object);
  }
}

/** Total JSON-wire analysis: malformed or over-budget input is returned as data, never thrown. */
export function analyzeGenerativeUiJsonValue(
  value: unknown,
  options: AnalyzeGenerativeUiJsonValueOptions = {},
): GenerativeUiJsonValueAnalysis {
  const state: WalkState = {
    limits: DEFAULT_LIMITS,
    bytes: 0,
    values: 0,
    deepest: 0,
    ancestors: new WeakSet(),
    onToken: options.on_token,
  };
  try {
    state.limits = limitsFor(options.limits);
    walk(value, state, 0, options.path ?? "");
    return {
      valid: true,
      byte_length: state.bytes,
      value_count: state.values,
      max_depth: state.deepest,
    };
  } catch (cause) {
    const error = cause instanceof JsonWalkError
      ? cause
      : new JsonWalkError(options.path ?? "", "JSON value could not be inspected", "jsonValue");
    return {
      valid: false,
      byte_length: state.bytes,
      value_count: state.values,
      max_depth: state.deepest,
      error: { path: error.path, message: error.message, keyword: error.keyword },
    };
  }
}
