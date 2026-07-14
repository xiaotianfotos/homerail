import { describe, expect, it } from "vitest";
import {
  GENERATIVE_UI_IR_VERSION,
  GENERATIVE_UI_SHADOW_MAX_DIFFERENCES,
  GenerativeUiImportance,
  GenerativeUiPhase,
  GenerativeUiShadowDifferenceKind,
  GenerativeUiShadowComparisonError,
  GenerativeUiShadowReferenceKind,
  GenerativeUiSurface,
  compareGenerativeUiShadowDocuments,
  type GenerativeUiDocumentV1,
  type GenerativeUiStoredNodeV1,
} from "../src/generative-ui/index.js";

const time0 = "2026-07-11T08:00:00.000Z";
const time1 = "2026-07-11T08:01:00.000Z";

function storedNode(
  id: string,
  content: Record<string, unknown> = { objective: `Objective for ${id}` },
): GenerativeUiStoredNodeV1 {
  return {
    ir_version: GENERATIVE_UI_IR_VERSION,
    id,
    kind: "com.homerail.core/task_summary",
    kind_version: 1,
    owner: { id: "com.homerail.core", version: "0.1.0" },
    surface: GenerativeUiSurface.TASK,
    importance: GenerativeUiImportance.PRIMARY,
    status: { phase: GenerativeUiPhase.WAITING },
    content,
    fallback: { title: `Fallback for ${id}` },
    revision: 1,
    updated_at: time0,
  };
}

function document(nodes: GenerativeUiStoredNodeV1[]): GenerativeUiDocumentV1 {
  return {
    ir_version: GENERATIVE_UI_IR_VERSION,
    document_id: "legacy-shadow-document",
    scope: { type: "voice_session", id: "legacy-session" },
    revision: 1,
    nodes,
    updated_at: time0,
  };
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

describe("Generative UI Shadow comparator", () => {
  it("compares expected semantic output without treating storage metadata or node order as drift", () => {
    const reference = document([storedNode("task-a"), storedNode("task-b")]);
    const derived = structuredClone(reference);
    derived.revision = 9;
    derived.updated_at = time1;
    derived.nodes.reverse();
    derived.nodes[0].revision = 4;
    derived.nodes[0].updated_at = time1;

    const report = compareGenerativeUiShadowDocuments({
      derived,
      reference,
      reference_kind: GenerativeUiShadowReferenceKind.EXPECTED,
    });

    expect(report).toEqual({
      report_version: 1,
      purpose: "shadow_evidence",
      authoritative: false,
      side_effect_free: true,
      reference_kind: "expected",
      comparison_profile: "semantic",
      matched: true,
      reference_document_id: "legacy-shadow-document",
      derived_document_id: "legacy-shadow-document",
      summary: {
        reference_node_count: 2,
        derived_node_count: 2,
        difference_count: 0,
        reported_difference_count: 0,
        missing_from_derived: 0,
        unexpected_in_derived: 0,
        type_mismatches: 0,
        value_mismatches: 0,
        truncated: false,
      },
      differences: [],
    });
  });

  it("emits stable, bounded evidence without mutating either document", () => {
    const reference = deepFreeze(document([
      storedNode("task-a", { objective: "Expected objective" }),
      storedNode("task-b"),
    ]));
    const derived = deepFreeze(document([
      storedNode("task-a", { objective: "Derived objective" }),
      storedNode("task-c"),
    ]));
    const referenceBefore = JSON.stringify(reference);
    const derivedBefore = JSON.stringify(derived);

    const first = compareGenerativeUiShadowDocuments({
      derived,
      reference,
      reference_kind: GenerativeUiShadowReferenceKind.EXPECTED,
    });
    const repeated = compareGenerativeUiShadowDocuments({
      derived,
      reference,
      reference_kind: GenerativeUiShadowReferenceKind.EXPECTED,
    });

    expect(JSON.stringify(repeated)).toBe(JSON.stringify(first));
    expect(JSON.stringify(reference)).toBe(referenceBefore);
    expect(JSON.stringify(derived)).toBe(derivedBefore);
    expect(first.matched).toBe(false);
    expect(first.summary).toMatchObject({
      difference_count: 3,
      missing_from_derived: 1,
      unexpected_in_derived: 1,
      value_mismatches: 1,
      truncated: false,
    });
    expect(first.differences.map((difference) => difference.kind)).toEqual([
      GenerativeUiShadowDifferenceKind.VALUE_MISMATCH,
      GenerativeUiShadowDifferenceKind.MISSING_FROM_DERIVED,
      GenerativeUiShadowDifferenceKind.UNEXPECTED_IN_DERIVED,
    ]);
    expect(first.differences[0].path).toMatch(/^\/nodes\/redacted-\d+\/content\/redacted-\d+$/);
    expect(first.differences[1].path).toMatch(/^\/nodes\/redacted-\d+$/);
    expect(first.differences[2].path).toMatch(/^\/nodes\/redacted-\d+$/);
    const valueMismatch = first.differences[0];
    expect(valueMismatch.reference).toEqual({
      type: "string",
      length: 18,
      redacted: true,
      truncated: false,
    });
    expect(valueMismatch.derived).toEqual({
      type: "string",
      length: 17,
      redacted: true,
      truncated: false,
    });
    expect(JSON.stringify(first)).not.toContain("Expected objective");
    expect(JSON.stringify(first)).not.toContain("Derived objective");
    expect(JSON.stringify(first)).not.toContain("task-a");
    expect(JSON.stringify(first)).not.toContain("objective");
  });

  it("uses exact comparison for a repeated derivation so metadata and ordering drift remain visible", () => {
    const reference = document([storedNode("task-a"), storedNode("task-b")]);
    const exactRepeat = structuredClone(reference);
    const exactReport = compareGenerativeUiShadowDocuments({
      derived: exactRepeat,
      reference,
      reference_kind: GenerativeUiShadowReferenceKind.REPEAT,
    });
    expect(exactReport).toMatchObject({
      authoritative: false,
      comparison_profile: "exact",
      matched: true,
    });

    const driftingRepeat = structuredClone(reference);
    driftingRepeat.updated_at = time1;
    driftingRepeat.nodes.reverse();
    const driftReport = compareGenerativeUiShadowDocuments({
      derived: driftingRepeat,
      reference,
      reference_kind: GenerativeUiShadowReferenceKind.REPEAT,
    });

    expect(driftReport.matched).toBe(false);
    const driftPaths = driftReport.differences.map((difference) => difference.path);
    expect(driftPaths).toEqual(expect.arrayContaining([
      "/nodes/0/fallback/title",
      "/nodes/0/id",
      "/nodes/1/fallback/title",
      "/nodes/1/id",
      "/updated_at",
    ]));
    expect(driftPaths.filter((path) => /\/nodes\/[01]\/content\/redacted-\d+$/.test(path))).toHaveLength(2);
  });

  it("treats the direct A2UI surface as semantic shadow evidence", () => {
    const referenceNode = storedNode("task-a");
    referenceNode.a2ui = {
      version: "v1.0",
      catalogId: "https://homerail.dev/a2ui/catalogs/core/v1",
      components: [{ id: "root", component: "Text", text: "Expected" }],
    };
    const derivedNode = structuredClone(referenceNode);
    derivedNode.a2ui.components[0] = { id: "root", component: "Text", text: "Derived" };

    const report = compareGenerativeUiShadowDocuments({
      derived: document([derivedNode]),
      reference: document([referenceNode]),
      reference_kind: GenerativeUiShadowReferenceKind.EXPECTED,
    });

    expect(report.matched).toBe(false);
    expect(report.differences).toEqual([
      expect.objectContaining({
        path: expect.stringMatching(/^\/nodes\/redacted-\d+\/a2ui\/components\/0\/text$/),
        kind: GenerativeUiShadowDifferenceKind.VALUE_MISMATCH,
      }),
    ]);
  });

  it("counts all drift while bounding the evidence payload", () => {
    const referenceContent = Object.fromEntries(
      Array.from({ length: GENERATIVE_UI_SHADOW_MAX_DIFFERENCES + 8 }, (_, index) => [`field-${index}`, "expected"]),
    );
    const derivedContent = Object.fromEntries(
      Array.from({ length: GENERATIVE_UI_SHADOW_MAX_DIFFERENCES + 8 }, (_, index) => [`field-${index}`, "derived"]),
    );
    const report = compareGenerativeUiShadowDocuments({
      derived: document([storedNode("task-a", { fields: derivedContent })]),
      reference: document([storedNode("task-a", { fields: referenceContent })]),
      reference_kind: GenerativeUiShadowReferenceKind.EXPECTED,
    });

    expect(report.summary).toMatchObject({
      difference_count: GENERATIVE_UI_SHADOW_MAX_DIFFERENCES + 8,
      reported_difference_count: GENERATIVE_UI_SHADOW_MAX_DIFFERENCES,
      value_mismatches: GENERATIVE_UI_SHADOW_MAX_DIFFERENCES + 8,
      truncated: true,
    });
    expect(report.differences).toHaveLength(GENERATIVE_UI_SHADOW_MAX_DIFFERENCES);
  });

  it("preserves __proto__ node ids and content keys in semantic evidence", () => {
    const referenceContent = JSON.parse('{"__proto__":"expected"}') as Record<string, unknown>;
    const derivedContent = JSON.parse('{"__proto__":"derived"}') as Record<string, unknown>;
    const report = compareGenerativeUiShadowDocuments({
      derived: document([storedNode("__proto__", derivedContent)]),
      reference: document([storedNode("__proto__", referenceContent)]),
      reference_kind: GenerativeUiShadowReferenceKind.EXPECTED,
    });

    expect(report.matched).toBe(false);
    expect(report.summary.difference_count).toBe(1);
    expect(report.differences[0]).toMatchObject({
      kind: GenerativeUiShadowDifferenceKind.VALUE_MISMATCH,
      reference: { type: "string", length: 8, redacted: true },
      derived: { type: "string", length: 7, redacted: true },
    });
    expect(report.differences[0].path).toMatch(/^\/nodes\/redacted-\d+\/content\/redacted-\d+$/);
    expect(JSON.stringify(report)).not.toContain("__proto__");
  });

  it("redacts numeric object keys and node ids while preserving array indices", () => {
    const report = compareGenerativeUiShadowDocuments({
      derived: document([storedNode("123456", { "654321": "derived" })]),
      reference: document([storedNode("123456", { "654321": "expected" })]),
      reference_kind: GenerativeUiShadowReferenceKind.EXPECTED,
    });

    expect(report.differences[0].path).toMatch(
      /^\/nodes\/redacted-\d+\/content\/redacted-\d+$/,
    );
    expect(JSON.stringify(report)).not.toContain("123456");
    expect(JSON.stringify(report)).not.toContain("654321");
  });

  it("rejects unknown reference kinds and invalid documents before comparison", () => {
    expectComparisonError(() => compareGenerativeUiShadowDocuments({
      derived: document([]),
      reference: document([]),
      reference_kind: "typo" as never,
    }), "invalid_reference_kind");

    const invalidReference = document([]);
    invalidReference.document_id = "";
    expectComparisonError(() => compareGenerativeUiShadowDocuments({
      derived: document([]),
      reference: invalidReference,
      reference_kind: GenerativeUiShadowReferenceKind.EXPECTED,
    }), "invalid_reference_document");

    const invalidDerived = document([]);
    invalidDerived.scope.id = "";
    expectComparisonError(() => compareGenerativeUiShadowDocuments({
      derived: invalidDerived,
      reference: document([]),
      reference_kind: GenerativeUiShadowReferenceKind.EXPECTED,
    }), "invalid_derived_document");
  });

  it("rejects non-JSON values that the structural schema does not inspect recursively", () => {
    const reference = document([storedNode("task-a", { nested: undefined })]);
    expectComparisonError(() => compareGenerativeUiShadowDocuments({
      derived: document([storedNode("task-a")]),
      reference,
      reference_kind: GenerativeUiShadowReferenceKind.EXPECTED,
    }), "invalid_json_value");
  });

  it("redacts long string evidence while retaining length and truncation metadata", () => {
    const referenceSecret = `secret-reference-${"a".repeat(200)}`;
    const derivedSecret = `secret-derived-${"b".repeat(200)}`;
    const report = compareGenerativeUiShadowDocuments({
      derived: document([storedNode("task-a", { secret: derivedSecret })]),
      reference: document([storedNode("task-a", { secret: referenceSecret })]),
      reference_kind: GenerativeUiShadowReferenceKind.EXPECTED,
    });

    expect(report.differences[0].reference).toMatchObject({
      type: "string",
      length: referenceSecret.length,
      redacted: true,
      truncated: true,
    });
    expect(report.differences[0].derived).toMatchObject({
      type: "string",
      length: derivedSecret.length,
      redacted: true,
      truncated: true,
    });
    expect(JSON.stringify(report)).not.toContain(referenceSecret);
    expect(JSON.stringify(report)).not.toContain(derivedSecret);
    expect(JSON.stringify(report)).not.toContain("secret");
  });

  it("redacts numeric and boolean evidence instead of exposing raw values", () => {
    const report = compareGenerativeUiShadowDocuments({
      derived: document([storedNode("task-a", { pin: 654321, allowed: false })]),
      reference: document([storedNode("task-a", { pin: 123456, allowed: true })]),
      reference_kind: GenerativeUiShadowReferenceKind.EXPECTED,
    });

    expect(report.differences).toHaveLength(2);
    for (const difference of report.differences) {
      expect(difference.reference).toEqual(expect.objectContaining({ redacted: true }));
      expect(difference.derived).toEqual(expect.objectContaining({ redacted: true }));
      expect(difference.reference).not.toHaveProperty("hash");
      expect(difference.derived).not.toHaveProperty("hash");
    }
    expect(JSON.stringify(report)).not.toContain("654321");
    expect(JSON.stringify(report)).not.toContain("123456");
    expect(JSON.stringify(report)).not.toContain("pin");
  });

  it("fails explicitly when canonicalization exceeds depth or work budgets", () => {
    let nested: unknown = "leaf";
    for (let index = 0; index < 20; index += 1) nested = { child: nested };
    const deeplyNested = document([storedNode("deep-task", { nested })]);
    expectComparisonError(() => compareGenerativeUiShadowDocuments({
      derived: structuredClone(deeplyNested),
      reference: deeplyNested,
      reference_kind: GenerativeUiShadowReferenceKind.EXPECTED,
    }, { max_depth: 8 }), "depth_budget_exceeded");

    expectComparisonError(() => compareGenerativeUiShadowDocuments({
      derived: document([storedNode("task-a")]),
      reference: document([storedNode("task-a")]),
      reference_kind: GenerativeUiShadowReferenceKind.EXPECTED,
    }, { max_work_units: 10 }), "work_budget_exceeded");
  });
});

function expectComparisonError(
  callback: () => unknown,
  code: GenerativeUiShadowComparisonError["code"],
): void {
  try {
    callback();
    throw new Error(`expected ${code}`);
  } catch (error) {
    expect(error).toBeInstanceOf(GenerativeUiShadowComparisonError);
    expect((error as GenerativeUiShadowComparisonError).code).toBe(code);
  }
}
