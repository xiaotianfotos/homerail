import { createHash } from "node:crypto";
import { encodeJson, getDb, parseJsonRow } from "./db.js";

export interface DagTriggerConfig {
  type: "interval" | "event";
  every_ms?: number;
  event?: string;
  overlap: "skip" | "allow";
  max_concurrency: number;
  enabled: boolean;
}

export interface DagTriggerRecord {
  trigger_key: string;
  workflow_id: string;
  trigger_id: string;
  config: DagTriggerConfig;
  enabled: boolean;
  next_fire_at?: number;
  updated_at: number;
}

function fromRow(row: Record<string, unknown>): DagTriggerRecord {
  return {
    trigger_key: String(row.trigger_key),
    workflow_id: String(row.workflow_id),
    trigger_id: String(row.trigger_id),
    config: parseJsonRow<DagTriggerConfig>(String(row.config_json)),
    enabled: Number(row.enabled) === 1,
    ...(row.next_fire_at === null || row.next_fire_at === undefined ? {} : { next_fire_at: Number(row.next_fire_at) }),
    updated_at: Number(row.updated_at),
  };
}

export function syncDagTriggers(workflowId: string, triggers: Record<string, DagTriggerConfig>): void {
  getDb().transaction(() => {
    const ids = Object.keys(triggers);
    if (ids.length === 0) {
      getDb().prepare("DELETE FROM dag_triggers WHERE workflow_id = ?").run(workflowId);
      return;
    }
    const placeholders = ids.map(() => "?").join(",");
    getDb().prepare(`DELETE FROM dag_triggers WHERE workflow_id = ? AND trigger_id NOT IN (${placeholders})`).run(workflowId, ...ids);
    const now = Date.now();
    for (const [id, config] of Object.entries(triggers)) {
      const key = `${workflowId}:${id}`;
      const existing = getDb().prepare("SELECT next_fire_at FROM dag_triggers WHERE trigger_key = ?").get(key) as { next_fire_at?: number } | undefined;
      const nextFireAt = config.type === "interval"
        ? existing?.next_fire_at ?? now + (config.every_ms ?? 1_000)
        : null;
      getDb().prepare(`
        INSERT INTO dag_triggers(trigger_key, workflow_id, trigger_id, type, config_json, enabled, next_fire_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(trigger_key) DO UPDATE SET
          type = excluded.type, config_json = excluded.config_json, enabled = excluded.enabled,
          next_fire_at = excluded.next_fire_at, updated_at = excluded.updated_at
      `).run(key, workflowId, id, config.type, encodeJson(config), config.enabled ? 1 : 0, nextFireAt, now);
    }
  })();
}

export function listDagTriggers(): DagTriggerRecord[] {
  return (getDb().prepare("SELECT * FROM dag_triggers ORDER BY workflow_id, trigger_id").all() as Record<string, unknown>[]).map(fromRow);
}

export function dueIntervalTriggers(now = Date.now()): DagTriggerRecord[] {
  return (getDb().prepare("SELECT * FROM dag_triggers WHERE enabled = 1 AND type = 'interval' AND next_fire_at <= ? ORDER BY next_fire_at").all(now) as Record<string, unknown>[]).map(fromRow);
}

export function eventTriggers(eventName: string): DagTriggerRecord[] {
  return listDagTriggers().filter((record) => record.enabled && record.config.type === "event" && record.config.event === eventName);
}

export function claimTriggerDelivery(record: DagTriggerRecord, fireKey: string, payload: unknown): { claimed: boolean; reason?: string } {
  return getDb().transaction(() => {
    const activeCount = (getDb().prepare("SELECT COUNT(*) AS count FROM dag_runs WHERE workflow_id = ? AND status = 'active'").get(record.workflow_id) as { count: number }).count;
    if (record.config.overlap === "skip" && activeCount > 0) return { claimed: false, reason: "overlap_policy" };
    if (activeCount >= record.config.max_concurrency) return { claimed: false, reason: "max_concurrency" };
    const deliveryKey = createHash("sha256").update(`${record.trigger_key}\0${fireKey}`).digest("hex");
    const now = Date.now();
    const inserted = getDb().prepare(`
      INSERT OR IGNORE INTO dag_trigger_deliveries(
        delivery_key, trigger_key, fire_key, status, payload_json, created_at, updated_at
      ) VALUES (?, ?, ?, 'claimed', ?, ?, ?)
    `).run(deliveryKey, record.trigger_key, fireKey, encodeJson(payload), now, now);
    return inserted.changes === 1 ? { claimed: true } : { claimed: false, reason: "duplicate" };
  })();
}

export function completeTriggerDelivery(record: DagTriggerRecord, fireKey: string, runId: string): void {
  const deliveryKey = createHash("sha256").update(`${record.trigger_key}\0${fireKey}`).digest("hex");
  const now = Date.now();
  getDb().transaction(() => {
    getDb().prepare("UPDATE dag_trigger_deliveries SET status = 'dispatched', run_id = ?, updated_at = ? WHERE delivery_key = ?")
      .run(runId, now, deliveryKey);
    if (record.config.type === "interval") {
      getDb().prepare("UPDATE dag_triggers SET next_fire_at = ?, updated_at = ? WHERE trigger_key = ?")
        .run(now + (record.config.every_ms ?? 1_000), now, record.trigger_key);
    }
  })();
}

export function releaseTriggerDelivery(record: DagTriggerRecord, fireKey: string, reason: string): void {
  const deliveryKey = createHash("sha256").update(`${record.trigger_key}\0${fireKey}`).digest("hex");
  getDb().prepare("UPDATE dag_trigger_deliveries SET status = ?, updated_at = ? WHERE delivery_key = ?")
    .run(`failed:${reason}`.slice(0, 256), Date.now(), deliveryKey);
}

export function deferIntervalTrigger(record: DagTriggerRecord): void {
  if (record.config.type !== "interval") return;
  const now = Date.now();
  getDb().prepare("UPDATE dag_triggers SET next_fire_at = ?, updated_at = ? WHERE trigger_key = ?")
    .run(now + (record.config.every_ms ?? 1_000), now, record.trigger_key);
}
