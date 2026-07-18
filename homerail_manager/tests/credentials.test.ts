import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { dispatchEnvelopeAuditView } from "../src/orchestration/ws-dispatch-adapter.js";
import { parseWorkflowSource } from "../src/orchestration/workflow-spec-v1.js";
import { closeDb, getDb } from "../src/persistence/db.js";
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
  createActiveRun,
} from "../src/runtime/active-runs.js";
import {
  executeCredentialBrokerCall,
  invokeCredentialBroker,
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
    expectCurrentSchemaMigrationVersion(undefined, 31);
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

    const result = await executeCredentialBrokerCall("worker-1", {
      request_id: "request-1",
      run_id: "credential-broker-run",
      node_id: "work",
      session_id: "credential-broker-run",
      credential_ref: "broker-api",
      broker: "test_broker",
      action: "inspect",
      input: { question: "status" },
    });
    expect(result).toEqual({
      request_id: "request-1",
      ok: true,
      result: {
        credential_id: "broker-api",
        authorized: true,
        input: { question: "status" },
      },
    });
    expect(JSON.stringify(result)).not.toContain("broker-secret-value-123");

    const denied = await executeCredentialBrokerCall("worker-1", {
      request_id: "request-2",
      run_id: "credential-broker-run",
      node_id: "work",
      session_id: "credential-broker-run",
      credential_ref: "broker-api",
      broker: "test_broker",
      action: "delete",
      input: {},
    });
    expect(denied).toMatchObject({ ok: false, error: expect.stringContaining("not permitted") });
    const providerError = await executeCredentialBrokerCall("worker-1", {
      request_id: "request-3",
      run_id: "credential-broker-run",
      node_id: "work",
      session_id: "credential-broker-run",
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
    expect(listCredentialAuditEvents("broker-api")).toEqual(expect.arrayContaining([
      expect.objectContaining({
        event_type: "materialized",
        detail: expect.objectContaining({ broker: "test_broker", action: "inspect" }),
      }),
      expect.objectContaining({ event_type: "denied", result: "failed" }),
    ]));
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
        run_id: "run-transport",
        node_id: "node-transport",
        session_id: "session-transport",
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
        run_id: "run-transport",
        node_id: "node-transport",
        session_id: "session-transport",
        credential_ref: "credential-transport",
        broker: "test_broker",
        action: "inspect",
        input: "not-an-object",
      },
    })).toBeNull();
  });
});
