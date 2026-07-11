import {
  validateHomerailPluginManifest,
  type HomerailResolvedPluginDescriptorV1,
} from "homerail-protocol";
import { validateResolvedPluginDescriptor, pluginJsonDigest } from "../plugins/descriptor.js";
import { encodeJson, getDb, parseJsonRow } from "./db.js";
import { nowIso } from "./time.js";

export type PluginPackageSource = "builtin" | "installed" | "development";

interface PluginPackageRow {
  plugin_id: string;
  plugin_version: string;
  manifest_version: number;
  package_digest: string;
  manifest_json: string;
  resolved_descriptor_json: string;
  source: PluginPackageSource;
  installed_at: string;
}

interface PluginActivationRow {
  plugin_id: string;
  active_version: string;
  enabled: number;
  locked: number;
  revision: number;
  updated_at: string;
}

interface ActivePluginRow extends PluginPackageRow, PluginActivationRow {}

interface PluginInstallationRow {
  plugin_id: string;
  plugin_version: string;
  archive_digest: string;
  payload_digest: string;
  channel: "staging" | "local" | "registry";
  lifecycle_state: "staged" | "installed" | "removed" | "failed";
  health_state: "unchecked" | "healthy" | "unhealthy";
  signature_state: "unsigned" | "verified" | "untrusted" | "revoked";
  package_path: string;
  installed_at: string;
  updated_at: string;
  removed_at: string | null;
}

export interface PluginPackageRecord {
  plugin_id: string;
  plugin_version: string;
  package_digest: string;
  source: PluginPackageSource;
  installed_at: string;
  descriptor: HomerailResolvedPluginDescriptorV1;
}

export interface PluginActivationRecord {
  plugin_id: string;
  active_version: string;
  enabled: boolean;
  locked: boolean;
  revision: number;
  updated_at: string;
}

export interface ActivePluginRecord extends PluginPackageRecord {
  activation: PluginActivationRecord;
}

export interface PluginRegistryState {
  revision: number;
  fingerprint: string;
  plugins: ActivePluginRecord[];
}

export type PluginInstallationRecord = PluginInstallationRow;

export interface PluginVersionRecord extends PluginPackageRecord {
  installation?: PluginInstallationRecord;
  active: boolean;
  enabled: boolean;
}

export interface PluginPermissionGrantRecord {
  plugin_id: string;
  plugin_version: string;
  permission: string;
  declaration: Record<string, unknown>;
  status: "pending" | "granted" | "denied";
  revision: number;
  updated_at: string;
}

function decodePackage(row: PluginPackageRow): PluginPackageRecord {
  const manifest = parseJsonRow<unknown>(row.manifest_json);
  const descriptor = parseJsonRow<HomerailResolvedPluginDescriptorV1>(row.resolved_descriptor_json);
  const manifestValidation = validateHomerailPluginManifest(manifest);
  const descriptorErrors = validateResolvedPluginDescriptor(descriptor);
  if (
    !manifestValidation.valid
    || !manifestValidation.value
    || descriptorErrors.length
    || descriptor.manifest.id !== row.plugin_id
    || descriptor.manifest.version !== row.plugin_version
    || descriptor.manifest.manifest_version !== row.manifest_version
    || descriptor.package_digest !== row.package_digest
    || descriptor.manifest_digest !== pluginJsonDigest(manifestValidation.value, 512 * 1024)
    || JSON.stringify(descriptor.manifest) !== JSON.stringify(manifestValidation.value)
  ) {
    throw new Error(`Invalid persisted plugin package: ${row.plugin_id}@${row.plugin_version}`);
  }
  return {
    plugin_id: row.plugin_id,
    plugin_version: row.plugin_version,
    package_digest: row.package_digest,
    source: row.source,
    installed_at: row.installed_at,
    descriptor: structuredClone(descriptor),
  };
}

function decodeActivation(row: PluginActivationRow): PluginActivationRecord {
  if (
    !Number.isInteger(row.revision)
    || row.revision < 1
    || (row.enabled !== 0 && row.enabled !== 1)
    || (row.locked !== 0 && row.locked !== 1)
    || (row.locked === 1 && row.enabled !== 1)
  ) {
    throw new Error(`Invalid persisted plugin activation: ${row.plugin_id}`);
  }
  return {
    plugin_id: row.plugin_id,
    active_version: row.active_version,
    enabled: row.enabled === 1,
    locked: row.locked === 1,
    revision: row.revision,
    updated_at: row.updated_at,
  };
}

function decodeInstallation(row: PluginInstallationRow): PluginInstallationRecord {
  if (
    !["staging", "local", "registry"].includes(row.channel)
    || !["staged", "installed", "removed", "failed"].includes(row.lifecycle_state)
    || !["unchecked", "healthy", "unhealthy"].includes(row.health_state)
    || !["unsigned", "verified", "untrusted", "revoked"].includes(row.signature_state)
  ) throw new Error(`Invalid persisted plugin installation: ${row.plugin_id}@${row.plugin_version}`);
  return { ...row };
}

function appendActivationEvent(input: {
  plugin_id: string;
  event_type: "install" | "activate" | "enable" | "disable" | "rollback" | "uninstall";
  from_version?: string | null;
  to_version: string;
  activation_revision: number;
  timestamp: string;
  data?: Record<string, unknown>;
}): void {
  getDb().prepare(`
    INSERT INTO plugin_activation_events(
      plugin_id, event_type, from_version, to_version,
      activation_revision, created_at, data_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.plugin_id,
    input.event_type,
    input.from_version ?? null,
    input.to_version,
    input.activation_revision,
    input.timestamp,
    encodeJson(input.data ?? {}),
  );
}

function assertExternalVersionReady(pluginId: string, version: string): PluginInstallationRecord {
  const installation = getDb().prepare(`
    SELECT plugin_id, plugin_version, archive_digest, payload_digest, channel,
           lifecycle_state, health_state, signature_state, package_path,
           installed_at, updated_at, removed_at
    FROM plugin_installations WHERE plugin_id = ? AND plugin_version = ?
  `).get(pluginId, version) as PluginInstallationRow | undefined;
  if (!installation) throw new Error(`External plugin version is not installed: ${pluginId}@${version}`);
  const decoded = decodeInstallation(installation);
  if (decoded.lifecycle_state !== "installed" || decoded.health_state !== "healthy") {
    throw new Error(`Plugin version is not healthy and installed: ${pluginId}@${version}`);
  }
  const pendingRequired = getDb().prepare(`
    SELECT permission FROM plugin_permission_grants
    WHERE plugin_id = ? AND plugin_version = ? AND status != 'granted'
      AND json_extract(grant_json, '$.required') = 1
    ORDER BY permission
  `).all(pluginId, version) as Array<{ permission: string }>;
  if (pendingRequired.length) {
    throw new Error(`Plugin version has ungranted required permissions: ${pendingRequired.map((row) => row.permission).join(", ")}`);
  }
  return decoded;
}

function activeRow(pluginId: string): ActivePluginRow | undefined {
  return getDb().prepare(`
    SELECT p.plugin_id, p.plugin_version, p.manifest_version, p.package_digest,
           p.manifest_json, p.resolved_descriptor_json, p.source, p.installed_at,
           a.active_version, a.enabled, a.locked, a.revision, a.updated_at
    FROM plugin_activations a
    JOIN plugin_packages p
      ON p.plugin_id = a.plugin_id AND p.plugin_version = a.active_version
    WHERE a.plugin_id = ?
  `).get(pluginId) as ActivePluginRow | undefined;
}

function decodeActive(row: ActivePluginRow): ActivePluginRecord {
  return {
    ...decodePackage(row),
    activation: decodeActivation(row),
  };
}

export function syncPluginPackage(input: {
  descriptor: HomerailResolvedPluginDescriptorV1;
  source: PluginPackageSource;
  locked?: boolean;
  default_enabled?: boolean;
  timestamp?: string;
}): ActivePluginRecord {
  const errors = validateResolvedPluginDescriptor(input.descriptor);
  if (errors.length) throw new Error(`Cannot persist invalid plugin descriptor: ${JSON.stringify(errors)}`);
  const { manifest } = input.descriptor;
  const locked = input.locked ?? false;
  const defaultEnabled = locked || (input.default_enabled ?? false);
  if (locked && input.source !== "builtin") throw new Error("Only builtin plugins may be locked");
  const timestamp = input.timestamp ?? nowIso();

  return getDb().transaction(() => {
    const existingPackage = getDb().prepare(`
      SELECT plugin_id, plugin_version, manifest_version, package_digest,
             manifest_json, resolved_descriptor_json, source, installed_at
      FROM plugin_packages
      WHERE plugin_id = ? AND plugin_version = ?
    `).get(manifest.id, manifest.version) as PluginPackageRow | undefined;
    if (existingPackage) {
      const decoded = decodePackage(existingPackage);
      if (decoded.package_digest !== input.descriptor.package_digest) {
        throw new Error(`Plugin package digest collision: ${manifest.id}@${manifest.version}`);
      }
    } else {
      getDb().prepare(`
        INSERT INTO plugin_packages(
          plugin_id, plugin_version, manifest_version, package_digest,
          manifest_json, resolved_descriptor_json, source, installed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        manifest.id,
        manifest.version,
        manifest.manifest_version,
        input.descriptor.package_digest,
        encodeJson(manifest),
        encodeJson(input.descriptor),
        input.source,
        timestamp,
      );
    }

    const activation = getDb().prepare(`
      SELECT plugin_id, active_version, enabled, locked, revision, updated_at
      FROM plugin_activations WHERE plugin_id = ?
    `).get(manifest.id) as PluginActivationRow | undefined;
    if (!activation) {
      getDb().prepare(`
        INSERT INTO plugin_activations(
          plugin_id, active_version, enabled, locked, revision, updated_at
        ) VALUES (?, ?, ?, ?, 1, ?)
      `).run(manifest.id, manifest.version, defaultEnabled ? 1 : 0, locked ? 1 : 0, timestamp);
    } else {
      const current = decodeActivation(activation);
      const nextLocked = current.locked || locked;
      const nextEnabled = nextLocked ? true : current.enabled;
      if (
        current.active_version !== manifest.version
        || current.locked !== nextLocked
        || current.enabled !== nextEnabled
      ) {
        getDb().prepare(`
          UPDATE plugin_activations
          SET active_version = ?, enabled = ?, locked = ?, revision = revision + 1, updated_at = ?
          WHERE plugin_id = ?
        `).run(manifest.version, nextEnabled ? 1 : 0, nextLocked ? 1 : 0, timestamp, manifest.id);
      }
    }
    return decodeActive(activeRow(manifest.id)!);
  }).immediate();
}

export function setPluginEnabled(
  pluginId: string,
  enabled: boolean,
  options: { expected_revision?: number; expected_active_version?: string; timestamp?: string } = {},
): PluginActivationRecord {
  const timestamp = options.timestamp ?? nowIso();
  return getDb().transaction(() => {
    const row = getDb().prepare(`
      SELECT plugin_id, active_version, enabled, locked, revision, updated_at
      FROM plugin_activations WHERE plugin_id = ?
    `).get(pluginId) as PluginActivationRow | undefined;
    if (!row) throw new Error(`Plugin is not installed: ${pluginId}`);
    const current = decodeActivation(row);
    if (options.expected_revision !== undefined && options.expected_revision !== current.revision) {
      throw new Error(`Plugin activation revision conflict: expected ${options.expected_revision}, current ${current.revision}`);
    }
    if (options.expected_active_version !== undefined && options.expected_active_version !== current.active_version) {
      throw new Error(`Plugin active version conflict: expected ${options.expected_active_version}, current ${current.active_version}`);
    }
    if (current.locked && !enabled) throw new Error(`Plugin is locked and cannot be disabled: ${pluginId}`);
    if (enabled) {
      const packageRow = getDb().prepare("SELECT source FROM plugin_packages WHERE plugin_id = ? AND plugin_version = ?")
        .get(pluginId, current.active_version) as { source: PluginPackageSource } | undefined;
      if (packageRow?.source === "installed") assertExternalVersionReady(pluginId, current.active_version);
    }
    if (current.enabled === enabled) return current;
    const update = getDb().prepare(`
      UPDATE plugin_activations
      SET enabled = ?, revision = revision + 1, updated_at = ?
      WHERE plugin_id = ? AND revision = ?
    `).run(enabled ? 1 : 0, timestamp, pluginId, current.revision);
    if (update.changes !== 1) throw new Error("Plugin activation revision conflict");
    const next = decodeActivation(getDb().prepare(`
      SELECT plugin_id, active_version, enabled, locked, revision, updated_at
      FROM plugin_activations WHERE plugin_id = ?
    `).get(pluginId) as PluginActivationRow);
    appendActivationEvent({
      plugin_id: pluginId,
      event_type: enabled ? "enable" : "disable",
      from_version: current.active_version,
      to_version: next.active_version,
      activation_revision: next.revision,
      timestamp,
    });
    return next;
  }).immediate();
}

export function installExternalPluginPackage(input: {
  descriptor: HomerailResolvedPluginDescriptorV1;
  archive_digest: string;
  payload_digest: string;
  channel: PluginInstallationRow["channel"];
  lifecycle_state: PluginInstallationRow["lifecycle_state"];
  health_state: PluginInstallationRow["health_state"];
  signature_state: PluginInstallationRow["signature_state"];
  package_path: string;
  timestamp?: string;
}): {
  package: PluginPackageRecord;
  installation: PluginInstallationRecord;
  activation: PluginActivationRecord;
  idempotent: boolean;
} {
  const errors = validateResolvedPluginDescriptor(input.descriptor);
  if (errors.length) throw new Error(`Cannot install invalid plugin descriptor: ${JSON.stringify(errors)}`);
  const { manifest } = input.descriptor;
  const timestamp = input.timestamp ?? nowIso();
  return getDb().transaction(() => {
    const existing = getDb().prepare(`
      SELECT plugin_id, plugin_version, manifest_version, package_digest,
             manifest_json, resolved_descriptor_json, source, installed_at
      FROM plugin_packages WHERE plugin_id = ? AND plugin_version = ?
    `).get(manifest.id, manifest.version) as PluginPackageRow | undefined;
    if (existing) {
      const decoded = decodePackage(existing);
      if (decoded.package_digest !== input.descriptor.package_digest) {
        throw new Error(`Plugin package digest collision: ${manifest.id}@${manifest.version}`);
      }
    } else {
      getDb().prepare(`
        INSERT INTO plugin_packages(
          plugin_id, plugin_version, manifest_version, package_digest,
          manifest_json, resolved_descriptor_json, source, installed_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'installed', ?)
      `).run(
        manifest.id,
        manifest.version,
        manifest.manifest_version,
        input.descriptor.package_digest,
        encodeJson(manifest),
        encodeJson(input.descriptor),
        timestamp,
      );
    }
    const previousInstallation = getDb().prepare(`
      SELECT plugin_id, plugin_version, archive_digest, payload_digest, channel,
             lifecycle_state, health_state, signature_state, package_path,
             installed_at, updated_at, removed_at
      FROM plugin_installations WHERE plugin_id = ? AND plugin_version = ?
    `).get(manifest.id, manifest.version) as PluginInstallationRow | undefined;
    let installationUnchanged = false;
    if (previousInstallation) {
      const decoded = decodeInstallation(previousInstallation);
      if (
        decoded.archive_digest !== input.archive_digest
        || decoded.payload_digest !== input.payload_digest
        || decoded.package_path !== input.package_path
      ) throw new Error(`Plugin installation identity collision: ${manifest.id}@${manifest.version}`);
      installationUnchanged = decoded.lifecycle_state === input.lifecycle_state
        && decoded.health_state === input.health_state
        && decoded.signature_state === input.signature_state
        && decoded.channel === input.channel
        && decoded.removed_at === null;
      if (!installationUnchanged) {
        getDb().prepare(`
          UPDATE plugin_installations
          SET lifecycle_state = ?, health_state = ?, signature_state = ?,
              channel = ?, updated_at = ?, removed_at = NULL
          WHERE plugin_id = ? AND plugin_version = ?
        `).run(
          input.lifecycle_state, input.health_state, input.signature_state,
          input.channel, timestamp, manifest.id, manifest.version,
        );
      }
    } else {
      getDb().prepare(`
        INSERT INTO plugin_installations(
          plugin_id, plugin_version, archive_digest, payload_digest, channel,
          lifecycle_state, health_state, signature_state, package_path,
          installed_at, updated_at, removed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
      `).run(
        manifest.id, manifest.version, input.archive_digest, input.payload_digest,
        input.channel, input.lifecycle_state, input.health_state, input.signature_state,
        input.package_path, timestamp, timestamp,
      );
    }
    const grants = [...manifest.permissions.required.map((grant) => ({ required: true, grant })),
      ...manifest.permissions.optional.map((grant) => ({ required: false, grant }))];
    for (const grant of grants) {
      getDb().prepare(`
        INSERT INTO plugin_permission_grants(
          plugin_id, plugin_version, permission, grant_json, status, revision, updated_at
        ) VALUES (?, ?, ?, ?, 'pending', 1, ?)
        ON CONFLICT(plugin_id, plugin_version, permission) DO NOTHING
      `).run(manifest.id, manifest.version, grant.grant.permission, encodeJson(grant), timestamp);
    }
    let activation = getDb().prepare(`
      SELECT plugin_id, active_version, enabled, locked, revision, updated_at
      FROM plugin_activations WHERE plugin_id = ?
    `).get(manifest.id) as PluginActivationRow | undefined;
    const activationExisted = Boolean(activation);
    if (!activation) {
      getDb().prepare(`
        INSERT INTO plugin_activations(plugin_id, active_version, enabled, locked, revision, updated_at)
        VALUES (?, ?, 0, 0, 1, ?)
      `).run(manifest.id, manifest.version, timestamp);
      activation = getDb().prepare(`
        SELECT plugin_id, active_version, enabled, locked, revision, updated_at
        FROM plugin_activations WHERE plugin_id = ?
      `).get(manifest.id) as PluginActivationRow;
    }
    const decodedActivation = decodeActivation(activation);
    const idempotent = Boolean(existing && previousInstallation && installationUnchanged && activationExisted);
    if (!idempotent) {
      appendActivationEvent({
        plugin_id: manifest.id,
        event_type: "install",
        from_version: decodedActivation.active_version,
        to_version: manifest.version,
        activation_revision: decodedActivation.revision,
        timestamp,
        data: { channel: input.channel, lifecycle_state: input.lifecycle_state },
      });
    }
    const packageRow = getDb().prepare(`
      SELECT plugin_id, plugin_version, manifest_version, package_digest,
             manifest_json, resolved_descriptor_json, source, installed_at
      FROM plugin_packages WHERE plugin_id = ? AND plugin_version = ?
    `).get(manifest.id, manifest.version) as PluginPackageRow;
    const installationRow = getDb().prepare(`
      SELECT plugin_id, plugin_version, archive_digest, payload_digest, channel,
             lifecycle_state, health_state, signature_state, package_path,
             installed_at, updated_at, removed_at
      FROM plugin_installations WHERE plugin_id = ? AND plugin_version = ?
    `).get(manifest.id, manifest.version) as PluginInstallationRow;
    return {
      package: decodePackage(packageRow),
      installation: decodeInstallation(installationRow),
      activation: decodedActivation,
      idempotent,
    };
  }).immediate();
}

export function activatePluginVersion(
  pluginId: string,
  version: string,
  options: { expected_revision?: number; event_type?: "activate" | "rollback"; preserve_enabled?: boolean; timestamp?: string } = {},
): PluginActivationRecord {
  const timestamp = options.timestamp ?? nowIso();
  return getDb().transaction(() => {
    assertExternalVersionReady(pluginId, version);
    const row = getDb().prepare(`
      SELECT plugin_id, active_version, enabled, locked, revision, updated_at
      FROM plugin_activations WHERE plugin_id = ?
    `).get(pluginId) as PluginActivationRow | undefined;
    if (!row) throw new Error(`Plugin is not installed: ${pluginId}`);
    const current = decodeActivation(row);
    if (current.locked) throw new Error(`Locked plugin version cannot be changed: ${pluginId}`);
    if (options.expected_revision !== undefined && options.expected_revision !== current.revision) {
      throw new Error(`Plugin activation revision conflict: expected ${options.expected_revision}, current ${current.revision}`);
    }
    if (current.active_version === version) return current;
    const enabled = options.preserve_enabled ? current.enabled : false;
    const update = getDb().prepare(`
      UPDATE plugin_activations
      SET active_version = ?, enabled = ?, revision = revision + 1, updated_at = ?
      WHERE plugin_id = ? AND revision = ?
    `).run(version, enabled ? 1 : 0, timestamp, pluginId, current.revision);
    if (update.changes !== 1) throw new Error("Plugin activation revision conflict");
    const next = decodeActivation(getDb().prepare(`
      SELECT plugin_id, active_version, enabled, locked, revision, updated_at
      FROM plugin_activations WHERE plugin_id = ?
    `).get(pluginId) as PluginActivationRow);
    appendActivationEvent({
      plugin_id: pluginId,
      event_type: options.event_type ?? "activate",
      from_version: current.active_version,
      to_version: next.active_version,
      activation_revision: next.revision,
      timestamp,
    });
    return next;
  }).immediate();
}

export function rollbackPluginVersion(
  pluginId: string,
  targetVersion?: string,
  expectedRevision?: number,
): PluginActivationRecord {
  const active = getActivePlugin(pluginId);
  if (!active) throw new Error(`Plugin is not installed: ${pluginId}`);
  const previousActive = getDb().prepare(`
    SELECT e.from_version AS plugin_version
    FROM plugin_activation_events e
    JOIN plugin_installations i
      ON i.plugin_id = e.plugin_id AND i.plugin_version = e.from_version
    WHERE e.plugin_id = ? AND e.to_version = ?
      AND e.event_type IN ('activate', 'rollback')
      AND e.from_version IS NOT NULL AND e.from_version != e.to_version
      AND i.lifecycle_state = 'installed' AND i.health_state = 'healthy'
    ORDER BY e.seq DESC LIMIT 1
  `).get(pluginId, active.plugin_version) as { plugin_version: string } | undefined;
  const legacyFallback = getDb().prepare(`
    SELECT i.plugin_version
    FROM plugin_installations i
    WHERE i.plugin_id = ? AND i.plugin_version != ?
      AND i.lifecycle_state = 'installed' AND i.health_state = 'healthy'
    ORDER BY i.installed_at DESC, i.plugin_version DESC LIMIT 1
  `).get(pluginId, active.plugin_version) as { plugin_version: string } | undefined;
  const target = targetVersion ?? previousActive?.plugin_version ?? legacyFallback?.plugin_version;
  if (!target) throw new Error(`No healthy rollback version is available: ${pluginId}`);
  return activatePluginVersion(pluginId, target, {
    expected_revision: expectedRevision,
    event_type: "rollback",
    preserve_enabled: true,
  });
}

export function setPluginGrantStatus(input: {
  plugin_id: string;
  plugin_version: string;
  permission: string;
  status: "granted" | "denied";
  expected_revision?: number;
  timestamp?: string;
}): { permission: string; status: string; revision: number } {
  const timestamp = input.timestamp ?? nowIso();
  return getDb().transaction(() => {
    const current = getDb().prepare(`
      SELECT status, revision FROM plugin_permission_grants
      WHERE plugin_id = ? AND plugin_version = ? AND permission = ?
    `).get(input.plugin_id, input.plugin_version, input.permission) as { status: string; revision: number } | undefined;
    if (!current) throw new Error(`Plugin permission was not requested: ${input.permission}`);
    if (input.expected_revision !== undefined && current.revision !== input.expected_revision) {
      throw new Error("Plugin permission revision conflict");
    }
    if (current.status === input.status) return { permission: input.permission, ...current };
    const update = getDb().prepare(`
      UPDATE plugin_permission_grants
      SET status = ?, revision = revision + 1, updated_at = ?
      WHERE plugin_id = ? AND plugin_version = ? AND permission = ? AND revision = ?
    `).run(input.status, timestamp, input.plugin_id, input.plugin_version, input.permission, current.revision);
    if (update.changes !== 1) throw new Error("Plugin permission revision conflict");
    const next = getDb().prepare(`
      SELECT status, revision FROM plugin_permission_grants
      WHERE plugin_id = ? AND plugin_version = ? AND permission = ?
    `).get(input.plugin_id, input.plugin_version, input.permission) as { status: string; revision: number };
    return { permission: input.permission, ...next };
  }).immediate();
}

export function listPluginVersions(pluginId: string): PluginVersionRecord[] {
  const activation = getActivePlugin(pluginId)?.activation;
  const packages = listPluginPackages().filter((pluginPackage) => pluginPackage.plugin_id === pluginId);
  return packages.map((pluginPackage) => {
    const row = getDb().prepare(`
      SELECT plugin_id, plugin_version, archive_digest, payload_digest, channel,
             lifecycle_state, health_state, signature_state, package_path,
             installed_at, updated_at, removed_at
      FROM plugin_installations WHERE plugin_id = ? AND plugin_version = ?
    `).get(pluginId, pluginPackage.plugin_version) as PluginInstallationRow | undefined;
    return {
      ...pluginPackage,
      ...(row ? { installation: decodeInstallation(row) } : {}),
      active: activation?.active_version === pluginPackage.plugin_version,
      enabled: Boolean(activation?.enabled && activation.active_version === pluginPackage.plugin_version),
    };
  });
}

export function pluginVersionSetDigest(pluginId: string): string {
  const active = getActivePlugin(pluginId)?.activation;
  return pluginJsonDigest({
    plugin_id: pluginId,
    activation: active ? {
      active_version: active.active_version,
      enabled: active.enabled,
      revision: active.revision,
    } : null,
    versions: listPluginVersions(pluginId).map((version) => ({
      plugin_version: version.plugin_version,
      package_digest: version.package_digest,
      source: version.source,
      installation: version.installation ? {
        archive_digest: version.installation.archive_digest,
        payload_digest: version.installation.payload_digest,
        channel: version.installation.channel,
        lifecycle_state: version.installation.lifecycle_state,
        health_state: version.installation.health_state,
        signature_state: version.installation.signature_state,
      } : null,
    })),
  });
}

export function listPluginPermissionGrants(pluginId: string, version?: string): PluginPermissionGrantRecord[] {
  const rows = getDb().prepare(`
    SELECT plugin_id, plugin_version, permission, grant_json, status, revision, updated_at
    FROM plugin_permission_grants
    WHERE plugin_id = ? AND (? IS NULL OR plugin_version = ?)
    ORDER BY plugin_version, permission
  `).all(pluginId, version ?? null, version ?? null) as Array<{
    plugin_id: string;
    plugin_version: string;
    permission: string;
    grant_json: string;
    status: "pending" | "granted" | "denied";
    revision: number;
    updated_at: string;
  }>;
  return rows.map((row) => ({
    plugin_id: row.plugin_id,
    plugin_version: row.plugin_version,
    permission: row.permission,
    declaration: parseJsonRow<Record<string, unknown>>(row.grant_json),
    status: row.status,
    revision: row.revision,
    updated_at: row.updated_at,
  }));
}

export function uninstallExternalPlugin(
  pluginId: string,
  expectedVersionSetDigest: string,
  timestamp = nowIso(),
): PluginVersionRecord[] {
  return getDb().transaction(() => {
    const currentVersionSetDigest = pluginVersionSetDigest(pluginId);
    if (currentVersionSetDigest !== expectedVersionSetDigest) {
      throw new Error("Plugin version set conflict");
    }
    const active = getActivePlugin(pluginId);
    if (!active) throw new Error(`Plugin is not installed: ${pluginId}`);
    if (active.source !== "installed" || active.activation.locked) throw new Error(`Plugin cannot be uninstalled: ${pluginId}`);
    const versions = listPluginVersions(pluginId);
    getDb().prepare(`
      UPDATE plugin_installations
      SET lifecycle_state = 'removed', updated_at = ?, removed_at = ?
      WHERE plugin_id = ? AND lifecycle_state != 'removed'
    `).run(timestamp, timestamp, pluginId);
    appendActivationEvent({
      plugin_id: pluginId,
      event_type: "uninstall",
      from_version: active.plugin_version,
      to_version: active.plugin_version,
      activation_revision: active.activation.revision + 1,
      timestamp,
    });
    getDb().prepare("DELETE FROM plugin_activations WHERE plugin_id = ?").run(pluginId);
    return versions;
  }).immediate();
}

export function listPluginPackages(): PluginPackageRecord[] {
  const rows = getDb().prepare(`
    SELECT plugin_id, plugin_version, manifest_version, package_digest,
           manifest_json, resolved_descriptor_json, source, installed_at
    FROM plugin_packages
    ORDER BY plugin_id, plugin_version
  `).all() as PluginPackageRow[];
  return rows.map(decodePackage);
}

export function getPluginRegistryState(): PluginRegistryState {
  const rows = getDb().prepare(`
    SELECT p.plugin_id, p.plugin_version, p.manifest_version, p.package_digest,
           p.manifest_json, p.resolved_descriptor_json, p.source, p.installed_at,
           a.active_version, a.enabled, a.locked, a.revision, a.updated_at
    FROM plugin_activations a
    JOIN plugin_packages p
      ON p.plugin_id = a.plugin_id AND p.plugin_version = a.active_version
    ORDER BY p.plugin_id
  `).all() as ActivePluginRow[];
  const plugins = rows.map(decodeActive);
  const registryMeta = getDb().prepare(`
    SELECT revision FROM plugin_registry_meta WHERE singleton = 1
  `).get() as { revision: number } | undefined;
  if (!registryMeta || !Number.isSafeInteger(registryMeta.revision) || registryMeta.revision < 0) {
    throw new Error("Invalid persisted plugin registry revision");
  }
  return {
    revision: registryMeta.revision,
    fingerprint: pluginJsonDigest(plugins.map((plugin) => ({
      id: plugin.plugin_id,
      version: plugin.plugin_version,
      digest: plugin.package_digest,
      enabled: plugin.activation.enabled,
      locked: plugin.activation.locked,
      revision: plugin.activation.revision,
    }))),
    plugins,
  };
}

export function getActivePlugin(pluginId: string): ActivePluginRecord | undefined {
  const row = activeRow(pluginId);
  return row ? decodeActive(row) : undefined;
}
