import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { ensureDefaultWorkspacePath, getDataRoot } from "../config/env.js";
import { dbTransaction, getDb } from "../persistence/db.js";
import { getProject } from "../persistence/projects-changes.js";
import { nowIso } from "../persistence/time.js";

const MAX_ARTIFACT_BYTES = 16 * 1024 * 1024;
const MAX_HTML_BYTES = 2 * 1024 * 1024;

const ARTIFACT_FORMATS = new Map([
  [".html", { mediaType: "text/html", kind: "html" as const }],
  [".htm", { mediaType: "text/html", kind: "html" as const }],
  [".png", { mediaType: "image/png", kind: "image" as const }],
  [".jpg", { mediaType: "image/jpeg", kind: "image" as const }],
  [".jpeg", { mediaType: "image/jpeg", kind: "image" as const }],
  [".webp", { mediaType: "image/webp", kind: "image" as const }],
]);

export interface PublishedVoiceArtifact {
  artifact_id: string;
  revision: number;
  title: string;
  filename: string;
  url: string;
  preview_url: string;
  stable_url: string;
  revision_url: string;
  media_type: string;
  kind: "image" | "html";
  size_bytes: number;
  digest: string;
}

interface VoiceArtifactRow {
  session_id: string;
  artifact_id: string;
  title: string;
  kind: "image" | "html";
  media_type: string;
  current_revision: number;
  current_digest: string;
  current_filename: string;
}

interface VoiceArtifactRevisionRow {
  revision: number;
  title: string;
  kind: "image" | "html";
  media_type: string;
  digest: string;
  filename: string;
  size_bytes: number;
}

export interface ResolvedVoiceArtifactRevision extends PublishedVoiceArtifact {
  path: string;
}

export class VoiceArtifactRevisionConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VoiceArtifactRevisionConflictError";
  }
}

function safeSessionId(value: string): string {
  if (!/^[A-Za-z0-9_.-]+$/.test(value)) throw new Error("invalid voice session id");
  return value;
}

function safeArtifactId(value: string): string {
  const clean = value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(clean)) throw new Error("invalid voice artifact id");
  return clean;
}

export function voiceArtifactRoot(sessionId: string): string {
  return path.join(getDataRoot(), "voice-agent-sdk", safeSessionId(sessionId));
}

export function resolveVoiceArtifact(sessionId: string, filePath = "index.html"): string {
  const root = path.resolve(voiceArtifactRoot(sessionId));
  const relative = decodeURIComponent(filePath || "index.html").replace(/^\/+/, "");
  const candidate = path.resolve(root, relative);
  if (candidate !== root && !candidate.startsWith(`${root}${path.sep}`)) {
    throw new Error("invalid artifact path");
  }
  if (!fs.existsSync(candidate) || !fs.statSync(candidate).isFile()) {
    throw new Error("voice artifact file not found");
  }
  return candidate;
}

function projectRoot(projectId?: string | null): string {
  if (projectId) {
    const project = getProject(projectId);
    const configured = project?.workspace_path ?? project?.project_root;
    if (configured) return path.resolve(configured);
  }
  const fallback = ensureDefaultWorkspacePath();
  if (!fallback) throw new Error("voice artifact publishing requires a project workspace");
  return path.resolve(fallback);
}

function sourceFile(root: string, sourcePath: string): string {
  const clean = sourcePath.trim();
  if (!clean || clean.includes("\0")) throw new Error("artifact source_path is invalid");
  const containerRelative = clean.replace(/^\/workspace\/project\/?/, "");
  const candidate = path.isAbsolute(containerRelative)
    ? path.resolve(containerRelative)
    : path.resolve(root, containerRelative);
  const realRoot = fs.realpathSync(root);
  const realCandidate = fs.realpathSync(candidate);
  if (realCandidate !== realRoot && !realCandidate.startsWith(`${realRoot}${path.sep}`)) {
    throw new Error("artifact source_path is outside the project workspace");
  }
  const stat = fs.statSync(realCandidate);
  if (!stat.isFile()) throw new Error("artifact source_path is not a file");
  return realCandidate;
}

function slug(value: string): string {
  const normalized = value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return normalized.slice(0, 48) || "artifact";
}

function artifactUrls(sessionId: string, artifactId: string, revision: number, filename: string) {
  const session = encodeURIComponent(sessionId);
  const id = encodeURIComponent(artifactId);
  const revisionUrl = `/api/voice-agent/sessions/${session}/artifacts/${encodeURIComponent(filename)}`;
  const stableUrl = `/api/voice-agent/sessions/${session}/artifacts/by-id/${id}/preview`;
  return {
    url: revisionUrl,
    revision_url: revisionUrl,
    stable_url: stableUrl,
    preview_url: `${stableUrl}?revision=${revision}`,
  };
}

function publishedFromRows(
  sessionId: string,
  artifactId: string,
  artifact: VoiceArtifactRow,
  revision: VoiceArtifactRevisionRow,
): PublishedVoiceArtifact {
  return {
    artifact_id: artifactId,
    revision: revision.revision,
    title: revision.title,
    filename: revision.filename,
    ...artifactUrls(sessionId, artifactId, revision.revision, revision.filename),
    media_type: revision.media_type,
    kind: revision.kind,
    size_bytes: revision.size_bytes,
    digest: revision.digest,
  };
}

function getArtifactRow(sessionId: string, artifactId: string): VoiceArtifactRow | undefined {
  return getDb().prepare(`
    SELECT session_id, artifact_id, title, kind, media_type, current_revision, current_digest, current_filename
    FROM voice_artifacts
    WHERE session_id = ? AND artifact_id = ?
  `).get(sessionId, artifactId) as VoiceArtifactRow | undefined;
}

function getRevisionRow(
  sessionId: string,
  artifactId: string,
  revision: number,
): VoiceArtifactRevisionRow | undefined {
  return getDb().prepare(`
    SELECT revision, title, kind, media_type, digest, filename, size_bytes
    FROM voice_artifact_revisions
    WHERE session_id = ? AND artifact_id = ? AND revision = ?
  `).get(sessionId, artifactId, revision) as VoiceArtifactRevisionRow | undefined;
}

function verifyMagic(content: Buffer, extension: string): void {
  if (extension === ".png" && !content.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    throw new Error("PNG artifact signature is invalid");
  }
  if ((extension === ".jpg" || extension === ".jpeg") && !(content[0] === 0xff && content[1] === 0xd8)) {
    throw new Error("JPEG artifact signature is invalid");
  }
  if (extension === ".webp" && !(content.subarray(0, 4).toString("ascii") === "RIFF" && content.subarray(8, 12).toString("ascii") === "WEBP")) {
    throw new Error("WebP artifact signature is invalid");
  }
}

export function publishVoiceArtifact(input: {
  session_id: string;
  project_id?: string | null;
  source_path: string;
  title?: string;
  artifact_id?: string;
  expected_revision?: number;
}): PublishedVoiceArtifact {
  const sessionId = safeSessionId(input.session_id);
  const artifactId = input.artifact_id ? safeArtifactId(input.artifact_id) : `artifact-${randomUUID()}`;
  if (input.expected_revision !== undefined
    && (!Number.isInteger(input.expected_revision) || input.expected_revision < 0)) {
    throw new Error("expected_revision must be a non-negative integer");
  }
  const root = projectRoot(input.project_id);
  const source = sourceFile(root, input.source_path);
  const extension = path.extname(source).toLowerCase();
  const format = ARTIFACT_FORMATS.get(extension);
  if (!format) throw new Error("artifact type must be PNG, JPEG, WebP, or standalone HTML");
  const stat = fs.statSync(source);
  const limit = format.kind === "html" ? MAX_HTML_BYTES : MAX_ARTIFACT_BYTES;
  if (stat.size < 1 || stat.size > limit) throw new Error(`artifact exceeds ${limit} bytes`);
  const content = fs.readFileSync(source);
  verifyMagic(content, extension);
  const digest = createHash("sha256").update(content).digest("hex");
  const outputExtension = extension === ".htm" ? ".html" : extension;
  const title = String(input.title || path.basename(source, extension)).trim().slice(0, 200) || "Artifact";
  const filename = `${slug(title)}-${digest.slice(0, 16)}${outputExtension}`;
  const destinationRoot = voiceArtifactRoot(sessionId);
  const destination = path.join(destinationRoot, filename);
  fs.mkdirSync(destinationRoot, { recursive: true });
  if (!fs.existsSync(destination)) fs.writeFileSync(destination, content, { mode: 0o600 });

  return dbTransaction(() => {
    const existing = getArtifactRow(sessionId, artifactId);
    if (!existing) {
      if (input.expected_revision !== undefined && input.expected_revision !== 0) {
        throw new VoiceArtifactRevisionConflictError(
          `voice artifact does not exist; expected_revision must be 0, received ${input.expected_revision}`,
        );
      }
      const createdAt = nowIso();
      getDb().prepare(`
        INSERT INTO voice_artifacts (
          session_id, artifact_id, title, kind, media_type, current_revision,
          current_digest, current_filename, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?)
      `).run(sessionId, artifactId, title, format.kind, format.mediaType, digest, filename, createdAt, createdAt);
      getDb().prepare(`
        INSERT INTO voice_artifact_revisions (
          session_id, artifact_id, revision, title, kind, media_type,
          digest, filename, size_bytes, created_at
        ) VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?)
      `).run(sessionId, artifactId, title, format.kind, format.mediaType, digest, filename, stat.size, createdAt);
      const artifact = getArtifactRow(sessionId, artifactId)!;
      const revision = getRevisionRow(sessionId, artifactId, 1)!;
      return publishedFromRows(sessionId, artifactId, artifact, revision);
    }

    if (input.expected_revision === undefined) {
      throw new VoiceArtifactRevisionConflictError(
        `expected_revision is required to update voice artifact ${artifactId}`,
      );
    }
    if (input.expected_revision !== existing.current_revision) {
      throw new VoiceArtifactRevisionConflictError(
        `voice artifact revision conflict: expected ${input.expected_revision}, current ${existing.current_revision}`,
      );
    }
    if (existing.current_digest === digest
      && existing.kind === format.kind
      && existing.media_type === format.mediaType) {
      const revision = getRevisionRow(sessionId, artifactId, existing.current_revision)!;
      return publishedFromRows(sessionId, artifactId, existing, revision);
    }

    const nextRevision = existing.current_revision + 1;
    const updatedAt = nowIso();
    getDb().prepare(`
      INSERT INTO voice_artifact_revisions (
        session_id, artifact_id, revision, title, kind, media_type,
        digest, filename, size_bytes, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      sessionId,
      artifactId,
      nextRevision,
      title,
      format.kind,
      format.mediaType,
      digest,
      filename,
      stat.size,
      updatedAt,
    );
    const update = getDb().prepare(`
      UPDATE voice_artifacts
      SET title = ?, kind = ?, media_type = ?, current_revision = ?,
          current_digest = ?, current_filename = ?, updated_at = ?
      WHERE session_id = ? AND artifact_id = ? AND current_revision = ?
    `).run(
      title,
      format.kind,
      format.mediaType,
      nextRevision,
      digest,
      filename,
      updatedAt,
      sessionId,
      artifactId,
      existing.current_revision,
    );
    if (update.changes !== 1) {
      throw new VoiceArtifactRevisionConflictError("voice artifact changed during publication");
    }
    const artifact = getArtifactRow(sessionId, artifactId)!;
    const revision = getRevisionRow(sessionId, artifactId, nextRevision)!;
    return publishedFromRows(sessionId, artifactId, artifact, revision);
  });
}

export function resolveVoiceArtifactRevision(
  sessionIdInput: string,
  artifactIdInput: string,
  revisionInput?: number,
): ResolvedVoiceArtifactRevision {
  const sessionId = safeSessionId(sessionIdInput);
  const artifactId = safeArtifactId(artifactIdInput);
  const artifact = getArtifactRow(sessionId, artifactId);
  if (!artifact) throw new Error("voice artifact not found");
  const revisionNumber = revisionInput ?? artifact.current_revision;
  if (!Number.isInteger(revisionNumber) || revisionNumber < 1) throw new Error("invalid voice artifact revision");
  const revision = getRevisionRow(sessionId, artifactId, revisionNumber);
  if (!revision) throw new Error("voice artifact revision not found");
  return {
    ...publishedFromRows(sessionId, artifactId, artifact, revision),
    path: resolveVoiceArtifact(sessionId, revision.filename),
  };
}
