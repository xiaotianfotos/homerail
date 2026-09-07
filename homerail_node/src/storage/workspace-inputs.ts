import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type {
  DagWorkspaceInputProjection,
} from "homerail-protocol";
import { homerailWorkerWorkspacePath } from "./homerail-home.js";

const MAX_INPUTS = 16;
const MAX_BYTES = 1024 * 1024;
const MEDIA_TYPES = new Set<string>(["text/markdown", "text/plain", "application/json"]);

function segmentsFor(value: string): string[] {
  const normalized = value.replace(/\\/g, "/").trim();
  const segments = normalized.split("/");
  if (
    normalized.length > 512
    || segments.length < 2
    || segments[0] !== "input"
    || segments.some((segment) => (
      !segment || segment === "." || segment === ".." || !/^[A-Za-z0-9._-]+$/.test(segment)
    ))
  ) {
    throw new Error("workspace input mount_path must be a safe path below input/");
  }
  return segments;
}

function decodeProjection(value: unknown): DagWorkspaceInputProjection & { bytes: Buffer; segments: string[] } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("workspace input projection must be an object");
  }
  const raw = value as Record<string, unknown>;
  const logicalName = typeof raw.logical_name === "string" ? raw.logical_name.trim() : "";
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(logicalName)) {
    throw new Error("workspace input logical_name is invalid");
  }
  const mountPath = typeof raw.mount_path === "string" ? raw.mount_path : "";
  const segments = segmentsFor(mountPath);
  const mediaType = typeof raw.media_type === "string" ? raw.media_type : "";
  if (!MEDIA_TYPES.has(mediaType)) throw new Error("workspace input media_type is invalid");
  const sha256 = typeof raw.sha256 === "string" ? raw.sha256 : "";
  if (!/^[0-9a-f]{64}$/.test(sha256)) throw new Error("workspace input sha256 is invalid");
  const sizeBytes = Number(raw.size_bytes);
  if (!Number.isInteger(sizeBytes) || sizeBytes < 1 || sizeBytes > MAX_BYTES) {
    throw new Error("workspace input size_bytes is invalid");
  }
  const encoded = typeof raw.content_base64 === "string" ? raw.content_base64 : "";
  if (!encoded || encoded.length > Math.ceil(MAX_BYTES / 3) * 4 + 8) {
    throw new Error("workspace input content_base64 is invalid");
  }
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.byteLength !== sizeBytes || createHash("sha256").update(bytes).digest("hex") !== sha256) {
    throw new Error("workspace input content does not match its descriptor");
  }
  return {
    logical_name: logicalName,
    mount_path: segments.join("/"),
    media_type: mediaType as DagWorkspaceInputProjection["media_type"],
    sha256,
    size_bytes: sizeBytes,
    content_base64: encoded,
    bytes,
    segments,
  };
}

function assertPathHasNoSymlink(root: string, segments: string[]): void {
  let current = root;
  for (const segment of segments) {
    current = path.join(current, segment);
    if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) {
      throw new Error("workspace input projection cannot traverse a symlink");
    }
  }
}

function listFiles(root: string): string[] {
  if (!fs.existsSync(root)) return [];
  const files: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error("workspace input projection contains a symlink");
      if (entry.isDirectory()) visit(target);
      else if (entry.isFile()) files.push(path.relative(root, target).replace(/\\/g, "/"));
      else throw new Error("workspace input projection contains an unsupported file type");
    }
  };
  visit(root);
  return files.sort();
}

export function materializeWorkspaceInputs(workspaceId: string, rawInputs: unknown): number {
  if (rawInputs === undefined) return 0;
  if (!Array.isArray(rawInputs) || rawInputs.length < 1 || rawInputs.length > MAX_INPUTS) {
    throw new Error(`workspace_inputs must contain 1-${MAX_INPUTS} projections`);
  }
  const projections = rawInputs.map(decodeProjection);
  const logicalNames = new Set<string>();
  const mountPaths = new Set<string>();
  for (const projection of projections) {
    if (logicalNames.has(projection.logical_name)) throw new Error("workspace input logical_name is duplicated");
    if (mountPaths.has(projection.mount_path)) throw new Error("workspace input mount_path is duplicated");
    logicalNames.add(projection.logical_name);
    mountPaths.add(projection.mount_path);
  }

  const workspace = path.resolve(homerailWorkerWorkspacePath(workspaceId));
  const inputRoot = path.resolve(workspace, "input");
  fs.mkdirSync(inputRoot, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(inputRoot, 0o700); } catch { /* Best effort before read-only mount. */ }
  const directories = new Set<string>([inputRoot]);
  for (const projection of projections) {
    assertPathHasNoSymlink(workspace, projection.segments);
    const target = path.resolve(workspace, ...projection.segments);
    const relative = path.relative(inputRoot, target);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error("workspace input projection escaped input root");
    }
    const parent = path.dirname(target);
    fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
    let cursor = parent;
    while (cursor === inputRoot || cursor.startsWith(`${inputRoot}${path.sep}`)) {
      directories.add(cursor);
      if (cursor === inputRoot) break;
      cursor = path.dirname(cursor);
    }
    if (fs.existsSync(target)) {
      if (!fs.lstatSync(target).isFile()) throw new Error("workspace input target is not a regular file");
      const existing = fs.readFileSync(target);
      if (
        existing.byteLength !== projection.size_bytes
        || createHash("sha256").update(existing).digest("hex") !== projection.sha256
      ) {
        throw new Error("workspace input target conflicts with its immutable descriptor");
      }
    } else {
      const temporary = path.join(parent, `.input-${randomUUID()}.tmp`);
      fs.writeFileSync(temporary, projection.bytes, { flag: "wx", mode: 0o400 });
      fs.renameSync(temporary, target);
    }
    try { fs.chmodSync(target, 0o444); } catch { /* The nested read-only mount is authoritative. */ }
  }

  const expectedFiles = projections
    .map((projection) => projection.segments.slice(1).join("/"))
    .sort();
  const actualFiles = listFiles(inputRoot);
  if (actualFiles.length !== expectedFiles.length
    || actualFiles.some((file, index) => file !== expectedFiles[index])) {
    throw new Error("workspace input directory contains an unstaged file");
  }
  for (const directory of Array.from(directories).sort((left, right) => right.length - left.length)) {
    try { fs.chmodSync(directory, 0o555); } catch { /* Best effort on non-POSIX filesystems. */ }
  }
  return projections.length;
}
