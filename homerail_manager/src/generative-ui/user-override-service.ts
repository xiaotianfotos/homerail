import {
  validateGenerativeUiUserOverride,
  type GenerativeUiDocumentScopeV1,
  type GenerativeUiSurface,
  type GenerativeUiUserOverrideV1,
  type GenerativeUiVisibility,
} from "homerail-protocol";
import { getDb } from "../persistence/db.js";
import { nowIso } from "../persistence/time.js";
import { PersistentGenerativeUiDocumentService } from "./persistent-document-service.js";
import { persistentGenerativeUiDocumentService } from "./shadow-service.js";

interface OverrideRow {
  document_id: string;
  node_id: string;
  visibility: GenerativeUiVisibility | null;
  pinned: number | null;
  preferred_surface: GenerativeUiSurface | null;
  updated_at: string;
}

export interface PutGenerativeUiUserOverrideInput {
  documentId: string;
  nodeId: string;
  visibility?: GenerativeUiVisibility;
  pinned?: boolean;
  preferredSurface?: GenerativeUiSurface;
  /** Test/replay hook. Production callers leave this unset so Manager stamps it. */
  updatedAt?: string;
}

function decodeOverride(row: OverrideRow): GenerativeUiUserOverrideV1 {
  if (row.pinned !== null && row.pinned !== 0 && row.pinned !== 1) {
    throw new Error(`Invalid persisted Generative UI user override: ${row.document_id}:${row.node_id}`);
  }
  const override: GenerativeUiUserOverrideV1 = {
    document_id: row.document_id,
    node_id: row.node_id,
    ...(row.visibility === null ? {} : { visibility: row.visibility }),
    ...(row.pinned === null ? {} : { pinned: row.pinned === 1 }),
    ...(row.preferred_surface === null ? {} : { preferred_surface: row.preferred_surface }),
    updated_at: row.updated_at,
  };
  const validation = validateGenerativeUiUserOverride(override);
  if (!validation.valid) {
    throw new Error(`Invalid persisted Generative UI user override: ${row.document_id}:${row.node_id}`);
  }
  return validation.value ?? override;
}

/** Scope-bound, durable user preferences kept separate from Agent-authored Nodes. */
export class GenerativeUiUserOverrideService {
  readonly #documents: PersistentGenerativeUiDocumentService;

  constructor(documents: PersistentGenerativeUiDocumentService) {
    this.#documents = documents;
  }

  list(
    documentId: string,
    expectedScope: GenerativeUiDocumentScopeV1,
    includeDeletedDocument = true,
  ): GenerativeUiUserOverrideV1[] {
    const document = includeDeletedDocument
      ? this.#documents.getIncludingDeleted(documentId, expectedScope)
      : this.#documents.get(documentId, expectedScope);
    if (!document) throw new Error(`Generative UI document not found: ${documentId}`);
    const rows = getDb().prepare(`
      SELECT document_id, node_id, visibility, pinned, preferred_surface, updated_at
      FROM generative_ui_user_overrides
      WHERE document_id = ?
      ORDER BY node_id ASC
    `).all(documentId) as OverrideRow[];
    return rows.map((row) => structuredClone(decodeOverride(row)));
  }

  put(
    input: PutGenerativeUiUserOverrideInput,
    expectedScope: GenerativeUiDocumentScopeV1,
  ): GenerativeUiUserOverrideV1 {
    const document = this.#documents.get(input.documentId, expectedScope);
    if (!document) throw new Error(`Active Generative UI document not found: ${input.documentId}`);
    if (!document.nodes.some((node) => node.id === input.nodeId)) {
      throw new Error(`Generative UI node not found: ${input.nodeId}`);
    }
    const override: GenerativeUiUserOverrideV1 = {
      document_id: input.documentId,
      node_id: input.nodeId,
      ...(input.visibility === undefined ? {} : { visibility: input.visibility }),
      ...(input.pinned === undefined ? {} : { pinned: input.pinned }),
      ...(input.preferredSurface === undefined ? {} : { preferred_surface: input.preferredSurface }),
      updated_at: input.updatedAt ?? nowIso(),
    };
    const validation = validateGenerativeUiUserOverride(override);
    if (!validation.valid) {
      throw new Error(`Invalid Generative UI user override: ${JSON.stringify(validation.errors)}`);
    }
    const stable = validation.value ?? override;
    getDb().prepare(`
      INSERT INTO generative_ui_user_overrides(
        document_id, node_id, visibility, pinned, preferred_surface, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(document_id, node_id) DO UPDATE SET
        visibility = excluded.visibility,
        pinned = excluded.pinned,
        preferred_surface = excluded.preferred_surface,
        updated_at = excluded.updated_at
    `).run(
      stable.document_id,
      stable.node_id,
      stable.visibility ?? null,
      stable.pinned === undefined ? null : stable.pinned ? 1 : 0,
      stable.preferred_surface ?? null,
      stable.updated_at,
    );
    return structuredClone(stable);
  }

  delete(
    documentId: string,
    nodeId: string,
    expectedScope: GenerativeUiDocumentScopeV1,
  ): boolean {
    const document = this.#documents.get(documentId, expectedScope);
    if (!document) throw new Error(`Active Generative UI document not found: ${documentId}`);
    return getDb().prepare(`
      DELETE FROM generative_ui_user_overrides WHERE document_id = ? AND node_id = ?
    `).run(documentId, nodeId).changes === 1;
  }
}

export const persistentGenerativeUiUserOverrideService = new GenerativeUiUserOverrideService(
  persistentGenerativeUiDocumentService,
);
