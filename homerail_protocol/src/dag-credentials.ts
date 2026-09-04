/**
 * DAG credential projection contracts.
 * @version 0.1.0
 */

export type DagCredentialProjection =
  | {
      credential_ref: string;
      purpose: string;
      mode: "env";
      values: Record<string, string>;
    }
  | {
      credential_ref: string;
      purpose: string;
      mode: "file" | "stdin";
      field: string;
      content: string;
      filename: string;
      env: string;
    }
  | {
      credential_ref: string;
      purpose: string;
      mode: "manager_broker";
      broker: string;
      allowed_actions: string[];
    };

export interface DagCredentialProjectionSummary {
  credential_ref: string;
  purpose: string;
  mode: DagCredentialProjection["mode"];
  fields?: string[];
  env?: string;
  broker?: string;
  allowed_actions?: string[];
}

interface DagCredentialBrokerCallRequestBase {
  request_id: string;
  /** Stable replay identity. A reused key must describe the exact same request. */
  idempotency_key: string;
  /** Identifies which authority contract owns this operation. */
  run_id: string;
  node_id: string;
  session_id: string;
  round_id: string;
  credential_ref: string;
  broker: string;
  action: string;
  input: Record<string, unknown>;
}

export type DagCredentialBrokerCallRequest = DagCredentialBrokerCallRequestBase & (
  | {
      transport_kind: "worker_actor";
      actor_id: string;
      generation: number;
      lease_generation: number;
      command_id?: string;
      gateway_attempt?: never;
    }
  | {
      transport_kind: "manager_gateway";
      gateway_attempt: number;
      actor_id?: never;
      generation?: never;
      lease_generation?: never;
      command_id?: never;
    }
);

export type DagCredentialBrokerCallOutcome =
  | "completed"
  | "failed"
  | "failed_pre_dispatch"
  | "cancelled"
  | "indeterminate"
  | "reconciled";

type WithoutBrokerInput<T> = T extends unknown ? Omit<T, "input"> : never;

/** Immutable correlation identity echoed by every broker result. */
export type DagCredentialBrokerCallIdentity = WithoutBrokerInput<DagCredentialBrokerCallRequest>;

export function dagCredentialBrokerCallIdentity(
  request: DagCredentialBrokerCallRequest,
): DagCredentialBrokerCallIdentity {
  const { input: _input, ...identity } = request;
  return identity;
}

export function matchesDagCredentialBrokerCallIdentity(
  request: DagCredentialBrokerCallRequest,
  identity: DagCredentialBrokerCallIdentity,
): boolean {
  const expected = dagCredentialBrokerCallIdentity(request) as Record<string, unknown>;
  const received = identity as Record<string, unknown>;
  const expectedKeys = Object.keys(expected).sort();
  const receivedKeys = Object.keys(received).sort();
  return expectedKeys.length === receivedKeys.length
    && expectedKeys.every((key, index) => key === receivedKeys[index] && expected[key] === received[key]);
}

export interface DagCredentialBrokerCallResult {
  request_id: string;
  identity: DagCredentialBrokerCallIdentity;
  ok: boolean;
  outcome: DagCredentialBrokerCallOutcome;
  /** Manager-authored digest of the immutable request and full execution fence. */
  request_digest?: string;
  result?: unknown;
  error?: string;
  reconciliation?: "completed" | "absent" | "failed";
}

/**
 * Turn-scoped cancellation for an already-sent Worker broker call. The Manager
 * matches every supplied fence field against the in-flight immutable request;
 * cancellation by request_id alone is never authoritative.
 */
export interface DagCredentialBrokerCancelRequest {
  request_id: string;
  idempotency_key: string;
  transport_kind: "worker_actor";
  run_id: string;
  node_id: string;
  session_id: string;
  round_id: string;
  actor_id: string;
  generation: number;
  lease_generation: number;
  command_id?: string;
}

export function summarizeDagCredentialProjection(
  projection: DagCredentialProjection,
): DagCredentialProjectionSummary {
  if (projection.mode === "env") {
    return {
      credential_ref: projection.credential_ref,
      purpose: projection.purpose,
      mode: projection.mode,
      fields: Object.keys(projection.values).sort(),
    };
  }
  if (projection.mode === "manager_broker") {
    return {
      credential_ref: projection.credential_ref,
      purpose: projection.purpose,
      mode: projection.mode,
      broker: projection.broker,
      allowed_actions: [...projection.allowed_actions].sort(),
    };
  }
  return {
    credential_ref: projection.credential_ref,
    purpose: projection.purpose,
    mode: projection.mode,
    fields: [projection.field],
    env: projection.env,
  };
}
