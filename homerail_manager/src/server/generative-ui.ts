import * as http from "node:http";
import type { GenerativeUiDocumentScopeV1 } from "homerail-protocol";
import { persistentGenerativeUiDocumentService } from "../generative-ui/shadow-service.js";

const STREAM_VERSION = 1 as const;
const PURPOSE = "legacy_widget_shadow" as const;

function json(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function scopeFor(sessionId: string): GenerativeUiDocumentScopeV1 {
  return { type: "voice_session", id: sessionId };
}

function projection(sessionId: string) {
  const scope = scopeFor(sessionId);
  const document = persistentGenerativeUiDocumentService.findActiveForScope(scope, PURPOSE)
    ?? persistentGenerativeUiDocumentService.getLatestForScope(scope, PURPOSE, true);
  if (!document) return null;
  const cursor = persistentGenerativeUiDocumentService.getCursor(document.document_id, scope);
  return { scope, document, cursor };
}

function positiveInteger(value: string | null, fallback: number, maximum: number): number {
  const parsed = value === null ? fallback : Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? Math.min(parsed, maximum) : fallback;
}

export function generativeUiRoutesHandler(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): boolean {
  const url = new URL(req.url || "/", "http://localhost");
  const pathname = url.pathname;
  const transactionsMatch = pathname.match(
    /^\/api\/voice-agent\/sessions\/([^/]+)\/generative-ui\/transactions$/,
  );
  const streamMatch = pathname.match(
    /^\/api\/voice-agent\/sessions\/([^/]+)\/generative-ui\/stream$/,
  );
  const headMatch = pathname.match(/^\/api\/voice-agent\/sessions\/([^/]+)\/generative-ui$/);
  if (!transactionsMatch && !streamMatch && !headMatch) return false;
  if (req.method !== "GET") {
    json(res, 405, { success: false, error: "Generative UI projection is read-only" });
    return true;
  }

  try {
    const sessionId = decodeURIComponent((transactionsMatch ?? streamMatch ?? headMatch)![1]);
    const current = projection(sessionId);
    if (!current) {
      json(res, 404, { success: false, error: "Generative UI document not found" });
      return true;
    }
    const etag = `"${current.document.document_id}:${current.document.revision}"`;

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
          mode: "shadow",
          authoritative: false,
          purpose: PURPOSE,
          document: current.document,
          cursor: current.cursor,
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
        authoritative: false,
        purpose: PURPOSE,
        cursor: current.cursor,
        document: current.document,
      })}\n`);
      for (const committed of page) {
        res.write(`${JSON.stringify({
          type: "generative_ui",
          event: "transaction",
          stream_version: STREAM_VERSION,
          authoritative: false,
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
        authoritative: false,
        purpose: PURPOSE,
        document_id: current.document.document_id,
        head_revision: current.document.revision,
        transactions: page,
        next_after_seq: nextAfterSeq,
        has_more: transactions.length > limit,
      },
    });
    return true;
  } catch {
    json(res, 500, { success: false, error: "Generative UI projection unavailable" });
    return true;
  }
}
