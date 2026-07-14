import {
  analyzeGenerativeUiJsonValue,
  decodeHomerailPluginUtf8,
  type HomerailPluginManifestV1,
} from "homerail-protocol";
import { canonicalHrpJsonBytes } from "./archive.js";

export const HOMERAIL_KIND_MIGRATION_VERSION = 1 as const;
export const MAX_HOMERAIL_KIND_MIGRATION_BYTES = 32 * 1024;
export const MAX_HOMERAIL_KIND_MIGRATION_OPERATIONS = 64;

export type HomerailKindMigrationOperationV1 =
  | { op: "rename"; from: string; path: string }
  | { op: "set_default"; path: string; value: unknown }
  | { op: "remove"; path: string };

export interface HomerailKindMigrationV1 {
  migration_version: 1;
  type: "declarative_kind_content";
  from: number;
  to: number;
  operations: HomerailKindMigrationOperationV1[];
}

const SAFE_POINTER_SEGMENT = /^[A-Za-z0-9._-]{1,64}$/;
const FORBIDDEN_FIELD = /^(?:__proto__|prototype|constructor|code|script|command|executable|handler|url|uri)$/i;
const URL_LIKE = /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i;

export function isHomerailDeclarativeKindMigrationManifest(
  manifest: HomerailPluginManifestV1,
): boolean {
  return manifest.runtime.trust === "data_only"
    && manifest.runtime.entrypoint === undefined
    && manifest.permissions.required.length === 0
    && manifest.permissions.optional.length === 0
    && manifest.actions.length === 0
    && manifest.workflows.length === 0
    && manifest.state.schema_version === 1
    && manifest.state.migrations.length === 0
    && manifest.kinds.some((kind) => kind.migrations.length > 0)
    && manifest.renderers.every((renderer) => (
      renderer.mode === "declarative" && renderer.source.type === "declarative"
    ))
    && manifest.tools.every((tool) => (
      tool.handler.type === "projection"
      && tool.effect === "write"
      && tool.permissions.length === 0
      && tool.confirmation === "never"
      && Boolean(tool.output_schema)
    ));
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[], label: string): void {
  if (Object.keys(value).sort().join(",") !== [...expected].sort().join(",")) {
    throw new Error(`${label} must contain exact keys: ${expected.join(", ")}`);
  }
}

function pointerSegments(value: unknown, label: string): string[] {
  if (typeof value !== "string" || value.length > 256 || !value.startsWith("/")) {
    throw new Error(`${label} must be a bounded absolute field pointer`);
  }
  const segments = value.slice(1).split("/");
  if (
    !segments.length
    || segments.length > 8
    || segments.some((segment) => !SAFE_POINTER_SEGMENT.test(segment) || FORBIDDEN_FIELD.test(segment))
  ) throw new Error(`${label} contains an unsafe or unsupported field segment`);
  return segments;
}

function assertSafeLiteral(value: unknown, path: string): void {
  const analysis = analyzeGenerativeUiJsonValue(value, {
    path,
    limits: { max_bytes: 8 * 1024, max_depth: 12, max_values: 512 },
  });
  if (!analysis.valid) throw new Error(`Migration literal is invalid: ${analysis.error?.message ?? "jsonValue"}`);
  const visit = (candidate: unknown, candidatePath: string): void => {
    if (typeof candidate === "string" && URL_LIKE.test(candidate.trim())) {
      throw new Error(`Migration literal cannot contain a URL at ${candidatePath}`);
    }
    if (Array.isArray(candidate)) {
      candidate.forEach((child, index) => visit(child, `${candidatePath}/${index}`));
      return;
    }
    if (!candidate || typeof candidate !== "object") return;
    for (const [key, child] of Object.entries(candidate as Record<string, unknown>)) {
      if (FORBIDDEN_FIELD.test(key)) {
        throw new Error(`Migration literal contains a forbidden field at ${candidatePath}/${key}`);
      }
      visit(child, `${candidatePath}/${key}`);
    }
  };
  visit(value, path);
}

function normalizeOperation(value: unknown, index: number): HomerailKindMigrationOperationV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Migration operation ${index} must be an object`);
  }
  const raw = value as Record<string, unknown>;
  if (raw.op === "rename") {
    exactKeys(raw, ["op", "from", "path"], `Migration rename operation ${index}`);
    pointerSegments(raw.from, `Migration operation ${index} from`);
    pointerSegments(raw.path, `Migration operation ${index} path`);
    if (raw.from === raw.path) throw new Error(`Migration rename operation ${index} must change the path`);
    return { op: "rename", from: raw.from as string, path: raw.path as string };
  }
  if (raw.op === "set_default") {
    exactKeys(raw, ["op", "path", "value"], `Migration set_default operation ${index}`);
    pointerSegments(raw.path, `Migration operation ${index} path`);
    assertSafeLiteral(raw.value, `/operations/${index}/value`);
    return { op: "set_default", path: raw.path as string, value: structuredClone(raw.value) };
  }
  if (raw.op === "remove") {
    exactKeys(raw, ["op", "path"], `Migration remove operation ${index}`);
    pointerSegments(raw.path, `Migration operation ${index} path`);
    return { op: "remove", path: raw.path as string };
  }
  throw new Error(`Migration operation ${index} has an unsupported op`);
}

export function parseHomerailKindMigrationV1(
  contentValue: Uint8Array,
  expected?: { from: number; to: number },
): HomerailKindMigrationV1 {
  const content = Buffer.from(contentValue);
  if (!content.byteLength || content.byteLength > MAX_HOMERAIL_KIND_MIGRATION_BYTES) {
    throw new Error("Kind migration file size is outside limits");
  }
  let value: unknown;
  try {
    value = JSON.parse(decodeHomerailPluginUtf8(content, "kind migration"));
  } catch (cause) {
    throw new Error(`Invalid kind migration JSON: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Kind migration must be an object");
  }
  const raw = value as Record<string, unknown>;
  exactKeys(raw, ["migration_version", "type", "from", "to", "operations"], "Kind migration");
  if (
    raw.migration_version !== 1
    || raw.type !== "declarative_kind_content"
    || !Number.isSafeInteger(raw.from)
    || Number(raw.from) < 1
    || !Number.isSafeInteger(raw.to)
    || Number(raw.to) !== Number(raw.from) + 1
    || !Array.isArray(raw.operations)
    || !raw.operations.length
    || raw.operations.length > MAX_HOMERAIL_KIND_MIGRATION_OPERATIONS
  ) throw new Error("Kind migration header or operation count is invalid");
  const migration: HomerailKindMigrationV1 = {
    migration_version: 1,
    type: "declarative_kind_content",
    from: Number(raw.from),
    to: Number(raw.to),
    operations: raw.operations.map(normalizeOperation),
  };
  if (expected && (migration.from !== expected.from || migration.to !== expected.to)) {
    throw new Error("Kind migration file identity does not match its manifest declaration");
  }
  if (!content.equals(canonicalHrpJsonBytes(migration))) {
    throw new Error("Kind migration must use canonical JSON bytes");
  }
  return migration;
}

function parentAt(
  root: Record<string, unknown>,
  segments: readonly string[],
  options: { missing: "ignore" | "error" },
): Record<string, unknown> | undefined {
  let current: unknown = root;
  for (const segment of segments.slice(0, -1)) {
    if (!current || typeof current !== "object" || Array.isArray(current)) {
      if (options.missing === "ignore") return undefined;
      throw new Error(`Kind migration path parent is not an object: ${segments.join("/")}`);
    }
    if (!Object.prototype.hasOwnProperty.call(current, segment)) {
      if (options.missing === "ignore") return undefined;
      throw new Error(`Kind migration path parent does not exist: ${segments.join("/")}`);
    }
    current = (current as Record<string, unknown>)[segment];
  }
  if (!current || typeof current !== "object" || Array.isArray(current)) {
    if (options.missing === "ignore") return undefined;
    throw new Error(`Kind migration path parent is not an object: ${segments.join("/")}`);
  }
  return current as Record<string, unknown>;
}

export function applyHomerailKindMigrationV1(
  content: Record<string, unknown>,
  migration: HomerailKindMigrationV1,
): Record<string, unknown> {
  const sourceAnalysis = analyzeGenerativeUiJsonValue(content, {
    path: "/content",
    limits: { max_bytes: 32 * 1024, max_depth: 32, max_values: 32_768 },
  });
  if (!sourceAnalysis.valid) {
    throw new Error(`Kind migration input is invalid: ${sourceAnalysis.error?.message ?? "jsonValue"}`);
  }
  const next = structuredClone(content);
  for (const operation of migration.operations) {
    if (operation.op === "rename") {
      const fromSegments = pointerSegments(operation.from, "Migration rename from");
      const source = parentAt(next, fromSegments, { missing: "ignore" });
      const fromKey = fromSegments.at(-1)!;
      if (!source || !Object.prototype.hasOwnProperty.call(source, fromKey)) continue;
      const toSegments = pointerSegments(operation.path, "Migration rename path");
      const target = parentAt(next, toSegments, { missing: "error" })!;
      const toKey = toSegments.at(-1)!;
      if (Object.prototype.hasOwnProperty.call(target, toKey)) {
        throw new Error(`Kind migration rename target already exists: ${operation.path}`);
      }
      target[toKey] = source[fromKey];
      delete source[fromKey];
      continue;
    }
    const segments = pointerSegments(operation.path, `Migration ${operation.op} path`);
    const parent = parentAt(next, segments, {
      missing: operation.op === "remove" ? "ignore" : "error",
    });
    if (!parent) continue;
    const key = segments.at(-1)!;
    if (operation.op === "remove") {
      delete parent[key];
    } else if (!Object.prototype.hasOwnProperty.call(parent, key)) {
      parent[key] = structuredClone(operation.value);
    }
  }
  return next;
}
