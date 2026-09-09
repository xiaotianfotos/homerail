import { createHash } from "node:crypto";
import { getDb } from "../persistence/db.js";
import { loadRunMetadata, loadRunSnapshot } from "../persistence/store.js";
import type { PersistedRunMetadata } from "../persistence/types.js";
import { findDispatchTarget } from "../orchestration/dispatch-tracker.js";
import { observeDurableCommand, type DurableCommandRecord } from "./durable-command.js";

export interface DispatchRecoveryRecord {
  run_id: string; node_id: string; reason: string; before_json: string; failed_sha256: string;
  request_json: string | null; receipt_json: string | null;
}
export interface DispatchRecoveryRequest {
  request_id: string;
  expected_state_sha256: string;
  clear_reasoning_effort_for: string[];
  reason: string;
}
export interface DispatchRecoveryReceipt {
  run_id: string; node_id: string; request_id: string; recovered_at: number;
  previous_state_sha256: string; resumed_state_sha256: string;
  round_id: string; preserved_nodes: string[]; changed_agents: string[];
}
export function recoveryDigest(value: unknown): string {
  const sorted = (v: any): any => Array.isArray(v) ? v.map(sorted)
    : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map(k => [k, sorted(v[k])])) : v;
  return createHash("sha256").update(JSON.stringify(sorted(value))).digest("hex");
}
export function getDispatchRecovery(runId: string): DispatchRecoveryRecord | undefined {
  return getDb().prepare("SELECT * FROM dag_dispatch_recoveries WHERE run_id = ?").get(runId) as DispatchRecoveryRecord | undefined;
}

/** Deliberately narrow: no Worker may ever have acquired a lease, provisioned,
 * sent a message or executed. A missing usage report is not execution proof. */
export function assertNoWorkerExecution(metadata: PersistedRunMetadata): void {
  if (!metadata.graph || metadata.counters?.dispatches !== 0 || Object.keys(metadata.counters.dispatch_retries).length) {
    throw new Error("Recovery requires zero Worker dispatch attempts");
  }
  const db = getDb();
  for (const table of ["dag_actor_provisioned_workers", "dag_actor_checkpoints", "dag_actor_commands", "dag_actor_live_commands", "dag_actor_interventions"]) {
    if (db.prepare(`SELECT 1 FROM ${table} WHERE run_id = ? LIMIT 1`).get(metadata.runId)) {
      throw new Error(`Recovery cannot replay existing ${table}`);
    }
  }
  if (db.prepare("SELECT 1 FROM dag_actor_runtimes WHERE run_id = ? AND (lease_generation != 0 OR target_id IS NOT NULL OR state = 'leased')").get(metadata.runId)) {
    throw new Error("Recovery cannot replay a previously leased actor");
  }
  const actors = metadata.graph.nodes.filter(node => !node.node_type?.endsWith("_gateway"));
  const snapshot = loadRunSnapshot(metadata.runId)!;
  const workerEvents = new Set(["dag:node_dispatched", "dag:ws_dispatched", "dag:provisioning_requested", "dag:actor_lease_acquired", "dag:message_sent"]);
  if (snapshot.events.some(event => workerEvents.has(event.type))) throw new Error("Recovery found Worker dispatch evidence");
  for (const node of actors) {
    if (findDispatchTarget(metadata.runId, node.node_id) || snapshot.chats[node.node_id]?.length
      || snapshot.usages?.some(usage => usage.nodeId === node.node_id)
      || snapshot.handoffs.some(handoff => handoff.fromNode === node.node_id)) {
      throw new Error(`Recovery found execution evidence for ${node.node_id}`);
    }
  }
  // Finished commands remain completed only if their original executor receipt
  // still verifies. No observer/command is launched by this inspection.
  const commands = db.prepare("SELECT * FROM dag_durable_commands WHERE run_id = ?").all(metadata.runId) as DurableCommandRecord[];
  for (const command of commands) {
    const result = observeDurableCommand(command);
    const identity = JSON.parse(command.identity_json);
    if (!command.consumed || result.status !== "finished" || result.receipt_digest !== command.receipt_digest
      || metadata.nodeStates[identity.node_id] !== "COMPLETED") throw new Error("Recovery found uncertain native command execution");
  }
}

export function recordDispatchRecovery(before: PersistedRunMetadata, nodeId: string, reason: string): void {
  const failed = loadRunMetadata(before.runId)!;
  // Existing records are immutable; this first version permits one repair of a
  // zero-dispatch root, never a generic reset/retry of already running work.
  if (failed.status !== "failed" || getDispatchRecovery(before.runId)) return;
  assertNoWorkerExecution(failed);
  getDb().prepare(`INSERT INTO dag_dispatch_recoveries(run_id, node_id, reason, before_json, failed_sha256)
    VALUES (?, ?, ?, ?, ?)`).run(before.runId, nodeId, reason, JSON.stringify(before), recoveryDigest(failed));
}

export function parseDispatchRecoveryRequest(value: unknown): DispatchRecoveryRequest {
  const v = value as DispatchRecoveryRequest;
  if (!v || typeof v !== "object" || Array.isArray(v)
    || Object.keys(v).some(k => !["request_id", "expected_state_sha256", "clear_reasoning_effort_for", "reason"].includes(k))
    || typeof v.request_id !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(v.request_id)
    || typeof v.expected_state_sha256 !== "string" || !/^[a-f0-9]{64}$/.test(v.expected_state_sha256)
    || typeof v.reason !== "string" || !v.reason.trim() || v.reason.length > 2000
    || !Array.isArray(v.clear_reasoning_effort_for) || v.clear_reasoning_effort_for.length < 1 || v.clear_reasoning_effort_for.length > 64
    || v.clear_reasoning_effort_for.some(id => typeof id !== "string" || !id || id.length > 256)
    || new Set(v.clear_reasoning_effort_for).size !== v.clear_reasoning_effort_for.length) throw new Error("Invalid pre-dispatch recovery request");
  return { ...v, clear_reasoning_effort_for: [...v.clear_reasoning_effort_for].sort() };
}

export function inspectDispatchRecovery(runId: string) {
  const record = getDispatchRecovery(runId);
  if (!record) throw new Error("No durable pre-dispatch recovery checkpoint; legacy failures require separate verified migration");
  return { run_id: runId, node_id: record.node_id, failure: record.reason,
    expected_state_sha256: record.failed_sha256,
    ...(record.receipt_json ? { receipt: JSON.parse(record.receipt_json) as DispatchRecoveryReceipt } : {}) };
}
