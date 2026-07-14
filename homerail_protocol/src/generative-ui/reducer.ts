/**
 * Pure atomic reducer for Generative UI documents.
 * @version 0.1.0
 */

import {
  validateGenerativeUiDocument,
  validateGenerativeUiStoredNode,
  validateGenerativeUiTransaction,
} from "./validation.js";
import {
  GENERATIVE_UI_IR_VERSION,
  type GenerativeUiDocumentScopeV1,
  type GenerativeUiDocumentV1,
  type GenerativeUiPatchUnsetField,
  type GenerativeUiReducerContextV1,
  type GenerativeUiStoredNodeV1,
  type GenerativeUiTransactionResultV1,
  type GenerativeUiTransactionV1,
  type GenerativeUiValidationError,
} from "./types.js";

function error(path: string, message: string, keyword: string): GenerativeUiValidationError {
  return { path, message, keyword };
}

function prefixErrors(
  prefix: string,
  errors: GenerativeUiValidationError[],
): GenerativeUiValidationError[] {
  return errors.map((item) => ({
    ...item,
    path: `${prefix}${item.path}`,
  }));
}

function result(
  status: GenerativeUiTransactionResultV1["status"],
  document: GenerativeUiDocumentV1,
  errors?: GenerativeUiValidationError[],
): GenerativeUiTransactionResultV1 {
  return {
    status,
    revision: document.revision,
    document,
    ...(errors?.length ? { errors } : {}),
  };
}

function duplicateNodeIdErrors(document: GenerativeUiDocumentV1): GenerativeUiValidationError[] {
  const seen = new Set<string>();
  const errors: GenerativeUiValidationError[] = [];
  document.nodes.forEach((node, index) => {
    if (seen.has(node.id)) {
      errors.push(error(`/nodes/${index}/id`, `duplicate node id: ${node.id}`, "uniqueNodeId"));
    }
    seen.add(node.id);
  });
  return errors;
}

function kindErrors(
  context: GenerativeUiReducerContextV1,
  node: GenerativeUiStoredNodeV1,
  path: string,
): GenerativeUiValidationError[] {
  try {
    // Registry callbacks are policy extensions, not owners of reducer state.
    // Always isolate them from both the canonical input and candidate output.
    return prefixErrors(path, context.validate_kind(structuredClone(node)));
  } catch (cause) {
    return [error(
      path,
      `kind validator failed: ${cause instanceof Error ? cause.message : String(cause)}`,
      "kindValidator",
    )];
  }
}

function unsetOptionalFields(
  node: GenerativeUiStoredNodeV1,
  fields: GenerativeUiPatchUnsetField[],
): void {
  for (const field of fields) {
    if (field === "status") delete node.status;
    if (field === "presentation") delete node.presentation;
    if (field === "lifecycle") delete node.lifecycle;
    if (field === "actions") delete node.actions;
    if (field === "provenance") delete node.provenance;
    if (field === "view") delete node.view;
    if (field === "a2ui") delete node.a2ui;
  }
}

export function createGenerativeUiDocument(input: {
  document_id: string;
  scope: GenerativeUiDocumentScopeV1;
  created_at: string;
}): GenerativeUiDocumentV1 {
  return {
    ir_version: GENERATIVE_UI_IR_VERSION,
    document_id: input.document_id,
    scope: structuredClone(input.scope),
    revision: 0,
    nodes: [],
    updated_at: input.created_at,
  };
}

/**
 * Applies a transaction without mutating either input.
 *
 * The reducer validates the complete transaction and every resulting node
 * before returning an applied document. Any failed operation returns the
 * original document unchanged.
 */
export function applyGenerativeUiTransaction(
  document: GenerativeUiDocumentV1,
  transaction: GenerativeUiTransactionV1,
  context: GenerativeUiReducerContextV1,
): GenerativeUiTransactionResultV1 {
  if (!context || typeof context.validate_kind !== "function") {
    return result("rejected", document, [
      error("/context/validate_kind", "a kind registry validator is required", "required"),
    ]);
  }
  const documentValidation = validateGenerativeUiDocument(document);
  if (!documentValidation.valid) {
    return result("rejected", document, prefixErrors("/document", documentValidation.errors));
  }

  const duplicateErrors = duplicateNodeIdErrors(document);
  if (duplicateErrors.length) return result("rejected", document, duplicateErrors);

  const transactionValidation = validateGenerativeUiTransaction(transaction);
  if (!transactionValidation.valid) {
    return result("rejected", document, prefixErrors("/transaction", transactionValidation.errors));
  }

  if (transaction.document_id !== document.document_id) {
    return result("rejected", document, [
      error(
        "/transaction/document_id",
        `expected ${document.document_id}, received ${transaction.document_id}`,
        "documentId",
      ),
    ]);
  }

  if (context.transaction_already_applied) {
    return result("duplicate", document);
  }

  // Exact replays are resolved above by the idempotency authority. Only new
  // transactions are subject to the registry's current enablement policy;
  // disabling a plugin must not rewrite an already-applied result.
  const existingKindErrors = document.nodes.flatMap((node, index) =>
    kindErrors(context, node, `/document/nodes/${index}/content`)
  );
  if (existingKindErrors.length) return result("rejected", document, existingKindErrors);

  if (transaction.base_revision !== document.revision) {
    return result("conflict", document, [
      error(
        "/transaction/base_revision",
        `expected ${document.revision}, received ${transaction.base_revision}`,
        "revisionConflict",
      ),
    ]);
  }

  const next = structuredClone(document);

  for (let index = 0; index < transaction.operations.length; index += 1) {
    const operation = transaction.operations[index];
    const operationPath = `/transaction/operations/${index}`;

    if (operation.op === "put") {
      const existingIndex = next.nodes.findIndex((node) => node.id === operation.node.id);
      const existing = existingIndex >= 0 ? next.nodes[existingIndex] : undefined;
      if (existing && (existing.kind !== operation.node.kind || existing.owner.id !== operation.node.owner.id)) {
        return result("rejected", document, [
          error(
            `${operationPath}/node/id`,
            "put cannot change the kind or owner of an existing node id",
            "immutableIdentity",
          ),
        ]);
      }

      const storedNode: GenerativeUiStoredNodeV1 = {
        ...structuredClone(operation.node),
        revision: (existing?.revision ?? 0) + 1,
        updated_at: transaction.created_at,
      };
      const validation = validateGenerativeUiStoredNode(storedNode);
      if (!validation.valid) {
        return result("rejected", document, prefixErrors(`${operationPath}/node`, validation.errors));
      }
      const storedKindErrors = kindErrors(context, storedNode, `${operationPath}/node/content`);
      if (storedKindErrors.length) return result("rejected", document, storedKindErrors);
      if (existingIndex >= 0) next.nodes[existingIndex] = storedNode;
      else next.nodes.push(storedNode);
      continue;
    }

    const nodeIndex = next.nodes.findIndex((node) => node.id === operation.node_id);
    if (nodeIndex < 0) {
      return result("rejected", document, [
        error(`${operationPath}/node_id`, `node not found: ${operation.node_id}`, "nodeNotFound"),
      ]);
    }
    const current = next.nodes[nodeIndex];
    if (operation.if_revision !== undefined && operation.if_revision !== current.revision) {
      return result("conflict", document, [
        error(
          `${operationPath}/if_revision`,
          `expected node revision ${current.revision}, received ${operation.if_revision}`,
          "revisionConflict",
        ),
      ]);
    }

    if (operation.op === "remove") {
      next.nodes.splice(nodeIndex, 1);
      continue;
    }

    const { unset = [], ...changes } = structuredClone(operation.changes);
    const patchedNode: GenerativeUiStoredNodeV1 = {
      ...current,
      ...changes,
      revision: current.revision + 1,
      updated_at: transaction.created_at,
    };
    unsetOptionalFields(patchedNode, unset);
    const validation = validateGenerativeUiStoredNode(patchedNode);
    if (!validation.valid) {
      return result("rejected", document, prefixErrors(`${operationPath}/changes`, validation.errors));
    }
    const patchedKindErrors = kindErrors(context, patchedNode, `${operationPath}/changes/content`);
    if (patchedKindErrors.length) return result("rejected", document, patchedKindErrors);
    next.nodes[nodeIndex] = patchedNode;
  }

  next.revision += 1;
  next.updated_at = transaction.created_at;

  const finalValidation = validateGenerativeUiDocument(next);
  if (!finalValidation.valid) {
    return result("rejected", document, prefixErrors("/document", finalValidation.errors));
  }
  return result("applied", next);
}
