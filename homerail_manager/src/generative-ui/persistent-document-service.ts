import {
  GENERATIVE_UI_MAX_DOCUMENT_BYTES,
  applyGenerativeUiTransaction,
  createGenerativeUiDocument,
  validateGenerativeUiDocument,
  validateGenerativeUiTransaction,
  type GenerativeUiDocumentScopeV1,
  type GenerativeUiDocumentV1,
  type GenerativeUiKindValidatorV1,
  type GenerativeUiTransactionResultV1,
  type GenerativeUiTransactionV1,
} from "homerail-protocol";
import { encodeJson, getDb, parseJsonRow } from "../persistence/db.js";
import { nowIso } from "../persistence/time.js";
import {
  generativeUiJsonFingerprint,
  rejected,
  sameScope,
  transactionFingerprint,
  type CreateGenerativeUiDocumentInput,
  type GenerativeUiDocumentStore,
} from "./document-service.js";

interface DocumentRow {
  document_id: string;
  purpose: "canonical" | "legacy_widget_shadow";
  scope_type: GenerativeUiDocumentScopeV1["type"];
  scope_id: string;
  ir_version: number;
  revision: number;
  snapshot_json: string;
  snapshot_hash: string;
  updated_at: string;
  deleted_at: string | null;
}

interface TransactionRow {
  seq: number;
  document_id: string;
  transaction_id: string;
  fingerprint: string;
  base_revision: number;
  committed_revision: number;
  transaction_json: string;
  producer_created_at: string;
  committed_at: string;
}

export interface GenerativeUiCommittedTransactionV1 {
  seq: number;
  document_id: string;
  transaction_id: string;
  committed_revision: number;
  committed_at: string;
  transaction: GenerativeUiTransactionV1;
}

function rowScope(row: DocumentRow): GenerativeUiDocumentScopeV1 {
  return { type: row.scope_type, id: row.scope_id };
}

function decodeDocument(row: DocumentRow): GenerativeUiDocumentV1 {
  const document = parseJsonRow<GenerativeUiDocumentV1>(row.snapshot_json);
  const validation = validateGenerativeUiDocument(document);
  if (
    !validation.valid
    || document.document_id !== row.document_id
    || document.ir_version !== row.ir_version
    || document.revision !== row.revision
    || !sameScope(document.scope, rowScope(row))
    || generativeUiJsonFingerprint(document, GENERATIVE_UI_MAX_DOCUMENT_BYTES) !== row.snapshot_hash
  ) {
    throw new Error(`Invalid persisted Generative UI document: ${row.document_id}`);
  }
  return validation.value ?? document;
}

/** SQLite-backed M2 document head plus append-only committed transaction ledger. */
export class PersistentGenerativeUiDocumentService implements GenerativeUiDocumentStore {
  readonly #validateKind: GenerativeUiKindValidatorV1;

  constructor(validateKind: GenerativeUiKindValidatorV1) {
    this.#validateKind = validateKind;
  }

  #row(documentId: string): DocumentRow | undefined {
    return getDb().prepare(`
      SELECT document_id, scope_type, scope_id, revision, snapshot_json, deleted_at
             , purpose, ir_version, snapshot_hash, updated_at
      FROM generative_ui_documents
      WHERE document_id = ?
    `).get(documentId) as DocumentRow | undefined;
  }

  createOrGet(input: CreateGenerativeUiDocumentInput): GenerativeUiDocumentV1 {
    const existing = this.#row(input.documentId);
    const purpose = input.purpose ?? "canonical";
    if (existing) {
      if (existing.deleted_at) throw new Error(`Generative UI document id cannot be reused after deletion: ${input.documentId}`);
      if (!sameScope(rowScope(existing), input.scope)) {
        throw new Error(`Generative UI document scope mismatch: ${input.documentId}`);
      }
      if (existing.purpose !== purpose) {
        throw new Error(`Generative UI document purpose mismatch: ${input.documentId}`);
      }
      return structuredClone(decodeDocument(existing));
    }
    const document = createGenerativeUiDocument({
      document_id: input.documentId,
      scope: structuredClone(input.scope),
      created_at: input.createdAt,
    });
    const validation = validateGenerativeUiDocument(document);
    if (!validation.valid) {
      throw new Error(`Invalid Generative UI document: ${JSON.stringify(validation.errors)}`);
    }
    getDb().prepare(`
      INSERT INTO generative_ui_documents(
        document_id, purpose, scope_type, scope_id, ir_version, revision,
        snapshot_json, snapshot_hash, created_at, updated_at, deleted_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
    `).run(
      document.document_id,
      purpose,
      document.scope.type,
      document.scope.id,
      document.ir_version,
      document.revision,
      encodeJson(document),
      generativeUiJsonFingerprint(document, GENERATIVE_UI_MAX_DOCUMENT_BYTES),
      input.createdAt,
      document.updated_at,
    );
    return structuredClone(document);
  }

  get(
    documentId: string,
    expectedScope: GenerativeUiDocumentScopeV1,
  ): GenerativeUiDocumentV1 | undefined {
    const row = this.#row(documentId);
    if (!row || row.deleted_at) return undefined;
    if (!sameScope(rowScope(row), expectedScope)) {
      throw new Error(`Generative UI document scope mismatch: ${documentId}`);
    }
    return structuredClone(decodeDocument(row));
  }

  /**
   * Trusted internal lookup for brokers that resume an already-authorized
   * request by document id. HTTP callers must still prove the scope on the
   * initial interaction; this method is intentionally not exposed as a route.
   */
  resolveScope(documentId: string): GenerativeUiDocumentScopeV1 | undefined {
    const row = this.#row(documentId);
    if (!row || row.deleted_at) return undefined;
    decodeDocument(row);
    return structuredClone(rowScope(row));
  }

  getIncludingDeleted(
    documentId: string,
    expectedScope: GenerativeUiDocumentScopeV1,
  ): GenerativeUiDocumentV1 | undefined {
    const row = this.#row(documentId);
    if (!row) return undefined;
    if (!sameScope(rowScope(row), expectedScope)) {
      throw new Error(`Generative UI document scope mismatch: ${documentId}`);
    }
    return structuredClone(decodeDocument(row));
  }

  getLatestForScope(
    scope: GenerativeUiDocumentScopeV1,
    purpose: DocumentRow["purpose"] = "canonical",
    includeDeleted = false,
  ): GenerativeUiDocumentV1 | undefined {
    const row = getDb().prepare(`
      SELECT document_id, purpose, scope_type, scope_id, ir_version, revision,
             snapshot_json, snapshot_hash, updated_at, deleted_at
      FROM generative_ui_documents
      WHERE scope_type = ? AND scope_id = ? AND purpose = ?
        AND (? = 1 OR deleted_at IS NULL)
      ORDER BY updated_at DESC, rowid DESC
      LIMIT 1
    `).get(scope.type, scope.id, purpose, includeDeleted ? 1 : 0) as DocumentRow | undefined;
    return row ? structuredClone(decodeDocument(row)) : undefined;
  }

  findActiveForScope(
    scope: GenerativeUiDocumentScopeV1,
    purpose: DocumentRow["purpose"],
  ): GenerativeUiDocumentV1 | undefined {
    return this.getLatestForScope(scope, purpose, false);
  }

  /** Trusted migration-only snapshot of every live canonical document. */
  listActiveCanonicalDocuments(): GenerativeUiDocumentV1[] {
    const rows = getDb().prepare(`
      SELECT document_id, purpose, scope_type, scope_id, ir_version, revision,
             snapshot_json, snapshot_hash, updated_at, deleted_at
      FROM generative_ui_documents
      WHERE purpose = 'canonical' AND deleted_at IS NULL
      ORDER BY document_id
    `).all() as DocumentRow[];
    return rows.map((row) => structuredClone(decodeDocument(row)));
  }

  apply(
    transaction: GenerativeUiTransactionV1,
    expectedScope: GenerativeUiDocumentScopeV1,
  ): GenerativeUiTransactionResultV1 {
    return getDb().transaction((): GenerativeUiTransactionResultV1 => {
      const row = this.#row(transaction.document_id);
      if (!row || row.deleted_at) throw new Error(`Generative UI document not found: ${transaction.document_id}`);
      const document = decodeDocument(row);
      if (!sameScope(rowScope(row), expectedScope)) {
        return rejected(document, {
          path: "/transaction/document_id",
          message: `transaction scope does not own document: ${transaction.document_id}`,
          keyword: "documentScope",
        });
      }

      let fingerprint: string;
      try {
        fingerprint = transactionFingerprint(transaction);
      } catch (cause) {
        return rejected(document, {
          path: "/transaction",
          message: cause instanceof Error ? cause.message : String(cause),
          keyword: "jsonValue",
        });
      }
      const previous = getDb().prepare(`
        SELECT seq, document_id, transaction_id, fingerprint, base_revision,
               committed_revision, transaction_json, producer_created_at, committed_at
        FROM generative_ui_transactions
        WHERE document_id = ? AND transaction_id = ?
      `).get(transaction.document_id, transaction.transaction_id) as TransactionRow | undefined;
      if (previous) {
        if (previous.fingerprint !== fingerprint) {
          return rejected(document, {
            path: "/transaction/transaction_id",
            message: `transaction id was already used with different input: ${transaction.transaction_id}`,
            keyword: "transactionIdCollision",
          });
        }
        return { status: "duplicate", revision: document.revision, document: structuredClone(document) };
      }

      const result = applyGenerativeUiTransaction(document, transaction, {
        transaction_already_applied: false,
        validate_kind: this.#validateKind,
      });
      if (result.status !== "applied") return structuredClone(result);

      const snapshotJson = encodeJson(result.document);
      const updated = getDb().prepare(`
        UPDATE generative_ui_documents
        SET revision = ?, snapshot_json = ?, snapshot_hash = ?, updated_at = ?
        WHERE document_id = ? AND revision = ? AND deleted_at IS NULL
      `).run(
        result.document.revision,
        snapshotJson,
        generativeUiJsonFingerprint(result.document, GENERATIVE_UI_MAX_DOCUMENT_BYTES),
        result.document.updated_at,
        transaction.document_id,
        document.revision,
      );
      if (updated.changes !== 1) {
        return {
          status: "conflict",
          revision: document.revision,
          document: structuredClone(document),
          errors: [{
            path: "/transaction/base_revision",
            message: "document head changed before commit",
            keyword: "revisionConflict",
          }],
        };
      }
      getDb().prepare(`
        INSERT INTO generative_ui_transactions(
          document_id, transaction_id, fingerprint, base_revision,
          committed_revision, transaction_json, producer_created_at, committed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        transaction.document_id,
        transaction.transaction_id,
        fingerprint,
        transaction.base_revision,
        result.document.revision,
        encodeJson(transaction),
        transaction.created_at,
        nowIso(),
      );
      return structuredClone(result);
    }).immediate();
  }

  listTransactions(
    documentId: string,
    expectedScope: GenerativeUiDocumentScopeV1,
    afterSeq = 0,
    limit = 100,
  ): GenerativeUiCommittedTransactionV1[] {
    const documentRow = this.#row(documentId);
    if (!documentRow) throw new Error(`Generative UI document not found: ${documentId}`);
    if (!sameScope(rowScope(documentRow), expectedScope)) {
      throw new Error(`Generative UI document scope mismatch: ${documentId}`);
    }
    decodeDocument(documentRow);
    const boundedLimit = Math.max(1, Math.min(500, Math.floor(limit)));
    const rows = getDb().prepare(`
      SELECT seq, document_id, transaction_id, fingerprint, base_revision,
             committed_revision, transaction_json, producer_created_at, committed_at
      FROM generative_ui_transactions
      WHERE document_id = ? AND seq > ?
      ORDER BY seq ASC
      LIMIT ?
    `).all(documentId, Math.max(0, Math.floor(afterSeq)), boundedLimit) as TransactionRow[];
    return rows.map((row) => {
      const transaction = parseJsonRow<GenerativeUiTransactionV1>(row.transaction_json);
      const validation = validateGenerativeUiTransaction(transaction);
      if (
        !validation.valid
        || transaction.document_id !== row.document_id
        || transaction.transaction_id !== row.transaction_id
        || transaction.base_revision !== row.base_revision
        || transaction.base_revision + 1 !== row.committed_revision
        || transaction.created_at !== row.producer_created_at
        || transactionFingerprint(transaction) !== row.fingerprint
      ) {
        throw new Error(`Invalid persisted Generative UI transaction: ${row.transaction_id}`);
      }
      return {
        seq: row.seq,
        document_id: row.document_id,
        transaction_id: row.transaction_id,
        committed_revision: row.committed_revision,
        committed_at: row.committed_at,
        transaction: validation.value ?? transaction,
      };
    });
  }

  getCursor(documentId: string, expectedScope: GenerativeUiDocumentScopeV1): number {
    const documentRow = this.#row(documentId);
    if (!documentRow) throw new Error(`Generative UI document not found: ${documentId}`);
    if (!sameScope(rowScope(documentRow), expectedScope)) {
      throw new Error(`Generative UI document scope mismatch: ${documentId}`);
    }
    decodeDocument(documentRow);
    const row = getDb().prepare(`
      SELECT COALESCE(MAX(seq), 0) AS seq
      FROM generative_ui_transactions
      WHERE document_id = ?
    `).get(documentId) as { seq: number };
    return row.seq;
  }

  delete(documentId: string, expectedScope: GenerativeUiDocumentScopeV1): boolean {
    const row = this.#row(documentId);
    if (!row || row.deleted_at) return false;
    if (!sameScope(rowScope(row), expectedScope)) {
      throw new Error(`Generative UI document scope mismatch: ${documentId}`);
    }
    const timestamp = nowIso();
    return getDb().prepare(`
      UPDATE generative_ui_documents SET deleted_at = ?, updated_at = ?
      WHERE document_id = ? AND deleted_at IS NULL
    `).run(timestamp, timestamp, documentId).changes === 1;
  }

  evictEphemeral(documentId: string, expectedScope: GenerativeUiDocumentScopeV1): boolean {
    const row = this.#row(documentId);
    if (!row || row.deleted_at) return false;
    if (!sameScope(rowScope(row), expectedScope)) {
      throw new Error(`Generative UI document scope mismatch: ${documentId}`);
    }
    return true;
  }

  close(documentId: string, expectedScope: GenerativeUiDocumentScopeV1): boolean {
    return this.delete(documentId, expectedScope);
  }

  clear(): void {
    getDb().transaction(() => {
      getDb().prepare("DELETE FROM generative_ui_user_overrides").run();
      getDb().prepare("DELETE FROM generative_ui_transactions").run();
      getDb().prepare("DELETE FROM generative_ui_documents").run();
    })();
  }
}
