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
const FILE = path.resolve(
  process.cwd(),
  "..",
  "assets",
  "orchestrations",
  "three-worker-game-copilot.yaml.template",
);
const SOURCE = fs.readFileSync(FILE, "utf8");

type ActorId = (typeof ACTOR_IDS)[number];

interface ActorReport {
  actor: ActorId;
  status: "ready" | "blocked";
  headline: string;
  findings: Array<{ title: string; detail: string }>;
  next_actions: string[];
  assumptions: string[];
}

class ActorDispatcher implements DAGDispatcher {
  readonly dispatched: DispatchEnvelope[] = [];

  dispatch(envelope: DispatchEnvelope): DispatchResult {
    if (!envelope.activity) throw new Error("showcase dispatch is missing logical Actor identity");
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

function report(actor: ActorId, headline = `${actor} is ready`): ActorReport {
  return {
    actor,
    status: "ready",
    headline,
    findings: [{ title: `${actor} finding`, detail: `Useful evidence from ${actor}` }],
    next_actions: [`Use the ${actor} recommendation`],
    assumptions: [],
  };
}

function handoffReport(runId: string, envelope: DispatchEnvelope, content: ActorReport): void {
  const activity = envelope.activity;
  if (!activity?.leaseGeneration) throw new Error("showcase dispatch is missing its Actor lease");
  handoffActiveRun(runId, envelope.nodeId, "report", content, {
    transport: true,
    roundId: activity.roundId,
    actorId: activity.actorId,
    generation: activity.generation,
    leaseGeneration: activity.leaseGeneration,
    ...(activity.commandId ? { commandId: activity.commandId } : {}),
  });
}

describe("three-Worker game copilot showcase asset", () => {
  let previousHome: string | undefined;
  let home: string;

  beforeEach(() => {
    previousHome = process.env.HOMERAIL_HOME;
    home = fs.mkdtempSync(path.join(os.tmpdir(), "homerail-three-worker-showcase-"));
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
        workflow_id: "three-worker-game-copilot",
        node_count: 5,
        edge_count: 8,
        entry_nodes: [...ACTOR_IDS],
        terminal_nodes: [],
      },
    });
    expect(result.canonical?.contracts.ActorReport).toMatchObject({
      type: "object",
      additionalProperties: false,
      required: ["actor", "status", "headline", "findings", "next_actions", "assumptions"],
      properties: {
        actor: { enum: ["goal_scout", "systems_guide", "session_coach"] },
        status: { enum: ["ready", "blocked"] },
        findings: { minItems: 1, maxItems: 6 },
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
        outputs: [{ name: "report", contract: "ActorReport" }],
        config: {
          allowed_builtin_tools: [],
          allowed_dag_tools: ["handoff", "report_activity"],
        },
      });
      const system = canonical.agents[actorId]?.system ?? "";
      expect(system).toContain("report_activity with type progress");
      expect(system).toContain("report_activity with type finding");
      expect(system).toContain("structured\ncommand envelope on command");
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
        "systems_guide.report->collect_round.systems",
        "session_coach.report->collect_round.session",
        "collect_round.ready->wait_for_command.ready",
        "collect_round.blocked->wait_for_command.blocked",
      ].sort());
  });

  it("fans in to waiting and reruns only a commanded Actor with frozen sibling reports", () => {
    const runId = "three-worker-showcase-runtime";
    const dispatcher = new ActorDispatcher();
    const executor = new GraphExecutor(dispatcher);
    executor.createRun(runId, runtimeAsset(), "Plan a friendly two-hour co-op session");

    expect(executor.tick(runId)).toBe(3);
    expect(dispatcher.dispatched.map((entry) => entry.nodeId).sort()).toEqual([...ACTOR_IDS]);
    expect(dispatcher.dispatched.every((entry) => (
      entry.inputs.mission?.[0] === "Plan a friendly two-hour co-op session"
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
        payload: { focus: "Prefer the lower-risk route and explain the tradeoff" },
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
          payload: { focus: "Prefer the lower-risk route and explain the tradeoff" },
        }],
      },
    });
    handoffReport(runId, commanded, report("systems_guide", "Lower-risk route refreshed"));
    expect(executor.tick(runId)).toBe(2);

    const joined = loadRunSnapshot(runId)?.handoffs
      .findLast((entry) => entry.fromNode === "collect_round")?.content;
    expect(joined).toMatchObject({
      total: 3,
      successes: 3,
      passed: true,
      values: expect.arrayContaining([
        expect.objectContaining({ actor: "goal_scout", headline: "goal_scout is ready" }),
        expect.objectContaining({ actor: "session_coach", headline: "session_coach is ready" }),
        expect.objectContaining({ actor: "systems_guide", headline: "Lower-risk route refreshed" }),
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
