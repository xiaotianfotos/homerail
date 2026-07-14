import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  GenerativeUiShadowService,
  validateLegacyShadowKind,
} from "../src/generative-ui/shadow-service.js";
import {
  compileLegacyWidgetToGenerativeUiNode,
  type LegacyVoiceWidget,
} from "../src/generative-ui/legacy-widget-compiler.js";

const time0 = "2026-07-11T11:00:00.000Z";
const time1 = "2026-07-11T11:01:00.000Z";
const time2 = "2026-07-11T11:02:00.000Z";
const fixturesRoot = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "legacy-widgets",
);

function readJson<T>(file: string): T {
  return JSON.parse(fs.readFileSync(path.join(fixturesRoot, file), "utf8")) as T;
}

function widget(input: Partial<{
  id: string;
  type: string;
  title: string;
  body: string;
  status: string;
}> = {}) {
  return {
    id: input.id ?? "task-draft",
    type: input.type ?? "task_draft",
    title: input.title ?? "Shadow task",
    body: input.body ?? "Compile the legacy Widget without changing the legacy response.",
    priority: "normal" as const,
    status: input.status ?? "draft",
    items: ["Keep legacy authoritative"],
    steps: [],
    active_step: 0,
    data: { visual: input.type ?? "task_draft", ui_state: "visible" },
  };
}

describe("GenerativeUiShadowService", () => {
  it("runs the complete M0 Widget catalog through the shadow pipeline", () => {
    const fileGoldens = readJson<Record<string, LegacyVoiceWidget>>("widget-file-protocol.golden.json");
    const dynamicGoldens = readJson<LegacyVoiceWidget[]>("show-dynamic-widget.golden.json");
    const widgets = [
      ...["memo", "task_draft", "progress_status", "checklist", "artifact_ref", "timeline"]
        .map((type) => fileGoldens[type]),
      ...dynamicGoldens,
    ];
    const target = new GenerativeUiShadowService();
    const result = target.reconcile({ sessionId: "voice-m0-catalog", widgets, checkedAt: time0 });

    expect(result).toMatchObject({
      transaction_status: "applied",
      legacy_widget_count: 14,
      document_revision: 1,
      matched: true,
      expected_report: { matched: true },
      repeat_report: { matched: true },
    });
    expect(target.getDocument("voice-m0-catalog")?.nodes).toHaveLength(14);
  });

  it("derives, applies, and independently repeats one matched shadow document", () => {
    const target = new GenerativeUiShadowService();
    const result = target.reconcile({
      sessionId: "voice-shadow-1",
      widgets: [widget(), widget({ id: "timeline", type: "timeline", title: "Timeline", status: "running" })],
      checkedAt: time0,
    });

    expect(result).toMatchObject({
      authoritative: false,
      side_effect_free: true,
      transaction_status: "applied",
      document_revision: 1,
      legacy_widget_count: 2,
      matched: true,
      expected_report: { matched: true, comparison_profile: "semantic" },
      repeat_report: { matched: true, comparison_profile: "exact" },
    });
    expect(target.getDocument("voice-shadow-1")?.nodes.map((node) => node.id)).toEqual([
      "task-draft",
      "timeline",
    ]);
  });

  it("does no transaction work for an unchanged snapshot", () => {
    const target = new GenerativeUiShadowService();
    target.reconcile({ sessionId: "voice-shadow-2", widgets: [widget()], checkedAt: time0 });
    const unchanged = target.reconcile({ sessionId: "voice-shadow-2", widgets: [widget()], checkedAt: time1 });

    expect(unchanged).toMatchObject({
      transaction_status: "noop",
      document_revision: 1,
      matched: true,
    });
    expect(target.getDocument("voice-shadow-2")?.nodes[0]).toMatchObject({ revision: 1, updated_at: time0 });

    const invalidTime = target.reconcile({
      sessionId: "voice-shadow-2",
      widgets: [widget()],
      checkedAt: "not-a-time",
    });
    expect(invalidTime).toMatchObject({
      status: "error",
      transaction_status: "error",
      document_revision: 1,
      matched: false,
    });
  });

  it("distinguishes isolated UTF-16 surrogates in legacy snapshot fingerprints", () => {
    const target = new GenerativeUiShadowService();
    expect(target.reconcile({
      sessionId: "voice-surrogate-fingerprint",
      widgets: [widget({ title: "\ud800" })],
      checkedAt: time0,
    })).toMatchObject({ transaction_status: "applied", document_revision: 1 });
    expect(target.reconcile({
      sessionId: "voice-surrogate-fingerprint",
      widgets: [widget({ title: "\ud801" })],
      checkedAt: time1,
    })).toMatchObject({ transaction_status: "applied", document_revision: 2 });
  });

  it("never rewrites a rejected transaction as a cached successful noop", () => {
    const target = new GenerativeUiShadowService();
    for (let revision = 1; revision <= 2_048; revision += 1) {
      const result = target.reconcile({
        sessionId: "voice-transaction-limit",
        widgets: [widget({ title: `Revision ${revision}` })],
        checkedAt: time0,
      });
      expect(result?.transaction_status).toBe("applied");
    }

    const rejectedInput = {
      sessionId: "voice-transaction-limit",
      widgets: [widget({ title: "Beyond transaction ledger capacity" })],
      checkedAt: time1,
    };
    expect(target.reconcile(rejectedInput)).toMatchObject({
      status: "ok",
      transaction_status: "rejected",
      document_revision: 2_048,
      matched: false,
    });
    expect(target.reconcile(rejectedInput)).toMatchObject({
      status: "ok",
      transaction_status: "rejected",
      document_revision: 2_048,
      matched: false,
    });
  }, 20_000);

  it("emits minimal put and remove effects as the legacy snapshot changes", () => {
    const target = new GenerativeUiShadowService();
    target.reconcile({
      sessionId: "voice-shadow-3",
      widgets: [widget(), widget({ id: "timeline", type: "timeline", title: "Timeline" })],
      checkedAt: time0,
    });
    const changed = target.reconcile({
      sessionId: "voice-shadow-3",
      widgets: [widget({ title: "Updated shadow task", status: "ready" })],
      checkedAt: time1,
    });

    expect(changed).toMatchObject({ transaction_status: "applied", document_revision: 2, matched: true });
    expect(target.getDocument("voice-shadow-3")?.nodes).toEqual([
      expect.objectContaining({
        id: "task-draft",
        revision: 2,
        status: expect.objectContaining({ phase: "ready" }),
        fallback: expect.objectContaining({ title: "Updated shadow task" }),
      }),
    ]);
  });

  it("keeps every supported full snapshot replacement within one atomic transaction", () => {
    const target = new GenerativeUiShadowService();
    const initial = Array.from({ length: 16 }, (_, index) => widget({
      id: `old-${index}`,
      title: `Old ${index}`,
    }));
    const replacement = Array.from({ length: 16 }, (_, index) => widget({
      id: `new-${index}`,
      title: `New ${index}`,
    }));

    expect(target.reconcile({
      sessionId: "voice-atomic-capacity",
      widgets: initial,
      checkedAt: time0,
    })).toMatchObject({ transaction_status: "applied", document_revision: 1, matched: true });
    expect(target.reconcile({
      sessionId: "voice-atomic-capacity",
      widgets: replacement,
      checkedAt: time1,
    })).toMatchObject({ transaction_status: "applied", document_revision: 2, matched: true });
    expect(target.getDocument("voice-atomic-capacity")?.nodes.map((node) => node.id)).toEqual(
      replacement.map(({ id }) => id),
    );

    expect(target.reconcile({
      sessionId: "voice-atomic-capacity",
      widgets: [...replacement, widget({ id: "overflow" })],
      checkedAt: time2,
    })).toMatchObject({ status: "error", document_revision: 2, matched: false });
    expect(target.getDocument("voice-atomic-capacity")?.nodes.map((node) => node.id)).toEqual(
      replacement.map(({ id }) => id),
    );
  });

  it("atomically removes then replaces a stable id when semantic identity changes", () => {
    const target = new GenerativeUiShadowService();
    target.reconcile({
      sessionId: "voice-identity-change",
      widgets: [widget({ id: "stable", type: "note", title: "Notice" })],
      checkedAt: time0,
    });
    const changed = target.reconcile({
      sessionId: "voice-identity-change",
      widgets: [widget({ id: "stable", type: "artifact", title: "Artifact" })],
      checkedAt: time1,
    });

    expect(changed).toMatchObject({ transaction_status: "applied", document_revision: 2, matched: true });
    expect(target.getDocument("voice-identity-change")?.nodes).toEqual([
      expect.objectContaining({
        id: "stable",
        kind: "com.homerail.core/artifact",
        revision: 1,
      }),
    ]);
  });

  it("keeps sessions isolated and returns cloned diagnostics", () => {
    const target = new GenerativeUiShadowService();
    const left = target.reconcile({ sessionId: "voice-left", widgets: [widget()], checkedAt: time0 });
    const right = target.reconcile({
      sessionId: "voice-right",
      widgets: [widget({ id: "note", type: "note", title: "Right" })],
      checkedAt: time0,
    });
    left.expected_report.differences.push({ path: "/tamper", kind: "value_mismatch" });

    expect(left.document_id).not.toBe(right.document_id);
    expect(target.getSnapshot("voice-left")?.expected_report.differences).toEqual([]);
    expect(target.getDocument("voice-left")?.nodes[0].id).toBe("task-draft");
    expect(target.getDocument("voice-right")?.nodes[0].id).toBe("note");
  });

  it("bounds active documents with LRU and rebuilds evicted sessions under a new incarnation", () => {
    const target = new GenerativeUiShadowService(2);
    const first = target.reconcile({ sessionId: "voice-lru-1", widgets: [widget()], checkedAt: time0 });
    target.reconcile({ sessionId: "voice-lru-2", widgets: [widget()], checkedAt: time0 });
    target.reconcile({ sessionId: "voice-lru-3", widgets: [widget()], checkedAt: time0 });

    expect(target.getDocument("voice-lru-1")).toBeUndefined();
    expect(target.getDocument("voice-lru-2")?.revision).toBe(1);
    expect(target.getDocument("voice-lru-3")?.revision).toBe(1);

    const rebuilt = target.reconcile({ sessionId: "voice-lru-1", widgets: [widget()], checkedAt: time1 });
    expect(rebuilt).toMatchObject({ status: "ok", transaction_status: "applied", document_revision: 1, matched: true });
    expect(rebuilt?.document_id).not.toBe(first?.document_id);
    expect(target.getDocument("voice-lru-1")?.revision).toBe(1);
    expect(target.getDocument("voice-lru-2")).toBeUndefined();
  });

  it("rejects duplicate legacy ids before changing canonical state", () => {
    const target = new GenerativeUiShadowService();
    expect(target.reconcile({
      sessionId: "voice-duplicate",
      widgets: [widget(), widget({ title: "Duplicate" })],
      checkedAt: time0,
    })).toMatchObject({
      status: "error",
      transaction_status: "error",
      matched: false,
      legacy_widget_count: 2,
      document_revision: 0,
    });
    expect(target.getDocument("voice-duplicate")).toMatchObject({ revision: 0, nodes: [] });
  });

  it("replaces a stale matched snapshot with a bounded failure snapshot", () => {
    const target = new GenerativeUiShadowService();
    expect(target.reconcile({
      sessionId: "voice-stale-evidence",
      widgets: [widget()],
      checkedAt: time0,
    })).toMatchObject({ status: "ok", matched: true, document_revision: 1 });

    const failed = target.reconcile({
      sessionId: "voice-stale-evidence",
      widgets: [{ ...widget(), data: { payload: "x".repeat(140 * 1024) } }],
      checkedAt: time1,
    });

    expect(failed).toMatchObject({
      status: "error",
      checked_at: time1,
      legacy_widget_count: 1,
      document_revision: 1,
      transaction_status: "error",
      matched: false,
      error_hash: expect.stringMatching(/^[0-9a-f]{24}$/),
    });
    expect(target.getSnapshot("voice-stale-evidence")).toEqual(failed);
    expect(target.getDocument("voice-stale-evidence")?.revision).toBe(1);
  });

  it("retries a failed derivation when non-Widget inputs recover", () => {
    const target = new GenerativeUiShadowService();
    expect(target.reconcile({
      sessionId: "voice-failure-recovery",
      widgets: [widget()],
      checkedAt: "not-a-time",
    })).toMatchObject({ status: "error", document_revision: 0, matched: false });

    expect(target.reconcile({
      sessionId: "voice-failure-recovery",
      widgets: [widget()],
      checkedAt: time1,
    })).toMatchObject({ status: "ok", transaction_status: "applied", document_revision: 1, matched: true });
    expect(target.getDocument("voice-failure-recovery")?.nodes).toHaveLength(1);
  });

  it("clears stale standalone failure evidence when the legacy surface becomes empty", () => {
    const target = new GenerativeUiShadowService();
    target.reconcile({
      sessionId: "voice-failure-cleared",
      widgets: [{ ...widget(), data: { payload: "x".repeat(140 * 1024) } }],
      checkedAt: time0,
    });
    expect(target.getSnapshot("voice-failure-cleared")).toMatchObject({ status: "error" });

    expect(target.reconcile({
      sessionId: "voice-failure-cleared",
      widgets: [],
      checkedAt: time1,
    })).toBeNull();
    expect(target.getSnapshot("voice-failure-cleared")).toBeUndefined();
  });

  it("bounds standalone failure evidence for sessions without shadow documents", () => {
    const target = new GenerativeUiShadowService(1);
    const oversized = (id: string) => ({
      ...widget({ id }),
      data: { payload: "x".repeat(140 * 1024) },
    });

    target.reconcile({ sessionId: "voice-failure-1", widgets: [oversized("one")], checkedAt: time0 });
    target.reconcile({ sessionId: "voice-failure-2", widgets: [oversized("two")], checkedAt: time1 });
    target.reconcile({ sessionId: "voice-failure-3", widgets: [oversized("three")], checkedAt: time2 });

    expect(target.getSnapshot("voice-failure-1")).toBeUndefined();
    expect(target.getSnapshot("voice-failure-2")).toMatchObject({ status: "error" });
    expect(target.getSnapshot("voice-failure-3")).toMatchObject({ status: "error" });
    expect(target.getDocument("voice-failure-1")).toBeUndefined();
    expect(target.getDocument("voice-failure-2")).toBeUndefined();
    expect(target.getDocument("voice-failure-3")).toBeUndefined();
  });

  it("uses a strict local Kind policy for the legacy projection", () => {
    const valid = compileLegacyWidgetToGenerativeUiNode(widget());
    const stored = { ...valid, revision: 1, updated_at: time2 };
    expect(validateLegacyShadowKind(stored)).toEqual([]);

    expect(validateLegacyShadowKind({
      ...stored,
      kind: "com.example.unregistered/task",
      owner: { id: "com.example.unregistered", version: "1.0.0" },
    })[0]?.keyword).toBe("kindRegistry");
    expect(validateLegacyShadowKind({
      ...stored,
      content: { legacy_widget: { ...widget(), id: "other" } },
    })[0]?.keyword).toBe("legacyWidgetProjection");
  });
});
