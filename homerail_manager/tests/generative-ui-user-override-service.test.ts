import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { closeDb, getDb } from "../src/persistence/db.js";
import { PersistentGenerativeUiDocumentService } from "../src/generative-ui/persistent-document-service.js";
import { validateLegacyShadowKind } from "../src/generative-ui/shadow-service.js";
import { GenerativeUiUserOverrideService } from "../src/generative-ui/user-override-service.js";
import { compileLegacyVoiceSurfaceToGenerativeUiTransaction } from "../src/generative-ui/legacy-widget-compiler.js";

const scope = { type: "voice_session", id: "override-session" } as const;
const time0 = "2026-07-11T19:00:00.000Z";
const time1 = "2026-07-11T19:01:00.000Z";
const time2 = "2026-07-11T19:02:00.000Z";

function services() {
  const documents = new PersistentGenerativeUiDocumentService(validateLegacyShadowKind);
  const overrides = new GenerativeUiUserOverrideService(documents);
  return { documents, overrides };
}

function createDocument() {
  const target = services();
  target.documents.createOrGet({
    documentId: "override-document",
    scope,
    createdAt: time0,
    purpose: "legacy_widget_shadow",
  });
  const transaction = compileLegacyVoiceSurfaceToGenerativeUiTransaction({
    transaction_id: "override-transaction",
    document_id: "override-document",
    base_revision: 0,
    created_at: time1,
    voice_surface: {
      widgets: [{ id: "note", type: "note", title: "Override me", body: "Body" }],
    },
  });
  if (!transaction) throw new Error("expected transaction");
  expect(target.documents.apply(transaction, scope).status).toBe("applied");
  return target;
}

describe("GenerativeUiUserOverrideService", () => {
  let previousHome: string | undefined;
  let tmpHome: string;

  beforeEach(() => {
    closeDb();
    previousHome = process.env.HOMERAIL_HOME;
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "homerail-generative-ui-overrides-"));
    process.env.HOMERAIL_HOME = tmpHome;
  });

  afterEach(() => {
    closeDb();
    if (previousHome === undefined) delete process.env.HOMERAIL_HOME;
    else process.env.HOMERAIL_HOME = previousHome;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it("persists user state separately and replaces the complete override atomically", () => {
    const target = createDocument();
    expect(target.overrides.put({
      documentId: "override-document",
      nodeId: "note",
      visibility: "minimized",
      pinned: true,
      preferredSurface: "result",
      updatedAt: time1,
    }, scope)).toMatchObject({
      visibility: "minimized",
      pinned: true,
      preferred_surface: "result",
    });
    expect(target.documents.get("override-document", scope)?.nodes[0]).not.toHaveProperty("pinned");

    closeDb();
    const restarted = services();
    expect(restarted.overrides.list("override-document", scope)).toEqual([{
      document_id: "override-document",
      node_id: "note",
      visibility: "minimized",
      pinned: true,
      preferred_surface: "result",
      updated_at: time1,
    }]);
    restarted.overrides.put({
      documentId: "override-document",
      nodeId: "note",
      pinned: false,
      updatedAt: time2,
    }, scope);
    expect(restarted.overrides.list("override-document", scope)).toEqual([{
      document_id: "override-document",
      node_id: "note",
      pinned: false,
      updated_at: time2,
    }]);
  });

  it("rejects cross-scope, missing-node and empty overrides", () => {
    const target = createDocument();
    expect(() => target.overrides.put({
      documentId: "override-document",
      nodeId: "note",
      pinned: true,
      updatedAt: time1,
    }, { type: "voice_session", id: "other" })).toThrow("scope mismatch");
    expect(() => target.overrides.put({
      documentId: "override-document",
      nodeId: "missing",
      pinned: true,
      updatedAt: time1,
    }, scope)).toThrow("node not found");
    expect(() => target.overrides.put({
      documentId: "override-document",
      nodeId: "note",
      updatedAt: time1,
    }, scope)).toThrow("Invalid Generative UI user override");
  });

  it("retains historical overrides after close but rejects further writes", () => {
    const target = createDocument();
    target.overrides.put({
      documentId: "override-document",
      nodeId: "note",
      visibility: "hidden",
      updatedAt: time1,
    }, scope);
    expect(target.documents.close("override-document", scope)).toBe(true);

    expect(target.overrides.list("override-document", scope)).toMatchObject([{
      node_id: "note",
      visibility: "hidden",
    }]);
    expect(() => target.overrides.put({
      documentId: "override-document",
      nodeId: "note",
      pinned: true,
      updatedAt: time2,
    }, scope)).toThrow("Active Generative UI document not found");
    expect(() => target.overrides.delete("override-document", "note", scope))
      .toThrow("Active Generative UI document not found");
  });

  it("fails closed on corrupted persisted override values", () => {
    const target = createDocument();
    target.overrides.put({
      documentId: "override-document",
      nodeId: "note",
      pinned: true,
      updatedAt: time1,
    }, scope);
    getDb().pragma("ignore_check_constraints = ON");
    getDb().prepare(`
      UPDATE generative_ui_user_overrides SET pinned = 2
      WHERE document_id = ? AND node_id = ?
    `).run("override-document", "note");
    getDb().pragma("ignore_check_constraints = OFF");
    expect(() => target.overrides.list("override-document", scope)).toThrow("Invalid persisted");
  });
});
