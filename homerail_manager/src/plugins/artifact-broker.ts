import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  HOMERAIL_ARTIFACT_BROKER_MAX_TTL_MS,
  HomerailPluginPermission,
  homerailPluginArtifactCapabilitySigningInput,
  homerailPluginToolInvocationDigestInput,
  isHomerailPluginId,
  stableStringify,
  validateHomerailPluginArtifactWriteCapabilityClaims,
  validateHomerailPluginAuthorizedToolInvocation,
  type HomerailPluginArtifactMediaTypeV1,
  type HomerailPluginArtifactWriteCapabilityClaimsV1,
  type HomerailPluginAuthorizedToolInvocationV1,
} from "homerail-protocol";
import { getDataRoot } from "../config/env.js";
import { loadPluginCapabilitySecret } from "./capability-token.js";
import { pluginJsonDigest } from "./descriptor.js";

const TOKEN_PREFIX = "hrartifact1";
const TOKEN_MAX_BYTES = 16 * 1024;
const MIN_SECRET_BYTES = 32;
const WIRE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,159}$/;
const DIGEST = /^[a-f0-9]{64}$/;

export interface PluginArtifactWriteDeclarationV1 {
  label: string;
  media_type: HomerailPluginArtifactMediaTypeV1;
  digest: string;
  size_bytes: number;
}

export interface PluginArtifactWriteCapabilityV1 {
  token: string;
  claims: HomerailPluginArtifactWriteCapabilityClaimsV1;
  upload_path: string;
}

export interface PluginArtifactMetadataV1 {
  metadata_version: 1;
  artifact_id: string;
  uri: string;
  read_path: string;
  capability_id: string;
  binding: HomerailPluginArtifactWriteCapabilityClaimsV1["binding"];
  request_id: string;
  request_digest: string;
  document_scope: HomerailPluginArtifactWriteCapabilityClaimsV1["document_scope"];
  label: string;
  media_type: HomerailPluginArtifactMediaTypeV1;
  digest: string;
  size_bytes: number;
  created_at: string;
  integrity: {
    algorithm: "hmac-sha256";
    key_id: "manager-artifact-broker-v1";
    value: string;
  };
}

export interface PluginArtifactReadResultV1 {
  metadata: PluginArtifactMetadataV1;
  content: Buffer;
}

function isErrno(cause: unknown, code: string): boolean {
  return cause instanceof Error && "code" in cause && cause.code === code;
}

function identifier(prefix: string): string {
  return `${prefix}_${randomBytes(18).toString("hex")}`;
}

function digest(content: Buffer | string): string {
  return createHash("sha256").update(content).digest("hex");
}

function validateSecret(secret: Buffer | string): Buffer {
  const value = Buffer.isBuffer(secret) ? secret : Buffer.from(secret, "utf8");
  if (value.byteLength < MIN_SECRET_BYTES || value.byteLength > 4 * 1024) {
    throw new Error("Artifact Broker secret must contain 32-4096 bytes");
  }
  return Buffer.from(value);
}

function signature(secret: Buffer, payload: string): Buffer {
  return createHmac("sha256", secret).update(`${TOKEN_PREFIX}.${payload}`, "utf8").digest();
}

function metadataMac(secret: Buffer, value: Omit<PluginArtifactMetadataV1, "integrity">): string {
  return createHmac("sha256", secret)
    .update(`homerail-artifact-metadata-v1\0${stableStringify(value)}`, "utf8")
    .digest("hex");
}

function safeWireId(value: string, label: string): void {
  if (!WIRE_ID.test(value)) throw new Error(`${label} is invalid`);
}

function safeDigest(value: string, label: string): void {
  if (!DIGEST.test(value)) throw new Error(`${label} is invalid`);
}

function assertContentMatchesMediaType(content: Buffer, mediaType: HomerailPluginArtifactMediaTypeV1): void {
  if (mediaType === "application/json") {
    try {
      JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(content));
    } catch {
      throw new Error("Artifact content is not valid UTF-8 JSON");
    }
    return;
  }
  if (mediaType === "image/png"
    && content.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return;
  if (mediaType === "image/jpeg"
    && content.byteLength >= 4
    && content[0] === 0xff
    && content[1] === 0xd8
    && content[2] === 0xff
    && content.at(-2) === 0xff
    && content.at(-1) === 0xd9) return;
  if (mediaType === "image/webp"
    && content.byteLength >= 12
    && content.subarray(0, 4).toString("ascii") === "RIFF"
    && content.subarray(8, 12).toString("ascii") === "WEBP") return;
  throw new Error(`Artifact content does not match ${mediaType}`);
}

function exactMetadataKeys(value: Record<string, unknown>): boolean {
  const expected = [
    "metadata_version", "artifact_id", "uri", "read_path", "capability_id", "binding",
    "request_id", "request_digest", "document_scope", "label", "media_type", "digest",
    "size_bytes", "created_at", "integrity",
  ].sort();
  return Object.keys(value).sort().every((key, index, keys) => (
    keys.length === expected.length && key === expected[index]
  ));
}

function openRegularNoFollow(file: string): { descriptor: number; stat: fs.Stats } {
  const before = fs.lstatSync(file);
  if (before.isSymbolicLink() || !before.isFile()) throw new Error("Artifact storage contains a non-regular file");
  const descriptor = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const opened = fs.fstatSync(descriptor);
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) {
      throw new Error("Artifact file changed while opening");
    }
    return { descriptor, stat: opened };
  } catch (cause) {
    fs.closeSync(descriptor);
    throw cause;
  }
}

/**
 * Content-addressed Artifact Broker. It is intentionally independent of the
 * Runtime transport: the transport may convey only the returned capability
 * and upload path, never a Manager filesystem path.
 */
export class PluginArtifactBroker {
  readonly #root: string;
  readonly #secret: Buffer;
  readonly #consumedNonces = new Set<string>();

  constructor(input: { root: string; secret: Buffer | string }) {
    this.#root = path.resolve(input.root);
    this.#secret = validateSecret(input.secret);
    this.#ensureDirectory();
    this.#ensureDirectory("blobs", "sha256");
    this.#ensureDirectory("metadata");
    this.#ensureDirectory("tmp");
  }

  get root(): string {
    return this.#root;
  }

  #ensureDirectory(...segments: string[]): string {
    const target = path.join(this.#root, ...segments);
    const relative = path.relative(this.#root, target);
    if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Artifact storage path escaped its root");
    const absolute = path.resolve(target);
    const root = path.parse(absolute).root;
    let current = root;
    for (const segment of absolute.slice(root.length).split(path.sep).filter(Boolean)) {
      current = path.join(current, segment);
      try {
        const stat = fs.lstatSync(current);
        if (stat.isSymbolicLink() || !stat.isDirectory()) {
          throw new Error("Artifact storage must contain only real directories");
        }
      } catch (cause) {
        if (!isErrno(cause, "ENOENT")) throw cause;
        fs.mkdirSync(current, { mode: 0o700 });
        const created = fs.lstatSync(current);
        if (created.isSymbolicLink() || !created.isDirectory()) {
          throw new Error("Artifact storage directory creation was redirected");
        }
      }
    }
    if (fs.realpathSync(absolute) !== absolute) {
      throw new Error("Artifact storage must not resolve through aliases or symlinks");
    }
    return absolute;
  }

  #blobFile(contentDigest: string): string {
    safeDigest(contentDigest, "Artifact digest");
    const directory = this.#ensureDirectory("blobs", "sha256", contentDigest.slice(0, 2));
    return path.join(directory, contentDigest);
  }

  #metadataFile(pluginId: string, requestId: string, contentDigest: string): string {
    if (!isHomerailPluginId(pluginId)) throw new Error("Artifact plugin id is invalid");
    safeWireId(requestId, "Artifact request id");
    safeDigest(contentDigest, "Artifact digest");
    // Wire ids may contain ':' and package ids can be long. Only fixed SHA-256
    // directory names reach the filesystem; exact identities remain
    // authenticated inside metadata.
    const directory = this.#ensureDirectory("metadata", digest(pluginId), digest(requestId));
    return path.join(directory, `${contentDigest}.json`);
  }

  #writeTemporary(content: Buffer): string {
    const temporary = path.join(this.#ensureDirectory("tmp"), identifier("artifact"));
    let descriptor: number | undefined;
    try {
      descriptor = fs.openSync(temporary, "wx", 0o600);
      fs.writeFileSync(descriptor, content);
      fs.fsyncSync(descriptor);
      return temporary;
    } catch (cause) {
      try { fs.rmSync(temporary, { force: true }); } catch { /* Preserve original error. */ }
      throw cause;
    } finally {
      if (descriptor !== undefined) fs.closeSync(descriptor);
    }
  }

  #publishNoReplace(temporary: string, destination: string): "created" | "exists" {
    try {
      fs.linkSync(temporary, destination);
      return "created";
    } catch (cause) {
      if (isErrno(cause, "EEXIST")) return "exists";
      throw cause;
    } finally {
      fs.rmSync(temporary, { force: true });
    }
  }

  #readAndVerifyBlob(file: string, expectedDigest: string, expectedSize: number): Buffer {
    const opened = openRegularNoFollow(file);
    try {
      if (opened.stat.size !== expectedSize) throw new Error("Existing content-addressed Artifact size is corrupt");
      const content = fs.readFileSync(opened.descriptor);
      if (digest(content) !== expectedDigest) throw new Error("Existing content-addressed Artifact digest is corrupt");
      return content;
    } finally {
      fs.closeSync(opened.descriptor);
    }
  }

  #metadataBody(metadata: PluginArtifactMetadataV1): Omit<PluginArtifactMetadataV1, "integrity"> {
    const { integrity: _integrity, ...body } = metadata;
    return body;
  }

  #verifyMetadata(raw: unknown): PluginArtifactMetadataV1 {
    if (!raw || typeof raw !== "object" || Array.isArray(raw) || !exactMetadataKeys(raw as Record<string, unknown>)) {
      throw new Error("Artifact metadata is not an exact record");
    }
    const metadata = raw as PluginArtifactMetadataV1;
    if (!metadata.integrity || metadata.integrity.algorithm !== "hmac-sha256"
      || metadata.integrity.key_id !== "manager-artifact-broker-v1"
      || !DIGEST.test(metadata.integrity.value)) {
      throw new Error("Artifact metadata integrity field is invalid");
    }
    const expected = Buffer.from(metadataMac(this.#secret, this.#metadataBody(metadata)), "hex");
    const supplied = Buffer.from(metadata.integrity.value, "hex");
    if (expected.byteLength !== supplied.byteLength || !timingSafeEqual(expected, supplied)) {
      throw new Error("Artifact metadata integrity verification failed");
    }
    return structuredClone(metadata);
  }

  issueWriteCapability(input: {
    authorization: HomerailPluginAuthorizedToolInvocationV1;
    artifact: PluginArtifactWriteDeclarationV1;
    now?: Date;
    ttl_ms?: number;
  }): PluginArtifactWriteCapabilityV1 {
    const now = input.now ?? new Date();
    const authorization = validateHomerailPluginAuthorizedToolInvocation(input.authorization, {
      now_ms: now.getTime(),
    });
    if (!authorization.valid || !authorization.value) {
      throw new Error(`Artifact capability requires an exact authorized Tool: ${JSON.stringify(authorization.errors)}`);
    }
    const invocation = authorization.value.invocation;
    if (invocation.source.type !== "agent") {
      throw new Error("Artifact Broker V1 requires an Agent-origin Tool document scope");
    }
    if (pluginJsonDigest(homerailPluginToolInvocationDigestInput(invocation)) !== invocation.request_digest) {
      throw new Error("Artifact capability Tool request digest is invalid");
    }
    if (!invocation.policy.permissions.includes(HomerailPluginPermission.ARTIFACT_WRITE)
      || !invocation.policy.effective_grants.some((grant) => (
        grant.permission === HomerailPluginPermission.ARTIFACT_WRITE
      ))) {
      throw new Error("Artifact capability requires the exact artifact.write grant");
    }
    const ttl = input.ttl_ms ?? 60_000;
    if (!Number.isSafeInteger(ttl) || ttl < 1 || ttl > HOMERAIL_ARTIFACT_BROKER_MAX_TTL_MS) {
      throw new Error("Artifact capability TTL is outside protocol limits");
    }
    const expiresAt = Math.min(
      now.getTime() + ttl,
      Date.parse(invocation.deadline_at),
      Date.parse(authorization.value.capability.expires_at),
      ...(authorization.value.confirmation
        ? [Date.parse(authorization.value.confirmation.challenge.expires_at)]
        : []),
    );
    if (expiresAt <= now.getTime()) throw new Error("Artifact capability would already be expired");
    const claims: HomerailPluginArtifactWriteCapabilityClaimsV1 = {
      artifact_capability_version: 1,
      capability_id: identifier("artifact_cap"),
      audience: "homerail.artifact-broker",
      scope: "plugin.artifact.write",
      nonce: identifier("artifact_nonce"),
      single_use: true,
      binding: structuredClone(invocation.binding),
      request_id: invocation.request_id,
      request_digest: invocation.request_digest,
      document_scope: {
        ...structuredClone(invocation.source.scope),
        document_id: invocation.source.target.document_id,
      },
      artifact: structuredClone(input.artifact),
      issued_at: now.toISOString(),
      expires_at: new Date(expiresAt).toISOString(),
    };
    const validation = validateHomerailPluginArtifactWriteCapabilityClaims(claims, { now_ms: now.getTime() });
    if (!validation.valid || !validation.value) {
      throw new Error(`Manager produced an invalid Artifact capability: ${JSON.stringify(validation.errors)}`);
    }
    const payload = Buffer.from(homerailPluginArtifactCapabilitySigningInput(validation.value), "utf8").toString("base64url");
    const token = `${TOKEN_PREFIX}.${payload}.${signature(this.#secret, payload).toString("base64url")}`;
    return {
      token,
      claims: validation.value,
      upload_path: `/api/plugins/artifacts/uploads/${encodeURIComponent(validation.value.capability_id)}`,
    };
  }

  inspectWriteCapability(input: {
    token: string;
    capability_id?: string;
    now?: Date;
  }): HomerailPluginArtifactWriteCapabilityClaimsV1 {
    if (Buffer.byteLength(input.token, "utf8") > TOKEN_MAX_BYTES) throw new Error("Artifact capability token is too large");
    const parts = input.token.split(".");
    if (parts.length !== 3 || parts[0] !== TOKEN_PREFIX || !parts[1] || !parts[2]) {
      throw new Error("Artifact capability token format is invalid");
    }
    const expectedSignature = signature(this.#secret, parts[1]);
    let suppliedSignature: Buffer;
    try {
      suppliedSignature = Buffer.from(parts[2], "base64url");
    } catch {
      throw new Error("Artifact capability token signature is invalid");
    }
    if (suppliedSignature.toString("base64url") !== parts[2]) {
      throw new Error("Artifact capability token signature is not canonical");
    }
    if (expectedSignature.byteLength !== suppliedSignature.byteLength
      || !timingSafeEqual(expectedSignature, suppliedSignature)) {
      throw new Error("Artifact capability token signature is invalid");
    }
    let raw: unknown;
    try {
      const decoded = Buffer.from(parts[1], "base64url");
      if (decoded.toString("base64url") !== parts[1]) throw new Error("non-canonical payload");
      raw = JSON.parse(decoded.toString("utf8"));
    } catch {
      throw new Error("Artifact capability token payload is invalid");
    }
    const validation = validateHomerailPluginArtifactWriteCapabilityClaims(raw, {
      now_ms: (input.now ?? new Date()).getTime(),
      expected: input.capability_id ? { capability_id: input.capability_id } : undefined,
    });
    if (!validation.valid || !validation.value) {
      throw new Error(`Artifact capability claims are invalid: ${JSON.stringify(validation.errors)}`);
    }
    if (homerailPluginArtifactCapabilitySigningInput(validation.value)
      !== Buffer.from(parts[1], "base64url").toString("utf8")) {
      throw new Error("Artifact capability payload is not canonical");
    }
    if (this.#consumedNonces.has(validation.value.nonce)) {
      throw new Error("Artifact capability was already consumed");
    }
    return validation.value;
  }

  publish(input: {
    token: string;
    capability_id: string;
    content_type: string;
    content: Buffer;
    now?: Date;
  }): PluginArtifactMetadataV1 {
    const now = input.now ?? new Date();
    const claims = this.inspectWriteCapability({
      token: input.token,
      capability_id: input.capability_id,
      now,
    });
    if (input.content_type !== claims.artifact.media_type) throw new Error("Artifact Content-Type does not match its capability");
    if (input.content.byteLength !== claims.artifact.size_bytes) throw new Error("Artifact byte length does not match its capability");
    if (digest(input.content) !== claims.artifact.digest) throw new Error("Artifact digest does not match its capability");
    assertContentMatchesMediaType(input.content, claims.artifact.media_type);
    this.#consumedNonces.add(claims.nonce);

    const blobFile = this.#blobFile(claims.artifact.digest);
    const blobTemporary = this.#writeTemporary(input.content);
    const blobResult = this.#publishNoReplace(blobTemporary, blobFile);
    if (blobResult === "exists") {
      this.#readAndVerifyBlob(blobFile, claims.artifact.digest, claims.artifact.size_bytes);
    }

    const readPath = `/api/plugins/artifacts/${encodeURIComponent(claims.binding.plugin_id)}`
      + `/${encodeURIComponent(claims.request_id)}/${claims.artifact.digest}`;
    const body: Omit<PluginArtifactMetadataV1, "integrity"> = {
      metadata_version: 1,
      artifact_id: `sha256:${claims.artifact.digest}`,
      uri: `artifact:sha256/${claims.artifact.digest}`,
      read_path: readPath,
      capability_id: claims.capability_id,
      binding: structuredClone(claims.binding),
      request_id: claims.request_id,
      request_digest: claims.request_digest,
      document_scope: structuredClone(claims.document_scope),
      label: claims.artifact.label,
      media_type: claims.artifact.media_type,
      digest: claims.artifact.digest,
      size_bytes: claims.artifact.size_bytes,
      created_at: now.toISOString(),
    };
    const metadata: PluginArtifactMetadataV1 = {
      ...body,
      integrity: {
        algorithm: "hmac-sha256",
        key_id: "manager-artifact-broker-v1",
        value: metadataMac(this.#secret, body),
      },
    };
    const metadataFile = this.#metadataFile(claims.binding.plugin_id, claims.request_id, claims.artifact.digest);
    const metadataTemporary = this.#writeTemporary(Buffer.from(`${stableStringify(metadata)}\n`, "utf8"));
    if (this.#publishNoReplace(metadataTemporary, metadataFile) === "exists") {
      throw new Error("Artifact metadata already exists; capability replay refused");
    }
    return structuredClone(metadata);
  }

  read(input: { plugin_id: string; request_id: string; digest: string }): PluginArtifactReadResultV1 {
    const metadataFile = this.#metadataFile(input.plugin_id, input.request_id, input.digest);
    let opened: { descriptor: number; stat: fs.Stats };
    try {
      opened = openRegularNoFollow(metadataFile);
    } catch (cause) {
      if (isErrno(cause, "ENOENT")) throw new Error("Artifact metadata was not found");
      throw cause;
    }
    let raw: unknown;
    try {
      if (opened.stat.size < 2 || opened.stat.size > 64 * 1024) throw new Error("Artifact metadata size is invalid");
      raw = JSON.parse(fs.readFileSync(opened.descriptor, "utf8"));
    } finally {
      fs.closeSync(opened.descriptor);
    }
    const metadata = this.#verifyMetadata(raw);
    if (metadata.binding.plugin_id !== input.plugin_id
      || metadata.request_id !== input.request_id
      || metadata.digest !== input.digest
      || metadata.artifact_id !== `sha256:${input.digest}`
      || metadata.uri !== `artifact:sha256/${input.digest}`) {
      throw new Error("Artifact metadata scope binding is invalid");
    }
    const content = this.#readAndVerifyBlob(
      this.#blobFile(input.digest),
      input.digest,
      metadata.size_bytes,
    );
    return { metadata, content };
  }
}

let defaultArtifactBroker: { root: string; value: PluginArtifactBroker } | undefined;

export function getPluginArtifactBroker(): PluginArtifactBroker {
  const root = path.join(getDataRoot(), "plugin-artifacts");
  if (!defaultArtifactBroker || defaultArtifactBroker.root !== root) {
    defaultArtifactBroker = {
      root,
      value: new PluginArtifactBroker({ root, secret: loadPluginCapabilitySecret() }),
    };
  }
  return defaultArtifactBroker.value;
}
