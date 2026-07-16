import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { generateKeyPairSync } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildSignedHrpArchive,
  HRP_MANIFEST_FILE,
  verifyHrpArchive,
} from "homerail-plugin-sdk";
import { closeDb, getDb } from "../src/persistence/db.js";
import {
  getPluginDistributionRevision,
  listPluginPublisherTrust,
  listPluginPublisherTrustEvents,
  setPluginPublisherTrust,
} from "../src/persistence/plugin-distribution.js";

describe("plugin publisher trust persistence", () => {
  let previousHome: string | undefined;
  let home: string;

  beforeEach(() => {
    closeDb();
    previousHome = process.env.HOMERAIL_HOME;
    home = fs.mkdtempSync(path.join(os.tmpdir(), "homerail-plugin-distribution-"));
    process.env.HOMERAIL_HOME = home;
  });

  afterEach(() => {
    closeDb();
    if (previousHome === undefined) delete process.env.HOMERAIL_HOME;
    else process.env.HOMERAIL_HOME = previousHome;
    fs.rmSync(home, { recursive: true, force: true });
  });

  function signedPackage() {
    const { privateKey } = generateKeyPairSync("ed25519");
    return buildSignedHrpArchive([{
      path: HRP_MANIFEST_FILE,
      content: Buffer.from(JSON.stringify({
        manifest_version: 1,
        id: "com.example.signed",
        version: "1.0.0",
      })),
    }], {
      publisher: "Example Publisher",
      private_key: privateKey,
    });
  }

  it("records monotonic trust and permanent revocation with append-only audit", () => {
    const signed = signedPackage();
    const entry = {
      publisher: signed.signature.publisher,
      key_id: signed.signature.key_id,
      public_key_spki: signed.signature.public_key_spki,
      state: "trusted" as const,
    };
    expect(getPluginDistributionRevision()).toBe(0);
    const trusted = setPluginPublisherTrust({
      entry,
      expected_revision: 0,
      actor: "test-operator",
      data: { source: "test" },
      timestamp: "2026-07-11T00:00:00.000Z",
    });
    expect(trusted).toMatchObject({
      distribution_revision: 1,
      idempotent: false,
      record: { state: "trusted", revision: 1 },
    });
    expect(verifyHrpArchive(signed.archive, {
      allow_signature: true,
      trust_store: listPluginPublisherTrust(),
      require_trusted_signature: true,
    }).signature_state).toBe("verified");

    expect(setPluginPublisherTrust({
      entry,
      expected_revision: 1,
      actor: "test-operator",
    })).toMatchObject({ distribution_revision: 1, idempotent: true });

    const revoked = setPluginPublisherTrust({
      entry: { ...entry, state: "revoked" },
      expected_revision: 1,
      actor: "security-operator",
      reason: "publisher key compromised",
      timestamp: "2026-07-11T00:01:00.000Z",
    });
    expect(revoked).toMatchObject({
      distribution_revision: 2,
      idempotent: false,
      record: { state: "revoked", revision: 2, reason: "publisher key compromised" },
    });
    expect(verifyHrpArchive(signed.archive, {
      allow_signature: true,
      trust_store: listPluginPublisherTrust(),
    }).signature_state).toBe("revoked");
    expect(() => setPluginPublisherTrust({
      entry,
      expected_revision: 2,
      actor: "test-operator",
    })).toThrow(/cannot be trusted again/);
    expect(listPluginPublisherTrustEvents()).toEqual([
      expect.objectContaining({
        seq: 1,
        to_state: "trusted",
        trust_revision: 1,
        distribution_revision: 1,
        data: { source: "test" },
      }),
      expect.objectContaining({
        seq: 2,
        from_state: "trusted",
        to_state: "revoked",
        trust_revision: 2,
        distribution_revision: 2,
        reason: "publisher key compromised",
      }),
    ]);
  });

  it("fails revision, identity, and revocation validation without partial writes", () => {
    const signed = signedPackage();
    const entry = {
      publisher: signed.signature.publisher,
      key_id: signed.signature.key_id,
      public_key_spki: signed.signature.public_key_spki,
      state: "trusted" as const,
    };
    setPluginPublisherTrust({ entry, actor: "test-operator" });
    expect(() => setPluginPublisherTrust({
      entry: { ...entry, state: "revoked" },
      expected_revision: 0,
      actor: "test-operator",
      reason: "stale request",
    })).toThrow(/revision conflict/);
    expect(() => setPluginPublisherTrust({
      entry: { ...entry, state: "revoked" },
      expected_revision: 1,
      actor: "test-operator",
    })).toThrow(/requires a reason/);
    expect(getPluginDistributionRevision()).toBe(1);
    expect(listPluginPublisherTrust()).toEqual([
      expect.objectContaining({ state: "trusted", revision: 1 }),
    ]);
    expect(listPluginPublisherTrustEvents()).toHaveLength(1);
    expect(getDb().prepare(
      "SELECT MAX(version) AS version FROM schema_migrations",
    ).get()).toEqual({ version: 27 });
  });
});
