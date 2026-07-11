import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { closeDb } from "../src/persistence/db.js";
import { createPendingApproval, getApproval, getDagState } from "../src/persistence/dag-runtime-primitives.js";
import { createServer } from "../src/server/http.js";
import { _clearActiveRuns, getActiveRun, recoverAllActiveRuns } from "../src/runtime/active-runs.js";

const AUTH_WORKFLOW = `
api_version: homerail.ai/v1
kind: Workflow
metadata: { id: auth-workflow, name: Auth Workflow }
spec:
  agents: {}
  nodes:
    done: { kind: terminal, outcome: success }
  edges: []
`;

const COMPETING_BUDGET_WORKFLOW = `
api_version: homerail.ai/v1
kind: Workflow
metadata: { id: http-budget-gate, name: HTTP Budget Gate }
spec:
  contracts:
    Work:
      type: object
      required: [expected_usage]
      properties: { expected_usage: { type: number, minimum: 0 } }
  agents: {}
  nodes:
    gate:
      kind: state
      inputs: { work: { contract: Work } }
      outputs: { admit: {}, block: {} }
      config:
        namespace: budget
        key: http-shared
        operation: budget_admit
        value_field: expected_usage
        budget_limit: 5
        success_port: admit
        conflict_port: block
    admitted: { kind: terminal, outcome: success, inputs: { result: {} } }
    blocked: { kind: terminal, outcome: cancelled, inputs: { result: {} } }
  edges:
    - { from: $run.input, to: gate.work }
    - { from: gate.admit, to: admitted.result }
    - { from: gate.block, to: blocked.result }
`;

const RESTART_APPROVAL_WORKFLOW = `
api_version: homerail.ai/v1
kind: Workflow
metadata: { id: http-restart-approval, name: HTTP Restart Approval }
spec:
  agents: {}
  nodes:
    approve:
      kind: approval
      outputs: { approved: {}, rejected: {} }
      config:
        approval_id: release
        proposer_actor: agent:release-proposer
        authorized_actors: [matrix]
        approved_port: approved
        rejected_port: rejected
    accepted: { kind: terminal, outcome: success, inputs: { result: {} } }
    denied: { kind: terminal, outcome: failure, inputs: { result: {} } }
  edges:
    - { from: approve.approved, to: accepted.result }
    - { from: approve.rejected, to: denied.result, condition: on_failure }
`;

async function listen(server: http.Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address !== "object") throw new Error("server did not bind");
  return address.port;
}

async function close(server: http.Server): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

describe("DAG patterns API", () => {
  let server: http.Server;
  let baseUrl: string;
  let tmpHome: string;
  let oldHome: string | undefined;
  let oldMutationToken: string | undefined;
  let oldApprovalToken: string | undefined;

  beforeEach(async () => {
    oldHome = process.env.HOMERAIL_HOME;
    oldMutationToken = process.env.HOMERAIL_DAG_MUTATION_TOKEN;
    oldApprovalToken = process.env.HOMERAIL_DAG_APPROVAL_TOKEN;
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "homerail-dag-pattern-api-"));
    process.env.HOMERAIL_HOME = tmpHome;
    closeDb();
    server = createServer(0, undefined, undefined, false);
    baseUrl = `http://127.0.0.1:${await listen(server)}`;
  });

  afterEach(async () => {
    await close(server);
    closeDb();
    if (oldHome === undefined) delete process.env.HOMERAIL_HOME;
    else process.env.HOMERAIL_HOME = oldHome;
    if (oldMutationToken === undefined) delete process.env.HOMERAIL_DAG_MUTATION_TOKEN;
    else process.env.HOMERAIL_DAG_MUTATION_TOKEN = oldMutationToken;
    if (oldApprovalToken === undefined) delete process.env.HOMERAIL_DAG_APPROVAL_TOKEN;
    else process.env.HOMERAIL_DAG_APPROVAL_TOKEN = oldApprovalToken;
    _clearActiveRuns();
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it("admits only one of two concurrent Budget Gate HTTP run requests", async () => {
    process.env.HOMERAIL_DAG_MUTATION_TOKEN = "mutation-secret";
    const headers = { "Content-Type": "application/json", "x-homerail-dag-token": "mutation-secret" };
    const sync = await fetch(`${baseUrl}/api/dag/workflows/sync`, {
      method: "POST",
      headers,
      body: JSON.stringify({ yaml_text: COMPETING_BUDGET_WORKFLOW }),
    });
    expect(sync.status).toBe(201);

    for (const runId of ["http-budget-1", "http-budget-2"]) {
      const created = await fetch(`${baseUrl}/api/runs`, {
        method: "POST",
        headers,
        body: JSON.stringify({ workflow_id: "http-budget-gate", runId, prompt: JSON.stringify({ expected_usage: 3 }) }),
      });
      expect(created.status).toBe(201);
    }

    const invoked = await Promise.all(["http-budget-1", "http-budget-2"].map((runId) => fetch(
      `${baseUrl}/api/runs/${runId}/invoke`,
      { method: "POST", headers },
    )));
    expect(invoked.map((response) => response.status)).toEqual([200, 200]);
    const runs = [getActiveRun("http-budget-1"), getActiveRun("http-budget-2")];
    expect(runs.filter((run) => run?.status === "completed")).toHaveLength(1);
    expect(runs.filter((run) => run?.status === "cancelled")).toHaveLength(1);
    expect(getDagState("budget", "http-shared")).toMatchObject({ version: 1, value: 3 });
  });

  it("preserves approval safety across an HTTP Manager restart", async () => {
    process.env.HOMERAIL_DAG_MUTATION_TOKEN = "mutation-secret";
    process.env.HOMERAIL_DAG_APPROVAL_TOKEN = "approval-secret";
    const mutationHeaders = { "Content-Type": "application/json", "x-homerail-dag-token": "mutation-secret" };
    expect((await fetch(`${baseUrl}/api/dag/workflows/sync`, {
      method: "POST",
      headers: mutationHeaders,
      body: JSON.stringify({ yaml_text: RESTART_APPROVAL_WORKFLOW }),
    })).status).toBe(201);
    expect((await fetch(`${baseUrl}/api/runs`, {
      method: "POST",
      headers: mutationHeaders,
      body: JSON.stringify({ workflow_id: "http-restart-approval", runId: "http-approval-run" }),
    })).status).toBe(201);
    expect((await fetch(`${baseUrl}/api/runs/http-approval-run/invoke`, {
      method: "POST",
      headers: mutationHeaders,
    })).status).toBe(200);
    const pending = getApproval("http-approval-run", "approve")!;

    // Simulate a legacy row that bypassed the current DSL self-approval diagnostic.
    const { getDb } = await import("../src/persistence/db.js");
    getDb().prepare("UPDATE dag_approvals SET authorized_actors = ? WHERE run_id = ? AND node_id = ?")
      .run(JSON.stringify(["agent:release-proposer", "matrix"]), "http-approval-run", "approve");

    await close(server);
    _clearActiveRuns();
    closeDb();
    server = createServer(0, undefined, undefined, false);
    expect(recoverAllActiveRuns().recovered).toContain("http-approval-run");
    baseUrl = `http://127.0.0.1:${await listen(server)}`;

    const approvalUrl = `${baseUrl}/api/runs/http-approval-run/node/approve/approval`;
    const selfApproval = await fetch(approvalUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-homerail-approval-token": "approval-secret" },
      body: JSON.stringify({
        decision: "approved",
        actor: "agent:release-proposer",
        proposal_hash: pending.proposal_hash,
      }),
    });
    expect(selfApproval.status).toBe(400);
    expect(await selfApproval.json()).toMatchObject({ error: expect.stringContaining("cannot approve its own proposal") });

    const humanApproval = await fetch(approvalUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-homerail-approval-token": "approval-secret" },
      body: JSON.stringify({ decision: "approved", actor: "matrix", proposal_hash: pending.proposal_hash }),
    });
    expect(humanApproval.status).toBe(200);
    expect(() => createPendingApproval({
      runId: "http-approval-run",
      nodeId: "approve",
      approvalId: "release",
      proposal: { replace: true },
      proposerActor: "agent:release-proposer",
      authorizedActors: ["matrix"],
    })).toThrow("approval decision is immutable: already approved");
    expect(getApproval("http-approval-run", "approve")).toMatchObject({ status: "approved", actor: "matrix" });
  });

  it("requires authorization for DAG state and event mutations when a token is configured", async () => {
    process.env.HOMERAIL_DAG_MUTATION_TOKEN = "mutation-secret";
    const unauthorizedRunMutation = await fetch(`${baseUrl}/api/runs/emergency-stop`, { method: "POST" });
    expect(unauthorizedRunMutation.status).toBe(403);

    const authorizedRunMutation = await fetch(`${baseUrl}/api/runs/emergency-stop`, {
      method: "POST",
      headers: { "x-homerail-dag-token": "mutation-secret" },
    });
    expect(authorizedRunMutation.status).toBe(200);

    const unauthorizedWorkflowSync = await fetch(`${baseUrl}/api/dag/workflows/sync`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ yaml_text: AUTH_WORKFLOW }),
    });
    expect(unauthorizedWorkflowSync.status).toBe(403);

    const authorizedWorkflowSync = await fetch(`${baseUrl}/api/dag/workflows/sync`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-homerail-dag-token": "mutation-secret" },
      body: JSON.stringify({ yaml_text: AUTH_WORKFLOW }),
    });
    expect(authorizedWorkflowSync.status).toBe(201);

    const unauthorizedState = await fetch(`${baseUrl}/api/dag/state/test/key`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ value: 1 }),
    });
    expect(unauthorizedState.status).toBe(403);
    expect(getDagState("test", "key")).toBeUndefined();

    const authorizedState = await fetch(`${baseUrl}/api/dag/state/test/key`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-homerail-dag-token": "mutation-secret" },
      body: JSON.stringify({ value: 1 }),
    });
    expect(authorizedState.status).toBe(200);
    expect(getDagState("test", "key")).toMatchObject({ version: 1, value: 1 });

    const unauthorizedEvent = await fetch(`${baseUrl}/api/dag/triggers/events/repo.push`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ idempotency_key: "sha-1" }),
    });
    expect(unauthorizedEvent.status).toBe(403);

    const authorizedEvent = await fetch(`${baseUrl}/api/dag/triggers/events/repo.push`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ idempotency_key: "sha-1", authorization_token: "mutation-secret" }),
    });
    expect(authorizedEvent.status).toBe(200);
    expect(await authorizedEvent.json()).toMatchObject({
      success: true,
      data: { deliveries: [], total: 0 },
    });
  });

  it("lists and describes built-in patterns for AI clients", async () => {
    const listResponse = await fetch(`${baseUrl}/api/dag/patterns`);
    const listBody = await listResponse.json() as {
      success: boolean;
      data: { total: number; patterns: Array<{ id: string; typical_uses: string[] }> };
    };
    expect(listResponse.status).toBe(200);
    expect(listBody.success).toBe(true);
    expect(listBody.data.total).toBe(10);
    expect(listBody.data.patterns.find((pattern) => pattern.id === "quorum")?.typical_uses.length).toBeGreaterThan(0);

    const detailResponse = await fetch(`${baseUrl}/api/dag/patterns/ratchet`);
    const detailBody = await detailResponse.json() as {
      data: { required_primitives: string[]; workflow_template: { api_version: string; spec: { nodes: Record<string, unknown> } } };
    };
    expect(detailResponse.status).toBe(200);
    expect(detailBody.data.required_primitives).toContain("while_gateway");
    expect(detailBody.data.workflow_template.api_version).toBe("homerail.ai/v1");
    expect(detailBody.data.workflow_template.spec.nodes).toHaveProperty("target_gate");
  });

  it("instantiates a typed pattern and returns validated YAML without persisting it", async () => {
    const response = await fetch(`${baseUrl}/api/dag/patterns/quorum/instantiate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ parameters: { workflow_id: "api-quorum", threshold: 3 } }),
    });
    const body = await response.json() as {
      success: boolean;
      data: {
        parameters: { threshold: number };
        workflow: { workflow_id: string; pattern: { id: string } };
        yaml_text: string;
        validation: { valid: boolean };
      };
    };

    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data.parameters.threshold).toBe(3);
    expect(body.data.workflow).toMatchObject({
      api_version: "homerail.ai/v1",
      kind: "Workflow",
      metadata: { id: "api-quorum" },
      spec: { pattern: { id: "quorum" } },
    });
    expect(body.data.yaml_text).toContain("threshold: 3");
    expect(body.data.validation.valid).toBe(true);
  });

  it("reports invalid parameters and unknown patterns with API status codes", async () => {
    const invalid = await fetch(`${baseUrl}/api/dag/patterns/quorum/instantiate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ parameters: { threshold: 4 } }),
    });
    expect(invalid.status).toBe(400);

    const invalidContainer = await fetch(`${baseUrl}/api/dag/patterns/quorum/instantiate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ parameters: ["threshold=2"] }),
    });
    expect(invalidContainer.status).toBe(400);

    const missing = await fetch(`${baseUrl}/api/dag/patterns/unknown`);
    expect(missing.status).toBe(404);

    const missingInstance = await fetch(`${baseUrl}/api/dag/patterns/unknown/instantiate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    expect(missingInstance.status).toBe(404);
  });
});
