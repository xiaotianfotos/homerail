import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DAG_ACTIVITY_EVENT_SCHEMA_VERSION,
  type DagActivityEventV1,
} from "homerail-protocol";

import {
  getDagLiveSurfaceDocument,
  getDagLiveSurfaceProjection,
  listDagLiveSurfaceGenerationHistory,
  projectDagActivityJournalEntry,
} from "../src/generative-ui/dag-live-surface-projector.js";
import type {
  DAGDispatcher,
  DispatchEnvelope,
  DispatchResult,
} from "../src/orchestration/dag-dispatcher.js";
import {
  _clearAllDispatches,
  clearByTargetId,
  findDispatchExclusion,
  recordDispatch,
} from "../src/orchestration/dispatch-tracker.js";
import { parseDAGYaml } from "../src/orchestration/yaml-loader.js";
import { appendDagActivityEvent } from "../src/persistence/dag-activity-journal.js";
import {
  createDagActorIntervention,
  getDagActorIntervention,
  listDagActorInterventions,
} from "../src/persistence/dag-actor-interventions.js";
import { getDagActor, listDagActors } from "../src/persistence/dag-actors.js";
import {
  acquireDagActorLease,
  getDagActorLease,
  writeDagActorCheckpoint,
} from "../src/persistence/dag-actor-leases.js";
import { closeDb } from "../src/persistence/db.js";
import { _clearAllPersistence } from "../src/persistence/store.js";
import {
  _clearActiveRuns,
  createActiveRun,
  dispatchReadyNodes,
  getActiveRun,
  handoffActiveRun,
  interveneActiveRunActor,
  recoverAllActiveRuns,
  recoverDagActorInterventions,
} from "../src/runtime/active-runs.js";
import { buildDagActorCheckpoint } from "../src/runtime/dag-actor-checkpoint-builder.js";
import { getDagActorControlState } from "../src/runtime/dag-actor-control-state.js";

class ActorDispatcher implements DAGDispatcher {
  readonly dispatched: DispatchEnvelope[] = [];

  dispatch(envelope: DispatchEnvelope): DispatchResult {
    if (!envelope.activity) throw new Error("test dispatch is missing durable actor identity");
    const targetId = `worker-${envelope.activity.actorId}`;
    const lease = acquireDagActorLease({
      run_id: envelope.runId,
      actor_id: envelope.activity.actorId,
      target_type: "worker",
      target_id: targetId,
    });
    const dispatched = structuredClone({
      ...envelope,
      activity: {
        ...envelope.activity,
        leaseGeneration: lease.lease_generation,
      },
    });
    this.dispatched.push(dispatched);
    recordDispatch(envelope.runId, envelope.nodeId, "worker", targetId);
    return { status: "dispatched", targetType: "worker", targetId };
  }
}

function threeActorDag() {
  return parseDAGYaml(`
name: branch-intervention
workflow_id: branch-intervention
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
    outputs:
      result: { to: join.in:research }
  build:
    agent: worker
    extra:
      agent_runtime:
        actor_id: build
        role: Build
        surface_id: surface:build
    outputs:
      result: { to: join.in:build }
  verify:
    agent: worker
    extra:
      agent_runtime:
        actor_id: verify
        role: Verify
        surface_id: surface:verify
    outputs:
      result: { to: join.in:verify }
  join:
    type: join_gateway
    after: [research, build, verify]
    gateway_config:
      mode: all
      passed_port: merged
      failed_port: failed
`);
}

function oneActorDag() {
  return parseDAGYaml(`
name: recover-intervention
workflow_id: recover-intervention
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

function activity(input: {
  runId: string;
  actorId: string;
  generation?: number;
  sequence: number;
  type: DagActivityEventV1["type"];
  payload?: DagActivityEventV1["payload"];
}): DagActivityEventV1 {
  const generation = input.generation ?? 1;
  return {
    schema_version: DAG_ACTIVITY_EVENT_SCHEMA_VERSION,
    event_id: `${input.runId}-${input.actorId}-g${generation}-s${input.sequence}-${input.type}`,
    run_id: input.runId,
    round_id: "round-0001",
    node_id: input.actorId,
    actor_id: input.actorId,
    generation,
    surface_id: `surface:${input.actorId}`,
    sequence: input.sequence,
    timestamp: Date.now() + input.sequence,
    type: input.type,
    payload: input.payload ?? { message: `${input.actorId} ${input.type}` },
  };
}

function appendAndProject(event: DagActivityEventV1): void {
  projectDagActivityJournalEntry(appendDagActivityEvent(event));
}

function projectInitialEvidence(runId: string, actorIds: readonly string[]): void {
  for (const actorId of actorIds) {
    appendAndProject(activity({ runId, actorId, sequence: 1, type: "started" }));
    appendAndProject(activity({
      runId,
      actorId,
      sequence: 2,
      type: "finding",
      payload: { title: `${actorId} evidence`, detail: `durable ${actorId} result` },
    }));
  }
}

function nodeById(runId: string, nodeId: string) {
  return getDagLiveSurfaceDocument(runId)?.nodes.find((node) => node.id === nodeId);
}

describe("runtime-backed DAG actor branch intervention", () => {
  let home: string;
  let previousHome: string | undefined;

  beforeEach(() => {
    previousHome = process.env.HOMERAIL_HOME;
    home = fs.mkdtempSync(path.join(os.tmpdir(), "homerail-branch-intervention-"));
    process.env.HOMERAIL_HOME = home;
    closeDb();
    _clearActiveRuns();
    _clearAllPersistence();
    _clearAllDispatches();
  });

  afterEach(() => {
    _clearActiveRuns();
    _clearAllPersistence();
    _clearAllDispatches();
    closeDb();
    if (previousHome === undefined) delete process.env.HOMERAIL_HOME;
    else process.env.HOMERAIL_HOME = previousHome;
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("retries only the selected branch, preserves other surfaces, and fences the old generation", () => {
    const runId = "intervene-one-of-three";
    const dispatcher = new ActorDispatcher();
    createActiveRun(runId, threeActorDag());
    expect(dispatchReadyNodes(runId, dispatcher)).toBe(3);
    projectInitialEvidence(runId, ["research", "build", "verify"]);

    const actorsBefore = new Map(listDagActors(runId).map((actor) => [actor.actor_id, actor]));
    const researchBefore = actorsBefore.get("research")!;
    const oldEnvelope = dispatcher.dispatched.find((entry) => entry.activity?.actorId === "research")!;
    const buildSurfaceBefore = structuredClone(nodeById(runId, "surface:build"));
    const verifySurfaceBefore = structuredClone(nodeById(runId, "surface:verify"));
    const researchSurfaceBefore = structuredClone(nodeById(runId, "surface:research"));
    const oldToken = getDagActorControlState(runId, "research").state_token;

    const result = interveneActiveRunActor(runId, {
      actor_id: "research",
      operation: "retry",
      expected_state_token: oldToken,
      idempotency_key: "retry-research-once",
      instruction: "Use the retained evidence and verify the corrected claim.",
    });

    expect(result).toMatchObject({
      run_id: runId,
      actor_id: "research",
      operation: "retry",
      status: "applied",
      actor_state: "ready",
      deduplicated: false,
    });
    const actorsAfter = new Map(listDagActors(runId).map((actor) => [actor.actor_id, actor]));
    expect(actorsAfter.get("research")).toMatchObject({
      generation: researchBefore.generation + 1,
      attempt: researchBefore.attempt + 1,
      checkpoint_ref: "portable:1",
    });
    expect(actorsAfter.get("build")).toEqual(actorsBefore.get("build"));
    expect(actorsAfter.get("verify")).toEqual(actorsBefore.get("verify"));
    expect(getActiveRun(runId)?.dagRun.nodeStates.get("research")).toBe("READY");
    expect(getActiveRun(runId)?.dagRun.nodeStates.get("build")).toBe("RUNNING");
    expect(getActiveRun(runId)?.dagRun.nodeStates.get("verify")).toBe("RUNNING");

    expect(nodeById(runId, "surface:build")).toEqual(buildSurfaceBefore);
    expect(nodeById(runId, "surface:verify")).toEqual(verifySurfaceBefore);
    expect(nodeById(runId, "surface:research")).toMatchObject({
      id: researchSurfaceBefore?.id,
      revision: (researchSurfaceBefore?.revision ?? 0) + 1,
      content: {
        data: {
          actor: { id: "research", generation: 2 },
          intervention: {
            operation: "retry",
            generation_state: "current",
            supersedes_generation: 1,
          },
          findings: [],
        },
      },
    });
    const history = listDagLiveSurfaceGenerationHistory({ run_id: runId, actor_id: "research" });
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ generation: 1, superseded_by_generation: 2 });
    expect(history[0]?.node_snapshot).toMatchObject({
      content: { data: { findings: [{ title: "research evidence" }] } },
    });
    expect(listDagLiveSurfaceGenerationHistory({ run_id: runId, actor_id: "build" })).toEqual([]);
    expect(getDagLiveSurfaceProjection(runId, "research")).toMatchObject({
      generation: 2,
      visibility_state: "focused",
    });
    expect(getDagActorLease({ run_id: runId, actor_id: "research" })?.state).toBe("dormant");

    expect(() => handoffActiveRun(runId, "research", "result", { ok: true }, {
      transport: true,
      roundId: oldEnvelope.activity!.roundId,
      actorId: oldEnvelope.activity!.actorId,
      generation: oldEnvelope.activity!.generation,
      leaseGeneration: oldEnvelope.activity!.leaseGeneration,
    })).toThrow("DAG_HANDOFF_GENERATION_CONFLICT");

    expect(interveneActiveRunActor(runId, {
      actor_id: "research",
      operation: "retry",
      expected_state_token: oldToken,
      idempotency_key: "retry-research-once",
      instruction: "Use the retained evidence and verify the corrected claim.",
    })).toMatchObject({
      intervention_id: result.intervention_id,
      deduplicated: true,
      state_token: result.state_token,
    });
    expect(() => interveneActiveRunActor(runId, {
      actor_id: "research",
      operation: "retry",
      expected_state_token: oldToken,
      idempotency_key: "retry-research-again",
    })).toThrow("state changed before intervention");
    expect(listDagActorInterventions({ run_id: runId, actor_id: "research" })).toHaveLength(1);
  });

  it.each([
    ["retry", "READY", "dormant", "active"],
    ["reassign", "READY", "dormant", "active"],
    ["checkpoint_fork", "READY", "dormant", "active"],
    ["interrupt", "CANCELLED", "retired", "cancelled"],
    ["cancel", "CANCELLED", "retired", "cancelled"],
  ] as const)("enforces %s branch state, checkpoint, and lease semantics", (operation, nodeState, leaseState, runStatus) => {
    const runId = `operation-${operation}`;
    const dispatcher = new ActorDispatcher();
    createActiveRun(runId, oneActorDag());
    expect(dispatchReadyNodes(runId, dispatcher)).toBe(1);
    projectInitialEvidence(runId, ["research"]);
    const actor = getDagActor(runId, "research")!;
    let checkpointVersion: number | undefined;
    if (operation === "checkpoint_fork") {
      checkpointVersion = writeDagActorCheckpoint({
        run_id: runId,
        actor_id: "research",
        checkpoint: buildDagActorCheckpoint({
          runId,
          actor,
          roundId: "round-0001",
        }),
        expected_checkpoint_version: 0,
      }).checkpoint_version;
    }
    const result = interveneActiveRunActor(runId, {
      actor_id: "research",
      operation,
      expected_state_token: getDagActorControlState(runId, "research").state_token,
      idempotency_key: `key-${operation}`,
      ...(checkpointVersion === undefined ? {} : { checkpoint_version: checkpointVersion }),
    });

    expect(result.status).toBe("applied");
    expect(getActiveRun(runId)?.dagRun.nodeStates.get("research")).toBe(nodeState);
    expect(getActiveRun(runId)?.status).toBe(runStatus);
    if (runStatus === "cancelled") expect(getActiveRun(runId)?.completedAt).toEqual(expect.any(Number));
    expect(getDagActor(runId, "research")).toMatchObject({
      generation: 2,
      checkpoint_ref: `portable:${operation === "checkpoint_fork" ? checkpointVersion : 1}`,
    });
    expect(getDagActorLease({ run_id: runId, actor_id: "research" })?.state).toBe(leaseState);
    expect(listDagLiveSurfaceGenerationHistory({ run_id: runId, actor_id: "research" })).toHaveLength(1);
    if (operation === "reassign") {
      expect(findDispatchExclusion(runId, "research")).toEqual({
        targetType: "worker",
        targetId: "worker-research",
      });
    } else {
      expect(findDispatchExclusion(runId, "research")).toBeUndefined();
    }
  });

  it("keeps a reassign exclusion across target disconnect and Manager restart until replacement dispatch", () => {
    const runId = "durable-reassign-exclusion";
    const dispatcher = new ActorDispatcher();
    createActiveRun(runId, oneActorDag());
    expect(dispatchReadyNodes(runId, dispatcher)).toBe(1);

    interveneActiveRunActor(runId, {
      actor_id: "research",
      operation: "reassign",
      expected_state_token: getDagActorControlState(runId, "research").state_token,
      idempotency_key: "durable-reassign-once",
    });
    expect(findDispatchExclusion(runId, "research")).toEqual({
      targetType: "worker",
      targetId: "worker-research",
    });
    clearByTargetId("worker-research");
    expect(findDispatchExclusion(runId, "research")?.targetId).toBe("worker-research");

    _clearActiveRuns();
    _clearAllDispatches();
    closeDb();
    expect(recoverAllActiveRuns().recovered).toContain(runId);
    expect(recoverDagActorInterventions()).toEqual({ applied: [], failed: [], skipped: [] });
    expect(findDispatchExclusion(runId, "research")?.targetId).toBe("worker-research");

    recordDispatch(runId, "research", "worker", "replacement-worker");
    expect(findDispatchExclusion(runId, "research")).toBeUndefined();
    _clearActiveRuns();
    _clearAllDispatches();
    closeDb();
    expect(recoverAllActiveRuns().recovered).toContain(runId);
    recoverDagActorInterventions();
    expect(findDispatchExclusion(runId, "research")).toBeUndefined();
  });

  it("rejects new interventions after an actor branch is retired", () => {
    const runId = "retired-actor-intervention";
    const dispatcher = new ActorDispatcher();
    createActiveRun(runId, threeActorDag());
    expect(dispatchReadyNodes(runId, dispatcher)).toBe(3);

    interveneActiveRunActor(runId, {
      actor_id: "research",
      operation: "cancel",
      expected_state_token: getDagActorControlState(runId, "research").state_token,
      idempotency_key: "cancel-research",
    });
    expect(getActiveRun(runId)?.status).toBe("active");
    expect(getDagActorLease({ run_id: runId, actor_id: "research" })?.state).toBe("retired");
    expect(() => interveneActiveRunActor(runId, {
      actor_id: "research",
      operation: "retry",
      expected_state_token: getDagActorControlState(runId, "research").state_token,
      idempotency_key: "retry-retired-research",
    })).toThrow("is retired and cannot accept another intervention");
    expect(listDagActorInterventions({ run_id: runId, actor_id: "research" })).toHaveLength(1);
  });

  it("recovers a durable queued intervention before orphaned running-node demotion", () => {
    const runId = "recover-queued-intervention";
    const dispatcher = new ActorDispatcher();
    createActiveRun(runId, oneActorDag());
    expect(dispatchReadyNodes(runId, dispatcher)).toBe(1);
    projectInitialEvidence(runId, ["research"]);
    const actor = getDagActor(runId, "research")!;
    createDagActorIntervention({
      intervention_id: "recover-intervention",
      run_id: runId,
      actor_id: actor.actor_id,
      operation: "retry",
      expected_actor_generation: actor.generation,
      expected_actor_version: actor.version,
      idempotency_key: "recover-once",
    });

    _clearActiveRuns();
    _clearAllDispatches();
    closeDb();

    expect(recoverAllActiveRuns()).toMatchObject({
      recovered: [runId],
      failed: [],
    });
    expect(getActiveRun(runId)?.dagRun.nodeStates.get("research")).toBe("RUNNING");
    expect(recoverDagActorInterventions()).toEqual({
      applied: ["recover-intervention"],
      failed: [],
      skipped: [],
    });
    expect(getDagActorIntervention("recover-intervention")).toMatchObject({
      status: "applied",
      from_generation: 1,
      to_generation: 2,
    });
    expect(getDagActor(runId, "research")).toMatchObject({ generation: 2, checkpoint_ref: "portable:1" });
    expect(getActiveRun(runId)?.dagRun.nodeStates.get("research")).toBe("READY");
    expect(listDagLiveSurfaceGenerationHistory({ run_id: runId, actor_id: "research" })).toHaveLength(1);
    expect(recoverDagActorInterventions()).toEqual({ applied: [], failed: [], skipped: [] });
  });

  it("demotes an orphaned running node when its queued intervention cannot recover", () => {
    const runId = "recover-failed-intervention";
    const dispatcher = new ActorDispatcher();
    createActiveRun(runId, oneActorDag());
    expect(dispatchReadyNodes(runId, dispatcher)).toBe(1);
    const actor = getDagActor(runId, "research")!;
    createDagActorIntervention({
      intervention_id: "recover-missing-checkpoint",
      run_id: runId,
      actor_id: actor.actor_id,
      operation: "checkpoint_fork",
      checkpoint_version: 999,
      expected_actor_generation: actor.generation,
      expected_actor_version: actor.version,
      idempotency_key: "recover-missing-checkpoint-once",
    });

    _clearActiveRuns();
    _clearAllDispatches();
    closeDb();
    expect(recoverAllActiveRuns()).toMatchObject({ recovered: [runId], failed: [] });
    expect(getActiveRun(runId)?.dagRun.nodeStates.get("research")).toBe("RUNNING");
    expect(recoverDagActorInterventions()).toEqual({
      applied: [],
      failed: ["recover-missing-checkpoint"],
      skipped: [],
    });
    expect(getDagActorIntervention("recover-missing-checkpoint")?.status).toBe("failed");
    expect(getActiveRun(runId)?.dagRun.nodeStates.get("research")).toBe("FAILED");
    expect(getActiveRun(runId)).toMatchObject({ status: "failed", completedAt: expect.any(Number) });
  });
});
