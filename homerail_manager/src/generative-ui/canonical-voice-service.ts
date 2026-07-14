import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  GENERATIVE_UI_IR_VERSION,
  GenerativeUiActorType,
  type GenerativeUiDocumentScopeV1,
  type GenerativeUiDocumentV1,
  type GenerativeUiNodeV1,
  type GenerativeUiStoredNodeV1,
  type GenerativeUiTransactionV1,
} from "homerail-protocol";
import { persistentGenerativeUiDocumentService } from "./shadow-service.js";

const MAX_CANONICAL_PATCH_NODES = 16;

export interface VoiceCanonicalProjectionPatch {
  /** Exact canonical head observed when the Tool projection was accepted. */
  base_revision: number;
  upsert: GenerativeUiNodeV1[];
  remove_ids: string[];
}

export class VoiceCanonicalProjectionConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VoiceCanonicalProjectionConflictError";
  }
}

function scopeFor(sessionId: string): GenerativeUiDocumentScopeV1 {
  return { type: "voice_session", id: sessionId };
}

export function voiceCanonicalDocumentId(sessionId: string): string {
  const digest = createHash("sha256").update(sessionId).digest("hex").slice(0, 24);
  return `voice-canonical-${digest}`;
}

function unstored(node: GenerativeUiStoredNodeV1): GenerativeUiNodeV1 {
  const { revision: _revision, updated_at: _updatedAt, ...semantic } = node;
  return semantic;
}

function transactionId(documentId: string, revision: number): string {
  return `${documentId}-${revision}`;
}

/**
 * Apply only the semantic plugin-node delta accepted in the current Voice
 * turn. The persisted legacy workspace remains available for `prefer`
 * fallback, but is never replayed over a newer Action-authored revision.
 */
export function applyVoiceCanonicalProjectionPatch(input: {
  session_id: string;
  patch: VoiceCanonicalProjectionPatch;
  created_at: string;
}): GenerativeUiDocumentV1 | null {
  if (!Number.isSafeInteger(input.patch.base_revision) || input.patch.base_revision < 0) {
    throw new Error("Voice canonical projection base revision is invalid");
  }
  if (
    input.patch.upsert.length > MAX_CANONICAL_PATCH_NODES
    || input.patch.remove_ids.length > MAX_CANONICAL_PATCH_NODES
  ) throw new Error(`Voice canonical projection supports at most ${MAX_CANONICAL_PATCH_NODES} node changes`);

  const upserts = [...input.patch.upsert]
    .map((node) => structuredClone(node))
    .sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
  const removeIds = [...input.patch.remove_ids].sort();
  if (upserts.some((node, index) => index > 0 && node.id === upserts[index - 1].id)) {
    throw new Error("Voice canonical projection contains duplicate node ids");
  }
  if (removeIds.some((nodeId, index) => index > 0 && nodeId === removeIds[index - 1])) {
    throw new Error("Voice canonical projection contains duplicate removals");
  }

  const scope = scopeFor(input.session_id);
  let document = persistentGenerativeUiDocumentService.findActiveForScope(scope, "canonical");
  if (!document && input.patch.base_revision !== 0) {
    throw new VoiceCanonicalProjectionConflictError("Voice canonical projection head no longer exists");
  }
  if (document && document.revision !== input.patch.base_revision) {
    throw new VoiceCanonicalProjectionConflictError(
      `Voice canonical projection is stale: expected revision ${input.patch.base_revision}, current ${document.revision}`,
    );
  }
  if (!document && !upserts.length) return null;
  if (!document) {
    document = persistentGenerativeUiDocumentService.createOrGet({
      documentId: voiceCanonicalDocumentId(input.session_id),
      scope,
      createdAt: input.created_at,
      purpose: "canonical",
    });
  }

  const upsertIds = new Set(upserts.map((node) => node.id));
  const currentById = new Map(document.nodes.map((node) => [node.id, node]));
  const operations: GenerativeUiTransactionV1["operations"] = [];
  for (const nodeId of removeIds) {
    if (upsertIds.has(nodeId)) continue;
    const current = currentById.get(nodeId);
    if (current) operations.push({ op: "remove", node_id: nodeId, if_revision: current.revision });
  }
  for (const node of upserts) {
    const current = currentById.get(node.id);
    if (!current || !isDeepStrictEqual(unstored(current), node)) {
      operations.push({ op: "put", node });
    }
  }
  if (!operations.length) return document;

  const nextRevision = document.revision + 1;
  const result = persistentGenerativeUiDocumentService.apply({
    ir_version: GENERATIVE_UI_IR_VERSION,
    transaction_id: transactionId(document.document_id, nextRevision),
    document_id: document.document_id,
    base_revision: document.revision,
    actor: { type: GenerativeUiActorType.SYSTEM, id: "voice-plugin-canonical" },
    operations,
    created_at: input.created_at,
  }, scope);
  if (result.status !== "applied") {
    throw new Error(`Voice canonical projection was not applied: ${result.status}`);
  }
  return result.document;
}
