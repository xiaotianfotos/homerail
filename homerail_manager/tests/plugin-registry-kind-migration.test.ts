import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { generateKeyPairSync } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildSignedHrpArchive,
  buildSignedPluginRegistryIndex,
  canonicalHrpJsonBytes,
  scaffoldPluginProject,
  scanPluginSource,
  sourceFilesForPack,
} from "homerail-plugin-sdk";
import {
  GENERATIVE_UI_IR_VERSION,
  GenerativeUiActorType,
  GenerativeUiImportance,
  GenerativeUiSurface,
} from "homerail-protocol";
import { PersistentGenerativeUiDocumentService } from "../src/generative-ui/persistent-document-service.js";
import { GenerativeUiKindRegistry } from "../src/generative-ui/kind-registry.js";
import { closeDb, getDb } from "../src/persistence/db.js";
import { setPluginPublisherTrust } from "../src/persistence/plugin-distribution.js";
import { listPluginRegistryUpdateAttempts } from "../src/persistence/plugin-registry-distribution.js";
import { getActivePlugin, listPluginVersions } from "../src/persistence/plugins.js";
import { loadVerifiedKindMigrationPlan } from "../src/plugins/kind-migration.js";
import { inspectInstalledPlugin } from "../src/plugins/package-lifecycle.js";
import {
  activateRemotePluginRegistryRelease,
  configureRemotePluginRegistry,
  enableRemotePluginRegistryRelease,
  installRemotePluginRegistryRelease,
  rollbackRemotePluginRegistryRelease,
  syncRemotePluginRegistryIndex,
} from "../src/plugins/remote-registry.js";

const pluginId = "com.example.migrating-card";
const registryId = "stable.migration";
const now = "2026-07-12T00:00:00.000Z";
const scope = { type: "voice_session", id: "migration-session" } as const;

describe("atomic Registry Kind migration activation", () => {
  let previousHome: string | undefined;
  let home: string;
  let source: string;
  const publisherKeys = generateKeyPairSync("ed25519");
  const registryKeys = generateKeyPairSync("ed25519");

  beforeEach(() => {
    closeDb();
    previousHome = process.env.HOMERAIL_HOME;
    home = fs.mkdtempSync(path.join(os.tmpdir(), "homerail-kind-migration-home-"));
    source = fs.mkdtempSync(path.join(os.tmpdir(), "homerail-kind-migration-source-"));
    process.env.HOMERAIL_HOME = home;
    scaffoldPluginProject(source, pluginId, { name: "Migrating Card", version: "1.0.0" });
  });

  afterEach(() => {
    closeDb();
    if (previousHome === undefined) delete process.env.HOMERAIL_HOME;
    else process.env.HOMERAIL_HOME = previousHome;
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(source, { recursive: true, force: true });
  });

  function signedArchive() {
    const snapshot = scanPluginSource(source);
    expect(snapshot.valid).toBe(true);
    return buildSignedHrpArchive(sourceFilesForPack(snapshot), {
      publisher: "com.example",
      private_key: publisherKeys.privateKey,
    });
  }

  function signedIndex(sequence: number, packages: Array<ReturnType<typeof signedArchive>>) {
    return buildSignedPluginRegistryIndex({
      registry_id: registryId,
      sequence,
      issued_at: "2026-07-11T23:59:00.000Z",
      expires_at: "2026-07-13T00:00:00.000Z",
      releases: packages.map((candidate) => ({
        plugin_id: candidate.lock.plugin.id,
        plugin_version: candidate.lock.plugin.version,
        archive_path: `releases/card-${candidate.lock.plugin.version}.hrp`,
        archive_digest: candidate.archive_digest,
        payload_digest: candidate.lock.payload_digest,
        publisher_key_id: candidate.signature.key_id,
      })),
    }, { private_key: registryKeys.privateKey });
  }

  function prepareBase() {
    const first = signedArchive();
    setPluginPublisherTrust({
      entry: {
        publisher: first.signature.publisher,
        key_id: first.signature.key_id,
        public_key_spki: first.signature.public_key_spki,
        state: "trusted",
      },
      actor: "migration-test",
    });
    const firstIndex = signedIndex(1, [first]);
    configureRemotePluginRegistry({
      registry_id: registryId,
      source_url: "https://registry.example/migration-index.json",
      root_key_id: firstIndex.root_pin,
    });
    syncRemotePluginRegistryIndex({ registry_id: registryId, index_bytes: firstIndex.bytes, now });
    const installed = installRemotePluginRegistryRelease({
      registry_id: registryId,
      plugin_id: pluginId,
      plugin_version: "1.0.0",
      archive: first.archive,
      now,
    });
    const enabled = enableRemotePluginRegistryRelease({
      registry_id: registryId,
      plugin_id: pluginId,
      expected_revision: installed.installed.activation.revision,
      expected_active_version: "1.0.0",
      now,
    });
    const documents = new PersistentGenerativeUiDocumentService(
      new GenerativeUiKindRegistry().validateHistoricalNode,
    );
    documents.createOrGet({
      documentId: "canonical-migration-document",
      scope,
      purpose: "canonical",
      createdAt: "2026-07-12T00:00:01.000Z",
    });
    const seeded = documents.apply({
      ir_version: GENERATIVE_UI_IR_VERSION,
      transaction_id: "seed-migrating-card",
      document_id: "canonical-migration-document",
      base_revision: 0,
      actor: { type: GenerativeUiActorType.SYSTEM, id: "migration-test-seed" },
      operations: [{
        op: "put",
        node: {
          ir_version: GENERATIVE_UI_IR_VERSION,
          id: `${pluginId}:current`,
          kind: `${pluginId}/card`,
          kind_version: 1,
          owner: { id: pluginId, version: "1.0.0" },
          surface: GenerativeUiSurface.TASK,
          importance: GenerativeUiImportance.PRIMARY,
          content: { title: "Original", summary: "Preserve me" },
          fallback: { title: "Original", summary: "Preserve me" },
        },
      }],
      created_at: "2026-07-12T00:00:02.000Z",
    }, scope);
    expect(seeded.status).toBe("applied");
    return { first, enabled, documents };
  }

  function migrationArchive(mode: "valid" | "invalid_schema" | "state") {
    const manifestFile = path.join(source, "homerail.plugin.json");
    const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8")) as {
      version: string;
      schemas: Array<{ id: string; file: string }>;
      kinds: Array<{
        current_version: number;
        versions: Array<Record<string, unknown>>;
        migrations: Array<Record<string, unknown>>;
      }>;
      state: { schema_version: number; migrations: Array<Record<string, unknown>> };
    };
    manifest.version = "1.1.0";
    fs.mkdirSync(path.join(source, "migrations"), { recursive: true });
    if (mode === "state") {
      manifest.state.schema_version = 2;
      manifest.state.migrations = [{
        from: 1,
        to: 2,
        file: "migrations/state-1-2.json",
        effect: "write",
        permissions: [],
        confirmation: "never",
      }];
      fs.writeFileSync(path.join(source, "migrations/state-1-2.json"), "{}\n");
    } else {
      manifest.schemas.push({ id: "card-content-v2", file: "schemas/card-content.v2.schema.json" });
      fs.writeFileSync(path.join(source, "schemas/card-content.v2.schema.json"), `${JSON.stringify({
        $schema: "http://json-schema.org/draft-07/schema#",
        type: "object",
        properties: {
          heading: { type: "string", minLength: 1, maxLength: 120 },
          summary: { type: "string", maxLength: 2000 },
          items: { type: "array", maxItems: 16, items: { type: "string", minLength: 1, maxLength: 240 } },
        },
        required: mode === "invalid_schema" ? ["heading", "summary"] : ["heading"],
        additionalProperties: false,
      }, null, 2)}\n`);
      const v1 = manifest.kinds[0].versions[0];
      manifest.kinds[0].current_version = 2;
      manifest.kinds[0].versions.push({ ...v1, version: 2, content_schema: "card-content-v2" });
      manifest.kinds[0].migrations.push({ from: 1, to: 2, file: "migrations/card-1-2.json" });
      fs.writeFileSync(path.join(source, "migrations/card-1-2.json"), canonicalHrpJsonBytes({
        migration_version: 1,
        type: "declarative_kind_content",
        from: 1,
        to: 2,
        operations: [{ op: "rename", from: "/title", path: "/heading" }],
      }));
    }
    fs.writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
    return signedArchive();
  }

  function stageTarget(first: ReturnType<typeof signedArchive>, target: ReturnType<typeof signedArchive>) {
    const index = signedIndex(2, [first, target]);
    syncRemotePluginRegistryIndex({ registry_id: registryId, index_bytes: index.bytes, now });
    const update = installRemotePluginRegistryRelease({
      registry_id: registryId,
      plugin_id: pluginId,
      plugin_version: "1.1.0",
      archive: target.archive,
      operation: "update",
      now,
    });
    expect(update.installed.installation).toMatchObject({
      lifecycle_state: "staged",
      health_state: "unchecked",
      signature_state: "verified",
    });
    return update;
  }

  it("migrates canonical content and ledger before atomically activating the staged version", () => {
    const { first, enabled, documents } = prepareBase();
    const target = migrationArchive("valid");
    stageTarget(first, target);

    const activated = activateRemotePluginRegistryRelease({
      registry_id: registryId,
      plugin_id: pluginId,
      plugin_version: "1.1.0",
      expected_revision: enabled.activation.revision,
      now,
    });
    expect(activated).toMatchObject({
      activation: { active_version: "1.1.0", enabled: false },
      migration: { migrated_documents: 1, migrated_nodes: 1, committed_transactions: 1 },
    });
    expect(documents.get("canonical-migration-document", scope)).toMatchObject({
      revision: 2,
      nodes: [{
        owner: { id: pluginId, version: "1.1.0" },
        kind_version: 2,
        content: { heading: "Original", summary: "Preserve me" },
        revision: 2,
      }],
    });
    expect(getDb().prepare("SELECT COUNT(*) AS count FROM generative_ui_transactions").get())
      .toEqual({ count: 2 });
    expect(listPluginVersions(pluginId).find((version) => version.plugin_version === "1.1.0")?.installation)
      .toMatchObject({ lifecycle_state: "installed", health_state: "healthy" });
    expect(inspectInstalledPlugin(pluginId)).toMatchObject({ healthy: true, issues: [] });
    expect(() => rollbackRemotePluginRegistryRelease({
      registry_id: registryId,
      plugin_id: pluginId,
      plugin_version: "1.0.0",
      expected_revision: activated.activation.revision,
      now,
    })).toThrow(/Reverse Kind migrations are not implemented/);
    expect(getActivePlugin(pluginId)?.activation.active_version).toBe("1.1.0");
  });

  it("rolls back promotion, document head, ledger, and activation when target schema rejects migrated content", () => {
    const { first, enabled, documents } = prepareBase();
    const secondScope = { type: "voice_session", id: "migration-session-z" } as const;
    documents.createOrGet({
      documentId: "canonical-migration-document-z",
      scope: secondScope,
      purpose: "canonical",
      createdAt: "2026-07-12T00:00:03.000Z",
    });
    expect(documents.apply({
      ir_version: GENERATIVE_UI_IR_VERSION,
      transaction_id: "seed-migrating-card-without-summary",
      document_id: "canonical-migration-document-z",
      base_revision: 0,
      actor: { type: GenerativeUiActorType.SYSTEM, id: "migration-test-seed" },
      operations: [{
        op: "put",
        node: {
          ir_version: GENERATIVE_UI_IR_VERSION,
          id: `${pluginId}:second`,
          kind: `${pluginId}/card`,
          kind_version: 1,
          owner: { id: pluginId, version: "1.0.0" },
          surface: GenerativeUiSurface.TASK,
          importance: GenerativeUiImportance.PRIMARY,
          content: { title: "No summary" },
          fallback: { title: "No summary" },
        },
      }],
      created_at: "2026-07-12T00:00:04.000Z",
    }, secondScope).status).toBe("applied");
    const target = migrationArchive("invalid_schema");
    stageTarget(first, target);
    const activeBefore = structuredClone(getActivePlugin(pluginId)!.activation);
    const documentBefore = documents.get("canonical-migration-document", scope)!;
    const secondDocumentBefore = documents.get("canonical-migration-document-z", secondScope)!;
    const ledgerBefore = getDb().prepare("SELECT COUNT(*) AS count FROM generative_ui_transactions").get();

    expect(() => activateRemotePluginRegistryRelease({
      registry_id: registryId,
      plugin_id: pluginId,
      plugin_version: "1.1.0",
      expected_revision: enabled.activation.revision,
      now,
    })).toThrow(/migration was rejected|required|kind schema/i);

    expect(getActivePlugin(pluginId)!.activation).toEqual(activeBefore);
    expect(documents.get("canonical-migration-document", scope)).toEqual(documentBefore);
    expect(documents.get("canonical-migration-document-z", secondScope)).toEqual(secondDocumentBefore);
    expect(getDb().prepare("SELECT COUNT(*) AS count FROM generative_ui_transactions").get())
      .toEqual(ledgerBefore);
    expect(listPluginVersions(pluginId).find((version) => version.plugin_version === "1.1.0")?.installation)
      .toMatchObject({ lifecycle_state: "staged", health_state: "unchecked" });
    expect(listPluginRegistryUpdateAttempts(registryId, pluginId).at(-1)).toMatchObject({
      operation: "activate",
      status: "failed",
      rollback_version: "1.0.0",
      data: {
        active_version_preserved: "1.0.0",
        activation_revision_preserved: activeBefore.revision,
      },
    });
  });

  it("keeps state migrations staged and fails closed without changing activation", () => {
    const { first, enabled } = prepareBase();
    const target = migrationArchive("state");
    stageTarget(first, target);
    expect(() => activateRemotePluginRegistryRelease({
      registry_id: registryId,
      plugin_id: pluginId,
      plugin_version: "1.1.0",
      expected_revision: enabled.activation.revision,
      now,
    })).toThrow(/state migrations are not implemented/i);
    expect(getActivePlugin(pluginId)?.activation).toMatchObject({
      active_version: "1.0.0",
      enabled: true,
      revision: enabled.activation.revision,
    });
    expect(listPluginVersions(pluginId).find((version) => version.plugin_version === "1.1.0")?.installation)
      .toMatchObject({ lifecycle_state: "staged", health_state: "unchecked" });
  });

  it("rejects migration bytes that no longer match the immutable archived digest", () => {
    const { first } = prepareBase();
    const target = migrationArchive("valid");
    stageTarget(first, target);
    const persisted = structuredClone(
      listPluginVersions(pluginId).find((version) => version.plugin_version === "1.1.0")!,
    );
    const migration = persisted.descriptor.referenced_files
      .find((file) => file.path === "migrations/card-1-2.json")!;
    migration.content = canonicalHrpJsonBytes({
      migration_version: 1,
      type: "declarative_kind_content",
      from: 1,
      to: 2,
      operations: [{ op: "remove", path: "/title" }],
    }).toString("base64");
    expect(() => loadVerifiedKindMigrationPlan(persisted)).toThrow(/migration digest mismatch/);
  });
});
