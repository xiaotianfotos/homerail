import { createHash } from "node:crypto";
import type {
  DagCredentialBrokerCancelRequest,
  DagCredentialBrokerCallRequest,
  DagCredentialBrokerCallResult,
} from "homerail-protocol";
import { dagCredentialBrokerCallIdentity } from "homerail-protocol";
import {
  materializeCredential,
  recordCredentialUseFailure,
  type CredentialRecord,
} from "../persistence/credentials.js";
import {
  cancelCredentialBrokerMutationAttempt,
  checkpointCredentialBrokerMutation,
  completeCredentialBrokerMutation,
  dispatchCredentialBrokerMutation,
  failCredentialBrokerMutationBeforeDispatch,
  getCredentialBrokerMutationAttempt,
  listUnresolvedCredentialBrokerMutations,
  markCredentialBrokerMutationIndeterminate,
  prepareCredentialBrokerMutation,
  reconcileCredentialBrokerMutation,
  type CredentialBrokerMutationAttempt,
  type CredentialBrokerMutationResolution,
} from "../persistence/credential-broker-mutations.js";
import { subscribe } from "../events/bus.js";
import { assessDagTransportFence } from "../orchestration/response-bridge.js";
import {
  getActiveRun,
  getCurrentNodeSession,
  recordActiveRunBrokerActionSuccess,
} from "./active-runs.js";
import {
  githubAssessReview,
  githubChecksSnapshot,
  githubCommitFiles,
  githubCommitWorkspace,
  githubMutationSemanticTarget,
  githubPullRequestSnapshot,
  githubReadDiff,
  githubReadFile,
  githubReconcileMutation,
  githubRequiredChecks,
  githubValidateHead,
} from "./github-pr-broker.js";

export interface CredentialBrokerContext {
  credential: CredentialRecord;
  secret: Readonly<Record<string, string>>;
  input: Readonly<Record<string, unknown>>;
  transport?: Readonly<Omit<DagCredentialBrokerCallRequest, "input">>;
  /** Turn/run cancellation, combined by provider adapters with their own timeout. */
  signal?: AbortSignal;
  /** Present only for mutation handlers after their durable attempt is prepared. */
  mutation?: Readonly<{
    request_digest: string;
    semantic_target: string;
    checkpoint: (patch: Record<string, unknown>) => void;
    assert_authority: () => void;
  }>;
}

export type CredentialBrokerHandler = (
  context: CredentialBrokerContext,
) => Promise<unknown>;

export interface CredentialBrokerRegistrationOptions {
  maxInputBytes?: number;
  effect?: "read" | "mutation";
  semanticTarget?: (context: CredentialBrokerContext) => string;
  reconcile?: (
    context: CredentialBrokerContext,
    attempt: CredentialBrokerMutationAttempt,
  ) => Promise<CredentialBrokerReconciliation>;
}

export type CredentialBrokerReconciliation =
  | { resolution: "completed"; result: unknown }
  | { resolution: "absent" | "failed"; error?: string }
  | { resolution: "indeterminate"; error?: string };

interface RegisteredCredentialBrokerHandler {
  handler: CredentialBrokerHandler;
  maxInputBytes: number;
  effect: "read" | "mutation";
  semanticTarget?: (context: CredentialBrokerContext) => string;
  reconcile?: CredentialBrokerRegistrationOptions["reconcile"];
}

const BROKER_NAME = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const ACTION_NAME = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MAX_INPUT_BYTES = 64 * 1024;
const MAX_CONFIGURED_INPUT_BYTES = 2 * 1024 * 1024;
const MAX_RESULT_BYTES = 256 * 1024;
const handlers = new Map<string, Map<string, RegisteredCredentialBrokerHandler>>();

interface InFlightCredentialBrokerCall {
  sourceId: string;
  request: DagCredentialBrokerCallRequest;
  controller: AbortController;
  effect: "read" | "mutation";
}

const inFlightCalls = new Map<string, InFlightCredentialBrokerCall>();

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonicalize(entry)]),
  );
}

function brokerRequestDigest(sourceId: string, request: DagCredentialBrokerCallRequest): string {
  return createHash("sha256").update(JSON.stringify(canonicalize({
    version: 1,
    source_id: sourceId,
    request,
  }))).digest("hex");
}

function boundedMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error))
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .slice(0, 1_000);
}

function transportPayload(request: DagCredentialBrokerCallRequest): Record<string, unknown> {
  return {
    runId: request.run_id,
    nodeId: request.node_id,
    round_id: request.round_id,
    actor_id: request.actor_id,
    generation: request.generation,
    lease_generation: request.lease_generation,
    command_id: request.command_id,
  };
}

function validateRequestContract(
  expectedKind: DagCredentialBrokerCallRequest["transport_kind"],
  request: DagCredentialBrokerCallRequest,
): string | undefined {
  for (const [label, value] of [
    ["request_id", request.request_id],
    ["idempotency_key", request.idempotency_key],
    ["run_id", request.run_id],
    ["node_id", request.node_id],
    ["session_id", request.session_id],
    ["round_id", request.round_id],
    ["credential_ref", request.credential_ref],
  ] as const) {
    if (typeof value !== "string" || !value.trim() || value.length > 256) return `${label} is invalid`;
  }
  if (request.transport_kind !== expectedKind) return `transport_kind must be ${expectedKind}`;
  if (expectedKind === "worker_actor") {
    if (typeof request.actor_id !== "string" || !request.actor_id || request.actor_id.length > 256) {
      return "worker broker actor_id is invalid";
    }
    if (!Number.isSafeInteger(request.generation) || Number(request.generation) < 1) {
      return "worker broker generation is invalid";
    }
    if (!Number.isSafeInteger(request.lease_generation) || Number(request.lease_generation) < 1) {
      return "worker broker lease_generation is invalid";
    }
    if (request.gateway_attempt !== undefined) return "worker broker cannot provide gateway_attempt";
  } else {
    if (!Number.isSafeInteger(request.gateway_attempt) || Number(request.gateway_attempt) < 1) {
      return "manager broker gateway_attempt is invalid";
    }
    if (
      request.actor_id !== undefined
      || request.generation !== undefined
      || request.lease_generation !== undefined
      || request.command_id !== undefined
    ) return "manager broker cannot provide Worker Actor fence fields";
  }
  if (!request.input || typeof request.input !== "object" || Array.isArray(request.input)) {
    return "credential broker input must be an object";
  }
  return undefined;
}

function assertWorkerAuthority(workerId: string, request: DagCredentialBrokerCallRequest): void {
  const assessment = assessDagTransportFence(
    transportPayload(request),
    { targetType: "worker", targetId: workerId },
    { renewExpiredLease: false },
  );
  if (assessment.status !== "current") {
    const reason = assessment.status === "ignored" || assessment.status === "malformed_payload"
      ? assessment.reason
      : assessment.status === "unknown_run"
        ? `unknown run ${assessment.runId}`
        : "credential broker transport is not current";
    throw new Error(reason);
  }
  const run = getActiveRun(request.run_id);
  if (!run || run.status !== "active" || run.dagRun.nodeStates.get(request.node_id) !== "RUNNING") {
    throw new Error("Credential broker Worker node is not running");
  }
  const session = getCurrentNodeSession(request.run_id, request.node_id);
  if (!session || session.sessionId !== request.session_id || session.status !== "running") {
    throw new Error("Credential broker Worker session is stale");
  }
}

function assertManagerAuthority(request: DagCredentialBrokerCallRequest): void {
  const run = getActiveRun(request.run_id);
  if (!run || run.status !== "active") throw new Error("Credential broker run is not active");
  if (run.currentRound.round_id !== request.round_id) throw new Error("Credential broker Manager round is stale");
  if (run.dagRun.nodeStates.get(request.node_id) !== "RUNNING") {
    throw new Error("Credential broker Manager gateway is not running");
  }
  const session = getCurrentNodeSession(request.run_id, request.node_id);
  if (
    !session
    || session.sessionId !== request.session_id
    || session.attempt !== request.gateway_attempt
    || session.status !== "running"
  ) throw new Error("Credential broker Manager gateway fence is stale");
}

function resultForFailure(
  request: DagCredentialBrokerCallRequest,
  outcome: DagCredentialBrokerCallResult["outcome"],
  error: string,
  requestDigest?: string,
  reconciliation?: DagCredentialBrokerCallResult["reconciliation"],
): DagCredentialBrokerCallResult {
  return {
    request_id: request.request_id,
    identity: dagCredentialBrokerCallIdentity(request),
    ok: false,
    outcome,
    ...(requestDigest ? { request_digest: requestDigest } : {}),
    error,
    ...(reconciliation ? { reconciliation } : {}),
  };
}

function sameCancellationFence(
  request: DagCredentialBrokerCallRequest,
  cancel: DagCredentialBrokerCancelRequest,
): boolean {
  return request.transport_kind === "worker_actor"
    && cancel.transport_kind === "worker_actor"
    && request.request_id === cancel.request_id
    && request.idempotency_key === cancel.idempotency_key
    && request.run_id === cancel.run_id
    && request.node_id === cancel.node_id
    && request.session_id === cancel.session_id
    && request.round_id === cancel.round_id
    && request.actor_id === cancel.actor_id
    && request.generation === cancel.generation
    && request.lease_generation === cancel.lease_generation
    && request.command_id === cancel.command_id;
}

function abortInFlightWhere(
  predicate: (call: InFlightCredentialBrokerCall) => boolean,
  reason: string,
): void {
  for (const call of inFlightCalls.values()) {
    if (!predicate(call) || call.controller.signal.aborted) continue;
    if (call.effect === "mutation") {
      const attempt = getCredentialBrokerMutationAttempt(call.request.request_id);
      if (attempt) {
        try { cancelCredentialBrokerMutationAttempt(attempt.request_id, reason); } catch { /* Completion won the race. */ }
      }
    }
    call.controller.abort(new Error(reason));
  }
}

export function cancelCredentialBrokerCall(
  workerId: string,
  cancel: DagCredentialBrokerCancelRequest,
): boolean {
  const call = inFlightCalls.get(cancel.request_id);
  if (!call || call.sourceId !== workerId || !sameCancellationFence(call.request, cancel)) return false;
  abortInFlightWhere((candidate) => candidate === call, "Credential broker caller cancelled the Actor turn");
  return true;
}

subscribe("dag:run_cancelled", (payload) => {
  const runId = (payload as { runId?: unknown }).runId;
  if (typeof runId === "string") abortInFlightWhere((call) => call.request.run_id === runId, "DAG run cancelled");
});
subscribe("dag:run_failed", (payload) => {
  const runId = (payload as { runId?: unknown }).runId;
  if (typeof runId === "string") abortInFlightWhere((call) => call.request.run_id === runId, "DAG run failed");
});
subscribe("dag:run_completed", (payload) => {
  const runId = (payload as { runId?: unknown }).runId;
  if (typeof runId === "string") abortInFlightWhere((call) => call.request.run_id === runId, "DAG run completed");
});
subscribe("dag:actor_intervention_applied", (payload) => {
  const data = payload as { runId?: unknown; actorId?: unknown };
  if (typeof data.runId === "string" && typeof data.actorId === "string") {
    abortInFlightWhere(
      (call) => call.request.run_id === data.runId && call.request.actor_id === data.actorId,
      "DAG Actor generation superseded",
    );
  }
});
subscribe("dag:actor_lease_released", (payload) => {
  const data = payload as { runId?: unknown; actorId?: unknown };
  if (typeof data.runId === "string" && typeof data.actorId === "string") {
    abortInFlightWhere(
      (call) => call.request.run_id === data.runId && call.request.actor_id === data.actorId,
      "DAG Actor lease released",
    );
  }
});

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
  options: CredentialBrokerRegistrationOptions = {},
): void {
  if (!BROKER_NAME.test(broker)) throw new Error("Invalid credential broker name");
  if (!ACTION_NAME.test(action)) throw new Error("Invalid credential broker action");
  const maxInputBytes = options.maxInputBytes ?? MAX_INPUT_BYTES;
  if (!Number.isSafeInteger(maxInputBytes) || maxInputBytes < 1 || maxInputBytes > MAX_CONFIGURED_INPUT_BYTES) {
    throw new Error(`Credential broker input limit must be 1-${MAX_CONFIGURED_INPUT_BYTES} bytes`);
  }
  const effect = options.effect ?? "read";
  if (effect === "mutation" && (!options.semanticTarget || !options.reconcile)) {
    throw new Error("Credential broker mutation handlers require semanticTarget and reconcile contracts");
  }
  if (effect === "read" && (options.semanticTarget || options.reconcile)) {
    throw new Error("Credential broker read handlers cannot declare mutation reconciliation contracts");
  }
  const actions = handlers.get(broker) ?? new Map<string, RegisteredCredentialBrokerHandler>();
  actions.set(action, {
    handler,
    maxInputBytes,
    effect,
    ...(options.semanticTarget ? { semanticTarget: options.semanticTarget } : {}),
    ...(options.reconcile ? { reconcile: options.reconcile } : {}),
  });
  handlers.set(broker, actions);
}

export async function invokeCredentialBroker(
  broker: string,
  action: string,
  context: CredentialBrokerContext,
): Promise<unknown> {
  const registered = handlers.get(broker)?.get(action);
  if (!registered) throw new Error(`Unsupported credential broker action: ${broker}/${action}`);
  if (safeJsonSize(context.input) > registered.maxInputBytes) {
    throw new Error(`Credential broker input exceeds ${registered.maxInputBytes} bytes`);
  }
  const result = await registered.handler({
    ...context,
    signal: context.signal ?? new AbortController().signal,
  });
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

async function executeDeclaredCredentialBrokerCall(
  actor: string,
  sourceId: string,
  expectedKind: DagCredentialBrokerCallRequest["transport_kind"],
  assertAuthority: (request: DagCredentialBrokerCallRequest) => void,
  request: DagCredentialBrokerCallRequest,
): Promise<DagCredentialBrokerCallResult> {
  const contractError = validateRequestContract(expectedKind, request);
  if (contractError) return resultForFailure(request, "failed_pre_dispatch", contractError);
  if (!BROKER_NAME.test(request.broker) || !ACTION_NAME.test(request.action)) {
    return resultForFailure(request, "failed_pre_dispatch", "Credential broker or action is invalid");
  }
  const registered = handlers.get(request.broker)?.get(request.action);
  if (inFlightCalls.has(request.request_id)) {
    return resultForFailure(request, "failed_pre_dispatch", "Credential broker request is already in flight");
  }
  const requestDigest = brokerRequestDigest(sourceId, request);
  const controller = new AbortController();
  const inFlight: InFlightCredentialBrokerCall = {
    sourceId,
    request: structuredClone(request),
    controller,
    effect: registered?.effect ?? "read",
  };
  inFlightCalls.set(request.request_id, inFlight);
  let binding;
  let materializedSecret: Readonly<Record<string, string>> | undefined;
  let mutationAttempt: CredentialBrokerMutationAttempt | undefined;
  const ensureAuthority = () => {
    if (controller.signal.aborted) throw controller.signal.reason ?? new Error("Credential broker call cancelled");
    assertAuthority(request);
  };
  try {
    ensureAuthority();
    binding = managerBrokerBinding(request.run_id, request.node_id, request.credential_ref);
    if (binding.broker !== request.broker || !binding.allowed_actions.includes(request.action)) {
      throw new Error("Credential broker action is not permitted by the WorkflowSpec");
    }
    if (!registered) {
      throw new Error(`Unsupported credential broker action: ${request.broker}/${request.action}`);
    }
    const useContext = {
      actor,
      run_id: request.run_id,
      node_id: request.node_id,
      purpose: binding.purpose,
      broker: request.broker,
      action: request.action,
    };
    const materialized = materializeCredential(request.credential_ref, useContext);
    materializedSecret = materialized.secret;
    const transport = Object.fromEntries(
      Object.entries(request).filter(([key]) => key !== "input"),
    ) as unknown as Omit<DagCredentialBrokerCallRequest, "input">;
    const baseContext: CredentialBrokerContext = {
      credential: materialized.record,
      secret: materialized.secret,
      input: request.input,
      transport,
      signal: controller.signal,
    };

    if (registered.effect === "read") {
      const result = await invokeCredentialBroker(request.broker, request.action, baseContext);
      ensureAuthority();
      recordActiveRunBrokerActionSuccess({
        run_id: request.run_id,
        node_id: request.node_id,
        session_id: request.session_id,
        credential_ref: request.credential_ref,
        broker: request.broker,
        action: request.action,
        result,
      });
      return {
        request_id: request.request_id,
        identity: dagCredentialBrokerCallIdentity(request),
        request_digest: requestDigest,
        ok: true,
        outcome: "completed",
        result,
      };
    }

    const semanticTarget = registered.semanticTarget!(baseContext).trim();
    let prepared = prepareCredentialBrokerMutation({
      request,
      request_digest: requestDigest,
      semantic_target: semanticTarget,
      source_id: sourceId,
    });
    if (prepared.status === "blocked") {
      const blocker = await reconcilePersistedCredentialBrokerMutation(prepared.attempt);
      if (blocker.state === "reconciled" && blocker.resolution !== "completed") {
        prepared = prepareCredentialBrokerMutation({
          request,
          request_digest: requestDigest,
          semantic_target: semanticTarget,
          source_id: sourceId,
        });
      } else {
        return resultForFailure(
          request,
          blocker.state === "reconciled" ? "reconciled" : "indeterminate",
          `Credential broker semantic target is owned by unresolved request ${blocker.request_id}`,
          requestDigest,
          blocker.state === "reconciled" ? blocker.resolution : undefined,
        );
      }
    }
    mutationAttempt = prepared.attempt;
    if (prepared.status === "duplicate") {
      const duplicate = ["prepared", "dispatched", "cancel_requested", "indeterminate"].includes(mutationAttempt.state)
        ? await reconcilePersistedCredentialBrokerMutation(mutationAttempt)
        : mutationAttempt;
      if (
        duplicate.state === "completed"
        || (duplicate.state === "reconciled" && duplicate.resolution === "completed")
      ) {
        ensureAuthority();
        recordActiveRunBrokerActionSuccess({
          run_id: request.run_id,
          node_id: request.node_id,
          session_id: request.session_id,
          credential_ref: request.credential_ref,
          broker: request.broker,
          action: request.action,
          result: duplicate.result,
        });
        return {
          request_id: request.request_id,
          identity: dagCredentialBrokerCallIdentity(request),
          request_digest: requestDigest,
          ok: true,
          outcome: duplicate.state === "completed" ? "completed" : "reconciled",
          ...(duplicate.state === "reconciled" ? { reconciliation: "completed" as const } : {}),
          result: duplicate.result,
        };
      }
      return attemptFailureResult(duplicate, requestDigest);
    }

    ensureAuthority();
    mutationAttempt = dispatchCredentialBrokerMutation(request.request_id);
    const mutationContext: CredentialBrokerContext = {
      ...baseContext,
      mutation: {
        request_digest: requestDigest,
        semantic_target: semanticTarget,
        checkpoint: (patch) => { checkpointCredentialBrokerMutation(request.request_id, patch); },
        assert_authority: ensureAuthority,
      },
    };
    const result = await invokeCredentialBroker(request.broker, request.action, mutationContext);
    try {
      ensureAuthority();
    } catch (authorityError) {
      mutationAttempt = reconcileCredentialBrokerMutation(request.request_id, "completed", { result });
      return resultForFailure(
        request,
        "reconciled",
        `Credential broker mutation completed after authority was revoked: ${boundedMessage(authorityError)}`,
        requestDigest,
        "completed",
      );
    }
    mutationAttempt = completeCredentialBrokerMutation(request.request_id, result);
    recordActiveRunBrokerActionSuccess({
      run_id: request.run_id,
      node_id: request.node_id,
      session_id: request.session_id,
      credential_ref: request.credential_ref,
      broker: request.broker,
      action: request.action,
      result,
    });
    return {
      request_id: request.request_id,
      identity: dagCredentialBrokerCallIdentity(request),
      request_digest: requestDigest,
      ok: true,
      outcome: "completed",
      result,
    };
  } catch (error) {
    const rawMessage = boundedMessage(error);
    const message = materializedSecret && Object.values(materializedSecret).some((value) => rawMessage.includes(value))
      ? "Credential broker call failed without exposing provider details"
      : rawMessage;
    if (request.credential_ref) {
      try {
        recordCredentialUseFailure(request.credential_ref, {
          actor,
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
    if (registered?.effect === "mutation") {
      if (!mutationAttempt) {
        return resultForFailure(
          request,
          controller.signal.aborted ? "cancelled" : "failed_pre_dispatch",
          message,
          requestDigest,
        );
      }
      const current = getCredentialBrokerMutationAttempt(mutationAttempt.request_id) ?? mutationAttempt;
      if (current.state === "prepared") {
        const terminal = controller.signal.aborted
          ? cancelCredentialBrokerMutationAttempt(current.request_id, message)
          : failCredentialBrokerMutationBeforeDispatch(current.request_id, message);
        return attemptFailureResult(terminal, requestDigest);
      }
      if (current.state === "dispatched" || current.state === "cancel_requested") {
        markCredentialBrokerMutationIndeterminate(current.request_id, message);
      }
      const reconciled = await reconcilePersistedCredentialBrokerMutation(
        getCredentialBrokerMutationAttempt(current.request_id) ?? current,
      );
      return attemptFailureResult(reconciled, requestDigest);
    }
    return resultForFailure(
      request,
      controller.signal.aborted ? "cancelled" : "failed",
      message,
      requestDigest,
    );
  } finally {
    if (inFlightCalls.get(request.request_id) === inFlight) inFlightCalls.delete(request.request_id);
  }
}

function attemptFailureResult(
  attempt: CredentialBrokerMutationAttempt,
  requestDigest = attempt.request_digest,
): DagCredentialBrokerCallResult {
  if (attempt.state === "completed") {
    return resultForFailure(
      attempt.request,
      "reconciled",
      "Credential broker mutation completed after the caller authority was revoked",
      requestDigest,
      "completed",
    );
  }
  if (attempt.state === "reconciled") {
    return resultForFailure(
      attempt.request,
      "reconciled",
      attempt.error_message ?? `Credential broker mutation reconciled as ${attempt.resolution}`,
      requestDigest,
      attempt.resolution,
    );
  }
  const outcome: DagCredentialBrokerCallResult["outcome"] = attempt.state === "failed_pre_dispatch"
    ? "failed_pre_dispatch"
    : attempt.state === "cancelled"
      ? "cancelled"
      : "indeterminate";
  return resultForFailure(
    attempt.request,
    outcome,
    attempt.error_message ?? `Credential broker mutation is ${attempt.state}`,
    requestDigest,
  );
}

function applyReconciliation(
  attempt: CredentialBrokerMutationAttempt,
  reconciliation: CredentialBrokerReconciliation,
  secret: Readonly<Record<string, string>>,
): CredentialBrokerMutationAttempt {
  if (reconciliation.resolution === "indeterminate") {
    const current = getCredentialBrokerMutationAttempt(attempt.request_id) ?? attempt;
    if (current.state === "dispatched" || current.state === "cancel_requested") {
      return markCredentialBrokerMutationIndeterminate(
        current.request_id,
        reconciliation.error ?? "Credential broker mutation outcome is indeterminate",
      );
    }
    return current;
  }
  if (reconciliation.resolution === "completed") {
    assertResultDoesNotRevealSecrets(reconciliation.result, secret);
    if (safeJsonSize(reconciliation.result) > MAX_RESULT_BYTES) {
      throw new Error("Credential broker reconciled result exceeds 256 KiB");
    }
    return reconcileCredentialBrokerMutation(attempt.request_id, "completed", { result: reconciliation.result });
  }
  return reconcileCredentialBrokerMutation(attempt.request_id, reconciliation.resolution, {
    // A provider validation failure is the useful caller-facing reason. The
    // read-back result proves only whether a write landed, so it must not
    // replace the original error with a generic "not dispatched" message.
    error: attempt.error_message
      ?? reconciliation.error
      ?? `Credential broker mutation reconciled as ${reconciliation.resolution}`,
  });
}

async function reconcilePersistedCredentialBrokerMutation(
  attempt: CredentialBrokerMutationAttempt,
): Promise<CredentialBrokerMutationAttempt> {
  if (attempt.state === "prepared") {
    return failCredentialBrokerMutationBeforeDispatch(
      attempt.request_id,
      "Credential broker mutation was durably prepared but never dispatched",
    );
  }
  if (!["dispatched", "cancel_requested", "indeterminate"].includes(attempt.state)) return attempt;
  const registered = handlers.get(attempt.broker)?.get(attempt.action);
  if (!registered?.reconcile) {
    if (attempt.state === "dispatched" || attempt.state === "cancel_requested") {
      return markCredentialBrokerMutationIndeterminate(
        attempt.request_id,
        "Credential broker mutation has no reconciliation handler",
      );
    }
    return attempt;
  }
  let secret: Readonly<Record<string, string>> | undefined;
  try {
    const materialized = materializeCredential(attempt.credential_ref, {
      actor: "credential-broker:recovery",
      run_id: attempt.run_id,
      node_id: attempt.node_id,
      purpose: "reconcile durable credential broker mutation",
      broker: attempt.broker,
      action: attempt.action,
    });
    secret = materialized.secret;
    const timeoutSignal = AbortSignal.timeout(30_000);
    const transport = Object.fromEntries(
      Object.entries(attempt.request).filter(([key]) => key !== "input"),
    ) as unknown as Omit<DagCredentialBrokerCallRequest, "input">;
    const reconciliation = await registered.reconcile({
      credential: materialized.record,
      secret: materialized.secret,
      input: attempt.request.input,
      transport,
      signal: timeoutSignal,
    }, attempt);
    return applyReconciliation(attempt, reconciliation, materialized.secret);
  } catch (error) {
    const raw = boundedMessage(error);
    const message = secret && Object.values(secret).some((value) => raw.includes(value))
      ? "Credential broker reconciliation failed without exposing provider details"
      : raw;
    const current = getCredentialBrokerMutationAttempt(attempt.request_id) ?? attempt;
    if (current.state === "dispatched" || current.state === "cancel_requested") {
      return markCredentialBrokerMutationIndeterminate(current.request_id, message);
    }
    return current;
  }
}

export interface CredentialBrokerRecoverySummary {
  reconciled: string[];
  unresolved: string[];
  failed: Array<{ request_id: string; error: string }>;
}

export async function recoverCredentialBrokerMutations(): Promise<CredentialBrokerRecoverySummary> {
  const summary: CredentialBrokerRecoverySummary = { reconciled: [], unresolved: [], failed: [] };
  for (const attempt of listUnresolvedCredentialBrokerMutations()) {
    try {
      const current = await reconcilePersistedCredentialBrokerMutation(attempt);
      if (current.state === "reconciled" || current.state === "failed_pre_dispatch") {
        summary.reconciled.push(current.request_id);
      } else {
        summary.unresolved.push(current.request_id);
      }
    } catch (error) {
      summary.failed.push({ request_id: attempt.request_id, error: boundedMessage(error) });
    }
  }
  return summary;
}

export async function executeCredentialBrokerCall(
  workerId: string,
  request: DagCredentialBrokerCallRequest,
): Promise<DagCredentialBrokerCallResult> {
  return await executeDeclaredCredentialBrokerCall(
    `credential-broker:worker:${workerId}`,
    workerId,
    "worker_actor",
    (candidate) => assertWorkerAuthority(workerId, candidate),
    request,
  );
}

export async function executeManagerCredentialBrokerCall(
  request: DagCredentialBrokerCallRequest,
): Promise<DagCredentialBrokerCallResult> {
  return await executeDeclaredCredentialBrokerCall(
    `credential-broker:manager:${request.node_id}`,
    `manager:${request.node_id}`,
    "manager_gateway",
    assertManagerAuthority,
    request,
  );
}

registerCredentialBroker("lark_bot", "bot_info", async ({ credential, secret, signal }) => {
  if (credential.credential_type !== "bot" || !secret.app_id || !secret.app_secret) {
    throw new Error("lark_bot requires a bot credential");
  }
  const tokenResponse = await fetch(
    "https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ app_id: secret.app_id, app_secret: secret.app_secret }),
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(10_000)])
        : AbortSignal.timeout(10_000),
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
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(10_000)])
      : AbortSignal.timeout(10_000),
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

registerCredentialBroker("github_pr", "pull_request_snapshot", githubPullRequestSnapshot);
registerCredentialBroker("github_pr", "read_file", githubReadFile);
registerCredentialBroker("github_pr", "read_diff", githubReadDiff);
registerCredentialBroker("github_pr", "assess_review", githubAssessReview);
registerCredentialBroker("github_pr", "checks_snapshot", githubChecksSnapshot);
registerCredentialBroker("github_pr", "required_checks", githubRequiredChecks);
registerCredentialBroker("github_pr", "validate_head", githubValidateHead);
registerCredentialBroker("github_pr", "commit_workspace", githubCommitWorkspace, {
  effect: "mutation",
  semanticTarget: githubMutationSemanticTarget,
  reconcile: githubReconcileMutation,
  maxInputBytes: MAX_CONFIGURED_INPUT_BYTES,
});
registerCredentialBroker("github_pr", "commit_files", githubCommitFiles, {
  effect: "mutation",
  semanticTarget: githubMutationSemanticTarget,
  reconcile: githubReconcileMutation,
  // A 1 MiB decoded commit expands to roughly 1.4 MiB as base64 plus bounded
  // JSON/path overhead. Other broker actions retain the 64 KiB default.
  maxInputBytes: MAX_CONFIGURED_INPUT_BYTES,
});
