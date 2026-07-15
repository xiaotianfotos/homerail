import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  acknowledgeDagActorCommand,
  advanceDagActorGeneration,
  cancelUnclaimedDagActorCommands,
  claimDagActorCommand,
  createDagActorCommand,
  DagActorConflictError,
  deliverDagActorCommand,
  failDagActorCommand,
  getDagActor,
  getDagActorCommand,
  listDagActorCommands,
  listDagActors,
  markDagActorCommandDelivered,
  registerDagActor,
  updateDagActorBinding,
} from "../src/persistence/dag-actors.js";
import { closeDb, getDb } from "../src/persistence/db.js";
import { ensureRunDir } from "../src/persistence/store.js";
import { parseDAGYaml } from "../src/orchestration/yaml-loader.js";
import {
  _clearActiveRuns,
  buildCurrentDispatchEnvelope,
  createActiveRun,
  getActiveRun,
  recoverAllActiveRuns,
} from "../src/runtime/active-runs.js";

function registerActor(overrides: Partial<Parameters<typeof registerDagActor>[0]> = {}) {
  return registerDagActor({
    run_id: "run-1",
    actor_id: "researcher",
    node_id: "research-node",
    role: "research",
    model_profile: { agent_id: "research-agent", provider: "local", model: "test-model" },
    surface_id: "surface-research",
    workspace_ref: "project-1",
    ...overrides,
  });
}

function createCommand(overrides: Partial<Parameters<typeof createDagActorCommand>[0]> = {}) {
  return createDagActorCommand({
    command_id: "command-1",
    run_id: "run-1",
    actor_id: "researcher",
    round_id: "round-1",
    idempotency_key: "research-round-1",
    payload: { instruction: "Find three primary sources" },
    ...overrides,
  });
}

function twoActorDag(secondActorId: string, secondSurfaceId: string) {
  return parseDAGYaml(`
name: logical-actor-identity
workflow_id: logical-actor-identity
agents:
  worker:
    agent_type: deterministic
    system: HANDOFF port=done content=ok
nodes:
  first:
    agent: worker
    extra:
      agent_runtime:
        actor_id: shared
        surface_id: surface-first
    outputs:
      done:
        to: ""
  second:
    agent: worker
    extra:
      agent_runtime:
        actor_id: ${secondActorId}
        surface_id: ${secondSurfaceId}
    outputs:
      done:
        to: ""
`);
}

describe("durable DAG logical actors and command inbox", () => {
  let home: string;
  let oldHome: string | undefined;

  beforeEach(() => {
    closeDb();
    oldHome = process.env.HOMERAIL_HOME;
    home = fs.mkdtempSync(path.join(os.tmpdir(), "homerail-dag-actors-"));
    process.env.HOMERAIL_HOME = home;
    ensureRunDir("run-1");
    _clearActiveRuns();
  });

  afterEach(() => {
    _clearActiveRuns();
    closeDb();
    if (oldHome === undefined) delete process.env.HOMERAIL_HOME;
    else process.env.HOMERAIL_HOME = oldHome;
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("upgrades a v19 database and validates migration v20 on repeated startup", () => {
    getDb().exec(`
      DROP TABLE dag_run_rounds;
      DROP TABLE dag_surface_projection_controls;
      DROP TABLE dag_surface_projection_queue;
      DROP TABLE dag_surface_projections;
      DROP INDEX idx_dag_actors_projection_identity;
      DROP TABLE dag_actor_commands;
      DROP TABLE dag_actors;
      DELETE FROM schema_migrations WHERE version IN (20, 21, 22, 23);
    `);
    closeDb();

    const migrated = getDb();
    expect(migrated.prepare("SELECT version FROM schema_migrations WHERE version = 20").get())
      .toEqual({ version: 20 });
    expect(migrated.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'dag_actors'").get())
      .toEqual({ name: "dag_actors" });
    closeDb();

    const reopened = getDb();
    expect(reopened.prepare("SELECT COUNT(*) AS count FROM schema_migrations WHERE version = 20").get())
      .toEqual({ count: 1 });
    expect(reopened.prepare("PRAGMA index_list(dag_actor_commands)").all())
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ name: "idx_dag_actor_commands_idempotency", unique: 1 }),
        expect.objectContaining({ name: "idx_dag_actor_commands_actor_status", unique: 0 }),
        expect.objectContaining({ name: "idx_dag_actor_commands_round", unique: 0 }),
      ]));
  });

  it("fails closed when a v20 migration marker points at a non-unique surface index", () => {
    getDb().exec(`
      DROP INDEX idx_dag_actors_run_surface;
      CREATE INDEX idx_dag_actors_run_surface ON dag_actors(run_id, surface_id);
    `);
    closeDb();

    expect(() => getDb()).toThrow(
      "Schema migration 20 is incomplete: index idx_dag_actors_run_surface must be unique",
    );
  });

  it("keeps actor identity and surface ownership stable across registration and restart", () => {
    const first = registerActor();
    const duplicate = registerActor({ model_profile: { api_key: "sk-should-not-replace-existing" } });
    registerActor({
      actor_id: "writer",
      node_id: "write-node",
      role: "writing",
      surface_id: "surface-write",
    });
    registerActor({
      actor_id: "visualizer",
      node_id: "visualize-node",
      role: "visualization",
      surface_id: "surface-visualize",
    });

    expect(first).toMatchObject({ inserted: true, deduplicated: false });
    expect(duplicate).toMatchObject({ inserted: false, deduplicated: true });
    expect(listDagActors("run-1").map((actor) => [actor.actor_id, actor.surface_id]))
      .toEqual([
        ["researcher", "surface-research"],
        ["visualizer", "surface-visualize"],
        ["writer", "surface-write"],
      ]);
    expect(() => registerActor({ actor_id: "other", surface_id: "surface-research" }))
      .toThrowError(expect.objectContaining<DagActorConflictError>({ code: "actor_identity_conflict" }));

    closeDb();
    expect(listDagActors("run-1").map((actor) => [actor.actor_id, actor.surface_id]))
      .toEqual([
        ["researcher", "surface-research"],
        ["visualizer", "surface-visualize"],
        ["writer", "surface-write"],
      ]);
  });

  it("redacts model bindings and enforces version CAS updates", () => {
    const actor = registerActor({
      model_profile: {
        provider: "remote",
        api_key: "sk-supersecretvalue123456",
        authorization: "Bearer abcdefghijklmnopqrstuvwxyz",
      },
    }).actor;
    expect(actor.model_profile).toEqual({
      api_key: "***REDACTED***",
      authorization: "***REDACTED***",
      provider: "remote",
    });

    const updated = updateDagActorBinding({
      run_id: "run-1",
      actor_id: "researcher",
      expected_version: actor.version,
      session_id: "session-1",
      checkpoint_ref: "checkpoint-1",
    });
    expect(updated).toMatchObject({ session_id: "session-1", attempt: 1, checkpoint_ref: "checkpoint-1", version: 2 });
    expect(() => updateDagActorBinding({
      run_id: "run-1",
      actor_id: "researcher",
      expected_version: actor.version,
      workspace_ref: "other-project",
    })).toThrowError(expect.objectContaining<DagActorConflictError>({ code: "actor_version_conflict" }));
  });

  it("registers graph actors once and dispatches the durable actor identity after restart", () => {
    const dag = parseDAGYaml(`
name: logical-actor-runtime
workflow_id: logical-actor-runtime
workspace:
  project_id: showcase
agents:
  worker:
    agent_type: deterministic
    system: HANDOFF port=done content=ok
nodes:
  research:
    agent: worker
    extra:
      agent_runtime:
        actor_id: researcher
        role: research
        surface_id: surface-research
    outputs:
      done:
        to: ""
  compare:
    agent: worker
    extra:
      agent_runtime:
        actor_id: comparator
        role: comparison
        surface_id: surface-compare
    outputs:
      done:
        to: ""
  present:
    agent: worker
    extra:
      agent_runtime:
        actor_id: presenter
        role: presentation
        surface_id: surface-present
    outputs:
      done:
        to: ""
`);
    createActiveRun("runtime-run", dag);

    expect(listDagActors("runtime-run").map((actor) => ({
      actor_id: actor.actor_id,
      node_id: actor.node_id,
      role: actor.role,
      surface_id: actor.surface_id,
    }))).toEqual([
      { actor_id: "comparator", node_id: "compare", role: "comparison", surface_id: "surface-compare" },
      { actor_id: "presenter", node_id: "present", role: "presentation", surface_id: "surface-present" },
      { actor_id: "researcher", node_id: "research", role: "research", surface_id: "surface-research" },
    ]);
    const first = buildCurrentDispatchEnvelope("runtime-run", "research");
    expect(first).toMatchObject({
      ok: true,
      envelope: {
        activity: {
          actorId: "researcher",
          generation: 1,
          surfaceId: "surface-research",
        },
      },
    });

    _clearActiveRuns();
    closeDb();
    expect(recoverAllActiveRuns().recovered).toContain("runtime-run");
    const afterRestart = buildCurrentDispatchEnvelope("runtime-run", "research");
    expect(afterRestart).toMatchObject({
      ok: true,
      envelope: {
        sessionId: first.ok ? first.envelope.sessionId : undefined,
        activity: {
          actorId: "researcher",
          generation: 1,
          surfaceId: "surface-research",
        },
      },
    });
    expect(listDagActors("runtime-run")).toHaveLength(3);
  });

  it.each([
    ["actor", "shared", "surface-second", "DAG actor shared is configured for both nodes"],
    ["surface", "second", "surface-first", "DAG surface surface-first is configured for both nodes"],
  ])("rejects duplicate %s ownership before persisting a run", (_kind, actorId, surfaceId, message) => {
    const runId = `duplicate-${_kind}-run`;
    expect(() => createActiveRun(runId, twoActorDag(actorId, surfaceId))).toThrow(message);

    expect(getActiveRun(runId)).toBeUndefined();
    expect(getDb().prepare("SELECT run_id FROM dag_runs WHERE run_id = ?").get(runId)).toBeUndefined();
    expect(listDagActors(runId)).toEqual([]);
  });

  it("rolls back the run and previously registered actors when actor persistence fails", () => {
    const runId = "actor-registration-rollback";
    const dag = twoActorDag("second", "surface-second");
    const secondRuntime = dag.graph.nodes[1]?.extra?.agent_runtime as Record<string, unknown>;
    secondRuntime.role = "x".repeat(257);

    expect(() => createActiveRun(runId, dag)).toThrow("role must be between 1 and 256 characters");
    expect(getActiveRun(runId)).toBeUndefined();
    expect(getDb().prepare("SELECT run_id FROM dag_runs WHERE run_id = ?").get(runId)).toBeUndefined();
    expect(listDagActors(runId)).toEqual([]);
  });

  it("persists a command before immediate delivery and retains it when the actor is offline", async () => {
    registerActor();
    const created = createCommand();
    expect(created).toMatchObject({ changed: true, deduplicated: false });

    const offline = await deliverDagActorCommand({
      command_id: "command-1",
      deliver: (command) => {
        expect(getDagActorCommand(command.command_id)?.status).toBe("pending");
        return false;
      },
    });
    expect(offline).toMatchObject({ delivered: false, changed: false });
    expect(getDagActorCommand("command-1")?.status).toBe("pending");

    closeDb();
    expect(getDagActorCommand("command-1")?.status).toBe("pending");
    const delivered = await deliverDagActorCommand({
      command_id: "command-1",
      deliver: () => true,
    });
    expect(delivered).toMatchObject({ delivered: true, changed: true });
    expect(getDagActorCommand("command-1")?.status).toBe("delivered");
  });

  it("deduplicates command ids and idempotency keys without duplicate execution", () => {
    registerActor();
    const first = createCommand();
    const duplicateId = createCommand();
    const duplicateKey = createCommand({ command_id: "command-retry" });

    expect(first).toMatchObject({ changed: true, deduplicated: false });
    expect(duplicateId).toMatchObject({ changed: false, deduplicated: true });
    expect(duplicateKey).toMatchObject({ changed: false, deduplicated: true });
    expect(duplicateKey.command.command_id).toBe("command-1");
    expect(listDagActorCommands({ run_id: "run-1" })).toHaveLength(1);
    expect(() => createCommand({ payload: { instruction: "Different work" } }))
      .toThrowError(expect.objectContaining<DagActorConflictError>({ code: "command_identity_conflict" }));
  });

  it("cancels only pending and delivered commands while preserving audit rows", () => {
    registerActor();
    createCommand();
    createCommand({ command_id: "command-2", idempotency_key: "research-round-1-delivered" });
    createCommand({ command_id: "command-3", idempotency_key: "research-round-1-claimed" });
    const delivered = markDagActorCommandDelivered("command-2").command;
    claimDagActorCommand({
      command_id: "command-3",
      run_id: "run-1",
      actor_id: "researcher",
      generation: 1,
    });

    const cancelled = cancelUnclaimedDagActorCommands({
      run_id: "run-1",
      completed_at: Date.now() + 1_000,
      reason: { status: "cancelled", message: "run cancelled" },
    });

    expect(cancelled.map((command) => [command.command_id, command.status]))
      .toEqual([
        ["command-1", "cancelled"],
        ["command-2", "cancelled"],
      ]);
    expect(getDagActorCommand("command-2")).toMatchObject({
      status: "cancelled",
      delivered_at: delivered.delivered_at,
      failure: { status: "cancelled", message: "run cancelled" },
    });
    expect(getDagActorCommand("command-3")?.status).toBe("claimed");
    expect(listDagActorCommands({ run_id: "run-1" })).toHaveLength(3);
    expect(cancelUnclaimedDagActorCommands("run-1")).toEqual([]);
    expect(() => claimDagActorCommand({
      command_id: "command-1",
      run_id: "run-1",
      actor_id: "researcher",
      generation: 1,
    })).toThrowError(expect.objectContaining<DagActorConflictError>({ code: "command_status_conflict" }));
  });

  it("cancels unclaimed commands for only the intervened actor", () => {
    registerActor();
    registerActor({
      actor_id: "writer",
      node_id: "writer-node",
      role: "write",
      surface_id: "surface-writer",
    });
    createCommand();
    createCommand({
      command_id: "writer-command",
      actor_id: "writer",
      idempotency_key: "writer-round-1",
    });

    expect(cancelUnclaimedDagActorCommands({
      run_id: "run-1",
      actor_id: "researcher",
      reason: { operation: "retry" },
    }).map((command) => command.command_id)).toEqual(["command-1"]);
    expect(getDagActorCommand("command-1")?.status).toBe("cancelled");
    expect(getDagActorCommand("writer-command")?.status).toBe("pending");
  });

  it("allows only the current generation to claim and complete a command", () => {
    const actor = registerActor().actor;
    const generationTwo = advanceDagActorGeneration({
      run_id: "run-1",
      actor_id: "researcher",
      expected_generation: actor.generation,
      expected_version: actor.version,
      session_id: "session-2",
      attempt: 2,
      checkpoint_ref: "checkpoint-2",
    });
    expect(generationTwo).toMatchObject({ generation: 2, attempt: 2, version: 2, session_id: "session-2" });
    expect(() => advanceDagActorGeneration({
      run_id: "run-1",
      actor_id: "researcher",
      expected_generation: 1,
      expected_version: 1,
    })).toThrowError(expect.objectContaining<DagActorConflictError>({ code: "actor_generation_conflict" }));

    createCommand({ target_generation: 2 });
    expect(() => claimDagActorCommand({
      command_id: "command-1",
      run_id: "run-1",
      actor_id: "researcher",
      generation: 1,
    })).toThrowError(expect.objectContaining<DagActorConflictError>({ code: "command_generation_conflict" }));

    const claimed = claimDagActorCommand({
      command_id: "command-1",
      run_id: "run-1",
      actor_id: "researcher",
      generation: 2,
    });
    const duplicateClaim = claimDagActorCommand({
      command_id: "command-1",
      run_id: "run-1",
      actor_id: "researcher",
      generation: 2,
    });
    expect(claimed).toMatchObject({ changed: true, command: { status: "claimed", claimed_generation: 2 } });
    expect(duplicateClaim).toMatchObject({ changed: false, deduplicated: true });
    expect(acknowledgeDagActorCommand({ command_id: "command-1", generation: 2 }))
      .toMatchObject({ changed: true, command: { status: "acknowledged" } });
    expect(() => failDagActorCommand({
      command_id: "command-1",
      generation: 2,
      failure: { message: "too late" },
    })).toThrowError(expect.objectContaining<DagActorConflictError>({ code: "command_status_conflict" }));
  });

  it("redacts a failed command before persistence", () => {
    registerActor();
    createCommand();
    claimDagActorCommand({
      command_id: "command-1",
      run_id: "run-1",
      actor_id: "researcher",
      generation: 1,
    });
    const failed = failDagActorCommand({
      command_id: "command-1",
      generation: 1,
      failure: { message: "request failed token=plain-secret-value", api_key: "sk-anothersecretvalue123" },
    });
    expect(failed.command).toMatchObject({
      status: "failed",
      failure: {
        message: "request failed token=***REDACTED***",
        api_key: "***REDACTED***",
      },
    });
    const raw = getDb().prepare("SELECT failure_json FROM dag_actor_commands WHERE command_id = ?")
      .get("command-1") as { failure_json: string };
    expect(raw.failure_json).not.toContain("plain-secret-value");
    expect(raw.failure_json).not.toContain("anothersecretvalue");
  });
});
