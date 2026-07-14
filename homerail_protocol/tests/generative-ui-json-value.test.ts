import { describe, expect, it } from "vitest";

import {
  GENERATIVE_UI_IR_VERSION,
  GenerativeUiActorType,
  GenerativeUiImportance,
  GenerativeUiSurface,
  analyzeGenerativeUiJsonValue,
  applyGenerativeUiTransaction,
  createGenerativeUiDocument,
  validateGenerativeUiNode,
  type GenerativeUiNodeV1,
  type GenerativeUiTransactionV1,
} from "../src/generative-ui/index.js";

const time0 = "2026-07-11T12:00:00.000Z";

function node(content: Record<string, unknown>): GenerativeUiNodeV1 {
  return {
    ir_version: GENERATIVE_UI_IR_VERSION,
    id: "json-boundary",
    kind: "com.homerail.core/notice",
    kind_version: 1,
    owner: { id: "com.homerail.core", version: "0.1.0" },
    surface: GenerativeUiSurface.AMBIENT,
    importance: GenerativeUiImportance.SECONDARY,
    content,
    fallback: { title: "JSON boundary" },
  };
}

function transaction(candidate: GenerativeUiNodeV1): GenerativeUiTransactionV1 {
  return {
    ir_version: GENERATIVE_UI_IR_VERSION,
    transaction_id: "json-boundary-transaction",
    document_id: "json-boundary-document",
    base_revision: 0,
    actor: { type: GenerativeUiActorType.SYSTEM, id: "json-boundary-test" },
    operations: [{ op: "put", node: candidate }],
    created_at: time0,
  };
}

describe("Generative UI JSON value boundary", () => {
  it("counts exact wire bytes and emits a key-order-independent token stream", () => {
    const leftTokens: Uint8Array[] = [];
    const rightTokens: Uint8Array[] = [];
    const left = { z: "emoji 😀", a: [true, null, "line\nfeed"] };
    const right = { a: [true, null, "line\nfeed"], z: "emoji 😀" };
    const analysis = analyzeGenerativeUiJsonValue(left, { on_token: (value) => leftTokens.push(value) });
    const repeated = analyzeGenerativeUiJsonValue(right, { on_token: (value) => rightTokens.push(value) });

    expect(analysis).toMatchObject({
      valid: true,
      byte_length: new TextEncoder().encode(JSON.stringify(left)).byteLength,
    });
    expect(repeated.valid).toBe(true);
    expect(rightTokens).toEqual(leftTokens);

    const surrogateTokens = (value: string): number[] => {
      const chunks: Uint8Array[] = [];
      expect(analyzeGenerativeUiJsonValue(value, { on_token: (chunk) => chunks.push(chunk) }).valid).toBe(true);
      return chunks.flatMap((chunk) => Array.from(chunk));
    };
    expect(surrogateTokens("\ud800")).not.toEqual(surrogateTokens("\ud801"));
  });

  it("rejects non-JSON values as data without throwing", () => {
    const sparse: unknown[] = [];
    sparse.length = 1;
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const accessor: Record<string, unknown> = {};
    Object.defineProperty(accessor, "value", { enumerable: true, get: () => "secret" });
    const symbolKey = { value: 1 } as Record<PropertyKey, unknown>;
    symbolKey[Symbol("secret")] = true;
    const accessorArray = ["safe"];
    Object.defineProperty(accessorArray, "0", { enumerable: true, get: () => "secret" });
    const invalidValues: unknown[] = [
      undefined,
      () => undefined,
      1n,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      new Date(),
      sparse,
      circular,
      accessor,
      accessorArray,
      symbolKey,
    ];

    for (const value of invalidValues) {
      expect(() => analyzeGenerativeUiJsonValue(value)).not.toThrow();
      expect(analyzeGenerativeUiJsonValue(value)).toMatchObject({ valid: false });
    }
  });

  it("stops on explicit depth and byte budgets", () => {
    let deep: unknown = "leaf";
    for (let index = 0; index < 20; index += 1) deep = { child: deep };
    expect(analyzeGenerativeUiJsonValue(deep, { limits: { max_depth: 8 } })).toMatchObject({
      valid: false,
      error: { keyword: "maxJsonDepth" },
    });

    const oversized = analyzeGenerativeUiJsonValue("x".repeat(10_000), {
      limits: { max_bytes: 100 },
    });
    expect(oversized).toMatchObject({ valid: false, error: { keyword: "maxPayloadBytes" } });
    expect(oversized.byte_length).toBe(101);

    const secretKey = `secret-${"k".repeat(1_050_000)}`;
    const oversizedKey = analyzeGenerativeUiJsonValue({ [secretKey]: null }, {
      limits: { max_bytes: 100 },
    });
    expect(oversizedKey).toMatchObject({ valid: false, error: { keyword: "maxPayloadBytes" } });
    expect(oversizedKey.error?.path.length).toBeLessThan(128);
    expect(oversizedKey.error?.path).not.toContain("secret");

    const wideObject = Object.fromEntries(Array.from({ length: 1_000 }, (_, index) => [`key-${index}`, null]));
    const wideArray = Array.from({ length: 1_000 }, () => null);
    for (const wide of [wideObject, wideArray]) {
      expect(analyzeGenerativeUiJsonValue(wide, { limits: { max_values: 10 } })).toMatchObject({
        valid: false,
        value_count: 1,
        error: { keyword: "maxJsonValues" },
      });
    }
  });

  it("makes public validation and reduction total for hostile nested content", () => {
    const invalidContents: Array<Record<string, unknown>> = [
      { value: undefined },
      { value: 1n },
      { value: Number.NaN },
    ];
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    invalidContents.push(circular);

    for (const content of invalidContents) {
      const candidate = node(content);
      expect(() => validateGenerativeUiNode(candidate)).not.toThrow();
      expect(validateGenerativeUiNode(candidate).valid).toBe(false);

      const document = createGenerativeUiDocument({
        document_id: "json-boundary-document",
        scope: { type: "voice_session", id: "json-boundary-session" },
        created_at: time0,
      });
      const result = applyGenerativeUiTransaction(document, transaction(candidate), {
        transaction_already_applied: false,
        validate_kind: () => [],
      });
      expect(result.status).toBe("rejected");
      expect(result.document).toBe(document);
      expect(document.nodes).toEqual([]);
    }

    const proxied = new Proxy(node({ message: "safe-looking" }), {
      getOwnPropertyDescriptor(target, property) {
        return Reflect.getOwnPropertyDescriptor(target, property);
      },
      get(target, property, receiver) {
        if (property === "kind") throw new Error("late-changing proxy read");
        return Reflect.get(target, property, receiver);
      },
    });
    expect(() => validateGenerativeUiNode(proxied)).not.toThrow();
    expect(validateGenerativeUiNode(proxied)).toMatchObject({
      valid: false,
      errors: [{ keyword: "jsonSnapshot" }],
    });
  });
});
