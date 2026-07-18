import type {
  DagCredentialBrokerCallRequest,
  DagCredentialBrokerCallResult,
} from "homerail-protocol";
import {
  materializeCredential,
  recordCredentialUseFailure,
  type CredentialRecord,
} from "../persistence/credentials.js";
import { getActiveRun } from "./active-runs.js";

export interface CredentialBrokerContext {
  credential: CredentialRecord;
  secret: Readonly<Record<string, string>>;
  input: Readonly<Record<string, unknown>>;
}

export type CredentialBrokerHandler = (
  context: CredentialBrokerContext,
) => Promise<unknown>;

const BROKER_NAME = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const ACTION_NAME = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MAX_INPUT_BYTES = 64 * 1024;
const MAX_RESULT_BYTES = 256 * 1024;
const handlers = new Map<string, Map<string, CredentialBrokerHandler>>();

function safeJsonSize(value: unknown): number {
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error("Credential broker value is not JSON serializable");
  return Buffer.byteLength(encoded, "utf8");
}

function assertResultDoesNotRevealSecrets(
  result: unknown,
  secret: Readonly<Record<string, string>>,
): void {
  const secretValues = Object.values(secret);
  const seen = new WeakSet<object>();
  const containsSecret = (value: unknown): boolean => {
    if (typeof value === "string") return secretValues.some((candidate) => value.includes(candidate));
    if (typeof value === "number" || typeof value === "boolean") {
      return secretValues.includes(String(value));
    }
    if (!value || typeof value !== "object") return false;
    if (seen.has(value)) return false;
    seen.add(value);
    if (Array.isArray(value)) return value.some(containsSecret);
    return Object.entries(value).some(([key, entry]) => containsSecret(key) || containsSecret(entry));
  };
  if (containsSecret(result)) {
    throw new Error("Credential broker result reflected a secret value");
  }
}

export function registerCredentialBroker(
  broker: string,
  action: string,
  handler: CredentialBrokerHandler,
): void {
  if (!BROKER_NAME.test(broker)) throw new Error("Invalid credential broker name");
  if (!ACTION_NAME.test(action)) throw new Error("Invalid credential broker action");
  const actions = handlers.get(broker) ?? new Map<string, CredentialBrokerHandler>();
  actions.set(action, handler);
  handlers.set(broker, actions);
}

export async function invokeCredentialBroker(
  broker: string,
  action: string,
  context: CredentialBrokerContext,
): Promise<unknown> {
  const handler = handlers.get(broker)?.get(action);
  if (!handler) throw new Error(`Unsupported credential broker action: ${broker}/${action}`);
  if (safeJsonSize(context.input) > MAX_INPUT_BYTES) {
    throw new Error("Credential broker input exceeds 64 KiB");
  }
  const result = await handler(context);
  assertResultDoesNotRevealSecrets(result, context.secret);
  if (safeJsonSize(result) > MAX_RESULT_BYTES) {
    throw new Error("Credential broker result exceeds 256 KiB");
  }
  return result;
}

function managerBrokerBinding(
  runId: string,
  nodeId: string,
  credentialRef: string,
): {
  purpose: string;
  broker: string;
  allowed_actions: string[];
} {
  const run = getActiveRun(runId);
  if (!run || run.status !== "active") throw new Error("Credential broker run is not active");
  const node = run.dagRun.graph.nodes.find((candidate) => candidate.node_id === nodeId);
  if (!node) throw new Error("Credential broker node was not found");
  const runtime = node.extra?.agent_runtime;
  const credentials = runtime && typeof runtime === "object" && !Array.isArray(runtime)
    ? (runtime as Record<string, unknown>).credentials
    : undefined;
  if (!Array.isArray(credentials)) throw new Error("Credential broker is not declared on this node");
  for (const raw of credentials) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const binding = raw as Record<string, unknown>;
    if (binding.credential_ref !== credentialRef) continue;
    const inject = binding.inject;
    if (!inject || typeof inject !== "object" || Array.isArray(inject)) continue;
    const policy = inject as Record<string, unknown>;
    if (policy.mode !== "manager_broker") continue;
    return {
      purpose: String(binding.purpose ?? ""),
      broker: String(policy.broker ?? ""),
      allowed_actions: Array.isArray(policy.allowed_actions)
        ? policy.allowed_actions.filter((entry): entry is string => typeof entry === "string")
        : [],
    };
  }
  throw new Error("Credential broker reference is not declared on this node");
}

export async function executeCredentialBrokerCall(
  workerId: string,
  request: DagCredentialBrokerCallRequest,
): Promise<DagCredentialBrokerCallResult> {
  const fail = (error: string): DagCredentialBrokerCallResult => ({
    request_id: request.request_id,
    ok: false,
    error,
  });
  if (!request.request_id || !request.run_id || !request.node_id || !request.session_id) {
    return fail("Credential broker transport identity is incomplete");
  }
  if (!BROKER_NAME.test(request.broker) || !ACTION_NAME.test(request.action)) {
    return fail("Credential broker or action is invalid");
  }
  let binding;
  let materializedSecret: Readonly<Record<string, string>> | undefined;
  try {
    binding = managerBrokerBinding(request.run_id, request.node_id, request.credential_ref);
    if (binding.broker !== request.broker || !binding.allowed_actions.includes(request.action)) {
      throw new Error("Credential broker action is not permitted by the WorkflowSpec");
    }
    const useContext = {
      actor: `credential-broker:worker:${workerId}`,
      run_id: request.run_id,
      node_id: request.node_id,
      purpose: binding.purpose,
      broker: request.broker,
      action: request.action,
    };
    const materialized = materializeCredential(request.credential_ref, useContext);
    materializedSecret = materialized.secret;
    const result = await invokeCredentialBroker(request.broker, request.action, {
      credential: materialized.record,
      secret: materialized.secret,
      input: request.input,
    });
    return { request_id: request.request_id, ok: true, result };
  } catch (error) {
    const rawMessage = error instanceof Error ? error.message : String(error);
    const message = materializedSecret && Object.values(materializedSecret).some((value) => rawMessage.includes(value))
      ? "Credential broker call failed without exposing provider details"
      : rawMessage;
    if (request.credential_ref) {
      try {
        recordCredentialUseFailure(request.credential_ref, {
          actor: `credential-broker:worker:${workerId}`,
          run_id: request.run_id,
          node_id: request.node_id,
          purpose: binding?.purpose,
          broker: request.broker,
          action: request.action,
        }, message);
      } catch {
        // Failure auditing must not replace the original bounded error.
      }
    }
    return fail(message);
  }
}

registerCredentialBroker("lark_bot", "bot_info", async ({ credential, secret }) => {
  if (credential.credential_type !== "bot" || !secret.app_id || !secret.app_secret) {
    throw new Error("lark_bot requires a bot credential");
  }
  const tokenResponse = await fetch(
    "https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ app_id: secret.app_id, app_secret: secret.app_secret }),
      signal: AbortSignal.timeout(10_000),
    },
  );
  const tokenBody = await tokenResponse.json() as {
    code?: number;
    tenant_access_token?: string;
  };
  if (!tokenResponse.ok || tokenBody.code !== 0 || !tokenBody.tenant_access_token) {
    throw new Error("Lark Bot authentication failed");
  }
  const infoResponse = await fetch("https://open.feishu.cn/open-apis/bot/v3/info", {
    headers: { Authorization: `Bearer ${tokenBody.tenant_access_token}` },
    signal: AbortSignal.timeout(10_000),
  });
  const infoBody = await infoResponse.json() as {
    code?: number;
    bot?: { app_name?: string; avatar_url?: string; open_id?: string; activate_status?: number };
  };
  if (!infoResponse.ok || infoBody.code !== 0 || !infoBody.bot) {
    throw new Error("Lark Bot info request failed");
  }
  return {
    bot_name: infoBody.bot.app_name ?? "",
    avatar_url: infoBody.bot.avatar_url ?? "",
    open_id: infoBody.bot.open_id ?? "",
    activate_status: infoBody.bot.activate_status ?? 0,
  };
});
