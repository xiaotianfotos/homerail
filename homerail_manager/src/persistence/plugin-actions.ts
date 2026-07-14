import {
  homerailPluginToolInvocationDigestInput,
  validateHomerailPluginToolConfirmationChallenge,
  validateHomerailPluginToolConfirmationDecision,
  validateHomerailPluginToolInvocation,
  type HomerailPluginToolConfirmationChallengeV1,
  type HomerailPluginToolConfirmationDecisionV1,
  type HomerailPluginToolInvocationV1,
} from "homerail-protocol";
import { pluginJsonDigest } from "../plugins/descriptor.js";
import { encodeJson, getDb, parseJsonRow } from "./db.js";
import { nowIso } from "./time.js";

export type PluginToolRequestStatus =
  | "needs_grant"
  | "awaiting_confirmation"
  | "authorized"
  | "running"
  | "committed"
  | "denied"
  | "failed"
  | "cancelled";

export type PluginToolEventType =
  | "requested"
  | "needs_grant"
  | "confirmation_issued"
  | "confirmed"
  | "denied"
  | "authorized"
  | "running"
  | "committed"
  | "failed"
  | "cancelled"
  | "duplicate";

interface PluginToolRequestRow {
  request_id: string;
  idempotency_key: string;
  request_digest: string;
  plugin_id: string;
  plugin_version: string;
  source_type: "ui_action" | "agent";
  document_id: string;
  document_revision: number;
  node_id: string | null;
  node_revision: number | null;
  action_id: string | null;
  action_intent: string | null;
  tool_id: string;
  tool_wire_id: string;
  status: PluginToolRequestStatus;
  policy_digest: string;
  permission_revision: number;
  invocation_json: string;
  result_json: string | null;
  error_code: string | null;
  error_message: string | null;
  created_at: string;
  updated_at: string;
}

export interface PluginToolRequestRecord {
  request_id: string;
  idempotency_key: string;
  request_digest: string;
  plugin_id: string;
  plugin_version: string;
  status: PluginToolRequestStatus;
  policy_digest: string;
  permission_revision: number;
  invocation: HomerailPluginToolInvocationV1;
  result?: Record<string, unknown>;
  error_code?: string;
  error_message?: string;
  created_at: string;
  updated_at: string;
}

export interface PluginToolEventRecord {
  seq: number;
  request_id: string;
  request_digest: string;
  event_type: PluginToolEventType;
  created_at: string;
  data: Record<string, unknown>;
}

const transitions: Readonly<Record<PluginToolRequestStatus, ReadonlySet<PluginToolRequestStatus>>> = {
  needs_grant: new Set(["awaiting_confirmation", "authorized", "denied", "failed", "cancelled"]),
  awaiting_confirmation: new Set(["authorized", "denied", "failed", "cancelled"]),
  authorized: new Set(["running", "committed", "failed", "cancelled"]),
  running: new Set(["committed", "failed", "cancelled"]),
  committed: new Set(),
  denied: new Set(),
  // Only attested Runtime reconciliation may use failed -> committed; the
  // service additionally requires error_code=runtime_indeterminate.
  failed: new Set(["committed"]),
  cancelled: new Set(),
};

function decodeRequest(row: PluginToolRequestRow): PluginToolRequestRecord {
  const invocation = parseJsonRow<unknown>(row.invocation_json);
  const validation = validateHomerailPluginToolInvocation(invocation);
  const value = validation.value;
  const target = value?.source.type === "ui_action"
    ? {
      document_id: value.source.target.document_id,
      document_revision: value.source.target.document_revision,
      node_id: value.source.target.node_id,
      node_revision: value.source.target.node_revision,
      action_id: value.source.target.action_id,
      action_intent: value.source.target.action_intent,
    }
    : value?.source.type === "agent"
      ? {
        document_id: value.source.target.document_id,
        document_revision: value.source.target.base_revision,
        node_id: null,
        node_revision: null,
        action_id: null,
        action_intent: null,
      }
      : undefined;
  if (
    !validation.valid
    || !value
    || !target
    || value.request_id !== row.request_id
    || value.idempotency_key !== row.idempotency_key
    || value.request_digest !== row.request_digest
    || value.binding.plugin_id !== row.plugin_id
    || value.binding.plugin_version !== row.plugin_version
    || value.source.type !== row.source_type
    || target.document_id !== row.document_id
    || target.document_revision !== row.document_revision
    || target.node_id !== row.node_id
    || target.node_revision !== row.node_revision
    || target.action_id !== row.action_id
    || target.action_intent !== row.action_intent
    || value.tool.local_id !== row.tool_id
    || value.tool.wire_id !== row.tool_wire_id
    || value.binding.permission_revision !== row.permission_revision
  ) throw new Error(`Invalid persisted plugin Tool request: ${row.request_id}`);
  let result: Record<string, unknown> | undefined;
  if (row.result_json !== null) {
    const parsed = parseJsonRow<unknown>(row.result_json);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(`Invalid persisted plugin Tool result: ${row.request_id}`);
    }
    result = parsed as Record<string, unknown>;
  }
  return {
    request_id: row.request_id,
    idempotency_key: row.idempotency_key,
    request_digest: row.request_digest,
    plugin_id: row.plugin_id,
    plugin_version: row.plugin_version,
    status: row.status,
    policy_digest: row.policy_digest,
    permission_revision: row.permission_revision,
    invocation: value,
    ...(result ? { result } : {}),
    ...(row.error_code ? { error_code: row.error_code } : {}),
    ...(row.error_message ? { error_message: row.error_message } : {}),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function requestRow(requestId: string): PluginToolRequestRow | undefined {
  return getDb().prepare(`
    SELECT request_id, idempotency_key, request_digest, plugin_id, plugin_version,
           source_type, document_id, document_revision, node_id, node_revision, action_id,
           action_intent, tool_id, tool_wire_id, status, policy_digest, permission_revision,
           invocation_json, result_json, error_code, error_message, created_at, updated_at
    FROM plugin_tool_requests WHERE request_id = ?
  `).get(requestId) as PluginToolRequestRow | undefined;
}

export function getPluginToolRequest(requestId: string): PluginToolRequestRecord | undefined {
  const row = requestRow(requestId);
  return row ? decodeRequest(row) : undefined;
}

/**
 * A dispatched Runtime Action is unresolved after a process restart while it
 * is still `running`, or after an explicit post-dispatch ambiguity. M6 will
 * supply reconciliation; until then the exact semantic target is fail-closed.
 */
export function getUnresolvedPluginToolTarget(input: {
  document_id: string;
  node_id: string;
  node_revision: number;
  action_id: string;
}): PluginToolRequestRecord | undefined {
  const row = getDb().prepare(`
    SELECT request_id, idempotency_key, request_digest, plugin_id, plugin_version,
           source_type, document_id, document_revision, node_id, node_revision, action_id,
           action_intent, tool_id, tool_wire_id, status, policy_digest, permission_revision,
           invocation_json, result_json, error_code, error_message, created_at, updated_at
    FROM plugin_tool_requests
    WHERE document_id = ?
      AND node_id = ?
      AND node_revision = ?
      AND action_id = ?
      AND (status = 'running' OR (status = 'failed' AND error_code = 'runtime_indeterminate'))
    ORDER BY updated_at DESC, rowid DESC
    LIMIT 1
  `).get(
    input.document_id,
    input.node_id,
    input.node_revision,
    input.action_id,
  ) as PluginToolRequestRow | undefined;
  return row ? decodeRequest(row) : undefined;
}

/** Pending Agent-origin confirmations for one exact active UI scope. */
export function listPendingPluginToolConfirmationsForScope(input: {
  scope_type: "voice_session" | "project" | "run";
  scope_id: string;
  limit?: number;
}): Array<{ request: PluginToolRequestRecord; confirmation: PluginConfirmationRecord }> {
  const limit = Math.max(1, Math.min(32, Math.floor(input.limit ?? 16)));
  const rows = getDb().prepare(`
    SELECT r.request_id, r.idempotency_key, r.request_digest, r.plugin_id, r.plugin_version,
           r.source_type, r.document_id, r.document_revision, r.node_id, r.node_revision,
           r.action_id, r.action_intent, r.tool_id, r.tool_wire_id, r.status,
           r.policy_digest, r.permission_revision, r.invocation_json, r.result_json,
           r.error_code, r.error_message, r.created_at, r.updated_at
    FROM plugin_tool_requests r
    JOIN generative_ui_documents d ON d.document_id = r.document_id
    JOIN plugin_tool_confirmation_challenges c ON c.request_id = r.request_id
    WHERE r.source_type = 'agent'
      AND r.status = 'awaiting_confirmation'
      AND c.status = 'pending'
      AND d.deleted_at IS NULL
      AND d.scope_type = ?
      AND d.scope_id = ?
    ORDER BY r.created_at, r.request_id
    LIMIT ?
  `).all(input.scope_type, input.scope_id, limit) as PluginToolRequestRow[];
  return rows.map((row) => {
    const request = decodeRequest(row);
    const confirmation = getPluginToolConfirmationForRequest(request.request_id);
    if (!confirmation || confirmation.status !== "pending") {
      throw new Error(`Pending plugin Tool confirmation is inconsistent: ${request.request_id}`);
    }
    return { request, confirmation };
  });
}

function boundedEventData(data: Record<string, unknown>): string {
  pluginJsonDigest(data, 128 * 1024);
  return encodeJson(data);
}

export function appendPluginToolEvent(input: {
  request_id: string;
  request_digest: string;
  event_type: PluginToolEventType;
  created_at?: string;
  data?: Record<string, unknown>;
}): PluginToolEventRecord {
  if (!/^[a-f0-9]{64}$/.test(input.request_digest)) throw new Error("Tool event request digest must be SHA-256");
  const request = getPluginToolRequest(input.request_id);
  if (!request || request.request_digest !== input.request_digest) throw new Error("Tool event request binding is invalid");
  const createdAt = input.created_at ?? nowIso();
  const data = input.data ?? {};
  const result = getDb().prepare(`
    INSERT INTO plugin_tool_events(request_id, request_digest, event_type, created_at, data_json)
    VALUES (?, ?, ?, ?, ?)
  `).run(input.request_id, input.request_digest, input.event_type, createdAt, boundedEventData(data));
  return {
    seq: Number(result.lastInsertRowid),
    request_id: input.request_id,
    request_digest: input.request_digest,
    event_type: input.event_type,
    created_at: createdAt,
    data: structuredClone(data),
  };
}

export function createPluginToolRequest(input: {
  invocation: HomerailPluginToolInvocationV1;
  policy_digest: string;
  status: "needs_grant" | "awaiting_confirmation" | "authorized";
  confirmation_challenge?: HomerailPluginToolConfirmationChallengeV1;
}): { record: PluginToolRequestRecord; idempotent: boolean } {
  const validation = validateHomerailPluginToolInvocation(input.invocation);
  if (!validation.valid || !validation.value) {
    throw new Error(`Invalid plugin Tool invocation: ${JSON.stringify(validation.errors)}`);
  }
  const invocation = validation.value;
  if (pluginJsonDigest(homerailPluginToolInvocationDigestInput(invocation), 256 * 1024) !== invocation.request_digest) {
    throw new Error("Plugin Tool request digest does not match its canonical invocation");
  }
  if (!/^[a-f0-9]{64}$/.test(input.policy_digest)) throw new Error("Plugin Tool policy digest must be SHA-256");
  if ((input.status === "awaiting_confirmation") !== Boolean(input.confirmation_challenge)) {
    throw new Error("Plugin Tool awaiting-confirmation request and challenge must be created together");
  }
  let confirmationChallenge: HomerailPluginToolConfirmationChallengeV1 | undefined;
  if (input.confirmation_challenge) {
    const confirmationValidation = validateHomerailPluginToolConfirmationChallenge(
      input.confirmation_challenge,
      invocation,
      { now_ms: Date.parse(input.confirmation_challenge.issued_at) },
    );
    if (!confirmationValidation.valid || !confirmationValidation.value) {
      throw new Error(`Invalid plugin Tool confirmation challenge: ${JSON.stringify(confirmationValidation.errors)}`);
    }
    confirmationChallenge = confirmationValidation.value;
  }
  return getDb().transaction(() => {
    const byRequest = requestRow(invocation.request_id);
    const byIdempotency = getDb().prepare(`
      SELECT request_id, idempotency_key, request_digest, plugin_id, plugin_version,
             source_type, document_id, document_revision, node_id, node_revision, action_id,
             action_intent, tool_id, tool_wire_id, status, policy_digest, permission_revision,
             invocation_json, result_json, error_code, error_message, created_at, updated_at
      FROM plugin_tool_requests
      WHERE plugin_id = ? AND plugin_version = ? AND idempotency_key = ?
    `).get(
      invocation.binding.plugin_id,
      invocation.binding.plugin_version,
      invocation.idempotency_key,
    ) as PluginToolRequestRow | undefined;
    const existing = byRequest ?? byIdempotency;
    if (existing) {
      if (
        existing.request_id !== invocation.request_id
        || existing.request_digest !== invocation.request_digest
        || existing.idempotency_key !== invocation.idempotency_key
      ) throw new Error("Plugin Tool idempotency collision");
      return { record: decodeRequest(existing), idempotent: true };
    }
    getDb().prepare(`
      INSERT INTO plugin_tool_requests(
        request_id, idempotency_key, request_digest, plugin_id, plugin_version,
        source_type, document_id, document_revision, node_id, node_revision, action_id,
        action_intent, tool_id, tool_wire_id, status, policy_digest, permission_revision,
        invocation_json, result_json, error_code, error_message, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?)
    `).run(
      invocation.request_id,
      invocation.idempotency_key,
      invocation.request_digest,
      invocation.binding.plugin_id,
      invocation.binding.plugin_version,
      invocation.source.type,
      invocation.source.type === "ui_action" ? invocation.source.target.document_id : invocation.source.target.document_id,
      invocation.source.type === "ui_action" ? invocation.source.target.document_revision : invocation.source.target.base_revision,
      invocation.source.type === "ui_action" ? invocation.source.target.node_id : null,
      invocation.source.type === "ui_action" ? invocation.source.target.node_revision : null,
      invocation.source.type === "ui_action" ? invocation.source.target.action_id : null,
      invocation.source.type === "ui_action" ? invocation.source.target.action_intent : null,
      invocation.tool.local_id,
      invocation.tool.wire_id,
      input.status,
      input.policy_digest,
      invocation.binding.permission_revision,
      encodeJson(invocation),
      invocation.invoked_at,
      invocation.invoked_at,
    );
    appendPluginToolEvent({
      request_id: invocation.request_id,
      request_digest: invocation.request_digest,
      event_type: "requested",
      created_at: invocation.invoked_at,
      data: { status: input.status },
    });
    if (input.status === "needs_grant") appendPluginToolEvent({
      request_id: invocation.request_id,
      request_digest: invocation.request_digest,
      event_type: "needs_grant",
      created_at: invocation.invoked_at,
    });
    if (confirmationChallenge) insertPluginToolConfirmation(confirmationChallenge);
    return { record: decodeRequest(requestRow(invocation.request_id)!), idempotent: false };
  }).immediate();
}

export function transitionPluginToolRequest(input: {
  request_id: string;
  expected_status: PluginToolRequestStatus;
  status: PluginToolRequestStatus;
  updated_at?: string;
  result?: Record<string, unknown>;
  error_code?: string;
  error_message?: string;
}): PluginToolRequestRecord {
  if (!transitions[input.expected_status].has(input.status)) {
    throw new Error(`Invalid plugin Tool transition: ${input.expected_status} -> ${input.status}`);
  }
  if (input.error_code !== undefined && !/^[a-z][a-z0-9_]{0,63}$/.test(input.error_code)) {
    throw new Error("Plugin Tool error code is invalid");
  }
  const errorMessage = input.error_message?.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 1_000);
  const resultJson = input.result ? boundedEventData(input.result) : null;
  const updatedAt = input.updated_at ?? nowIso();
  const updated = getDb().prepare(`
    UPDATE plugin_tool_requests
    SET status = ?, result_json = ?, error_code = ?, error_message = ?, updated_at = ?
    WHERE request_id = ? AND status = ?
  `).run(
    input.status,
    resultJson,
    input.error_code ?? null,
    errorMessage ?? null,
    updatedAt,
    input.request_id,
    input.expected_status,
  );
  if (updated.changes !== 1) throw new Error("Plugin Tool status conflict");
  return decodeRequest(requestRow(input.request_id)!);
}

export function resolvePluginToolRuntimeAmbiguity(input: {
  request_id: string;
  request_digest: string;
  resolution: "absent" | "failed";
  error?: { code: string; message: string };
  updated_at?: string;
}): PluginToolRequestRecord {
  const code = input.resolution === "absent" ? "runtime_absent" : "runtime_reconciled_failed";
  const message = input.resolution === "absent"
    ? "Attested Runtime ledger proves the request was never dispatched"
    : input.error?.message ?? "Attested Runtime ledger reports a terminal failure";
  const updatedAt = input.updated_at ?? nowIso();
  const updated = getDb().prepare(`
    UPDATE plugin_tool_requests
    SET status = 'failed', error_code = ?, error_message = ?, result_json = ?, updated_at = ?
    WHERE request_id = ? AND request_digest = ?
      AND (status = 'running' OR (status = 'failed' AND error_code = 'runtime_indeterminate'))
  `).run(
    code,
    message.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 1_000),
    boundedEventData({ reconciliation: input.resolution, ...(input.error ? { error: input.error } : {}) }),
    updatedAt,
    input.request_id,
    input.request_digest,
  );
  if (updated.changes !== 1) throw new Error("Plugin Tool reconciliation status conflict");
  return decodeRequest(requestRow(input.request_id)!);
}

interface ConfirmationRow {
  challenge_id: string;
  request_id: string;
  request_digest: string;
  status: "pending" | "approved" | "denied" | "consumed" | "expired";
  challenge_json: string;
  decision_json: string | null;
  expires_at: string;
  created_at: string;
  decided_at: string | null;
  consumed_at: string | null;
}

export interface PluginConfirmationRecord {
  status: ConfirmationRow["status"];
  challenge: HomerailPluginToolConfirmationChallengeV1;
  decision?: HomerailPluginToolConfirmationDecisionV1;
  consumed_at?: string;
}

function confirmationRow(challengeId: string): ConfirmationRow | undefined {
  return getDb().prepare(`
    SELECT challenge_id, request_id, request_digest, status, challenge_json,
           decision_json, expires_at, created_at, decided_at, consumed_at
    FROM plugin_tool_confirmation_challenges WHERE challenge_id = ?
  `).get(challengeId) as ConfirmationRow | undefined;
}

function decodeConfirmation(row: ConfirmationRow): PluginConfirmationRecord {
  const challengeValidation = validateHomerailPluginToolConfirmationChallenge(
    parseJsonRow<unknown>(row.challenge_json),
  );
  if (!challengeValidation.valid || !challengeValidation.value) {
    throw new Error(`Invalid persisted plugin Tool confirmation: ${row.challenge_id}`);
  }
  let decision: HomerailPluginToolConfirmationDecisionV1 | undefined;
  if (row.decision_json !== null) {
    const decisionValidation = validateHomerailPluginToolConfirmationDecision(
      parseJsonRow<unknown>(row.decision_json),
      undefined,
      challengeValidation.value,
    );
    if (!decisionValidation.valid || !decisionValidation.value) {
      throw new Error(`Invalid persisted plugin Tool confirmation decision: ${row.challenge_id}`);
    }
    decision = decisionValidation.value;
  }
  return {
    status: row.status,
    challenge: challengeValidation.value,
    ...(decision ? { decision } : {}),
    ...(row.consumed_at ? { consumed_at: row.consumed_at } : {}),
  };
}

export function getPluginToolConfirmation(challengeId: string): PluginConfirmationRecord | undefined {
  const row = confirmationRow(challengeId);
  return row ? decodeConfirmation(row) : undefined;
}

/** Latest challenge for a Tool request, used to replay the exact UI state. */
export function getPluginToolConfirmationForRequest(requestId: string): PluginConfirmationRecord | undefined {
  const row = getDb().prepare(`
    SELECT challenge_id, request_id, request_digest, status, challenge_json,
           decision_json, expires_at, created_at, decided_at, consumed_at
    FROM plugin_tool_confirmation_challenges
    WHERE request_id = ?
    ORDER BY created_at DESC, rowid DESC
    LIMIT 1
  `).get(requestId) as ConfirmationRow | undefined;
  return row ? decodeConfirmation(row) : undefined;
}

export function createPluginToolConfirmation(input: {
  challenge: HomerailPluginToolConfirmationChallengeV1;
}): PluginConfirmationRecord {
  const request = getPluginToolRequest(input.challenge.request_id);
  if (!request) throw new Error("Plugin Tool confirmation request does not exist");
  const validation = validateHomerailPluginToolConfirmationChallenge(
    input.challenge,
    request.invocation,
    { now_ms: Date.parse(input.challenge.issued_at) },
  );
  if (!validation.valid || !validation.value) {
    throw new Error(`Invalid plugin Tool confirmation challenge: ${JSON.stringify(validation.errors)}`);
  }
  return getDb().transaction(() => insertPluginToolConfirmation(validation.value!)).immediate();
}

function insertPluginToolConfirmation(
  challenge: HomerailPluginToolConfirmationChallengeV1,
): PluginConfirmationRecord {
  const request = getPluginToolRequest(challenge.request_id);
  if (!request || request.request_digest !== challenge.request_digest) {
    throw new Error("Plugin Tool confirmation request binding is invalid");
  }
  getDb().prepare(`
    INSERT INTO plugin_tool_confirmation_challenges(
      challenge_id, request_id, request_digest, status, challenge_json,
      decision_json, expires_at, created_at, decided_at, consumed_at
    ) VALUES (?, ?, ?, 'pending', ?, NULL, ?, ?, NULL, NULL)
  `).run(
    challenge.challenge_id,
    challenge.request_id,
    challenge.request_digest,
    encodeJson(challenge),
    challenge.expires_at,
    challenge.issued_at,
  );
  appendPluginToolEvent({
    request_id: request.request_id,
    request_digest: request.request_digest,
    event_type: "confirmation_issued",
    created_at: challenge.issued_at,
    data: { challenge_id: challenge.challenge_id, expires_at: challenge.expires_at },
  });
  return decodeConfirmation(confirmationRow(challenge.challenge_id)!);
}

export function decidePluginToolConfirmation(input: {
  decision: HomerailPluginToolConfirmationDecisionV1;
}): PluginConfirmationRecord {
  return getDb().transaction(() => {
    const row = confirmationRow(input.decision.challenge_id);
    if (!row) throw new Error("Plugin Tool confirmation challenge does not exist");
    if (row.status !== "pending") throw new Error("Plugin Tool confirmation challenge is no longer pending");
    const request = getPluginToolRequest(row.request_id);
    if (!request) throw new Error("Plugin Tool confirmation request does not exist");
    const challenge = decodeConfirmation(row).challenge;
    const validation = validateHomerailPluginToolConfirmationDecision(
      input.decision,
      request.invocation,
      challenge,
    );
    if (!validation.valid || !validation.value) {
      const expiredOnly = validation.errors.length > 0
        && validation.errors.every((entry) => entry.keyword === "confirmationExpired")
        && Date.parse(input.decision.decided_at) >= Date.parse(challenge.expires_at);
      if (expiredOnly) {
        getDb().prepare(`
          UPDATE plugin_tool_confirmation_challenges
          SET status = 'expired', decided_at = ?
          WHERE challenge_id = ? AND status = 'pending'
        `).run(input.decision.decided_at, challenge.challenge_id);
        transitionPluginToolRequest({
          request_id: request.request_id,
          expected_status: "awaiting_confirmation",
          status: "failed",
          updated_at: input.decision.decided_at,
          error_code: "confirmation_expired",
          error_message: "Plugin Tool confirmation challenge expired",
        });
        appendPluginToolEvent({
          request_id: request.request_id,
          request_digest: request.request_digest,
          event_type: "failed",
          created_at: input.decision.decided_at,
          data: { error_code: "confirmation_expired", challenge_id: challenge.challenge_id },
        });
        return decodeConfirmation(confirmationRow(challenge.challenge_id)!);
      }
      throw new Error(`Invalid plugin Tool confirmation decision: ${JSON.stringify(validation.errors)}`);
    }
    const status = validation.value.decision === "approved" ? "approved" : "denied";
    const updated = getDb().prepare(`
      UPDATE plugin_tool_confirmation_challenges
      SET status = ?, decision_json = ?, decided_at = ?
      WHERE challenge_id = ? AND status = 'pending'
    `).run(status, encodeJson(validation.value), validation.value.decided_at, challenge.challenge_id);
    if (updated.changes !== 1) throw new Error("Plugin Tool confirmation decision conflict");
    appendPluginToolEvent({
      request_id: request.request_id,
      request_digest: request.request_digest,
      event_type: status === "approved" ? "confirmed" : "denied",
      created_at: validation.value.decided_at,
      data: { challenge_id: challenge.challenge_id, actor: validation.value.actor },
    });
    transitionPluginToolRequest({
      request_id: request.request_id,
      expected_status: "awaiting_confirmation",
      status: status === "approved" ? "authorized" : "denied",
      updated_at: validation.value.decided_at,
    });
    return decodeConfirmation(confirmationRow(challenge.challenge_id)!);
  }).immediate();
}

export function consumePluginToolConfirmation(challengeId: string, consumedAt: string = nowIso()): PluginConfirmationRecord {
  const updated = getDb().prepare(`
    UPDATE plugin_tool_confirmation_challenges
    SET status = 'consumed', consumed_at = ?
    WHERE challenge_id = ? AND status = 'approved'
  `).run(consumedAt, challengeId);
  if (updated.changes !== 1) throw new Error("Plugin Tool confirmation is not approved or was already consumed");
  return decodeConfirmation(confirmationRow(challengeId)!);
}

export function recordPluginToolCapabilityNonce(input: {
  nonce: string;
  capability_id: string;
  request_id: string;
  request_digest: string;
  token_digest: string;
  expires_at: string;
  created_at?: string;
}): void {
  if (!/^[A-Za-z0-9._:-]{8,160}$/.test(input.nonce) || !/^[A-Za-z0-9._:-]{8,160}$/.test(input.capability_id)) {
    throw new Error("Plugin capability nonce identity is invalid");
  }
  if (!/^[a-f0-9]{64}$/.test(input.request_digest) || !/^[a-f0-9]{64}$/.test(input.token_digest)) {
    throw new Error("Plugin capability digest is invalid");
  }
  const request = getPluginToolRequest(input.request_id);
  if (!request || request.request_digest !== input.request_digest) throw new Error("Plugin capability request binding is invalid");
  const createdAt = input.created_at ?? nowIso();
  if (Date.parse(input.expires_at) <= Date.parse(createdAt)) throw new Error("Plugin capability expiry is invalid");
  getDb().prepare(`
    INSERT INTO plugin_tool_capability_nonces(
      nonce, capability_id, request_id, request_digest, token_digest,
      expires_at, created_at, consumed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL)
  `).run(
    input.nonce,
    input.capability_id,
    input.request_id,
    input.request_digest,
    input.token_digest,
    input.expires_at,
    createdAt,
  );
}

export function consumePluginToolCapabilityNonce(input: {
  nonce: string;
  request_id: string;
  request_digest: string;
  token_digest: string;
  consumed_at?: string;
}): void {
  const consumedAt = input.consumed_at ?? nowIso();
  const updated = getDb().prepare(`
    UPDATE plugin_tool_capability_nonces
    SET consumed_at = ?
    WHERE nonce = ? AND request_id = ? AND request_digest = ? AND token_digest = ?
      AND consumed_at IS NULL AND expires_at > ?
  `).run(
    consumedAt,
    input.nonce,
    input.request_id,
    input.request_digest,
    input.token_digest,
    consumedAt,
  );
  if (updated.changes !== 1) throw new Error("Plugin capability is expired, mismatched, or already consumed");
}

export function listPluginToolEvents(requestId: string): PluginToolEventRecord[] {
  const rows = getDb().prepare(`
    SELECT seq, request_id, request_digest, event_type, created_at, data_json
    FROM plugin_tool_events WHERE request_id = ? ORDER BY seq
  `).all(requestId) as Array<Omit<PluginToolEventRecord, "data"> & { data_json: string }>;
  return rows.map(({ data_json, ...row }) => ({
    ...row,
    data: parseJsonRow<Record<string, unknown>>(data_json),
  }));
}
