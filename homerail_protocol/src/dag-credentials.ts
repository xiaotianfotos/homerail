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

export interface DagCredentialBrokerCallRequest {
  request_id: string;
  run_id: string;
  node_id: string;
  session_id: string;
  round_id?: string;
  actor_id?: string;
  generation?: number;
  lease_generation?: number;
  command_id?: string;
  credential_ref: string;
  broker: string;
  action: string;
  input: Record<string, unknown>;
}

export interface DagCredentialBrokerCallResult {
  request_id: string;
  ok: boolean;
  result?: unknown;
  error?: string;
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
