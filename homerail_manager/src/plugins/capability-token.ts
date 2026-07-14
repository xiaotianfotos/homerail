import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  HOMERAIL_ACTION_CAPABILITY_MAX_TTL_MS,
  homerailPluginToolInvocationDigestInput,
  validateHomerailPluginToolCapabilityClaims,
  validateHomerailPluginToolInvocation,
  type HomerailPluginToolCapabilityClaimsV1,
  type HomerailPluginToolInvocationV1,
} from "homerail-protocol";
import { getDataRoot } from "../config/env.js";
import { getPluginPermissionRevision } from "../persistence/plugins.js";
import {
  consumePluginToolCapabilityNonce,
  recordPluginToolCapabilityNonce,
} from "../persistence/plugin-actions.js";
import { pluginJsonDigest } from "./descriptor.js";

const TOKEN_PREFIX = "hrcap1";
const TOKEN_MAX_BYTES = 24 * 1024;
const SECRET_BYTES = 32;
const SECRET_ENV = "HOMERAIL_PLUGIN_CAPABILITY_SECRET";

function tokenDigest(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function identifier(prefix: string): string {
  return `${prefix}_${randomBytes(18).toString("hex")}`;
}

function signature(secret: Buffer, payload: string): Buffer {
  return createHmac("sha256", secret).update(`${TOKEN_PREFIX}.${payload}`, "utf8").digest();
}

function validateSecret(secret: Buffer): Buffer {
  if (secret.byteLength < SECRET_BYTES || secret.byteLength > 4 * 1024) {
    throw new Error(`Plugin capability secret must contain ${SECRET_BYTES}-4096 bytes`);
  }
  return Buffer.from(secret);
}

function readSecretFile(filePath: string): Buffer {
  const stat = fs.lstatSync(filePath);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error("Plugin capability secret must be a regular file");
  if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) {
    throw new Error("Plugin capability secret must not be group/world accessible");
  }
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
    throw new Error("Plugin capability secret is owned by another user");
  }
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    const opened = fs.fstatSync(descriptor);
    if (!opened.isFile() || opened.dev !== stat.dev || opened.ino !== stat.ino) {
      throw new Error("Plugin capability secret changed while opening");
    }
    const encoded = fs.readFileSync(descriptor, "utf8").trim();
    if (!/^[A-Za-z0-9_-]{43}$/.test(encoded)) throw new Error("Plugin capability secret file is invalid");
    const secret = Buffer.from(encoded, "base64url");
    if (secret.byteLength !== SECRET_BYTES || secret.toString("base64url") !== encoded) {
      throw new Error("Plugin capability secret file is invalid");
    }
    return secret;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function ensureRealDirectoryTree(directory: string): string {
  const absolute = path.resolve(directory);
  const root = path.parse(absolute).root;
  let current = root;
  for (const segment of absolute.slice(root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    try {
      const stat = fs.lstatSync(current);
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw new Error("Plugin capability secret parent must contain only real directories");
      }
    } catch (cause) {
      if (!(cause instanceof Error && "code" in cause && cause.code === "ENOENT")) throw cause;
      fs.mkdirSync(current, { mode: 0o700 });
      const created = fs.lstatSync(current);
      if (created.isSymbolicLink() || !created.isDirectory()) {
        throw new Error("Plugin capability secret parent creation was redirected");
      }
    }
  }
  if (fs.realpathSync(absolute) !== absolute) {
    throw new Error("Plugin capability secret parent must not resolve through aliases or symlinks");
  }
  return absolute;
}

/** Load a Manager-only HMAC key. The key never enters plugin descriptors or RPC. */
export function loadPluginCapabilitySecret(filePath = path.join(getDataRoot(), "plugin-capability.key")): Buffer {
  const environment = process.env[SECRET_ENV];
  if (environment !== undefined) {
    if (environment !== environment.trim() || /[\u0000-\u001f\u007f]/.test(environment)) {
      throw new Error(`${SECRET_ENV} must not contain surrounding whitespace or control bytes`);
    }
    return validateSecret(Buffer.from(environment, "utf8"));
  }
  const absoluteFile = path.resolve(filePath);
  const directory = ensureRealDirectoryTree(path.dirname(absoluteFile));
  try {
    return readSecretFile(absoluteFile);
  } catch (cause) {
    if (!(cause instanceof Error && "code" in cause && cause.code === "ENOENT")) throw cause;
  }
  const secret = randomBytes(SECRET_BYTES);
  let descriptor: number | undefined;
  let created = false;
  try {
    descriptor = fs.openSync(absoluteFile, "wx", 0o600);
    created = true;
    fs.writeFileSync(descriptor, `${secret.toString("base64url")}\n`, "utf8");
    fs.fsyncSync(descriptor);
  } catch (cause) {
    if (cause instanceof Error && "code" in cause && cause.code === "EEXIST") return readSecretFile(absoluteFile);
    if (created) {
      try { fs.rmSync(absoluteFile, { force: true }); } catch { /* Preserve the original error. */ }
    }
    throw cause;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
  const finalDirectory = fs.lstatSync(directory);
  if (finalDirectory.isSymbolicLink() || !finalDirectory.isDirectory() || fs.realpathSync(directory) !== directory) {
    throw new Error("Plugin capability secret parent changed during creation");
  }
  return secret;
}

export class PluginToolCapabilityTokenAuthority {
  readonly #secret: Buffer;

  constructor(secret: Buffer | string) {
    this.#secret = validateSecret(Buffer.isBuffer(secret) ? secret : Buffer.from(secret, "utf8"));
  }

  issue(input: {
    invocation: HomerailPluginToolInvocationV1;
    now?: Date;
    ttl_ms?: number;
  }): { token: string; claims: HomerailPluginToolCapabilityClaimsV1; token_digest: string } {
    const now = input.now ?? new Date();
    const nowMs = now.getTime();
    const invocationValidation = validateHomerailPluginToolInvocation(input.invocation, { now_ms: nowMs });
    if (!invocationValidation.valid || !invocationValidation.value) {
      throw new Error(`Cannot issue capability for invalid Tool: ${JSON.stringify(invocationValidation.errors)}`);
    }
    const invocation = invocationValidation.value;
    if (pluginJsonDigest(homerailPluginToolInvocationDigestInput(invocation)) !== invocation.request_digest) {
      throw new Error("Cannot issue capability for a Tool with an invalid request digest");
    }
    if (invocation.binding.permission_revision !== getPluginPermissionRevision()) {
      throw new Error("Cannot issue capability from a stale permission snapshot");
    }
    const requestedTtl = input.ttl_ms ?? 60_000;
    if (!Number.isSafeInteger(requestedTtl) || requestedTtl < 1 || requestedTtl > HOMERAIL_ACTION_CAPABILITY_MAX_TTL_MS) {
      throw new Error("Plugin capability TTL is outside protocol limits");
    }
    const expiresMs = Math.min(nowMs + requestedTtl, Date.parse(invocation.deadline_at));
    if (expiresMs <= nowMs) throw new Error("Plugin capability would already be expired");
    const claims: HomerailPluginToolCapabilityClaimsV1 = {
      capability_version: 1,
      capability_id: identifier("cap"),
      audience: "homerail.plugin-runtime",
      scope: "plugin.tool.execute",
      nonce: identifier("nonce"),
      single_use: true,
      request_id: invocation.request_id,
      request_digest: invocation.request_digest,
      binding: structuredClone(invocation.binding),
      effect: invocation.policy.effect,
      permissions: [...invocation.policy.permissions],
      effective_grants: structuredClone(invocation.policy.effective_grants),
      issued_at: now.toISOString(),
      expires_at: new Date(expiresMs).toISOString(),
    };
    const validation = validateHomerailPluginToolCapabilityClaims(claims, invocation, { now_ms: nowMs });
    if (!validation.valid || !validation.value) {
      throw new Error(`Manager produced an invalid plugin capability: ${JSON.stringify(validation.errors)}`);
    }
    const payload = Buffer.from(JSON.stringify(validation.value), "utf8").toString("base64url");
    const token = `${TOKEN_PREFIX}.${payload}.${signature(this.#secret, payload).toString("base64url")}`;
    const digest = tokenDigest(token);
    recordPluginToolCapabilityNonce({
      nonce: validation.value.nonce,
      capability_id: validation.value.capability_id,
      request_id: validation.value.request_id,
      request_digest: validation.value.request_digest,
      token_digest: digest,
      expires_at: validation.value.expires_at,
      created_at: validation.value.issued_at,
    });
    return { token, claims: validation.value, token_digest: digest };
  }

  verifyAndConsume(input: {
    token: string;
    invocation: HomerailPluginToolInvocationV1;
    now?: Date;
  }): HomerailPluginToolCapabilityClaimsV1 {
    if (Buffer.byteLength(input.token, "utf8") > TOKEN_MAX_BYTES) throw new Error("Plugin capability token is too large");
    const parts = input.token.split(".");
    if (parts.length !== 3 || parts[0] !== TOKEN_PREFIX || !parts[1] || !parts[2]) {
      throw new Error("Plugin capability token format is invalid");
    }
    let supplied: Buffer;
    let claims: unknown;
    try {
      supplied = Buffer.from(parts[2], "base64url");
      const payloadBytes = Buffer.from(parts[1], "base64url");
      if (
        !/^[A-Za-z0-9_-]+$/.test(parts[1])
        || !/^[A-Za-z0-9_-]+$/.test(parts[2])
        || payloadBytes.toString("base64url") !== parts[1]
        || supplied.toString("base64url") !== parts[2]
      ) throw new Error("noncanonical base64url");
      claims = JSON.parse(payloadBytes.toString("utf8"));
    } catch {
      throw new Error("Plugin capability token encoding is invalid");
    }
    const expected = signature(this.#secret, parts[1]);
    if (supplied.byteLength !== expected.byteLength || !timingSafeEqual(supplied, expected)) {
      throw new Error("Plugin capability token signature is invalid");
    }
    if (input.invocation.binding.permission_revision !== getPluginPermissionRevision()) {
      throw new Error("Plugin capability permission snapshot is stale");
    }
    if (pluginJsonDigest(homerailPluginToolInvocationDigestInput(input.invocation)) !== input.invocation.request_digest) {
      throw new Error("Plugin capability Tool request digest is invalid");
    }
    const now = input.now ?? new Date();
    const validation = validateHomerailPluginToolCapabilityClaims(
      claims,
      input.invocation,
      { now_ms: now.getTime() },
    );
    if (!validation.valid || !validation.value) {
      throw new Error(`Plugin capability claims are invalid: ${JSON.stringify(validation.errors)}`);
    }
    consumePluginToolCapabilityNonce({
      nonce: validation.value.nonce,
      request_id: validation.value.request_id,
      request_digest: validation.value.request_digest,
      token_digest: tokenDigest(input.token),
      consumed_at: now.toISOString(),
    });
    return validation.value;
  }
}
