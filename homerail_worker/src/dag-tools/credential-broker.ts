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
) => Promise<DagCredentialBrokerCallResult>;

export function createCredentialBrokerCallTool(
  state: DagToolsState,
  bindings: readonly CredentialBrokerBinding[],
  call: CredentialBrokerCaller,
): DagToolDefinition {
  return {
    name: "credential_broker_call",
    description:
      "Ask the Manager to perform one declared credential-backed action. "
      + "The credential stays in the Manager; only the action result is returned.",
    input_schema: {
      type: "object",
      properties: {
        credential_ref: { type: "string", minLength: 1, maxLength: 128 },
        action: { type: "string", minLength: 1, maxLength: 128 },
        input: { type: "object", additionalProperties: true },
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
      const result = await call({
        request_id: randomUUID(),
        run_id: state.runId,
        node_id: state.nodeId,
        session_id: state.sessionId,
        ...(state.roundId ? { round_id: state.roundId } : {}),
        ...(state.actorId ? { actor_id: state.actorId } : {}),
        ...(state.generation !== undefined ? { generation: state.generation } : {}),
        ...(state.leaseGeneration !== undefined ? { lease_generation: state.leaseGeneration } : {}),
        ...(state.commandId ? { command_id: state.commandId } : {}),
        credential_ref: credentialRef,
        broker: binding.broker,
        action,
        input: input as Record<string, unknown> | undefined ?? {},
      });
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
