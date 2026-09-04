import type { DagCredentialBrokerCallRequest } from "homerail-protocol";
import { encodeJson, getDb, parseJsonRow } from "./db.js";
import { nowIso } from "./time.js";

export type CredentialBrokerMutationState =
  | "prepared"
  | "dispatched"
  | "completed"
  | "failed_pre_dispatch"
  | "cancelled"
  | "cancel_requested"
  | "indeterminate"
  | "reconciled";

export type CredentialBrokerMutationResolution = "completed" | "absent" | "failed";

interface MutationAttemptRow {
  request_id: string;
  idempotency_key: string;
  request_digest: string;
  semantic_target: string;
  source_type: "worker_actor" | "manager_gateway";
  source_id: string;
  run_id: string;
  node_id: string;
  session_id: string;
  round_id: string;
  actor_id: string | null;
  generation: number | null;
  lease_generation: number | null;
  command_id: string | null;
  gateway_attempt: number | null;
  credential_ref: string;
  broker: string;
  action: string;
  state: CredentialBrokerMutationState;
  request_json: string;
  provider_state_json: string | null;
  result_json: string | null;
  error_message: string | null;
  resolution: CredentialBrokerMutationResolution | null;
  created_at: string;
  updated_at: string;
}

export interface CredentialBrokerMutationAttempt {
  request_id: string;
  idempotency_key: string;
  request_digest: string;
  semantic_target: string;
  source_type: "worker_actor" | "manager_gateway";
  source_id: string;
  run_id: string;
  node_id: string;
  session_id: string;
  round_id: string;
  actor_id?: string;
  generation?: number;
  lease_generation?: number;
  command_id?: string;
  gateway_attempt?: number;
  credential_ref: string;
  broker: string;
  action: string;
  state: CredentialBrokerMutationState;
  request: DagCredentialBrokerCallRequest;
  provider_state?: Record<string, unknown>;
  result?: unknown;
  error_message?: string;
  resolution?: CredentialBrokerMutationResolution;
  created_at: string;
  updated_at: string;
}

export interface PrepareCredentialBrokerMutationInput {
  request: DagCredentialBrokerCallRequest;
  request_digest: string;
  semantic_target: string;
  source_id: string;
}

export type PrepareCredentialBrokerMutationResult =
  | { status: "created"; attempt: CredentialBrokerMutationAttempt }
  | { status: "duplicate"; attempt: CredentialBrokerMutationAttempt }
  | { status: "blocked"; attempt: CredentialBrokerMutationAttempt };

const MAX_REQUEST_BYTES = 2_200_000;
const MAX_PROVIDER_STATE_BYTES = 128 * 1024;
const MAX_RESULT_BYTES = 256 * 1024;

function boundedJson(value: unknown, maxBytes: number, label: string): string {
  const encoded = encodeJson(value);
  if (Buffer.byteLength(encoded, "utf8") > maxBytes) throw new Error(`${label} exceeds ${maxBytes} bytes`);
  return encoded;
}

function boundedError(value: string | undefined): string | null {
  if (!value) return null;
  return value.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 1_000);
}

function rowByRequestId(requestId: string): MutationAttemptRow | undefined {
  return getDb().prepare(`
    SELECT request_id, idempotency_key, request_digest, semantic_target,
           source_type, source_id, run_id, node_id, session_id, round_id,
           actor_id, generation, lease_generation, command_id, gateway_attempt,
           credential_ref, broker, action, state, request_json, provider_state_json,
           result_json, error_message, resolution, created_at, updated_at
    FROM credential_broker_mutation_attempts
    WHERE request_id = ?
  `).get(requestId) as MutationAttemptRow | undefined;
}

function decodeRow(row: MutationAttemptRow): CredentialBrokerMutationAttempt {
  const request = parseJsonRow<DagCredentialBrokerCallRequest>(row.request_json);
  if (
    !request
    || request.request_id !== row.request_id
    || request.idempotency_key !== row.idempotency_key
    || request.transport_kind !== row.source_type
    || request.run_id !== row.run_id
    || request.node_id !== row.node_id
    || request.session_id !== row.session_id
    || request.round_id !== row.round_id
    || request.credential_ref !== row.credential_ref
    || request.broker !== row.broker
    || request.action !== row.action
  ) throw new Error(`Invalid persisted credential broker mutation attempt: ${row.request_id}`);
  const providerState = row.provider_state_json === null
    ? undefined
    : parseJsonRow<Record<string, unknown>>(row.provider_state_json);
  const result = row.result_json === null ? undefined : parseJsonRow<unknown>(row.result_json);
  return {
    request_id: row.request_id,
    idempotency_key: row.idempotency_key,
    request_digest: row.request_digest,
    semantic_target: row.semantic_target,
    source_type: row.source_type,
    source_id: row.source_id,
    run_id: row.run_id,
    node_id: row.node_id,
    session_id: row.session_id,
    round_id: row.round_id,
    ...(row.actor_id === null ? {} : { actor_id: row.actor_id }),
    ...(row.generation === null ? {} : { generation: row.generation }),
    ...(row.lease_generation === null ? {} : { lease_generation: row.lease_generation }),
    ...(row.command_id === null ? {} : { command_id: row.command_id }),
    ...(row.gateway_attempt === null ? {} : { gateway_attempt: row.gateway_attempt }),
    credential_ref: row.credential_ref,
    broker: row.broker,
    action: row.action,
    state: row.state,
    request,
    ...(providerState === undefined ? {} : { provider_state: providerState }),
    ...(result === undefined ? {} : { result }),
    ...(row.error_message === null ? {} : { error_message: row.error_message }),
    ...(row.resolution === null ? {} : { resolution: row.resolution }),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function appendEvent(
  requestId: string,
  requestDigest: string,
  state: CredentialBrokerMutationState,
  detail: Record<string, unknown> = {},
): void {
  getDb().prepare(`
    INSERT INTO credential_broker_mutation_events(
      request_id, request_digest, state, detail_json, created_at
    ) VALUES (?, ?, ?, ?, ?)
  `).run(requestId, requestDigest, state, boundedJson(detail, 32 * 1024, "Broker mutation event"), nowIso());
}

export function getCredentialBrokerMutationAttempt(
  requestId: string,
): CredentialBrokerMutationAttempt | undefined {
  const row = rowByRequestId(requestId);
  return row ? decodeRow(row) : undefined;
}

export function listUnresolvedCredentialBrokerMutations(limit = 64): CredentialBrokerMutationAttempt[] {
  const boundedLimit = Math.max(1, Math.min(256, Math.floor(limit)));
  const rows = getDb().prepare(`
    SELECT request_id, idempotency_key, request_digest, semantic_target,
           source_type, source_id, run_id, node_id, session_id, round_id,
           actor_id, generation, lease_generation, command_id, gateway_attempt,
           credential_ref, broker, action, state, request_json, provider_state_json,
           result_json, error_message, resolution, created_at, updated_at
    FROM credential_broker_mutation_attempts
    WHERE state IN ('prepared', 'dispatched', 'cancel_requested', 'indeterminate')
    ORDER BY created_at, request_id
    LIMIT ?
  `).all(boundedLimit) as MutationAttemptRow[];
  return rows.map(decodeRow);
}

export function prepareCredentialBrokerMutation(
  input: PrepareCredentialBrokerMutationInput,
): PrepareCredentialBrokerMutationResult {
  if (!/^[a-f0-9]{64}$/.test(input.request_digest)) throw new Error("Broker request digest must be SHA-256");
  if (!input.semantic_target || input.semantic_target.length > 1_024) {
    throw new Error("Broker semantic target must be 1-1024 characters");
  }
  if (!input.source_id || input.source_id.length > 256) throw new Error("Broker source id is invalid");
  const requestJson = boundedJson(input.request, MAX_REQUEST_BYTES, "Broker mutation request");
  return getDb().transaction(() => {
    const byRequest = rowByRequestId(input.request.request_id);
    const byIdempotency = getDb().prepare(`
      SELECT request_id, idempotency_key, request_digest, semantic_target,
             source_type, source_id, run_id, node_id, session_id, round_id,
             actor_id, generation, lease_generation, command_id, gateway_attempt,
             credential_ref, broker, action, state, request_json, provider_state_json,
             result_json, error_message, resolution, created_at, updated_at
      FROM credential_broker_mutation_attempts
      WHERE credential_ref = ? AND broker = ? AND action = ? AND idempotency_key = ?
    `).get(
      input.request.credential_ref,
      input.request.broker,
      input.request.action,
      input.request.idempotency_key,
    ) as MutationAttemptRow | undefined;
    const existing = byRequest ?? byIdempotency;
    if (existing) {
      if (
        existing.request_id !== input.request.request_id
        || existing.request_digest !== input.request_digest
        || existing.idempotency_key !== input.request.idempotency_key
      ) throw new Error("Credential broker mutation idempotency collision");
      return { status: "duplicate" as const, attempt: decodeRow(existing) };
    }
    const unresolved = getDb().prepare(`
      SELECT request_id, idempotency_key, request_digest, semantic_target,
             source_type, source_id, run_id, node_id, session_id, round_id,
             actor_id, generation, lease_generation, command_id, gateway_attempt,
             credential_ref, broker, action, state, request_json, provider_state_json,
             result_json, error_message, resolution, created_at, updated_at
      FROM credential_broker_mutation_attempts
      WHERE credential_ref = ? AND broker = ? AND semantic_target = ?
        AND state IN ('prepared', 'dispatched', 'cancel_requested', 'indeterminate')
      ORDER BY created_at, request_id
      LIMIT 1
    `).get(
      input.request.credential_ref,
      input.request.broker,
      input.semantic_target,
    ) as MutationAttemptRow | undefined;
    if (unresolved) return { status: "blocked" as const, attempt: decodeRow(unresolved) };

    const now = nowIso();
    getDb().prepare(`
      INSERT INTO credential_broker_mutation_attempts(
        request_id, idempotency_key, request_digest, semantic_target,
        source_type, source_id, run_id, node_id, session_id, round_id,
        actor_id, generation, lease_generation, command_id, gateway_attempt,
        credential_ref, broker, action, state, request_json, provider_state_json,
        result_json, error_message, resolution, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                'prepared', ?, NULL, NULL, NULL, NULL, ?, ?)
    `).run(
      input.request.request_id,
      input.request.idempotency_key,
      input.request_digest,
      input.semantic_target,
      input.request.transport_kind,
      input.source_id,
      input.request.run_id,
      input.request.node_id,
      input.request.session_id,
      input.request.round_id,
      input.request.actor_id ?? null,
      input.request.generation ?? null,
      input.request.lease_generation ?? null,
      input.request.command_id ?? null,
      input.request.gateway_attempt ?? null,
      input.request.credential_ref,
      input.request.broker,
      input.request.action,
      requestJson,
      now,
      now,
    );
    appendEvent(input.request.request_id, input.request_digest, "prepared", {
      source_type: input.request.transport_kind,
      semantic_target: input.semantic_target,
    });
    return { status: "created" as const, attempt: decodeRow(rowByRequestId(input.request.request_id)!) };
  }).immediate();
}

function transition(
  requestId: string,
  from: readonly CredentialBrokerMutationState[],
  to: CredentialBrokerMutationState,
  options: {
    result?: unknown;
    error?: string;
    resolution?: CredentialBrokerMutationResolution;
    detail?: Record<string, unknown>;
  } = {},
): CredentialBrokerMutationAttempt {
  return getDb().transaction(() => {
    const existing = rowByRequestId(requestId);
    if (!existing) throw new Error(`Unknown credential broker mutation attempt: ${requestId}`);
    if (!from.includes(existing.state)) {
      if (existing.state === to) return decodeRow(existing);
      throw new Error(`Invalid credential broker mutation transition: ${existing.state} -> ${to}`);
    }
    const resultJson = options.result === undefined
      ? existing.result_json
      : boundedJson(options.result, MAX_RESULT_BYTES, "Broker mutation result");
    const updatedAt = nowIso();
    const placeholders = from.map(() => "?").join(", ");
    const updated = getDb().prepare(`
      UPDATE credential_broker_mutation_attempts
      SET state = ?, result_json = ?, error_message = ?, resolution = ?, updated_at = ?
      WHERE request_id = ? AND state IN (${placeholders})
    `).run(
      to,
      resultJson,
      boundedError(options.error) ?? existing.error_message,
      options.resolution ?? existing.resolution,
      updatedAt,
      requestId,
      ...from,
    );
    if (updated.changes !== 1) throw new Error("Credential broker mutation status conflict");
    appendEvent(requestId, existing.request_digest, to, options.detail ?? {
      ...(options.resolution ? { resolution: options.resolution } : {}),
    });
    return decodeRow(rowByRequestId(requestId)!);
  }).immediate();
}

export function dispatchCredentialBrokerMutation(requestId: string): CredentialBrokerMutationAttempt {
  return transition(requestId, ["prepared"], "dispatched");
}

export function completeCredentialBrokerMutation(
  requestId: string,
  result: unknown,
): CredentialBrokerMutationAttempt {
  return transition(requestId, ["dispatched"], "completed", { result });
}

export function failCredentialBrokerMutationBeforeDispatch(
  requestId: string,
  error: string,
): CredentialBrokerMutationAttempt {
  return transition(requestId, ["prepared"], "failed_pre_dispatch", { error });
}

export function cancelCredentialBrokerMutationAttempt(
  requestId: string,
  reason: string,
): CredentialBrokerMutationAttempt {
  const existing = getCredentialBrokerMutationAttempt(requestId);
  if (!existing) throw new Error(`Unknown credential broker mutation attempt: ${requestId}`);
  if (existing.state === "prepared") {
    return transition(requestId, ["prepared"], "cancelled", { error: reason });
  }
  if (existing.state === "dispatched") {
    return transition(requestId, ["dispatched"], "cancel_requested", { error: reason });
  }
  return existing;
}

export function markCredentialBrokerMutationIndeterminate(
  requestId: string,
  error: string,
): CredentialBrokerMutationAttempt {
  return transition(requestId, ["dispatched", "cancel_requested"], "indeterminate", { error });
}

export function reconcileCredentialBrokerMutation(
  requestId: string,
  resolution: CredentialBrokerMutationResolution,
  options: { result?: unknown; error?: string } = {},
): CredentialBrokerMutationAttempt {
  return transition(
    requestId,
    ["dispatched", "cancel_requested", "indeterminate"],
    "reconciled",
    { ...options, resolution },
  );
}

export function checkpointCredentialBrokerMutation(
  requestId: string,
  patch: Record<string, unknown>,
): CredentialBrokerMutationAttempt {
  return getDb().transaction(() => {
    const existing = rowByRequestId(requestId);
    if (!existing) throw new Error(`Unknown credential broker mutation attempt: ${requestId}`);
    if (!["prepared", "dispatched", "cancel_requested", "indeterminate"].includes(existing.state)) {
      throw new Error(`Credential broker mutation ${requestId} is already terminal`);
    }
    const current = existing.provider_state_json === null
      ? {}
      : parseJsonRow<Record<string, unknown>>(existing.provider_state_json);
    const providerStateJson = boundedJson(
      { ...current, ...structuredClone(patch) },
      MAX_PROVIDER_STATE_BYTES,
      "Broker provider state",
    );
    const updated = getDb().prepare(`
      UPDATE credential_broker_mutation_attempts
      SET provider_state_json = ?, updated_at = ?
      WHERE request_id = ? AND state = ?
    `).run(providerStateJson, nowIso(), requestId, existing.state);
    if (updated.changes !== 1) throw new Error("Credential broker mutation checkpoint conflict");
    appendEvent(requestId, existing.request_digest, existing.state, {
      checkpoint_fields: Object.keys(patch).sort(),
    });
    return decodeRow(rowByRequestId(requestId)!);
  }).immediate();
}

/** Terminal known completion for an exact Manager gateway fence during cold recovery. */
export function findCompletedManagerGatewayMutation(input: {
  run_id: string;
  node_id: string;
  session_id: string;
  round_id: string;
  gateway_attempt: number;
}): CredentialBrokerMutationAttempt | undefined {
  const row = getDb().prepare(`
    SELECT request_id, idempotency_key, request_digest, semantic_target,
           source_type, source_id, run_id, node_id, session_id, round_id,
           actor_id, generation, lease_generation, command_id, gateway_attempt,
           credential_ref, broker, action, state, request_json, provider_state_json,
           result_json, error_message, resolution, created_at, updated_at
    FROM credential_broker_mutation_attempts
    WHERE source_type = 'manager_gateway' AND run_id = ? AND node_id = ?
      AND session_id = ? AND round_id = ? AND gateway_attempt = ?
      AND (state = 'completed' OR (state = 'reconciled' AND resolution = 'completed'))
    ORDER BY updated_at DESC, request_id DESC
    LIMIT 1
  `).get(
    input.run_id,
    input.node_id,
    input.session_id,
    input.round_id,
    input.gateway_attempt,
  ) as MutationAttemptRow | undefined;
  return row ? decodeRow(row) : undefined;
}
