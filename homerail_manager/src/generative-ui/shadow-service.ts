import * as crypto from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import {
  GENERATIVE_UI_IR_VERSION,
  GENERATIVE_UI_MAX_NODE_CONTENT_BYTES,
  GenerativeUiActorType,
  GenerativeUiShadowReferenceKind,
  compareGenerativeUiShadowDocuments,
  analyzeGenerativeUiJsonValue,
  isValidGenerativeUiTimestamp,
  validateGenerativeUiDocument,
  type GenerativeUiDocumentScopeV1,
  type GenerativeUiDocumentV1,
  type GenerativeUiKindValidatorV1,
  type GenerativeUiNodeV1,
  type GenerativeUiOperationV1,
  type GenerativeUiShadowEvidenceReportV1,
  type GenerativeUiStoredNodeV1,
  type GenerativeUiTransactionStatus,
  type GenerativeUiTransactionV1,
  type GenerativeUiValidationError,
} from "homerail-protocol";
import {
  InMemoryGenerativeUiDocumentService,
  type GenerativeUiDocumentStore,
} from "./document-service.js";
import { PersistentGenerativeUiDocumentService } from "./persistent-document-service.js";
import {
  compileLegacyWidgetToGenerativeUiNode,
  type LegacyVoiceWidget,
  type LegacyWidgetSemanticProjector,
} from "./legacy-widget-compiler.js";
import { getGenerativeUiKindRegistry } from "./kind-registry.js";

const LEGACY_SHADOW_KINDS = new Set([
  "com.homerail.core/task_summary",
  "com.homerail.core/notice",
  "com.homerail.core/checklist",
  "com.homerail.core/execution_progress",
  "com.homerail.core/execution_graph",
  "com.homerail.core/timeline",
  "com.homerail.core/metric_set",
  "com.homerail.core/artifact",
  "com.homerail.core/confirmation",
  "com.homerail.content/topic_outline",
  "com.homerail.content/xiaohongshu_note",
  "com.homerail.presentation/slide_deck",
  "com.homerail.legacy/rich_content",
  "com.homerail.legacy/widget",
]);
// One changed Widget can require one remove plus one put. Keep the snapshot
// ceiling at half the Protocol transaction-operation limit so every supported
// snapshot transition remains one atomic transaction.
const MAX_LEGACY_SHADOW_WIDGETS = 16;
export const DEFAULT_MAX_ACTIVE_SHADOW_DOCUMENTS = 256 as const;

export type GenerativeUiShadowTransactionStatus = "noop" | "error" | GenerativeUiTransactionStatus;

interface GenerativeUiShadowSnapshotBaseV1 {
  snapshot_version: 1;
  purpose: "legacy_widget_shadow";
  authoritative: false;
  side_effect_free: true;
  session_id: string;
  document_id: string;
  checked_at: string;
  legacy_widget_count: number;
  document_revision: number;
  matched: boolean;
}

export interface GenerativeUiShadowSuccessSnapshotV1 extends GenerativeUiShadowSnapshotBaseV1 {
  status: "ok";
  transaction_status: GenerativeUiShadowTransactionStatus;
  expected_report: GenerativeUiShadowEvidenceReportV1;
  repeat_report: GenerativeUiShadowEvidenceReportV1;
  errors?: GenerativeUiValidationError[];
}

export interface GenerativeUiShadowFailureSnapshotV1 extends GenerativeUiShadowSnapshotBaseV1 {
  status: "error";
  transaction_status: "error";
  matched: false;
  error_code: string;
  error_hash: string;
}

export type GenerativeUiShadowSnapshotV1 =
  | GenerativeUiShadowSuccessSnapshotV1
  | GenerativeUiShadowFailureSnapshotV1;

export interface ReconcileLegacyWidgetShadowInput {
  sessionId: string;
  widgets: readonly LegacyVoiceWidget[];
  /** Trusted semantic projections accepted by Manager, keyed by the same UI id. */
  nodes?: readonly GenerativeUiNodeV1[];
  checkedAt: string;
}

function scopeFor(sessionId: string): GenerativeUiDocumentScopeV1 {
  return { type: "voice_session", id: sessionId };
}

export function legacyShadowDocumentId(sessionId: string, generation: string | number = 0): string {
  const digest = crypto.createHash("sha256").update(`${sessionId}:${generation}`).digest("hex").slice(0, 24);
  return `legacy-shadow-${digest}`;
}

function transactionId(documentId: string, nextRevision: number): string {
  const digest = crypto.createHash("sha256").update(documentId).digest("hex").slice(0, 20);
  return `legacy-shadow-${digest}-${nextRevision}`;
}

function shadowInputFingerprint(
  widgets: readonly LegacyVoiceWidget[],
  nodes: readonly GenerativeUiNodeV1[],
): string {
  if (widgets.length > MAX_LEGACY_SHADOW_WIDGETS) {
    throw new Error(`legacy shadow supports at most ${MAX_LEGACY_SHADOW_WIDGETS} widgets per snapshot`);
  }
  const hash = crypto.createHash("sha256");
  widgets.forEach((widget, index) => {
    hash.update(`widget:${index};`);
    const analysis = analyzeGenerativeUiJsonValue(widget, {
      path: `/widgets/${index}`,
      limits: { max_bytes: GENERATIVE_UI_MAX_NODE_CONTENT_BYTES },
      on_token: (value) => hash.update(value),
    });
    if (!analysis.valid) {
      throw new Error(`legacy widget shadow preflight failed: ${analysis.error?.keyword || "jsonValue"}`);
    }
  });
  if (nodes.length > MAX_LEGACY_SHADOW_WIDGETS) {
    throw new Error(`legacy shadow supports at most ${MAX_LEGACY_SHADOW_WIDGETS} semantic nodes per snapshot`);
  }
  nodes.forEach((node, index) => {
    hash.update(`node:${index};`);
    const analysis = analyzeGenerativeUiJsonValue(node, {
      path: `/nodes/${index}`,
      limits: { max_bytes: GENERATIVE_UI_MAX_NODE_CONTENT_BYTES },
      on_token: (value) => hash.update(value),
    });
    if (!analysis.valid) throw new Error(`semantic shadow preflight failed: ${analysis.error?.keyword || "jsonValue"}`);
  });
  return hash.digest("hex");
}

function storedSemantics(node: GenerativeUiStoredNodeV1): GenerativeUiNodeV1 {
  const { revision: _revision, updated_at: _updatedAt, ...semantic } = node;
  return semantic;
}

function legacyWidgetFromNode(node: GenerativeUiStoredNodeV1): LegacyVoiceWidget | null {
  const keys = Object.keys(node.content);
  if (keys.length !== 1 || keys[0] !== "legacy_widget") return null;
  const value = node.content.legacy_widget;
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as LegacyVoiceWidget
    : null;
}

export const validateLegacyShadowKind: GenerativeUiKindValidatorV1 = (node) => {
  if (!LEGACY_SHADOW_KINDS.has(node.kind)) {
    return [{ path: "/kind", message: `kind is not registered for legacy shadow: ${node.kind}`, keyword: "kindRegistry" }];
  }
  const widget = legacyWidgetFromNode(node);
  if (!widget) {
    return [{
      path: "/content",
      message: "legacy shadow content must contain only one legacy_widget object",
      keyword: "legacyWidgetProjection",
    }];
  }
  if (widget.id !== node.id) {
    return [{
      path: "/content/legacy_widget/id",
      message: "legacy widget id must match the semantic node id",
      keyword: "legacyWidgetProjection",
    }];
  }
  try {
    const expected = compileLegacyWidgetToGenerativeUiNode(widget);
    if (!isDeepStrictEqual(storedSemantics(node), expected)) {
      return [{
        path: "/content/legacy_widget",
        message: "semantic node does not match the registered legacy widget projection",
        keyword: "legacyWidgetProjection",
      }];
    }
  } catch (cause) {
    return [{
      path: "/content/legacy_widget",
      message: cause instanceof Error ? cause.message : String(cause),
      keyword: "legacyWidgetProjection",
    }];
  }
  return [];
};

function targetNodes(
  widgets: readonly LegacyVoiceWidget[],
  semanticNodes: readonly GenerativeUiNodeV1[] = [],
  projector?: LegacyWidgetSemanticProjector,
): GenerativeUiNodeV1[] {
  const seen = new Set<string>();
  const semanticById = new Map<string, GenerativeUiNodeV1>();
  for (const node of semanticNodes) {
    if (semanticById.has(node.id)) throw new Error(`duplicate semantic node id: ${node.id}`);
    semanticById.set(node.id, structuredClone(node));
  }
  const result = widgets.map((widget) => {
    const node = semanticById.get(widget.id) ?? compileLegacyWidgetToGenerativeUiNode(widget, projector);
    if (seen.has(node.id)) throw new Error(`duplicate legacy widget id: ${node.id}`);
    seen.add(node.id);
    semanticById.delete(node.id);
    return node;
  });
  for (const node of semanticById.values()) {
    if (seen.has(node.id)) throw new Error(`duplicate semantic node id: ${node.id}`);
    seen.add(node.id);
    result.push(node);
  }
  if (result.length > MAX_LEGACY_SHADOW_WIDGETS) {
    throw new Error(`legacy shadow supports at most ${MAX_LEGACY_SHADOW_WIDGETS} projected nodes per snapshot`);
  }
  return result;
}

function referenceDocument(
  current: GenerativeUiDocumentV1,
  nodes: readonly GenerativeUiNodeV1[],
  checkedAt: string,
  validateKind: GenerativeUiKindValidatorV1 = validateLegacyShadowKind,
): GenerativeUiDocumentV1 {
  const reference: GenerativeUiDocumentV1 = {
    ir_version: GENERATIVE_UI_IR_VERSION,
    document_id: current.document_id,
    scope: structuredClone(current.scope),
    revision: current.revision,
    nodes: nodes.map((node) => ({
      ...structuredClone(node),
      revision: 1,
      updated_at: checkedAt,
    })),
    updated_at: checkedAt,
  };
  const validation = validateGenerativeUiDocument(reference);
  if (!validation.valid) {
    throw new Error(`invalid legacy shadow reference: ${JSON.stringify(validation.errors)}`);
  }
  for (const node of reference.nodes) {
    const errors = validateKind(node);
    if (errors.length) throw new Error(`invalid legacy shadow kind: ${JSON.stringify(errors)}`);
  }
  return reference;
}

/**
 * Non-authoritative M1 shadow pipeline. It consumes an already-produced legacy
 * Widget snapshot and never invokes an Agent, Tool, Action, renderer, or file.
 */
export class GenerativeUiShadowService {
  readonly #documents: GenerativeUiDocumentStore;
  readonly #documentIdFactory: (sessionId: string, generation: number) => string;
  readonly #snapshots = new Map<string, GenerativeUiShadowSnapshotV1>();
  readonly #successfulFingerprints = new Map<string, string>();
  readonly #documentIds = new Map<string, string>();
  readonly #lastAccess = new Map<string, number>();
  readonly #maxActiveDocuments: number;
  readonly #projectWidget?: LegacyWidgetSemanticProjector;
  readonly #validateKind: GenerativeUiKindValidatorV1;
  #accessCounter = 0;
  #generationCounter = 0;

  constructor(
    maxActiveDocuments = DEFAULT_MAX_ACTIVE_SHADOW_DOCUMENTS,
    documents?: GenerativeUiDocumentStore,
    documentIdFactory: (sessionId: string, generation: number) => string = legacyShadowDocumentId,
    projectWidget?: LegacyWidgetSemanticProjector,
    validateKind: GenerativeUiKindValidatorV1 = validateLegacyShadowKind,
  ) {
    if (!Number.isSafeInteger(maxActiveDocuments) || maxActiveDocuments < 1 || maxActiveDocuments > 512) {
      throw new Error("maxActiveDocuments must be an integer between 1 and 512");
    }
    this.#maxActiveDocuments = maxActiveDocuments;
    this.#documents = documents ?? new InMemoryGenerativeUiDocumentService(validateKind);
    this.#documentIdFactory = documentIdFactory;
    this.#projectWidget = projectWidget;
    this.#validateKind = validateKind;
  }

  #touch(sessionId: string): void {
    this.#accessCounter += 1;
    this.#lastAccess.set(sessionId, this.#accessCounter);
  }

  #pruneStandaloneEvidence(): void {
    const maxSnapshots = this.#maxActiveDocuments * 2;
    while (this.#snapshots.size > maxSnapshots) {
      const oldest = [...this.#snapshots.keys()]
        .filter((sessionId) => !this.#documentIds.has(sessionId))
        .map((sessionId) => [sessionId, this.#lastAccess.get(sessionId) ?? 0] as const)
        .sort((left, right) => left[1] - right[1] || left[0].localeCompare(right[0]))[0]?.[0];
      if (!oldest) return;
      this.#snapshots.delete(oldest);
      this.#successfulFingerprints.delete(oldest);
      this.#lastAccess.delete(oldest);
    }
  }

  #evictLeastRecentlyUsed(): void {
    if (this.#documentIds.size < this.#maxActiveDocuments) return;
    const oldest = [...this.#documentIds.keys()]
      .map((sessionId) => [sessionId, this.#lastAccess.get(sessionId) ?? 0] as const)
      .sort((left, right) => left[1] - right[1] || left[0].localeCompare(right[0]))[0]?.[0];
    if (!oldest) throw new Error("shadow document retention state is inconsistent");
    const documentId = this.#documentIds.get(oldest);
    if (documentId) this.#documents.evictEphemeral(documentId, scopeFor(oldest));
    this.#documentIds.delete(oldest);
    this.#snapshots.delete(oldest);
    this.#successfulFingerprints.delete(oldest);
    this.#lastAccess.delete(oldest);
  }

  #allocateDocumentId(sessionId: string): string {
    const existing = this.#documentIds.get(sessionId);
    if (existing) return existing;
    this.#evictLeastRecentlyUsed();
    this.#generationCounter += 1;
    const documentId = this.#documentIdFactory(sessionId, this.#generationCounter);
    this.#documentIds.set(sessionId, documentId);
    return documentId;
  }

  #restoreActiveDocumentId(sessionId: string): string | undefined {
    const mapped = this.#documentIds.get(sessionId);
    if (mapped) return mapped;
    const active = this.#documents.findActiveForScope(scopeFor(sessionId), "legacy_widget_shadow");
    if (!active) return undefined;
    this.#evictLeastRecentlyUsed();
    this.#documentIds.set(sessionId, active.document_id);
    this.#touch(sessionId);
    return active.document_id;
  }

  reconcile(input: ReconcileLegacyWidgetShadowInput): GenerativeUiShadowSnapshotV1 | null {
    const scope = scopeFor(input.sessionId);
    const allocatedDocumentId = this.#restoreActiveDocumentId(input.sessionId);
    const semanticNodes = input.nodes ?? [];
    if (!allocatedDocumentId && input.widgets.length === 0 && semanticNodes.length === 0) {
      this.#snapshots.delete(input.sessionId);
      this.#successfulFingerprints.delete(input.sessionId);
      this.#lastAccess.delete(input.sessionId);
      return null;
    }
    if (
      allocatedDocumentId
      && !this.#documents.get(allocatedDocumentId, scope)
      && input.widgets.length === 0
      && semanticNodes.length === 0
    ) {
      this.#snapshots.delete(input.sessionId);
      this.#successfulFingerprints.delete(input.sessionId);
      this.#lastAccess.delete(input.sessionId);
      return null;
    }
    if (allocatedDocumentId) this.#touch(input.sessionId);
    try {
      if (!isValidGenerativeUiTimestamp(input.checkedAt)) {
        throw new Error("legacy shadow checkedAt must be a valid RFC 3339 timestamp");
      }
      const fingerprint = shadowInputFingerprint(input.widgets, semanticNodes);
      if (!allocatedDocumentId) this.#touch(input.sessionId);
      const previous = this.#snapshots.get(input.sessionId);
      if (previous && this.#successfulFingerprints.get(input.sessionId) === fingerprint && previous.status === "ok") {
        const unchanged: GenerativeUiShadowSuccessSnapshotV1 = {
          ...structuredClone(previous),
          checked_at: input.checkedAt,
          transaction_status: "noop",
        };
        this.#snapshots.set(input.sessionId, structuredClone(unchanged));
        return unchanged;
      }
      const snapshot = this.#reconcile(input);
      if (snapshot?.status === "ok" && snapshot.matched) {
        this.#successfulFingerprints.set(input.sessionId, fingerprint);
      } else {
        this.#successfulFingerprints.delete(input.sessionId);
      }
      return snapshot;
    } catch (cause) {
      this.#successfulFingerprints.delete(input.sessionId);
      return this.recordFailure(input, cause);
    }
  }

  #reconcile(input: ReconcileLegacyWidgetShadowInput): GenerativeUiShadowSnapshotV1 | null {
    const scope = scopeFor(input.sessionId);
    const documentId = this.#allocateDocumentId(input.sessionId);
    const existing = this.#documents.get(documentId, scope);
    if (!existing && input.widgets.length === 0 && (input.nodes?.length ?? 0) === 0) return null;
    const current = existing ?? this.#documents.createOrGet({
      documentId,
      scope,
      createdAt: input.checkedAt,
      purpose: "legacy_widget_shadow",
    });
    const expectedNodes = targetNodes(input.widgets, input.nodes, this.#projectWidget);
    const expected = referenceDocument(current, expectedNodes, input.checkedAt, this.#validateKind);
    const repeated = referenceDocument(
      current,
      targetNodes(structuredClone(input.widgets), structuredClone(input.nodes ?? []), this.#projectWidget),
      input.checkedAt,
      this.#validateKind,
    );
    const repeatReport = compareGenerativeUiShadowDocuments({
      derived: repeated,
      reference: expected,
      reference_kind: GenerativeUiShadowReferenceKind.REPEAT,
    });

    const currentById = new Map(current.nodes.map((node) => [node.id, node]));
    const expectedById = new Map(expectedNodes.map((node) => [node.id, node]));
    const changedNodes = expectedNodes.filter((target) => {
      const stored = currentById.get(target.id);
      return !stored || !isDeepStrictEqual(storedSemantics(stored), target);
    });
    const identityChanges = changedNodes.filter((target) => {
      const stored = currentById.get(target.id);
      return stored && (stored.kind !== target.kind || stored.owner.id !== target.owner.id);
    });
    const operations: GenerativeUiOperationV1[] = [
      ...identityChanges.map((target): GenerativeUiOperationV1 => ({
        op: "remove",
        node_id: target.id,
        if_revision: currentById.get(target.id)!.revision,
      })),
      ...changedNodes.map((node): GenerativeUiOperationV1 => ({ op: "put", node })),
      ...current.nodes
        .filter((node) => !expectedById.has(node.id))
        .map((node): GenerativeUiOperationV1 => ({
          op: "remove",
          node_id: node.id,
          if_revision: node.revision,
        })),
    ];
    const transaction: GenerativeUiTransactionV1 | null = operations.length ? {
      ir_version: GENERATIVE_UI_IR_VERSION,
      transaction_id: transactionId(documentId, current.revision + 1),
      document_id: documentId,
      base_revision: current.revision,
      actor: { type: GenerativeUiActorType.SYSTEM, id: "legacy-widget-shadow" },
      operations,
      created_at: input.checkedAt,
    } : null;
    const result = transaction ? this.#documents.apply(transaction, scope) : null;
    const derived = result?.document ?? current;
    const expectedReport = compareGenerativeUiShadowDocuments({
      derived,
      reference: expected,
      reference_kind: GenerativeUiShadowReferenceKind.EXPECTED,
    });
    const transactionStatus: GenerativeUiShadowTransactionStatus = result?.status ?? "noop";
    const transactionSucceeded = transactionStatus === "noop" || transactionStatus === "applied" || transactionStatus === "duplicate";
    const snapshot: GenerativeUiShadowSnapshotV1 = {
      snapshot_version: 1,
      purpose: "legacy_widget_shadow",
      authoritative: false,
      side_effect_free: true,
      status: "ok",
      session_id: input.sessionId,
      document_id: documentId,
      checked_at: input.checkedAt,
      legacy_widget_count: input.widgets.length,
      document_revision: derived.revision,
      transaction_status: transactionStatus,
      matched: transactionSucceeded && expectedReport.matched && repeatReport.matched,
      expected_report: expectedReport,
      repeat_report: repeatReport,
      ...(result?.errors?.length ? { errors: structuredClone(result.errors) } : {}),
    };
    this.#snapshots.set(input.sessionId, structuredClone(snapshot));
    return structuredClone(snapshot);
  }

  recordFailure(
    input: ReconcileLegacyWidgetShadowInput,
    cause: unknown,
  ): GenerativeUiShadowFailureSnapshotV1 {
    this.#touch(input.sessionId);
    const message = cause instanceof Error ? `${cause.name}:${cause.message}` : String(cause);
    const documentId = this.#documentIds.get(input.sessionId)
      ?? this.#documentIdFactory(input.sessionId, this.#generationCounter + 1);
    const document = this.#documentIds.has(input.sessionId)
      ? this.#documents.get(documentId, scopeFor(input.sessionId))
      : undefined;
    const snapshot: GenerativeUiShadowFailureSnapshotV1 = {
      snapshot_version: 1,
      purpose: "legacy_widget_shadow",
      authoritative: false,
      side_effect_free: true,
      status: "error",
      session_id: input.sessionId,
      document_id: documentId,
      checked_at: input.checkedAt,
      legacy_widget_count: input.widgets.length,
      document_revision: document?.revision ?? 0,
      transaction_status: "error",
      matched: false,
      error_code: cause instanceof Error && cause.name ? cause.name : "shadow_reconcile_error",
      error_hash: crypto.createHash("sha256").update(message).digest("hex").slice(0, 24),
    };
    this.#snapshots.set(input.sessionId, structuredClone(snapshot));
    this.#pruneStandaloneEvidence();
    return structuredClone(snapshot);
  }

  getSnapshot(sessionId: string): GenerativeUiShadowSnapshotV1 | undefined {
    const snapshot = this.#snapshots.get(sessionId);
    return snapshot ? structuredClone(snapshot) : undefined;
  }

  getDocument(sessionId: string): GenerativeUiDocumentV1 | undefined {
    const documentId = this.#restoreActiveDocumentId(sessionId);
    return documentId ? this.#documents.get(documentId, scopeFor(sessionId)) : undefined;
  }

  deleteSession(sessionId: string): boolean {
    const scope = scopeFor(sessionId);
    const documentId = this.#documentIds.get(sessionId)
      ?? this.#documents.findActiveForScope(scope, "legacy_widget_shadow")?.document_id;
    this.#snapshots.delete(sessionId);
    this.#successfulFingerprints.delete(sessionId);
    this.#lastAccess.delete(sessionId);
    this.#documentIds.delete(sessionId);
    return documentId ? this.#documents.close(documentId, scope) : false;
  }

  clear(): void {
    this.#snapshots.clear();
    this.#successfulFingerprints.clear();
    this.#documentIds.clear();
    this.#lastAccess.clear();
    this.#accessCounter = 0;
    this.#generationCounter = 0;
    this.#documents.clear();
  }
}

const validatePluginAwareShadowKind: GenerativeUiKindValidatorV1 = (node) => (
  Object.keys(node.content).length === 1 && node.content.legacy_widget
    ? validateLegacyShadowKind(node)
    : getGenerativeUiKindRegistry().validateHistoricalNode(node)
);

export const persistentGenerativeUiDocumentService = new PersistentGenerativeUiDocumentService(
  validatePluginAwareShadowKind,
);
export const generativeUiShadowService = new GenerativeUiShadowService(
  DEFAULT_MAX_ACTIVE_SHADOW_DOCUMENTS,
  persistentGenerativeUiDocumentService,
  (sessionId) => legacyShadowDocumentId(sessionId, crypto.randomUUID()),
  undefined,
  validatePluginAwareShadowKind,
);

export function _clearGenerativeUiShadowForTest(): void {
  generativeUiShadowService.clear();
}
