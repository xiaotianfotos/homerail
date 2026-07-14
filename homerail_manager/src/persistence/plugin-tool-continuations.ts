import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { GenerativeUiDocumentScopeV1 } from "homerail-protocol";
import { pluginJsonDigest } from "../plugins/descriptor.js";
import {
  getPluginToolConfirmationForRequest,
  getPluginToolRequest,
  type PluginToolRequestRecord,
  type PluginToolRequestStatus,
} from "./plugin-actions.js";
import { encodeJson, getDb, parseJsonRow } from "./db.js";
import { nowIso } from "./time.js";

const TERMINAL = new Set<PluginToolRequestStatus>(["committed", "denied", "failed", "cancelled"]);
const DEFAULT_LEASE_MS = 2 * 60_000;

export interface PluginAgentToolContinuationV1 {
  continuation_version: 1;
  request_id: string;
  request_digest: string;
  call_id: string;
  plugin: { id: string; version: string };
  tool: { local_id: string; qualified_id: string; wire_id: string };
  status: "committed" | "denied" | "failed" | "cancelled";
  confirmation: "approved" | "denied" | "expired";
  result?: Record<string, unknown>;
  error?: { code: string; message: string };
  completed_at: string;
}

interface ContinuationRow {
  request_id: string;
  scope_type: GenerativeUiDocumentScopeV1["type"];
  scope_id: string;
  call_id: string;
  status: "pending" | "leased" | "delivered";
  payload_json: string;
  lease_id: string | null;
  lease_expires_at: string | null;
  delivery_attempts: number;
  created_at: string;
  delivered_at: string | null;
}

export interface PluginAgentToolContinuationRecord {
  scope: GenerativeUiDocumentScopeV1;
  status: ContinuationRow["status"];
  payload: PluginAgentToolContinuationV1;
  lease_id?: string;
  lease_expires_at?: string;
  delivery_attempts: number;
  created_at: string;
  delivered_at?: string;
}

function decodePayload(value: unknown, row: ContinuationRow): PluginAgentToolContinuationV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Invalid Agent Tool continuation payload: ${row.request_id}`);
  }
  const payload = value as PluginAgentToolContinuationV1;
  if (
    payload.continuation_version !== 1
    || payload.request_id !== row.request_id
    || payload.call_id !== row.call_id
    || !/^[a-f0-9]{64}$/.test(payload.request_digest)
    || !TERMINAL.has(payload.status)
    || !["approved", "denied", "expired"].includes(payload.confirmation)
  ) throw new Error(`Invalid Agent Tool continuation identity: ${row.request_id}`);
  pluginJsonDigest(payload, 128 * 1024);
  return structuredClone(payload);
}

function decodeRow(row: ContinuationRow): PluginAgentToolContinuationRecord {
  if (!Number.isSafeInteger(row.delivery_attempts) || row.delivery_attempts < 0) {
    throw new Error(`Invalid Agent Tool continuation delivery count: ${row.request_id}`);
  }
  if (
    (row.status === "pending" && (row.lease_id !== null || row.lease_expires_at !== null || row.delivered_at !== null))
    || (row.status === "leased" && (!row.lease_id || !row.lease_expires_at || row.delivered_at !== null))
    || (row.status === "delivered" && (row.lease_id !== null || row.lease_expires_at !== null || !row.delivered_at))
  ) throw new Error(`Invalid Agent Tool continuation state: ${row.request_id}`);
  return {
    scope: { type: row.scope_type, id: row.scope_id },
    status: row.status,
    payload: decodePayload(parseJsonRow<unknown>(row.payload_json), row),
    ...(row.lease_id ? { lease_id: row.lease_id } : {}),
    ...(row.lease_expires_at ? { lease_expires_at: row.lease_expires_at } : {}),
    delivery_attempts: row.delivery_attempts,
    created_at: row.created_at,
    ...(row.delivered_at ? { delivered_at: row.delivered_at } : {}),
  };
}

function continuationRow(requestId: string): ContinuationRow | undefined {
  return getDb().prepare(`
    SELECT request_id, scope_type, scope_id, call_id, status, payload_json,
           lease_id, lease_expires_at, delivery_attempts, created_at, delivered_at
    FROM plugin_agent_tool_continuations WHERE request_id = ?
  `).get(requestId) as ContinuationRow | undefined;
}

function terminalPayload(request: PluginToolRequestRecord): PluginAgentToolContinuationV1 {
  if (request.invocation.source.type !== "agent" || !TERMINAL.has(request.status)) {
    throw new Error("Only terminal Agent-origin Tool requests can create continuations");
  }
  const confirmation = getPluginToolConfirmationForRequest(request.request_id);
  if (!confirmation) throw new Error("Agent Tool continuation requires a persisted confirmation");
  const outcome = confirmation.decision?.decision
    ?? (confirmation.status === "expired" ? "expired" : undefined);
  if (!outcome) throw new Error("Agent Tool continuation confirmation is not terminal");
  const source = request.invocation.source;
  return {
    continuation_version: 1,
    request_id: request.request_id,
    request_digest: request.request_digest,
    call_id: source.call_id,
    plugin: { id: request.plugin_id, version: request.plugin_version },
    tool: structuredClone(request.invocation.tool),
    status: request.status as PluginAgentToolContinuationV1["status"],
    confirmation: outcome,
    ...(request.result ? { result: structuredClone(request.result) } : {}),
    ...(request.error_code || request.error_message ? {
      error: {
        code: request.error_code ?? "tool_failed",
        message: request.error_message ?? "Plugin Tool failed",
      },
    } : {}),
    completed_at: request.updated_at,
  };
}

export function enqueuePluginAgentToolContinuation(
  requestValue: string | PluginToolRequestRecord,
): { record: PluginAgentToolContinuationRecord; idempotent: boolean } {
  const request = typeof requestValue === "string" ? getPluginToolRequest(requestValue) : requestValue;
  if (!request) throw new Error("Plugin Tool request does not exist");
  const payload = terminalPayload(request);
  const source = request.invocation.source;
  if (source.type !== "agent") throw new Error("Plugin Tool continuation source is invalid");
  return getDb().transaction(() => {
    const existing = continuationRow(request.request_id);
    if (existing) {
      const decoded = decodeRow(existing);
      if (!isDeepStrictEqual(decoded.payload, payload)) {
        throw new Error("Plugin Tool continuation identity collision");
      }
      return { record: decoded, idempotent: true };
    }
    getDb().prepare(`
      INSERT INTO plugin_agent_tool_continuations(
        request_id, scope_type, scope_id, call_id, status, payload_json,
        lease_id, lease_expires_at, delivery_attempts, created_at, delivered_at
      ) VALUES (?, ?, ?, ?, 'pending', ?, NULL, NULL, 0, ?, NULL)
    `).run(
      request.request_id,
      source.scope.type,
      source.scope.id,
      source.call_id,
      encodeJson(payload),
      request.updated_at,
    );
    return { record: decodeRow(continuationRow(request.request_id)!), idempotent: false };
  }).immediate();
}

export function leasePluginAgentToolContinuations(input: {
  scope: GenerativeUiDocumentScopeV1;
  now?: Date;
  lease_ms?: number;
  limit?: number;
}): { lease_id?: string; records: PluginAgentToolContinuationRecord[] } {
  const now = input.now ?? new Date();
  const leaseMs = input.lease_ms ?? DEFAULT_LEASE_MS;
  const limit = input.limit ?? 16;
  if (!Number.isSafeInteger(leaseMs) || leaseMs < 1_000 || leaseMs > 10 * 60_000) {
    throw new Error("Agent Tool continuation lease duration is invalid");
  }
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 32) {
    throw new Error("Agent Tool continuation lease limit is invalid");
  }
  return getDb().transaction(() => {
    getDb().prepare(`
      UPDATE plugin_agent_tool_continuations
      SET status = 'pending', lease_id = NULL, lease_expires_at = NULL
      WHERE status = 'leased' AND lease_expires_at <= ?
    `).run(now.toISOString());
    const candidates = getDb().prepare(`
      SELECT request_id FROM plugin_agent_tool_continuations
      WHERE scope_type = ? AND scope_id = ? AND status = 'pending'
      ORDER BY created_at, request_id LIMIT ?
    `).all(input.scope.type, input.scope.id, limit) as Array<{ request_id: string }>;
    if (!candidates.length) return { records: [] };
    const leaseId = `continuation_${randomUUID().replace(/-/g, "")}`;
    const expiresAt = new Date(now.getTime() + leaseMs).toISOString();
    for (const candidate of candidates) {
      const updated = getDb().prepare(`
        UPDATE plugin_agent_tool_continuations
        SET status = 'leased', lease_id = ?, lease_expires_at = ?,
            delivery_attempts = delivery_attempts + 1
        WHERE request_id = ? AND status = 'pending'
      `).run(leaseId, expiresAt, candidate.request_id);
      if (updated.changes !== 1) throw new Error("Agent Tool continuation lease conflict");
    }
    return {
      lease_id: leaseId,
      records: candidates.map((candidate) => decodeRow(continuationRow(candidate.request_id)!)),
    };
  }).immediate();
}

export function acknowledgePluginAgentToolContinuationLease(leaseId: string, deliveredAt = nowIso()): number {
  if (!/^continuation_[a-f0-9]{32}$/.test(leaseId)) throw new Error("Agent Tool continuation lease id is invalid");
  return getDb().transaction(() => getDb().prepare(`
    UPDATE plugin_agent_tool_continuations
    SET status = 'delivered', lease_id = NULL, lease_expires_at = NULL, delivered_at = ?
    WHERE status = 'leased' AND lease_id = ?
  `).run(deliveredAt, leaseId).changes).immediate();
}

export function releasePluginAgentToolContinuationLease(leaseId: string): number {
  if (!/^continuation_[a-f0-9]{32}$/.test(leaseId)) throw new Error("Agent Tool continuation lease id is invalid");
  return getDb().transaction(() => getDb().prepare(`
    UPDATE plugin_agent_tool_continuations
    SET status = 'pending', lease_id = NULL, lease_expires_at = NULL
    WHERE status = 'leased' AND lease_id = ?
  `).run(leaseId).changes).immediate();
}

export function listPluginAgentToolContinuations(
  scope?: GenerativeUiDocumentScopeV1,
): PluginAgentToolContinuationRecord[] {
  const rows = (scope
    ? getDb().prepare(`
        SELECT request_id, scope_type, scope_id, call_id, status, payload_json,
               lease_id, lease_expires_at, delivery_attempts, created_at, delivered_at
        FROM plugin_agent_tool_continuations
        WHERE scope_type = ? AND scope_id = ? ORDER BY created_at, request_id
      `).all(scope.type, scope.id)
    : getDb().prepare(`
        SELECT request_id, scope_type, scope_id, call_id, status, payload_json,
               lease_id, lease_expires_at, delivery_attempts, created_at, delivered_at
        FROM plugin_agent_tool_continuations ORDER BY created_at, request_id
      `).all()) as ContinuationRow[];
  return rows.map(decodeRow);
}
