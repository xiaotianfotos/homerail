import Database from "better-sqlite3";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { getDbPath } from "../src/config/env.js";
import { closeDb, getDb } from "../src/persistence/db.js";
import { PersistentGenerativeUiDocumentService } from "../src/generative-ui/persistent-document-service.js";
import { compileLegacyVoiceSurfaceToGenerativeUiTransaction } from "../src/generative-ui/legacy-widget-compiler.js";
import {
  GenerativeUiShadowService,
  validateLegacyShadowKind,
} from "../src/generative-ui/shadow-service.js";

const scope = { type: "voice_session", id: "persistent-session" } as const;
const time0 = "2026-07-11T18:00:00.000Z";
const time1 = "2026-07-11T18:01:00.000Z";

function transaction(documentId = "persistent-document", title = "Persistent note") {
  const compiled = compileLegacyVoiceSurfaceToGenerativeUiTransaction({
    transaction_id: "persistent-transaction-1",
    document_id: documentId,
    base_revision: 0,
    created_at: time1,
    voice_surface: {
      widgets: [{ id: "note", type: "note", title, body: "Durable shadow state" }],
    },
  });
  if (!compiled) throw new Error("expected transaction");
  return compiled;
}

describe("PersistentGenerativeUiDocumentService", () => {
  let previousHome: string | undefined;
  let tmpHome: string;

  beforeEach(() => {
    closeDb();
    previousHome = process.env.HOMERAIL_HOME;
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "homerail-generative-ui-persistent-"));
    process.env.HOMERAIL_HOME = tmpHome;
  });

  afterEach(() => {
    closeDb();
    if (previousHome === undefined) delete process.env.HOMERAIL_HOME;
    else process.env.HOMERAIL_HOME = previousHome;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it("applies one durable transaction and recovers head plus ledger after restart", () => {
    const target = new PersistentGenerativeUiDocumentService(validateLegacyShadowKind);
    target.createOrGet({
      documentId: "persistent-document",
      scope,
      createdAt: time0,
      purpose: "legacy_widget_shadow",
    });
    const input = transaction();
    expect(target.apply(input, scope)).toMatchObject({ status: "applied", revision: 1 });
    expect(target.apply(structuredClone(input), scope)).toMatchObject({ status: "duplicate", revision: 1 });
    expect(getDb().prepare("SELECT COUNT(*) AS count FROM generative_ui_transactions").get())
      .toEqual({ count: 1 });

    closeDb();
    const reopened = new PersistentGenerativeUiDocumentService(validateLegacyShadowKind);
    expect(reopened.findActiveForScope(scope, "legacy_widget_shadow")).toMatchObject({
      document_id: "persistent-document",
      revision: 1,
      nodes: [{ id: "note", revision: 1 }],
    });
    expect(reopened.listTransactions("persistent-document", scope)).toMatchObject([{
      seq: 1,
      transaction_id: "persistent-transaction-1",
      committed_revision: 1,
    }]);

    const collision = reopened.apply(transaction("persistent-document", "Changed collision"), scope);
    expect(collision).toMatchObject({
      status: "rejected",
      errors: [{ keyword: "transactionIdCollision" }],
    });
  });

  it("rolls back the head when append-only ledger persistence fails", () => {
    const target = new PersistentGenerativeUiDocumentService(validateLegacyShadowKind);
    target.createOrGet({
      documentId: "persistent-document",
      scope,
      createdAt: time0,
      purpose: "legacy_widget_shadow",
    });
    getDb().exec(`
      CREATE TRIGGER fail_generative_ui_ledger
      BEFORE INSERT ON generative_ui_transactions
      BEGIN
        SELECT RAISE(ABORT, 'forced ledger failure');
      END
    `);

    expect(() => target.apply(transaction(), scope)).toThrow("forced ledger failure");
    expect(target.get("persistent-document", scope)).toMatchObject({ revision: 0, nodes: [] });
    expect(getDb().prepare("SELECT COUNT(*) AS count FROM generative_ui_transactions").get())
      .toEqual({ count: 0 });
  });

  it("fails closed on corrupted snapshot metadata and isolates purpose and scope", () => {
    const target = new PersistentGenerativeUiDocumentService(validateLegacyShadowKind);
    target.createOrGet({
      documentId: "persistent-document",
      scope,
      createdAt: time0,
      purpose: "legacy_widget_shadow",
    });
    expect(() => target.createOrGet({
      documentId: "persistent-document",
      scope,
      createdAt: time0,
      purpose: "canonical",
    })).toThrow("purpose mismatch");
    expect(() => target.get("persistent-document", { type: "voice_session", id: "other" }))
      .toThrow("scope mismatch");

    getDb().prepare(`
      UPDATE generative_ui_documents SET snapshot_hash = ? WHERE document_id = ?
    `).run("0".repeat(64), "persistent-document");
    expect(() => target.get("persistent-document", scope)).toThrow("Invalid persisted");
  });

  it("tombstones a closed incarnation while allowing a new active document", () => {
    const target = new PersistentGenerativeUiDocumentService(validateLegacyShadowKind);
    target.createOrGet({
      documentId: "persistent-document-1",
      scope,
      createdAt: time0,
      purpose: "legacy_widget_shadow",
    });
    expect(target.close("persistent-document-1", scope)).toBe(true);
    expect(target.findActiveForScope(scope, "legacy_widget_shadow")).toBeUndefined();
    expect(target.getLatestForScope(scope, "legacy_widget_shadow", true)).toMatchObject({
      document_id: "persistent-document-1",
    });
    expect(target.createOrGet({
      documentId: "persistent-document-2",
      scope,
      createdAt: time1,
      purpose: "legacy_widget_shadow",
    })).toMatchObject({ document_id: "persistent-document-2", revision: 0 });
  });

  it("closes a durable active document after the shadow process state is lost", () => {
    const target = new PersistentGenerativeUiDocumentService(validateLegacyShadowKind);
    target.createOrGet({
      documentId: "persistent-document",
      scope,
      createdAt: time0,
      purpose: "legacy_widget_shadow",
    });

    const restartedShadow = new GenerativeUiShadowService(8, target);
    expect(restartedShadow.deleteSession(scope.id)).toBe(true);
    expect(target.findActiveForScope(scope, "legacy_widget_shadow")).toBeUndefined();
    expect(target.getLatestForScope(scope, "legacy_widget_shadow", true)).toMatchObject({
      document_id: "persistent-document",
    });
  });

  it("upgrades an existing v2 database once without changing legacy Voice data", () => {
    closeDb();
    fs.mkdirSync(path.dirname(getDbPath()), { recursive: true });
    const legacy = new Database(getDbPath());
    legacy.exec(`
      CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
      INSERT INTO schema_migrations(version, applied_at) VALUES (1, '${time0}'), (2, '${time0}');
      CREATE TABLE voice_agent_sessions(
        session_id TEXT PRIMARY KEY,
        project_id TEXT,
        updated_at TEXT NOT NULL,
        data TEXT NOT NULL
      );
    `);
    const legacyPayload = JSON.stringify({ session_id: "legacy-v2", widgets: [{ id: "legacy" }] });
    legacy.prepare(`
      INSERT INTO voice_agent_sessions(session_id, project_id, updated_at, data) VALUES (?, NULL, ?, ?)
    `).run("legacy-v2", time0, legacyPayload);
    legacy.close();

    expect(getDb().prepare("SELECT version FROM schema_migrations ORDER BY version").all())
      .toEqual(Array.from({ length: 18 }, (_, index) => ({ version: index + 1 })));
    expect(getDb().prepare("SELECT data FROM voice_agent_sessions WHERE session_id = ?").get("legacy-v2"))
      .toEqual({ data: legacyPayload });
    expect(getDb().prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'table' AND name IN ('generative_ui_documents', 'generative_ui_transactions')
      ORDER BY name
    `).all()).toEqual([
      { name: "generative_ui_documents" },
      { name: "generative_ui_transactions" },
    ]);
    closeDb();
    expect(getDb().prepare("SELECT COUNT(*) AS count FROM schema_migrations WHERE version = 3").get())
      .toEqual({ count: 1 });
    expect(getDb().prepare("SELECT COUNT(*) AS count FROM schema_migrations WHERE version = 4").get())
      .toEqual({ count: 1 });
    expect(getDb().prepare("SELECT COUNT(*) AS count FROM schema_migrations WHERE version = 5").get())
      .toEqual({ count: 1 });
    expect(getDb().prepare("SELECT COUNT(*) AS count FROM schema_migrations WHERE version = 6").get())
      .toEqual({ count: 1 });
    expect(getDb().prepare("SELECT COUNT(*) AS count FROM schema_migrations WHERE version = 7").get())
      .toEqual({ count: 1 });
    expect(getDb().prepare("SELECT COUNT(*) AS count FROM schema_migrations WHERE version = 8").get())
      .toEqual({ count: 1 });
    expect(getDb().prepare("SELECT COUNT(*) AS count FROM schema_migrations WHERE version = 9").get())
      .toEqual({ count: 1 });
  });

  it("remaps main's colliding DAG migration markers before applying the merged chain", () => {
    closeDb();
    fs.mkdirSync(path.dirname(getDbPath()), { recursive: true });
    const mainDb = new Database(getDbPath());
    mainDb.exec(`
      CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
      INSERT INTO schema_migrations(version, applied_at)
      VALUES (1, '${time0}'), (2, '${time0}'), (3, '${time0}'), (4, '${time0}'), (5, '${time0}'), (6, '${time0}');
      CREATE TABLE dag_workflows (
        workflow_id TEXT PRIMARY KEY,
        head_revision INTEGER NOT NULL DEFAULT 0,
        api_version TEXT,
        canonical_hash TEXT,
        compiler_version TEXT
      );
      CREATE TABLE dag_workflow_revisions (
        workflow_id TEXT NOT NULL,
        revision INTEGER NOT NULL,
        canonical_hash TEXT NOT NULL,
        PRIMARY KEY(workflow_id, revision)
      );
      CREATE TABLE dag_approvals (
        run_id TEXT NOT NULL,
        node_id TEXT NOT NULL,
        status TEXT NOT NULL,
        proposer_actor TEXT NOT NULL,
        expires_at INTEGER,
        decision TEXT,
        actor TEXT,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY(run_id, node_id)
      );
      CREATE TABLE dag_run_admissions (
        run_id TEXT PRIMARY KEY,
        workflow_id TEXT NOT NULL,
        source TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE dag_artifacts (
        run_id TEXT NOT NULL,
        name TEXT NOT NULL,
        artifact_id TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL,
        upload_token_hash TEXT,
        upload_expires_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        data TEXT NOT NULL,
        PRIMARY KEY(run_id, name)
      );
    `);
    mainDb.close();

    expect(getDb().prepare("SELECT version FROM schema_migrations ORDER BY version").all())
      .toEqual(Array.from({ length: 18 }, (_, index) => ({ version: index + 1 })));
    expect(getDb().prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'table' AND name IN ('generative_ui_documents', 'generative_ui_user_overrides')
      ORDER BY name
    `).all()).toEqual([
      { name: "generative_ui_documents" },
      { name: "generative_ui_user_overrides" },
    ]);
  });

  it("fails closed when a v3 migration marker exists without its schema objects", () => {
    closeDb();
    fs.mkdirSync(path.dirname(getDbPath()), { recursive: true });
    const corrupt = new Database(getDbPath());
    corrupt.exec(`
      CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
      INSERT INTO schema_migrations(version, applied_at)
      VALUES (1, '${time0}'), (2, '${time0}'), (3, '${time0}');
    `);
    corrupt.close();

    expect(() => getDb()).toThrow(
      "Schema migration 3 is incomplete: missing table generative_ui_documents",
    );
  });

  it("fails closed when the v4 override table disappears after migration", () => {
    getDb().exec("DROP TABLE generative_ui_user_overrides");
    closeDb();
    expect(() => getDb()).toThrow(
      "Schema migration 4 is incomplete: missing table generative_ui_user_overrides",
    );
  });

  it("fails closed when a v5 plugin registry table disappears after migration", () => {
    getDb().exec("DROP TABLE plugin_activations");
    closeDb();
    expect(() => getDb()).toThrow(
      "Schema migration 5 is incomplete: missing table plugin_activations",
    );
  });
});
