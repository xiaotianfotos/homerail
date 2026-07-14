import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { generateKeyPairSync } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildHrpArchive,
  buildSignedHrpArchive,
  buildSignedPluginRegistryIndex,
  canonicalHrpJsonBytes,
  scaffoldPluginProject,
  scanPluginSource,
  sourceFilesForPack,
} from "homerail-plugin-sdk";
import { closeDb, getDb } from "../src/persistence/db.js";
import {
  getPluginRegistrySource,
  listPluginRegistryReleases,
  listPluginRegistryUpdateAttempts,
  normalizePluginRegistrySourceUrl,
} from "../src/persistence/plugin-registry-distribution.js";
import { setPluginPublisherTrust } from "../src/persistence/plugin-distribution.js";
import {
  activateInstalledPlugin,
  enableInstalledPlugin,
  installHrpArchive,
} from "../src/plugins/package-lifecycle.js";
import {
  activateRemotePluginRegistryRelease,
  configureRemotePluginRegistry,
  enableRemotePluginRegistryRelease,
  installRemotePluginRegistryRelease,
  rollbackRemotePluginRegistryRelease,
  syncRemotePluginRegistryIndex,
} from "../src/plugins/remote-registry.js";
import { getActivePlugin, listPluginVersions } from "../src/persistence/plugins.js";

const CATALOG_TEST_NOW = "2026-07-12T00:00:00.000Z";

describe("signed remote plugin registry", () => {
  let previousHome: string | undefined;
  let home: string;
  let sourceRoot: string;
  const publisherKeys = generateKeyPairSync("ed25519");
  const registryKeys = generateKeyPairSync("ed25519");

  beforeEach(() => {
    closeDb();
    previousHome = process.env.HOMERAIL_HOME;
    home = fs.mkdtempSync(path.join(os.tmpdir(), "homerail-remote-registry-home-"));
    sourceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "homerail-remote-registry-source-"));
    process.env.HOMERAIL_HOME = home;
    scaffoldPluginProject(sourceRoot, "com.example.registry-plugin", {
      name: "Registry Plugin",
      version: "1.0.0",
    });
  });

  afterEach(() => {
    closeDb();
    if (previousHome === undefined) delete process.env.HOMERAIL_HOME;
    else process.env.HOMERAIL_HOME = previousHome;
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(sourceRoot, { recursive: true, force: true });
  });

  function setVersion(version: string): void {
    const manifestFile = path.join(sourceRoot, "homerail.plugin.json");
    const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8")) as Record<string, unknown>;
    manifest.version = version;
    fs.writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
  }

  function signedArchive(version: string) {
    setVersion(version);
    return buildSignedHrpArchive(sourceFilesForPack(scanPluginSource(sourceRoot)), {
      publisher: "com.example",
      private_key: publisherKeys.privateKey,
    });
  }

  function configureAndTrust(first: ReturnType<typeof signedArchive>): string {
    setPluginPublisherTrust({
      entry: {
        publisher: first.signature.publisher,
        key_id: first.signature.key_id,
        public_key_spki: first.signature.public_key_spki,
        state: "trusted",
      },
      actor: "test-operator",
    });
    const empty = buildSignedPluginRegistryIndex({
      registry_id: "stable.example",
      sequence: 1,
      issued_at: "2026-07-11T23:59:00.000Z",
      expires_at: "2026-07-13T00:00:00.000Z",
      releases: [],
    }, { private_key: registryKeys.privateKey });
    configureRemotePluginRegistry({
      registry_id: "stable.example",
      source_url: "https://registry.example/index.json",
      root_key_id: empty.root_pin,
    });
    return empty.root_pin;
  }

  function indexFor(
    sequence: number,
    rootPin: string,
    packages: Array<ReturnType<typeof signedArchive>>,
    times: { issued_at?: string; expires_at?: string } = {},
  ) {
    const built = buildSignedPluginRegistryIndex({
      registry_id: "stable.example",
      sequence,
      issued_at: times.issued_at ?? "2026-07-11T23:59:00.000Z",
      expires_at: times.expires_at ?? "2026-07-13T00:00:00.000Z",
      releases: packages.map((candidate) => ({
        plugin_id: candidate.lock.plugin.id,
        plugin_version: candidate.lock.plugin.version,
        archive_path: `releases/plugin-${candidate.lock.plugin.version}.hrp`,
        archive_digest: candidate.archive_digest,
        payload_digest: candidate.lock.payload_digest,
        publisher_key_id: candidate.signature.key_id,
      })),
    }, { private_key: registryKeys.privateKey });
    expect(built.root_pin).toBe(rootPin);
    return built;
  }

  it("accepts only HTTPS or loopback HTTP registry source URLs without ambient credentials", () => {
    expect(normalizePluginRegistrySourceUrl("https://registry.example/index.json"))
      .toBe("https://registry.example/index.json");
    expect(normalizePluginRegistrySourceUrl("http://127.0.0.1:8123/index.json"))
      .toBe("http://127.0.0.1:8123/index.json");
    expect(() => normalizePluginRegistrySourceUrl("http://registry.example/index.json"))
      .toThrow(/HTTPS or loopback/);
    expect(() => normalizePluginRegistrySourceUrl("https://registry.example/index.json?token=secret"))
      .toThrow(/query/);
    expect(() => normalizePluginRegistrySourceUrl("https://user:secret@registry.example/index.json"))
      .toThrow(/credentials/);
  });

  it("distributes a signed executable package without running install-time plugin code", () => {
    const marker = path.join(home, "must-not-exist");
    const manifestFile = path.join(sourceRoot, "homerail.plugin.json");
    const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8")) as {
      runtime: Record<string, unknown>;
      tools: Array<{ handler: Record<string, unknown> }>;
    };
    manifest.runtime = {
      trust: "sandboxed_runtime",
      plugin_api: 1,
      entrypoint: { file: "runtime/index.js", args: [] },
    };
    manifest.tools[0].handler = { type: "runtime", method: "project" };
    fs.mkdirSync(path.join(sourceRoot, "runtime"));
    fs.writeFileSync(
      path.join(sourceRoot, "runtime/index.js"),
      `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "executed");\n`,
    );
    fs.writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
    const snapshot = scanPluginSource(sourceRoot);
    expect(snapshot.valid).toBe(true);
    const executable = buildSignedHrpArchive(sourceFilesForPack(snapshot), {
      publisher: "com.example",
      private_key: publisherKeys.privateKey,
    });
    const rootPin = configureAndTrust(executable);
    const catalog = indexFor(2, rootPin, [executable]);
    syncRemotePluginRegistryIndex({
      registry_id: "stable.example",
      index_bytes: catalog.bytes,
      now: "2026-07-12T00:00:00.000Z",
    });

    const result = installRemotePluginRegistryRelease({
      registry_id: "stable.example",
      plugin_id: "com.example.registry-plugin",
      plugin_version: "1.0.0",
      archive: executable.archive,
      now: CATALOG_TEST_NOW,
    });
    expect(result.installed.installation).toMatchObject({
      lifecycle_state: "staged",
      health_state: "unchecked",
      signature_state: "verified",
    });
    expect(fs.existsSync(marker)).toBe(false);
  });

  it("atomically preserves the old catalog on rollback, expiry, and tamper failures", () => {
    const first = signedArchive("1.0.0");
    const rootPin = configureAndTrust(first);
    const initial = indexFor(2, rootPin, [first]);
    syncRemotePluginRegistryIndex({
      registry_id: "stable.example",
      index_bytes: initial.bytes,
      now: "2026-07-12T00:00:00.000Z",
    });
    expect(listPluginRegistryReleases("stable.example")).toEqual([
      expect.objectContaining({ plugin_version: "1.0.0", index_sequence: 2 }),
    ]);

    expect(() => syncRemotePluginRegistryIndex({
      registry_id: "stable.example",
      index_bytes: initial.bytes,
      now: "2026-07-12T00:00:00.000Z",
    })).toThrow(/rollback or replay/);

    const expired = indexFor(3, rootPin, [first], {
      issued_at: "2026-07-11T22:00:00.000Z",
      expires_at: "2026-07-11T23:00:00.000Z",
    });
    expect(() => syncRemotePluginRegistryIndex({
      registry_id: "stable.example",
      index_bytes: expired.bytes,
      now: "2026-07-12T00:00:00.000Z",
    })).toThrow(/expired/);

    const next = indexFor(3, rootPin, [first]);
    const tampered = { ...next.index, sequence: 4 };
    expect(() => syncRemotePluginRegistryIndex({
      registry_id: "stable.example",
      index_bytes: canonicalHrpJsonBytes(tampered),
      now: "2026-07-12T00:00:00.000Z",
    })).toThrow(/signature is invalid/);

    expect(getPluginRegistrySource("stable.example")).toMatchObject({
      last_sequence: 2,
      last_index_digest: initial.index_digest,
    });
    expect(listPluginRegistryReleases("stable.example")).toEqual([
      expect.objectContaining({ plugin_version: "1.0.0", index_sequence: 2 }),
    ]);
    expect(listPluginRegistryUpdateAttempts("stable.example").filter((attempt) => attempt.status === "failed"))
      .toHaveLength(3);
    expect(getDb().prepare("SELECT MAX(version) AS version FROM schema_migrations").get())
      .toEqual({ version: 18 });
  });

  it("rejects signed catalog releases whose payload or publisher digest disagrees with the HRP", () => {
    const first = signedArchive("1.0.0");
    const rootPin = configureAndTrust(first);
    const buildMismatch = (sequence: number, mismatch: "payload" | "publisher") => (
      buildSignedPluginRegistryIndex({
        registry_id: "stable.example",
        sequence,
        issued_at: "2026-07-11T23:59:00.000Z",
        expires_at: "2026-07-13T00:00:00.000Z",
        releases: [{
          plugin_id: first.lock.plugin.id,
          plugin_version: first.lock.plugin.version,
          archive_path: "releases/plugin-1.0.0.hrp",
          archive_digest: first.archive_digest,
          payload_digest: mismatch === "payload" ? "d".repeat(64) : first.lock.payload_digest,
          publisher_key_id: mismatch === "publisher"
            ? `sha256:${"e".repeat(64)}`
            : first.signature.key_id,
        }],
      }, { private_key: registryKeys.privateKey })
    );

    for (const [sequence, mismatch] of [[2, "payload"], [3, "publisher"]] as const) {
      const index = buildMismatch(sequence, mismatch);
      expect(index.root_pin).toBe(rootPin);
      syncRemotePluginRegistryIndex({
        registry_id: "stable.example",
        index_bytes: index.bytes,
        now: "2026-07-12T00:00:00.000Z",
      });
      expect(() => installRemotePluginRegistryRelease({
        registry_id: "stable.example",
        plugin_id: "com.example.registry-plugin",
        plugin_version: "1.0.0",
        archive: first.archive,
        now: CATALOG_TEST_NOW,
      })).toThrow(/identity or publisher digest mismatch/);
      expect(listPluginVersions("com.example.registry-plugin")).toEqual([]);
    }
  });

  it("fails closed when a previously verified catalog has expired at consumption time", () => {
    const first = signedArchive("1.0.0");
    const rootPin = configureAndTrust(first);
    const catalog = indexFor(2, rootPin, [first], {
      issued_at: "2026-07-12T00:00:00.000Z",
      expires_at: "2026-07-12T00:01:00.000Z",
    });
    syncRemotePluginRegistryIndex({
      registry_id: "stable.example",
      index_bytes: catalog.bytes,
      now: "2026-07-12T00:00:30.000Z",
    });

    expect(() => installRemotePluginRegistryRelease({
      registry_id: "stable.example",
      plugin_id: "com.example.registry-plugin",
      plugin_version: "1.0.0",
      archive: first.archive,
      now: "2026-07-12T00:01:00.000Z",
    })).toThrow(/catalog is expired/);
    expect(listPluginVersions("com.example.registry-plugin")).toEqual([]);

    const installed = installRemotePluginRegistryRelease({
      registry_id: "stable.example",
      plugin_id: "com.example.registry-plugin",
      plugin_version: "1.0.0",
      archive: first.archive,
      now: "2026-07-12T00:00:45.000Z",
    });
    expect(() => enableInstalledPlugin("com.example.registry-plugin", true, {
      revision: installed.installed.activation.revision,
      active_version: "1.0.0",
    })).toThrow(/signed Registry lifecycle endpoint/);
    expect(() => enableRemotePluginRegistryRelease({
      registry_id: "stable.example",
      plugin_id: "com.example.registry-plugin",
      expected_revision: installed.installed.activation.revision,
      expected_active_version: "1.0.0",
      now: "2026-07-12T00:01:01.000Z",
    })).toThrow(/catalog is expired/);
    expect(() => activateRemotePluginRegistryRelease({
      registry_id: "stable.example",
      plugin_id: "com.example.registry-plugin",
      plugin_version: "1.0.0",
      expected_revision: installed.installed.activation.revision,
      now: "2026-07-12T00:01:01.000Z",
    })).toThrow(/catalog is expired/);
    expect(getActivePlugin("com.example.registry-plugin")?.activation.enabled).toBe(false);
  });

  it("never resolves an implicit Registry rollback to a local unsigned package", () => {
    const unsigned = buildHrpArchive(sourceFilesForPack(scanPluginSource(sourceRoot)));
    const local = installHrpArchive(unsigned.archive, { channel: "local" });
    const enabledLocal = enableInstalledPlugin("com.example.registry-plugin", true, {
      revision: local.activation.revision,
      active_version: "1.0.0",
    });

    const remote = signedArchive("2.0.0");
    const rootPin = configureAndTrust(remote);
    const catalog = indexFor(2, rootPin, [remote]);
    syncRemotePluginRegistryIndex({
      registry_id: "stable.example",
      index_bytes: catalog.bytes,
      now: "2026-07-12T00:00:00.000Z",
    });
    installRemotePluginRegistryRelease({
      registry_id: "stable.example",
      plugin_id: "com.example.registry-plugin",
      plugin_version: "2.0.0",
      archive: remote.archive,
      now: "2026-07-12T00:00:00.000Z",
    });
    const activated = activateRemotePluginRegistryRelease({
      registry_id: "stable.example",
      plugin_id: "com.example.registry-plugin",
      plugin_version: "2.0.0",
      expected_revision: enabledLocal.revision,
      now: "2026-07-12T00:00:00.000Z",
    });
    const enabledRemote = enableRemotePluginRegistryRelease({
      registry_id: "stable.example",
      plugin_id: "com.example.registry-plugin",
      expected_revision: activated.activation.revision,
      expected_active_version: "2.0.0",
      now: "2026-07-12T00:00:00.000Z",
    });

    expect(() => activateInstalledPlugin(
      "com.example.registry-plugin",
      "1.0.0",
      enabledRemote.activation.revision,
    )).toThrow(/signed Registry lifecycle endpoint/);

    expect(() => rollbackRemotePluginRegistryRelease({
      registry_id: "stable.example",
      plugin_id: "com.example.registry-plugin",
      expected_revision: enabledRemote.activation.revision,
      now: "2026-07-12T00:00:00.000Z",
    })).toThrow(/not catalogued|not installed and verified/);
    expect(getActivePlugin("com.example.registry-plugin")?.activation).toMatchObject({
      active_version: "2.0.0",
      enabled: true,
      revision: enabledRemote.activation.revision,
    });
  });

  it("rechecks publisher and package digests, stages updates, activates explicitly, and rolls back", () => {
    const first = signedArchive("1.0.0");
    const second = signedArchive("1.1.0");
    const rootPin = configureAndTrust(first);
    const catalog = indexFor(2, rootPin, [first, second]);
    syncRemotePluginRegistryIndex({
      registry_id: "stable.example",
      index_bytes: catalog.bytes,
      now: "2026-07-12T00:00:00.000Z",
    });

    const installed = installRemotePluginRegistryRelease({
      registry_id: "stable.example",
      plugin_id: "com.example.registry-plugin",
      plugin_version: "1.0.0",
      archive: first.archive,
      now: CATALOG_TEST_NOW,
    });
    expect(installed).toMatchObject({
      staged: true,
      installed: {
        installation: { channel: "registry", signature_state: "verified" },
        activation: { active_version: "1.0.0", enabled: false },
      },
    });
    const enabledFirst = enableRemotePluginRegistryRelease({
      registry_id: "stable.example",
      plugin_id: "com.example.registry-plugin",
      expected_revision: installed.installed.activation.revision,
      expected_active_version: "1.0.0",
      now: "2026-07-12T00:00:00.000Z",
    });

    expect(() => installRemotePluginRegistryRelease({
      registry_id: "stable.example",
      plugin_id: "com.example.registry-plugin",
      plugin_version: "1.1.0",
      archive: first.archive,
      operation: "update",
      now: CATALOG_TEST_NOW,
    })).toThrow(/archive digest mismatch/);
    expect(getActivePlugin("com.example.registry-plugin")?.activation).toMatchObject({
      active_version: "1.0.0",
      enabled: true,
      revision: enabledFirst.activation.revision,
    });
    expect(listPluginRegistryUpdateAttempts("stable.example", "com.example.registry-plugin").at(-1))
      .toMatchObject({
        operation: "update",
        status: "failed",
        rollback_version: "1.0.0",
      });

    const update = installRemotePluginRegistryRelease({
      registry_id: "stable.example",
      plugin_id: "com.example.registry-plugin",
      plugin_version: "1.1.0",
      archive: second.archive,
      operation: "update",
      now: CATALOG_TEST_NOW,
    });
    expect(update).toMatchObject({
      staged: true,
      installed: { activation: { active_version: "1.0.0", enabled: true } },
    });
    expect(listPluginVersions("com.example.registry-plugin")).toEqual(expect.arrayContaining([
      expect.objectContaining({ plugin_version: "1.0.0", active: true, enabled: true }),
      expect.objectContaining({ plugin_version: "1.1.0", active: false, enabled: false }),
    ]));

    const activated = activateRemotePluginRegistryRelease({
      registry_id: "stable.example",
      plugin_id: "com.example.registry-plugin",
      plugin_version: "1.1.0",
      expected_revision: enabledFirst.activation.revision,
      now: CATALOG_TEST_NOW,
    });
    expect(activated.activation).toMatchObject({
      active_version: "1.1.0",
      enabled: false,
    });
    const enabledSecond = enableRemotePluginRegistryRelease({
      registry_id: "stable.example",
      plugin_id: "com.example.registry-plugin",
      expected_revision: activated.activation.revision,
      expected_active_version: "1.1.0",
      now: "2026-07-12T00:00:00.000Z",
    });
    const rolledBack = rollbackRemotePluginRegistryRelease({
      registry_id: "stable.example",
      plugin_id: "com.example.registry-plugin",
      expected_revision: enabledSecond.activation.revision,
      now: CATALOG_TEST_NOW,
    });
    expect(rolledBack.activation).toMatchObject({
      active_version: "1.0.0",
      enabled: true,
    });
    expect(listPluginRegistryUpdateAttempts("stable.example", "com.example.registry-plugin"))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ operation: "update", status: "succeeded", rollback_version: "1.0.0" }),
        expect.objectContaining({ operation: "activate", status: "succeeded", from_version: "1.0.0", to_version: "1.1.0" }),
        expect.objectContaining({ operation: "rollback", status: "succeeded", to_version: "1.0.0" }),
      ]));
  });
});
