import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  GenerativeUiActorType,
  type GenerativeUiNodeV1,
} from "homerail-protocol";
import {
  applyVoiceCanonicalProjectionPatch,
  VoiceCanonicalProjectionConflictError,
  voiceCanonicalDocumentId,
} from "../src/generative-ui/canonical-voice-service.js";
import { persistentGenerativeUiDocumentService } from "../src/generative-ui/shadow-service.js";
import { closeDb } from "../src/persistence/db.js";

const sessionId = "prefer-canonical-session";
const scope = { type: "voice_session", id: sessionId } as const;
const timestamp = "2026-07-12T02:00:00.000Z";

function node(id: string, title: string): GenerativeUiNodeV1 {
  return {
    ir_version: 1,
    id,
    kind: "com.homerail.topic-outline/outline",
    kind_version: 1,
    owner: { id: "com.homerail.topic-outline", version: "1.0.0" },
    surface: "task",
    importance: "primary",
    content: { title },
    lifecycle: { persistence: "session" },
    fallback: { title },
  };
}

describe("Voice canonical Generative UI projection service", () => {
  let oldHome: string | undefined;
  let home: string;

  beforeEach(() => {
    closeDb();
    oldHome = process.env.HOMERAIL_HOME;
    home = fs.mkdtempSync(path.join(os.tmpdir(), "homerail-canonical-voice-"));
    process.env.HOMERAIL_HOME = home;
  });

  afterEach(() => {
    closeDb();
    if (oldHome === undefined) delete process.env.HOMERAIL_HOME;
    else process.env.HOMERAIL_HOME = oldHome;
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("applies accepted plugin-node deltas without replaying stale workspace nodes over Actions", () => {
    const first = applyVoiceCanonicalProjectionPatch({
      session_id: sessionId,
      patch: {
        base_revision: 0,
        upsert: [node("topic-one", "Initial one"), node("topic-two", "Initial two")],
        remove_ids: [],
      },
      created_at: timestamp,
    });
    expect(first).toMatchObject({
      document_id: voiceCanonicalDocumentId(sessionId),
      revision: 1,
      nodes: [{ id: "topic-one" }, { id: "topic-two" }],
    });

    const actionResult = persistentGenerativeUiDocumentService.apply({
      ir_version: 1,
      transaction_id: "action-updates-topic-one",
      document_id: first!.document_id,
      base_revision: 1,
      actor: {
        type: GenerativeUiActorType.PLUGIN,
        id: "com.homerail.topic-outline:update",
        plugin: { id: "com.homerail.topic-outline", version: "1.0.0" },
      },
      operations: [{ op: "put", node: node("topic-one", "Action result") }],
      created_at: "2026-07-12T02:00:01.000Z",
    }, scope);
    expect(actionResult).toMatchObject({ status: "applied", revision: 2 });

    const patched = applyVoiceCanonicalProjectionPatch({
      session_id: sessionId,
      patch: {
        base_revision: 2,
        upsert: [node("topic-two", "New Tool result")],
        remove_ids: [],
      },
      created_at: "2026-07-12T02:00:02.000Z",
    });
    expect(patched).toMatchObject({
      revision: 3,
      nodes: [
        { id: "topic-one", content: { title: "Action result" } },
        { id: "topic-two", content: { title: "New Tool result" } },
      ],
    });
    expect(persistentGenerativeUiDocumentService.listTransactions(first!.document_id, scope))
      .toHaveLength(3);
  });

  it("does not create an empty canonical document and applies explicit removals once", () => {
    expect(applyVoiceCanonicalProjectionPatch({
      session_id: sessionId,
      patch: { base_revision: 0, upsert: [], remove_ids: ["missing"] },
      created_at: timestamp,
    })).toBeNull();

    const created = applyVoiceCanonicalProjectionPatch({
      session_id: sessionId,
      patch: { base_revision: 0, upsert: [node("topic-one", "Initial")], remove_ids: [] },
      created_at: timestamp,
    })!;
    const removed = applyVoiceCanonicalProjectionPatch({
      session_id: sessionId,
      patch: { base_revision: 1, upsert: [], remove_ids: ["topic-one"] },
      created_at: "2026-07-12T02:00:01.000Z",
    });
    expect(removed).toMatchObject({ revision: 2, nodes: [] });
    expect(applyVoiceCanonicalProjectionPatch({
      session_id: sessionId,
      patch: { base_revision: 2, upsert: [], remove_ids: ["topic-one"] },
      created_at: "2026-07-12T02:00:02.000Z",
    })).toMatchObject({ revision: 2, nodes: [] });
    expect(persistentGenerativeUiDocumentService.listTransactions(created.document_id, scope))
      .toHaveLength(2);
  });

  it("rejects an old pending Tool patch after an Action advances the canonical head", () => {
    const created = applyVoiceCanonicalProjectionPatch({
      session_id: sessionId,
      patch: { base_revision: 0, upsert: [node("topic-one", "Initial")], remove_ids: [] },
      created_at: timestamp,
    })!;
    const stalePending = {
      base_revision: created.revision,
      upsert: [node("topic-one", "Stale Tool result")],
      remove_ids: [],
    };
    expect(persistentGenerativeUiDocumentService.apply({
      ir_version: 1,
      transaction_id: "winning-action",
      document_id: created.document_id,
      base_revision: created.revision,
      actor: {
        type: GenerativeUiActorType.PLUGIN,
        id: "com.homerail.topic-outline:update",
        plugin: { id: "com.homerail.topic-outline", version: "1.0.0" },
      },
      operations: [{ op: "put", node: node("topic-one", "Winning Action") }],
      created_at: "2026-07-12T02:00:01.000Z",
    }, scope)).toMatchObject({ status: "applied", revision: 2 });

    expect(() => applyVoiceCanonicalProjectionPatch({
      session_id: sessionId,
      patch: stalePending,
      created_at: "2026-07-12T02:00:02.000Z",
    })).toThrow(VoiceCanonicalProjectionConflictError);
    expect(persistentGenerativeUiDocumentService.get(created.document_id, scope)).toMatchObject({
      revision: 2,
      nodes: [{ id: "topic-one", content: { title: "Winning Action" } }],
    });
    expect(persistentGenerativeUiDocumentService.listTransactions(created.document_id, scope))
      .toHaveLength(2);
  });
});
