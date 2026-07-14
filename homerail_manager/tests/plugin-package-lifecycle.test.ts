import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { generateKeyPairSync } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildHrpArchive,
  buildSignedHrpArchive,
  scaffoldPluginProject,
  scanPluginSource,
  sourceFilesForPack,
} from "homerail-plugin-sdk";
import { GenerativeUiKindRegistry } from "../src/generative-ui/kind-registry.js";
import { closeDb, getDb } from "../src/persistence/db.js";
import {
  getPluginPermissionRevision,
  getActivePlugin,
  getPluginRegistryState,
  listPluginPermissionEvents,
  listPluginPermissionGrants,
  listPluginPackages,
  listPluginVersions,
  pluginVersionSetDigest,
  setPluginGrantStatus,
  uninstallExternalPlugin,
} from "../src/persistence/plugins.js";
import { setPluginPublisherTrust } from "../src/persistence/plugin-distribution.js";
import {
  activateInstalledPlugin,
  enableInstalledPlugin,
  inspectInstalledPlugin,
  installHrpArchive,
  reconcileInstalledPluginPublisherTrust,
  recoverPluginPackageTrash,
  rollbackInstalledPlugin,
  uninstallInstalledPlugin,
} from "../src/plugins/package-lifecycle.js";

describe("external plugin package lifecycle", () => {
  let oldHome: string | undefined;
  let home: string;
  let sourceRoot: string;

  beforeEach(() => {
    closeDb();
    oldHome = process.env.HOMERAIL_HOME;
    home = fs.mkdtempSync(path.join(os.tmpdir(), "homerail-plugin-lifecycle-home-"));
    sourceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "homerail-plugin-lifecycle-source-"));
    process.env.HOMERAIL_HOME = home;
    scaffoldPluginProject(sourceRoot, "com.example.release-notes", { name: "Release Notes", version: "1.0.0" });
  });

  afterEach(() => {
    closeDb();
    if (oldHome === undefined) delete process.env.HOMERAIL_HOME;
    else process.env.HOMERAIL_HOME = oldHome;
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(sourceRoot, { recursive: true, force: true });
  });

  function archive(): Buffer {
    return buildHrpArchive(sourceFilesForPack(scanPluginSource(sourceRoot))).archive;
  }

  it("requires trusted registry signatures and disables an active package after revocation", () => {
    const { privateKey } = generateKeyPairSync("ed25519");
    const signed = buildSignedHrpArchive(sourceFilesForPack(scanPluginSource(sourceRoot)), {
      publisher: "com.example",
      private_key: privateKey,
    });
    expect(() => installHrpArchive(signed.archive, { channel: "registry" }))
      .toThrow(/requires a trusted publisher signature; received untrusted/);
    expect(listPluginPackages()).toEqual([]);

    const trust = {
      publisher: signed.signature.publisher,
      key_id: signed.signature.key_id,
      public_key_spki: signed.signature.public_key_spki,
      state: "trusted" as const,
    };
    setPluginPublisherTrust({ entry: trust, actor: "test-operator" });
    const installed = installHrpArchive(signed.archive, { channel: "registry" });
    expect(installed.installation).toMatchObject({
      channel: "registry",
      lifecycle_state: "installed",
      health_state: "healthy",
      signature_state: "verified",
    });
    expect(fs.existsSync(path.join(installed.installation.package_path, "homerail.signature.json"))).toBe(true);
    const enabled = enableInstalledPlugin(installed.package.plugin_id, true, {
      revision: installed.activation.revision,
      active_version: installed.activation.active_version,
    }, { registry_authorized: true });
    expect(enabled.enabled).toBe(true);

    setPluginPublisherTrust({
      entry: { ...trust, state: "revoked" },
      expected_revision: 1,
      actor: "security-operator",
      reason: "publisher key compromised",
    });
    // Simulate a process that committed trust first and crashed before its
    // legacy reconciliation step. Runtime/context reads still fail closed.
    expect(getActivePlugin(installed.package.plugin_id)?.activation.enabled).toBe(false);
    expect(reconcileInstalledPluginPublisherTrust()).toEqual({
      checked: 1,
      updated: 1,
      revoked: 1,
      failures: [],
    });
    const revoked = listPluginVersions(installed.package.plugin_id)[0]!;
    expect(revoked.installation).toMatchObject({
      health_state: "unhealthy",
      signature_state: "revoked",
    });
    expect(revoked.enabled).toBe(false);
    expect(() => enableInstalledPlugin(installed.package.plugin_id, true, {
      revision: enabled.revision + 1,
      active_version: enabled.active_version,
    }, { registry_authorized: true })).toThrow(/not healthy and installed|signature is revoked/);
  });

  it("installs and enables data-only custom Renderer packages through the M6 isolated tier", () => {
    const manifestFile = path.join(sourceRoot, "homerail.plugin.json");
    const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8")) as {
      renderers: Array<Record<string, unknown>>;
    };
    manifest.renderers[0] = {
      ...manifest.renderers[0],
      mode: "custom",
      source: { type: "custom", file: "ui/views/card.mjs" },
    };
    fs.mkdirSync(path.join(sourceRoot, "ui", "views"), { recursive: true });
    fs.writeFileSync(path.join(sourceRoot, "ui", "views", "card.mjs"), [
      "export function render(payload) {",
      "  const title = typeof payload.node?.fallback?.title === 'string'",
      "    ? payload.node.fallback.title.slice(0, 120)",
      "    : 'Release Notes';",
      "  return { version: 'v1.0', catalogId: 'https://homerail.dev/a2ui/catalogs/core/v1', components: [{ id: 'root', component: 'Text', text: title }] };",
      "}",
      "",
    ].join("\n"));
    fs.writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
    const built = buildHrpArchive(sourceFilesForPack(scanPluginSource(sourceRoot))).archive;
    const installed = installHrpArchive(built, { channel: "staging" });
    expect(installed).toMatchObject({
      m6_custom_renderer_eligible: true,
      m6_custom_renderer_eligibility_reasons: [],
      installation: { lifecycle_state: "installed", health_state: "healthy" },
    });
    expect(enableInstalledPlugin(installed.package.plugin_id, true, {
      revision: installed.activation.revision,
      active_version: installed.activation.active_version,
    })).toMatchObject({ enabled: true });
  });

  function setVersion(version: string): void {
    const file = path.join(sourceRoot, "homerail.plugin.json");
    const manifest = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
    manifest.version = version;
    fs.writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
  }

  function addProjectionAction(): void {
    const manifestFile = path.join(sourceRoot, "homerail.plugin.json");
    const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8")) as {
      id: string;
      capabilities: Array<{ actions: string[] }>;
      schemas: Array<{ id: string; file: string }>;
      kinds: Array<{ versions: Array<{ actions: string[] }> }>;
      tools: Array<Record<string, unknown>>;
      actions: Array<Record<string, unknown>>;
      permissions: { optional: Array<Record<string, unknown>> };
    };
    const contentSchema = JSON.parse(
      fs.readFileSync(path.join(sourceRoot, "schemas/card-content.v1.schema.json"), "utf8"),
    ) as Record<string, unknown>;
    fs.writeFileSync(path.join(sourceRoot, "schemas/card-action.v1.schema.json"), `${JSON.stringify({
      $schema: "http://json-schema.org/draft-07/schema#",
      type: "object",
      properties: {
        id: { type: "string", minLength: manifest.id.length + 2, maxLength: 256 },
        content: contentSchema,
      },
      required: ["id", "content"],
      additionalProperties: false,
    }, null, 2)}\n`);
    fs.writeFileSync(path.join(sourceRoot, "ui/projectors/card-action.v1.json"), `${JSON.stringify({
      projection_version: 1,
      type: "direct_ui_node",
      kind: `${manifest.id}/card`,
      kind_version: 1,
      node_id_pointer: "/id",
      content_pointer: "/content",
      omit_content_fields: [],
      fallback: { title_pointer: "/content/title", summary_pointer: "/content/summary" },
      defaults: { surface: "task", importance: "primary", density: "detail", persistence: "session" },
    }, null, 2)}\n`);
    manifest.schemas.push({ id: "card-action-v1", file: "schemas/card-action.v1.schema.json" });
    manifest.capabilities[0].actions.push("replace_card");
    manifest.kinds[0].versions[0].actions.push("replace_card");
    manifest.permissions.optional.push({ permission: "artifact.write" });
    manifest.tools.push({
      id: "replace_card_tool",
      description: "Replace the selected card through an Action-bound Tool.",
      exposure: ["action"],
      input_schema: "card-action-v1",
      output_schema: "card-content-v1",
      effect: "write",
      permissions: ["artifact.write"],
      confirmation: "always",
      handler: { type: "projection", file: "ui/projectors/card-action.v1.json" },
    });
    manifest.actions.push({
      id: "replace_card",
      intent: `${manifest.id}.replace_card`,
      tool: "replace_card_tool",
    });
    fs.writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
  }

  it("installs disabled, keeps newer versions inactive, activates, enables, and rolls back without schema downgrade", () => {
    const first = installHrpArchive(archive(), { channel: "staging" });
    expect(first).toMatchObject({
      data_only_eligible: true,
      m5_projection_action_eligible: false,
      m5_projection_action_eligibility_reasons: ["projection_action_required"],
      idempotent: false,
      installation: { lifecycle_state: "installed", health_state: "healthy", signature_state: "unsigned" },
      activation: { active_version: "1.0.0", enabled: false, revision: 1 },
    });
    expect(fs.existsSync(first.installation.package_path)).toBe(true);
    expect(enableInstalledPlugin("com.example.release-notes", true, { revision: 1, active_version: "1.0.0" }))
      .toMatchObject({ enabled: true, revision: 2 });

    setVersion("1.1.0");
    const second = installHrpArchive(archive(), { channel: "staging" });
    expect(second.activation).toMatchObject({ active_version: "1.0.0", enabled: true, revision: 2 });
    expect(getPluginRegistryState().plugins.find((plugin) => plugin.plugin_id === "com.example.release-notes"))
      .toMatchObject({ plugin_version: "1.0.0", activation: { enabled: true } });

    expect(activateInstalledPlugin("com.example.release-notes", "1.1.0", 2)).toMatchObject({
      active_version: "1.1.0", enabled: false, revision: 3,
    });
    expect(() => enableInstalledPlugin("com.example.release-notes", true, {
      revision: 2,
      active_version: "1.0.0",
    })).toThrow(/conflict/);
    expect(getPluginRegistryState().plugins.find((plugin) => plugin.plugin_id === "com.example.release-notes"))
      .toMatchObject({ plugin_version: "1.1.0", activation: { enabled: false, revision: 3 } });
    expect(enableInstalledPlugin("com.example.release-notes", true, { revision: 3, active_version: "1.1.0" }))
      .toMatchObject({ enabled: true, revision: 4 });
    setVersion("1.2.0");
    installHrpArchive(archive(), { channel: "staging" });
    expect(rollbackInstalledPlugin("com.example.release-notes", undefined, 4)).toMatchObject({
      active_version: "1.0.0", enabled: true, revision: 5,
    });
    expect(listPluginVersions("com.example.release-notes")).toEqual(expect.arrayContaining([
      expect.objectContaining({ plugin_version: "1.0.0", active: true, enabled: true }),
      expect.objectContaining({ plugin_version: "1.1.0", active: false, enabled: false }),
      expect.objectContaining({ plugin_version: "1.2.0", active: false, enabled: false }),
    ]));
    expect(getDb().prepare("SELECT MAX(version) AS version FROM schema_migrations").get()).toEqual({ version: 18 });
    expect(inspectInstalledPlugin("com.example.release-notes")).toMatchObject({ healthy: true, issues: [] });
  });

  it("installs and enables an external M5 data-only projection Action package", () => {
    addProjectionAction();
    const snapshot = scanPluginSource(sourceRoot);
    expect(snapshot).toMatchObject({
      valid: true,
      m4_data_only_eligible: false,
      m5_projection_action_eligible: true,
      m5_projection_action_eligibility_reasons: [],
    });

    const installed = installHrpArchive(archive(), { channel: "staging" });
    expect(installed).toMatchObject({
      data_only_eligible: false,
      m5_projection_action_eligible: true,
      m5_projection_action_eligibility_reasons: [],
      installation: { lifecycle_state: "installed", health_state: "healthy" },
      activation: { active_version: "1.0.0", enabled: false, revision: 1 },
    });
    expect(enableInstalledPlugin("com.example.release-notes", true, {
      revision: 1,
      active_version: "1.0.0",
    })).toMatchObject({ enabled: true, revision: 2 });
    expect(inspectInstalledPlugin("com.example.release-notes")).toMatchObject({
      installed: true,
      healthy: true,
      issues: [],
    });
  });

  it("retains a runtime Action package as staged and blocks activation until attested M6 preflight", () => {
    addProjectionAction();
    const manifestFile = path.join(sourceRoot, "homerail.plugin.json");
    const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8")) as {
      runtime: Record<string, unknown>;
      tools: Array<{ id: string; handler: Record<string, unknown> }>;
    };
    manifest.runtime = {
      trust: "sandboxed_runtime",
      plugin_api: 1,
      entrypoint: { file: "runtime/index.js", args: [] },
    };
    manifest.tools.find((tool) => tool.id === "replace_card_tool")!.handler = {
      type: "runtime",
      method: "replace_card",
    };
    fs.mkdirSync(path.join(sourceRoot, "runtime"));
    fs.writeFileSync(path.join(sourceRoot, "runtime/index.js"), "export {};\n");
    fs.writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);

    const snapshot = scanPluginSource(sourceRoot);
    expect(snapshot).toMatchObject({
      valid: true,
      m4_data_only_eligible: false,
      m5_projection_action_eligible: false,
      m5_projection_action_eligibility_reasons: expect.arrayContaining([
        "runtime_trust_not_data_only",
        "runtime_entrypoint_present",
        "runtime_handler_present",
      ]),
    });
    const staged = installHrpArchive(archive());
    expect(staged).toMatchObject({
      data_only_eligible: false,
      m5_projection_action_eligible: false,
      m5_projection_action_eligibility_reasons: expect.arrayContaining(["runtime_handler_present"]),
      installation: { lifecycle_state: "staged", health_state: "unchecked" },
      activation: { active_version: "1.0.0", enabled: false },
    });
    expect(() => enableInstalledPlugin("com.example.release-notes", true, {
      revision: 1,
      active_version: "1.0.0",
    })).toThrow(/not healthy and installed/);
    expect(() => activateInstalledPlugin("com.example.release-notes", "1.0.0", 1))
      .toThrow(/not healthy and installed/);
    expect(inspectInstalledPlugin("com.example.release-notes")).toMatchObject({
      installed: true,
      healthy: false,
      issues: [expect.stringContaining("staged")],
    });
  });

  it("treats an identical reinstall as a no-op and rejects a modified immutable package", () => {
    const bytes = archive();
    const first = installHrpArchive(bytes, { channel: "staging" });
    const eventsBefore = (getDb().prepare(`
      SELECT COUNT(*) AS count FROM plugin_activation_events
      WHERE plugin_id = ? AND event_type = 'install'
    `).get("com.example.release-notes") as { count: number }).count;

    const repeated = installHrpArchive(bytes, { channel: "staging" });
    expect(repeated.idempotent).toBe(true);
    expect(repeated.activation).toEqual(first.activation);
    expect((getDb().prepare(`
      SELECT COUNT(*) AS count FROM plugin_activation_events
      WHERE plugin_id = ? AND event_type = 'install'
    `).get("com.example.release-notes") as { count: number }).count).toBe(eventsBefore);

    fs.appendFileSync(path.join(first.installation.package_path, "homerail.plugin.json"), " \n");
    expect(() => installHrpArchive(bytes, { channel: "staging" })).toThrow(/modified content/);
    expect(inspectInstalledPlugin("com.example.release-notes")).toMatchObject({
      healthy: false,
      issues: [expect.stringContaining("Package integrity check failed")],
    });
    expect(listPluginVersions("com.example.release-notes")).toHaveLength(1);
  });

  it("persists a monotonic permission revision and append-only grant audit", () => {
    const manifestFile = path.join(sourceRoot, "homerail.plugin.json");
    const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8")) as {
      permissions: { required: unknown[]; optional: Array<Record<string, unknown>> };
    };
    manifest.permissions.optional = [{ permission: "artifact.read" }];
    fs.writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);

    const installed = installHrpArchive(archive(), { channel: "staging" });
    expect(installed).toMatchObject({
      data_only_eligible: false,
      installation: { lifecycle_state: "staged", health_state: "unchecked" },
    });
    expect(getPluginPermissionRevision()).toBe(1);
    expect(listPluginPermissionGrants("com.example.release-notes", "1.0.0"))
      .toEqual([expect.objectContaining({ permission: "artifact.read", status: "pending", revision: 1 })]);
    expect(listPluginPermissionEvents()).toEqual([expect.objectContaining({
      event_type: "declared",
      from_status: null,
      to_status: "pending",
      permission_revision: 1,
      actor_type: "system",
      data: { required: false },
    })]);

    expect(setPluginGrantStatus({
      plugin_id: "com.example.release-notes",
      plugin_version: "1.0.0",
      permission: "artifact.read",
      status: "granted",
      expected_revision: 1,
      actor_type: "operator",
      actor_id: "local-admin",
      request_digest: "a".repeat(64),
    })).toMatchObject({ revision: 2, permission_revision: 2, status: "granted" });
    expect(setPluginGrantStatus({
      plugin_id: "com.example.release-notes",
      plugin_version: "1.0.0",
      permission: "artifact.read",
      status: "granted",
      expected_revision: 2,
    })).toMatchObject({ revision: 2, permission_revision: 2 });
    expect(listPluginPermissionEvents({ plugin_id: "com.example.release-notes" }))
      .toEqual([
        expect.objectContaining({ event_type: "declared", permission_revision: 1 }),
        expect.objectContaining({
          event_type: "granted",
          from_status: "pending",
          to_status: "granted",
          grant_revision: 2,
          permission_revision: 2,
          actor_id: "local-admin",
          request_digest: "a".repeat(64),
        }),
      ]);
    closeDb();
    expect(getPluginPermissionRevision()).toBe(2);
  });

  it("migrates the registry high-water mark across uninstall and reinstall ABA history", () => {
    const bytes = archive();
    installHrpArchive(bytes, { channel: "staging" });
    getDb().prepare(`
      UPDATE plugin_activations SET revision = 100 WHERE plugin_id = ?
    `).run("com.example.release-notes");
    uninstallInstalledPlugin(
      "com.example.release-notes",
      pluginVersionSetDigest("com.example.release-notes"),
    );
    installHrpArchive(bytes, { channel: "staging" });
    expect(getDb().prepare(`
      SELECT revision FROM plugin_activations WHERE plugin_id = ?
    `).get("com.example.release-notes")).toEqual({ revision: 1 });

    getDb().exec(`
      DROP TRIGGER plugin_registry_revision_after_activation_insert;
      DROP TRIGGER plugin_registry_revision_after_activation_update;
      DROP TRIGGER plugin_registry_revision_after_activation_delete;
      DROP TABLE plugin_registry_meta;
      DELETE FROM schema_migrations WHERE version = 7;
    `);
    closeDb();

    expect(getPluginRegistryState().revision).toBe(101);
    expect(getDb().prepare("SELECT MAX(version) AS version FROM schema_migrations").get())
      .toEqual({ version: 18 });
  });

  it("rejects a stale uninstall when an inactive version was installed concurrently", () => {
    installHrpArchive(archive());
    const staleDigest = pluginVersionSetDigest("com.example.release-notes");
    setVersion("1.1.0");
    installHrpArchive(archive());

    expect(() => uninstallInstalledPlugin("com.example.release-notes", staleDigest)).toThrow(/version set conflict/);
    expect(listPluginVersions("com.example.release-notes")).toHaveLength(2);
    expect(fs.existsSync(path.join(home, "plugins", "packages", "com.example.release-notes", "1.0.0"))).toBe(true);
    expect(fs.existsSync(path.join(home, "plugins", "packages", "com.example.release-notes", "1.1.0"))).toBe(true);
    expect(fs.existsSync(path.join(home, "plugins", ".trash"))).toBe(false);
  });

  it("fails malformed and ineligible packages without making them executable", () => {
    const tampered = archive();
    tampered[Math.floor(tampered.byteLength / 3)] ^= 0xff;
    expect(() => installHrpArchive(tampered)).toThrow();
    expect(listPluginPackages().some((plugin) => plugin.plugin_id === "com.example.release-notes")).toBe(false);

    const manifestFile = path.join(sourceRoot, "homerail.plugin.json");
    const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8")) as {
      permissions: { required: unknown[]; optional: unknown[] };
    };
    manifest.permissions.required = [{ permission: "network.connect", hosts: ["example.com"] }];
    fs.writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
    const staged = installHrpArchive(archive());
    expect(staged).toMatchObject({
      data_only_eligible: false,
      installation: { lifecycle_state: "staged", health_state: "unchecked" },
    });
    expect(() => enableInstalledPlugin("com.example.release-notes", true, { revision: 1, active_version: "1.0.0" }))
      .toThrow(/not healthy and installed/);

    const migrationManifest = manifest as typeof manifest & {
      version: string;
      kinds: Array<{
        current_version: number;
        versions: Array<Record<string, unknown>>;
        migrations: Array<Record<string, unknown>>;
      }>;
    };
    migrationManifest.version = "1.1.0";
    migrationManifest.permissions.required = [];
    migrationManifest.kinds[0].current_version = 2;
    migrationManifest.kinds[0].versions.push({ ...migrationManifest.kinds[0].versions[0], version: 2 });
    migrationManifest.kinds[0].migrations.push({ from: 1, to: 2, file: "migrations/card-1-2.json" });
    fs.writeFileSync(manifestFile, `${JSON.stringify(migrationManifest, null, 2)}\n`);
    fs.mkdirSync(path.join(sourceRoot, "migrations"));
    fs.writeFileSync(path.join(sourceRoot, "migrations", "card-1-2.json"), "not an approved declarative migration DSL\n");
    expect(installHrpArchive(archive())).toMatchObject({
      data_only_eligible: false,
      installation: { lifecycle_state: "staged", health_state: "unchecked" },
      activation: { active_version: "1.0.0", enabled: false },
    });
  });

  it("uninstalls execution files while retaining immutable descriptors and historical Kind validation", () => {
    const installed = installHrpArchive(archive());
    enableInstalledPlugin("com.example.release-notes", true, { revision: 1, active_version: "1.0.0" });
    const historicalRegistry = new GenerativeUiKindRegistry();
    const node = {
      ir_version: 1 as const,
      id: "com.example.release-notes:current",
      kind: "com.example.release-notes/card",
      kind_version: 1,
      owner: { id: "com.example.release-notes", version: "1.0.0" },
      surface: "task" as const,
      importance: "primary" as const,
      content: { title: "Release Notes" },
      fallback: { title: "Release Notes" },
      revision: 1,
      updated_at: "2026-07-12T00:00:00.000Z",
    };
    expect(historicalRegistry.validateHistoricalNode(node)).toEqual([]);

    uninstallInstalledPlugin("com.example.release-notes", pluginVersionSetDigest("com.example.release-notes"));
    expect(fs.existsSync(installed.installation.package_path)).toBe(false);
    expect(getPluginRegistryState().plugins.some((plugin) => plugin.plugin_id === "com.example.release-notes")).toBe(false);
    expect(listPluginPackages()).toContainEqual(expect.objectContaining({
      plugin_id: "com.example.release-notes",
      plugin_version: "1.0.0",
    }));
    expect(new GenerativeUiKindRegistry().validateHistoricalNode(node)).toEqual([]);
    expect(listPluginVersions("com.example.release-notes")[0]).toMatchObject({
      installation: { lifecycle_state: "removed" },
    });
    expect(inspectInstalledPlugin("com.example.release-notes")).toMatchObject({
      installed: false,
      healthy: false,
      issues: [],
    });
  });

  it("recovers an interrupted uninstall on either side of the database commit", () => {
    const installed = installHrpArchive(archive());
    const packageRoot = path.dirname(installed.installation.package_path);
    const trashRoot = path.join(home, "plugins", ".trash");
    fs.mkdirSync(trashRoot, { recursive: true });
    const beforeToken = "00000000-0000-4000-8000-000000000001";
    fs.writeFileSync(path.join(trashRoot, `${beforeToken}.json`), JSON.stringify({
      journal_version: 1,
      plugin_id: "com.example.release-notes",
    }));
    fs.renameSync(packageRoot, path.join(trashRoot, `${beforeToken}.package`));

    expect(recoverPluginPackageTrash()).toEqual({ restored: 1, removed: 0, quarantined: 0 });
    expect(fs.existsSync(installed.installation.package_path)).toBe(true);

    const afterToken = "00000000-0000-4000-8000-000000000002";
    fs.writeFileSync(path.join(trashRoot, `${afterToken}.json`), JSON.stringify({
      journal_version: 1,
      plugin_id: "com.example.release-notes",
    }));
    fs.renameSync(packageRoot, path.join(trashRoot, `${afterToken}.package`));
    uninstallExternalPlugin("com.example.release-notes", pluginVersionSetDigest("com.example.release-notes"));

    expect(recoverPluginPackageTrash()).toEqual({ restored: 0, removed: 1, quarantined: 0 });
    expect(fs.existsSync(path.join(trashRoot, `${afterToken}.package`))).toBe(false);
    expect(listPluginVersions("com.example.release-notes")[0]).toMatchObject({
      installation: { lifecycle_state: "removed" },
    });
  });

  it("rejects invalid plugin ids before touching uninstall storage and quarantines bad journals", () => {
    expect(() => uninstallInstalledPlugin("..", "0".repeat(64))).toThrow(/Invalid HomeRail plugin id/);
    expect(fs.existsSync(path.join(home, "plugins", ".trash"))).toBe(false);

    const trashRoot = path.join(home, "plugins", ".trash");
    fs.mkdirSync(trashRoot, { recursive: true });
    fs.writeFileSync(path.join(trashRoot, "00000000-0000-4000-8000-000000000003.json"), JSON.stringify({
      journal_version: 1,
      plugin_id: "..",
    }));
    expect(recoverPluginPackageTrash()).toEqual({ restored: 0, removed: 0, quarantined: 1 });
    expect(fs.readdirSync(trashRoot).some((file) => file.endsWith(".invalid"))).toBe(true);
  });
});
