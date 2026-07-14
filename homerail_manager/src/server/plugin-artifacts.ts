import type * as http from "node:http";
import { HOMERAIL_ARTIFACT_BROKER_MAX_BYTES, isHomerailPluginId } from "homerail-protocol";
import { getPluginArtifactBroker } from "../plugins/artifact-broker.js";

function json(res: http.ServerResponse, status: number, body: unknown): void {
  res.setHeader("Cache-Control", "no-store");
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function errorStatus(cause: unknown): number {
  const message = cause instanceof Error ? cause.message.toLowerCase() : String(cause).toLowerCase();
  if (message.includes("not found")) return 404;
  if (message.includes("content-type")) return 415;
  if (message.includes("too large") || message.includes("byte length")) return 413;
  if (message.includes("already") || message.includes("replay") || message.includes("exists")) return 409;
  if (message.includes("token") || message.includes("capability")) return 401;
  if (message.includes("digest") || message.includes("scope binding")) return 422;
  return 400;
}

function routeError(res: http.ServerResponse, cause: unknown): void {
  json(res, errorStatus(cause), {
    success: false,
    error: cause instanceof Error ? cause.message : String(cause),
  });
}

function artifactAuthorization(req: http.IncomingMessage): string {
  const raw = req.headers.authorization;
  if (typeof raw !== "string") throw new Error("Artifact capability token is required");
  const match = /^HomerailArtifact ([^\s,]+)$/.exec(raw);
  if (!match) throw new Error("Artifact capability token format is invalid");
  return match[1];
}

function readArtifactBody(req: http.IncomingMessage, exactBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    if (!Number.isSafeInteger(exactBytes) || exactBytes < 1 || exactBytes > HOMERAIL_ARTIFACT_BROKER_MAX_BYTES) {
      reject(new Error("Artifact body limit is invalid"));
      req.resume();
      return;
    }
    const rawLength = req.headers["content-length"];
    if (rawLength !== undefined) {
      const declared = Number(rawLength);
      if (!Number.isSafeInteger(declared) || declared !== exactBytes) {
        reject(new Error("Artifact byte length does not match its capability"));
        req.resume();
        return;
      }
    }
    const chunks: Buffer[] = [];
    let bytes = 0;
    let rejected = false;
    req.on("data", (chunk: Buffer | string) => {
      if (rejected) return;
      const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += value.byteLength;
      if (bytes > exactBytes) {
        rejected = true;
        chunks.length = 0;
        reject(new Error("Artifact body is too large"));
        return;
      }
      chunks.push(value);
    });
    req.on("end", () => {
      if (rejected) return;
      if (bytes !== exactBytes) reject(new Error("Artifact byte length does not match its capability"));
      else resolve(Buffer.concat(chunks, exactBytes));
    });
    req.on("error", reject);
  });
}

function decodeSegment(raw: string, label: string): string {
  try {
    const value = decodeURIComponent(raw);
    if (encodeURIComponent(value) !== raw && encodeURIComponent(value).toLowerCase() !== raw.toLowerCase()) {
      throw new Error("non-canonical encoding");
    }
    return value;
  } catch {
    throw new Error(`${label} is invalid`);
  }
}

/**
 * Artifact routes have their own bearer capability trust boundary and must be
 * mounted before the generic admin-mutation policy.
 */
export function pluginArtifactRoutesHandler(req: http.IncomingMessage, res: http.ServerResponse): boolean {
  const url = new URL(req.url || "/", "http://localhost");
  const upload = url.pathname.match(/^\/api\/plugins\/artifacts\/uploads\/([^/]+)$/);
  if (upload) {
    if (req.method !== "PUT") {
      json(res, 405, { success: false, error: "Artifact upload requires PUT" });
      return true;
    }
    res.removeHeader("Access-Control-Allow-Origin");
    let capabilityId: string;
    let token: string;
    let claims;
    try {
      capabilityId = decodeSegment(upload[1], "Artifact capability id");
      token = artifactAuthorization(req);
      claims = getPluginArtifactBroker().inspectWriteCapability({ token, capability_id: capabilityId });
    } catch (cause) {
      req.resume();
      routeError(res, cause);
      return true;
    }
    const contentType = String(req.headers["content-type"] ?? "").trim().toLowerCase();
    readArtifactBody(req, claims.artifact.size_bytes).then((content) => {
      const metadata = getPluginArtifactBroker().publish({
        token,
        capability_id: capabilityId,
        content_type: contentType,
        content,
      });
      json(res, 201, { success: true, data: metadata });
    }).catch((cause) => routeError(res, cause));
    return true;
  }

  const read = url.pathname.match(/^\/api\/plugins\/artifacts\/([^/]+)\/([^/]+)\/([a-f0-9]{64})$/);
  if (!read) return false;
  if (req.method !== "GET" && req.method !== "HEAD") {
    json(res, 405, { success: false, error: "Artifact read requires GET or HEAD" });
    return true;
  }
  try {
    const pluginId = decodeSegment(read[1], "Artifact plugin id");
    if (!isHomerailPluginId(pluginId)) throw new Error("Artifact plugin id is invalid");
    const requestId = decodeSegment(read[2], "Artifact request id");
    const result = getPluginArtifactBroker().read({
      plugin_id: pluginId,
      request_id: requestId,
      digest: read[3],
    });
    const etag = `"sha256-${result.metadata.digest}"`;
    res.removeHeader("Access-Control-Allow-Origin");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
    res.setHeader("Cache-Control", "private, immutable, max-age=31536000");
    res.setHeader("ETag", etag);
    res.setHeader("Content-Type", result.metadata.media_type);
    res.setHeader("Content-Length", String(result.metadata.size_bytes));
    res.setHeader("X-Homerail-Artifact-Request", result.metadata.request_id);
    if (req.headers["if-none-match"] === etag) {
      res.writeHead(304);
      res.end();
    } else {
      res.writeHead(200);
      res.end(req.method === "HEAD" ? undefined : result.content);
    }
  } catch (cause) {
    routeError(res, cause);
  }
  return true;
}
