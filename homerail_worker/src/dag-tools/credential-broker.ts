import { randomUUID } from "node:crypto";
import type {
  DagCredentialBrokerCallRequest,
  DagCredentialBrokerCallResult,
  DagCredentialProjection,
} from "homerail-protocol";
import type { DagToolDefinition } from "../agent/types.js";
import type { DagToolsState } from "./index.js";

export type CredentialBrokerBinding = Extract<DagCredentialProjection, { mode: "manager_broker" }>;
export type CredentialBrokerCaller = (
  request: DagCredentialBrokerCallRequest,
  signal?: AbortSignal,
) => Promise<DagCredentialBrokerCallResult>;

export function createCredentialBrokerCallTool(
  state: DagToolsState,
  bindings: readonly CredentialBrokerBinding[],
  call: CredentialBrokerCaller,
  abortSignal?: AbortSignal,
): DagToolDefinition {
  const credentialRefs = Array.from(new Set(bindings.map((binding) => binding.credential_ref))).sort();
  const actions = Array.from(new Set(bindings.flatMap((binding) => binding.allowed_actions))).sort();
  const availablePairs = bindings
    .map((binding) => `${binding.credential_ref}: ${binding.allowed_actions.join(", ")}`)
    .join("; ");
  const actionHints = actions.flatMap((action) => {
    if (["pull_request_snapshot", "checks_snapshot", "required_checks"].includes(action)) {
      return [`${action} input={}`];
    }
    if (action === "read_file") {
      return [`read_file input={"expected_head_sha":"<sha>","path":"<repository path>"}`];
    }
    if (action === "commit_workspace") {
      return [`commit_workspace input={"expected_head_sha":"<sha>","message":"<single line>","workspace_path":"<declared writable path>"}`];
    }
    if (action === "commit_files") {
      return [`commit_files input={"expected_head_sha":"<sha>","message":"<single line>","files":[{"path":"<path>","content_base64":"<canonical base64>"}]}`];
    }
    return [];
  }).join("; ");
  return {
    name: "credential_broker_call",
    description:
      "Ask the Manager to perform one declared credential-backed action. "
      + "The credential stays in the Manager; only the action result is returned. "
      + `Available credential/action pairs: ${availablePairs}. `
      + "Put action arguments only inside input; pass input: {} for an action with no arguments. "
      + (actionHints ? `Exact action payloads: ${actionHints}.` : ""),
    input_schema: {
      type: "object",
      properties: {
        credential_ref: {
          type: "string",
          enum: credentialRefs,
          description: "Choose exactly one credential reference from this enum.",
        },
        action: {
          type: "string",
          enum: actions,
          description: "Choose exactly one action from this enum; do not prefix it with a broker name.",
        },
        input: {
          type: "object",
          additionalProperties: true,
          description: "Action payload only. Use an empty object when the selected action needs no arguments.",
        },
      },
      required: ["credential_ref", "action"],
      additionalProperties: false,
    },
    async handler(args) {
      const credentialRef = String(args.credential_ref ?? "").trim();
      const action = String(args.action ?? "").trim();
      const binding = bindings.find((candidate) => candidate.credential_ref === credentialRef);
      if (!binding) {
        return {
          content: [{ type: "text", text: `Credential broker reference '${credentialRef}' is not available to this node.` }],
          is_error: true,
        };
      }
      if (!binding.allowed_actions.includes(action)) {
        return {
          content: [{ type: "text", text: `Action '${action}' is not allowed for credential '${credentialRef}'.` }],
          is_error: true,
        };
      }
      const input = args.input;
      if (input !== undefined && (typeof input !== "object" || input === null || Array.isArray(input))) {
        return {
          content: [{ type: "text", text: "input must be an object" }],
          is_error: true,
        };
      }
      if (!state.roundId || !state.actorId || state.generation === undefined || state.leaseGeneration === undefined) {
        return {
          content: [{ type: "text", text: "Credential broker requires the complete Actor round/generation/lease fence." }],
          is_error: true,
        };
      }
      const requestId = randomUUID();
      const result = await call({
        request_id: requestId,
        idempotency_key: requestId,
        transport_kind: "worker_actor",
        run_id: state.runId,
        node_id: state.nodeId,
        session_id: state.sessionId,
        round_id: state.roundId,
        actor_id: state.actorId,
        generation: state.generation,
        lease_generation: state.leaseGeneration,
        ...(state.commandId ? { command_id: state.commandId } : {}),
        credential_ref: credentialRef,
        broker: binding.broker,
        action,
        input: input as Record<string, unknown> | undefined ?? {},
      }, abortSignal);
      if (!result.ok) {
        return {
          content: [{ type: "text", text: result.error ?? "Credential broker call failed" }],
          is_error: true,
        };
      }
      return {
        content: [{ type: "text", text: JSON.stringify(result.result ?? null) }],
      };
    },
  };
}
