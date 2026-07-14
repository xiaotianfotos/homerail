import * as crypto from "node:crypto";
import * as http from "node:http";
import type {
  GenerativeUiDocumentScopeV1,
  GenerativeUiSurfaceContextV1,
} from "homerail-protocol";
import {
  resolveVoiceSessionGenerativeUiMode,
  VoiceGenerativeUiSessionNotFoundError,
} from "../generative-ui/session-mode.js";
import { getGenerativeUiKindRegistry } from "../generative-ui/kind-registry.js";
import { persistentGenerativeUiDocumentService } from "../generative-ui/shadow-service.js";
import { composeGenerativeUi } from "../generative-ui/surface-composer.js";
import { persistentGenerativeUiUserOverrideService } from "../generative-ui/user-override-service.js";
import { getPluginToolInvocationService } from "../plugins/action-bus.js";

const STREAM_VERSION = 1 as const;
const MAX_OVERRIDE_BODY_BYTES = 16 * 1024;

class GenerativeUiHttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function scopeFor(sessionId: string): GenerativeUiDocumentScopeV1 {
  return { type: "voice_session", id: sessionId };
}

function sessionMode(sessionId: string) {
  try {
    return resolveVoiceSessionGenerativeUiMode(sessionId);
  } catch (cause) {
    if (cause instanceof VoiceGenerativeUiSessionNotFoundError) {
      throw new GenerativeUiHttpError(404, "Voice workspace not found");
    }
    throw cause;
  }
}

function enumParam<T extends string>(
  value: string | null,
  fallback: T,
  allowed: readonly T[],
  label: string,
): T {
  if (value === null) return fallback;
  if (allowed.includes(value as T)) return value as T;
  throw new GenerativeUiHttpError(400, `Invalid Generative UI ${label}: ${value}`);
}

function surfaceContext(url: URL, sessionId: string): GenerativeUiSurfaceContextV1 {
  return {
    device: enumParam(url.searchParams.get("device"), "desktop", ["phone", "desktop", "tv"], "device"),
    input: enumParam(url.searchParams.get("input"), "mouse", ["touch", "mouse", "gamepad", "voice"], "input"),
    viewport: enumParam(url.searchParams.get("viewport"), "wide", ["compact", "regular", "wide"], "viewport"),
    attention: enumParam(url.searchParams.get("attention"), "focused", ["glance", "focused"], "attention"),
    active_session_id: sessionId,
    ...(url.searchParams.get("active_run_id")
      ? { active_run_id: url.searchParams.get("active_run_id")! }
      : {}),
  };
}

function projection(sessionId: string, context: GenerativeUiSurfaceContextV1) {
  const scope = scopeFor(sessionId);
  const mode = sessionMode(sessionId);
  if (mode === "off") return null;
  const purpose = mode === "prefer" ? "canonical" : "legacy_widget_shadow";
  const activeDocument = persistentGenerativeUiDocumentService.findActiveForScope(scope, purpose);
  const document = activeDocument
    ?? persistentGenerativeUiDocumentService.getLatestForScope(scope, purpose, true);
  const pendingToolConfirmations = mode === "prefer" && activeDocument
    ? getPluginToolInvocationService().pendingConfirmations(scope)
    : [];
  if (
    !document
    || (mode === "prefer" && (
      !activeDocument
      || (document.nodes.length === 0 && pendingToolConfirmations.length === 0)
    ))
  ) return null;
  const cursor = persistentGenerativeUiDocumentService.getCursor(document.document_id, scope);
  const overrides = persistentGenerativeUiUserOverrideService.list(document.document_id, scope, true);
  const registry = getGenerativeUiKindRegistry();
  const composition = composeGenerativeUi(
    document,
    overrides,
    context,
    registry.compositionMetadata(),
  );
  return {
    mode,
    authoritative: mode === "prefer",
    purpose,
    scope,
    document,
    cursor,
    overrides,
    composition,
    uiRegistry: registry.uiProjection(),
    pendingToolConfirmations,
    active: Boolean(activeDocument),
  };
}

function projectionEtag(current: NonNullable<ReturnType<typeof projection>>): string {
  const hash = crypto.createHash("sha256").update(JSON.stringify({
    mode: current.mode,
    authoritative: current.authoritative,
    purpose: current.purpose,
    document_id: current.document.document_id,
    revision: current.document.revision,
    overrides: current.overrides,
    context: current.composition.context,
    plugin_registry: current.uiRegistry.registry_fingerprint,
    pending_tool_confirmations: current.pendingToolConfirmations,
  })).digest("hex").slice(0, 32);
  return `"gui-${hash}"`;
}

function positiveInteger(value: string | null, fallback: number, maximum: number): number {
  const parsed = value === null ? fallback : Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? Math.min(parsed, maximum) : fallback;
}

function readJsonBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let body = "";
    let bytes = 0;
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > MAX_OVERRIDE_BODY_BYTES) {
        reject(new GenerativeUiHttpError(413, "Generative UI override body is too large"));
        return;
      }
      body += chunk;
    });
    req.on("end", () => {
      if (bytes > MAX_OVERRIDE_BODY_BYTES) return;
      try {
        const parsed = JSON.parse(body || "{}") as unknown;
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          throw new GenerativeUiHttpError(400, "Generative UI override body must be an object");
        }
        resolve(parsed as Record<string, unknown>);
      } catch (cause) {
        reject(cause instanceof GenerativeUiHttpError
          ? cause
          : new GenerativeUiHttpError(400, "Invalid Generative UI override JSON"));
      }
    });
    req.on("error", reject);
  });
}

function handleError(res: http.ServerResponse, cause: unknown): void {
  if (cause instanceof GenerativeUiHttpError) {
    json(res, cause.status, { success: false, error: cause.message });
    return;
  }
  json(res, 500, { success: false, error: "Generative UI projection unavailable" });
}

function requireProjection(sessionId: string, context: GenerativeUiSurfaceContextV1) {
  const current = projection(sessionId, context);
  if (!current) throw new GenerativeUiHttpError(404, "Generative UI document not found");
  return current;
}

function handleOverrideMutation(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  sessionId: string,
  nodeId: string,
  context: GenerativeUiSurfaceContextV1,
): void {
  let current: NonNullable<ReturnType<typeof projection>>;
  try {
    current = requireProjection(sessionId, context);
    if (!current.active) throw new GenerativeUiHttpError(409, "Historical Generative UI overrides are read-only");
  } catch (cause) {
    handleError(res, cause);
    return;
  }
  if (req.method === "DELETE") {
    try {
      const deleted = persistentGenerativeUiUserOverrideService.delete(
        current.document.document_id,
        nodeId,
        current.scope,
      );
      json(res, deleted ? 200 : 404, deleted
        ? { success: true, data: { document_id: current.document.document_id, node_id: nodeId } }
        : { success: false, error: "Generative UI user override not found" });
    } catch (cause) {
      handleError(res, cause);
    }
    return;
  }
  if (req.method !== "PUT") {
    json(res, 405, { success: false, error: "Generative UI override requires PUT or DELETE" });
    return;
  }
  readJsonBody(req).then((body) => {
    const allowed = new Set(["visibility", "pinned", "preferred_surface"]);
    const unknown = Object.keys(body).filter((field) => !allowed.has(field));
    if (unknown.length) throw new GenerativeUiHttpError(400, `Unknown Generative UI override fields: ${unknown.join(", ")}`);
    const override = persistentGenerativeUiUserOverrideService.put({
      documentId: current.document.document_id,
      nodeId,
      ...(body.visibility === undefined ? {} : { visibility: body.visibility as never }),
      ...(body.pinned === undefined ? {} : { pinned: body.pinned as never }),
      ...(body.preferred_surface === undefined ? {} : { preferredSurface: body.preferred_surface as never }),
    }, current.scope);
    json(res, 200, { success: true, data: { override } });
  }).catch((cause) => {
    if (cause instanceof Error && cause.message.startsWith("Invalid Generative UI user override")) {
      handleError(res, new GenerativeUiHttpError(400, cause.message));
      return;
    }
    handleError(res, cause);
  });
}

export function generativeUiRoutesHandler(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): boolean {
  const url = new URL(req.url || "/", "http://localhost");
  const pathname = url.pathname;
  const overrideMatch = pathname.match(
    /^\/api\/voice-agent\/sessions\/([^/]+)\/generative-ui\/overrides\/([^/]+)$/,
  );
  const transactionsMatch = pathname.match(
    /^\/api\/voice-agent\/sessions\/([^/]+)\/generative-ui\/transactions$/,
  );
  const streamMatch = pathname.match(
    /^\/api\/voice-agent\/sessions\/([^/]+)\/generative-ui\/stream$/,
  );
  const headMatch = pathname.match(/^\/api\/voice-agent\/sessions\/([^/]+)\/generative-ui$/);
  if (!overrideMatch && !transactionsMatch && !streamMatch && !headMatch) return false;

  try {
    const match = overrideMatch ?? transactionsMatch ?? streamMatch ?? headMatch;
    const sessionId = decodeURIComponent(match![1]);
    const context = surfaceContext(url, sessionId);
    if (overrideMatch) {
      handleOverrideMutation(req, res, sessionId, decodeURIComponent(overrideMatch[2]), context);
      return true;
    }
    if (req.method !== "GET") {
      json(res, 405, { success: false, error: "Generative UI projection is read-only" });
      return true;
    }

    const current = requireProjection(sessionId, context);
    const etag = projectionEtag(current);
    res.setHeader("Cache-Control", "private, no-cache");

    if (headMatch) {
      if (req.headers["if-none-match"] === etag) {
        res.writeHead(304, { ETag: etag });
        res.end();
        return true;
      }
      res.setHeader("ETag", etag);
      json(res, 200, {
        success: true,
        data: {
          stream_version: STREAM_VERSION,
          mode: current.mode,
          authoritative: current.authoritative,
          purpose: current.purpose,
          document: current.document,
          cursor: current.cursor,
          overrides: current.overrides,
          composition: current.composition,
          ui_registry: current.uiRegistry,
          pending_tool_confirmations: current.pendingToolConfirmations,
        },
      });
      return true;
    }

    const afterSeq = positiveInteger(url.searchParams.get("after_seq"), 0, Number.MAX_SAFE_INTEGER);
    const limit = positiveInteger(url.searchParams.get("limit"), 100, 100) || 100;
    const transactions = persistentGenerativeUiDocumentService.listTransactions(
      current.document.document_id,
      current.scope,
      afterSeq,
      limit + 1,
    );
    const page = transactions.slice(0, limit);
    const nextAfterSeq = page.at(-1)?.seq ?? afterSeq;

    if (streamMatch) {
      res.writeHead(200, { "Content-Type": "application/x-ndjson", ETag: etag });
      res.write(`${JSON.stringify({
        type: "generative_ui",
        event: "snapshot",
        stream_version: STREAM_VERSION,
        mode: current.mode,
        authoritative: current.authoritative,
        purpose: current.purpose,
        cursor: current.cursor,
        document: current.document,
        overrides: current.overrides,
        composition: current.composition,
        ui_registry: current.uiRegistry,
        ...(current.mode === "prefer"
          ? { pending_tool_confirmations: current.pendingToolConfirmations }
          : {}),
      })}\n`);
      for (const committed of page) {
        res.write(`${JSON.stringify({
          type: "generative_ui",
          event: "transaction",
          stream_version: STREAM_VERSION,
          authoritative: current.authoritative,
          purpose: current.purpose,
          ...committed,
          revision: committed.committed_revision,
        })}\n`);
      }
      res.end();
      return true;
    }

    json(res, 200, {
      success: true,
      data: {
        stream_version: STREAM_VERSION,
        authoritative: current.authoritative,
        purpose: current.purpose,
        document_id: current.document.document_id,
        head_revision: current.document.revision,
        transactions: page,
        next_after_seq: nextAfterSeq,
        has_more: transactions.length > limit,
      },
    });
    return true;
  } catch (cause) {
    handleError(res, cause);
    return true;
  }
}
