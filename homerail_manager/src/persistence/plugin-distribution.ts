import {
  validateHrpPublisherTrustEntry,
  type HrpPublisherTrustEntry,
} from "homerail-plugin-sdk";
import { encodeJson, getDb, parseJsonRow } from "./db.js";
import { revokeInstalledPluginPackagesByPublisherKey } from "./plugins.js";
import { nowIso } from "./time.js";

interface PublisherTrustRow {
  key_id: string;
  publisher: string;
  public_key_spki: string;
  state: "trusted" | "revoked";
  revision: number;
  reason: string | null;
  created_at: string;
  updated_at: string;
}

interface PublisherTrustEventRow {
  seq: number;
  key_id: string;
  publisher: string;
  from_state: "trusted" | "revoked" | null;
  to_state: "trusted" | "revoked";
  trust_revision: number;
  distribution_revision: number;
  actor: string;
  reason: string | null;
  created_at: string;
  data_json: string;
}

export interface PluginPublisherTrustRecord extends HrpPublisherTrustEntry {
  revision: number;
  reason?: string;
  created_at: string;
  updated_at: string;
}

export interface PluginPublisherTrustEvent {
  seq: number;
  key_id: string;
  publisher: string;
  from_state?: "trusted" | "revoked";
  to_state: "trusted" | "revoked";
  trust_revision: number;
  distribution_revision: number;
  actor: string;
  reason?: string;
  created_at: string;
  data: Record<string, unknown>;
}

function decodeTrust(row: PublisherTrustRow): PluginPublisherTrustRecord {
  const entry = validateHrpPublisherTrustEntry({
    key_id: row.key_id,
    publisher: row.publisher,
    public_key_spki: row.public_key_spki,
    state: row.state,
  });
  if (!Number.isSafeInteger(row.revision) || row.revision < 1) {
    throw new Error(`Invalid persisted publisher trust revision: ${row.key_id}`);
  }
  return {
    ...entry,
    revision: row.revision,
    ...(row.reason === null ? {} : { reason: row.reason }),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function assertActor(actor: string): string {
  if (!actor || actor.length > 128 || /[\u0000-\u001f\u007f]/.test(actor)) {
    throw new Error("Publisher trust actor must be 1-128 safe characters");
  }
  return actor;
}

function normalizeReason(reason: string | undefined, required: boolean): string | undefined {
  if (reason === undefined) {
    if (required) throw new Error("Publisher key revocation requires a reason");
    return undefined;
  }
  const normalized = reason.trim();
  if (!normalized || normalized.length > 512 || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new Error("Publisher trust reason must be 1-512 safe characters");
  }
  return normalized;
}

export function getPluginDistributionRevision(): number {
  const row = getDb().prepare(
    "SELECT revision FROM plugin_distribution_meta WHERE singleton = 1",
  ).get() as { revision: number } | undefined;
  if (!row || !Number.isSafeInteger(row.revision) || row.revision < 0) {
    throw new Error("Invalid persisted plugin distribution revision");
  }
  return row.revision;
}

export function listPluginPublisherTrust(): PluginPublisherTrustRecord[] {
  return (getDb().prepare(`
    SELECT key_id, publisher, public_key_spki, state, revision, reason, created_at, updated_at
    FROM plugin_publisher_trust
    ORDER BY publisher, key_id
  `).all() as PublisherTrustRow[]).map(decodeTrust);
}

export function getPluginPublisherTrust(keyId: string): PluginPublisherTrustRecord | undefined {
  const row = getDb().prepare(`
    SELECT key_id, publisher, public_key_spki, state, revision, reason, created_at, updated_at
    FROM plugin_publisher_trust WHERE key_id = ?
  `).get(keyId) as PublisherTrustRow | undefined;
  return row ? decodeTrust(row) : undefined;
}

export function setPluginPublisherTrust(input: {
  entry: HrpPublisherTrustEntry;
  expected_revision?: number;
  actor: string;
  reason?: string;
  data?: Record<string, unknown>;
  timestamp?: string;
}): { record: PluginPublisherTrustRecord; distribution_revision: number; idempotent: boolean } {
  const entry = validateHrpPublisherTrustEntry(input.entry);
  const actor = assertActor(input.actor);
  const reason = normalizeReason(input.reason, entry.state === "revoked");
  if (
    input.expected_revision !== undefined
    && (!Number.isSafeInteger(input.expected_revision) || input.expected_revision < 0)
  ) throw new Error("Publisher trust expected revision must be a non-negative integer");
  const timestamp = input.timestamp ?? nowIso();
  return getDb().transaction(() => {
    const existing = getPluginPublisherTrust(entry.key_id);
    if (existing) {
      if (existing.publisher !== entry.publisher || existing.public_key_spki !== entry.public_key_spki) {
        throw new Error("Publisher trust key identity is immutable");
      }
      if (input.expected_revision !== undefined && input.expected_revision !== existing.revision) {
        throw new Error("Publisher trust revision conflict");
      }
      if (existing.state === "revoked" && entry.state !== "revoked") {
        throw new Error("A revoked publisher key cannot be trusted again");
      }
      if (existing.state === entry.state && existing.reason === reason) {
        return {
          record: existing,
          distribution_revision: getPluginDistributionRevision(),
          idempotent: true,
        };
      }
      const revision = existing.revision + 1;
      getDb().prepare(`
        UPDATE plugin_publisher_trust
        SET state = ?, revision = ?, reason = ?, updated_at = ?
        WHERE key_id = ? AND revision = ?
      `).run(entry.state, revision, reason ?? null, timestamp, entry.key_id, existing.revision);
      const distributionRevision = getPluginDistributionRevision();
      getDb().prepare(`
        INSERT INTO plugin_publisher_trust_events(
          key_id, publisher, from_state, to_state, trust_revision,
          distribution_revision, actor, reason, created_at, data_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        entry.key_id,
        entry.publisher,
        existing.state,
        entry.state,
        revision,
        distributionRevision,
        actor,
        reason ?? null,
        timestamp,
        encodeJson(input.data ?? {}),
      );
      return {
        record: getPluginPublisherTrust(entry.key_id)!,
        distribution_revision: distributionRevision,
        idempotent: false,
      };
    }

    if (input.expected_revision !== undefined && input.expected_revision !== 0) {
      throw new Error("Publisher trust revision conflict");
    }
    getDb().prepare(`
      INSERT INTO plugin_publisher_trust(
        key_id, publisher, public_key_spki, state, revision, reason, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 1, ?, ?, ?)
    `).run(
      entry.key_id,
      entry.publisher,
      entry.public_key_spki,
      entry.state,
      reason ?? null,
      timestamp,
      timestamp,
    );
    const distributionRevision = getPluginDistributionRevision();
    getDb().prepare(`
      INSERT INTO plugin_publisher_trust_events(
        key_id, publisher, from_state, to_state, trust_revision,
        distribution_revision, actor, reason, created_at, data_json
      ) VALUES (?, ?, NULL, ?, 1, ?, ?, ?, ?, ?)
    `).run(
      entry.key_id,
      entry.publisher,
      entry.state,
      distributionRevision,
      actor,
      reason ?? null,
      timestamp,
      encodeJson(input.data ?? {}),
    );
    return {
      record: getPluginPublisherTrust(entry.key_id)!,
      distribution_revision: distributionRevision,
      idempotent: false,
    };
  }).immediate();
}

/**
 * Security-sensitive trust transition used by the administrative API.
 * Better-sqlite3 nests the two persistence helpers as savepoints underneath
 * this outer transaction, so a revocation and every affected activation
 * disable become one crash-atomic commit.
 */
export function setPluginPublisherTrustAndRevokePackages(input: Parameters<typeof setPluginPublisherTrust>[0]): {
  trust: ReturnType<typeof setPluginPublisherTrust>;
  revoked_packages: ReturnType<typeof revokeInstalledPluginPackagesByPublisherKey>;
} {
  return getDb().transaction(() => {
    const trust = setPluginPublisherTrust(input);
    const revokedPackages = input.entry.state === "revoked"
      ? revokeInstalledPluginPackagesByPublisherKey(input.entry.key_id, input.timestamp)
      : [];
    return { trust, revoked_packages: revokedPackages };
  }).immediate();
}

export function listPluginPublisherTrustEvents(keyId?: string): PluginPublisherTrustEvent[] {
  const rows = (keyId
    ? getDb().prepare(`
        SELECT seq, key_id, publisher, from_state, to_state, trust_revision,
               distribution_revision, actor, reason, created_at, data_json
        FROM plugin_publisher_trust_events WHERE key_id = ? ORDER BY seq
      `).all(keyId)
    : getDb().prepare(`
        SELECT seq, key_id, publisher, from_state, to_state, trust_revision,
               distribution_revision, actor, reason, created_at, data_json
        FROM plugin_publisher_trust_events ORDER BY seq
      `).all()) as PublisherTrustEventRow[];
  return rows.map((row) => ({
    seq: row.seq,
    key_id: row.key_id,
    publisher: row.publisher,
    ...(row.from_state === null ? {} : { from_state: row.from_state }),
    to_state: row.to_state,
    trust_revision: row.trust_revision,
    distribution_revision: row.distribution_revision,
    actor: row.actor,
    ...(row.reason === null ? {} : { reason: row.reason }),
    created_at: row.created_at,
    data: parseJsonRow<Record<string, unknown>>(row.data_json),
  }));
}
