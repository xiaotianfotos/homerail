import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type {
  DAGDispatcher,
  DispatchEnvelope,
  DispatchResult,
} from "../src/orchestration/dag-dispatcher.js";
import { GraphExecutor } from "../src/orchestration/graph-executor.js";
import {
  compileWorkflowSource,
  parseWorkflowSource,
} from "../src/orchestration/workflow-spec-v1.js";
import { listDagActors, listDagActorCommands } from "../src/persistence/dag-actors.js";
import { acquireDagActorLease } from "../src/persistence/dag-actor-leases.js";
import { closeDb } from "../src/persistence/db.js";
import { _clearAllPersistence, loadRunSnapshot } from "../src/persistence/store.js";
import {
  _clearActiveRuns,
  getActiveRun,
  handoffActiveRun,
  resumeWaitingActiveRun,
} from "../src/runtime/active-runs.js";

const ACTOR_IDS = ["goal_scout", "session_coach", "systems_guide"] as const;
const SOURCE = `api_version: homerail.ai/v1
kind: Workflow

metadata:
  id: test-three-actor-supervised
  name: Test Three-Actor Supervised Workflow

spec:
  contracts:
    Prompt:
      type: string
      minLength: 1
      maxLength: 24000
    ActorReport:
      type: object
      additionalProperties: false
      required: [actor, status]
      properties:
        actor:
          type: string
          enum: [goal_scout, systems_guide, session_coach]
        status:
          type: string
          enum: [ready, blocked]
    Failure:
      type: object
      additionalProperties: true
      required: [error]
      properties:
        error: { type: string }
    RoundGate:
      type: object
      additionalProperties: false
      required: [mode, total, successes, failures, threshold, passed, values]
      properties:
        mode: { type: string, const: all }
        total: { type: integer, const: 3 }
        successes: { type: integer, minimum: 0, maximum: 3 }
        failures: { type: integer, minimum: 0, maximum: 3 }
        threshold: { type: integer, const: 3 }
        passed: { type: boolean }
        values:
          type: array
          minItems: 3
          maxItems: 3
          items: { type: object }

  agents:
    goal_scout:
      description: Extracts the exact objective and constraints.
      system: |
        Own the objective and constraints. Call report_activity with type progress,
        then report_activity with type finding. Apply any command envelope on the
        same responsibility. Call handoff exactly once on port report with only
        actor and status.
    systems_guide:
      description: Evaluates options and tradeoffs.
      system: |
        Own options and tradeoffs. Call report_activity with type progress, then
        report_activity with type finding. Apply any command envelope on the same
        responsibility. Call handoff exactly once on port report with only actor
        and status.
    session_coach:
      description: Turns the result into an action sequence.
      system: |
        Own the action sequence. Call report_activity with type progress, then
        report_activity with type finding. Apply any command envelope on the same
        responsibility. Call handoff exactly once on port report with only actor
        and status.

  nodes:
    goal_scout:
      kind: agent
      agent: goal_scout
      allowed_builtin_tools: []
      allowed_dag_tools: [report_activity, handoff]
      inputs:
        mission: { contract: Prompt }
        command: {}
      outputs:
        report: { contract: ActorReport }
        failed: { contract: Failure }
    systems_guide:
      kind: agent
      agent: systems_guide
      allowed_builtin_tools: []
      allowed_dag_tools: [report_activity, handoff]
      inputs:
        mission: { contract: Prompt }
        command: {}
      outputs:
        report: { contract: ActorReport }
        failed: { contract: Failure }
    session_coach:
      kind: agent
      agent: session_coach
      allowed_builtin_tools: []
      allowed_dag_tools: [report_activity, handoff]
      inputs:
        mission: { contract: Prompt }
        command: {}
      outputs:
        report: { contract: ActorReport }
        failed: { contract: Failure }
    collect_round:
      kind: join
      inputs:
        goals: { contract: ActorReport }
        systems: { contract: ActorReport }
        session: { contract: ActorReport }
      outputs:
        ready: { contract: RoundGate }
        blocked: { contract: RoundGate }
      config:
        mode: all
        field: status
        success_values: [ready]
        passed_port: ready
        failed_port: blocked
    wait_for_command:
      kind: await_command
      inputs:
        ready: { contract: RoundGate }
        blocked: { contract: RoundGate }
      config:
        primitive_version: 1
        target_actors: [goal_scout, systems_guide, session_coach]
        command_port: command
    goal_scout_failed:
      kind: terminal
      outcome: failure
      inputs: { result: { contract: Failure } }
    systems_guide_failed:
      kind: terminal
      outcome: failure
      inputs: { result: { contract: Failure } }
    session_coach_failed:
      kind: terminal
      outcome: failure
      inputs: { result: { contract: Failure } }

  edges:
    - { from: $run.input, to: goal_scout.mission }
    - { from: $run.input, to: systems_guide.mission }
    - { from: $run.input, to: session_coach.mission }
    - { from: goal_scout.report, to: collect_round.goals }
    - { from: systems_guide.report, to: collect_round.systems }
    - { from: session_coach.report, to: collect_round.session }
    - { from: collect_round.ready, to: wait_for_command.ready }
    - { from: collect_round.blocked, to: wait_for_command.blocked }
    - { from: goal_scout.failed, to: goal_scout_failed.result, condition: on_failure }
    - { from: systems_guide.failed, to: systems_guide_failed.result, condition: on_failure }
    - { from: session_coach.failed, to: session_coach_failed.result, condition: on_failure }

  policies:
    max_nodes: 8
    max_edges: 11
    max_parallelism: 3
    max_dispatches: 120
    max_handoffs: 120
    max_tool_calls_per_node: 60
    max_corrections_per_node: 3
`;

type ActorId = (typeof ACTOR_IDS)[number];

interface ActorReport {
  actor: ActorId;
  status: "ready" | "blocked";
}

class ActorDispatcher implements DAGDispatcher {
  readonly dispatched: DispatchEnvelope[] = [];

  dispatch(envelope: DispatchEnvelope): DispatchResult {
    if (!envelope.activity) throw new Error("test dispatch is missing logical Actor identity");
    const lease = acquireDagActorLease({
      run_id: envelope.runId,
      actor_id: envelope.activity.actorId,
      target_type: "worker",
      target_id: `worker-${envelope.nodeId}-${this.dispatched.length + 1}`,
    });
    this.dispatched.push(structuredClone({
      ...envelope,
      activity: {
        ...envelope.activity,
        leaseGeneration: lease.lease_generation,
      },
    }));
    return {
      status: "dispatched",
      targetType: "worker",
      targetId: lease.target_id,
    };
  }
}

function runtimeAsset() {
  const parsed = parseWorkflowSource(SOURCE);
  parsed.meta.agents = Object.fromEntries(
    Object.entries(parsed.meta.agents ?? {}).map(([id, agent]) => [
      id,
      { ...agent, agent_type: "deterministic" },
    ]),
  );
  return parsed;
}

function report(actor: ActorId): ActorReport {
  return { actor, status: "ready" };
}

function handoffReport(runId: string, envelope: DispatchEnvelope, content: ActorReport): void {
  const activity = envelope.activity;
  if (!activity?.leaseGeneration) throw new Error("test dispatch is missing its Actor lease");
  handoffActiveRun(runId, envelope.nodeId, "report", content, {
    transport: true,
    roundId: activity.roundId,
    actorId: activity.actorId,
    generation: activity.generation,
    leaseGeneration: activity.leaseGeneration,
    ...(activity.commandId ? { commandId: activity.commandId } : {}),
  });
}

describe("generic three-Actor supervised workflow", () => {
  let previousHome: string | undefined;
  let home: string;

  beforeEach(() => {
    previousHome = process.env.HOMERAIL_HOME;
    home = fs.mkdtempSync(path.join(os.tmpdir(), "homerail-three-actor-test-"));
    process.env.HOMERAIL_HOME = home;
    closeDb();
    _clearActiveRuns();
    _clearAllPersistence();
  });

  afterEach(() => {
    _clearActiveRuns();
    _clearAllPersistence();
    closeDb();
    if (previousHome === undefined) delete process.env.HOMERAIL_HOME;
    else process.env.HOMERAIL_HOME = previousHome;
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("strictly parses a provider-neutral workflow with bounded report contracts", () => {
    const result = compileWorkflowSource(SOURCE);

    expect(result.valid).toBe(true);
    expect(result.diagnostics).toEqual([]);
    expect(result).toMatchObject({
      source_api_version: "homerail.ai/v1",
      summary: {
        workflow_id: "test-three-actor-supervised",
        node_count: 8,
        edge_count: 11,
        entry_nodes: [...ACTOR_IDS],
        terminal_nodes: ["goal_scout_failed", "session_coach_failed", "systems_guide_failed"],
      },
    });
    expect(result.canonical?.contracts.ActorReport).toMatchObject({
      type: "object",
      additionalProperties: false,
      required: ["actor", "status"],
      properties: {
        actor: { enum: ["goal_scout", "systems_guide", "session_coach"] },
        status: { enum: ["ready", "blocked"] },
      },
    });
    expect(result.canonical?.contracts.RoundGate).toMatchObject({
      required: ["mode", "total", "successes", "failures", "threshold", "passed", "values"],
      properties: {
        mode: { const: "all" },
        total: { const: 3 },
        threshold: { const: 3 },
        values: { minItems: 3, maxItems: 3 },
      },
    });
    expect(SOURCE).not.toMatch(/^\s*(?:provider|model|llm_setting_id|api_key|base_url):/m);
  });

  it("projects exactly three concurrent Actors through one join and one command boundary", () => {
    const result = compileWorkflowSource(SOURCE);
    const canonical = result.canonical!;
    const nodes = new Map(canonical.nodes.map((node) => [node.id, node]));

    for (const actorId of ACTOR_IDS) {
      expect(nodes.get(actorId)).toMatchObject({
        kind: "agent",
        agent: actorId,
        inputs: expect.arrayContaining([
          { name: "mission", contract: "Prompt" },
          { name: "command" },
        ]),
        outputs: [
          { name: "failed", contract: "Failure" },
          { name: "report", contract: "ActorReport" },
        ],
        config: {
          allowed_builtin_tools: [],
          allowed_dag_tools: ["handoff", "report_activity"],
        },
      });
      const system = canonical.agents[actorId]?.system ?? "";
      expect(system).toContain("report_activity with type progress");
      expect(system).toContain("report_activity with type finding");
      expect(system).toContain("command envelope");
      expect(system).toContain("Call handoff exactly once on port report");
    }
    expect(nodes.get("collect_round")).toMatchObject({
      kind: "join",
      config: {
        mode: "all",
        field: "status",
        success_values: ["ready"],
        passed_port: "ready",
        failed_port: "blocked",
      },
    });
    expect(nodes.get("wait_for_command")).toMatchObject({
      kind: "await_command",
      outputs: [],
      config: {
        primitive_version: 1,
        target_actors: ["goal_scout", "systems_guide", "session_coach"],
        command_port: "command",
      },
    });
    expect(nodes.get("wait_for_command")?.config).not.toHaveProperty("expires_after_ms");
    expect(canonical.edges
      .map((edge) => `${edge.from.node}.${edge.from.port}->${edge.to.node}.${edge.to.port}`)
      .sort())
      .toEqual([
        "$run.input->goal_scout.mission",
        "$run.input->systems_guide.mission",
        "$run.input->session_coach.mission",
        "goal_scout.report->collect_round.goals",
        "goal_scout.failed->goal_scout_failed.result",
        "systems_guide.report->collect_round.systems",
        "systems_guide.failed->systems_guide_failed.result",
        "session_coach.report->collect_round.session",
        "session_coach.failed->session_coach_failed.result",
        "collect_round.ready->wait_for_command.ready",
        "collect_round.blocked->wait_for_command.blocked",
      ].sort());
  });

  it("fans in to waiting and reruns only a commanded Actor with frozen sibling reports", () => {
    const runId = "three-actor-supervised-runtime";
    const dispatcher = new ActorDispatcher();
    const executor = new GraphExecutor(dispatcher);
    executor.createRun(runId, runtimeAsset(), "Compare three perspectives on one objective");

    expect(executor.tick(runId)).toBe(3);
    expect(dispatcher.dispatched.map((entry) => entry.nodeId).sort()).toEqual([...ACTOR_IDS]);
    expect(dispatcher.dispatched.every((entry) => (
      entry.inputs.mission?.[0] === "Compare three perspectives on one objective"
      && entry.allowedBuiltinTools?.length === 0
      && entry.allowedDagTools?.join(",") === "handoff,report_activity"
    ))).toBe(true);
    expect(listDagActors(runId).map((actor) => ({
      actor_id: actor.actor_id,
      node_id: actor.node_id,
      surface_id: actor.surface_id,
    }))).toEqual(ACTOR_IDS.map((actorId) => ({
      actor_id: actorId,
      node_id: actorId,
      surface_id: `actor:${actorId}`,
    })));

    for (const envelope of dispatcher.dispatched) {
      handoffReport(runId, envelope, report(envelope.nodeId as ActorId));
    }
    expect(executor.tick(runId)).toBe(2);
    expect(getActiveRun(runId)).toMatchObject({
      status: "waiting",
      currentRound: { round_id: "round-0001", ordinal: 1, status: "waiting" },
    });
    expect(loadRunSnapshot(runId)?.handoffs.findLast((entry) => entry.fromNode === "collect_round")?.content)
      .toMatchObject({ total: 3, successes: 3, failures: 0, threshold: 3, passed: true });

    const resumed = resumeWaitingActiveRun(runId, {
      expected_round_id: "round-0001",
      commands: [{
        actor_id: "systems_guide",
        command_id: "systems-focus-round-2",
        idempotency_key: "systems-focus-round-2-v1",
        payload: { focus: "Prefer the lower-risk option and explain the tradeoff" },
      }],
    });
    expect(resumed).toMatchObject({
      previousRoundId: "round-0001",
      roundId: "round-0002",
      actorIds: ["systems_guide"],
      nodeIds: ["systems_guide"],
      commandIds: ["systems-focus-round-2"],
    });

    const dispatchCount = dispatcher.dispatched.length;
    expect(executor.tick(runId)).toBe(1);
    expect(dispatcher.dispatched).toHaveLength(dispatchCount + 1);
    const commanded = dispatcher.dispatched.at(-1)!;
    expect(commanded).toMatchObject({
      nodeId: "systems_guide",
      activity: {
        roundId: "round-0002",
        actorId: "systems_guide",
        commandId: "systems-focus-round-2",
        surfaceId: "actor:systems_guide",
      },
      inputs: {
        command: [{
          command_id: "systems-focus-round-2",
          round_id: "round-0002",
          actor_id: "systems_guide",
          payload: { focus: "Prefer the lower-risk option and explain the tradeoff" },
        }],
      },
    });
    handoffReport(runId, commanded, report("systems_guide"));
    expect(executor.tick(runId)).toBe(2);

    const joined = loadRunSnapshot(runId)?.handoffs
      .findLast((entry) => entry.fromNode === "collect_round")?.content;
    expect(joined).toMatchObject({
      total: 3,
      successes: 3,
      passed: true,
      values: expect.arrayContaining([
        expect.objectContaining({ actor: "goal_scout", status: "ready" }),
        expect.objectContaining({ actor: "session_coach", status: "ready" }),
        expect.objectContaining({ actor: "systems_guide", status: "ready" }),
      ]),
    });
    expect(getActiveRun(runId)).toMatchObject({
      status: "waiting",
      currentRound: { round_id: "round-0002", ordinal: 2, status: "waiting" },
    });
    expect(listDagActorCommands({ run_id: runId })).toContainEqual(expect.objectContaining({
      command_id: "systems-focus-round-2",
      actor_id: "systems_guide",
      status: "acknowledged",
    }));
  });
});
