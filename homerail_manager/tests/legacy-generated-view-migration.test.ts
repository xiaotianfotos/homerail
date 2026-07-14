import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  GENERATIVE_UI_IR_VERSION,
  GenerativeUiActorType,
  type GenerativeUiStoredNodeV1,
} from "homerail-protocol";
import { GenerativeUiKindRegistry } from "../src/generative-ui/kind-registry.js";
import { rebindLegacyCoreGeneratedViewOwners } from "../src/generative-ui/legacy-generated-view-migration.js";
import { PersistentGenerativeUiDocumentService } from "../src/generative-ui/persistent-document-service.js";
import { closeDb } from "../src/persistence/db.js";
import { syncBuiltinPlugins } from "../src/plugins/registry.js";

const scope = { type: "voice_session" as const, id: "legacy-view-session" };
const createdAt = "2026-07-13T08:00:00.000Z";
const migratedAt = "2026-07-14T08:00:00.000Z";

function legacyViewNode(): Omit<GenerativeUiStoredNodeV1, "revision" | "updated_at"> {
  return {
    ir_version: GENERATIVE_UI_IR_VERSION,
    id: "legacy-view",
    kind: "com.homerail.core/generated_view",
    kind_version: 1,
    owner: { id: "com.homerail.core", version: "0.1.7" },
    surface: "result",
    importance: "primary",
    content: { data: { title: "Legacy ViewSpec remains exact" } },
    view: {
      view_version: 1,
      root: {
        id: "root",
        type: "heading",
        text: { path: "/data/title" },
        level: 2,
      },
    },
    presentation: { density: "detail", preferred_visual: "view_spec" },
    fallback: { title: "Legacy ViewSpec remains exact" },
  };
}

describe("legacy generated ViewSpec migration", () => {
  let previousHome: string | undefined;
  let tmpHome: string;

  beforeEach(() => {
    closeDb();
    previousHome = process.env.HOMERAIL_HOME;
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "homerail-view-spec-migration-"));
    process.env.HOMERAIL_HOME = tmpHome;
    syncBuiltinPlugins();
  });

  afterEach(() => {
    closeDb();
    if (previousHome === undefined) delete process.env.HOMERAIL_HOME;
    else process.env.HOMERAIL_HOME = previousHome;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it("rebinds the owner atomically while preserving ViewSpec and remains idempotent", () => {
    const seed = new PersistentGenerativeUiDocumentService(() => []);
    const document = seed.createOrGet({
      documentId: "legacy-view-document",
      scope,
      createdAt,
    });
    expect(seed.apply({
      ir_version: GENERATIVE_UI_IR_VERSION,
      transaction_id: "seed-legacy-view",
      document_id: document.document_id,
      base_revision: document.revision,
      actor: { type: GenerativeUiActorType.SYSTEM, id: "legacy-fixture" },
      operations: [{ op: "put", node: legacyViewNode() }],
      created_at: createdAt,
    }, scope).status).toBe("applied");

    const registry = new GenerativeUiKindRegistry();
    const validateKind = (node: GenerativeUiStoredNodeV1) => registry.validateHistoricalNode(
      node.owner.id === "com.homerail.core" && node.owner.version === "0.1.7"
        ? { ...node, owner: { ...node.owner, version: "0.1.8" } }
        : node,
    );
    expect(rebindLegacyCoreGeneratedViewOwners({
      active_plugin_version: "0.1.8",
      validate_kind: validateKind,
      timestamp: migratedAt,
    })).toEqual({
      migrated_documents: 1,
      migrated_nodes: 1,
      committed_transactions: 1,
    });

    const migratedStore = new PersistentGenerativeUiDocumentService(registry.validateHistoricalNode);
    const migrated = migratedStore.get(document.document_id, scope)!;
    expect(migrated.nodes[0]).toMatchObject({
      owner: { id: "com.homerail.core", version: "0.1.8" },
      kind: "com.homerail.core/generated_view",
      kind_version: 1,
      content: { data: { title: "Legacy ViewSpec remains exact" } },
      view: legacyViewNode().view,
      revision: 2,
    });
    expect(migrated.nodes[0].a2ui).toBeUndefined();
    expect(migratedStore.listTransactions(document.document_id, scope)).toHaveLength(2);
    expect(migratedStore.listTransactions(document.document_id, scope)[1]?.transaction.actor)
      .toMatchObject({ type: "system", id: "builtin-view-spec-owner-migration" });

    expect(rebindLegacyCoreGeneratedViewOwners({
      active_plugin_version: "0.1.8",
      validate_kind: registry.validateHistoricalNode,
      timestamp: migratedAt,
    })).toEqual({
      migrated_documents: 0,
      migrated_nodes: 0,
      committed_transactions: 0,
    });
    expect(migratedStore.listTransactions(document.document_id, scope)).toHaveLength(2);
  });
});
