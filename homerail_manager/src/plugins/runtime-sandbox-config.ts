/** Manager-side explicit Node attestation key pinning. @version 0.1.0 */

import { createHash, createPublicKey } from "node:crypto";
import {
  DenyUnverifiedPluginRuntimeSandboxGate,
  VerifiedPluginRuntimeSandboxGate,
  type PluginRuntimeSandboxGate,
} from "./runtime-broker.js";

export const TRUSTED_RUNTIME_NODES_ENV = "HOMERAIL_PLUGIN_RUNTIME_TRUSTED_NODES";

export function loadPluginRuntimeSandboxGate(
  env: NodeJS.ProcessEnv = process.env,
): PluginRuntimeSandboxGate {
  const encoded = env[TRUSTED_RUNTIME_NODES_ENV]?.trim();
  if (!encoded) return new DenyUnverifiedPluginRuntimeSandboxGate();
  let raw: unknown;
  try {
    raw = JSON.parse(encoded);
  } catch {
    throw new Error(`${TRUSTED_RUNTIME_NODES_ENV} must be valid JSON`);
  }
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > 64) {
    throw new Error(`${TRUSTED_RUNTIME_NODES_ENV} must contain 1-64 pinned Node keys`);
  }
  const trusted = raw.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error(`Pinned Runtime Node ${index} is invalid`);
    const value = entry as Record<string, unknown>;
    if (Object.keys(value).sort().join(",") !== "key_id,node_id,public_key") throw new Error(`Pinned Runtime Node ${index} has unknown fields`);
    if (typeof value.node_id !== "string" || typeof value.key_id !== "string" || typeof value.public_key !== "string") {
      throw new Error(`Pinned Runtime Node ${index} identity is invalid`);
    }
    let publicKey;
    try {
      const bytes = Buffer.from(value.public_key, "base64url");
      if (bytes.toString("base64url") !== value.public_key) throw new Error("non-canonical");
      publicKey = createPublicKey({ key: bytes, format: "der", type: "spki" });
    } catch {
      throw new Error(`Pinned Runtime Node ${index} public key is invalid`);
    }
    if (publicKey.asymmetricKeyType !== "ed25519") throw new Error(`Pinned Runtime Node ${index} key must use Ed25519`);
    const publicDer = publicKey.export({ format: "der", type: "spki" }) as Buffer;
    const expectedKeyId = `node_${createHash("sha256").update(publicDer).digest("hex").slice(0, 24)}`;
    if (value.key_id !== expectedKeyId) {
      throw new Error(`Pinned Runtime Node ${index} key_id does not match its Ed25519 SPKI`);
    }
    return { node_id: value.node_id, key_id: value.key_id, public_key: publicKey };
  });
  return new VerifiedPluginRuntimeSandboxGate({
    trusted_nodes: trusted,
    allowed_profile_ids: new Set(["homerail.plugin-runtime.v1"]),
  });
}

let defaultGate: PluginRuntimeSandboxGate | undefined;

export function getPluginRuntimeSandboxGate(): PluginRuntimeSandboxGate {
  defaultGate ??= loadPluginRuntimeSandboxGate();
  return defaultGate;
}

export function _resetPluginRuntimeSandboxGateForTest(): void {
  defaultGate = undefined;
}
