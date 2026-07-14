import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { isHomerailPluginId } from "homerail-protocol";
import {
  encodeHrpZip,
  extractVerifiedHrpArchive,
  isHomerailDeclarativeKindMigrationManifest,
  normalizeHrpPath,
  verifyPluginArchive,
  type PluginM5ProjectionActionIneligibilityReason,
  type PluginM5WorkflowResolutionIneligibilityReason,
  type PluginM6CustomRendererIneligibilityReason,
} from "homerail-plugin-sdk";
import { getHomerailHome } from "../config/env.js";
import {
  activatePluginVersion,
  installExternalPluginPackage,
  listPluginPackages,
  listPluginVersions,
  pluginVersionSetDigest,
  rollbackPluginVersion,
  setPluginEnabled,
  updatePluginInstallationSignatureState,
  uninstallExternalPlugin,
  type PluginActivationRecord,
  type PluginInstallationRecord,
  type PluginPackageRecord,
  type PluginVersionRecord,
} from "../persistence/plugins.js";
import { listPluginPublisherTrust } from "../persistence/plugin-distribution.js";
import { loadPluginPackage } from "./manifest-loader.js";

export interface InstallHrpResult {
  package: PluginPackageRecord;
  installation: PluginInstallationRecord;
  activation: PluginActivationRecord;
  archive_digest: string;
  payload_digest: string;
  /** Backward-compatible M4 eligibility field. */
  data_only_eligible: boolean;
  m5_projection_action_eligible: boolean;
  m5_projection_action_eligibility_reasons: PluginM5ProjectionActionIneligibilityReason[];
  m5_workflow_resolution_eligible: boolean;
  m5_workflow_resolution_eligibility_reasons: PluginM5WorkflowResolutionIneligibilityReason[];
  m6_custom_renderer_eligible: boolean;
  m6_custom_renderer_eligibility_reasons: PluginM6CustomRendererIneligibilityReason[];
  idempotent: boolean;
}

function assertPluginId(pluginId: string): void {
  if (!isHomerailPluginId(pluginId)) throw new Error(`Invalid HomeRail plugin id: ${pluginId}`);
}

export function pluginPackageStorageRoot(): string {
  return path.join(getHomerailHome(), "plugins");
}

function stagingRoot(): string {
  return path.join(pluginPackageStorageRoot(), ".staging");
}

function packagesRoot(): string {
  return path.join(pluginPackageStorageRoot(), "packages");
}

function trashRoot(): string {
  return path.join(pluginPackageStorageRoot(), ".trash");
}

function targetPackagePath(pluginId: string, version: string): string {
  return path.join(packagesRoot(), pluginId, version);
}

function ensureRealDirectory(directory: string): void {
  if (!fs.existsSync(directory)) fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(directory);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`Plugin storage path must be a real directory: ${directory}`);
  }
}

function ensurePackageStorage(pluginId: string): void {
  ensureRealDirectory(pluginPackageStorageRoot());
  ensureRealDirectory(stagingRoot());
  ensureRealDirectory(packagesRoot());
  ensureRealDirectory(path.join(packagesRoot(), pluginId));
}

function readInstalledPackageFiles(root: string): Map<string, Buffer> {
  const files = new Map<string, Buffer>();
  const visit = (directory: string, prefix: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const relative = normalizeHrpPath(prefix ? `${prefix}/${entry.name}` : entry.name);
      const target = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`Installed plugin package contains a symlink: ${relative}`);
      if (entry.isDirectory()) visit(target, relative);
      else if (entry.isFile()) files.set(relative, fs.readFileSync(target));
      else throw new Error(`Installed plugin package contains a non-regular file: ${relative}`);
    }
  };
  const stat = fs.lstatSync(root);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("Installed plugin package path is not a real directory");
  visit(root, "");
  return files;
}

function assertExistingPackageMatches(
  packagePath: string,
  verified: ReturnType<typeof verifyPluginArchive>,
): void {
  const actual = readInstalledPackageFiles(packagePath);
  const expectedPaths = [...verified.files.keys()].sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)));
  const actualPaths = [...actual.keys()].sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)));
  if (JSON.stringify(actualPaths) !== JSON.stringify(expectedPaths)) {
    throw new Error(`Immutable plugin package path contains a different file set: ${verified.lock.plugin.id}@${verified.lock.plugin.version}`);
  }
  for (const filePath of expectedPaths) {
    if (!actual.get(filePath)?.equals(verified.files.get(filePath)!)) {
      throw new Error(`Immutable plugin package path contains modified content: ${filePath}`);
    }
  }
}

export function cleanupPluginPackageStaging(): number {
  const root = stagingRoot();
  if (!fs.existsSync(root)) return 0;
  const stat = fs.lstatSync(root);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`Plugin staging path must be a real directory: ${root}`);
  }
  const entries = fs.readdirSync(root, { withFileTypes: true });
  for (const entry of entries) fs.rmSync(path.join(root, entry.name), { recursive: true, force: true });
  return entries.length;
}

export function recoverPluginPackageTrash(): { restored: number; removed: number; quarantined: number } {
  const root = trashRoot();
  if (!fs.existsSync(root)) return { restored: 0, removed: 0, quarantined: 0 };
  ensureRealDirectory(root);
  let restored = 0;
  let removed = 0;
  let quarantined = 0;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })
    .filter((candidate) => candidate.isFile() && candidate.name.endsWith(".json"))
    .sort((left, right) => left.name.localeCompare(right.name))) {
    const journalFile = path.join(root, entry.name);
    try {
      const token = entry.name.slice(0, -5);
      if (!/^[a-f0-9-]{36}$/.test(token)) throw new Error(`Invalid plugin uninstall journal name: ${entry.name}`);
      const value = JSON.parse(fs.readFileSync(journalFile, "utf8")) as unknown;
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error(`Invalid plugin uninstall journal: ${entry.name}`);
      }
      const journal = value as Record<string, unknown>;
      if (Object.keys(journal).sort().join(",") !== "journal_version,plugin_id" || journal.journal_version !== 1) {
        throw new Error(`Unsupported plugin uninstall journal: ${entry.name}`);
      }
      const pluginId = journal.plugin_id;
      if (typeof pluginId !== "string") throw new Error(`Invalid plugin id in uninstall journal: ${entry.name}`);
      assertPluginId(pluginId);
      const packageTrash = path.join(root, `${token}.package`);
      const source = path.join(packagesRoot(), pluginId);
      const shouldRestore = listPluginVersions(pluginId).some((version) => (
        version.installation && version.installation.lifecycle_state !== "removed"
      ));
      if (fs.existsSync(packageTrash)) {
        if (shouldRestore) {
          ensureRealDirectory(packagesRoot());
          if (fs.existsSync(source)) throw new Error(`Plugin uninstall recovery target already exists: ${pluginId}`);
          fs.renameSync(packageTrash, source);
          restored += 1;
        } else {
          fs.rmSync(packageTrash, { recursive: true, force: true });
          removed += 1;
        }
      }
      fs.rmSync(journalFile, { force: true });
    } catch (cause) {
      const quarantine = path.join(root, `${entry.name}.${randomUUID()}.invalid`);
      fs.renameSync(journalFile, quarantine);
      quarantined += 1;
      console.error("quarantined invalid plugin uninstall journal", entry.name, cause);
    }
  }
  return { restored, removed, quarantined };
}

export function installHrpArchive(
  archive: Buffer,
  options: { channel?: "staging" | "local" | "registry" } = {},
): InstallHrpResult {
  const channel = options.channel ?? "staging";
  const verified = verifyPluginArchive(archive, {
    allow_signature: true,
    trust_store: listPluginPublisherTrust(),
    require_trusted_signature: channel === "registry",
  });
  const { manifest } = verified.snapshot;
  ensurePackageStorage(manifest.id);
  const staging = fs.mkdtempSync(path.join(stagingRoot(), ".install-"));
  let targetCreated = false;
  const target = targetPackagePath(manifest.id, manifest.version);
  try {
    extractVerifiedHrpArchive(verified, staging);
    const descriptor = loadPluginPackage(staging, {
      source: "installed",
      allow_staged_runtime: !verified.snapshot.m4_data_only_eligible
        && !verified.snapshot.m5_projection_action_eligible
        && !verified.snapshot.m5_workflow_resolution_eligible
        && !verified.snapshot.m6_custom_renderer_eligible,
    });
    if (descriptor.manifest.id !== verified.lock.plugin.id || descriptor.manifest.version !== verified.lock.plugin.version) {
      throw new Error("Resolved plugin descriptor does not match HRP identity");
    }
    if (fs.existsSync(target)) {
      assertExistingPackageMatches(target, verified);
      fs.rmSync(staging, { recursive: true, force: true });
    } else {
      fs.renameSync(staging, target);
      targetCreated = true;
    }
    const m4Eligible = verified.snapshot.m4_data_only_eligible;
    const m5Eligible = verified.snapshot.m5_projection_action_eligible;
    const m5WorkflowEligible = verified.snapshot.m5_workflow_resolution_eligible;
    const m6CustomRendererEligible = verified.snapshot.m6_custom_renderer_eligible;
    const eligible = (m4Eligible || m5Eligible || m5WorkflowEligible || m6CustomRendererEligible)
      && verified.signature_state !== "revoked";
    try {
      const persisted = installExternalPluginPackage({
        descriptor,
        archive_digest: verified.archive_digest,
        payload_digest: verified.lock.payload_digest,
        channel,
        lifecycle_state: eligible ? "installed" : "staged",
        health_state: eligible ? "healthy" : verified.signature_state === "revoked" ? "unhealthy" : "unchecked",
        signature_state: verified.signature_state,
        ...(verified.signature ? {
          signature: {
            key_id: verified.signature.statement.key_id,
            publisher: verified.signature.statement.publisher,
            public_key_spki: verified.signature.statement.public_key_spki,
            payload_digest: verified.signature.statement.payload_digest,
          },
        } : {}),
        package_path: target,
      });
      return {
        ...persisted,
        archive_digest: verified.archive_digest,
        payload_digest: verified.lock.payload_digest,
        data_only_eligible: m4Eligible,
        m5_projection_action_eligible: m5Eligible,
        m5_projection_action_eligibility_reasons:
          verified.snapshot.m5_projection_action_eligibility_reasons,
        m5_workflow_resolution_eligible: m5WorkflowEligible,
        m5_workflow_resolution_eligibility_reasons:
          verified.snapshot.m5_workflow_resolution_eligibility_reasons,
        m6_custom_renderer_eligible: m6CustomRendererEligible,
        m6_custom_renderer_eligibility_reasons:
          verified.snapshot.m6_custom_renderer_eligibility_reasons,
        idempotent: persisted.idempotent,
      };
    } catch (cause) {
      if (targetCreated) fs.rmSync(target, { recursive: true, force: true });
      throw cause;
    }
  } catch (cause) {
    if (fs.existsSync(staging)) fs.rmSync(staging, { recursive: true, force: true });
    throw cause;
  }
}

export function reconcileInstalledPluginPublisherTrust(): {
  checked: number;
  updated: number;
  revoked: number;
  failures: Array<{ plugin_id: string; plugin_version: string; error: string }>;
} {
  const trustStore = listPluginPublisherTrust();
  let checked = 0;
  let updated = 0;
  let revoked = 0;
  const failures: Array<{ plugin_id: string; plugin_version: string; error: string }> = [];
  for (const pluginPackage of listPluginPackages().filter((candidate) => candidate.source === "installed")) {
    const version = listPluginVersions(pluginPackage.plugin_id)
      .find((candidate) => candidate.plugin_version === pluginPackage.plugin_version);
    const installation = version?.installation;
    if (!installation || installation.lifecycle_state === "removed") continue;
    checked += 1;
    try {
      const files = readInstalledPackageFiles(installation.package_path);
      const archive = encodeHrpZip([...files.entries()].map(([filePath, content]) => ({
        path: filePath,
        content,
      })));
      const verified = verifyPluginArchive(archive, {
        allow_signature: true,
        trust_store: trustStore,
      });
      if (
        verified.archive_digest !== installation.archive_digest
        || verified.lock.payload_digest !== installation.payload_digest
      ) throw new Error("Installed plugin archive identity no longer matches persistence");
      const result = updatePluginInstallationSignatureState({
        plugin_id: pluginPackage.plugin_id,
        plugin_version: pluginPackage.plugin_version,
        signature_state: verified.signature_state,
      });
      if (result.changed) updated += 1;
      if (verified.signature_state === "revoked") revoked += 1;
    } catch (cause) {
      failures.push({
        plugin_id: pluginPackage.plugin_id,
        plugin_version: pluginPackage.plugin_version,
        error: cause instanceof Error ? cause.message : String(cause),
      });
    }
  }
  return { checked, updated, revoked, failures };
}

export function activateInstalledPlugin(
  pluginId: string,
  version: string,
  expectedRevision?: number,
  options: { registry_authorized?: boolean } = {},
): PluginActivationRecord {
  const versions = listPluginVersions(pluginId);
  const target = versions.find((candidate) => candidate.plugin_version === version);
  const active = versions.find((candidate) => candidate.active);
  if (
    options.registry_authorized !== true
    && (target?.installation?.channel === "registry" || active?.installation?.channel === "registry")
  ) {
    throw new Error("Registry plugin activation requires the signed Registry lifecycle endpoint");
  }
  return activatePluginVersion(pluginId, version, { expected_revision: expectedRevision });
}

export function enableInstalledPlugin(
  pluginId: string,
  enabled: boolean,
  expected: { revision: number; active_version: string },
  options: { registry_authorized?: boolean } = {},
): PluginActivationRecord {
  if (enabled && options.registry_authorized !== true) {
    const active = listPluginVersions(pluginId).find((candidate) => candidate.active);
    if (active?.installation?.channel === "registry") {
      throw new Error("Registry plugin enablement requires the signed Registry lifecycle endpoint");
    }
  }
  return setPluginEnabled(pluginId, enabled, {
    expected_revision: expected.revision,
    expected_active_version: expected.active_version,
    registry_authorized: options.registry_authorized,
  });
}

export function rollbackInstalledPlugin(
  pluginId: string,
  version?: string,
  expectedRevision?: number,
  options: { registry_authorized?: boolean } = {},
): PluginActivationRecord {
  if (options.registry_authorized !== true) {
    const versions = listPluginVersions(pluginId);
    const active = versions.find((candidate) => candidate.active);
    const target = version === undefined
      ? undefined
      : versions.find((candidate) => candidate.plugin_version === version);
    if (
      active?.installation?.channel === "registry"
      || target?.installation?.channel === "registry"
      || (version === undefined && versions.some((candidate) => (
        candidate.installation?.channel === "registry"
        && candidate.installation.lifecycle_state !== "removed"
      )))
    ) {
      throw new Error("Registry plugin rollback requires the signed Registry lifecycle endpoint");
    }
  }
  return rollbackPluginVersion(pluginId, version, expectedRevision);
}

export function uninstallInstalledPlugin(pluginId: string, expectedVersionSetDigest: string): PluginVersionRecord[] {
  assertPluginId(pluginId);
  if (pluginVersionSetDigest(pluginId) !== expectedVersionSetDigest) {
    throw new Error("Plugin version set conflict");
  }
  const installedVersions = listPluginVersions(pluginId);
  for (const version of installedVersions) {
    const packagePath = version.installation?.package_path;
    if (packagePath && path.resolve(packagePath) !== path.resolve(targetPackagePath(pluginId, version.plugin_version))) {
      throw new Error(`Refusing to remove plugin package outside its immutable version path: ${pluginId}@${version.plugin_version}`);
    }
  }
  const source = path.join(packagesRoot(), pluginId);
  let journalFile: string | undefined;
  let packageTrash: string | undefined;
  if (fs.existsSync(source)) {
    const sourceStat = fs.lstatSync(source);
    if (sourceStat.isSymbolicLink() || !sourceStat.isDirectory()) {
      throw new Error(`Plugin package root must be a real directory: ${pluginId}`);
    }
    ensureRealDirectory(trashRoot());
    const token = randomUUID();
    journalFile = path.join(trashRoot(), `${token}.json`);
    packageTrash = path.join(trashRoot(), `${token}.package`);
    const descriptor = Buffer.from(`${JSON.stringify({ journal_version: 1, plugin_id: pluginId })}\n`, "utf8");
    try {
      const fd = fs.openSync(journalFile, "wx", 0o600);
      try {
        fs.writeFileSync(fd, descriptor);
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      fs.renameSync(source, packageTrash);
    } catch (cause) {
      if (packageTrash && fs.existsSync(packageTrash) && !fs.existsSync(source)) fs.renameSync(packageTrash, source);
      fs.rmSync(journalFile, { force: true });
      throw cause;
    }
  }
  let versions: PluginVersionRecord[];
  try {
    versions = uninstallExternalPlugin(pluginId, expectedVersionSetDigest);
  } catch (cause) {
    if (packageTrash && fs.existsSync(packageTrash) && !fs.existsSync(source)) fs.renameSync(packageTrash, source);
    if (journalFile) fs.rmSync(journalFile, { force: true });
    throw cause;
  }
  if (packageTrash) {
    try {
      fs.rmSync(packageTrash, { recursive: true, force: true });
      if (journalFile) fs.rmSync(journalFile, { force: true });
    } catch (cause) {
      console.error("plugin uninstall trash cleanup deferred to cold recovery", cause);
    }
  }
  return versions;
}

export function inspectInstalledPlugin(pluginId: string): {
  plugin_id: string;
  installed: boolean;
  healthy: boolean;
  issues: string[];
  versions: PluginVersionRecord[];
} {
  const versions = listPluginVersions(pluginId);
  const issues: string[] = [];
  const liveVersions = versions.filter((version) => (
    version.installation && version.installation.lifecycle_state !== "removed"
  ));
  for (const version of versions) {
    if (!version.installation) continue;
    if (version.installation.lifecycle_state !== "removed") {
      if (!fs.existsSync(version.installation.package_path)) {
        issues.push(`Package directory is missing: ${version.plugin_version}`);
      } else {
        try {
          const files = readInstalledPackageFiles(version.installation.package_path);
          const archive = encodeHrpZip([...files.entries()].map(([filePath, content]) => ({ path: filePath, content })));
          const verified = verifyPluginArchive(archive, {
            allow_signature: true,
            trust_store: listPluginPublisherTrust(),
          });
          if (
            verified.archive_digest !== version.installation.archive_digest
            || verified.lock.payload_digest !== version.installation.payload_digest
            || verified.lock.plugin.id !== pluginId
            || verified.lock.plugin.version !== version.plugin_version
          ) throw new Error("persisted package identity does not match verified bytes");
          if (
            version.installation.lifecycle_state === "installed"
            && version.installation.health_state === "healthy"
            && !verified.snapshot.m4_data_only_eligible
            && !verified.snapshot.m5_projection_action_eligible
            && !verified.snapshot.m5_workflow_resolution_eligible
            && !verified.snapshot.m6_custom_renderer_eligible
            && !(version.installation.channel === "registry"
              && version.installation.signature_state === "verified"
              && isHomerailDeclarativeKindMigrationManifest(verified.snapshot.manifest))
            && !(verified.snapshot.manifest.runtime.trust === "sandboxed_runtime"
              && verified.snapshot.manifest.runtime.entrypoint)
          ) {
            throw new Error(
              "persisted package is not eligible for an installed M4/M5/M6 tier: "
              + [
                ...verified.snapshot.m5_projection_action_eligibility_reasons,
                ...verified.snapshot.m5_workflow_resolution_eligibility_reasons,
              ].join(", "),
            );
          }
          const descriptor = loadPluginPackage(version.installation.package_path, {
            source: "installed",
            allow_staged_runtime: version.installation.lifecycle_state !== "installed"
              || version.installation.health_state !== "healthy"
              || verified.snapshot.manifest.runtime.trust === "sandboxed_runtime",
          });
          if (descriptor.package_digest !== version.package_digest) {
            throw new Error("persisted descriptor digest does not match verified package");
          }
        } catch (cause) {
          issues.push(`Package integrity check failed for ${version.plugin_version}: ${cause instanceof Error ? cause.message : String(cause)}`);
        }
      }
    }
    if (version.installation.lifecycle_state === "installed" && version.installation.health_state !== "healthy") {
      issues.push(`Installed version is not healthy: ${version.plugin_version}`);
    }
    if (version.installation.lifecycle_state !== "installed" && version.installation.lifecycle_state !== "removed") {
      issues.push(`Plugin version is not installed: ${version.plugin_version} (${version.installation.lifecycle_state})`);
    }
  }
  return {
    plugin_id: pluginId,
    installed: liveVersions.length > 0,
    healthy: liveVersions.length > 0 && issues.length === 0,
    issues,
    versions,
  };
}
