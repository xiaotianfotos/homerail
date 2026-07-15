import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DAG_TRANSPORT_FENCE_CAPABILITY } from "homerail-protocol";

import type { DAGDispatcher, DispatchEnvelope, DispatchResult } from "../src/orchestration/dag-dispatcher.js";
import { ChangeOrchestrator } from "../src/orchestration/change-orchestrator.js";
import { GraphExecutor } from "../src/orchestration/graph-executor.js";
import {
  compileWorkflowSource,
  projectCanonicalWorkflowToParsedDAG,
} from "../src/orchestration/workflow-spec-v1.js";
import { parseDAGYaml } from "../src/orchestration/yaml-loader.js";
import { listDagActors, listDagActorCommands } from "../src/persistence/dag-actors.js";
import {
  acquireDagActorLease,
  getDagActorLease,
  getLatestDagActorCheckpoint,
} from "../src/persistence/dag-actor-leases.js";
import { closeDb, getDb } from "../src/persistence/db.js";
import { listDagRunRounds } from "../src/persistence/dag-run-rounds.js";
import {
  _clearAllSettings,
  createSetting,
  upsertProvider,
} from "../src/persistence/llm-settings.js";
import { _clearAllPersistence, loadRunMetadata, loadRunSnapshot } from "../src/persistence/store.js";
import {
  _clearActiveRuns,
  abortActiveRun,
  cancelActiveRun,
  completeActiveRun,
  createActiveRun,
  dispatchReadyNodes,
  expireWaitingActiveRuns,
  getActiveRun,
  getActiveRunCount,
  getWaitingRunCount,
  handoffActiveRun,
  recoverAllActiveRuns,
  resumeWaitingActiveRun,
} from "../src/runtime/active-runs.js";

class RepeatableDispatcher implements DAGDispatcher {
  readonly dispatched: DispatchEnvelope[] = [];
  targetId = "worker-hot";

  dispatch(envelope: DispatchEnvelope): DispatchResult {
    if (!envelope.activity) throw new Error("test dispatch is missing actor identity");
    const lease = acquireDagActorLease({
      run_id: envelope.runId,
      actor_id: envelope.activity.actorId,
      target_type: "worker",
      target_id: this.targetId,
    });
    this.dispatched.push(structuredClone({
      ...envelope,
      activity: {
        ...envelope.activity,
        leaseGeneration: lease.lease_generation,
      },
    }));
    return { status: "dispatched", targetType: "fake", targetId: this.targetId };
  }
}

function multiRoundDag() {
  return parseDAGYaml(`
name: multi-round-runtime
workflow_id: multi-round-runtime
agents:
  worker:
    agent_type: deterministic
    system: HANDOFF port=summary content=ok
nodes:
  actor:
    agent: worker
    extra:
      agent_runtime:
        actor_id: researcher
        role: research
        surface_id: surface-research
    outputs:
      summary: { to: suspend.in:summary }
  suspend:
    type: await_command
    after: [actor]
    gateway_config:
      primitive_version: 1
      target_actors: [actor]
      command_port: command
`);
}

function strictV1MultiRoundDag() {
  const compilation = compileWorkflowSource(`
api_version: homerail.ai/v1
kind: Workflow
metadata:
  id: strict-multi-round-runtime
  name: Strict Multi Round Runtime
spec:
  agents:
    worker:
      system: HANDOFF port=summary content=ok
  nodes:
    actor:
      kind: agent
      agent: worker
      outputs:
        summary: {}
    suspend:
      kind: await_command
      inputs:
        summary: {}
      config:
        primitive_version: 1
        target_actors: [actor]
        command_port: command
  edges:
    - { from: actor.summary, to: suspend.summary }
`);
  if (!compilation.valid || !compilation.canonical) {
    throw new Error(compilation.diagnostics.map((entry) => entry.message).join("\n"));
  }
  return projectCanonicalWorkflowToParsedDAG(compilation.canonical);
}

function fanInMultiRoundDag() {
  return parseDAGYaml(`
name: multi-round-fan-in
workflow_id: multi-round-fan-in
agents:
  worker: { agent_type: deterministic }
nodes:
  actor_a:
    agent: worker
    outputs:
      result: { to: join.in:a }
  actor_b:
    agent: worker
    outputs:
      result: { to: join.in:b }
  join:
    type: join_gateway
    after: [actor_a, actor_b]
    gateway_config:
      mode: all
      field: ok
      success_values: [true]
      passed_port: merged
      failed_port: failed
    outputs:
      merged: { to: suspend.in:summary }
      failed: { to: suspend.in:summary }
  suspend:
    type: await_command
    after: [join]
    gateway_config:
      primitive_version: 1
      target_actors: [actor_a, actor_b]
      command_port: command
`);
}

function expiringMultiRoundDag() {
  return parseDAGYaml(`
name: multi-round-expiry
workflow_id: multi-round-expiry
agents:
  worker: { agent_type: deterministic }
nodes:
  actor:
    agent: worker
    outputs:
      summary: { to: suspend.in:summary }
  suspend:
    type: await_command
    after: [actor]
    gateway_config:
      primitive_version: 1
      target_actors: [actor]
      command_port: command
      expires_after_ms: 1000
`);
}

function nonQuiescentMultiRoundDag() {
  return parseDAGYaml(`
name: multi-round-non-quiescent
workflow_id: multi-round-non-quiescent
agents:
  worker: { agent_type: deterministic }
nodes:
  actor:
    agent: worker
    outputs:
      summary: { to: suspend.in:summary }
  sibling:
    agent: worker
    outputs:
      done: { to: "" }
  suspend:
    type: await_command
    after: [actor]
    gateway_config:
      primitive_version: 1
      target_actors: [actor]
      command_port: command
`);
}

describe("durable multi-round DAG runtime", () => {
  let tmpHome: string;
  let oldHome: string | undefined;

  beforeEach(() => {
    oldHome = process.env.HOMERAIL_HOME;
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "homerail-multiround-"));
    process.env.HOMERAIL_HOME = tmpHome;
    closeDb();
    _clearActiveRuns();
    _clearAllPersistence();
    _clearAllSettings();
  });

  afterEach(() => {
    _clearActiveRuns();
    _clearAllPersistence();
    _clearAllSettings();
    closeDb();
    if (oldHome === undefined) delete process.env.HOMERAIL_HOME;
    else process.env.HOMERAIL_HOME = oldHome;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it("executes a strict v1 workflow across rounds without a synthetic terminal branch", () => {
    const runId = "strict-v1-multi-round";
    const dispatcher = new RepeatableDispatcher();
    upsertProvider({
      id: "strict-test",
      name: "Strict Test",
      default_model: "test-model",
      base_url: "http://127.0.0.1:9/v1",
      anthropic_base_url: "http://127.0.0.1:9/anthropic",
    });
    createSetting({
      provider_id: "strict-test",
      endpoint_id: "strict-test-default",
      endpoint_name: "default",
      model_name: "test-model",
      display_name: "Strict Test",
      api_key: "test-only",
      protocol: "custom",
      plan_type: "custom",
      base_url: "http://127.0.0.1:9/v1",
      anthropic_base_url: "http://127.0.0.1:9/anthropic",
      supports_llm: true,
      is_active: true,
      is_default: true,
    });
    createActiveRun(runId, strictV1MultiRoundDag());

    expect(dispatchReadyNodes(runId, dispatcher)).toBe(1);
    const firstEnvelope = dispatcher.dispatched.at(-1)!;
    expect(firstEnvelope.activity).toMatchObject({
      roundId: "round-0001",
      actorId: "actor",
      generation: 1,
      surfaceId: "actor:actor",
    });
    expect(firstEnvelope.requiredCapabilities).toEqual([DAG_TRANSPORT_FENCE_CAPABILITY]);
    handoffActiveRun(runId, "actor", "summary", { result: "round one" });
    expect(dispatchReadyNodes(runId, dispatcher)).toBe(1);
    expect(getActiveRun(runId)).toMatchObject({
      status: "waiting",
      currentRound: { round_id: "round-0001", ordinal: 1, status: "waiting" },
    });

    resumeWaitingActiveRun(runId, {
      expected_round_id: "round-0001",
      commands: [{ actor_id: "actor", command_id: "strict-command-2", payload: "continue" }],
    });
    expect(dispatchReadyNodes(runId, dispatcher)).toBe(1);
    expect(dispatcher.dispatched.at(-1)).toMatchObject({
      runId,
      nodeId: "actor",
      sessionId: firstEnvelope.sessionId,
      activity: {
        roundId: "round-0002",
        actorId: "actor",
        generation: 1,
        commandId: "strict-command-2",
        surfaceId: "actor:actor",
      },
      requiredCapabilities: [DAG_TRANSPORT_FENCE_CAPABILITY],
    });
  });

  it("rejects strict v1 workflows with more than one await_command", () => {
    const strict = compileWorkflowSource(`
api_version: homerail.ai/v1
kind: Workflow
metadata:
  id: multiple-await-command
  name: Multiple Await Command
spec:
  agents:
    worker: { system: HANDOFF }
  nodes:
    actor_a:
      kind: agent
      agent: worker
      outputs: { summary: {} }
    actor_b:
      kind: agent
      agent: worker
      outputs: { summary: {} }
    suspend_a:
      kind: await_command
      inputs: { summary: {} }
      config:
        primitive_version: 1
        target_actors: [actor_a]
    suspend_b:
      kind: await_command
      inputs: { summary: {} }
      config:
        primitive_version: 1
        target_actors: [actor_b]
  edges:
    - { from: actor_a.summary, to: suspend_a.summary }
    - { from: actor_b.summary, to: suspend_b.summary }
`);
    expect(strict.valid).toBe(false);
    expect(strict.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({
        severity: "error",
        message: expect.stringMatching(/at most one await_command/i),
      }),
    ]));
  });

  it("rejects legacy graphs with more than one await_command", () => {
    expect(() => parseDAGYaml(`
name: multiple-await-command-graph
agents:
  worker: { agent_type: deterministic }
nodes:
  actor_a:
    agent: worker
    outputs:
      summary: { to: suspend_a.in:summary }
  actor_b:
    agent: worker
    outputs:
      summary: { to: suspend_b.in:summary }
  suspend_a:
    type: await_command
    gateway_config:
      primitive_version: 1
      target_actors: [actor_a]
  suspend_b:
    type: await_command
    gateway_config:
      primitive_version: 1
      target_actors: [actor_b]
`)).toThrow(/at most one await_command/i);
  });

  it("runs two fenced rounds under one run and cold-recovers the waiting actor", () => {
    const runId = "multi-round-cold-recovery";
    const dispatcher = new RepeatableDispatcher();
    createActiveRun(runId, multiRoundDag());

    expect(dispatchReadyNodes(runId, dispatcher)).toBe(1);
    const firstEnvelope = dispatcher.dispatched.at(-1)!;
    expect(firstEnvelope.activity).toMatchObject({
      roundId: "round-0001",
      actorId: "researcher",
      generation: 1,
      surfaceId: "surface-research",
    });
    expect(() => handoffActiveRun(runId, "actor", "summary", "missing round", {
      transport: true,
      actorId: "researcher",
      generation: 1,
      leaseGeneration: firstEnvelope.activity!.leaseGeneration,
    })).toThrow("DAG_HANDOFF_ROUND_FENCE_MISSING");
    expect(() => handoffActiveRun(runId, "actor", "summary", "missing actor", {
      transport: true,
      roundId: "round-0001",
      generation: 1,
      leaseGeneration: firstEnvelope.activity!.leaseGeneration,
    })).toThrow("DAG_HANDOFF_ACTOR_FENCE_MISSING");
    expect(() => handoffActiveRun(runId, "actor", "summary", "missing generation", {
      transport: true,
      roundId: "round-0001",
      actorId: "researcher",
      leaseGeneration: firstEnvelope.activity!.leaseGeneration,
    })).toThrow("DAG_HANDOFF_GENERATION_FENCE_MISSING");
    handoffActiveRun(runId, "actor", "summary", { result: "round one" });
    expect(dispatchReadyNodes(runId, dispatcher)).toBe(1);
    expect(getActiveRun(runId)).toMatchObject({
      status: "waiting",
      currentRound: { round_id: "round-0001", ordinal: 1, status: "waiting" },
    });
    expect(getActiveRunCount()).toBe(0);
    expect(getWaitingRunCount()).toBe(1);
    expect(getLatestDagActorCheckpoint({ run_id: runId, actor_id: "researcher" })).toMatchObject({
      checkpoint_version: 1,
      checkpoint: {
        schema_version: 1,
        round_id: "round-0001",
        actor_generation: 1,
        surface_binding: "surface-research",
        confirmed_conclusions: expect.arrayContaining([expect.stringContaining("round one")]),
      },
    });

    const commandRequest = {
      expected_round_id: "round-0001",
      commands: [{
        actor_id: "researcher",
        command_id: "command-round-2",
        idempotency_key: "retry-round-2",
        payload: { task: "continue" },
      }],
    };
    dispatcher.targetId = "worker-replacement";
    const resumed = resumeWaitingActiveRun(runId, commandRequest);
    expect(resumed).toMatchObject({
      previousRoundId: "round-0001",
      roundId: "round-0002",
      ordinal: 2,
      actorIds: ["researcher"],
      nodeIds: ["actor"],
      commandIds: ["command-round-2"],
    });
    expect(dispatchReadyNodes(runId, dispatcher)).toBe(1);
    const secondEnvelope = dispatcher.dispatched.at(-1)!;
    expect(secondEnvelope).toMatchObject({
      runId,
      nodeId: "actor",
      sessionId: firstEnvelope.sessionId,
      activity: {
        roundId: "round-0002",
        actorId: "researcher",
        generation: 1,
        leaseGeneration: 2,
        commandId: "command-round-2",
        surfaceId: "surface-research",
      },
      actorCheckpoint: {
        schema_version: 1,
        round_id: "round-0001",
        actor_generation: 1,
        surface_binding: "surface-research",
      },
      inputs: {
        command: [{
          command_id: "command-round-2",
          round_id: "round-0002",
          actor_id: "researcher",
          payload: { task: "continue" },
        }],
      },
    });
    expect(listDagActorCommands({ run_id: runId })[0]?.status).toBe("delivered");
    expect(getDagActorLease({ run_id: runId, actor_id: "researcher" })).toMatchObject({
      state: "leased",
      lease_generation: 2,
      target_id: "worker-replacement",
    });

    expect(() => handoffActiveRun(runId, "actor", "summary", "stale worker", {
      transport: true,
      roundId: "round-0002",
      actorId: "researcher",
      generation: 1,
      leaseGeneration: firstEnvelope.activity!.leaseGeneration,
      commandId: "command-round-2",
    })).toThrow("DAG_HANDOFF_LEASE_CONFLICT");

    expect(() => handoffActiveRun(runId, "actor", "summary", "late", {
      transport: true,
      roundId: "round-0001",
      actorId: "researcher",
      generation: 1,
      leaseGeneration: secondEnvelope.activity!.leaseGeneration,
      commandId: "command-round-2",
    })).toThrow("DAG_HANDOFF_ROUND_CONFLICT");
    handoffActiveRun(runId, "actor", "summary", { result: "round two" }, {
      transport: true,
      roundId: "round-0002",
      actorId: "researcher",
      generation: 1,
      leaseGeneration: secondEnvelope.activity!.leaseGeneration,
      commandId: "command-round-2",
    });
    expect(listDagActorCommands({ run_id: runId })[0]?.status).toBe("acknowledged");
    expect(dispatchReadyNodes(runId, dispatcher)).toBe(1);
    expect(getActiveRun(runId)?.status).toBe("waiting");

    expect(resumeWaitingActiveRun(runId, commandRequest)).toMatchObject({
      roundId: "round-0002",
      commandIds: ["command-round-2"],
      deduplicated: true,
    });

    _clearActiveRuns();
    closeDb();
    expect(recoverAllActiveRuns()).toMatchObject({ recovered: [runId] });
    expect(getActiveRun(runId)).toMatchObject({
      status: "waiting",
      currentRound: { round_id: "round-0002", ordinal: 2, status: "waiting" },
    });
    expect(listDagActors(runId)).toContainEqual(expect.objectContaining({
      actor_id: "researcher",
      generation: 1,
      session_id: firstEnvelope.sessionId,
      surface_id: "surface-research",
    }));
    expect(loadRunMetadata(runId)?.dagRuntimeState).toBeDefined();

    resumeWaitingActiveRun(runId, {
      expected_round_id: "round-0002",
      commands: [{ actor_id: "researcher", command_id: "command-round-3", payload: "one more" }],
    });
    dispatcher.targetId = "worker-after-manager-restart";
    expect(dispatchReadyNodes(runId, dispatcher)).toBe(1);
    expect(dispatcher.dispatched.at(-1)).toMatchObject({
      activity: {
        roundId: "round-0003",
        actorId: "researcher",
        leaseGeneration: 3,
        commandId: "command-round-3",
      },
      actorCheckpoint: {
        schema_version: 1,
        round_id: "round-0002",
        actor_generation: 1,
        surface_binding: "surface-research",
      },
    });
    cancelActiveRun(runId);
    expect(getActiveRun(runId)?.status).toBe("cancelled");
    expect(getDagActorLease({ run_id: runId, actor_id: "researcher" })).toMatchObject({
      state: "retired",
      lease_generation: 3,
    });
    expect(listDagActorCommands({ run_id: runId }).find((command) => command.command_id === "command-round-3"))
      .toMatchObject({ status: "cancelled" });
    expect(listDagRunRounds(runId).map((round) => [round.round_id, round.status])).toEqual([
      ["round-0001", "completed"],
      ["round-0002", "completed"],
      ["round-0003", "cancelled"],
    ]);
  });

  it("allows explicit completion only after the run reaches await_command", () => {
    const runId = "multi-round-explicit-complete";
    const dispatcher = new RepeatableDispatcher();
    const orchestrator = new ChangeOrchestrator(new GraphExecutor(dispatcher));
    createActiveRun(runId, multiRoundDag());
    expect(() => orchestrator.completeRun(runId, "round-0001"))
      .toThrow("not waiting for explicit completion");

    const waitingRunId = "multi-round-explicit-complete-waiting";
    createActiveRun(waitingRunId, multiRoundDag());
    dispatchReadyNodes(waitingRunId, dispatcher);
    handoffActiveRun(waitingRunId, "actor", "summary", "done");
    dispatchReadyNodes(waitingRunId, dispatcher);
    expect(getActiveRun(waitingRunId)?.status).toBe("waiting");
    expect(() => orchestrator.completeRun(waitingRunId, "stale-round"))
      .toThrow("Waiting round conflict");
    orchestrator.completeRun(waitingRunId, "round-0001");
    expect(getActiveRun(waitingRunId)?.status).toBe("completed");
    expect(listDagRunRounds(waitingRunId)).toContainEqual(expect.objectContaining({
      round_id: "round-0001",
      status: "completed",
    }));
  });

  it("fails a waiting run deterministically when await_command expires", () => {
    const runId = "multi-round-expired";
    const dispatcher = new RepeatableDispatcher();
    createActiveRun(runId, expiringMultiRoundDag());
    dispatchReadyNodes(runId, dispatcher);
    handoffActiveRun(runId, "actor", "summary", "done");
    dispatchReadyNodes(runId, dispatcher);
    const expiresAt = getActiveRun(runId)?.currentRound.expires_at;
    expect(expiresAt).toEqual(expect.any(Number));

    expect(expireWaitingActiveRuns((expiresAt ?? 0) + 1)).toEqual([runId]);
    expect(getActiveRun(runId)).toMatchObject({
      status: "failed",
      currentRound: { round_id: "round-0001", status: "failed" },
    });
    expect(listDagRunRounds(runId)).toContainEqual(expect.objectContaining({
      round_id: "round-0001",
      status: "failed",
    }));
  });

  it("replays frozen unselected actor payloads when a selected actor rejoins fan-in", () => {
    const runId = "multi-round-fan-in-carryover";
    const dispatcher = new RepeatableDispatcher();
    createActiveRun(runId, fanInMultiRoundDag());

    expect(dispatchReadyNodes(runId, dispatcher)).toBe(2);
    handoffActiveRun(runId, "actor_a", "result", { ok: true, label: "A1" });
    handoffActiveRun(runId, "actor_b", "result", { ok: true, label: "B1" });
    expect(dispatchReadyNodes(runId, dispatcher)).toBe(1);
    expect(dispatchReadyNodes(runId, dispatcher)).toBe(1);
    expect(getActiveRun(runId)?.status).toBe("waiting");

    resumeWaitingActiveRun(runId, {
      expected_round_id: "round-0001",
      commands: [{ actor_id: "actor_a", command_id: "command-a2", payload: "refresh A" }],
    });
    expect(dispatchReadyNodes(runId, dispatcher)).toBe(1);
    const roundTwoEnvelope = dispatcher.dispatched.at(-1)!;
    handoffActiveRun(runId, "actor_a", "result", { ok: true, label: "A2" }, {
      transport: true,
      roundId: "round-0002",
      actorId: "actor_a",
      generation: 1,
      leaseGeneration: roundTwoEnvelope.activity!.leaseGeneration,
      commandId: "command-a2",
    });
    expect(dispatchReadyNodes(runId, dispatcher)).toBe(1);

    const joinHandoff = loadRunSnapshot(runId)?.handoffs.findLast((record) => record.fromNode === "join");
    expect(joinHandoff?.content).toMatchObject({
      total: 2,
      successes: 2,
      passed: true,
      values: expect.arrayContaining([
        { ok: true, label: "A2" },
        { ok: true, label: "B1" },
      ]),
    });
    expect(dispatchReadyNodes(runId, dispatcher)).toBe(1);
    expect(getActiveRun(runId)).toMatchObject({
      status: "waiting",
      currentRound: { round_id: "round-0002", status: "waiting" },
    });
  });

  it("does not deduplicate a subset retry after accepting commands for two actors", () => {
    const runId = "multi-round-command-subset-retry";
    const dispatcher = new RepeatableDispatcher();
    createActiveRun(runId, fanInMultiRoundDag());
    expect(dispatchReadyNodes(runId, dispatcher)).toBe(2);
    handoffActiveRun(runId, "actor_a", "result", { ok: true, label: "A1" });
    handoffActiveRun(runId, "actor_b", "result", { ok: true, label: "B1" });
    expect(dispatchReadyNodes(runId, dispatcher)).toBe(1);
    expect(dispatchReadyNodes(runId, dispatcher)).toBe(1);
    expect(getActiveRun(runId)?.status).toBe("waiting");

    const commands = [
      {
        actor_id: "actor_a",
        command_id: "subset-command-a2",
        idempotency_key: "subset-a2",
        payload: { task: "retry A" },
      },
      {
        actor_id: "actor_b",
        command_id: "subset-command-b2",
        idempotency_key: "subset-b2",
        payload: { task: "retry B" },
      },
    ];
    expect(resumeWaitingActiveRun(runId, {
      expected_round_id: "round-0001",
      commands,
    })).toMatchObject({
      roundId: "round-0002",
      actorIds: ["actor_a", "actor_b"],
      commandIds: ["subset-command-a2", "subset-command-b2"],
    });

    expect(() => resumeWaitingActiveRun(runId, {
      expected_round_id: "round-0001",
      commands: [commands[0]],
    })).toThrow(`Run ${runId} is not waiting`);
    expect(() => resumeWaitingActiveRun(runId, {
      expected_round_id: "round-0001",
      commands: [commands[0], { ...commands[0] }],
    })).toThrow("Each actor may receive at most one command per round");
    expect(listDagActorCommands({ run_id: runId, round_id: "round-0002" })).toHaveLength(2);
  });

  it("commits command acknowledgement, handoff, and run metadata atomically", () => {
    const runId = "multi-round-atomic-handoff";
    const dispatcher = new RepeatableDispatcher();
    createActiveRun(runId, multiRoundDag());
    dispatchReadyNodes(runId, dispatcher);
    handoffActiveRun(runId, "actor", "summary", "round one");
    dispatchReadyNodes(runId, dispatcher);
    resumeWaitingActiveRun(runId, {
      expected_round_id: "round-0001",
      commands: [{ actor_id: "researcher", command_id: "atomic-command", payload: "continue" }],
    });
    dispatchReadyNodes(runId, dispatcher);
    const roundTwoEnvelope = dispatcher.dispatched.at(-1)!;

    getDb().exec(`
      CREATE TRIGGER fail_atomic_handoff_metadata
      BEFORE UPDATE ON dag_runs
      WHEN NEW.run_id = '${runId}'
      BEGIN
        SELECT RAISE(ABORT, 'forced metadata failure');
      END
    `);
    expect(() => handoffActiveRun(runId, "actor", "summary", "round two", {
      transport: true,
      roundId: "round-0002",
      actorId: "researcher",
      generation: 1,
      leaseGeneration: roundTwoEnvelope.activity!.leaseGeneration,
      commandId: "atomic-command",
    })).toThrow("forced metadata failure");

    expect(getActiveRun(runId)?.dagRun.nodeStates.get("actor")).toBe("RUNNING");
    expect(listDagActorCommands({ run_id: runId })).toContainEqual(expect.objectContaining({
      command_id: "atomic-command",
      status: "delivered",
    }));
    expect(loadRunSnapshot(runId)?.handoffs.filter((record) => record.roundId === "round-0002")).toEqual([]);

    getDb().exec("DROP TRIGGER fail_atomic_handoff_metadata");
    handoffActiveRun(runId, "actor", "summary", "round two", {
      transport: true,
      roundId: "round-0002",
      actorId: "researcher",
      generation: 1,
      leaseGeneration: roundTwoEnvelope.activity!.leaseGeneration,
      commandId: "atomic-command",
    });
    expect(listDagActorCommands({ run_id: runId })).toContainEqual(expect.objectContaining({
      command_id: "atomic-command",
      status: "acknowledged",
    }));
  });

  it("rolls back in-memory completion and cancellation when persistence fails", () => {
    const dispatcher = new RepeatableDispatcher();
    const makeWaiting = (runId: string) => {
      createActiveRun(runId, multiRoundDag());
      dispatchReadyNodes(runId, dispatcher);
      handoffActiveRun(runId, "actor", "summary", "done");
      dispatchReadyNodes(runId, dispatcher);
      expect(getActiveRun(runId)?.status).toBe("waiting");
    };

    makeWaiting("rollback-complete");
    getDb().exec(`
      CREATE TRIGGER fail_terminal_metadata
      BEFORE UPDATE ON dag_runs
      BEGIN
        SELECT RAISE(ABORT, 'forced terminal failure');
      END
    `);
    expect(() => completeActiveRun("rollback-complete")).toThrow("forced terminal failure");
    expect(getActiveRun("rollback-complete")).toMatchObject({
      status: "waiting",
      currentRound: { status: "waiting" },
    });
    expect(getActiveRun("rollback-complete")?.dagRun.nodeStates.get("suspend")).toBe("WAITING_FOR_COMMAND");

    getDb().exec("DROP TRIGGER fail_terminal_metadata");
    makeWaiting("rollback-cancel");
    getDb().exec(`
      CREATE TRIGGER fail_terminal_metadata
      BEFORE UPDATE ON dag_runs
      BEGIN
        SELECT RAISE(ABORT, 'forced terminal failure');
      END
    `);
    expect(() => cancelActiveRun("rollback-cancel")).toThrow("forced terminal failure");
    expect(getActiveRun("rollback-cancel")).toMatchObject({
      status: "waiting",
      currentRound: { status: "waiting" },
    });
    expect(getActiveRun("rollback-cancel")?.dagRun.nodeStates.get("suspend")).toBe("WAITING_FOR_COMMAND");
    getDb().exec("DROP TRIGGER fail_terminal_metadata");
  });

  it("restores a waiting run in memory when expiry persistence fails", () => {
    const runId = "rollback-expiry";
    const dispatcher = new RepeatableDispatcher();
    createActiveRun(runId, expiringMultiRoundDag());
    dispatchReadyNodes(runId, dispatcher);
    handoffActiveRun(runId, "actor", "summary", "done");
    dispatchReadyNodes(runId, dispatcher);
    const beforeRound = structuredClone(getActiveRun(runId)!.currentRound);
    const expiresAt = beforeRound.expires_at!;

    getDb().exec(`
      CREATE TRIGGER fail_expiry_metadata
      BEFORE UPDATE ON dag_runs
      WHEN NEW.run_id = '${runId}'
      BEGIN
        SELECT RAISE(ABORT, 'forced expiry failure');
      END
    `);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      expect(expireWaitingActiveRuns(expiresAt + 1)).toEqual([]);
      expect(consoleError).toHaveBeenCalledWith(expect.stringContaining("forced expiry failure"));
      expect(getActiveRun(runId)).toMatchObject({
        status: "waiting",
        completedAt: undefined,
      });
      expect(getActiveRun(runId)?.counters.abort_reason).toBeUndefined();
      expect(getActiveRun(runId)?.currentRound).toEqual(beforeRound);
      expect(getActiveRun(runId)?.dagRun.nodeStates.get("suspend")).toBe("WAITING_FOR_COMMAND");
      expect(loadRunMetadata(runId)).toMatchObject({
        status: "waiting",
        currentRound: { round_id: "round-0001", status: "waiting" },
        nodeStates: { suspend: "WAITING_FOR_COMMAND" },
      });
    } finally {
      consoleError.mockRestore();
      getDb().exec("DROP TRIGGER fail_expiry_metadata");
    }
  });

  it("restores an active run in memory when abort persistence fails", () => {
    const runId = "rollback-abort";
    const dispatcher = new RepeatableDispatcher();
    createActiveRun(runId, multiRoundDag());
    expect(dispatchReadyNodes(runId, dispatcher)).toBe(1);
    const beforeRound = structuredClone(getActiveRun(runId)!.currentRound);
    const beforeCounters = structuredClone(getActiveRun(runId)!.counters);

    getDb().exec(`
      CREATE TRIGGER fail_abort_metadata
      BEFORE UPDATE ON dag_runs
      WHEN NEW.run_id = '${runId}'
      BEGIN
        SELECT RAISE(ABORT, 'forced abort failure');
      END
    `);
    try {
      expect(() => abortActiveRun(runId, "forced abort", "actor")).toThrow("forced abort failure");
      expect(getActiveRun(runId)).toMatchObject({
        status: "active",
        completedAt: undefined,
      });
      expect(getActiveRun(runId)?.currentRound).toEqual(beforeRound);
      expect(getActiveRun(runId)?.counters).toEqual(beforeCounters);
      expect(getActiveRun(runId)?.dagRun.nodeStates.get("actor")).toBe("RUNNING");
      expect(getActiveRun(runId)?.dagRun.nodeStates.get("suspend")).toBe("PENDING");
      expect(loadRunMetadata(runId)).toMatchObject({
        status: "active",
        currentRound: { round_id: "round-0001", status: "active" },
        nodeStates: { actor: "RUNNING", suspend: "PENDING" },
      });
    } finally {
      getDb().exec("DROP TRIGGER fail_abort_metadata");
    }
  });

  it("keeps await_command ready until a live sibling completes", () => {
    const runId = "multi-round-live-sibling";
    const dispatcher = new RepeatableDispatcher();
    createActiveRun(runId, nonQuiescentMultiRoundDag());
    expect(dispatchReadyNodes(runId, dispatcher)).toBe(2);
    handoffActiveRun(runId, "actor", "summary", "ready to wait");

    expect(dispatchReadyNodes(runId, dispatcher)).toBe(0);
    expect(getActiveRun(runId)?.status).toBe("active");
    expect(getActiveRun(runId)?.dagRun.nodeStates.get("sibling")).toBe("RUNNING");
    expect(getActiveRun(runId)?.dagRun.nodeStates.get("suspend")).toBe("READY");

    handoffActiveRun(runId, "sibling", "done", "sibling complete");
    expect(getActiveRun(runId)?.dagRun.nodeStates.get("sibling")).toBe("COMPLETED");
    expect(getActiveRun(runId)?.dagRun.nodeStates.get("suspend")).toBe("READY");
    expect(dispatchReadyNodes(runId, dispatcher)).toBe(1);
    expect(getActiveRun(runId)).toMatchObject({
      status: "waiting",
      currentRound: { round_id: "round-0001", status: "waiting" },
    });
    expect(getActiveRun(runId)?.dagRun.nodeStates.get("suspend")).toBe("WAITING_FOR_COMMAND");
  });
});
