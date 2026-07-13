import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { DAGArtifactDeclaration } from "../orchestration/graph.js";
import { getDataRoot } from "../config/env.js";
import { dbTransaction, encodeJson, getDb, parseJsonRow } from "./db.js";

export type RunArtifactStatus = "pending" | "uploading" | "ready" | "failed" | "skipped";

export interface RunArtifactError {
  code: string;
  message: string;
}

export interface RunArtifactRecord {
  artifact_id: string;
  run_id: string;
  name: string;
  status: RunArtifactStatus;
  media_type: string;
  required: boolean;
  publish: "success" | "failure" | "always";
  source: DAGArtifactDeclaration["source"];
  archive?: { format: "tar.gz"; deterministic: boolean };
  limits?: {
    max_files: number;
    max_uncompressed_bytes: number;
    max_compressed_bytes: number;
    timeout_ms: number;
  };
  size_bytes?: number;
  uncompressed_bytes?: number;
  file_count?: number;
  sha256?: string;
  error?: RunArtifactError;
  created_at: number;
  updated_at: number;
}

interface ArtifactRow {
  run_id: string;
  name: string;
  artifact_id: string;
  status: RunArtifactStatus;
  upload_token_hash: string | null;
  upload_expires_at: number | null;
  created_at: number;
  updated_at: number;
  data: string;
}

export class ArtifactUploadAuthorizationError extends Error {
  constructor(
    message: string,
    readonly statusCode: 401 | 404 | 409,
  ) {
    super(message);
    this.name = "ArtifactUploadAuthorizationError";
  }
}

function safeId(value: string, label: string): string {
  if (!value || value.startsWith("/") || value.includes("\\") || value.includes("\0")) {
    throw new Error(`${label} must be a safe relative identifier`);
  }
  if (!value.split("/").every((part) => part && part !== "." && part !== ".." && /^[A-Za-z0-9._-]+$/.test(part))) {
    throw new Error(`${label} contains an unsafe path segment`);
  }
  return value;
}

function rowToRecord(row: ArtifactRow): RunArtifactRecord {
  const data = parseJsonRow<Omit<RunArtifactRecord, "status" | "updated_at">>(row.data);
  return {
    ...data,
    artifact_id: row.artifact_id,
    run_id: row.run_id,
    name: row.name,
    status: row.status,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function artifactRow(runId: string, name: string): ArtifactRow | undefined {
  safeId(runId, "runId");
  safeId(name, "artifact name");
  return getDb().prepare(`
    SELECT run_id, name, artifact_id, status, upload_token_hash,
           upload_expires_at, created_at, updated_at, data
    FROM dag_artifacts
    WHERE run_id = ? AND name = ?
  `).get(runId, name) as ArtifactRow | undefined;
}

function writeRecord(
  record: RunArtifactRecord,
  privateFields: { uploadTokenHash?: string | null; uploadExpiresAt?: number | null } = {},
): void {
  const now = Date.now();
  const next = { ...record, updated_at: now };
  getDb().prepare(`
    UPDATE dag_artifacts
    SET status = ?,
        upload_token_hash = CASE WHEN ? = 1 THEN ? ELSE upload_token_hash END,
        upload_expires_at = CASE WHEN ? = 1 THEN ? ELSE upload_expires_at END,
        updated_at = ?, data = ?
    WHERE run_id = ? AND name = ?
  `).run(
    next.status,
    privateFields.uploadTokenHash === undefined ? 0 : 1,
    privateFields.uploadTokenHash ?? null,
    privateFields.uploadExpiresAt === undefined ? 0 : 1,
    privateFields.uploadExpiresAt ?? null,
    now,
    encodeJson(next),
    next.run_id,
    next.name,
  );
}

function artifactRoot(): string {
  return path.join(getDataRoot(), "artifacts");
}

function ensurePrivateDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(dir, 0o700);
  } catch {
    // Best effort on filesystems without POSIX modes.
  }
}

function artifactDir(record: RunArtifactRecord): string {
  return path.join(artifactRoot(), safeId(record.run_id, "runId"), safeId(record.artifact_id, "artifactId"));
}

export function initializeRunArtifacts(runId: string, declarations: DAGArtifactDeclaration[]): RunArtifactRecord[] {
  safeId(runId, "runId");
  const now = Date.now();
  const insert = getDb().prepare(`
    INSERT OR IGNORE INTO dag_artifacts(
      run_id, name, artifact_id, status, upload_token_hash, upload_expires_at,
      created_at, updated_at, data
    ) VALUES (?, ?, ?, 'pending', NULL, NULL, ?, ?, ?)
  `);
  dbTransaction(() => {
    for (const declaration of declarations) {
      safeId(declaration.name, "artifact name");
      const record: RunArtifactRecord = {
        artifact_id: randomUUID(),
        run_id: runId,
        name: declaration.name,
        status: "pending",
        media_type: declaration.media_type,
        required: declaration.required,
        publish: declaration.publish,
        source: structuredClone(declaration.source),
        ...("archive" in declaration ? {
          archive: structuredClone(declaration.archive),
          limits: structuredClone(declaration.limits),
        } : {}),
        created_at: now,
        updated_at: now,
      };
      insert.run(runId, declaration.name, record.artifact_id, now, now, encodeJson(record));
    }
  });
  return listRunArtifacts(runId);
}

export function listRunArtifacts(runId: string): RunArtifactRecord[] {
  safeId(runId, "runId");
  return (getDb().prepare(`
    SELECT run_id, name, artifact_id, status, upload_token_hash,
           upload_expires_at, created_at, updated_at, data
    FROM dag_artifacts
    WHERE run_id = ?
    ORDER BY name
  `).all(runId) as ArtifactRow[]).map(rowToRecord);
}

export function getRunArtifact(runId: string, name: string): RunArtifactRecord | undefined {
  const row = artifactRow(runId, name);
  return row ? rowToRecord(row) : undefined;
}

export function getRunArtifactBlobPath(runId: string, name: string): string | undefined {
  const record = getRunArtifact(runId, name);
  if (!record || record.status !== "ready") return undefined;
  return path.join(artifactDir(record), "blob");
}

export function writeRunArtifactBytes(
  runId: string,
  name: string,
  bytes: Uint8Array,
  metadata: { uncompressedBytes?: number; fileCount?: number } = {},
): RunArtifactRecord {
  const record = getRunArtifact(runId, name);
  if (!record) throw new Error(`artifact ${runId}/${name} not found`);
  const dir = artifactDir(record);
  ensurePrivateDir(dir);
  const temporary = path.join(dir, `.blob-${randomUUID()}.tmp`);
  fs.writeFileSync(temporary, bytes, { mode: 0o600 });
  fs.renameSync(temporary, path.join(dir, "blob"));
  const ready: RunArtifactRecord = {
    ...record,
    status: "ready",
    size_bytes: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    ...(metadata.uncompressedBytes === undefined ? {} : { uncompressed_bytes: metadata.uncompressedBytes }),
    ...(metadata.fileCount === undefined ? {} : { file_count: metadata.fileCount }),
  };
  writeRecord(ready, { uploadTokenHash: null, uploadExpiresAt: null });
  return getRunArtifact(runId, name)!;
}

export function markRunArtifactFailed(runId: string, name: string, error: RunArtifactError): RunArtifactRecord {
  const record = getRunArtifact(runId, name);
  if (!record) throw new Error(`artifact ${runId}/${name} not found`);
  writeRecord({ ...record, status: "failed", error }, { uploadTokenHash: null, uploadExpiresAt: null });
  return getRunArtifact(runId, name)!;
}

export function markRunArtifactSkipped(runId: string, name: string, message: string): RunArtifactRecord {
  const record = getRunArtifact(runId, name);
  if (!record) throw new Error(`artifact ${runId}/${name} not found`);
  writeRecord({
    ...record,
    status: "skipped",
    error: { code: "ARTIFACT_NOT_PUBLISHED", message },
  }, { uploadTokenHash: null, uploadExpiresAt: null });
  return getRunArtifact(runId, name)!;
}

export interface PreparedArtifactUpload {
  record: RunArtifactRecord;
  token: string;
  expires_at: number;
}

export function prepareRunArtifactUpload(
  runId: string,
  name: string,
  expiresAt = Date.now() + 10 * 60_000,
): PreparedArtifactUpload {
  const record = getRunArtifact(runId, name);
  if (!record) throw new Error(`artifact ${runId}/${name} not found`);
  const token = randomBytes(32).toString("base64url");
  const tokenHash = createHash("sha256").update(token).digest("hex");
  const pending: RunArtifactRecord = { ...record, status: "pending" };
  delete pending.error;
  getDb().prepare(`
    UPDATE dag_artifacts
    SET status = 'pending', upload_token_hash = ?, upload_expires_at = ?,
        updated_at = ?, data = ?
    WHERE run_id = ? AND name = ?
  `).run(tokenHash, expiresAt, Date.now(), encodeJson(pending), runId, name);
  return { record: getRunArtifact(runId, name)!, token, expires_at: expiresAt };
}

export interface AuthorizedArtifactUpload {
  record: RunArtifactRecord;
  temporary_path: string;
  final_path: string;
}

export function authorizeRunArtifactUpload(runId: string, name: string, token: string): AuthorizedArtifactUpload {
  const record = dbTransaction(() => {
    const row = artifactRow(runId, name);
    if (!row) throw new ArtifactUploadAuthorizationError("artifact not found", 404);
    if (row.status !== "pending" || !row.upload_token_hash || !row.upload_expires_at) {
      throw new ArtifactUploadAuthorizationError("artifact upload is not pending", 409);
    }
    if (row.upload_expires_at < Date.now()) {
      throw new ArtifactUploadAuthorizationError("artifact upload token expired", 401);
    }
    const actual = Buffer.from(createHash("sha256").update(token).digest("hex"), "hex");
    const expected = Buffer.from(row.upload_token_hash, "hex");
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
      throw new ArtifactUploadAuthorizationError("invalid artifact upload token", 401);
    }
    const changed = getDb().prepare(`
      UPDATE dag_artifacts
      SET status = 'uploading', upload_token_hash = NULL, upload_expires_at = NULL, updated_at = ?
      WHERE run_id = ? AND name = ? AND status = 'pending' AND upload_token_hash = ?
    `).run(Date.now(), runId, name, row.upload_token_hash);
    if (changed.changes !== 1) {
      throw new ArtifactUploadAuthorizationError("artifact upload already claimed", 409);
    }
    return { ...rowToRecord(row), status: "uploading" as const };
  });
  const dir = artifactDir(record);
  ensurePrivateDir(dir);
  return {
    record,
    temporary_path: path.join(dir, `.upload-${randomUUID()}.tmp`),
    final_path: path.join(dir, "blob"),
  };
}

export function completeRunArtifactUpload(
  runId: string,
  name: string,
  metadata: { sizeBytes: number; sha256: string; uncompressedBytes?: number; fileCount?: number },
): RunArtifactRecord {
  const record = getRunArtifact(runId, name);
  if (!record || record.status !== "uploading") throw new Error(`artifact ${runId}/${name} upload is not active`);
  writeRecord({
    ...record,
    status: "ready",
    size_bytes: metadata.sizeBytes,
    sha256: metadata.sha256,
    ...(metadata.uncompressedBytes === undefined ? {} : { uncompressed_bytes: metadata.uncompressedBytes }),
    ...(metadata.fileCount === undefined ? {} : { file_count: metadata.fileCount }),
  }, { uploadTokenHash: null, uploadExpiresAt: null });
  return getRunArtifact(runId, name)!;
}
