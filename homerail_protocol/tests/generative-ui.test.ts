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
    presentation: { density: "summary", canvas_size: "1x2", motion_profile: "standard" },
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

function legacyGeneratedViewNode(): GenerativeUiNodeV1 {
  return {
    ir_version: GENERATIVE_UI_IR_VERSION,
    id: "legacy-generated-view",
    kind: "com.homerail.core/generated_view",
    kind_version: 1,
    owner: { id: "com.homerail.core", version: "0.1.8" },
    surface: GenerativeUiSurface.RESULT,
    importance: GenerativeUiImportance.PRIMARY,
    content: { data: { title: "Persisted ViewSpec" } },
    view: {
      view_version: 1,
      root: {
        id: "root",
        type: "heading",
        text: { path: "/data/title" },
        level: 2,
      },
    },
    fallback: { title: "Persisted ViewSpec" },
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

  it("keeps ViewSpec read-compatible only for generated_view@1", () => {
    const legacy = legacyGeneratedViewNode();
    expect(validateGenerativeUiNode(legacy).valid).toBe(true);

    const viewOnV2 = structuredClone(legacy);
    viewOnV2.kind_version = 2;
    expect(validateGenerativeUiNode(viewOnV2).errors).toContainEqual(expect.objectContaining({
      keyword: "legacyViewSpecVersion",
    }));

    const a2uiOnV1 = structuredClone(legacy);
    delete a2uiOnV1.view;
    a2uiOnV1.a2ui = {
      version: "v1.0",
      catalogId: "https://homerail.dev/a2ui/catalogs/core/v1",
      components: [{ id: "root", component: "Text", text: "Native A2UI" }],
    };
    expect(validateGenerativeUiNode(a2uiOnV1).errors).toContainEqual(expect.objectContaining({
      keyword: "nativeA2uiVersion",
    }));

    const conflicting = structuredClone(legacy);
    conflicting.a2ui = a2uiOnV1.a2ui;
    expect(validateGenerativeUiNode(conflicting).errors).toContainEqual(expect.objectContaining({
      keyword: "presentationConflict",
    }));
  });

  it("rejects patches that set ViewSpec and A2UI together", () => {
    const patch = transaction({
      operations: [{
        op: "patch",
        node_id: "legacy-generated-view",
        changes: {
          view: legacyGeneratedViewNode().view,
          a2ui: {
            version: "v1.0",
            catalogId: "https://homerail.dev/a2ui/catalogs/core/v1",
            components: [{ id: "root", component: "Text", text: "Native A2UI" }],
          },
        },
      }],
    });
    expect(validateGenerativeUiTransaction(patch).errors).toContainEqual(expect.objectContaining({
      keyword: "presentationConflict",
    }));
  });

  it("rejects renderer-specific fields, executable actions, and missing fallbacks", () => {
    const { fallback: _fallback, ...withoutFallback } = taskNode();
    expect(validateGenerativeUiNode(withoutFallback).valid).toBe(false);

    expect(validateGenerativeUiNode({ ...taskNode(), gridColumn: "span 2" }).valid).toBe(false);
    expect(validateGenerativeUiNode({
      ...taskNode(),
      presentation: { density: "summary", canvas_size: "2x1" as never },
    }).valid).toBe(false);
    expect(validateGenerativeUiNode({
      ...taskNode(),
      presentation: { density: "summary", motion_profile: "cinematic" as never },
    }).valid).toBe(false);

    const unsafe = structuredClone(taskNode()) as unknown as Record<string, unknown>;
    unsafe.actions = [{
      id: "unsafe",
      label: "Run",
      intent: "run",
      javascript: "alert(1)",
    }];
    expect(validateGenerativeUiNode(unsafe).valid).toBe(false);

    const unsafeArtifact = structuredClone(taskNode());
    unsafeArtifact.fallback.artifact_refs = [{
      label: "unsafe",
      uri: "javascript:alert(document.domain)",
    }];
    expect(validateGenerativeUiNode(unsafeArtifact).valid).toBe(false);
    unsafeArtifact.fallback.artifact_refs = [{ label: "unsafe", uri: "file:///etc/passwd" }];
    expect(validateGenerativeUiNode(unsafeArtifact).valid).toBe(false);
    unsafeArtifact.fallback.artifact_refs = [{ label: "unsafe", uri: " //evil.example/x" }];
    expect(validateGenerativeUiNode(unsafeArtifact).valid).toBe(false);
    unsafeArtifact.fallback.artifact_refs = [{ label: "unsafe", uri: "\\\\evil.example\\share" }];
    expect(validateGenerativeUiNode(unsafeArtifact).valid).toBe(false);
    unsafeArtifact.fallback.artifact_refs = [{ label: "safe", uri: "artifact:artifact-1" }];
    expect(validateGenerativeUiNode(unsafeArtifact).valid).toBe(true);
    unsafeArtifact.fallback.artifact_refs = [{ label: "safe", uri: "/safe/report 1.html" }];
    expect(validateGenerativeUiNode(unsafeArtifact).valid).toBe(true);
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

    for (const createdAt of [
      "2026-02-30T00:00:00Z",
      "2025-02-29T00:00:00Z",
      "2026-01-01T24:00:00Z",
      "2026-01-01T00:00:00+24:00",
    ]) {
      expect(validateGenerativeUiTransaction(transaction({
        created_at: createdAt,
        operations: [{ op: "put", node: taskNode() }],
      })).errors[0]?.keyword).toBe("date-time");
    }
    expect(validateGenerativeUiTransaction(transaction({
      created_at: "2024-02-29T23:59:59.123+08:00",
      operations: [{ op: "put", node: taskNode() }],
    })).valid).toBe(true);
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

    const replayAfterDisable = applyGenerativeUiTransaction(
      first.document,
      put,
      reducerContext({
        transaction_already_applied: true,
        validate_kind: () => [{ path: "/", message: "kind disabled", keyword: "kindRegistry" }],
      }),
    );
    expect(replayAfterDisable.status).toBe("duplicate");
    expect(replayAfterDisable.document).toBe(first.document);
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

  it("applies node semantic validation to patch fields before reduction", () => {
    const unsafePatch = transaction({
      operations: [{
        op: "patch",
        node_id: "current-task",
        changes: {
          fallback: {
            title: "Unsafe credentialed URL",
            artifact_refs: [{
              label: "unsafe",
              uri: "https://user:pass@example.com/report",
            }],
          },
        },
      }],
    });
    expect(validateGenerativeUiTransaction(unsafePatch)).toMatchObject({
      valid: false,
      errors: [{ keyword: "artifactUri" }],
    });
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

  it("isolates canonical state from mutating kind validators", () => {
    const initial = document();
    const put = transaction({ operations: [{ op: "put", node: taskNode() }] });
    const result = applyGenerativeUiTransaction(initial, put, reducerContext({
      validate_kind: (candidate) => {
        candidate.content.objective = "mutated by validator";
        candidate.fallback.title = "mutated by validator";
        return [];
      },
    }));

    expect(result.status).toBe("applied");
    expect(result.document.nodes[0].content.objective).toBe("Design the generated UI foundation");
    expect(result.document.nodes[0].fallback.title).toBe("Generated UI foundation");
    expect(initial.nodes).toEqual([]);
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
    const nodeWithA2ui = taskNode();
    nodeWithA2ui.a2ui = {
      version: "v1.0",
      catalogId: "https://homerail.dev/a2ui/catalogs/core/v1",
      components: [{ id: "root", component: "Text", text: "Current task" }],
    };
    const put = transaction({ operations: [{ op: "put", node: nodeWithA2ui }] });
    const afterPut = applyGenerativeUiTransaction(document(), put, reducerContext());
    const clear = transaction({
      transaction_id: "turn-2-ui",
      base_revision: 1,
      created_at: time2,
      operations: [{
        op: "patch",
        node_id: "current-task",
        changes: { unset: ["a2ui", "actions", "presentation", "status"] },
      }],
    });
    const afterClear = applyGenerativeUiTransaction(afterPut.document, clear, reducerContext());
    expect(afterClear.status).toBe("applied");
    expect(afterClear.document.nodes[0].actions).toBeUndefined();
    expect(afterClear.document.nodes[0].a2ui).toBeUndefined();
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
