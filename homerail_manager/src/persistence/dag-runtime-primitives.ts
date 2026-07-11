import { createHash } from "node:crypto";
import { encodeJson, getDb, parseJsonRow } from "./db.js";

export interface DagApprovalRecord {
  run_id: string;
  node_id: string;
  approval_id: string;
  status: "waiting" | "approved" | "rejected" | "expired";
  proposal_hash: string;
  proposal: unknown;
  proposer_actor: string;
  authorized_actors: string[];
  decision?: string;
  actor?: string;
  created_at: number;
  updated_at: number;
  expires_at?: number;
}

export interface DagStateRecord {
  namespace: string;
  key: string;
  version: number;
  value: unknown;
  updated_at: number;
}

function approvalFromRow(row: Record<string, unknown>): DagApprovalRecord {
  return {
    run_id: String(row.run_id),
    node_id: String(row.node_id),
    approval_id: String(row.approval_id),
    status: String(row.status) as DagApprovalRecord["status"],
    proposal_hash: String(row.proposal_hash),
    proposal: parseJsonRow(String(row.proposal_json)),
    proposer_actor: String(row.proposer_actor ?? ""),
    authorized_actors: parseJsonRow<string[]>(String(row.authorized_actors)),
    ...(row.decision ? { decision: String(row.decision) } : {}),
    ...(row.actor ? { actor: String(row.actor) } : {}),
    created_at: Number(row.created_at),
    updated_at: Number(row.updated_at),
    ...(row.expires_at === null || row.expires_at === undefined ? {} : { expires_at: Number(row.expires_at) }),
  };
}

export function createPendingApproval(input: {
  runId: string;
  nodeId: string;
  approvalId: string;
  proposal: unknown;
  proposerActor: string;
  authorizedActors: string[];
  expiresAfterMs?: number;
}): DagApprovalRecord {
  const now = Date.now();
  const proposalJson = encodeJson(input.proposal ?? null);
  const proposalHash = createHash("sha256").update(proposalJson).digest("hex");
  const expiresAt = input.expiresAfterMs ? now + input.expiresAfterMs : undefined;
  return getDb().transaction(() => {
    const existing = getApproval(input.runId, input.nodeId);
    if (existing?.status === "approved" || existing?.status === "rejected") {
      throw new Error(`approval decision is immutable: already ${existing.status}`);
    }
    getDb().prepare(`
      INSERT INTO dag_approvals(
        run_id, node_id, approval_id, status, proposal_hash, proposal_json,
        proposer_actor, authorized_actors, created_at, updated_at, expires_at
      ) VALUES (?, ?, ?, 'waiting', ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(run_id, node_id) DO UPDATE SET
        approval_id = excluded.approval_id,
        status = 'waiting',
        proposal_hash = excluded.proposal_hash,
        proposal_json = excluded.proposal_json,
        proposer_actor = excluded.proposer_actor,
        authorized_actors = excluded.authorized_actors,
        decision = NULL,
        actor = NULL,
        updated_at = excluded.updated_at,
        expires_at = excluded.expires_at
    `).run(
      input.runId,
      input.nodeId,
      input.approvalId,
      proposalHash,
      proposalJson,
      input.proposerActor,
      encodeJson(input.authorizedActors),
      now,
      now,
      expiresAt ?? null,
    );
    return getApproval(input.runId, input.nodeId)!;
  })();
}

export function getApproval(runId: string, nodeId: string): DagApprovalRecord | undefined {
  const row = getDb().prepare("SELECT * FROM dag_approvals WHERE run_id = ? AND node_id = ?").get(runId, nodeId) as Record<string, unknown> | undefined;
  return row ? approvalFromRow(row) : undefined;
}

export function listPendingApprovals(): DagApprovalRecord[] {
  return (getDb().prepare("SELECT * FROM dag_approvals WHERE status = 'waiting' ORDER BY created_at").all() as Record<string, unknown>[])
    .map(approvalFromRow);
}

export function expirePendingApprovals(now = Date.now()): DagApprovalRecord[] {
  return getDb().transaction(() => {
    const expired = (getDb().prepare(`
      SELECT * FROM dag_approvals
      WHERE status = 'waiting' AND expires_at IS NOT NULL AND expires_at <= ?
      ORDER BY expires_at
    `).all(now) as Record<string, unknown>[]).map(approvalFromRow);
    if (expired.length > 0) {
      getDb().prepare(`
        UPDATE dag_approvals SET status = 'expired', decision = 'rejected', actor = 'system:expiry', updated_at = ?
        WHERE status = 'waiting' AND expires_at IS NOT NULL AND expires_at <= ?
      `).run(now, now);
    }
    return expired.map((record) => ({
      ...record,
      status: "expired" as const,
      decision: "rejected",
      actor: "system:expiry",
      updated_at: now,
    }));
  })();
}

export function decideApproval(input: {
  runId: string;
  nodeId: string;
  decision: "approved" | "rejected";
  actor: string;
  proposalHash: string;
}): DagApprovalRecord {
  const result = getDb().transaction((): DagApprovalRecord | "expired" => {
    const current = getApproval(input.runId, input.nodeId);
    if (!current) throw new Error("approval not found");
    if (current.status !== "waiting") throw new Error(`approval is already ${current.status}`);
    if (current.expires_at !== undefined && current.expires_at <= Date.now()) {
      getDb().prepare("UPDATE dag_approvals SET status = 'expired', updated_at = ? WHERE run_id = ? AND node_id = ?")
        .run(Date.now(), input.runId, input.nodeId);
      return "expired";
    }
    if (!current.proposer_actor.trim()) throw new Error("approval proposer identity is unavailable; recreate approval");
    if (!current.authorized_actors.includes(input.actor)) throw new Error(`actor '${input.actor}' is not authorized`);
    if (current.proposer_actor === input.actor) throw new Error(`proposer actor '${input.actor}' cannot approve its own proposal`);
    if (current.proposal_hash !== input.proposalHash) throw new Error("proposal hash mismatch");
    const now = Date.now();
    getDb().prepare(`
      UPDATE dag_approvals SET status = ?, decision = ?, actor = ?, updated_at = ?
      WHERE run_id = ? AND node_id = ? AND status = 'waiting'
    `).run(input.decision, input.decision, input.actor, now, input.runId, input.nodeId);
    return getApproval(input.runId, input.nodeId)!;
  })();
  if (result === "expired") throw new Error("approval expired");
  return result;
}

export function getDagState(namespace: string, key: string): DagStateRecord | undefined {
  const row = getDb().prepare("SELECT * FROM dag_state_records WHERE namespace = ? AND state_key = ?").get(namespace, key) as Record<string, unknown> | undefined;
  if (!row) return undefined;
  return {
    namespace: String(row.namespace),
    key: String(row.state_key),
    version: Number(row.version),
    value: parseJsonRow(String(row.value_json)),
    updated_at: Number(row.updated_at),
  };
}

export function updateDagState(input: {
  namespace: string;
  key: string;
  value: unknown;
  expectedVersion?: number;
  runId?: string;
  nodeId?: string;
}): { updated: boolean; record: DagStateRecord; previous?: DagStateRecord } {
  return mutateDagState(input, () => input.value);
}

type DagStateMutationInput = {
  namespace: string;
  key: string;
  expectedVersion?: number;
  runId?: string;
  nodeId?: string;
};

function writeDagState(
  input: DagStateMutationInput,
  before: DagStateRecord | undefined,
  value: unknown,
): { updated: true; record: DagStateRecord; previous?: DagStateRecord } {
  const version = (before?.version ?? 0) + 1;
  const now = Date.now();
  const valueJson = encodeJson(value ?? null);
  getDb().prepare(`
    INSERT INTO dag_state_records(namespace, state_key, version, value_json, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(namespace, state_key) DO UPDATE SET
      version = excluded.version, value_json = excluded.value_json, updated_at = excluded.updated_at
  `).run(input.namespace, input.key, version, valueJson, now);
  getDb().prepare(`
    INSERT INTO dag_state_history(namespace, state_key, before_json, after_json, version, run_id, node_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(input.namespace, input.key, before ? encodeJson(before.value) : null, valueJson, version, input.runId ?? null, input.nodeId ?? null, now);
  return {
    updated: true,
    record: getDagState(input.namespace, input.key)!,
    ...(before ? { previous: before } : {}),
  };
}

export function mutateDagState(
  input: DagStateMutationInput,
  mutate: (current: DagStateRecord | undefined) => unknown,
): { updated: boolean; record: DagStateRecord; previous?: DagStateRecord } {
  return getDb().transaction(() => {
    const before = getDagState(input.namespace, input.key);
    if (input.expectedVersion !== undefined && (before?.version ?? 0) !== input.expectedVersion) {
      return {
        updated: false,
        record: before ?? { namespace: input.namespace, key: input.key, version: 0, value: null, updated_at: 0 },
        ...(before ? { previous: before } : {}),
      };
    }
    return writeDagState(input, before, mutate(before));
  })();
}

export function reserveDagBudget(input: DagStateMutationInput & {
  amount: number;
  limit: number;
  usageField?: string;
}): {
  admitted: boolean;
  spent: number;
  requested: number;
  remaining: number;
  record?: DagStateRecord;
  previous?: DagStateRecord;
} {
  return getDb().transaction(() => {
    const before = getDagState(input.namespace, input.key);
    const fieldParts = input.usageField?.split(".").filter(Boolean) ?? [];
    let selected: unknown = before?.value;
    for (const part of fieldParts) {
      selected = selected && typeof selected === "object" && !Array.isArray(selected)
        ? (selected as Record<string, unknown>)[part]
        : undefined;
    }
    const spent = typeof selected === "number" && Number.isFinite(selected) ? selected : 0;
    const requested = input.amount;
    const admitted = Number.isFinite(requested) && requested > 0 && spent + requested <= input.limit;
    if (!admitted) {
      return {
        admitted: false,
        spent,
        requested,
        remaining: input.limit - spent,
        ...(before ? { record: before, previous: before } : {}),
      };
    }
    let nextValue: unknown = spent + requested;
    if (fieldParts.length > 0) {
      const root = before?.value && typeof before.value === "object" && !Array.isArray(before.value)
        ? structuredClone(before.value as Record<string, unknown>)
        : {};
      let target = root;
      for (const part of fieldParts.slice(0, -1)) {
        const nested = target[part];
        target[part] = nested && typeof nested === "object" && !Array.isArray(nested) ? nested : {};
        target = target[part] as Record<string, unknown>;
      }
      target[fieldParts.at(-1)!] = spent + requested;
      nextValue = root;
    }
    const updated = writeDagState(input, before, nextValue);
    return {
      admitted: true,
      spent: spent + requested,
      requested,
      remaining: input.limit - spent - requested,
      record: updated.record,
      ...(updated.previous ? { previous: updated.previous } : {}),
    };
  })();
}
