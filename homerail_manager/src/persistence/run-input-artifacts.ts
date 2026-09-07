import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type {
  DagRunInputArtifactDescriptor,
  DagRunInputBinding,
  DagRunInputBindingRequest,
  DagRunInputMediaType,
  DagWorkspaceInputProjection,
  StageDagRunInputRequest,
} from "homerail-protocol";
import { getDataRoot, getHomerailHome } from "../config/env.js";
import { getDb } from "./db.js";

export const MAX_DAG_RUN_INPUT_FILES = 16;
export const MAX_DAG_RUN_INPUT_BYTES = 1024 * 1024;

const SCOPE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const FILE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const MEDIA_TYPES = new Set<string>(["text/markdown", "text/plain", "application/json"]);

interface InputArtifactRow {
  artifact_id: string;
  scope_id: string;
  name: string;
  media_type: DagRunInputMediaType;
  sha256: string;
  size_bytes: number;
  created_at: number;
}

interface RunInputRow extends InputArtifactRow {
  run_id: string;
  logical_name: string;
  mount_path: string;
  bound_at: number;
}

function assertScope(value: string): string {
  const normalized = value.trim();
  if (!SCOPE_PATTERN.test(normalized)) {
    throw new Error("input_scope must be a 1-128 character stable identifier");
  }
  return normalized;
}

function assertName(value: string): string {
  const normalized = value.trim();
  if (!FILE_NAME_PATTERN.test(normalized) || normalized === "." || normalized === "..") {
    throw new Error("run input name must be a safe file name");
  }
  return normalized;
}

function assertLogicalName(value: string): string {
  const normalized = value.trim();
  if (!IDENTIFIER_PATTERN.test(normalized)) {
    throw new Error("run input logical_name must be a safe identifier");
  }
  return normalized;
}

function assertArtifactId(value: string): string {
  const normalized = value.trim();
  if (!/^input-[0-9a-f]{64}$/.test(normalized)) {
    throw new Error("run input artifact_id is invalid");
  }
  return normalized;
}

function mountPathSegments(value: string): string[] {
  const normalized = value.replace(/\\/g, "/").trim();
  if (!normalized || normalized.startsWith("/") || /^[A-Za-z]:\//.test(normalized)) {
    throw new Error("run input mount_path must be relative");
  }
  const segments = normalized.split("/");
  if (
    segments.length < 2
    || segments[0] !== "input"
    || segments.some((segment) => (
      !segment
      || segment === "."
      || segment === ".."
      || !/^[A-Za-z0-9._-]+$/.test(segment)
    ))
  ) {
    throw new Error("run input mount_path must be a safe path below input/");
  }
  if (normalized.length > 512) throw new Error("run input mount_path exceeds 512 characters");
  return segments;
}

function mediaType(value: string): DagRunInputMediaType {
  if (!MEDIA_TYPES.has(value)) throw new Error(`unsupported run input media_type: ${value}`);
  return value as DagRunInputMediaType;
}

function artifactDescriptor(row: InputArtifactRow): DagRunInputArtifactDescriptor {
  return {
    artifact_id: row.artifact_id,
    scope_id: row.scope_id,
    name: row.name,
    media_type: row.media_type,
    sha256: row.sha256,
    size_bytes: row.size_bytes,
    created_at: row.created_at,
  };
}

function blobPath(sha256: string): string {
  return path.join(getDataRoot(), "run-inputs", "blobs", sha256.slice(0, 2), sha256, "blob");
}

function ensurePrivateDir(value: string): void {
  fs.mkdirSync(value, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(value, 0o700); } catch { /* Best effort on non-POSIX filesystems. */ }
}

function verifyBytes(bytes: Uint8Array, expectedSha256: string, expectedSize: number): void {
  if (bytes.byteLength !== expectedSize) throw new Error("run input artifact size does not match its descriptor");
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== expectedSha256) throw new Error("run input artifact digest does not match its descriptor");
}

function readArtifactBytes(record: Pick<InputArtifactRow, "sha256" | "size_bytes">): Buffer {
  const file = blobPath(record.sha256);
  const bytes = fs.readFileSync(file);
  verifyBytes(bytes, record.sha256, record.size_bytes);
  return bytes;
}

function persistBlob(bytes: Uint8Array, sha256: string): void {
  const file = blobPath(sha256);
  if (fs.existsSync(file)) {
    verifyBytes(fs.readFileSync(file), sha256, bytes.byteLength);
    return;
  }
  const dir = path.dirname(file);
  ensurePrivateDir(dir);
  const temporary = path.join(dir, `.blob-${randomUUID()}.tmp`);
  fs.writeFileSync(temporary, bytes, { flag: "wx", mode: 0o600 });
  try {
    fs.renameSync(temporary, file);
  } finally {
    try { fs.unlinkSync(temporary); } catch { /* Rename already consumed it. */ }
  }
  verifyBytes(fs.readFileSync(file), sha256, bytes.byteLength);
}

export function stageDagRunInputArtifact(request: StageDagRunInputRequest): DagRunInputArtifactDescriptor {
  const scopeId = assertScope(request.scope_id);
  const name = assertName(request.name);
  const normalizedMediaType = mediaType(request.media_type);
  if (typeof request.content !== "string") throw new Error("run input content must be a string");
  const bytes = Buffer.from(request.content, "utf8");
  if (bytes.byteLength < 1 || bytes.byteLength > MAX_DAG_RUN_INPUT_BYTES) {
    throw new Error(`run input content must contain 1-${MAX_DAG_RUN_INPUT_BYTES} UTF-8 bytes`);
  }
  if (normalizedMediaType === "application/json") {
    try { JSON.parse(request.content); } catch { throw new Error("application/json run input must contain valid JSON"); }
  }
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const identity = createHash("sha256")
    .update(`${scopeId}\0${name}\0${normalizedMediaType}\0${sha256}`)
    .digest("hex");
  const artifactId = `input-${identity}`;
  persistBlob(bytes, sha256);
  const createdAt = Date.now();
  getDb().prepare(`
    INSERT OR IGNORE INTO dag_input_artifacts(
      artifact_id, scope_id, name, media_type, sha256, size_bytes, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(artifactId, scopeId, name, normalizedMediaType, sha256, bytes.byteLength, createdAt);
  const record = getDagRunInputArtifact(artifactId);
  if (!record
    || record.scope_id !== scopeId
    || record.name !== name
    || record.media_type !== normalizedMediaType
    || record.sha256 !== sha256
    || record.size_bytes !== bytes.byteLength) {
    throw new Error("run input artifact identity conflicts with persisted metadata");
  }
  return record;
}

export function getDagRunInputArtifact(artifactId: string): DagRunInputArtifactDescriptor | undefined {
  const row = getDb().prepare(`
    SELECT artifact_id, scope_id, name, media_type, sha256, size_bytes, created_at
    FROM dag_input_artifacts
    WHERE artifact_id = ?
  `).get(assertArtifactId(artifactId)) as InputArtifactRow | undefined;
  return row ? artifactDescriptor(row) : undefined;
}

export function resolveDagRunInputBindings(
  scopeId: string,
  requests: DagRunInputBindingRequest[],
): DagRunInputBinding[] {
  const scope = assertScope(scopeId);
  if (!Array.isArray(requests) || requests.length < 1 || requests.length > MAX_DAG_RUN_INPUT_FILES) {
    throw new Error(`input_artifacts must contain 1-${MAX_DAG_RUN_INPUT_FILES} bindings`);
  }
  const logicalNames = new Set<string>();
  const mountPaths = new Set<string>();
  return requests.map((request) => {
    const artifactId = assertArtifactId(request.artifact_id);
    const logicalName = assertLogicalName(request.logical_name);
    const mountPath = mountPathSegments(request.mount_path).join("/");
    if (logicalNames.has(logicalName)) throw new Error(`duplicate run input logical_name: ${logicalName}`);
    if (mountPaths.has(mountPath)) throw new Error(`duplicate run input mount_path: ${mountPath}`);
    logicalNames.add(logicalName);
    mountPaths.add(mountPath);
    const artifact = getDagRunInputArtifact(artifactId);
    if (!artifact) throw new Error(`run input artifact was not found: ${artifactId}`);
    if (artifact.scope_id !== scope) throw new Error(`run input artifact belongs to a different scope: ${artifactId}`);
    return {
      ...artifact,
      run_id: "",
      logical_name: logicalName,
      mount_path: mountPath,
      bound_at: 0,
    };
  });
}

export function bindDagRunInputs(runId: string, bindings: DagRunInputBinding[]): DagRunInputBinding[] {
  const now = Date.now();
  const insert = getDb().prepare(`
    INSERT INTO dag_run_inputs(
      run_id, logical_name, artifact_id, mount_path, sha256, size_bytes,
      media_type, name, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const binding of bindings) {
    const boundAt = binding.bound_at > 0 ? binding.bound_at : now;
    insert.run(
      runId,
      binding.logical_name,
      binding.artifact_id,
      binding.mount_path,
      binding.sha256,
      binding.size_bytes,
      binding.media_type,
      binding.name,
      boundAt,
    );
  }
  return listDagRunInputs(runId);
}

export function listDagRunInputs(runId: string): DagRunInputBinding[] {
  const rows = getDb().prepare(`
    SELECT i.artifact_id, a.scope_id, i.name, i.media_type, i.sha256, i.size_bytes,
           a.created_at, i.run_id, i.logical_name, i.mount_path, i.created_at AS bound_at
    FROM dag_run_inputs i
    JOIN dag_input_artifacts a ON a.artifact_id = i.artifact_id
    WHERE i.run_id = ?
    ORDER BY i.logical_name
  `).all(runId) as RunInputRow[];
  return rows.map((row) => ({ ...artifactDescriptor(row),
    run_id: row.run_id,
    logical_name: row.logical_name,
    mount_path: row.mount_path,
    bound_at: row.bound_at,
  }));
}

function runWorkspacePath(runId: string): string {
  const segments = runId.replace(/\\/g, "/").split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === ".." || !/^[A-Za-z0-9._-]+$/.test(segment))) {
    throw new Error("run id cannot be projected into a workspace path");
  }
  const root = path.resolve(getHomerailHome(), "workspace");
  const target = path.resolve(root, ...segments);
  const relative = path.relative(root, target);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("run input workspace path is unsafe");
  }
  return target;
}

function assertNoSymlinkPath(root: string, segments: string[]): void {
  let current = root;
  for (const segment of segments) {
    current = path.join(current, segment);
    if (!fs.existsSync(current)) continue;
    if (fs.lstatSync(current).isSymbolicLink()) throw new Error("run input projection cannot traverse a symlink");
  }
}

export function materializeDagRunInputs(
  runId: string,
  bindings: DagRunInputBinding[] = listDagRunInputs(runId),
): string {
  const workspace = runWorkspacePath(runId);
  const inputRoot = path.join(workspace, "input");
  ensurePrivateDir(inputRoot);
  const directories = new Set<string>([inputRoot]);
  for (const binding of bindings) {
    const segments = mountPathSegments(binding.mount_path);
    assertNoSymlinkPath(workspace, segments);
    const target = path.resolve(workspace, ...segments);
    const relative = path.relative(inputRoot, target);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error("run input projection escaped input root");
    }
    const parent = path.dirname(target);
    fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
    let cursor = parent;
    while (cursor === inputRoot || cursor.startsWith(`${inputRoot}${path.sep}`)) {
      directories.add(cursor);
      if (cursor === inputRoot) break;
      cursor = path.dirname(cursor);
    }
    const bytes = readArtifactBytes(binding);
    if (fs.existsSync(target)) {
      if (!fs.lstatSync(target).isFile()) throw new Error("run input projection target is not a regular file");
      verifyBytes(fs.readFileSync(target), binding.sha256, binding.size_bytes);
    } else {
      const temporary = path.join(parent, `.input-${randomUUID()}.tmp`);
      fs.writeFileSync(temporary, bytes, { flag: "wx", mode: 0o400 });
      fs.renameSync(temporary, target);
    }
    try { fs.chmodSync(target, 0o444); } catch { /* Mount policy is the hard boundary. */ }
  }
  for (const directory of Array.from(directories).sort((left, right) => right.length - left.length)) {
    try { fs.chmodSync(directory, 0o555); } catch { /* Best effort on non-POSIX filesystems. */ }
  }
  return inputRoot;
}

export function verifyDagRunInputs(runId: string): DagRunInputBinding[] {
  const bindings = listDagRunInputs(runId);
  for (const binding of bindings) readArtifactBytes(binding);
  if (bindings.length > 0) materializeDagRunInputs(runId, bindings);
  return bindings;
}

export function dagWorkspaceInputProjections(runId: string): DagWorkspaceInputProjection[] {
  return listDagRunInputs(runId).map((binding) => {
    const bytes = readArtifactBytes(binding);
    return {
      logical_name: binding.logical_name,
      mount_path: binding.mount_path,
      media_type: binding.media_type,
      sha256: binding.sha256,
      size_bytes: binding.size_bytes,
      content_base64: bytes.toString("base64"),
    };
  });
}

export function dagRunInputPath(runId: string, logicalName: string): string {
  const wanted = assertLogicalName(logicalName);
  const binding = listDagRunInputs(runId).find((entry) => entry.logical_name === wanted);
  if (!binding) throw new Error(`run input is not bound: ${wanted}`);
  materializeDagRunInputs(runId, [binding]);
  return path.resolve(runWorkspacePath(runId), ...mountPathSegments(binding.mount_path));
}
