import {
  createHash,
  createPublicKey,
  sign as signMessage,
  verify as verifyMessage,
  type KeyLike,
} from "node:crypto";
import {
  isCanonicalHomerailPluginSemver,
  isHomerailPluginId,
} from "homerail-protocol";
import { canonicalHrpJsonBytes, normalizeHrpPath } from "./archive.js";

export const PLUGIN_REGISTRY_INDEX_VERSION = 1 as const;
export const DEFAULT_PLUGIN_REGISTRY_INDEX_LIMITS = Object.freeze({
  max_bytes: 1024 * 1024,
  max_releases: 4096,
  max_future_ms: 5 * 60 * 1000,
});

export interface PluginRegistryReleaseV1 {
  plugin_id: string;
  plugin_version: string;
  archive_path: string;
  archive_digest: string;
  payload_digest: string;
  publisher_key_id: string;
}

export interface PluginRegistryIndexV1 {
  index_version: 1;
  registry_id: string;
  sequence: number;
  issued_at: string;
  expires_at: string;
  releases: PluginRegistryReleaseV1[];
  root_key_id: string;
  root_public_key_spki: string;
  signature: string;
}

export interface VerifiedPluginRegistryIndex {
  index: PluginRegistryIndexV1;
  index_digest: string;
  root_pin: string;
}

const SHA256 = /^[a-f0-9]{64}$/;
const KEY_ID = /^sha256:[a-f0-9]{64}$/;
const BASE64URL = /^[A-Za-z0-9_-]+$/;
const REGISTRY_ID = /^[a-z][a-z0-9._-]{0,79}$/;

function sha256(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function keyId(publicKeySpki: Buffer): string {
  return `sha256:${sha256(publicKeySpki)}`;
}

function decodeBase64Url(value: string, label: string, expectedBytes?: number): Buffer {
  if (!BASE64URL.test(value)) throw new Error(`Plugin registry index ${label} must be unpadded base64url`);
  const decoded = Buffer.from(value, "base64url");
  if (
    decoded.toString("base64url") !== value
    || (expectedBytes !== undefined && decoded.byteLength !== expectedBytes)
  ) throw new Error(`Plugin registry index ${label} has an invalid encoding or size`);
  return decoded;
}

function assertTimestamp(value: unknown, label: string): string {
  if (typeof value !== "string" || !value) {
    throw new Error(`Plugin registry index ${label} must be a canonical ISO timestamp`);
  }
  const timestamp = new Date(value);
  if (!Number.isFinite(timestamp.getTime()) || timestamp.toISOString() !== value) {
    throw new Error(`Plugin registry index ${label} must be a canonical ISO timestamp`);
  }
  return value;
}

function assertRegistryId(value: unknown): string {
  if (typeof value !== "string" || !REGISTRY_ID.test(value)) {
    throw new Error("Plugin registry index registry id is invalid");
  }
  return value;
}

function compareText(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function compareRelease(left: PluginRegistryReleaseV1, right: PluginRegistryReleaseV1): number {
  return compareText(left.plugin_id, right.plugin_id)
    || compareText(left.plugin_version, right.plugin_version);
}

function normalizeRelease(value: unknown): PluginRegistryReleaseV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Plugin registry index release must be an object");
  }
  const raw = value as Record<string, unknown>;
  if (
    Object.keys(raw).sort().join(",")
      !== "archive_digest,archive_path,payload_digest,plugin_id,plugin_version,publisher_key_id"
    || !isHomerailPluginId(raw.plugin_id)
    || !isCanonicalHomerailPluginSemver(raw.plugin_version)
    || typeof raw.archive_path !== "string"
    || typeof raw.archive_digest !== "string"
    || !SHA256.test(raw.archive_digest)
    || typeof raw.payload_digest !== "string"
    || !SHA256.test(raw.payload_digest)
    || typeof raw.publisher_key_id !== "string"
    || !KEY_ID.test(raw.publisher_key_id)
  ) throw new Error("Plugin registry index release is malformed");
  const archivePath = normalizeHrpPath(raw.archive_path);
  if (!archivePath.endsWith(".hrp")) {
    throw new Error("Plugin registry index archive path must name an .hrp package");
  }
  return {
    plugin_id: raw.plugin_id,
    plugin_version: raw.plugin_version,
    archive_path: archivePath,
    archive_digest: raw.archive_digest,
    payload_digest: raw.payload_digest,
    publisher_key_id: raw.publisher_key_id,
  };
}

function unsignedIndex(index: PluginRegistryIndexV1): Omit<PluginRegistryIndexV1, "signature"> {
  return {
    index_version: 1,
    registry_id: index.registry_id,
    sequence: index.sequence,
    issued_at: index.issued_at,
    expires_at: index.expires_at,
    releases: index.releases,
    root_key_id: index.root_key_id,
    root_public_key_spki: index.root_public_key_spki,
  };
}

export function canonicalPluginRegistryIndexMessage(
  index: Omit<PluginRegistryIndexV1, "signature">,
): Buffer {
  return canonicalHrpJsonBytes({
    context: "homerail.plugin-registry.index.v1",
    ...index,
  });
}

function validateStructure(value: unknown, maxReleases: number): PluginRegistryIndexV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Plugin registry index must be an object");
  }
  const raw = value as Record<string, unknown>;
  if (
    Object.keys(raw).sort().join(",")
      !== "expires_at,index_version,issued_at,registry_id,releases,root_key_id,root_public_key_spki,sequence,signature"
    || raw.index_version !== 1
    || !Number.isSafeInteger(raw.sequence)
    || Number(raw.sequence) < 1
    || !Array.isArray(raw.releases)
    || raw.releases.length > maxReleases
    || typeof raw.root_key_id !== "string"
    || !KEY_ID.test(raw.root_key_id)
    || typeof raw.root_public_key_spki !== "string"
    || typeof raw.signature !== "string"
  ) throw new Error("Unsupported or malformed plugin registry index");
  const releases = raw.releases.map(normalizeRelease);
  const releaseIds = new Set<string>();
  const archivePaths = new Set<string>();
  for (let index = 0; index < releases.length; index += 1) {
    const release = releases[index];
    if (index > 0 && compareRelease(releases[index - 1], release) >= 0) {
      throw new Error("Plugin registry index releases must be uniquely sorted by plugin id and version");
    }
    const releaseId = `${release.plugin_id}\u0000${release.plugin_version}`;
    if (releaseIds.has(releaseId)) throw new Error("Plugin registry index contains a duplicate release");
    if (archivePaths.has(release.archive_path)) throw new Error("Plugin registry index archive paths must be unique");
    releaseIds.add(releaseId);
    archivePaths.add(release.archive_path);
  }
  const issuedAt = assertTimestamp(raw.issued_at, "issued_at");
  const expiresAt = assertTimestamp(raw.expires_at, "expires_at");
  if (Date.parse(expiresAt) <= Date.parse(issuedAt)) {
    throw new Error("Plugin registry index expiry must be after issuance");
  }
  const publicKeySpki = decodeBase64Url(raw.root_public_key_spki, "root public key");
  if (publicKeySpki.byteLength < 32 || publicKeySpki.byteLength > 256) {
    throw new Error("Plugin registry index root public key is outside size limits");
  }
  if (keyId(publicKeySpki) !== raw.root_key_id) {
    throw new Error("Plugin registry index root key id does not match its public key");
  }
  const publicKey = createPublicKey({ key: publicKeySpki, format: "der", type: "spki" });
  if (publicKey.asymmetricKeyType !== "ed25519") {
    throw new Error("Plugin registry index root key must be Ed25519");
  }
  decodeBase64Url(raw.signature, "root signature", 64);
  return {
    index_version: 1,
    registry_id: assertRegistryId(raw.registry_id),
    sequence: Number(raw.sequence),
    issued_at: issuedAt,
    expires_at: expiresAt,
    releases,
    root_key_id: raw.root_key_id,
    root_public_key_spki: raw.root_public_key_spki,
    signature: raw.signature,
  };
}

export function buildSignedPluginRegistryIndex(
  input: Omit<PluginRegistryIndexV1, "index_version" | "root_key_id" | "root_public_key_spki" | "signature">,
  options: { private_key: KeyLike },
): { bytes: Buffer; index: PluginRegistryIndexV1; index_digest: string; root_pin: string } {
  const publicKey = createPublicKey(options.private_key);
  if (publicKey.asymmetricKeyType !== "ed25519") {
    throw new Error("Plugin registry index signing key must be Ed25519");
  }
  const publicKeySpki = publicKey.export({ format: "der", type: "spki" }) as Buffer;
  const rootKeyId = keyId(publicKeySpki);
  const unsignedCandidate = {
    index_version: 1 as const,
    registry_id: input.registry_id,
    sequence: input.sequence,
    issued_at: input.issued_at,
    expires_at: input.expires_at,
    releases: input.releases,
    root_key_id: rootKeyId,
    root_public_key_spki: publicKeySpki.toString("base64url"),
  };
  const normalized = validateStructure({
    ...unsignedCandidate,
    signature: Buffer.alloc(64).toString("base64url"),
  }, DEFAULT_PLUGIN_REGISTRY_INDEX_LIMITS.max_releases);
  const unsigned = unsignedIndex(normalized);
  const index = validateStructure({
    ...unsigned,
    signature: signMessage(
      null,
      canonicalPluginRegistryIndexMessage(unsigned),
      options.private_key,
    ).toString("base64url"),
  }, DEFAULT_PLUGIN_REGISTRY_INDEX_LIMITS.max_releases);
  const bytes = canonicalHrpJsonBytes(index);
  return { bytes, index, index_digest: sha256(bytes), root_pin: rootKeyId };
}

export function verifyPluginRegistryIndex(
  bytesValue: Uint8Array,
  options: {
    expected_registry_id: string;
    root_pin: string;
    min_sequence?: number;
    now?: string | Date;
    max_future_ms?: number;
    max_bytes?: number;
    max_releases?: number;
  },
): VerifiedPluginRegistryIndex {
  const bytes = Buffer.from(bytesValue);
  const maxBytes = options.max_bytes ?? DEFAULT_PLUGIN_REGISTRY_INDEX_LIMITS.max_bytes;
  const maxReleases = options.max_releases ?? DEFAULT_PLUGIN_REGISTRY_INDEX_LIMITS.max_releases;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new Error("Plugin registry index byte limit is invalid");
  }
  if (!Number.isSafeInteger(maxReleases) || maxReleases < 0) {
    throw new Error("Plugin registry index release limit is invalid");
  }
  if (!bytes.byteLength || bytes.byteLength > maxBytes) {
    throw new Error("Plugin registry index size is outside limits");
  }
  let raw: unknown;
  try {
    raw = JSON.parse(bytes.toString("utf8"));
  } catch (cause) {
    throw new Error(`Invalid plugin registry index JSON: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
  const index = validateStructure(raw, maxReleases);
  if (!bytes.equals(canonicalHrpJsonBytes(index))) {
    throw new Error("Plugin registry index must use canonical JSON bytes");
  }
  const expectedRegistryId = assertRegistryId(options.expected_registry_id);
  if (index.registry_id !== expectedRegistryId) throw new Error("Plugin registry index registry id mismatch");
  if (!KEY_ID.test(options.root_pin) || index.root_key_id !== options.root_pin) {
    throw new Error("Plugin registry index root pin mismatch");
  }
  if (
    options.min_sequence !== undefined
    && (!Number.isSafeInteger(options.min_sequence) || options.min_sequence < 0)
  ) throw new Error("Plugin registry index minimum sequence is invalid");
  if (index.sequence <= (options.min_sequence ?? 0)) {
    throw new Error("Plugin registry index sequence rollback or replay detected");
  }
  const now = options.now instanceof Date
    ? options.now
    : new Date(options.now ?? Date.now());
  if (!Number.isFinite(now.getTime())) throw new Error("Plugin registry index verification time is invalid");
  const maxFutureMs = options.max_future_ms ?? DEFAULT_PLUGIN_REGISTRY_INDEX_LIMITS.max_future_ms;
  if (!Number.isSafeInteger(maxFutureMs) || maxFutureMs < 0) {
    throw new Error("Plugin registry index future-skew policy is invalid");
  }
  if (Date.parse(index.issued_at) > now.getTime() + maxFutureMs) {
    throw new Error("Plugin registry index issuance is too far in the future");
  }
  if (Date.parse(index.expires_at) <= now.getTime()) {
    throw new Error("Plugin registry index is expired");
  }
  const publicKeySpki = decodeBase64Url(index.root_public_key_spki, "root public key");
  const publicKey = createPublicKey({ key: publicKeySpki, format: "der", type: "spki" });
  const signature = decodeBase64Url(index.signature, "root signature", 64);
  if (!verifyMessage(null, canonicalPluginRegistryIndexMessage(unsignedIndex(index)), publicKey, signature)) {
    throw new Error("Plugin registry index root signature is invalid");
  }
  return {
    index,
    index_digest: sha256(bytes),
    root_pin: index.root_key_id,
  };
}
