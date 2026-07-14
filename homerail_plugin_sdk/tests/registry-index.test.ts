import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { canonicalHrpJsonBytes } from "../src/archive.js";
import {
  buildSignedPluginRegistryIndex,
  verifyPluginRegistryIndex,
  type PluginRegistryReleaseV1,
} from "../src/registry-index.js";

const now = "2026-07-12T00:00:00.000Z";
const issued = "2026-07-11T23:59:00.000Z";
const expires = "2026-07-13T00:00:00.000Z";
const digestA = "a".repeat(64);
const digestB = "b".repeat(64);
const publisher = `sha256:${"c".repeat(64)}`;

function releases(): PluginRegistryReleaseV1[] {
  return [{
    plugin_id: "com.example.release-notes",
    plugin_version: "1.0.0",
    archive_path: "releases/release-notes-1.0.0.hrp",
    archive_digest: digestA,
    payload_digest: digestB,
    publisher_key_id: publisher,
  }];
}

function signed(overrides: Partial<{
  registry_id: string;
  sequence: number;
  issued_at: string;
  expires_at: string;
  releases: PluginRegistryReleaseV1[];
}> = {}) {
  const { privateKey } = generateKeyPairSync("ed25519");
  return buildSignedPluginRegistryIndex({
    registry_id: "stable.example",
    sequence: 7,
    issued_at: issued,
    expires_at: expires,
    releases: releases(),
    ...overrides,
  }, { private_key: privateKey });
}

describe("signed plugin registry index", () => {
  it("round-trips canonical bytes with an Ed25519 root pin and release digests", () => {
    const built = signed();
    expect(built.bytes.equals(canonicalHrpJsonBytes(built.index))).toBe(true);
    expect(built.root_pin).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(verifyPluginRegistryIndex(built.bytes, {
      expected_registry_id: "stable.example",
      root_pin: built.root_pin,
      min_sequence: 6,
      now,
    })).toEqual({
      index: built.index,
      index_digest: built.index_digest,
      root_pin: built.root_pin,
    });
  });

  it("rejects noncanonical, tampered, unpinned, rollback, expired, and future indexes", () => {
    const built = signed();
    const pretty = Buffer.from(`${JSON.stringify(built.index, null, 2)}\n`);
    expect(() => verifyPluginRegistryIndex(pretty, {
      expected_registry_id: "stable.example",
      root_pin: built.root_pin,
      now,
    })).toThrow(/canonical JSON/);

    const tampered = { ...built.index, sequence: 8 };
    expect(() => verifyPluginRegistryIndex(canonicalHrpJsonBytes(tampered), {
      expected_registry_id: "stable.example",
      root_pin: built.root_pin,
      now,
    })).toThrow(/signature is invalid/);
    expect(() => verifyPluginRegistryIndex(built.bytes, {
      expected_registry_id: "stable.example",
      root_pin: `sha256:${"d".repeat(64)}`,
      now,
    })).toThrow(/root pin mismatch/);
    expect(() => verifyPluginRegistryIndex(built.bytes, {
      expected_registry_id: "other.example",
      root_pin: built.root_pin,
      now,
    })).toThrow(/registry id mismatch/);
    expect(() => verifyPluginRegistryIndex(built.bytes, {
      expected_registry_id: "stable.example",
      root_pin: built.root_pin,
      min_sequence: 7,
      now,
    })).toThrow(/rollback or replay/);

    const expired = signed({ expires_at: "2026-07-11T23:59:30.000Z" });
    expect(() => verifyPluginRegistryIndex(expired.bytes, {
      expected_registry_id: "stable.example",
      root_pin: expired.root_pin,
      now,
    })).toThrow(/expired/);
    const future = signed({
      issued_at: "2026-07-12T01:00:00.000Z",
      expires_at: "2026-07-13T01:00:00.000Z",
    });
    expect(() => verifyPluginRegistryIndex(future.bytes, {
      expected_registry_id: "stable.example",
      root_pin: future.root_pin,
      now,
      max_future_ms: 0,
    })).toThrow(/future/);
  });

  it("requires sorted unique releases, canonical identities, and relative archive paths", () => {
    const second: PluginRegistryReleaseV1 = {
      ...releases()[0],
      plugin_id: "com.example.another",
      archive_path: "releases/another-1.0.0.hrp",
    };
    expect(() => signed({ releases: [releases()[0], second] })).toThrow(/uniquely sorted/);
    expect(() => signed({ releases: [releases()[0], { ...releases()[0] }] })).toThrow(/uniquely sorted|duplicate/);
    expect(() => signed({
      releases: [{ ...releases()[0], archive_path: "../release.hrp" }],
    })).toThrow(/package-relative|portable/);
    expect(() => signed({
      releases: [{ ...releases()[0], archive_digest: "A".repeat(64) }],
    })).toThrow(/malformed/);
    expect(() => signed({
      releases: [{ ...releases()[0], plugin_version: "v1.0.0" }],
    })).toThrow(/malformed/);
  });
});
