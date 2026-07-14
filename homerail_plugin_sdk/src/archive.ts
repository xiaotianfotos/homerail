import {
  createHash,
  createPublicKey,
  KeyObject,
  sign as signMessage,
  verify as verifyMessage,
  type KeyLike,
} from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { decodeHomerailPluginUtf8 } from "homerail-protocol";

export const HRP_LOCK_FILE = "homerail.lock.json" as const;
export const HRP_MANIFEST_FILE = "homerail.plugin.json" as const;
/** Optional detached statement. It is deliberately outside the payload lock so
 * M6 can sign the lock digest without creating a lock/signature hash cycle. */
export const HRP_SIGNATURE_FILE = "homerail.signature.json" as const;
export const HRP_LOCK_VERSION = 1 as const;
export const DEFAULT_HRP_LIMITS = Object.freeze({
  max_archive_bytes: 8 * 1024 * 1024,
  max_uncompressed_bytes: 4 * 1024 * 1024,
  max_file_bytes: 512 * 1024,
  max_entries: 256,
});

export interface HrpLimits {
  max_archive_bytes: number;
  max_uncompressed_bytes: number;
  max_file_bytes: number;
  max_entries: number;
}

export interface HrpLockFileV1 {
  lock_version: 1;
  manifest: typeof HRP_MANIFEST_FILE;
  plugin: { id: string; version: string };
  manifest_sha256: string;
  payload_digest: string;
  files: Array<{ path: string; size: number; sha256: string }>;
}

/**
 * Detached publisher statement. The signature file is intentionally not part
 * of the payload lock: it signs the immutable lock identity and can therefore
 * be added without a digest cycle or installation-time code execution.
 */
export interface HrpSignatureFileV1 {
  signature_version: 1;
  algorithm: "Ed25519";
  publisher: string;
  key_id: string;
  public_key_spki: string;
  payload_digest: string;
  signature: string;
}

export interface HrpPublisherTrustEntry {
  publisher: string;
  key_id: string;
  public_key_spki: string;
  state: "trusted" | "revoked";
}

export type HrpSignatureTrustState = "unsigned" | "verified" | "untrusted" | "revoked";

export interface VerifiedHrpSignature {
  statement: HrpSignatureFileV1;
  trust_state: Exclude<HrpSignatureTrustState, "unsigned">;
}

export interface HrpSourceFile {
  path: string;
  content: Buffer;
}

export interface VerifiedHrpArchive {
  archive_digest: string;
  lock: HrpLockFileV1;
  files: ReadonlyMap<string, Buffer>;
  signature?: VerifiedHrpSignature;
  signature_state: HrpSignatureTrustState;
}

const ZIP_LOCAL_FILE = 0x04034b50;
const ZIP_CENTRAL_FILE = 0x02014b50;
const ZIP_END = 0x06054b50;
const ZIP_UTF8 = 0x0800;
const ZIP_VERSION = 20;
const ZIP_UNIX_VERSION = (3 << 8) | ZIP_VERSION;
const ZIP_DOS_DATE_1980_01_01 = 0x0021;
const PORTABLE_SEGMENT = /^[A-Za-z0-9._-]+$/;
const SHA256 = /^[a-f0-9]{64}$/;
const SIGNATURE_KEY_ID = /^sha256:[a-f0-9]{64}$/;
const BASE64URL = /^[A-Za-z0-9_-]+$/;
const WINDOWS_DEVICE = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;
/** Common filesystems cap a single filename component at 255 bytes/code units. */
export const MAX_HRP_SEGMENT_UTF8_BYTES = 255;
/** Keep package-relative paths below the legacy Windows MAX_PATH boundary. */
export const MAX_HRP_PATH_UTF8_BYTES = 240;

const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
    }
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(buffer: Buffer): number {
  let value = 0xffffffff;
  for (const byte of buffer) value = crcTable[(value ^ byte) & 0xff] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

function sha256(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

function utf8Compare(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => utf8Compare(left, right))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
    .join(",")}}`;
}

export function canonicalHrpJsonBytes(value: unknown): Buffer {
  return Buffer.from(`${canonicalJson(value)}\n`, "utf8");
}

function assertPublisher(value: string): string {
  if (
    typeof value !== "string"
    || !value
    || value.length > 128
    || value !== value.normalize("NFC")
    || /[\u0000-\u001f\u007f]/.test(value)
  ) throw new Error("HRP signature publisher must be 1-128 safe NFC characters");
  return value;
}

function decodeBase64Url(value: string, label: string, expectedBytes?: number): Buffer {
  if (typeof value !== "string" || !BASE64URL.test(value)) {
    throw new Error(`HRP signature ${label} must be unpadded base64url`);
  }
  const decoded = Buffer.from(value, "base64url");
  if (decoded.toString("base64url") !== value || (expectedBytes !== undefined && decoded.byteLength !== expectedBytes)) {
    throw new Error(`HRP signature ${label} has an invalid encoding or size`);
  }
  return decoded;
}

function signatureKeyId(publicKeySpki: Buffer): string {
  return `sha256:${sha256(publicKeySpki)}`;
}

export function canonicalHrpSignatureMessage(lock: HrpLockFileV1): Buffer {
  return canonicalHrpJsonBytes({
    context: "homerail.hrp.signature.v1",
    lock_version: lock.lock_version,
    plugin: lock.plugin,
    payload_digest: lock.payload_digest,
  });
}

function parseHrpSignature(content: Buffer, lock: HrpLockFileV1): {
  statement: HrpSignatureFileV1;
  publicKeySpki: Buffer;
  signature: Buffer;
} {
  let value: unknown;
  try {
    value = JSON.parse(decodeHomerailPluginUtf8(content, HRP_SIGNATURE_FILE));
  } catch (cause) {
    throw new Error(`Invalid ${HRP_SIGNATURE_FILE}: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Invalid ${HRP_SIGNATURE_FILE}`);
  }
  const raw = value as Record<string, unknown>;
  if (
    Object.keys(raw).sort().join(",")
      !== "algorithm,key_id,payload_digest,public_key_spki,publisher,signature,signature_version"
    || raw.signature_version !== 1
    || raw.algorithm !== "Ed25519"
    || typeof raw.publisher !== "string"
    || typeof raw.key_id !== "string"
    || !SIGNATURE_KEY_ID.test(raw.key_id)
    || typeof raw.public_key_spki !== "string"
    || typeof raw.payload_digest !== "string"
    || !SHA256.test(raw.payload_digest)
    || typeof raw.signature !== "string"
  ) throw new Error(`Unsupported or malformed ${HRP_SIGNATURE_FILE}`);
  const statement: HrpSignatureFileV1 = {
    signature_version: 1,
    algorithm: "Ed25519",
    publisher: assertPublisher(raw.publisher),
    key_id: raw.key_id,
    public_key_spki: raw.public_key_spki,
    payload_digest: raw.payload_digest,
    signature: raw.signature,
  };
  if (!content.equals(canonicalHrpJsonBytes(statement))) {
    throw new Error(`${HRP_SIGNATURE_FILE} must use canonical JSON bytes`);
  }
  if (statement.payload_digest !== lock.payload_digest) {
    throw new Error("HRP signature payload digest does not match its lock");
  }
  const publicKeySpki = decodeBase64Url(statement.public_key_spki, "public key");
  if (publicKeySpki.byteLength < 32 || publicKeySpki.byteLength > 256) {
    throw new Error("HRP signature public key is outside size limits");
  }
  if (signatureKeyId(publicKeySpki) !== statement.key_id) {
    throw new Error("HRP signature key id does not match its public key");
  }
  const publicKey = createPublicKey({ key: publicKeySpki, format: "der", type: "spki" });
  if (publicKey.asymmetricKeyType !== "ed25519") {
    throw new Error("HRP signature public key must be Ed25519");
  }
  const signature = decodeBase64Url(statement.signature, "value", 64);
  if (!verifyMessage(null, canonicalHrpSignatureMessage(lock), publicKey, signature)) {
    throw new Error("HRP publisher signature is invalid");
  }
  return { statement, publicKeySpki, signature };
}

function resolveSignatureTrust(
  statement: HrpSignatureFileV1,
  trustStore: readonly HrpPublisherTrustEntry[],
): Exclude<HrpSignatureTrustState, "unsigned"> {
  const matches = trustStore.filter((entry) => entry.key_id === statement.key_id);
  for (const entry of matches) {
    const normalized = validateHrpPublisherTrustEntry(entry);
    if (normalized.public_key_spki !== statement.public_key_spki) {
      throw new Error("HRP publisher trust store contains a conflicting public key");
    }
  }
  if (matches.some((entry) => entry.state === "revoked")) return "revoked";
  if (matches.some((entry) => entry.state === "trusted" && entry.publisher === statement.publisher)) return "verified";
  return "untrusted";
}

export function validateHrpPublisherTrustEntry(entry: HrpPublisherTrustEntry): HrpPublisherTrustEntry {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    throw new Error("Invalid HRP publisher trust entry");
  }
  if (!SIGNATURE_KEY_ID.test(entry.key_id)) throw new Error("Malformed HRP publisher trust entry key id");
  if (entry.state !== "trusted" && entry.state !== "revoked") {
    throw new Error("Malformed HRP publisher trust entry state");
  }
  const publicKeySpki = decodeBase64Url(entry.public_key_spki, "trust-store public key");
  if (signatureKeyId(publicKeySpki) !== entry.key_id) throw new Error("HRP publisher trust entry key id mismatch");
  const publicKey = createPublicKey({ key: publicKeySpki, format: "der", type: "spki" });
  if (publicKey.asymmetricKeyType !== "ed25519") throw new Error("HRP publisher trust key must be Ed25519");
  return {
    publisher: assertPublisher(entry.publisher),
    key_id: entry.key_id,
    public_key_spki: entry.public_key_spki,
    state: entry.state,
  };
}

export function createHrpPublisherTrustEntry(options: {
  publisher: string;
  public_key: KeyLike;
  state?: "trusted" | "revoked";
}): HrpPublisherTrustEntry {
  const publicKey = options.public_key instanceof KeyObject && options.public_key.type === "public"
    ? options.public_key
    : createPublicKey(options.public_key);
  if (publicKey.asymmetricKeyType !== "ed25519") throw new Error("HRP publisher key must be Ed25519");
  const publicKeySpki = publicKey.export({ format: "der", type: "spki" }) as Buffer;
  return validateHrpPublisherTrustEntry({
    publisher: assertPublisher(options.publisher),
    key_id: signatureKeyId(publicKeySpki),
    public_key_spki: publicKeySpki.toString("base64url"),
    state: options.state ?? "trusted",
  });
}

export function normalizeHrpPath(value: string): string {
  if (typeof value !== "string" || !value) throw new Error("HRP entry path must not be empty");
  if (value !== value.normalize("NFC")) throw new Error(`HRP entry path must use NFC Unicode: ${value}`);
  if (value.startsWith("/") || value.includes("\\") || value.includes(":")) {
    throw new Error(`HRP entry path must be package-relative POSIX: ${value}`);
  }
  if (/[\u0000-\u001f\u007f]/.test(value)) throw new Error(`HRP entry path contains control bytes: ${value}`);
  const segments = value.split("/");
  for (const segment of segments) {
    if (Buffer.byteLength(segment, "utf8") > MAX_HRP_SEGMENT_UTF8_BYTES) {
      throw new Error(`HRP entry path segment exceeds ${MAX_HRP_SEGMENT_UTF8_BYTES} UTF-8 bytes: ${value}`);
    }
  }
  if (Buffer.byteLength(value, "utf8") > MAX_HRP_PATH_UTF8_BYTES) {
    throw new Error(`HRP entry path exceeds ${MAX_HRP_PATH_UTF8_BYTES} UTF-8 bytes: ${value}`);
  }
  if (segments.some((segment) => (
    !segment
    || segment === "."
    || segment === ".."
    || segment.endsWith(".")
    || WINDOWS_DEVICE.test(segment)
    || !PORTABLE_SEGMENT.test(segment)
  ))) {
    throw new Error(`HRP entry path is not portable across Windows, macOS, and Linux: ${value}`);
  }
  return segments.join("/");
}

function portablePathKey(value: string): string {
  // PORTABLE_SEGMENT is ASCII-only, so lowercase is a complete and
  // locale-independent case fold for every accepted HRP path.
  return value.normalize("NFC").toLowerCase();
}

function assertNoPortablePathCollisions(paths: readonly string[]): void {
  const normalizedPaths = paths.map((filePath) => normalizeHrpPath(filePath));
  const filesByKey = new Map<string, string>();
  for (const filePath of normalizedPaths) {
    const key = portablePathKey(filePath);
    const existing = filesByKey.get(key);
    if (existing !== undefined) {
      throw new Error(`Duplicate or cross-platform-colliding HRP path: ${existing} and ${filePath}`);
    }
    filesByKey.set(key, filePath);
  }

  for (const filePath of normalizedPaths) {
    const segments = filePath.split("/");
    for (let index = 1; index < segments.length; index += 1) {
      const prefix = segments.slice(0, index).join("/");
      const collidingFile = filesByKey.get(portablePathKey(prefix));
      if (collidingFile !== undefined) {
        throw new Error(`HRP file/directory prefix collision: ${collidingFile} and ${filePath}`);
      }
    }
  }
}

function normalizedFiles(files: readonly HrpSourceFile[], limits: HrpLimits): HrpSourceFile[] {
  if (!files.length || files.length > limits.max_entries) throw new Error("HRP file count is outside package limits");
  let total = 0;
  const normalized = files.map((entry) => {
    const filePath = normalizeHrpPath(entry.path);
    const content = Buffer.from(entry.content);
    if (content.byteLength > limits.max_file_bytes) throw new Error(`HRP file exceeds size limit: ${filePath}`);
    total += content.byteLength;
    if (total > limits.max_uncompressed_bytes) throw new Error("HRP package exceeds uncompressed size limit");
    return { path: filePath, content };
  }).sort((left, right) => utf8Compare(left.path, right.path));
  assertNoPortablePathCollisions(normalized.map((entry) => entry.path));
  return normalized;
}

function pluginIdentity(manifest: Buffer): { id: string; version: string } {
  let value: unknown;
  try {
    value = JSON.parse(decodeHomerailPluginUtf8(manifest, HRP_MANIFEST_FILE));
  } catch (cause) {
    throw new Error(`Invalid ${HRP_MANIFEST_FILE}: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
  const item = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
  if (typeof item?.id !== "string" || typeof item.version !== "string" || !item.id || !item.version) {
    throw new Error(`${HRP_MANIFEST_FILE} must declare plugin id and version`);
  }
  return { id: item.id, version: item.version };
}

export function createHrpLock(files: readonly HrpSourceFile[]): HrpLockFileV1 {
  const stable = normalizedFiles(files, DEFAULT_HRP_LIMITS);
  if (!stable.some((entry) => entry.path === HRP_MANIFEST_FILE)) {
    throw new Error(`HRP package is missing ${HRP_MANIFEST_FILE}`);
  }
  if (stable.some((entry) => entry.path === HRP_LOCK_FILE || entry.path === HRP_SIGNATURE_FILE)) {
    throw new Error("HRP lock and signature metadata cannot be supplied as payload files");
  }
  const manifestContent = stable.find((entry) => entry.path === HRP_MANIFEST_FILE)!.content;
  const identity = pluginIdentity(manifestContent);
  const lockedFiles = stable.map((entry) => ({
    path: entry.path,
    size: entry.content.byteLength,
    sha256: sha256(entry.content),
  }));
  const unsigned = {
    lock_version: HRP_LOCK_VERSION,
    manifest: HRP_MANIFEST_FILE,
    plugin: identity,
    manifest_sha256: sha256(manifestContent),
    files: lockedFiles,
  };
  return { ...unsigned, payload_digest: sha256(canonicalHrpJsonBytes(unsigned)) };
}

export function encodeHrpZip(
  sourceFiles: readonly HrpSourceFile[],
  limits: HrpLimits = DEFAULT_HRP_LIMITS,
): Buffer {
  const files = normalizedFiles(sourceFiles, limits);
  const localChunks: Buffer[] = [];
  const centralChunks: Buffer[] = [];
  let offset = 0;
  for (const file of files) {
    const name = Buffer.from(file.path, "utf8");
    const checksum = crc32(file.content);
    const local = Buffer.alloc(30 + name.byteLength);
    local.writeUInt32LE(ZIP_LOCAL_FILE, 0);
    local.writeUInt16LE(ZIP_VERSION, 4);
    local.writeUInt16LE(ZIP_UTF8, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(ZIP_DOS_DATE_1980_01_01, 12);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(file.content.byteLength, 18);
    local.writeUInt32LE(file.content.byteLength, 22);
    local.writeUInt16LE(name.byteLength, 26);
    local.writeUInt16LE(0, 28);
    name.copy(local, 30);
    localChunks.push(local, file.content);

    const central = Buffer.alloc(46 + name.byteLength);
    central.writeUInt32LE(ZIP_CENTRAL_FILE, 0);
    central.writeUInt16LE(ZIP_UNIX_VERSION, 4);
    central.writeUInt16LE(ZIP_VERSION, 6);
    central.writeUInt16LE(ZIP_UTF8, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(ZIP_DOS_DATE_1980_01_01, 14);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(file.content.byteLength, 20);
    central.writeUInt32LE(file.content.byteLength, 24);
    central.writeUInt16LE(name.byteLength, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE((0o100644 << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    name.copy(central, 46);
    centralChunks.push(central);
    offset += local.byteLength + file.content.byteLength;
  }
  const centralOffset = offset;
  const centralSize = centralChunks.reduce((total, chunk) => total + chunk.byteLength, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(ZIP_END, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(centralOffset, 16);
  end.writeUInt16LE(0, 20);
  const archive = Buffer.concat([...localChunks, ...centralChunks, end]);
  if (archive.byteLength > limits.max_archive_bytes) throw new Error("HRP archive exceeds size limit");
  return archive;
}

export function buildHrpArchive(sourceFiles: readonly HrpSourceFile[]): {
  archive: Buffer;
  lock: HrpLockFileV1;
  archive_digest: string;
} {
  const files = normalizedFiles(sourceFiles, DEFAULT_HRP_LIMITS);
  const lock = createHrpLock(files);
  const lockContent = canonicalHrpJsonBytes(lock);
  const archive = encodeHrpZip([...files, { path: HRP_LOCK_FILE, content: lockContent }]);
  return { archive, lock, archive_digest: sha256(archive) };
}

export function buildSignedHrpArchive(
  sourceFiles: readonly HrpSourceFile[],
  options: { publisher: string; private_key: KeyLike },
): {
  archive: Buffer;
  lock: HrpLockFileV1;
  signature: HrpSignatureFileV1;
  archive_digest: string;
} {
  const files = normalizedFiles(sourceFiles, DEFAULT_HRP_LIMITS);
  const lock = createHrpLock(files);
  const privateKey = options.private_key;
  const publicKey = createPublicKey(privateKey);
  if (publicKey.asymmetricKeyType !== "ed25519") {
    throw new Error("HRP signing key must be Ed25519");
  }
  const publicKeySpki = publicKey.export({ format: "der", type: "spki" }) as Buffer;
  const signature: HrpSignatureFileV1 = {
    signature_version: 1,
    algorithm: "Ed25519",
    publisher: assertPublisher(options.publisher),
    key_id: signatureKeyId(publicKeySpki),
    public_key_spki: publicKeySpki.toString("base64url"),
    payload_digest: lock.payload_digest,
    signature: signMessage(null, canonicalHrpSignatureMessage(lock), privateKey).toString("base64url"),
  };
  const archive = encodeHrpZip([
    ...files,
    { path: HRP_LOCK_FILE, content: canonicalHrpJsonBytes(lock) },
    { path: HRP_SIGNATURE_FILE, content: canonicalHrpJsonBytes(signature) },
  ]);
  return { archive, lock, signature, archive_digest: sha256(archive) };
}

function requireRange(buffer: Buffer, offset: number, length: number, label: string): void {
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 || offset + length > buffer.byteLength) {
    throw new Error(`Malformed HRP ZIP ${label}`);
  }
}

function findEndOfCentralDirectory(buffer: Buffer): number {
  const first = Math.max(0, buffer.byteLength - 65_557);
  for (let offset = buffer.byteLength - 22; offset >= first; offset -= 1) {
    if (buffer.readUInt32LE(offset) !== ZIP_END) continue;
    requireRange(buffer, offset, 22, "end record");
    const commentLength = buffer.readUInt16LE(offset + 20);
    if (offset + 22 + commentLength === buffer.byteLength) return offset;
  }
  throw new Error("Malformed HRP ZIP: end record not found");
}

export function decodeHrpZip(
  archiveValue: Buffer,
  limits: HrpLimits = DEFAULT_HRP_LIMITS,
): Map<string, Buffer> {
  const archive = Buffer.from(archiveValue);
  if (!archive.byteLength || archive.byteLength > limits.max_archive_bytes) {
    throw new Error("HRP archive size is outside package limits");
  }
  const endOffset = findEndOfCentralDirectory(archive);
  if (archive.readUInt16LE(endOffset + 4) !== 0 || archive.readUInt16LE(endOffset + 6) !== 0) {
    throw new Error("Multi-disk HRP ZIP archives are forbidden");
  }
  const diskEntries = archive.readUInt16LE(endOffset + 8);
  const totalEntries = archive.readUInt16LE(endOffset + 10);
  const centralSize = archive.readUInt32LE(endOffset + 12);
  const centralOffset = archive.readUInt32LE(endOffset + 16);
  if (
    diskEntries !== totalEntries
    || totalEntries < 1
    || totalEntries > limits.max_entries
    || totalEntries === 0xffff
    || centralSize === 0xffffffff
    || centralOffset === 0xffffffff
  ) throw new Error("HRP ZIP entry directory is invalid or requires unsupported ZIP64");
  requireRange(archive, centralOffset, centralSize, "central directory");
  if (centralOffset + centralSize !== endOffset) throw new Error("HRP ZIP central directory is not canonical");

  const result = new Map<string, Buffer>();
  const archivePaths: string[] = [];
  const localRanges: Array<{ start: number; end: number }> = [];
  let totalBytes = 0;
  let cursor = centralOffset;
  for (let index = 0; index < totalEntries; index += 1) {
    requireRange(archive, cursor, 46, "central entry");
    if (archive.readUInt32LE(cursor) !== ZIP_CENTRAL_FILE) throw new Error("Malformed HRP ZIP central entry signature");
    const madeBy = archive.readUInt16LE(cursor + 4);
    const flags = archive.readUInt16LE(cursor + 8);
    const method = archive.readUInt16LE(cursor + 10);
    const checksum = archive.readUInt32LE(cursor + 16);
    const compressedSize = archive.readUInt32LE(cursor + 20);
    const uncompressedSize = archive.readUInt32LE(cursor + 24);
    const nameLength = archive.readUInt16LE(cursor + 28);
    const extraLength = archive.readUInt16LE(cursor + 30);
    const commentLength = archive.readUInt16LE(cursor + 32);
    const externalAttributes = archive.readUInt32LE(cursor + 38);
    const localOffset = archive.readUInt32LE(cursor + 42);
    requireRange(archive, cursor + 46, nameLength + extraLength + commentLength, "central entry fields");
    if (flags !== ZIP_UTF8 || method !== 0 || compressedSize !== uncompressedSize || extraLength || commentLength) {
      throw new Error("HRP ZIP entries must be unencrypted deterministic stored files");
    }
    const platform = madeBy >>> 8;
    const mode = externalAttributes >>> 16;
    if (platform === 3 && mode && (mode & 0o170000) !== 0o100000) {
      throw new Error("HRP ZIP symlinks and non-regular files are forbidden");
    }
    const filePath = normalizeHrpPath(archive.toString("utf8", cursor + 46, cursor + 46 + nameLength));
    archivePaths.push(filePath);
    if (uncompressedSize > limits.max_file_bytes) throw new Error(`HRP file exceeds size limit: ${filePath}`);
    totalBytes += uncompressedSize;
    if (totalBytes > limits.max_uncompressed_bytes) throw new Error("HRP package exceeds uncompressed size limit");

    requireRange(archive, localOffset, 30, "local entry");
    if (archive.readUInt32LE(localOffset) !== ZIP_LOCAL_FILE) throw new Error("Malformed HRP ZIP local entry signature");
    const localFlags = archive.readUInt16LE(localOffset + 6);
    const localMethod = archive.readUInt16LE(localOffset + 8);
    const localChecksum = archive.readUInt32LE(localOffset + 14);
    const localCompressed = archive.readUInt32LE(localOffset + 18);
    const localUncompressed = archive.readUInt32LE(localOffset + 22);
    const localNameLength = archive.readUInt16LE(localOffset + 26);
    const localExtraLength = archive.readUInt16LE(localOffset + 28);
    requireRange(archive, localOffset + 30, localNameLength + localExtraLength, "local entry fields");
    const localName = archive.toString("utf8", localOffset + 30, localOffset + 30 + localNameLength);
    if (
      localFlags !== flags
      || localMethod !== method
      || localChecksum !== checksum
      || localCompressed !== compressedSize
      || localUncompressed !== uncompressedSize
      || localExtraLength
      || localName !== filePath
    ) throw new Error(`HRP ZIP local and central metadata disagree: ${filePath}`);
    const contentOffset = localOffset + 30 + localNameLength;
    requireRange(archive, contentOffset, compressedSize, "file content");
    if (contentOffset + compressedSize > centralOffset) throw new Error(`HRP ZIP file overlaps its directory: ${filePath}`);
    const content = Buffer.from(archive.subarray(contentOffset, contentOffset + compressedSize));
    if (crc32(content) !== checksum) throw new Error(`HRP ZIP CRC mismatch: ${filePath}`);
    result.set(filePath, content);
    localRanges.push({ start: localOffset, end: contentOffset + compressedSize });
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  if (cursor !== endOffset) throw new Error("HRP ZIP central directory entry count is inconsistent");
  assertNoPortablePathCollisions(archivePaths);
  localRanges.sort((left, right) => left.start - right.start);
  let localCursor = 0;
  for (const range of localRanges) {
    if (range.start !== localCursor || range.end <= range.start) {
      throw new Error("HRP ZIP local records contain gaps, overlaps, or hidden bytes");
    }
    localCursor = range.end;
  }
  if (localCursor !== centralOffset) throw new Error("HRP ZIP local records do not exactly cover the payload region");
  const canonical = encodeHrpZip([...result.entries()].map(([filePath, content]) => ({ path: filePath, content })), limits);
  if (!archive.equals(canonical)) throw new Error("HRP ZIP is valid but not in canonical deterministic form");
  return result;
}

function parseLock(content: Buffer): HrpLockFileV1 {
  let value: unknown;
  try {
    value = JSON.parse(decodeHomerailPluginUtf8(content, HRP_LOCK_FILE));
  } catch (cause) {
    throw new Error(`Invalid ${HRP_LOCK_FILE}: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Invalid ${HRP_LOCK_FILE}`);
  const lock = value as Record<string, unknown>;
  if (
    lock.lock_version !== HRP_LOCK_VERSION
    || lock.manifest !== HRP_MANIFEST_FILE
    || !Array.isArray(lock.files)
    || Object.keys(lock).sort().join(",") !== "files,lock_version,manifest,manifest_sha256,payload_digest,plugin"
    || typeof lock.manifest_sha256 !== "string"
    || !SHA256.test(lock.manifest_sha256)
    || typeof lock.payload_digest !== "string"
    || !SHA256.test(lock.payload_digest)
    || !lock.plugin
    || typeof lock.plugin !== "object"
    || Array.isArray(lock.plugin)
  ) throw new Error(`Unsupported or malformed ${HRP_LOCK_FILE}`);
  const plugin = lock.plugin as Record<string, unknown>;
  if (
    Object.keys(plugin).sort().join(",") !== "id,version"
    || typeof plugin.id !== "string"
    || typeof plugin.version !== "string"
    || !plugin.id
    || !plugin.version
  ) throw new Error(`Malformed ${HRP_LOCK_FILE} plugin identity`);
  const files: HrpLockFileV1["files"] = [];
  let previous = "";
  for (const raw of lock.files) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`Malformed ${HRP_LOCK_FILE} entry`);
    const entry = raw as Record<string, unknown>;
    if (
      Object.keys(entry).sort().join(",") !== "path,sha256,size"
      || typeof entry.path !== "string"
      || typeof entry.size !== "number"
      || !Number.isSafeInteger(entry.size)
      || entry.size < 0
      || typeof entry.sha256 !== "string"
      || !SHA256.test(entry.sha256)
    ) throw new Error(`Malformed ${HRP_LOCK_FILE} entry`);
    const filePath = normalizeHrpPath(entry.path);
    if (filePath <= previous) throw new Error(`${HRP_LOCK_FILE} entries must be uniquely sorted`);
    previous = filePath;
    files.push({ path: filePath, size: entry.size, sha256: entry.sha256 });
  }
  if (!files.some((entry) => entry.path === HRP_MANIFEST_FILE)) throw new Error(`${HRP_LOCK_FILE} omits manifest`);
  const unsigned = {
    lock_version: 1 as const,
    manifest: HRP_MANIFEST_FILE,
    plugin: { id: plugin.id, version: plugin.version },
    manifest_sha256: lock.manifest_sha256,
    files,
  };
  if (sha256(canonicalHrpJsonBytes(unsigned)) !== lock.payload_digest) {
    throw new Error(`${HRP_LOCK_FILE} payload digest is invalid`);
  }
  const parsed = { ...unsigned, payload_digest: lock.payload_digest };
  if (!content.equals(canonicalHrpJsonBytes(parsed))) {
    throw new Error(`${HRP_LOCK_FILE} must use canonical JSON bytes`);
  }
  return parsed;
}

export function verifyHrpArchive(
  archive: Buffer,
  options: {
    allow_signature?: boolean;
    trust_store?: readonly HrpPublisherTrustEntry[];
    require_trusted_signature?: boolean;
  } = {},
): VerifiedHrpArchive {
  const files = decodeHrpZip(archive);
  const lockContent = files.get(HRP_LOCK_FILE);
  if (!lockContent) throw new Error(`HRP archive is missing ${HRP_LOCK_FILE}`);
  if (files.has(HRP_SIGNATURE_FILE) && !options.allow_signature) {
    throw new Error("Signed HRP metadata is not enabled by this verifier policy");
  }
  const lock = parseLock(lockContent);
  const manifest = files.get(HRP_MANIFEST_FILE);
  if (!manifest) throw new Error(`HRP archive is missing ${HRP_MANIFEST_FILE}`);
  const identity = pluginIdentity(manifest);
  if (
    identity.id !== lock.plugin.id
    || identity.version !== lock.plugin.version
    || sha256(manifest) !== lock.manifest_sha256
  ) throw new Error("HRP lock identity does not match its manifest");
  const actualPaths = [...files.keys()]
    .filter((filePath) => filePath !== HRP_LOCK_FILE && filePath !== HRP_SIGNATURE_FILE)
    .sort();
  const lockedPaths = lock.files.map((entry) => entry.path);
  if (JSON.stringify(actualPaths) !== JSON.stringify(lockedPaths)) {
    throw new Error(`${HRP_LOCK_FILE} does not cover the exact archive file set`);
  }
  for (const entry of lock.files) {
    const content = files.get(entry.path)!;
    if (content.byteLength !== entry.size || sha256(content) !== entry.sha256) {
      throw new Error(`HRP lock digest mismatch: ${entry.path}`);
    }
  }
  let signature: VerifiedHrpSignature | undefined;
  let signatureState: HrpSignatureTrustState = "unsigned";
  const signatureContent = files.get(HRP_SIGNATURE_FILE);
  if (signatureContent) {
    const parsed = parseHrpSignature(signatureContent, lock);
    signatureState = resolveSignatureTrust(parsed.statement, options.trust_store ?? []);
    signature = { statement: parsed.statement, trust_state: signatureState };
  }
  if (options.require_trusted_signature && signatureState !== "verified") {
    throw new Error(`HRP package requires a trusted publisher signature; received ${signatureState}`);
  }
  return {
    archive_digest: sha256(archive),
    lock,
    files: new Map([...files.entries()].map(([filePath, content]) => [filePath, Buffer.from(content)])),
    signature,
    signature_state: signatureState,
  };
}

export function extractVerifiedHrpArchive(verified: VerifiedHrpArchive, destination: string): void {
  if (fs.existsSync(destination)) {
    const stat = fs.lstatSync(destination);
    if (stat.isSymbolicLink() || !stat.isDirectory() || fs.readdirSync(destination).length) {
      throw new Error("HRP staging destination must be a real empty directory");
    }
  } else {
    fs.mkdirSync(destination, { recursive: true, mode: 0o700 });
  }
  const root = fs.realpathSync(destination);
  for (const entry of verified.lock.files) {
    const content = verified.files.get(entry.path);
    if (!content) throw new Error(`Verified HRP content is missing: ${entry.path}`);
    const target = path.resolve(root, ...entry.path.split("/"));
    const relative = path.relative(root, target);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error(`HRP extraction escaped staging: ${entry.path}`);
    }
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    fs.writeFileSync(target, content, { flag: "wx", mode: 0o600 });
  }
  fs.writeFileSync(path.join(root, HRP_LOCK_FILE), verified.files.get(HRP_LOCK_FILE)!, { flag: "wx", mode: 0o600 });
  const signature = verified.files.get(HRP_SIGNATURE_FILE);
  if (signature) {
    fs.writeFileSync(path.join(root, HRP_SIGNATURE_FILE), signature, { flag: "wx", mode: 0o600 });
  }
}
