import { createHash } from "node:crypto";
import {
  verifyHrpArchive,
  verifyPluginRegistryIndex,
} from "homerail-plugin-sdk";
import {
  getActivePlugin,
  listPluginVersions,
} from "../persistence/plugins.js";
import { getDb } from "../persistence/db.js";
import { nowIso } from "../persistence/time.js";
import { listPluginPublisherTrust } from "../persistence/plugin-distribution.js";
import {
  commitPluginRegistryIndex,
  configurePluginRegistrySource,
  getPluginRegistryRelease,
  getPluginRegistrySource,
  listPluginRegistryReleases,
  listPluginRegistrySources,
  listPluginRegistryUpdateAttempts,
  recordPluginRegistryAttempt,
  type PluginRegistryOperation,
} from "../persistence/plugin-registry-distribution.js";
import {
  activateInstalledPlugin,
  enableInstalledPlugin,
  installHrpArchive,
  rollbackInstalledPlugin,
} from "./package-lifecycle.js";
import { migrateCanonicalDocumentsAndActivateStagedRegistryPlugin } from "./kind-migration.js";

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function instant(value: string | Date | undefined): number {
  const timestamp = value instanceof Date
    ? value.getTime()
    : value === undefined
      ? Date.now()
      : Date.parse(value);
  if (!Number.isFinite(timestamp)) throw new Error("Plugin registry operation time is invalid");
  return timestamp;
}

function assertFreshRegistrySource(
  source: NonNullable<ReturnType<typeof getPluginRegistrySource>>,
  now?: string | Date,
): void {
  const expiresAt = source.last_expires_at === undefined
    ? Number.NaN
    : Date.parse(source.last_expires_at);
  if (!Number.isFinite(expiresAt) || expiresAt <= instant(now)) {
    throw new Error(`Plugin registry catalog is expired or has no verified freshness: ${source.registry_id}`);
  }
}

export function configureRemotePluginRegistry(input: {
  registry_id: string;
  source_url: string;
  root_key_id: string;
}) {
  return configurePluginRegistrySource(input);
}

export function syncRemotePluginRegistryIndex(input: {
  registry_id: string;
  index_bytes: Uint8Array;
  now?: string | Date;
}) {
  const source = getPluginRegistrySource(input.registry_id);
  if (!source) throw new Error(`Plugin registry source is not configured: ${input.registry_id}`);
  const indexDigest = sha256(input.index_bytes);
  try {
    const verified = verifyPluginRegistryIndex(input.index_bytes, {
      expected_registry_id: source.registry_id,
      root_pin: source.root_key_id,
      min_sequence: source.last_sequence,
      ...(input.now === undefined ? {} : { now: input.now }),
    });
    return commitPluginRegistryIndex(verified);
  } catch (cause) {
    recordPluginRegistryAttempt({
      registry_id: source.registry_id,
      operation: "sync",
      status: "failed",
      index_digest: indexDigest,
      error: errorMessage(cause),
      data: { preserved_sequence: source.last_sequence },
    });
    throw cause;
  }
}

function releaseAndArchive(input: {
  registry_id: string;
  plugin_id: string;
  plugin_version: string;
  archive: Uint8Array;
  now?: string | Date;
}) {
  const source = getPluginRegistrySource(input.registry_id);
  if (!source) throw new Error(`Plugin registry source is not configured: ${input.registry_id}`);
  assertFreshRegistrySource(source, input.now);
  const release = getPluginRegistryRelease(input.registry_id, input.plugin_id, input.plugin_version);
  if (!release) {
    throw new Error(`Plugin registry release is not catalogued: ${input.plugin_id}@${input.plugin_version}`);
  }
  const archive = Buffer.from(input.archive);
  if (sha256(archive) !== release.archive_digest) {
    throw new Error("Plugin registry archive digest mismatch");
  }
  const verified = verifyHrpArchive(archive, {
    allow_signature: true,
    trust_store: listPluginPublisherTrust(),
    require_trusted_signature: true,
  });
  if (
    verified.lock.plugin.id !== release.plugin_id
    || verified.lock.plugin.version !== release.plugin_version
    || verified.lock.payload_digest !== release.payload_digest
    || verified.signature?.statement.key_id !== release.publisher_key_id
  ) throw new Error("Plugin registry release identity or publisher digest mismatch");
  return { source, release, archive };
}

export function installRemotePluginRegistryRelease(input: {
  registry_id: string;
  plugin_id: string;
  plugin_version: string;
  archive: Uint8Array;
  operation?: Extract<PluginRegistryOperation, "install" | "update">;
  now?: string | Date;
}) {
  const operation = input.operation ?? "install";
  const before = getActivePlugin(input.plugin_id)?.activation;
  try {
    const { release, archive } = releaseAndArchive(input);
    const installed = installHrpArchive(archive, { channel: "registry" });
    if (
      installed.archive_digest !== release.archive_digest
      || installed.payload_digest !== release.payload_digest
      || installed.installation.signature_state !== "verified"
    ) throw new Error("Manager registry install verification disagrees with the signed release catalog");
    if (before && (
      installed.activation.active_version !== before.active_version
      || installed.activation.revision !== before.revision
      || installed.activation.enabled !== before.enabled
    )) throw new Error("Registry update changed the active version before explicit activation");
    const attempt = recordPluginRegistryAttempt({
      registry_id: input.registry_id,
      operation,
      status: "succeeded",
      plugin_id: input.plugin_id,
      from_version: before?.active_version,
      to_version: input.plugin_version,
      index_sequence: release.index_sequence,
      index_digest: getPluginRegistrySource(input.registry_id)?.last_index_digest,
      rollback_version: before?.active_version,
      data: {
        archive_digest: release.archive_digest,
        payload_digest: release.payload_digest,
        candidate_active: installed.activation.active_version === input.plugin_version,
        candidate_enabled: installed.activation.active_version === input.plugin_version
          ? installed.activation.enabled
          : false,
      },
    });
    return {
      installed,
      release,
      attempt,
      staged: installed.activation.active_version !== input.plugin_version || !installed.activation.enabled,
    };
  } catch (cause) {
    const source = getPluginRegistrySource(input.registry_id);
    if (source) {
      recordPluginRegistryAttempt({
        registry_id: input.registry_id,
        operation,
        status: "failed",
        plugin_id: input.plugin_id,
        from_version: before?.active_version,
        to_version: input.plugin_version,
        index_sequence: getPluginRegistryRelease(
          input.registry_id,
          input.plugin_id,
          input.plugin_version,
        )?.index_sequence,
        index_digest: source.last_index_digest,
        rollback_version: before?.active_version,
        error: errorMessage(cause),
        data: { active_version_preserved: before?.active_version ?? null },
      });
    }
    throw cause;
  }
}

function assertInstalledRegistryRelease(
  registryId: string,
  pluginId: string,
  pluginVersion: string,
) {
  const release = getPluginRegistryRelease(registryId, pluginId, pluginVersion);
  if (!release) throw new Error(`Plugin registry release is not catalogued: ${pluginId}@${pluginVersion}`);
  const version = listPluginVersions(pluginId).find((candidate) => candidate.plugin_version === pluginVersion);
  if (
    version?.installation?.channel !== "registry"
    || version.installation.archive_digest !== release.archive_digest
    || version.installation.payload_digest !== release.payload_digest
    || version.installation.signature_state !== "verified"
  ) throw new Error(`Plugin registry release is not installed and verified: ${pluginId}@${pluginVersion}`);
  return release;
}

export function activateRemotePluginRegistryRelease(input: {
  registry_id: string;
  plugin_id: string;
  plugin_version: string;
  expected_revision: number;
  now?: string | Date;
}) {
  const before = getActivePlugin(input.plugin_id)?.activation;
  try {
    return getDb().transaction(() => {
      const source = getPluginRegistrySource(input.registry_id);
      if (!source) throw new Error(`Plugin registry source is not configured: ${input.registry_id}`);
      assertFreshRegistrySource(source, input.now);
      const current = getActivePlugin(input.plugin_id)?.activation;
      if (!current || current.revision !== input.expected_revision) {
        throw new Error("Plugin activation revision conflict before Registry migration");
      }
      const release = assertInstalledRegistryRelease(
        input.registry_id,
        input.plugin_id,
        input.plugin_version,
      );
      const target = listPluginVersions(input.plugin_id)
        .find((candidate) => candidate.plugin_version === input.plugin_version);
      if (!target?.installation) {
        throw new Error(`Plugin registry release is not installed and verified: ${input.plugin_id}@${input.plugin_version}`);
      }
      const declaresMigration = target.descriptor.manifest.kinds.some((kind) => kind.migrations.length > 0)
        || target.descriptor.manifest.state.migrations.length > 0;
      let migration: ReturnType<typeof migrateCanonicalDocumentsAndActivateStagedRegistryPlugin> | undefined;
      let activation: ReturnType<typeof activateInstalledPlugin>;
      if (target.installation.lifecycle_state === "staged") {
        if (current.active_version !== input.plugin_version) {
          assertInstalledRegistryRelease(input.registry_id, input.plugin_id, current.active_version);
        }
        migration = migrateCanonicalDocumentsAndActivateStagedRegistryPlugin({
          plugin_id: input.plugin_id,
          plugin_version: input.plugin_version,
          expected_revision: input.expected_revision,
          timestamp: nowIso(),
        });
        activation = migration.activation;
      } else {
        if (declaresMigration && current.active_version !== input.plugin_version) {
          throw new Error("Registry Kind migration candidate is not staged");
        }
        activation = activateInstalledPlugin(
          input.plugin_id,
          input.plugin_version,
          input.expected_revision,
          { registry_authorized: true },
        );
      }
      const attempt = recordPluginRegistryAttempt({
        registry_id: input.registry_id,
        operation: "activate",
        status: "succeeded",
        plugin_id: input.plugin_id,
        from_version: current.active_version,
        to_version: input.plugin_version,
        index_sequence: release.index_sequence,
        index_digest: source.last_index_digest,
        rollback_version: current.active_version,
        data: {
          enabled: activation.enabled,
          activation_revision: activation.revision,
          ...(migration ? {
            migrated_documents: migration.migrated_documents,
            migrated_nodes: migration.migrated_nodes,
            committed_transactions: migration.committed_transactions,
          } : {}),
        },
      });
      return {
        activation,
        attempt,
        ...(migration ? {
          migration: {
            migrated_documents: migration.migrated_documents,
            migrated_nodes: migration.migrated_nodes,
            committed_transactions: migration.committed_transactions,
          },
        } : {}),
      };
    }).immediate();
  } catch (cause) {
    const preserved = getActivePlugin(input.plugin_id)?.activation;
    if (getPluginRegistrySource(input.registry_id)) {
      recordPluginRegistryAttempt({
        registry_id: input.registry_id,
        operation: "activate",
        status: "failed",
        plugin_id: input.plugin_id,
        from_version: before?.active_version,
        to_version: input.plugin_version,
        rollback_version: preserved?.active_version ?? before?.active_version,
        error: errorMessage(cause),
        data: {
          active_version_preserved: preserved?.active_version ?? null,
          activation_revision_preserved: preserved?.revision ?? null,
        },
      });
    }
    throw cause;
  }
}

export function enableRemotePluginRegistryRelease(input: {
  registry_id: string;
  plugin_id: string;
  expected_revision: number;
  expected_active_version: string;
  now?: string | Date;
}) {
  const before = getActivePlugin(input.plugin_id)?.activation;
  try {
    const source = getPluginRegistrySource(input.registry_id);
    if (!source) throw new Error(`Plugin registry source is not configured: ${input.registry_id}`);
    assertFreshRegistrySource(source, input.now);
    if (!before || before.active_version !== input.expected_active_version) {
      throw new Error("Plugin registry active version changed before enablement");
    }
    const release = assertInstalledRegistryRelease(
      input.registry_id,
      input.plugin_id,
      input.expected_active_version,
    );
    const activation = enableInstalledPlugin(input.plugin_id, true, {
      revision: input.expected_revision,
      active_version: input.expected_active_version,
    }, { registry_authorized: true });
    const attempt = recordPluginRegistryAttempt({
      registry_id: input.registry_id,
      operation: "activate",
      status: "succeeded",
      plugin_id: input.plugin_id,
      from_version: before.active_version,
      to_version: activation.active_version,
      index_sequence: release.index_sequence,
      index_digest: source.last_index_digest,
      data: { enabled: true, activation_revision: activation.revision },
    });
    return { activation, attempt };
  } catch (cause) {
    if (getPluginRegistrySource(input.registry_id)) {
      recordPluginRegistryAttempt({
        registry_id: input.registry_id,
        operation: "activate",
        status: "failed",
        plugin_id: input.plugin_id,
        from_version: before?.active_version,
        to_version: input.expected_active_version,
        error: errorMessage(cause),
      });
    }
    throw cause;
  }
}

export function rollbackRemotePluginRegistryRelease(input: {
  registry_id: string;
  plugin_id: string;
  plugin_version?: string;
  expected_revision: number;
  now?: string | Date;
}) {
  const before = getActivePlugin(input.plugin_id)?.activation;
  try {
    const source = getPluginRegistrySource(input.registry_id);
    if (!source) throw new Error(`Plugin registry source is not configured: ${input.registry_id}`);
    assertFreshRegistrySource(source, input.now);
    if (!before?.active_version) throw new Error(`Plugin is not installed: ${input.plugin_id}`);
    // A Registry rollback is a supply-chain operation, not a generic local
    // activation shortcut. Prove both the current and target versions against
    // this exact signed catalog before changing activation state.
    assertInstalledRegistryRelease(input.registry_id, input.plugin_id, before.active_version);
    const targetVersion = input.plugin_version ?? (() => {
      const transition = [...listPluginRegistryUpdateAttempts(input.registry_id, input.plugin_id)]
        .reverse()
        .find((attempt) => (
          attempt.status === "succeeded"
          && (attempt.operation === "activate" || attempt.operation === "rollback")
          && attempt.to_version === before.active_version
          && typeof attempt.from_version === "string"
          && attempt.from_version !== before.active_version
        ));
      if (!transition?.from_version) {
        throw new Error(`No same-registry rollback target is recorded: ${input.plugin_id}`);
      }
      return transition.from_version;
    })();
    assertInstalledRegistryRelease(input.registry_id, input.plugin_id, targetVersion);
    const activeVersion = listPluginVersions(input.plugin_id)
      .find((candidate) => candidate.plugin_version === before.active_version);
    if (
      targetVersion !== before.active_version
      && activeVersion?.descriptor.manifest.kinds.some((kind) => kind.migrations.length > 0)
    ) {
      throw new Error("Reverse Kind migrations are not implemented and remain fail-closed");
    }
    const activation = rollbackInstalledPlugin(
      input.plugin_id,
      targetVersion,
      input.expected_revision,
      { registry_authorized: true },
    );
    const attempt = recordPluginRegistryAttempt({
      registry_id: input.registry_id,
      operation: "rollback",
      status: "succeeded",
      plugin_id: input.plugin_id,
      from_version: before?.active_version,
      to_version: activation.active_version,
      rollback_version: activation.active_version,
      index_digest: getPluginRegistrySource(input.registry_id)?.last_index_digest,
      data: { enabled: activation.enabled, activation_revision: activation.revision },
    });
    return { activation, attempt };
  } catch (cause) {
    if (getPluginRegistrySource(input.registry_id)) {
      recordPluginRegistryAttempt({
        registry_id: input.registry_id,
        operation: "rollback",
        status: "failed",
        plugin_id: input.plugin_id,
        from_version: before?.active_version,
        to_version: input.plugin_version,
        rollback_version: before?.active_version,
        error: errorMessage(cause),
      });
    }
    throw cause;
  }
}

export function remotePluginRegistryState(registryId?: string) {
  if (registryId) {
    const source = getPluginRegistrySource(registryId);
    if (!source) return undefined;
    return {
      source,
      releases: listPluginRegistryReleases(registryId),
      attempts: listPluginRegistryUpdateAttempts(registryId),
    };
  }
  return listPluginRegistrySources().map((source) => ({
    source,
    releases: listPluginRegistryReleases(source.registry_id),
    attempts: listPluginRegistryUpdateAttempts(source.registry_id),
  }));
}
