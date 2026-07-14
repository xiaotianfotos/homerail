import { createHash, generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  TRUSTED_RUNTIME_NODES_ENV,
  loadPluginRuntimeSandboxGate,
} from "../src/plugins/runtime-sandbox-config.js";
import {
  DenyUnverifiedPluginRuntimeSandboxGate,
  VerifiedPluginRuntimeSandboxGate,
} from "../src/plugins/runtime-broker.js";

function pin(keyId?: string): Record<string, string> {
  const { publicKey } = generateKeyPairSync("ed25519");
  const der = publicKey.export({ format: "der", type: "spki" }) as Buffer;
  return {
    node_id: "node-runtime-pinned",
    key_id: keyId ?? `node_${createHash("sha256").update(der).digest("hex").slice(0, 24)}`,
    public_key: der.toString("base64url"),
  };
}

describe("Plugin Runtime Node key pinning", () => {
  it("defaults to a deny-unverified gate when no pins are configured", () => {
    expect(loadPluginRuntimeSandboxGate({})).toBeInstanceOf(DenyUnverifiedPluginRuntimeSandboxGate);
  });

  it("accepts only the key_id canonically derived from the exact Ed25519 SPKI", () => {
    const exact = pin();
    expect(loadPluginRuntimeSandboxGate({
      [TRUSTED_RUNTIME_NODES_ENV]: JSON.stringify([exact]),
    })).toBeInstanceOf(VerifiedPluginRuntimeSandboxGate);
    expect(() => loadPluginRuntimeSandboxGate({
      [TRUSTED_RUNTIME_NODES_ENV]: JSON.stringify([{ ...exact, key_id: "node_aaaaaaaaaaaaaaaaaaaaaaaa" }]),
    })).toThrow(/key_id does not match.*SPKI/);
  });
});
