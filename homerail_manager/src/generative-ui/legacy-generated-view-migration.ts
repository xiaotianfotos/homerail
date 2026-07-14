import { createHash } from "node:crypto";
import {
  GENERATIVE_UI_IR_VERSION,
  GenerativeUiActorType,
  type GenerativeUiKindValidatorV1,
  type GenerativeUiNodeV1,
  type GenerativeUiStoredNodeV1,
} from "homerail-protocol";
import { getDb } from "../persistence/db.js";
import { nowIso } from "../persistence/time.js";
import { PersistentGenerativeUiDocumentService } from "./persistent-document-service.js";

const CORE_PLUGIN_ID = "com.homerail.core";
const GENERATED_VIEW_KIND = "com.homerail.core/generated_view";
const LEGACY_VIEW_SPEC_KIND_VERSION = 1;

export interface LegacyGeneratedViewMigrationResult {
  migrated_documents: number;
  migrated_nodes: number;
  committed_transactions: number;
}

function isLegacyViewSpecNode(
  node: GenerativeUiStoredNodeV1,
  activePluginVersion: string,
): boolean {
  return node.owner.id === CORE_PLUGIN_ID
    && node.owner.version !== activePluginVersion
    && node.kind === GENERATED_VIEW_KIND
    && node.kind_version === LEGACY_VIEW_SPEC_KIND_VERSION
    && node.view !== undefined
    && node.a2ui === undefined;
}

function ownerReboundNode(
  node: GenerativeUiStoredNodeV1,
  activePluginVersion: string,
): GenerativeUiNodeV1 {
  const { revision: _revision, updated_at: _updatedAt, ...base } = node;
  return {
    ...base,
    owner: { id: CORE_PLUGIN_ID, version: activePluginVersion },
  };
}

function migrationTransactionId(input: {
  active_plugin_version: string;
  document_id: string;
  base_revision: number;
  chunk: number;
}): string {
  const digest = createHash("sha256").update(JSON.stringify(input)).digest("hex");
  return `builtin-view-spec-owner-migration-${digest}`;
}

/**
 * Rebinds persisted ViewSpec nodes to the active built-in package without
 * changing their kind version, content, or presentation. The append-only
 * transaction ledger is the migration audit trail; the owner predicate makes
 * the operation idempotent across restarts.
 */
export function rebindLegacyCoreGeneratedViewOwners(input: {
  active_plugin_version: string;
  validate_kind: GenerativeUiKindValidatorV1;
  timestamp?: string;
}): LegacyGeneratedViewMigrationResult {
  return getDb().transaction(() => {
    const documents = new PersistentGenerativeUiDocumentService(input.validate_kind);
    const timestamp = input.timestamp ?? nowIso();
    let migratedDocuments = 0;
    let migratedNodes = 0;
    let committedTransactions = 0;

    for (const document of documents.listActiveCanonicalDocuments()) {
      const candidates = document.nodes.filter((node) => (
        isLegacyViewSpecNode(node, input.active_plugin_version)
      ));
      if (!candidates.length) continue;
      migratedDocuments += 1;
      migratedNodes += candidates.length;

      for (let offset = 0, chunk = 0; offset < candidates.length; offset += 32, chunk += 1) {
        const current = documents.get(document.document_id, document.scope);
        if (!current) throw new Error(`Canonical document disappeared during ViewSpec migration: ${document.document_id}`);
        const createdAt = Date.parse(current.updated_at) > Date.parse(timestamp)
          ? current.updated_at
          : timestamp;
        const candidateIds = new Set(candidates.slice(offset, offset + 32).map((node) => node.id));
        const operations = current.nodes
          .filter((node) => candidateIds.has(node.id) && isLegacyViewSpecNode(node, input.active_plugin_version))
          .map((node) => ({
            op: "put" as const,
            node: ownerReboundNode(node, input.active_plugin_version),
          }));
        if (!operations.length) continue;
        const result = documents.apply({
          ir_version: GENERATIVE_UI_IR_VERSION,
          transaction_id: migrationTransactionId({
            active_plugin_version: input.active_plugin_version,
            document_id: current.document_id,
            base_revision: current.revision,
            chunk,
          }),
          document_id: current.document_id,
          base_revision: current.revision,
          actor: { type: GenerativeUiActorType.SYSTEM, id: "builtin-view-spec-owner-migration" },
          operations,
          created_at: createdAt,
        }, current.scope);
        if (result.status !== "applied") {
          throw new Error(
            `ViewSpec owner migration was rejected for ${current.document_id}: ${JSON.stringify(result.errors ?? [])}`,
          );
        }
        committedTransactions += 1;
      }
    }

    return {
      migrated_documents: migratedDocuments,
      migrated_nodes: migratedNodes,
      committed_transactions: committedTransactions,
    };
  }).immediate();
}
