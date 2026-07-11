import * as fs from "node:fs";
import { randomBytes } from "node:crypto";
import * as path from "node:path";
import {
  DEFAULT_HRP_LIMITS,
  buildHrpArchive,
  generatePluginTypes,
  runPluginFixtureMatrix,
  scanPluginSource,
  sourceFilesForPack,
  verifyPluginArchive,
  type HrpLockFileV1,
  type PluginFixtureMatrixReport,
  type PluginSourceSnapshot,
} from "homerail-plugin-sdk";

export interface PluginValidationReport {
  root: string;
  plugin_id: string;
  plugin_version: string;
  valid: boolean;
  data_only_eligible: boolean;
  files: Array<{ path: string; sha256: string; size: number }>;
  issues: PluginSourceSnapshot["issues"];
}

export interface PluginPackReport {
  output: string;
  plugin_id: string;
  plugin_version: string;
  archive_digest: string;
  payload_digest: string;
  size: number;
  files: number;
}

export interface PluginVerifyReport {
  archive: string;
  plugin_id: string;
  plugin_version: string;
  archive_digest: string;
  payload_digest: string;
  data_only_eligible: boolean;
  files: HrpLockFileV1["files"];
}

export function resolvePluginRoot(value = "."): string {
  return path.resolve(value);
}

export function validatePluginProject(rootValue = "."): PluginValidationReport {
  const root = resolvePluginRoot(rootValue);
  const snapshot = scanPluginSource(root);
  return {
    root,
    plugin_id: snapshot.manifest.id,
    plugin_version: snapshot.manifest.version,
    valid: snapshot.valid,
    data_only_eligible: snapshot.m4_data_only_eligible,
    files: [...snapshot.files.entries()]
      .map(([filePath, content]) => ({
        path: filePath,
        sha256: snapshot.file_digests.get(filePath) ?? "",
        size: content.byteLength,
      }))
      .sort((left, right) => Buffer.compare(Buffer.from(left.path), Buffer.from(right.path))),
    issues: snapshot.issues,
  };
}

export function codegenPluginProject(
  rootValue = ".",
  options: { check?: boolean } = {},
): { root: string; output: string; changed: boolean; checked: boolean } {
  const root = resolvePluginRoot(rootValue);
  const result = generatePluginTypes(root, options);
  return { root, ...result, checked: options.check === true };
}

export function testPluginProject(rootValue = ".", options: { locale?: string } = {}): PluginFixtureMatrixReport & {
  root: string;
  plugin_id: string;
  plugin_version: string;
} {
  const root = resolvePluginRoot(rootValue);
  const snapshot = scanPluginSource(root);
  if (!snapshot.valid) {
    throw new Error(`Plugin validation failed: ${JSON.stringify(snapshot.issues)}`);
  }
  return {
    root,
    plugin_id: snapshot.manifest.id,
    plugin_version: snapshot.manifest.version,
    ...runPluginFixtureMatrix(root, options),
  };
}

export function defaultPluginArchivePath(root: string, version: string): string {
  return path.join(path.dirname(root), `${path.basename(root)}-${version}.hrp`);
}

function lstatIfPresent(filePath: string): fs.Stats | undefined {
  try {
    return fs.lstatSync(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function assertDirectoryIsSafe(directory: string): void {
  const stat = fs.lstatSync(directory);
  if (stat.isSymbolicLink()) {
    throw new Error(`Plugin archive output parent must not contain a symlink: ${directory}`);
  }
  if (!stat.isDirectory()) {
    throw new Error(`Plugin archive output parent must contain only directories: ${directory}`);
  }
}

/**
 * Create missing output directories one component at a time. Recursive mkdir
 * follows symlinks in an existing parent, so it is not suitable at this trust
 * boundary.
 */
function ensureSafeOutputParent(output: string): string {
  const directory = path.dirname(output);
  const parsed = path.parse(directory);
  let current = parsed.root;
  assertDirectoryIsSafe(current);

  const relative = directory.slice(parsed.root.length);
  for (const component of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    const existing = lstatIfPresent(current);
    if (!existing) {
      try {
        fs.mkdirSync(current, { mode: 0o700 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
    }
    assertDirectoryIsSafe(current);
  }
  return directory;
}

function assertSafeOutputTarget(output: string, force: boolean): void {
  const existing = lstatIfPresent(output);
  if (!existing) return;
  if (existing.isSymbolicLink()) {
    throw new Error(`Plugin archive output must not be a symlink: ${output}`);
  }
  if (!existing.isFile()) {
    throw new Error(`Plugin archive output must be a regular file: ${output}`);
  }
  if (!force) {
    const error = new Error(`EEXIST: plugin archive output already exists, open '${output}'`) as NodeJS.ErrnoException;
    error.code = "EEXIST";
    throw error;
  }
}

function writeArchiveAtomically(output: string, archive: Buffer, force: boolean): void {
  const directory = ensureSafeOutputParent(output);
  assertSafeOutputTarget(output, force);

  let temporaryPath: string | undefined;
  let descriptor: number | undefined;
  try {
    for (let attempt = 0; attempt < 16; attempt += 1) {
      const candidate = path.join(
        directory,
        `.homerail-pack-${process.pid}-${randomBytes(8).toString("hex")}.tmp`,
      );
      try {
        descriptor = fs.openSync(candidate, "wx", 0o600);
        temporaryPath = candidate;
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
    }
    if (descriptor === undefined || temporaryPath === undefined) {
      throw new Error("Unable to allocate an exclusive temporary plugin archive file");
    }

    fs.writeFileSync(descriptor, archive);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;

    // Recheck every component and the destination immediately before publish.
    // rename replaces a symlink itself rather than following it, but rejecting
    // it here keeps the output contract explicit and catches directory swaps.
    ensureSafeOutputParent(output);
    assertSafeOutputTarget(output, force);

    if (force) {
      fs.renameSync(temporaryPath, output);
    } else {
      // Node does not expose renameat2(RENAME_NOREPLACE). A same-directory hard
      // link atomically publishes the completed inode while preserving the
      // no-clobber contract; the temporary name is then removed.
      fs.linkSync(temporaryPath, output);
      fs.unlinkSync(temporaryPath);
    }
    temporaryPath = undefined;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    if (temporaryPath !== undefined) {
      try {
        fs.unlinkSync(temporaryPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
  }
}

export function packPluginProject(
  rootValue = ".",
  options: { output?: string; force?: boolean } = {},
): PluginPackReport {
  const root = resolvePluginRoot(rootValue);
  const snapshot = scanPluginSource(root);
  if (!snapshot.valid) {
    throw new Error(`Cannot pack invalid plugin source: ${JSON.stringify(snapshot.issues)}`);
  }
  if (!snapshot.m4_data_only_eligible) {
    throw new Error("M4 can only pack plugins eligible for the data-only execution policy");
  }
  const built = buildHrpArchive(sourceFilesForPack(snapshot));
  const output = path.resolve(options.output ?? defaultPluginArchivePath(root, snapshot.manifest.version));
  writeArchiveAtomically(output, built.archive, options.force === true);
  return {
    output,
    plugin_id: snapshot.manifest.id,
    plugin_version: snapshot.manifest.version,
    archive_digest: built.archive_digest,
    payload_digest: built.lock.payload_digest,
    size: built.archive.byteLength,
    files: built.lock.files.length,
  };
}

export function readPluginArchive(archiveValue: string): { archivePath: string; content: Buffer } {
  const archivePath = path.resolve(archiveValue);
  const stat = fs.lstatSync(archivePath);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error("Plugin archive must be a regular file, not a symlink");
  }
  if (!stat.size || stat.size > DEFAULT_HRP_LIMITS.max_archive_bytes) {
    throw new Error(`Plugin archive must contain 1-${DEFAULT_HRP_LIMITS.max_archive_bytes} bytes`);
  }
  return { archivePath, content: fs.readFileSync(archivePath) };
}

export function verifyPluginArchiveFile(archiveValue: string): PluginVerifyReport {
  const { archivePath, content } = readPluginArchive(archiveValue);
  const verified = verifyPluginArchive(content);
  return {
    archive: archivePath,
    plugin_id: verified.snapshot.manifest.id,
    plugin_version: verified.snapshot.manifest.version,
    archive_digest: verified.archive_digest,
    payload_digest: verified.lock.payload_digest,
    data_only_eligible: verified.snapshot.m4_data_only_eligible,
    files: verified.lock.files,
  };
}
