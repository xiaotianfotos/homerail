import { describe, expect, it } from "vitest";
import {
  GENERATIVE_UI_IR_VERSION,
  GenerativeUiActorType,
  GenerativeUiImportance,
  GenerativeUiPhase,
  GenerativeUiSurface,
  applyGenerativeUiTransaction,
  createGenerativeUiDocument,
  validateGenerativeUiDocument,
  validateGenerativeUiInteractionEvent,
  validateGenerativeUiNode,
  validateGenerativeUiTransaction,
  type GenerativeUiDocumentV1,
  type GenerativeUiNodeV1,
  type GenerativeUiReducerContextV1,
  type GenerativeUiTransactionV1,
} from "../src/generative-ui/index.js";

const time0 = "2026-07-11T08:00:00.000Z";
const time1 = "2026-07-11T08:01:00.000Z";
const time2 = "2026-07-11T08:02:00.000Z";

function taskNode(id = "current-task"): GenerativeUiNodeV1 {
  return {
    ir_version: GENERATIVE_UI_IR_VERSION,
    id,
    kind: "com.homerail.core/task_summary",
    kind_version: 1,
    owner: { id: "com.homerail.core", version: "0.1.0" },
    surface: GenerativeUiSurface.TASK,
    importance: GenerativeUiImportance.PRIMARY,
    status: { phase: GenerativeUiPhase.WAITING },
    content: {
      objective: "Design the generated UI foundation",
      open_questions: ["Which plugin capability is needed?"],
    },
    fallback: {
      title: "Generated UI foundation",
      summary: "The task is still being clarified.",
    },
    presentation: { density: "summary" },
    lifecycle: { persistence: "session" },
    actions: [
      {
        id: "confirm-task",
        label: "Confirm",
        intent: "submit_task",
        arguments: { task_id: id },
        style: "primary",
        confirmation: { required: true },
      },
    ],
  };
}

function document(): GenerativeUiDocumentV1 {
  return createGenerativeUiDocument({
    document_id: "voice-session-1-ui",
    scope: { type: "voice_session", id: "voice-session-1" },
    created_at: time0,
  });
}

function transaction(
  input: Partial<GenerativeUiTransactionV1> & Pick<GenerativeUiTransactionV1, "operations">,
): GenerativeUiTransactionV1 {
  return {
    ir_version: GENERATIVE_UI_IR_VERSION,
    transaction_id: input.transaction_id ?? "turn-1-ui",
    document_id: input.document_id ?? "voice-session-1-ui",
    base_revision: input.base_revision ?? 0,
    actor: input.actor ?? {
      type: GenerativeUiActorType.PLUGIN,
      plugin: { id: "com.homerail.core", version: "0.1.0" },
      skill_id: "voice-generative-ui",
      turn_id: "turn-1",
    },
    operations: input.operations,
    created_at: input.created_at ?? time1,
  };
}

function reducerContext(input: Partial<GenerativeUiReducerContextV1> = {}): GenerativeUiReducerContextV1 {
  return {
    transaction_already_applied: input.transaction_already_applied ?? false,
    validate_kind: input.validate_kind ?? (() => []),
  };
}

describe("Generative UI semantic protocol", () => {
  it("accepts namespaced semantic nodes with a portable fallback", () => {
    expect(validateGenerativeUiNode(taskNode())).toEqual({
      valid: true,
      value: taskNode(),
      errors: [],
    });
  });

  it("rejects renderer-specific fields, executable actions, and missing fallbacks", () => {
    const { fallback: _fallback, ...withoutFallback } = taskNode();
    expect(validateGenerativeUiNode(withoutFallback).valid).toBe(false);

    expect(validateGenerativeUiNode({ ...taskNode(), gridColumn: "span 2" }).valid).toBe(false);

    const unsafe = structuredClone(taskNode()) as unknown as Record<string, unknown>;
    unsafe.actions = [{
      id: "unsafe",
      label: "Run",
      intent: "run",
      javascript: "alert(1)",
    }];
    expect(validateGenerativeUiNode(unsafe).valid).toBe(false);
  });

  it("enforces plugin kind ownership and unique symbolic action ids", () => {
    expect(validateGenerativeUiNode({
      ...taskNode(),
      kind: "com.example.other/task_summary",
    }).errors[0]?.keyword).toBe("ownerNamespace");

    const duplicateActions = structuredClone(taskNode());
    duplicateActions.actions?.push(structuredClone(duplicateActions.actions[0]));
    expect(validateGenerativeUiNode(duplicateActions).errors[0]?.keyword).toBe("uniqueActionId");
  });

  it("accepts opaque legacy-compatible node ids", () => {
    expect(validateGenerativeUiNode(taskNode("widget-note-任务 草稿")).valid).toBe(true);
  });

  it("enforces timestamps and bounded plugin payloads", () => {
    const oversized = taskNode();
    oversized.content = { text: "x".repeat(129 * 1024) };
    expect(validateGenerativeUiNode(oversized).errors[0]?.keyword).toBe("maxPayloadBytes");

    const invalidTime = transaction({
      created_at: "2026-99-99T99:99:99Z",
      operations: [{ op: "put", node: taskNode() }],
    });
    expect(validateGenerativeUiTransaction(invalidTime).errors[0]?.keyword).toBe("date-time");
  });

  it("applies put, patch, and remove as revisioned atomic operations", () => {
    const put = transaction({ operations: [{ op: "put", node: taskNode() }] });
    const afterPut = applyGenerativeUiTransaction(document(), put, reducerContext());
    expect(afterPut.status).toBe("applied");
    expect(afterPut.revision).toBe(1);
    expect(afterPut.document.nodes[0]).toMatchObject({ id: "current-task", revision: 1 });

    const patch = transaction({
      transaction_id: "turn-2-ui",
      base_revision: 1,
      created_at: time2,
      operations: [{
        op: "patch",
        node_id: "current-task",
        if_revision: 1,
        changes: {
          status: { phase: GenerativeUiPhase.READY },
          fallback: { title: "Generated UI foundation", summary: "Ready for confirmation." },
        },
      }],
    });
    const afterPatch = applyGenerativeUiTransaction(afterPut.document, patch, reducerContext());
    expect(afterPatch.status).toBe("applied");
    expect(afterPatch.revision).toBe(2);
    expect(afterPatch.document.nodes[0]).toMatchObject({
      revision: 2,
      status: { phase: "ready" },
      fallback: { summary: "Ready for confirmation." },
    });

    const replaceAndRemove = transaction({
      transaction_id: "turn-3-ui",
      base_revision: 2,
      operations: [
        { op: "put", node: taskNode("next-task") },
        { op: "remove", node_id: "current-task", if_revision: 2 },
      ],
    });
    const final = applyGenerativeUiTransaction(afterPatch.document, replaceAndRemove, reducerContext());
    expect(final.status).toBe("applied");
    expect(final.revision).toBe(3);
    expect(final.document.nodes.map((node) => node.id)).toEqual(["next-task"]);
  });

  it("applies repeated node operations in transaction order", () => {
    const ordered = transaction({
      operations: [
        { op: "put", node: taskNode() },
        {
          op: "patch",
          node_id: "current-task",
          if_revision: 1,
          changes: { status: { phase: GenerativeUiPhase.READY } },
        },
      ],
    });
    const applied = applyGenerativeUiTransaction(document(), ordered, reducerContext());
    expect(applied.status).toBe("applied");
    expect(applied.revision).toBe(1);
    expect(applied.document.nodes[0]).toMatchObject({
      revision: 2,
      status: { phase: "ready" },
    });
  });

  it("rolls back the whole transaction when a later operation fails", () => {
    const initial = document();
    const snapshot = JSON.stringify(initial);
    const invalid = transaction({
      operations: [
        { op: "put", node: taskNode() },
        { op: "remove", node_id: "missing-node" },
      ],
    });
    const applied = applyGenerativeUiTransaction(initial, invalid, reducerContext());
    expect(applied.status).toBe("rejected");
    expect(applied.document).toBe(initial);
    expect(JSON.stringify(initial)).toBe(snapshot);
    expect(initial.nodes).toEqual([]);
  });

  it("returns conflicts without mutating state", () => {
    const initial = document();
    const stale = transaction({ base_revision: 4, operations: [{ op: "put", node: taskNode() }] });
    const result = applyGenerativeUiTransaction(initial, stale, reducerContext());
    expect(result.status).toBe("conflict");
    expect(result.revision).toBe(0);
    expect(result.document).toBe(initial);
  });

  it("handles repeated transaction ids idempotently", () => {
    const put = transaction({ operations: [{ op: "put", node: taskNode() }] });
    const first = applyGenerativeUiTransaction(document(), put, reducerContext());
    const second = applyGenerativeUiTransaction(
      first.document,
      put,
      reducerContext({ transaction_already_applied: true }),
    );
    expect(second.status).toBe("duplicate");
    expect(second.revision).toBe(1);
    expect(second.document).toBe(first.document);
  });

  it("prevents patch operations from changing semantic identity", () => {
    const invalid = transaction({
      operations: [{
        op: "patch",
        node_id: "current-task",
        changes: { id: "replacement" },
      }],
    } as unknown as Pick<GenerativeUiTransactionV1, "operations">);
    expect(validateGenerativeUiTransaction(invalid).valid).toBe(false);
  });

  it("rejects documents with duplicate node ids before reducing", () => {
    const put = transaction({ operations: [{ op: "put", node: taskNode() }] });
    const afterPut = applyGenerativeUiTransaction(document(), put, reducerContext()).document;
    const duplicateDocument = structuredClone(afterPut);
    duplicateDocument.nodes.push(structuredClone(duplicateDocument.nodes[0]));
    expect(validateGenerativeUiDocument(duplicateDocument).errors[0]?.keyword).toBe("uniqueNodeId");

    const next = transaction({
      transaction_id: "turn-2-ui",
      base_revision: 1,
      operations: [{ op: "remove", node_id: "current-task" }],
    });
    const result = applyGenerativeUiTransaction(duplicateDocument, next, reducerContext());
    expect(result.status).toBe("rejected");
    expect(result.errors?.[0].keyword).toBe("uniqueNodeId");
  });

  it("is deterministic, non-mutating, and JSON round-trip safe", () => {
    const initial = document();
    const put = transaction({ operations: [{ op: "put", node: taskNode() }] });
    const left = applyGenerativeUiTransaction(initial, put, reducerContext());
    const right = applyGenerativeUiTransaction(
      JSON.parse(JSON.stringify(initial)) as GenerativeUiDocumentV1,
      JSON.parse(JSON.stringify(put)) as GenerativeUiTransactionV1,
      reducerContext(),
    );
    expect(JSON.stringify(left)).toBe(JSON.stringify(right));
    expect(initial.nodes).toHaveLength(0);
    expect(validateGenerativeUiDocument(JSON.parse(JSON.stringify(left.document))).valid).toBe(true);
  });

  it("validates host-mediated interaction events", () => {
    const interaction = {
      ir_version: GENERATIVE_UI_IR_VERSION,
      event_id: "interaction-1",
      idempotency_key: "voice-session-1:current-task:confirm-task:2",
      document_id: "voice-session-1-ui",
      node_id: "current-task",
      node_revision: 2,
      action_id: "confirm-task",
      input: { confirmed: true },
      created_at: time2,
    };
    expect(validateGenerativeUiInteractionEvent(interaction).valid).toBe(true);
  });

  it("requires kind-registry validation before applying domain content", () => {
    const put = transaction({ operations: [{ op: "put", node: taskNode() }] });
    const rejected = applyGenerativeUiTransaction(document(), put, reducerContext({
      validate_kind: () => [{
        path: "/objective",
        message: "objective is not allowed by the registered kind schema",
        keyword: "kindSchema",
      }],
    }));
    expect(rejected.status).toBe("rejected");
    expect(rejected.errors?.[0]).toMatchObject({ keyword: "kindSchema" });
    expect(rejected.document.nodes).toEqual([]);
  });

  it("rejects reducers without an explicit kind-registry policy", () => {
    const put = transaction({ operations: [{ op: "put", node: taskNode() }] });
    const rejected = applyGenerativeUiTransaction(
      document(),
      put,
      undefined as unknown as GenerativeUiReducerContextV1,
    );
    expect(rejected.status).toBe("rejected");
    expect(rejected.errors?.[0]).toMatchObject({ keyword: "required" });
  });

  it("uses explicit unset semantics for optional node fields", () => {
    const put = transaction({ operations: [{ op: "put", node: taskNode() }] });
    const afterPut = applyGenerativeUiTransaction(document(), put, reducerContext());
    const clear = transaction({
      transaction_id: "turn-2-ui",
      base_revision: 1,
      created_at: time2,
      operations: [{
        op: "patch",
        node_id: "current-task",
        changes: { unset: ["actions", "presentation", "status"] },
      }],
    });
    const afterClear = applyGenerativeUiTransaction(afterPut.document, clear, reducerContext());
    expect(afterClear.status).toBe("applied");
    expect(afterClear.document.nodes[0].actions).toBeUndefined();
    expect(afterClear.document.nodes[0].presentation).toBeUndefined();
    expect(afterClear.document.nodes[0].status).toBeUndefined();

    const contradictory = transaction({
      transaction_id: "turn-3-ui",
      base_revision: 2,
      operations: [{
        op: "patch",
        node_id: "current-task",
        changes: { actions: [], unset: ["actions"] },
      }],
    });
    expect(validateGenerativeUiTransaction(contradictory).errors[0]?.keyword).toBe("patchConflict");
  });
});
