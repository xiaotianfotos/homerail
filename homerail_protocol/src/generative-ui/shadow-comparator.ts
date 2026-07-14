/**
 * Pure, non-authoritative Shadow comparison for Generative UI documents.
 *
 * This module produces evidence only. It does not validate, persist, mutate,
 * render, or choose an authoritative document.
 * @version 0.1.0
 */

import type {
  GenerativeUiDocumentV1,
  GenerativeUiStoredNodeV1,
} from "./types.js";
import { validateGenerativeUiDocument } from "./validation.js";
import {
  GENERATIVE_UI_MAX_DOCUMENT_BYTES,
  GENERATIVE_UI_MAX_JSON_DEPTH,
  GENERATIVE_UI_MAX_JSON_VALUES,
  analyzeGenerativeUiJsonValue,
} from "./json-value.js";

export const GENERATIVE_UI_SHADOW_REPORT_VERSION = 1 as const;
export const GENERATIVE_UI_SHADOW_MAX_DIFFERENCES = 128 as const;
export const GENERATIVE_UI_SHADOW_MAX_DEPTH = GENERATIVE_UI_MAX_JSON_DEPTH;
export const GENERATIVE_UI_SHADOW_MAX_WORK_UNITS = 32_000_000 as const;

export const GenerativeUiShadowReferenceKind = {
  EXPECTED: "expected",
  REPEAT: "repeat",
} as const;
export type GenerativeUiShadowReferenceKind =
  (typeof GenerativeUiShadowReferenceKind)[keyof typeof GenerativeUiShadowReferenceKind];

export const GenerativeUiShadowComparisonProfile = {
  SEMANTIC: "semantic",
  EXACT: "exact",
} as const;
export type GenerativeUiShadowComparisonProfile =
  (typeof GenerativeUiShadowComparisonProfile)[keyof typeof GenerativeUiShadowComparisonProfile];

export const GenerativeUiShadowDifferenceKind = {
  MISSING_FROM_DERIVED: "missing_from_derived",
  UNEXPECTED_IN_DERIVED: "unexpected_in_derived",
  TYPE_MISMATCH: "type_mismatch",
  VALUE_MISMATCH: "value_mismatch",
} as const;
export type GenerativeUiShadowDifferenceKind =
  (typeof GenerativeUiShadowDifferenceKind)[keyof typeof GenerativeUiShadowDifferenceKind];

export type GenerativeUiShadowValueType =
  | "null"
  | "boolean"
  | "number"
  | "string"
  | "array"
  | "object";

export interface GenerativeUiShadowValueEvidenceV1 {
  type: GenerativeUiShadowValueType;
  length?: number;
  size?: number;
  redacted?: boolean;
  truncated?: boolean;
}

export interface GenerativeUiShadowDifferenceV1 {
  /** RFC 6901 JSON Pointer into the selected comparison projection. */
  path: string;
  kind: GenerativeUiShadowDifferenceKind;
  reference?: GenerativeUiShadowValueEvidenceV1;
  derived?: GenerativeUiShadowValueEvidenceV1;
}

export interface GenerativeUiShadowEvidenceSummaryV1 {
  reference_node_count: number;
  derived_node_count: number;
  difference_count: number;
  reported_difference_count: number;
  missing_from_derived: number;
  unexpected_in_derived: number;
  type_mismatches: number;
  value_mismatches: number;
  truncated: boolean;
}

export interface GenerativeUiShadowEvidenceReportV1 {
  report_version: typeof GENERATIVE_UI_SHADOW_REPORT_VERSION;
  purpose: "shadow_evidence";
  authoritative: false;
  side_effect_free: true;
  reference_kind: GenerativeUiShadowReferenceKind;
  comparison_profile: GenerativeUiShadowComparisonProfile;
  matched: boolean;
  reference_document_id: string;
  derived_document_id: string;
  summary: GenerativeUiShadowEvidenceSummaryV1;
  differences: GenerativeUiShadowDifferenceV1[];
}

export interface CompareGenerativeUiShadowDocumentsInputV1 {
  /** Document produced by the Legacy Widget shadow derivation. */
  derived: GenerativeUiDocumentV1;
  /** Expected fixture or independently repeated derivation. */
  reference: GenerativeUiDocumentV1;
  reference_kind: GenerativeUiShadowReferenceKind;
}

export interface GenerativeUiShadowComparisonLimits {
  /** May lower, but never raise, the hard recursion-depth ceiling. */
  max_depth?: number;
  /** May lower, but never raise, the hard traversal-work ceiling. */
  max_work_units?: number;
}

export type GenerativeUiShadowComparisonErrorCode =
  | "invalid_input"
  | "invalid_reference_kind"
  | "invalid_reference_document"
  | "invalid_derived_document"
  | "invalid_json_value"
  | "invalid_limits"
  | "depth_budget_exceeded"
  | "work_budget_exceeded";

export class GenerativeUiShadowComparisonError extends Error {
  readonly code: GenerativeUiShadowComparisonErrorCode;

  constructor(code: GenerativeUiShadowComparisonErrorCode, message: string) {
    super(message);
    this.name = "GenerativeUiShadowComparisonError";
    this.code = code;
  }
}

type ComparableValue =
  | null
  | boolean
  | number
  | string
  | ComparableValue[]
  | { [key: string]: ComparableValue };

interface DifferenceAccumulator {
  total: number;
  missing: number;
  unexpected: number;
  typeMismatches: number;
  valueMismatches: number;
  differences: GenerativeUiShadowDifferenceV1[];
}

const MAX_EVIDENCE_STRING_LENGTH = 160;

interface TraversalBudget {
  maxDepth: number;
  maxWorkUnits: number;
  workUnits: number;
}

/**
 * Compares one derived document with expected or repeated Shadow output.
 *
 * `expected` compares semantic content: persistence revisions/timestamps and
 * node insertion order are ignored. `repeat` compares the complete canonical
 * JSON structure so nondeterministic timestamps, revisions, or array ordering
 * remain observable.
 */
export function compareGenerativeUiShadowDocuments(
  input: CompareGenerativeUiShadowDocumentsInputV1,
  limits: GenerativeUiShadowComparisonLimits = {},
): GenerativeUiShadowEvidenceReportV1 {
  assertComparisonInput(input);
  const budget = createTraversalBudget(limits);
  assertDocument(input.reference, "reference", budget);
  assertDocument(input.derived, "derived", budget);
  const profile = input.reference_kind === GenerativeUiShadowReferenceKind.REPEAT
    ? GenerativeUiShadowComparisonProfile.EXACT
    : GenerativeUiShadowComparisonProfile.SEMANTIC;
  const reference = profile === GenerativeUiShadowComparisonProfile.EXACT
    ? canonicalize(input.reference, budget, 0, "/reference", new WeakSet<object>())
    : semanticProjection(input.reference, budget, "/reference");
  const derived = profile === GenerativeUiShadowComparisonProfile.EXACT
    ? canonicalize(input.derived, budget, 0, "/derived", new WeakSet<object>())
    : semanticProjection(input.derived, budget, "/derived");
  const accumulator: DifferenceAccumulator = {
    total: 0,
    missing: 0,
    unexpected: 0,
    typeMismatches: 0,
    valueMismatches: 0,
    differences: [],
  };

  compareValues(reference, derived, "", accumulator, budget, 0);

  return {
    report_version: GENERATIVE_UI_SHADOW_REPORT_VERSION,
    purpose: "shadow_evidence",
    authoritative: false,
    side_effect_free: true,
    reference_kind: input.reference_kind,
    comparison_profile: profile,
    matched: accumulator.total === 0,
    reference_document_id: input.reference.document_id,
    derived_document_id: input.derived.document_id,
    summary: {
      reference_node_count: input.reference.nodes.length,
      derived_node_count: input.derived.nodes.length,
      difference_count: accumulator.total,
      reported_difference_count: accumulator.differences.length,
      missing_from_derived: accumulator.missing,
      unexpected_in_derived: accumulator.unexpected,
      type_mismatches: accumulator.typeMismatches,
      value_mismatches: accumulator.valueMismatches,
      truncated: accumulator.total > accumulator.differences.length,
    },
    differences: accumulator.differences,
  };
}

function assertComparisonInput(
  input: CompareGenerativeUiShadowDocumentsInputV1,
): void {
  if (!input || typeof input !== "object") {
    throw new GenerativeUiShadowComparisonError("invalid_input", "Shadow comparison input must be an object.");
  }
  if (
    input.reference_kind !== GenerativeUiShadowReferenceKind.EXPECTED
    && input.reference_kind !== GenerativeUiShadowReferenceKind.REPEAT
  ) {
    throw new GenerativeUiShadowComparisonError(
      "invalid_reference_kind",
      `Shadow reference_kind must be 'expected' or 'repeat'. Received: ${String(input.reference_kind)}.`,
    );
  }
}

function assertDocument(
  value: unknown,
  role: "reference" | "derived",
  budget: TraversalBudget,
): asserts value is GenerativeUiDocumentV1 {
  const code = role === "reference" ? "invalid_reference_document" : "invalid_derived_document";
  try {
    const json = analyzeGenerativeUiJsonValue(value, {
      path: `/${role}`,
      limits: {
        max_depth: budget.maxDepth,
        max_values: Math.min(GENERATIVE_UI_MAX_JSON_VALUES, budget.maxWorkUnits),
        max_bytes: GENERATIVE_UI_MAX_DOCUMENT_BYTES,
      },
    });
    if (!json.valid) {
      const errorCode = json.error?.keyword === "maxJsonDepth"
        ? "depth_budget_exceeded"
        : json.error?.keyword === "maxJsonValues"
          ? "work_budget_exceeded"
          : "invalid_json_value";
      throw new GenerativeUiShadowComparisonError(
        errorCode,
        `Shadow ${role} document is not safe to compare: ${json.error?.message || "invalid JSON value"}.`,
      );
    }
    const validation = validateGenerativeUiDocument(value);
    if (!validation.valid) {
      const detail = validation.errors
        .slice(0, 3)
        .map((error) => `${error.path || "/"}: ${error.message}`)
        .join("; ");
      throw new GenerativeUiShadowComparisonError(
        code,
        `Shadow ${role} document is invalid${detail ? `: ${detail}` : "."}`,
      );
    }
  } catch (cause) {
    if (cause instanceof GenerativeUiShadowComparisonError) throw cause;
    throw new GenerativeUiShadowComparisonError(
      code,
      `Shadow ${role} document could not be validated: ${cause instanceof Error ? cause.message : String(cause)}.`,
    );
  }
}

function createTraversalBudget(limits: GenerativeUiShadowComparisonLimits): TraversalBudget {
  return {
    maxDepth: resolveLimit(
      limits.max_depth,
      GENERATIVE_UI_SHADOW_MAX_DEPTH,
      "max_depth",
    ),
    maxWorkUnits: resolveLimit(
      limits.max_work_units,
      GENERATIVE_UI_SHADOW_MAX_WORK_UNITS,
      "max_work_units",
    ),
    workUnits: 0,
  };
}

function resolveLimit(value: number | undefined, hardMaximum: number, name: string): number {
  if (value === undefined) return hardMaximum;
  if (!Number.isInteger(value) || value < 1 || value > hardMaximum) {
    throw new GenerativeUiShadowComparisonError(
      "invalid_limits",
      `Shadow ${name} must be an integer between 1 and ${hardMaximum}. Received: ${String(value)}.`,
    );
  }
  return value;
}

function consumeBudget(
  budget: TraversalBudget,
  depth: number,
  phase: string,
  path: string,
): void {
  if (depth > budget.maxDepth) {
    throw new GenerativeUiShadowComparisonError(
      "depth_budget_exceeded",
      `Shadow ${phase} exceeded max depth ${budget.maxDepth} at ${path || "/"}.`,
    );
  }
  budget.workUnits += 1;
  if (budget.workUnits > budget.maxWorkUnits) {
    throw new GenerativeUiShadowComparisonError(
      "work_budget_exceeded",
      `Shadow comparison exceeded max work units ${budget.maxWorkUnits} during ${phase}.`,
    );
  }
}

function semanticProjection(
  document: GenerativeUiDocumentV1,
  budget: TraversalBudget,
  path: string,
): ComparableValue {
  const {
    revision: _revision,
    updated_at: _updatedAt,
    nodes,
    ...documentSemantics
  } = document;
  const nodesById = Object.create(null) as Record<
    string,
    Omit<GenerativeUiStoredNodeV1, "revision" | "updated_at">
  >;
  const sortedNodes = [...nodes].sort((left, right) => compareStrings(left.id, right.id));
  for (const node of sortedNodes) {
    const {
      revision: _nodeRevision,
      updated_at: _nodeUpdatedAt,
      ...nodeSemantics
    } = node;
    nodesById[node.id] = nodeSemantics;
  }
  return canonicalize(
    { ...documentSemantics, nodes: nodesById },
    budget,
    0,
    path,
    new WeakSet<object>(),
  );
}

function canonicalize(
  value: unknown,
  budget: TraversalBudget,
  depth: number,
  path: string,
  ancestors: WeakSet<object>,
): ComparableValue {
  consumeBudget(budget, depth, "canonicalization", path);
  if (value === null) return null;
  if (typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new GenerativeUiShadowComparisonError(
        "invalid_json_value",
        `Shadow document contains a non-finite number at ${path || "/"}.`,
      );
    }
    return Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value)) {
    if (ancestors.has(value)) {
      throw new GenerativeUiShadowComparisonError(
        "invalid_json_value",
        `Shadow document contains a cyclic array at ${path || "/"}.`,
      );
    }
    ancestors.add(value);
    try {
      return value.map((item, index) => canonicalize(
        item,
        budget,
        depth + 1,
        appendPointer(path, String(index)),
        ancestors,
      ));
    } finally {
      ancestors.delete(value);
    }
  }
  if (typeof value === "object") {
    const objectValue = value as object;
    if (ancestors.has(objectValue)) {
      throw new GenerativeUiShadowComparisonError(
        "invalid_json_value",
        `Shadow document contains a cyclic object at ${path || "/"}.`,
      );
    }
    const prototype = Object.getPrototypeOf(objectValue);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new GenerativeUiShadowComparisonError(
        "invalid_json_value",
        `Shadow document contains a non-JSON object at ${path || "/"}.`,
      );
    }
    const result = Object.create(null) as Record<string, ComparableValue>;
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => compareStrings(left, right));
    ancestors.add(objectValue);
    try {
      for (const [ordinal, [key, item]] of entries.entries()) {
        result[key] = canonicalize(
          item,
          budget,
          depth + 1,
          appendPointer(path, key, ordinal, true),
          ancestors,
        );
      }
      return result;
    } finally {
      ancestors.delete(objectValue);
    }
  }
  throw new GenerativeUiShadowComparisonError(
    "invalid_json_value",
    `Shadow document contains unsupported ${typeof value} at ${path || "/"}.`,
  );
}

function compareValues(
  reference: ComparableValue,
  derived: ComparableValue,
  path: string,
  accumulator: DifferenceAccumulator,
  budget: TraversalBudget,
  depth: number,
): void {
  consumeBudget(budget, depth, "difference traversal", path);
  const referenceType = comparableType(reference);
  const derivedType = comparableType(derived);
  if (referenceType !== derivedType) {
    recordDifference(accumulator, {
      path: path || "",
      kind: GenerativeUiShadowDifferenceKind.TYPE_MISMATCH,
      reference: evidenceValue(reference),
      derived: evidenceValue(derived),
    });
    return;
  }

  if (Array.isArray(reference) && Array.isArray(derived)) {
    const commonLength = Math.min(reference.length, derived.length);
    for (let index = 0; index < commonLength; index += 1) {
      compareValues(
        reference[index],
        derived[index],
        appendPointer(path, String(index)),
        accumulator,
        budget,
        depth + 1,
      );
    }
    for (let index = commonLength; index < reference.length; index += 1) {
      recordDifference(accumulator, {
        path: appendPointer(path, String(index)),
        kind: GenerativeUiShadowDifferenceKind.MISSING_FROM_DERIVED,
        reference: evidenceValue(reference[index]),
      });
    }
    for (let index = commonLength; index < derived.length; index += 1) {
      recordDifference(accumulator, {
        path: appendPointer(path, String(index)),
        kind: GenerativeUiShadowDifferenceKind.UNEXPECTED_IN_DERIVED,
        derived: evidenceValue(derived[index]),
      });
    }
    return;
  }

  if (isComparableObject(reference) && isComparableObject(derived)) {
    const keys = Array.from(new Set([...Object.keys(reference), ...Object.keys(derived)]))
      .sort(compareStrings);
    for (const [ordinal, key] of keys.entries()) {
      const referenceHasKey = Object.prototype.hasOwnProperty.call(reference, key);
      const derivedHasKey = Object.prototype.hasOwnProperty.call(derived, key);
      const nextPath = appendPointer(path, key, ordinal, true);
      if (!derivedHasKey) {
        recordDifference(accumulator, {
          path: nextPath,
          kind: GenerativeUiShadowDifferenceKind.MISSING_FROM_DERIVED,
          reference: evidenceValue(reference[key]),
        });
      } else if (!referenceHasKey) {
        recordDifference(accumulator, {
          path: nextPath,
          kind: GenerativeUiShadowDifferenceKind.UNEXPECTED_IN_DERIVED,
          derived: evidenceValue(derived[key]),
        });
      } else {
        compareValues(reference[key], derived[key], nextPath, accumulator, budget, depth + 1);
      }
    }
    return;
  }

  if (!Object.is(reference, derived)) {
    recordDifference(accumulator, {
      path: path || "",
      kind: GenerativeUiShadowDifferenceKind.VALUE_MISMATCH,
      reference: evidenceValue(reference),
      derived: evidenceValue(derived),
    });
  }
}

function recordDifference(
  accumulator: DifferenceAccumulator,
  difference: GenerativeUiShadowDifferenceV1,
): void {
  accumulator.total += 1;
  if (difference.kind === GenerativeUiShadowDifferenceKind.MISSING_FROM_DERIVED) accumulator.missing += 1;
  else if (difference.kind === GenerativeUiShadowDifferenceKind.UNEXPECTED_IN_DERIVED) accumulator.unexpected += 1;
  else if (difference.kind === GenerativeUiShadowDifferenceKind.TYPE_MISMATCH) accumulator.typeMismatches += 1;
  else accumulator.valueMismatches += 1;
  if (accumulator.differences.length < GENERATIVE_UI_SHADOW_MAX_DIFFERENCES) {
    accumulator.differences.push(difference);
  }
}

function comparableType(value: ComparableValue): GenerativeUiShadowValueType {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value as "boolean" | "number" | "string" | "object";
}

function evidenceValue(value: ComparableValue): GenerativeUiShadowValueEvidenceV1 {
  const type = comparableType(value);
  if (type === "string") {
    const stringValue = value as string;
    return {
      type,
      length: stringValue.length,
      redacted: true,
      truncated: stringValue.length > MAX_EVIDENCE_STRING_LENGTH,
    };
  }
  if (type === "number" || type === "boolean" || type === "null") {
    if (type === "null") return { type, redacted: true };
    return { type, redacted: true };
  }
  if (type === "array") return { type, size: (value as ComparableValue[]).length };
  const keys = Object.keys(value as Record<string, ComparableValue>).sort(compareStrings);
  return {
    type,
    size: keys.length,
    redacted: true,
  };
}

function isComparableObject(value: ComparableValue): value is { [key: string]: ComparableValue } {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function appendPointer(path: string, segment: string, ordinal = 0, objectKey = false): string {
  const dynamic = objectKey && (path.endsWith("/nodes")
    || path.includes("/content")
    || path.includes("/arguments")
    || path.includes("/input"));
  const safeSegment = dynamic
    ? `redacted-${ordinal}`
    : segment;
  return `${path}/${safeSegment.replace(/~/g, "~0").replace(/\//g, "~1")}`;
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
