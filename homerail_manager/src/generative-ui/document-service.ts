import * as crypto from "node:crypto";
import {
  applyGenerativeUiTransaction,
  GENERATIVE_UI_MAX_TRANSACTION_BYTES,
  analyzeGenerativeUiJsonValue,
  createGenerativeUiDocument,
  validateGenerativeUiDocument,
  type GenerativeUiDocumentScopeV1,
  type GenerativeUiDocumentV1,
  type GenerativeUiKindValidatorV1,
  type GenerativeUiTransactionResultV1,
  type GenerativeUiTransactionV1,
  type GenerativeUiValidationError,
} from "homerail-protocol";

interface AppliedTransactionRecord {
  fingerprint: string;
}

export interface CreateGenerativeUiDocumentInput {
  documentId: string;
  scope: GenerativeUiDocumentScopeV1;
  createdAt: string;
  purpose?: "canonical" | "legacy_widget_shadow";
}

export interface GenerativeUiDocumentStore {
  createOrGet(input: CreateGenerativeUiDocumentInput): GenerativeUiDocumentV1;
  get(documentId: string, expectedScope: GenerativeUiDocumentScopeV1): GenerativeUiDocumentV1 | undefined;
  apply(
    transaction: GenerativeUiTransactionV1,
    expectedScope: GenerativeUiDocumentScopeV1,
  ): GenerativeUiTransactionResultV1;
  findActiveForScope(
    scope: GenerativeUiDocumentScopeV1,
    purpose: NonNullable<CreateGenerativeUiDocumentInput["purpose"]>,
  ): GenerativeUiDocumentV1 | undefined;
  delete(documentId: string, expectedScope: GenerativeUiDocumentScopeV1): boolean;
  close(documentId: string, expectedScope: GenerativeUiDocumentScopeV1): boolean;
  evictEphemeral(documentId: string, expectedScope: GenerativeUiDocumentScopeV1): boolean;
  clear(): void;
}

const MAX_DOCUMENTS = 512;
const MAX_TRANSACTIONS_PER_DOCUMENT = 2_048;

export function generativeUiJsonFingerprint(value: unknown, maxBytes: number): string {
  const hash = crypto.createHash("sha256");
  const analysis = analyzeGenerativeUiJsonValue(value, {
    limits: { max_bytes: maxBytes },
    on_token: (value) => hash.update(value),
  });
  if (!analysis.valid) throw new Error(analysis.error?.message || "invalid Generative UI JSON value");
  return hash.digest("hex");
}

export function transactionFingerprint(value: unknown): string {
  return generativeUiJsonFingerprint(value, GENERATIVE_UI_MAX_TRANSACTION_BYTES);
}

export function sameScope(left: GenerativeUiDocumentScopeV1, right: GenerativeUiDocumentScopeV1): boolean {
  return left.type === right.type && left.id === right.id;
}

export function rejected(
  document: GenerativeUiDocumentV1,
  error: GenerativeUiValidationError,
): GenerativeUiTransactionResultV1 {
  return {
    status: "rejected",
    revision: document.revision,
    document: structuredClone(document),
    errors: [error],
  };
}

/**
 * M1-only in-memory authority for shadow Generative UI documents.
 *
 * Persistence and cross-process coordination intentionally remain out of this
 * service until the append-only transaction store lands in M2. All values are
 * cloned at the boundary so callers cannot mutate canonical state by reference.
 */
export class InMemoryGenerativeUiDocumentService implements GenerativeUiDocumentStore {
  readonly #documents = new Map<string, GenerativeUiDocumentV1>();
  readonly #appliedTransactions = new Map<string, Map<string, AppliedTransactionRecord>>();
  readonly #deletedDocumentIds = new Set<string>();
  readonly #purposes = new Map<string, NonNullable<CreateGenerativeUiDocumentInput["purpose"]>>();
  readonly #validateKind: GenerativeUiKindValidatorV1;

  constructor(validateKind: GenerativeUiKindValidatorV1) {
    this.#validateKind = validateKind;
  }

  createOrGet(input: CreateGenerativeUiDocumentInput): GenerativeUiDocumentV1 {
    const purpose = input.purpose ?? "canonical";
    const existing = this.#documents.get(input.documentId);
    if (existing) {
      if (!sameScope(existing.scope, input.scope)) {
        throw new Error(`Generative UI document scope mismatch: ${input.documentId}`);
      }
      if (this.#purposes.get(input.documentId) !== purpose) {
        throw new Error(`Generative UI document purpose mismatch: ${input.documentId}`);
      }
      return structuredClone(existing);
    }
    if (this.#deletedDocumentIds.has(input.documentId)) {
      throw new Error(`Generative UI document id cannot be reused after deletion: ${input.documentId}`);
    }
    if (this.#documents.size >= MAX_DOCUMENTS) {
      throw new Error(`Generative UI in-memory document limit reached: ${MAX_DOCUMENTS}`);
    }
    if (this.findActiveForScope(input.scope, purpose)) {
      throw new Error(`Generative UI active document already exists for ${input.scope.type}:${input.scope.id}:${purpose}`);
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
    this.#documents.set(input.documentId, structuredClone(document));
    this.#purposes.set(input.documentId, purpose);
    return structuredClone(document);
  }

  findActiveForScope(
    scope: GenerativeUiDocumentScopeV1,
    purpose: NonNullable<CreateGenerativeUiDocumentInput["purpose"]>,
  ): GenerativeUiDocumentV1 | undefined {
    for (const [documentId, document] of this.#documents) {
      if (this.#purposes.get(documentId) === purpose && sameScope(document.scope, scope)) {
        return structuredClone(document);
      }
    }
    return undefined;
  }

  get(
    documentId: string,
    expectedScope: GenerativeUiDocumentScopeV1,
  ): GenerativeUiDocumentV1 | undefined {
    const document = this.#documents.get(documentId);
    if (document && !sameScope(document.scope, expectedScope)) {
      throw new Error(`Generative UI document scope mismatch: ${documentId}`);
    }
    return document ? structuredClone(document) : undefined;
  }

  apply(
    transaction: GenerativeUiTransactionV1,
    expectedScope: GenerativeUiDocumentScopeV1,
  ): GenerativeUiTransactionResultV1 {
    const document = this.#documents.get(transaction.document_id);
    if (!document) {
      throw new Error(`Generative UI document not found: ${transaction.document_id}`);
    }
    if (!sameScope(document.scope, expectedScope)) {
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

    const documentTransactions = this.#appliedTransactions.get(transaction.document_id);
    const previous = documentTransactions?.get(transaction.transaction_id);
    if (previous && previous.fingerprint !== fingerprint) {
      return rejected(document, {
        path: "/transaction/transaction_id",
        message: `transaction id was already used with different input: ${transaction.transaction_id}`,
        keyword: "transactionIdCollision",
      });
    }

    const result = applyGenerativeUiTransaction(document, transaction, {
      transaction_already_applied: Boolean(previous),
      validate_kind: this.#validateKind,
    });
    if (result.status === "applied") {
      if (!previous && (documentTransactions?.size ?? 0) >= MAX_TRANSACTIONS_PER_DOCUMENT) {
        return rejected(document, {
          path: "/transaction/transaction_id",
          message: `in-memory transaction limit reached for document: ${transaction.document_id}`,
          keyword: "transactionLimit",
        });
      }
      this.#documents.set(transaction.document_id, structuredClone(result.document));
      const nextTransactions = documentTransactions ?? new Map<string, AppliedTransactionRecord>();
      nextTransactions.set(transaction.transaction_id, { fingerprint });
      this.#appliedTransactions.set(transaction.document_id, nextTransactions);
    }
    return structuredClone(result);
  }

  delete(documentId: string, expectedScope: GenerativeUiDocumentScopeV1): boolean {
    const document = this.#documents.get(documentId);
    if (!document) return false;
    if (!sameScope(document.scope, expectedScope)) {
      throw new Error(`Generative UI document scope mismatch: ${documentId}`);
    }
    this.#documents.delete(documentId);
    this.#appliedTransactions.delete(documentId);
    this.#purposes.delete(documentId);
    this.#deletedDocumentIds.add(documentId);
    return true;
  }

  /**
   * Releases an ephemeral shadow document without a tombstone. Callers must
   * guarantee that a new incarnation uses a different document id.
   */
  evictEphemeral(documentId: string, expectedScope: GenerativeUiDocumentScopeV1): boolean {
    const document = this.#documents.get(documentId);
    if (!document) return false;
    if (!sameScope(document.scope, expectedScope)) {
      throw new Error(`Generative UI document scope mismatch: ${documentId}`);
    }
    this.#documents.delete(documentId);
    this.#appliedTransactions.delete(documentId);
    this.#purposes.delete(documentId);
    return true;
  }

  close(documentId: string, expectedScope: GenerativeUiDocumentScopeV1): boolean {
    return this.evictEphemeral(documentId, expectedScope);
  }

  clear(): void {
    this.#documents.clear();
    this.#appliedTransactions.clear();
    this.#deletedDocumentIds.clear();
    this.#purposes.clear();
  }
}
