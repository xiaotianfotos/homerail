import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { ensureDefaultWorkspacePath, getDataRoot } from "../config/env.js";
import { getProject } from "../persistence/projects-changes.js";

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
  filename: string;
  url: string;
  media_type: string;
  kind: "image" | "html";
  size_bytes: number;
  digest: string;
}

function safeSessionId(value: string): string {
  if (!/^[A-Za-z0-9_.-]+$/.test(value)) throw new Error("invalid voice session id");
  return value;
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
}): PublishedVoiceArtifact {
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
  const filename = `${slug(input.title || path.basename(source, extension))}-${digest.slice(0, 16)}${outputExtension}`;
  const destinationRoot = voiceArtifactRoot(input.session_id);
  const destination = path.join(destinationRoot, filename);
  fs.mkdirSync(destinationRoot, { recursive: true });
  if (!fs.existsSync(destination)) fs.writeFileSync(destination, content, { mode: 0o600 });
  return {
    filename,
    url: `/api/voice-agent/sessions/${encodeURIComponent(input.session_id)}/artifacts/${encodeURIComponent(filename)}`,
    media_type: format.mediaType,
    kind: format.kind,
    size_bytes: stat.size,
    digest,
  };
}
