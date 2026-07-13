import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as http from "node:http";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  ArtifactUploadAuthorizationError,
  authorizeRunArtifactUpload,
  completeRunArtifactUpload,
  getRunArtifact,
  getRunArtifactBlobPath,
  listRunArtifacts,
  markRunArtifactFailed,
} from "../persistence/run-artifacts.js";
import { loadRunMetadata } from "../persistence/store.js";

interface BaseResponse {
  success: boolean;
  message: string;
  data?: unknown;
  error?: string;
}

function json(res: http.ServerResponse, status: number, body: BaseResponse): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function decodePart(value: string): string | undefined {
  try {
    return decodeURIComponent(value);
  } catch {
    return undefined;
  }
}

function bearerToken(req: http.IncomingMessage): string | undefined {
  const value = req.headers.authorization;
  if (!value || Array.isArray(value)) return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(value.trim());
  return match?.[1];
}

function numericHeader(req: http.IncomingMessage, name: string): number | undefined {
  const raw = req.headers[name];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

function contentDisposition(name: string): string {
  const ascii = name.replace(/[^A-Za-z0-9._-]/g, "_");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

type ByteRange = { start: number; end: number } | "invalid" | undefined;

function parseRange(value: string | undefined, size: number): ByteRange {
  if (!value) return undefined;
  const match = /^bytes=(\d*)-(\d*)$/.exec(value.trim());
  if (!match || (!match[1] && !match[2]) || size === 0) return "invalid";
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return "invalid";
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(match[1]);
  const end = match[2] ? Number(match[2]) : size - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= size || end < start) {
    return "invalid";
  }
  return { start, end: Math.min(end, size - 1) };
}

function serveArtifactContent(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  runId: string,
  name: string,
): void {
  const record = getRunArtifact(runId, name);
  if (!record) {
    json(res, 404, { success: false, message: "Artifact not found", error: "Artifact not found" });
    return;
  }
  if (record.status !== "ready") {
    json(res, 409, {
      success: false,
      message: `Artifact is ${record.status}`,
      error: `Artifact is ${record.status}`,
      data: record,
    });
    return;
  }
  const blobPath = getRunArtifactBlobPath(runId, name);
  if (!blobPath || !fs.existsSync(blobPath)) {
    json(res, 500, { success: false, message: "Artifact blob is missing", error: "Artifact blob is missing" });
    return;
  }
  const stat = fs.statSync(blobPath);
  const etag = record.sha256 ? `"${record.sha256}"` : undefined;
  if (etag && req.headers["if-none-match"] === etag) {
    res.writeHead(304, { ETag: etag });
    res.end();
    return;
  }
  const range = parseRange(Array.isArray(req.headers.range) ? req.headers.range[0] : req.headers.range, stat.size);
  if (range === "invalid") {
    res.writeHead(416, { "Content-Range": `bytes */${stat.size}` });
    res.end();
    return;
  }
  const headers: http.OutgoingHttpHeaders = {
    "Content-Type": record.media_type,
    "Content-Disposition": contentDisposition(record.name),
    "Accept-Ranges": "bytes",
    ...(etag ? { ETag: etag } : {}),
  };
  if (range) {
    headers["Content-Range"] = `bytes ${range.start}-${range.end}/${stat.size}`;
    headers["Content-Length"] = range.end - range.start + 1;
    res.writeHead(206, headers);
  } else {
    headers["Content-Length"] = stat.size;
    res.writeHead(200, headers);
  }
  if (req.method === "HEAD") {
    res.end();
    return;
  }
  const stream = fs.createReadStream(blobPath, range ? { start: range.start, end: range.end } : undefined);
  stream.on("error", () => res.destroy());
  stream.pipe(res);
}

async function receiveArtifactUpload(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  runId: string,
  name: string,
): Promise<void> {
  const token = bearerToken(req);
  if (!token) {
    json(res, 401, { success: false, message: "Bearer upload token required", error: "Bearer upload token required" });
    return;
  }
  let target: ReturnType<typeof authorizeRunArtifactUpload> | undefined;
  try {
    target = authorizeRunArtifactUpload(runId, name, token);
    const maxBytes = target.record.limits?.max_compressed_bytes;
    const contentLength = numericHeader(req, "content-length");
    if (maxBytes !== undefined && contentLength !== undefined && contentLength > maxBytes) {
      throw new Error(`compressed artifact exceeds ${maxBytes} bytes`);
    }
    if (target.record.media_type && req.headers["content-type"] !== target.record.media_type) {
      throw new Error(`expected Content-Type ${target.record.media_type}`);
    }

    let sizeBytes = 0;
    const hash = createHash("sha256");
    const counter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        sizeBytes += chunk.length;
        if (maxBytes !== undefined && sizeBytes > maxBytes) {
          callback(new Error(`compressed artifact exceeds ${maxBytes} bytes`));
          return;
        }
        hash.update(chunk);
        callback(null, chunk);
      },
    });
    await pipeline(req, counter, fs.createWriteStream(target.temporary_path, { mode: 0o600 }));
    const sha256 = hash.digest("hex");
    const expectedSha = Array.isArray(req.headers["x-homerail-artifact-sha256"])
      ? req.headers["x-homerail-artifact-sha256"][0]
      : req.headers["x-homerail-artifact-sha256"];
    if (expectedSha && expectedSha.toLowerCase() !== sha256) {
      throw new Error("artifact SHA-256 does not match upload header");
    }
    fs.renameSync(target.temporary_path, target.final_path);
    const record = completeRunArtifactUpload(runId, name, {
      sizeBytes,
      sha256,
      uncompressedBytes: numericHeader(req, "x-homerail-artifact-uncompressed-bytes"),
      fileCount: numericHeader(req, "x-homerail-artifact-file-count"),
    });
    json(res, 201, { success: true, message: "Artifact uploaded", data: record });
  } catch (error) {
    if (target) {
      try {
        fs.rmSync(target.temporary_path, { force: true });
      } catch {
        // Ignore cleanup failures while reporting the primary error.
      }
      try {
        markRunArtifactFailed(runId, name, {
          code: "ARTIFACT_UPLOAD_FAILED",
          message: error instanceof Error ? error.message : String(error),
        });
      } catch {
        // The lifecycle finalizer will reconcile a missing row.
      }
    }
    const status = error instanceof ArtifactUploadAuthorizationError ? error.statusCode : 400;
    if (!res.headersSent) {
      json(res, status, {
        success: false,
        message: error instanceof Error ? error.message : String(error),
        error: error instanceof Error ? error.message : String(error),
      });
    } else {
      res.destroy();
    }
  }
}

export function runArtifactRoutesHandler(req: http.IncomingMessage, res: http.ServerResponse): boolean {
  const pathname = new URL(req.url || "/", "http://localhost").pathname;
  const listMatch = /^\/api\/runs\/([^/]+)\/artifacts\/?$/.exec(pathname);
  if (listMatch && req.method === "GET") {
    const runId = decodePart(listMatch[1]);
    if (!runId || !loadRunMetadata(runId)) {
      json(res, 404, { success: false, message: "Run not found", error: "Run not found" });
      return true;
    }
    const artifacts = listRunArtifacts(runId);
    json(res, 200, {
      success: true,
      message: "Run artifacts retrieved",
      data: { run_id: runId, artifacts, total: artifacts.length },
    });
    return true;
  }

  const contentMatch = /^\/api\/runs\/([^/]+)\/artifacts\/([^/]+)\/content$/.exec(pathname);
  if (contentMatch && (req.method === "GET" || req.method === "HEAD")) {
    const runId = decodePart(contentMatch[1]);
    const name = decodePart(contentMatch[2]);
    if (!runId || !name) {
      json(res, 400, { success: false, message: "Invalid artifact path", error: "Invalid artifact path" });
      return true;
    }
    serveArtifactContent(req, res, runId, name);
    return true;
  }

  const uploadMatch = /^\/api\/runs\/([^/]+)\/artifacts\/([^/]+)\/upload$/.exec(pathname);
  if (uploadMatch && req.method === "PUT") {
    const runId = decodePart(uploadMatch[1]);
    const name = decodePart(uploadMatch[2]);
    if (!runId || !name) {
      json(res, 400, { success: false, message: "Invalid artifact path", error: "Invalid artifact path" });
      return true;
    }
    void receiveArtifactUpload(req, res, runId, name);
    return true;
  }
  return false;
}
