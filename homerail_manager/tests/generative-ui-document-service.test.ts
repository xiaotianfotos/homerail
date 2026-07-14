import { describe, expect, it } from "vitest";

import {
  GENERATIVE_UI_IR_VERSION,
  GenerativeUiActorType,
  GenerativeUiImportance,
  GenerativeUiPhase,
  GenerativeUiSurface,
  type GenerativeUiNodeV1,
  type GenerativeUiTransactionV1,
  validateGenerativeUiTransaction,
} from "homerail-protocol";
import { InMemoryGenerativeUiDocumentService } from "../src/generative-ui/document-service.js";

const createdAt = "2026-07-11T09:00:00.000Z";
const updatedAt = "2026-07-11T09:01:00.000Z";
const scope = { type: "voice_session", id: "voice-session-1" } as const;

function node(title = "Shadow task"): GenerativeUiNodeV1 {
  return {
    ir_version: GENERATIVE_UI_IR_VERSION,
    id: "task-draft",
    kind: "com.homerail.core/task_summary",
    kind_version: 1,
    owner: { id: "com.homerail.core", version: "0.1.0" },
    surface: GenerativeUiSurface.TASK,
    importance: GenerativeUiImportance.PRIMARY,
    status: { phase: GenerativeUiPhase.DRAFT },
    content: { title },
    fallback: { title },
  };
}

function transaction(input: Partial<GenerativeUiTransactionV1> = {}): GenerativeUiTransactionV1 {
  return {
    ir_version: GENERATIVE_UI_IR_VERSION,
    transaction_id: input.transaction_id ?? "shadow-turn-1",
    document_id: input.document_id ?? "voice-session-1-ui",
    base_revision: input.base_revision ?? 0,
    actor: input.actor ?? { type: GenerativeUiActorType.SYSTEM, id: "legacy-widget-shadow" },
    operations: input.operations ?? [{ op: "put", node: node() }],
    created_at: input.created_at ?? updatedAt,
  };
}

function service(): InMemoryGenerativeUiDocumentService {
  return new InMemoryGenerativeUiDocumentService((storedNode) => storedNode.kind.startsWith("com.homerail.core/")
    ? []
    : [{ path: "/kind", message: "unknown shadow kind", keyword: "kindRegistry" }]);
}

function createDocument(target = service()): InMemoryGenerativeUiDocumentService {
  target.createOrGet({
    documentId: "voice-session-1-ui",
    scope,
    createdAt,
  });
  return target;
}

describe("InMemoryGenerativeUiDocumentService", () => {
  it("creates one isolated document and never exposes canonical references", () => {
    const target = createDocument();
    const first = target.get("voice-session-1-ui", scope);
    if (!first) throw new Error("document missing");
    first.nodes.push({ ...node(), revision: 1, updated_at: updatedAt });

    expect(target.get("voice-session-1-ui", scope)).toMatchObject({ revision: 0, nodes: [] });
    expect(target.createOrGet({
      documentId: "voice-session-1-ui",
      scope: { type: "voice_session", id: "voice-session-1" },
      createdAt: updatedAt,
    })).toMatchObject({ revision: 0, updated_at: createdAt });
  });

  it("rejects scope reuse for a different session", () => {
    const target = createDocument();
    expect(() => target.createOrGet({
      documentId: "voice-session-1-ui",
      scope: { type: "voice_session", id: "voice-session-2" },
      createdAt,
    })).toThrow("document scope mismatch");
  });

  it("applies valid transactions and stores the new revision", () => {
    const target = createDocument();
    const result = target.apply(transaction(), scope);

    expect(result).toMatchObject({ status: "applied", revision: 1 });
    expect(target.get("voice-session-1-ui", scope)).toMatchObject({
      revision: 1,
      nodes: [{ id: "task-draft", revision: 1 }],
    });
  });

  it("returns duplicate for the same transaction without advancing state", () => {
    const target = createDocument();
    const input = transaction();
    expect(target.apply(input, scope).status).toBe("applied");
    expect(target.apply(structuredClone(input), scope)).toMatchObject({ status: "duplicate", revision: 1 });
    expect(target.get("voice-session-1-ui", scope)?.revision).toBe(1);
  });

  it("rejects transaction-id reuse with different input", () => {
    const target = createDocument();
    expect(target.apply(transaction(), scope).status).toBe("applied");
    const collision = target.apply(transaction({
      base_revision: 1,
      operations: [{ op: "put", node: node("Changed payload") }],
    }), scope);

    expect(collision.status).toBe("rejected");
    expect(collision.errors?.[0]?.keyword).toBe("transactionIdCollision");
    expect(target.get("voice-session-1-ui", scope)?.nodes[0]?.content).toEqual({ title: "Shadow task" });
  });

  it("distinguishes isolated UTF-16 surrogates in transaction fingerprints", () => {
    const target = createDocument();
    const first = transaction({ operations: [{ op: "put", node: node("\ud800") }] });
    expect(target.apply(first, scope).status).toBe("applied");

    const collision = target.apply(
      transaction({ operations: [{ op: "put", node: node("\ud801") }] }),
      scope,
    );
    expect(collision.status).toBe("rejected");
    expect(collision.errors?.[0]?.keyword).toBe("transactionIdCollision");
  });

  it("leaves canonical state unchanged on conflicts and kind-policy rejection", () => {
    const target = createDocument();
    expect(target.apply(transaction({ base_revision: 4 }), scope).status).toBe("conflict");

    const invalidNode = node();
    invalidNode.kind = "com.example.plugin/task";
    invalidNode.owner = { id: "com.example.plugin", version: "1.0.0" };
    const rejected = target.apply(transaction({ operations: [{ op: "put", node: invalidNode }] }), scope);
    expect(rejected.status).toBe("rejected");
    expect(rejected.errors?.[0]?.keyword).toBe("kindRegistry");
    expect(target.get("voice-session-1-ui", scope)).toMatchObject({ revision: 0, nodes: [] });
  });

  it("removes a document and its idempotency records together", () => {
    const target = createDocument();
    expect(target.apply(transaction(), scope).status).toBe("applied");
    expect(target.delete("voice-session-1-ui", scope)).toBe(true);
    expect(target.get("voice-session-1-ui", scope)).toBeUndefined();
    expect(() => createDocument(target)).toThrow("cannot be reused after deletion");
  });

  it("isolates transaction ids and caller scopes across documents", () => {
    const target = createDocument();
    const otherScope = { type: "voice_session", id: "voice-session-2" } as const;
    target.createOrGet({
      documentId: "voice-session-2-ui",
      scope: otherScope,
      createdAt,
    });

    expect(target.apply(transaction(), scope).status).toBe("applied");
    expect(target.apply(transaction({ document_id: "voice-session-2-ui" }), otherScope).status).toBe("applied");
    expect(target.apply(transaction({
      transaction_id: "shadow-turn-2",
      base_revision: 1,
    }), otherScope).errors?.[0]?.keyword).toBe("documentScope");
  });

  it("rejects non-JSON transaction input without changing canonical state", () => {
    const target = createDocument();
    const circular = transaction() as unknown as Record<string, unknown>;
    circular.loop = circular;
    const result = target.apply(circular as unknown as GenerativeUiTransactionV1, scope);

    expect(result.status).toBe("rejected");
    expect(result.errors?.[0]?.keyword).toBe("jsonValue");
    expect(target.get("voice-session-1-ui", scope)).toMatchObject({ revision: 0, nodes: [] });
  });

  it("uses the explicit Protocol resource envelope without a stricter hidden fingerprint quota", () => {
    const target = createDocument();
    const operations = Array.from({ length: 32 }, (_, index) => ({
      op: "put" as const,
      node: {
        ...node(`Task ${index}`),
        id: `task-${index}`,
        content: { values: Array.from({ length: 7_000 }, () => null) },
        fallback: { title: `Task ${index}` },
      },
    }));
    const input = transaction({ transaction_id: "large-valid-transaction", operations });

    expect(validateGenerativeUiTransaction(input).valid).toBe(true);
    expect(target.apply(input, scope)).toMatchObject({ status: "applied", revision: 1 });
    expect(target.get("voice-session-1-ui", scope)?.nodes).toHaveLength(32);
  });
});
