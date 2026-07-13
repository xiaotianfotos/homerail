import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { Transform, type Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";
import { homerailHomePath, homerailWorkerWorkspacePath } from "./homerail-home.js";

const TAR_BLOCK_SIZE = 512;

export interface WorkspaceArtifactLimits {
  max_files: number;
  max_uncompressed_bytes: number;
  max_compressed_bytes: number;
  timeout_ms: number;
}

export interface WorkspaceArtifactArchiveRequest {
  workspace_id: string;
  path: string;
  archive: { format: "tar.gz"; deterministic: boolean };
  limits: WorkspaceArtifactLimits;
}

export interface WorkspaceArtifactArchive {
  path: string;
  sha256: string;
  size_bytes: number;
  uncompressed_bytes: number;
  file_count: number;
  entry_count: number;
}

interface ArchiveEntry {
  absolutePath: string;
  archivePath: string;
  type: "file" | "directory";
  size: number;
  executable: boolean;
}

function safeRelativePath(value: string): string {
  if (!value || value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value) || value.includes("\\") || value.includes("\0")) {
    throw new Error("artifact path must be a relative POSIX path");
  }
  const segments = value.split("/");
  if (!segments.every((segment) => segment && segment !== "." && segment !== "..")) {
    throw new Error("artifact path contains an unsafe path segment");
  }
  return segments.join("/");
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function checkDeadline(deadline: number): void {
  if (Date.now() > deadline) throw new Error("workspace artifact archive timed out");
}

function archiveNameParts(value: string): { name: string; prefix: string } {
  const normalized = value.split(path.sep).join("/");
  if (normalized.includes("\0")) throw new Error("artifact archive path contains a NUL byte");
  if (Buffer.byteLength(normalized) <= 100) return { name: normalized, prefix: "" };
  const slashes = [...normalized.matchAll(/\//g)].map((match) => match.index ?? -1).filter((index) => index > 0).reverse();
  for (const index of slashes) {
    const prefix = normalized.slice(0, index);
    const name = normalized.slice(index + 1);
    if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(name) <= 100) return { name, prefix };
  }
  throw new Error(`artifact archive path is too long for deterministic ustar: ${normalized}`);
}

function writeString(buffer: Buffer, offset: number, length: number, value: string): void {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length > length) throw new Error(`tar field exceeds ${length} bytes`);
  bytes.copy(buffer, offset);
}

function octal(value: number, length: number): string {
  const encoded = Math.max(0, Math.floor(value)).toString(8);
  if (encoded.length > length - 1) throw new Error("tar numeric field overflow");
  return `${encoded.padStart(length - 1, "0")}\0`;
}

function tarHeader(entry: ArchiveEntry): Buffer {
  const header = Buffer.alloc(TAR_BLOCK_SIZE, 0);
  const archivePath = entry.type === "directory" && !entry.archivePath.endsWith("/")
    ? `${entry.archivePath}/`
    : entry.archivePath;
  const names = archiveNameParts(archivePath);
  writeString(header, 0, 100, names.name);
  writeString(header, 100, 8, octal(entry.type === "directory" ? 0o755 : entry.executable ? 0o755 : 0o644, 8));
  writeString(header, 108, 8, octal(0, 8));
  writeString(header, 116, 8, octal(0, 8));
  writeString(header, 124, 12, octal(entry.type === "file" ? entry.size : 0, 12));
  writeString(header, 136, 12, octal(0, 12));
  header.fill(0x20, 148, 156);
  header[156] = entry.type === "directory" ? 0x35 : 0x30;
  writeString(header, 257, 6, "ustar\0");
  writeString(header, 263, 2, "00");
  writeString(header, 345, 155, names.prefix);
  const checksum = header.reduce((total, byte) => total + byte, 0);
  writeString(header, 148, 8, `${checksum.toString(8).padStart(6, "0")}\0 `);
  return header;
}

function collectEntries(
  source: string,
  archiveRoot: string,
  workspaceReal: string,
  limits: WorkspaceArtifactLimits,
  deadline: number,
): { entries: ArchiveEntry[]; uncompressedBytes: number; fileCount: number } {
  const entries: ArchiveEntry[] = [];
  let uncompressedBytes = 0;
  let fileCount = 0;

  const visit = (absolutePath: string, archivePath: string) => {
    checkDeadline(deadline);
    const stat = fs.lstatSync(absolutePath);
    if (stat.isSymbolicLink()) throw new Error(`symbolic links are not allowed in workspace artifacts: ${archivePath}`);
    const real = fs.realpathSync(absolutePath);
    if (!isWithin(workspaceReal, real)) throw new Error(`workspace artifact entry escaped workspace root: ${archivePath}`);
    if (stat.isDirectory()) {
      entries.push({ absolutePath, archivePath, type: "directory", size: 0, executable: true });
      if (entries.length > limits.max_files) throw new Error(`workspace artifact exceeds max_files (${limits.max_files})`);
      for (const child of fs.readdirSync(absolutePath).sort()) {
        visit(path.join(absolutePath, child), `${archivePath}/${child}`);
      }
      return;
    }
    if (!stat.isFile()) throw new Error(`unsupported workspace artifact entry type: ${archivePath}`);
    uncompressedBytes += stat.size;
    fileCount += 1;
    entries.push({
      absolutePath,
      archivePath,
      type: "file",
      size: stat.size,
      executable: (stat.mode & 0o111) !== 0,
    });
    if (entries.length > limits.max_files) throw new Error(`workspace artifact exceeds max_files (${limits.max_files})`);
    if (uncompressedBytes > limits.max_uncompressed_bytes) {
      throw new Error(`workspace artifact exceeds max_uncompressed_bytes (${limits.max_uncompressed_bytes})`);
    }
  };

  visit(source, archiveRoot);
  return { entries, uncompressedBytes, fileCount };
}

function writeChunk(stream: Writable, chunk: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onDrain = () => {
      cleanup();
      resolve();
    };
    const cleanup = () => {
      stream.off("error", onError);
      stream.off("drain", onDrain);
    };
    stream.once("error", onError);
    if (stream.write(chunk)) {
      cleanup();
      resolve();
    } else {
      stream.once("drain", onDrain);
    }
  });
}

async function writeFileEntry(gzip: Writable, entry: ArchiveEntry, deadline: number): Promise<void> {
  const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0);
  const fd = fs.openSync(entry.absolutePath, flags);
  let readBytes = 0;
  try {
    const opened = fs.fstatSync(fd);
    if (!opened.isFile() || opened.size !== entry.size) {
      throw new Error(`workspace artifact file changed while packaging: ${entry.archivePath}`);
    }
    if (entry.size > 0) {
      const stream = fs.createReadStream(entry.absolutePath, { fd, autoClose: false, start: 0, end: entry.size - 1 });
      for await (const raw of stream) {
        checkDeadline(deadline);
        const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
        readBytes += chunk.length;
        await writeChunk(gzip, chunk);
      }
    }
  } finally {
    fs.closeSync(fd);
  }
  if (readBytes !== entry.size) throw new Error(`workspace artifact file changed while packaging: ${entry.archivePath}`);
  const remainder = entry.size % TAR_BLOCK_SIZE;
  if (remainder !== 0) await writeChunk(gzip, Buffer.alloc(TAR_BLOCK_SIZE - remainder));
}

export async function createWorkspaceArtifactArchive(
  request: WorkspaceArtifactArchiveRequest,
): Promise<WorkspaceArtifactArchive> {
  if (request.archive.format !== "tar.gz") throw new Error(`unsupported artifact archive format: ${request.archive.format}`);
  if (!request.archive.deterministic) throw new Error("workspace artifact archives must be deterministic");
  const relativePath = safeRelativePath(request.path);
  const deadline = Date.now() + request.limits.timeout_ms;
  const workspaceRoot = homerailWorkerWorkspacePath(request.workspace_id);
  if (!fs.existsSync(workspaceRoot)) throw new Error(`workspace does not exist: ${request.workspace_id}`);
  const workspaceReal = fs.realpathSync(workspaceRoot);
  const source = path.resolve(workspaceRoot, ...relativePath.split("/"));
  if (!isWithin(path.resolve(workspaceRoot), source) || !fs.existsSync(source)) {
    throw new Error(`workspace artifact directory does not exist: ${relativePath}`);
  }
  const sourceStat = fs.lstatSync(source);
  if (!sourceStat.isDirectory() || sourceStat.isSymbolicLink()) {
    throw new Error("workspace artifact source must be a directory and may not be a symbolic link");
  }
  const sourceReal = fs.realpathSync(source);
  if (!isWithin(workspaceReal, sourceReal)) throw new Error("workspace artifact source escaped workspace root");
  const archiveRoot = path.posix.basename(relativePath);
  const collected = collectEntries(source, archiveRoot, workspaceReal, request.limits, deadline);

  const stagingDir = homerailHomePath("node", "artifact-staging");
  fs.mkdirSync(stagingDir, { recursive: true, mode: 0o700 });
  const outputPath = path.join(stagingDir, `${randomUUID()}.tar.gz`);
  const hash = createHash("sha256");
  let compressedBytes = 0;
  const gzip = createGzip({ level: 9 });
  const counter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      compressedBytes += chunk.length;
      if (compressedBytes > request.limits.max_compressed_bytes) {
        callback(new Error(`workspace artifact exceeds max_compressed_bytes (${request.limits.max_compressed_bytes})`));
        return;
      }
      hash.update(chunk);
      callback(null, chunk);
    },
  });
  const output = fs.createWriteStream(outputPath, { mode: 0o600 });
  const completed = pipeline(gzip, counter, output);
  const timeout = setTimeout(() => gzip.destroy(new Error("workspace artifact archive timed out")), request.limits.timeout_ms);
  timeout.unref?.();

  try {
    for (const entry of collected.entries) {
      checkDeadline(deadline);
      await writeChunk(gzip, tarHeader(entry));
      if (entry.type === "file") await writeFileEntry(gzip, entry, deadline);
    }
    await writeChunk(gzip, Buffer.alloc(TAR_BLOCK_SIZE * 2));
    gzip.end();
    await completed;
    return {
      path: outputPath,
      sha256: hash.digest("hex"),
      size_bytes: compressedBytes,
      uncompressed_bytes: collected.uncompressedBytes,
      file_count: collected.fileCount,
      entry_count: collected.entries.length,
    };
  } catch (error) {
    gzip.destroy();
    await completed.catch(() => undefined);
    fs.rmSync(outputPath, { force: true });
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}
