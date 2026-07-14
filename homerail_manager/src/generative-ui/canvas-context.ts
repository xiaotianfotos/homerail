import {
  GENERATIVE_UI_CANVAS_CONTEXT_MAX_BYTES,
  GENERATIVE_UI_CANVAS_CONTEXT_MAX_NODES,
  GENERATIVE_UI_CANVAS_CONTEXT_VERSION,
  type GenerativeUiCanvasContextNodeV1,
  type GenerativeUiCanvasContextV1,
  type GenerativeUiDocumentV1,
} from "homerail-protocol";

const MAX_CONTENT_DEPTH = 5;
const MAX_CONTENT_KEYS = 48;
const MAX_CONTENT_ITEMS = 16;
const MAX_CONTENT_STRING = 2_000;
const MAX_NODE_BYTES = 16 * 1024;

function jsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function boundedJson(value: unknown, depth = 0): unknown {
  if (value === null || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") return value.slice(0, MAX_CONTENT_STRING);
  if (depth >= MAX_CONTENT_DEPTH) return "[truncated]";
  if (Array.isArray(value)) {
    return value.slice(0, MAX_CONTENT_ITEMS).map((entry) => boundedJson(entry, depth + 1));
  }
  if (!value || typeof value !== "object") return String(value).slice(0, MAX_CONTENT_STRING);
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .slice(0, MAX_CONTENT_KEYS)
      .map(([key, entry]) => [key, boundedJson(entry, depth + 1)]),
  );
}

function contextNode(
  node: GenerativeUiDocumentV1["nodes"][number],
  selectedNodeId?: string,
): GenerativeUiCanvasContextNodeV1 {
  const bounded = boundedJson(node.content) as Record<string, unknown>;
  const content = jsonBytes(bounded) <= MAX_NODE_BYTES
    ? bounded
    : { preview: JSON.stringify(bounded).slice(0, MAX_NODE_BYTES - 256) };
  const contentTruncated = jsonBytes(node.content) !== jsonBytes(content);
  const a2ui = node.a2ui && jsonBytes({ content, a2ui: node.a2ui }) <= MAX_NODE_BYTES
    ? structuredClone(node.a2ui)
    : undefined;
  const a2uiOmitted = Boolean(node.a2ui && !a2ui);
  return {
    id: node.id,
    revision: node.revision,
    kind: node.kind,
    surface: node.surface,
    title: node.fallback.title,
    ...(node.fallback.summary ? { summary: node.fallback.summary } : {}),
    ...(node.presentation?.canvas_size ? { canvas_size: node.presentation.canvas_size } : {}),
    selected: node.id === selectedNodeId,
    content,
    ...(a2ui ? { a2ui } : {}),
    ...(a2uiOmitted ? { a2ui_omitted: true } : {}),
    ...(contentTruncated ? { content_truncated: true } : {}),
  };
}

/**
 * The caller may nominate only an id. Content always comes from the current
 * authoritative document, so stale or forged selections cannot inject data.
 */
export function buildGenerativeUiCanvasContext(
  document: GenerativeUiDocumentV1 | undefined,
  requestedSelectedNodeId?: string,
): GenerativeUiCanvasContextV1 | undefined {
  if (!document?.nodes.length) return undefined;
  const selectedNodeId = document.nodes.some((node) => node.id === requestedSelectedNodeId)
    ? requestedSelectedNodeId
    : undefined;
  const nodes = [...document.nodes]
    .sort((left, right) => {
      if (left.id === selectedNodeId) return -1;
      if (right.id === selectedNodeId) return 1;
      return right.updated_at.localeCompare(left.updated_at) || right.revision - left.revision;
    })
    .slice(0, GENERATIVE_UI_CANVAS_CONTEXT_MAX_NODES)
    .map((node) => contextNode(node, selectedNodeId));
  while (nodes.length > 1 && jsonBytes(nodes) > GENERATIVE_UI_CANVAS_CONTEXT_MAX_BYTES) nodes.pop();
  return {
    canvas_context_version: GENERATIVE_UI_CANVAS_CONTEXT_VERSION,
    document_id: document.document_id,
    document_revision: document.revision,
    ...(selectedNodeId ? { selected_node_id: selectedNodeId } : {}),
    nodes,
  };
}
