import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildHrpArchive, scaffoldPluginProject, scanPluginSource, sourceFilesForPack } from "homerail-plugin-sdk";
import { GenerativeUiKindRegistry } from "../src/generative-ui/kind-registry.js";
import { closeDb, getDb } from "../src/persistence/db.js";
import {
  getPluginRegistryState,
  listPluginPackages,
  listPluginVersions,
  pluginVersionSetDigest,
  uninstallExternalPlugin,
} from "../src/persistence/plugins.js";
import {
  activateInstalledPlugin,
  enableInstalledPlugin,
  inspectInstalledPlugin,
  installHrpArchive,
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

  function setVersion(version: string): void {
    const file = path.join(sourceRoot, "homerail.plugin.json");
    const manifest = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
    manifest.version = version;
    fs.writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
  }

  it("installs disabled, keeps newer versions inactive, activates, enables, and rolls back without schema downgrade", () => {
    const first = installHrpArchive(archive(), { channel: "staging" });
    expect(first).toMatchObject({
      data_only_eligible: true,
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
    expect(getDb().prepare("SELECT MAX(version) AS version FROM schema_migrations").get()).toEqual({ version: 7 });
    expect(inspectInstalledPlugin("com.example.release-notes")).toMatchObject({ healthy: true, issues: [] });
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
      .toEqual({ version: 7 });
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
