import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DagCredentialBrokerCallRequest } from "homerail-protocol";

import { dispatchEnvelopeAuditView } from "../src/orchestration/ws-dispatch-adapter.js";
import { parseWorkflowSource } from "../src/orchestration/workflow-spec-v1.js";
import { closeDb, getDb } from "../src/persistence/db.js";
import { acquireDagActorLease } from "../src/persistence/dag-actor-leases.js";
import { getCredentialBrokerMutationAttempt } from "../src/persistence/credential-broker-mutations.js";
import { expectCurrentSchemaMigrationVersion } from "./schema-migration-helpers.js";
import {
  createCredential,
  deleteCredential,
  getCredential,
  listCredentialAuditEvents,
  listCredentials,
  materializeCredential,
  revokeCredential,
  rotateCredential,
} from "../src/persistence/credentials.js";
import {
  _clearActiveRuns,
  buildCurrentDispatchEnvelope,
  cancelActiveRun,
  createActiveRun,
  getCurrentNodeSession,
  markNodeDispatched,
} from "../src/runtime/active-runs.js";
import {
  cancelCredentialBrokerCall,
  executeCredentialBrokerCall,
  executeManagerCredentialBrokerCall,
  invokeCredentialBroker,
  recoverCredentialBrokerMutations,
  registerCredentialBroker,
} from "../src/runtime/credential-broker.js";
import { parseIncomingMessage } from "../src/worker/types.js";

function workflow(credentials: string): string {
  return `
api_version: homerail.ai/v1
kind: Workflow
metadata: { id: credential-test, name: Credential test }
spec:
  contracts:
    Task: { type: object }
  agents:
    worker: { system: "Use the credential" }
  nodes:
    work:
      kind: agent
      agent: worker
      allowed_dag_tools: [handoff, credential_broker_call]
      credentials:
${credentials.replace(/^/gm, "        ")}
      inputs: { task: { contract: Task } }
      outputs: { done: {} }
    done: { kind: terminal, outcome: success, inputs: { result: {} } }
  edges:
    - { from: $run.input, to: work.task }
    - { from: work.done, to: done.result }
`;
}

function startWorkerBrokerFence(
  runId: string,
  nodeId = "work",
  workerId = "worker-1",
): Pick<
  DagCredentialBrokerCallRequest,
  "transport_kind" | "run_id" | "node_id" | "session_id" | "round_id"
  | "actor_id" | "generation" | "lease_generation" | "command_id"
> {
  const built = buildCurrentDispatchEnvelope(runId, nodeId);
  if (!built.ok || !built.envelope.sessionId || !built.envelope.activity) {
    throw new Error(`could not build broker test fence for ${runId}/${nodeId}`);
  }
  const lease = acquireDagActorLease({
    run_id: runId,
    actor_id: built.envelope.activity.actorId,
    target_type: "worker",
    target_id: workerId,
  });
  if (!markNodeDispatched(runId, nodeId)) throw new Error("could not start broker test node");
  return {
    transport_kind: "worker_actor",
    run_id: runId,
    node_id: nodeId,
    session_id: built.envelope.sessionId,
    round_id: built.envelope.activity.roundId,
    actor_id: built.envelope.activity.actorId,
    generation: built.envelope.activity.generation,
    lease_generation: lease.lease_generation,
    ...(built.envelope.activity.commandId
      ? { command_id: built.envelope.activity.commandId }
      : {}),
  };
}

describe("generic credential store", () => {
  let home: string;
  let previousHome: string | undefined;

  beforeEach(() => {
    previousHome = process.env.HOMERAIL_HOME;
    home = fs.mkdtempSync(path.join(os.tmpdir(), "homerail-credentials-"));
    process.env.HOMERAIL_HOME = home;
    closeDb();
    _clearActiveRuns();
  });

  afterEach(() => {
    _clearActiveRuns();
    closeDb();
    if (previousHome === undefined) delete process.env.HOMERAIL_HOME;
    else process.env.HOMERAIL_HOME = previousHome;
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("encrypts values, never returns plaintext, rotates, revokes, and preserves audit after delete", () => {
    const secret = "sk-credential-plain-value";
    const created = createCredential({
      id: "demo-api",
      credential_type: "api_key",
      name: "Demo API",
      secret: { value: secret },
      metadata: { scopes: ["read"] },
    }, { actor: "test" });
    expect(created).toMatchObject({ status: "active", version: 1, secret_fields: ["value"] });
    expect(JSON.stringify(created)).not.toContain(secret);
    const stored = getDb().prepare(
      "SELECT encrypted_payload FROM execution_credentials WHERE id = ?",
    ).get("demo-api") as { encrypted_payload: string };
    expect(stored.encrypted_payload).not.toContain(secret);

    expect(materializeCredential("demo-api", {
      actor: "dag:test:node",
      run_id: "run-1",
      node_id: "node-1",
      purpose: "test call",
    }).secret.value).toBe(secret);
    const rotated = rotateCredential("demo-api", { secret: { value: "replacement" } }, { actor: "test" });
    expect(rotated.version).toBe(2);
    expect(materializeCredential("demo-api", { actor: "test" }).secret.value).toBe("replacement");
    expect(revokeCredential("demo-api", { actor: "test" }).status).toBe("revoked");
    expect(() => materializeCredential("demo-api", { actor: "test" })).toThrow("revoked");

    deleteCredential("demo-api", { actor: "test" });
    expect(getCredential("demo-api")).toBeUndefined();
    expect(listCredentialAuditEvents("demo-api").map((event) => event.event_type)).toEqual([
      "created",
      "materialized",
      "rotated",
      "materialized",
      "revoked",
      "denied",
      "deleted",
    ]);
    expect(JSON.stringify(listCredentialAuditEvents("demo-api"))).not.toContain(secret);
    expectCurrentSchemaMigrationVersion(undefined, 37);
  });

  it("does not reinterpret legacy encrypted_credentials rows as execution credentials", () => {
    getDb().prepare(`
      INSERT INTO encrypted_credentials(
        id, credential_type, name, encrypted_payload, metadata, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      "legacy-row",
      "legacy",
      "Legacy compatibility row",
      "legacy-payload-format",
      "{}",
      "2026-01-01T00:00:00.000Z",
      "2026-01-01T00:00:00.000Z",
    );
    expect(listCredentials()).toEqual([]);
    expect(getDb().prepare("SELECT id FROM encrypted_credentials WHERE id = ?").get("legacy-row"))
      .toEqual({ id: "legacy-row" });
  });

  it("compiles only credential references and redacts materialized dispatch payloads from audit", () => {
    createCredential({
      id: "lark-bot",
      credential_type: "bot",
      name: "Lark bot",
      secret: { app_id: "cli_demo", app_secret: "bot-secret-not-for-logs" },
    }, { actor: "test" });
    const parsed = parseWorkflowSource(workflow(`- credential_ref: lark-bot
  purpose: publish a document
  inject:
    mode: env
    mappings:
      app_id: LARK_APP_ID
      app_secret: LARK_APP_SECRET`));
    parsed.meta.agents!.worker.agent_type = "deterministic";
    createActiveRun("credential-dispatch", parsed);
    const built = buildCurrentDispatchEnvelope("credential-dispatch", "work");
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.envelope.credentialProjections).toEqual([expect.objectContaining({
      credential_ref: "lark-bot",
      mode: "env",
      values: { LARK_APP_ID: "cli_demo", LARK_APP_SECRET: "bot-secret-not-for-logs" },
    })]);
    const audit = JSON.stringify(dispatchEnvelopeAuditView(built.envelope));
    expect(audit).not.toContain("cli_demo");
    expect(audit).not.toContain("bot-secret-not-for-logs");
    expect(audit).toContain("LARK_APP_SECRET");
  });

  it("rejects inline secret fields in WorkflowSpec", () => {
    expect(() => parseWorkflowSource(workflow(`- credential_ref: lark-bot
  purpose: publish
  secret: should-never-compile
  inject:
    mode: env
  mappings: { app_secret: LARK_APP_SECRET }`))).toThrow(/DAG_SCHEMA_INVALID_FIELD/);
  });

  it("requires the credential broker tool for manager_broker bindings", () => {
    const source = workflow([
      "- credential_ref: lark-bot",
      "  purpose: inspect the bot",
      "  inject:",
      "    mode: manager_broker",
      "    broker: lark_bot",
      "    allowed_actions: [bot_info]",
    ].join("\n")).replace(
      "allowed_dag_tools: [handoff, credential_broker_call]",
      "allowed_dag_tools: [handoff]",
    );
    expect(() => parseWorkflowSource(source)).toThrow(/DAG_SEMANTIC_CREDENTIAL_BROKER_TOOL_REQUIRED/);
  });

  it("keeps Manager broker secrets host-side and enforces declared actions", async () => {
    createCredential({
      id: "broker-api",
      credential_type: "api_key",
      name: "Broker API",
      secret: { value: "broker-secret-value-123" },
    }, { actor: "test" });
    registerCredentialBroker("test_broker", "inspect", async ({ credential, secret, input }) => {
      if (input.throw_secret === true) throw new Error(secret.value);
      return {
        credential_id: credential.id,
        authorized: secret.value === "broker-secret-value-123",
        input,
      };
    });
    const parsed = parseWorkflowSource(workflow([
      "- credential_ref: broker-api",
      "  purpose: inspect through Manager",
      "  inject:",
      "    mode: manager_broker",
      "    broker: test_broker",
      "    allowed_actions: [inspect]",
    ].join("\n")));
    parsed.meta.agents!.worker.agent_type = "deterministic";
    createActiveRun("credential-broker-run", parsed);
    const fence = startWorkerBrokerFence("credential-broker-run");

    const result = await executeCredentialBrokerCall("worker-1", {
      request_id: "request-1",
      idempotency_key: "request-1",
      ...fence,
      credential_ref: "broker-api",
      broker: "test_broker",
      action: "inspect",
      input: { question: "status" },
    });
    expect(result).toMatchObject({
      request_id: "request-1",
      ok: true,
      outcome: "completed",
      result: {
        credential_id: "broker-api",
        authorized: true,
        input: { question: "status" },
      },
    });
    expect(JSON.stringify(result)).not.toContain("broker-secret-value-123");

    const denied = await executeCredentialBrokerCall("worker-1", {
      request_id: "request-2",
      idempotency_key: "request-2",
      ...fence,
      credential_ref: "broker-api",
      broker: "test_broker",
      action: "delete",
      input: {},
    });
    expect(denied).toMatchObject({ ok: false, error: expect.stringContaining("not permitted") });
    const providerError = await executeCredentialBrokerCall("worker-1", {
      request_id: "request-3",
      idempotency_key: "request-3",
      ...fence,
      credential_ref: "broker-api",
      broker: "test_broker",
      action: "inspect",
      input: { throw_secret: true },
    });
    expect(providerError).toMatchObject({
      ok: false,
      error: "Credential broker call failed without exposing provider details",
    });
    expect(JSON.stringify(providerError)).not.toContain("broker-secret-value-123");
    expect(getDb().prepare("SELECT COUNT(*) AS count FROM credential_broker_mutation_attempts").get())
      .toEqual({ count: 0 });
    expect(listCredentialAuditEvents("broker-api")).toEqual(expect.arrayContaining([
      expect.objectContaining({
        event_type: "materialized",
        detail: expect.objectContaining({ broker: "test_broker", action: "inspect" }),
      }),
      expect.objectContaining({ event_type: "denied", result: "failed" }),
    ]));
  });

  it("records a late mutation as reconciled instead of reporting stale success", async () => {
    createCredential({
      id: "mutation-api",
      credential_type: "api_key",
      name: "Mutation API",
      secret: { value: "mutation-secret" },
    }, { actor: "test" });
    let release!: () => void;
    let started!: () => void;
    const entered = new Promise<void>((resolve) => { started = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let mutations = 0;
    registerCredentialBroker("mutation_race", "write", async () => {
      started();
      await gate;
      mutations += 1;
      return { revision: mutations };
    }, {
      effect: "mutation",
      semanticTarget: () => "resource:one",
      reconcile: async () => ({ resolution: "indeterminate" }),
    });
    const parsed = parseWorkflowSource(workflow([
      "- credential_ref: mutation-api",
      "  purpose: mutate through Manager",
      "  inject:",
      "    mode: manager_broker",
      "    broker: mutation_race",
      "    allowed_actions: [write]",
    ].join("\n")));
    parsed.meta.agents!.worker.agent_type = "deterministic";
    createActiveRun("credential-mutation-race", parsed);
    const fence = startWorkerBrokerFence("credential-mutation-race");
    const pending = executeCredentialBrokerCall("worker-1", {
      request_id: "mutation-race-request",
      idempotency_key: "mutation-race-request",
      ...fence,
      credential_ref: "mutation-api",
      broker: "mutation_race",
      action: "write",
      input: {},
    });

    await entered;
    cancelActiveRun("credential-mutation-race");
    release();

    await expect(pending).resolves.toMatchObject({
      ok: false,
      outcome: "reconciled",
      reconciliation: "completed",
    });
    expect(mutations).toBe(1);
    expect(getCredentialBrokerMutationAttempt("mutation-race-request")).toMatchObject({
      state: "reconciled",
      resolution: "completed",
      result: { revision: 1 },
    });
  });

  it("accepts cancellation only for the exact in-flight Actor fence", async () => {
    createCredential({
      id: "cancel-api",
      credential_type: "api_key",
      name: "Cancel API",
      secret: { value: "cancel-secret" },
    }, { actor: "test" });
    let started!: () => void;
    const entered = new Promise<void>((resolve) => { started = resolve; });
    registerCredentialBroker("cancel_mutation", "write", async ({ signal }) => {
      started();
      await new Promise<never>((_resolve, reject) => {
        signal!.addEventListener("abort", () => reject(signal!.reason), { once: true });
      });
    }, {
      effect: "mutation",
      semanticTarget: () => "resource:cancel",
      reconcile: async () => ({ resolution: "absent" }),
    });
    const parsed = parseWorkflowSource(workflow([
      "- credential_ref: cancel-api",
      "  purpose: cancel an in-flight mutation",
      "  inject:",
      "    mode: manager_broker",
      "    broker: cancel_mutation",
      "    allowed_actions: [write]",
    ].join("\n")));
    parsed.meta.agents!.worker.agent_type = "deterministic";
    createActiveRun("credential-cancel-fence", parsed);
    const fence = startWorkerBrokerFence("credential-cancel-fence");
    if (fence.transport_kind !== "worker_actor") throw new Error("expected Worker fence");
    const request: DagCredentialBrokerCallRequest = {
      request_id: "cancel-request",
      idempotency_key: "cancel-request",
      ...fence,
      credential_ref: "cancel-api",
      broker: "cancel_mutation",
      action: "write",
      input: {},
    };
    const pending = executeCredentialBrokerCall("worker-1", request);
    await entered;

    expect(cancelCredentialBrokerCall("worker-1", {
      request_id: request.request_id,
      idempotency_key: request.idempotency_key,
      transport_kind: "worker_actor",
      run_id: request.run_id,
      node_id: request.node_id,
      session_id: request.session_id,
      round_id: request.round_id,
      actor_id: request.actor_id,
      generation: request.generation + 1,
      lease_generation: request.lease_generation,
    })).toBe(false);
    expect(cancelCredentialBrokerCall("worker-1", {
      request_id: request.request_id,
      idempotency_key: request.idempotency_key,
      transport_kind: "worker_actor",
      run_id: request.run_id,
      node_id: request.node_id,
      session_id: request.session_id,
      round_id: request.round_id,
      actor_id: request.actor_id,
      generation: request.generation,
      lease_generation: request.lease_generation,
    })).toBe(true);

    await expect(pending).resolves.toMatchObject({
      ok: false,
      outcome: "reconciled",
      reconciliation: "absent",
    });
    expect(getCredentialBrokerMutationAttempt("cancel-request")).toMatchObject({
      state: "reconciled",
      resolution: "absent",
    });
  });

  it("applies the same late-mutation reconciliation to Manager-originated calls", async () => {
    createCredential({
      id: "manager-mutation-api",
      credential_type: "api_key",
      name: "Manager Mutation API",
      secret: { value: "manager-mutation-secret" },
    }, { actor: "test" });
    let release!: () => void;
    let started!: () => void;
    const entered = new Promise<void>((resolve) => { started = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    registerCredentialBroker("manager_mutation", "write", async () => {
      started();
      await gate;
      return { revision: 7 };
    }, {
      effect: "mutation",
      semanticTarget: () => "resource:manager",
      reconcile: async () => ({ resolution: "indeterminate" }),
    });
    const parsed = parseWorkflowSource(workflow([
      "- credential_ref: manager-mutation-api",
      "  purpose: Manager-owned mutation",
      "  inject:",
      "    mode: manager_broker",
      "    broker: manager_mutation",
      "    allowed_actions: [write]",
    ].join("\n")));
    parsed.meta.agents!.worker.agent_type = "deterministic";
    createActiveRun("credential-manager-race", parsed);
    const workerFence = startWorkerBrokerFence("credential-manager-race");
    const session = getCurrentNodeSession("credential-manager-race", "work");
    if (!session) throw new Error("missing Manager broker test session");
    const pending = executeManagerCredentialBrokerCall({
      request_id: "manager-race-request",
      idempotency_key: "manager-race-request",
      transport_kind: "manager_gateway",
      run_id: "credential-manager-race",
      node_id: "work",
      session_id: workerFence.session_id,
      round_id: workerFence.round_id,
      gateway_attempt: session.attempt,
      credential_ref: "manager-mutation-api",
      broker: "manager_mutation",
      action: "write",
      input: {},
    });

    await entered;
    cancelActiveRun("credential-manager-race");
    release();

    await expect(pending).resolves.toMatchObject({
      ok: false,
      outcome: "reconciled",
      reconciliation: "completed",
    });
    expect(getCredentialBrokerMutationAttempt("manager-race-request")).toMatchObject({
      source_type: "manager_gateway",
      gateway_attempt: session.attempt,
      state: "reconciled",
      resolution: "completed",
    });
  });

  it("deduplicates a completed mutation by its durable request identity", async () => {
    createCredential({
      id: "idempotent-api",
      credential_type: "api_key",
      name: "Idempotent API",
      secret: { value: "idempotent-secret" },
    }, { actor: "test" });
    let mutations = 0;
    registerCredentialBroker("idempotent_mutation", "write", async () => ({ revision: ++mutations }), {
      effect: "mutation",
      semanticTarget: () => "resource:idempotent",
      reconcile: async () => ({ resolution: "indeterminate" }),
    });
    const parsed = parseWorkflowSource(workflow([
      "- credential_ref: idempotent-api",
      "  purpose: mutate exactly once",
      "  inject:",
      "    mode: manager_broker",
      "    broker: idempotent_mutation",
      "    allowed_actions: [write]",
    ].join("\n")));
    parsed.meta.agents!.worker.agent_type = "deterministic";
    createActiveRun("credential-idempotency", parsed);
    const request: DagCredentialBrokerCallRequest = {
      request_id: "idempotent-request",
      idempotency_key: "idempotent-request",
      ...startWorkerBrokerFence("credential-idempotency"),
      credential_ref: "idempotent-api",
      broker: "idempotent_mutation",
      action: "write",
      input: {},
    };

    await expect(executeCredentialBrokerCall("worker-1", {
      ...request,
      request_id: "stale-lease-request",
      idempotency_key: "stale-lease-request",
      lease_generation: request.lease_generation + 1,
    })).resolves.toMatchObject({ ok: false, outcome: "failed_pre_dispatch" });
    expect(mutations).toBe(0);
    expect(getCredentialBrokerMutationAttempt("stale-lease-request")).toBeUndefined();

    const first = await executeCredentialBrokerCall("worker-1", request);
    const duplicate = await executeCredentialBrokerCall("worker-1", request);

    expect(first).toMatchObject({ ok: true, outcome: "completed", result: { revision: 1 } });
    expect(duplicate).toMatchObject({ ok: true, outcome: "completed", result: { revision: 1 } });
    expect(mutations).toBe(1);
    expect(getDb().prepare(`
      SELECT state FROM credential_broker_mutation_events
      WHERE request_id = ? ORDER BY sequence
    `).all("idempotent-request")).toEqual([
      { state: "prepared" },
      { state: "dispatched" },
      { state: "completed" },
    ]);
    expect(() => getDb().prepare(`
      UPDATE credential_broker_mutation_attempts SET semantic_target = 'tampered'
      WHERE request_id = 'idempotent-request'
    `).run()).toThrow(/identity is immutable/);
    expect(() => getDb().prepare(`
      DELETE FROM credential_broker_mutation_events WHERE request_id = 'idempotent-request'
    `).run()).toThrow(/append-only/);

    getDb().prepare("DELETE FROM schema_migrations WHERE version = 37").run();
    closeDb();
    expectCurrentSchemaMigrationVersion(undefined, 37);
    expect(getCredentialBrokerMutationAttempt("idempotent-request")).toMatchObject({
      state: "completed",
      result: { revision: 1 },
    });
  });

  it("blocks conflicting mutations until recovery reconciles the uncertain attempt", async () => {
    createCredential({
      id: "recover-api",
      credential_type: "api_key",
      name: "Recover API",
      secret: { value: "recover-secret" },
    }, { actor: "test" });
    let calls = 0;
    let observed = false;
    registerCredentialBroker("recover_mutation", "write", async () => {
      calls += 1;
      throw new Error("provider response lost");
    }, {
      effect: "mutation",
      semanticTarget: () => "resource:shared",
      reconcile: async () => observed
        ? { resolution: "completed", result: { revision: 42 } }
        : { resolution: "indeterminate" },
    });
    const parsed = parseWorkflowSource(workflow([
      "- credential_ref: recover-api",
      "  purpose: mutate with recovery",
      "  inject:",
      "    mode: manager_broker",
      "    broker: recover_mutation",
      "    allowed_actions: [write]",
    ].join("\n")));
    parsed.meta.agents!.worker.agent_type = "deterministic";
    createActiveRun("credential-recovery", parsed);
    const fence = startWorkerBrokerFence("credential-recovery");
    const makeRequest = (id: string): DagCredentialBrokerCallRequest => ({
      request_id: id,
      idempotency_key: id,
      ...fence,
      credential_ref: "recover-api",
      broker: "recover_mutation",
      action: "write",
      input: {},
    });

    await expect(executeCredentialBrokerCall("worker-1", makeRequest("uncertain-request")))
      .resolves.toMatchObject({ ok: false, outcome: "indeterminate" });
    await expect(executeCredentialBrokerCall("worker-1", makeRequest("blocked-request")))
      .resolves.toMatchObject({ ok: false, outcome: "indeterminate" });
    expect(calls).toBe(1);

    observed = true;
    await expect(recoverCredentialBrokerMutations()).resolves.toMatchObject({
      reconciled: ["uncertain-request"],
      unresolved: [],
      failed: [],
    });
    expect(getCredentialBrokerMutationAttempt("uncertain-request")).toMatchObject({
      state: "reconciled",
      resolution: "completed",
      result: { revision: 42 },
    });
  });

  it("rejects broker results that reflect a secret", async () => {
    registerCredentialBroker("reflection_test", "echo", async ({ secret }) => ({
      echoed: `reflected:${secret.value}`,
    }));
    await expect(invokeCredentialBroker("reflection_test", "echo", {
      credential: {
        id: "reflection",
        credential_type: "api_key",
        name: "Reflection",
        status: "active",
        version: 1,
        secret_fields: ["value"],
        metadata: {},
        created_at: "2026-01-01T00:00:00.000Z",
        updated_at: "2026-01-01T00:00:00.000Z",
      },
      secret: { value: "must-not-leak-secret" },
      input: {},
    })).rejects.toThrow("reflected a secret");

    await expect(invokeCredentialBroker("reflection_test", "echo", {
      credential: {
        id: "short-reflection",
        credential_type: "api_key",
        name: "Short reflection",
        status: "active",
        version: 1,
        secret_fields: ["value"],
        metadata: {},
        created_at: "2026-01-01T00:00:00.000Z",
        updated_at: "2026-01-01T00:00:00.000Z",
      },
      secret: { value: "x" },
      input: {},
    })).rejects.toThrow("reflected a secret");
  });

  it("accepts complete broker transport messages and rejects malformed input", () => {
    expect(parseIncomingMessage({
      type: "credential_broker_call",
      data: {
        request_id: "request-transport",
        idempotency_key: "request-transport",
        transport_kind: "worker_actor",
        run_id: "run-transport",
        node_id: "node-transport",
        session_id: "session-transport",
        round_id: "round-transport",
        actor_id: "actor-transport",
        generation: 1,
        lease_generation: 1,
        credential_ref: "credential-transport",
        broker: "test_broker",
        action: "inspect",
        input: { question: "status" },
      },
    })).toMatchObject({
      type: "credential_broker_call",
      data: { request_id: "request-transport", action: "inspect" },
    });
    expect(parseIncomingMessage({
      type: "credential_broker_call",
      data: {
        request_id: "request-transport",
        idempotency_key: "request-transport",
        transport_kind: "worker_actor",
        run_id: "run-transport",
        node_id: "node-transport",
        session_id: "session-transport",
        round_id: "round-transport",
        actor_id: "actor-transport",
        generation: 1,
        lease_generation: 1,
        credential_ref: "credential-transport",
        broker: "test_broker",
        action: "inspect",
        input: "not-an-object",
      },
    })).toBeNull();
    expect(parseIncomingMessage({
      type: "credential_broker_cancel",
      data: {
        request_id: "request-transport",
        idempotency_key: "request-transport",
        transport_kind: "worker_actor",
        run_id: "run-transport",
        node_id: "node-transport",
        session_id: "session-transport",
        round_id: "round-transport",
        actor_id: "actor-transport",
        generation: 1,
        lease_generation: 1,
      },
    })).toMatchObject({
      type: "credential_broker_cancel",
      data: { request_id: "request-transport", lease_generation: 1 },
    });
  });
});
