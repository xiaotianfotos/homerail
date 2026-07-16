import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DAG_ACTIVITY_EVENT_SCHEMA_VERSION,
  type DagActivityEventV1,
} from "homerail-protocol";

import { projectDagActivityJournalEntry } from "../src/generative-ui/dag-live-surface-projector.js";
import type {
  DAGDispatcher,
  DispatchEnvelope,
  DispatchResult,
} from "../src/orchestration/dag-dispatcher.js";
import { _clearAllDispatches, recordDispatch } from "../src/orchestration/dispatch-tracker.js";
import { parseDAGYaml } from "../src/orchestration/yaml-loader.js";
import { appendDagActivityEvent } from "../src/persistence/dag-activity-journal.js";
import { acquireDagActorLease } from "../src/persistence/dag-actor-leases.js";
import { closeDb } from "../src/persistence/db.js";
import { _clearAllPersistence } from "../src/persistence/store.js";
import {
  _clearActiveRuns,
  createActiveRun,
  dispatchReadyNodes,
} from "../src/runtime/active-runs.js";
import { getDagActorControlState } from "../src/runtime/dag-actor-control-state.js";
import { createServer } from "../src/server/http.js";

class ApiDispatcher implements DAGDispatcher {
  readonly dispatched: DispatchEnvelope[] = [];

  dispatch(envelope: DispatchEnvelope): DispatchResult {
    if (!envelope.activity) throw new Error("test dispatch is missing actor identity");
    const targetId = `worker-${envelope.activity.actorId}-${this.dispatched.length + 1}`;
    const lease = acquireDagActorLease({
      run_id: envelope.runId,
      actor_id: envelope.activity.actorId,
      target_type: "worker",
      target_id: targetId,
    });
    this.dispatched.push(structuredClone({
      ...envelope,
      activity: { ...envelope.activity, leaseGeneration: lease.lease_generation },
    }));
    recordDispatch(envelope.runId, envelope.nodeId, "worker", targetId);
    return { status: "dispatched", targetType: "worker", targetId };
  }
}

function oneActorDag() {
  return parseDAGYaml(`
name: intervention-api
workflow_id: intervention-api
agents:
  worker: { agent_type: deterministic }
nodes:
  research:
    agent: worker
    extra:
      agent_runtime:
        actor_id: research
        role: Research
        surface_id: surface:research
`);
}

function activity(sequence: number, type: DagActivityEventV1["type"]): DagActivityEventV1 {
  return {
    schema_version: DAG_ACTIVITY_EVENT_SCHEMA_VERSION,
    event_id: `api-research-${sequence}-${type}`,
    run_id: "intervention-api-run",
    round_id: "round-0001",
    node_id: "research",
    actor_id: "research",
    generation: 1,
    surface_id: "surface:research",
    sequence,
    timestamp: Date.now() + sequence,
    type,
    payload: type === "finding"
      ? { title: "Original result", detail: "Retain this evidence" }
      : { message: "Research started" },
  };
}

async function listen(server: http.Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address !== "object") throw new Error("server did not bind");
  return address.port;
}

async function closeServer(server: http.Server | undefined): Promise<void> {
  if (!server?.listening) return;
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

async function jsonResponse(url: string, init?: RequestInit): Promise<{
  status: number;
  body: Record<string, unknown>;
}> {
  const response = await fetch(url, init);
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}

function jsonPost(body: unknown, token?: string): RequestInit {
  return {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { "X-Homerail-Dag-Token": token } : {}),
    },
    body: JSON.stringify(body),
  };
}

describe("DAG actor intervention HTTP API", () => {
  let home: string;
  let previousHome: string | undefined;
  let previousMutationToken: string | undefined;
  let server: http.Server | undefined;

  beforeEach(() => {
    previousHome = process.env.HOMERAIL_HOME;
    previousMutationToken = process.env.HOMERAIL_DAG_MUTATION_TOKEN;
    home = fs.mkdtempSync(path.join(os.tmpdir(), "homerail-intervention-api-"));
    process.env.HOMERAIL_HOME = home;
    process.env.HOMERAIL_DAG_MUTATION_TOKEN = "test-mutation-token";
    closeDb();
    _clearActiveRuns();
    _clearAllPersistence();
    _clearAllDispatches();
  });

  afterEach(async () => {
    await closeServer(server);
    server = undefined;
    _clearActiveRuns();
    _clearAllPersistence();
    _clearAllDispatches();
    closeDb();
    if (previousHome === undefined) delete process.env.HOMERAIL_HOME;
    else process.env.HOMERAIL_HOME = previousHome;
    if (previousMutationToken === undefined) delete process.env.HOMERAIL_DAG_MUTATION_TOKEN;
    else process.env.HOMERAIL_DAG_MUTATION_TOKEN = previousMutationToken;
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("authenticates, applies, observes, and deduplicates a sanitized actor-only intervention", async () => {
    const runId = "intervention-api-run";
    const dispatcher = new ApiDispatcher();
    createActiveRun(runId, oneActorDag());
    expect(dispatchReadyNodes(runId, dispatcher)).toBe(1);
    projectDagActivityJournalEntry(appendDagActivityEvent(activity(1, "started")));
    projectDagActivityJournalEntry(appendDagActivityEvent(activity(2, "finding")));
    const stateToken = getDagActorControlState(runId, "research").state_token;
    server = createServer(0, undefined, dispatcher, false, { autoDetectCodex: false });
    const baseUrl = `http://127.0.0.1:${await listen(server)}`;
    const endpoint = `${baseUrl}/api/runs/${runId}/actors/research/interventions`;
    const request = {
      operation: "retry",
      instruction: "Recheck the conclusion without exposing token=private-value.",
      expected_state_token: stateToken,
      idempotency_key: "api-retry-once",
    };

    expect(await jsonResponse(endpoint, jsonPost(request))).toMatchObject({
      status: 403,
      body: { success: false },
    });
    expect(await jsonResponse(endpoint, jsonPost({
      ...request,
      instruction: { text: "not a string" },
      idempotency_key: "invalid-instruction-type",
    }, "test-mutation-token"))).toMatchObject({
      status: 400,
      body: { error: "instruction must be a string when provided" },
    });
    expect(await jsonResponse(endpoint, jsonPost({
      ...request,
      operation: "checkpoint_fork",
      checkpoint_version: "1",
      idempotency_key: "invalid-checkpoint-type",
    }, "test-mutation-token"))).toMatchObject({
      status: 400,
      body: { error: "checkpoint_version must be a positive integer" },
    });
    const applied = await jsonResponse(endpoint, jsonPost(request, "test-mutation-token"));
    expect(applied).toMatchObject({
      status: 202,
      body: {
        success: true,
        data: {
          run_id: runId,
          actor_id: "research",
          operation: "retry",
          status: "applied",
          actor_state: "ready",
          deduplicated: false,
          redispatched: true,
        },
      },
    });
    const appliedData = (applied.body.data ?? {}) as Record<string, unknown>;
    const interventionId = String(appliedData.intervention_id);
    expect(interventionId).toMatch(/^intervention-[0-9a-f]{64}$/);
    expect(JSON.stringify(applied.body)).not.toMatch(/worker-|target_id|lease_generation|node_id|checkpoint_ref/);

    const repeated = await jsonResponse(endpoint, jsonPost(request, "test-mutation-token"));
    expect(repeated).toMatchObject({
      status: 200,
      body: { data: { intervention_id: interventionId, deduplicated: true, redispatched: false } },
    });
    const list = await jsonResponse(endpoint);
    expect(list).toMatchObject({
      status: 200,
      body: {
        data: {
          total: 1,
          interventions: [{
            intervention_id: interventionId,
            actor_id: "research",
            operation: "retry",
            status: "applied",
          }],
        },
      },
    });
    const detail = await jsonResponse(`${endpoint}/${interventionId}`);
    expect(detail).toMatchObject({
      status: 200,
      body: { data: { intervention_id: interventionId, status: "applied" } },
    });
    expect(JSON.stringify(list.body)).not.toMatch(/expected_actor|from_generation|to_generation|resulting_actor_version/);
    expect(JSON.stringify(detail.body)).not.toContain("private-value");

    const history = await jsonResponse(`${baseUrl}/api/runs/${runId}/actors/research/surface-history`);
    expect(history).toMatchObject({
      status: 200,
      body: {
        data: {
          generation_state: "superseded",
          total: 1,
          history: [{ generation: 1, superseded_by_generation: 2 }],
        },
      },
    });
    const live = await jsonResponse(`${baseUrl}/api/runs/${runId}/live-surfaces`);
    expect(live).toMatchObject({
      status: 200,
      body: {
        data: {
          surface_states: [{
            actor_id: "research",
            surface_id: "surface:research",
            generation_state: "current",
            superseded_count: 1,
            latest_intervention: { intervention_id: interventionId, status: "applied" },
          }],
        },
      },
    });

    expect(await jsonResponse(endpoint, jsonPost({
      ...request,
      idempotency_key: "physical-target-injection",
      target_id: "worker-private",
    }, "test-mutation-token"))).toMatchObject({ status: 400 });
    expect(await jsonResponse(endpoint, jsonPost({
      ...request,
      idempotency_key: "stale-token",
    }, "test-mutation-token"))).toMatchObject({ status: 409 });
    expect(await jsonResponse(
      `${baseUrl}/api/runs/${runId}/actors/missing/interventions`,
      jsonPost({ ...request, idempotency_key: "missing-actor" }, "test-mutation-token"),
    )).toMatchObject({ status: 404 });
  });
});
