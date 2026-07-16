import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  acknowledgeDagActorCommand,
  claimDagActorCommand,
  createDagActorCommand,
  failDagActorCommand,
  markDagActorCommandDelivered,
  registerDagActor,
} from "../src/persistence/dag-actors.js";
import { closeDb, getDb } from "../src/persistence/db.js";
import {
  createInitialDagRunRound,
  DagRunRoundConflictError,
  getCurrentDagRunRound,
  getDagRunRound,
  listDagRunRounds,
  openNextDagRunRound,
  terminalizeCurrentDagRunRound,
  transitionDagRunRoundToWaiting,
} from "../src/persistence/dag-run-rounds.js";
import {
  appendHandoff,
  ensureRunDir,
  loadRunMetadata,
  loadRunSnapshot,
  serializeRunMetadata,
  writeRunMetadata,
} from "../src/persistence/store.js";

function registerActor(): void {
  registerDagActor({
    run_id: "run-1",
    actor_id: "researcher",
    node_id: "research",
    role: "research",
    surface_id: "surface-research",
  });
}

function createCommand(commandId: string): void {
  createDagActorCommand({
    command_id: commandId,
    run_id: "run-1",
    actor_id: "researcher",
    round_id: "round-0001",
    idempotency_key: `key-${commandId}`,
    payload: { command_id: commandId },
  });
}

function downgradeActorCommandsToV20(): void {
  const db = getDb();
  db.transaction(() => db.exec(`
    DROP TABLE dag_run_rounds;
    ALTER TABLE dag_actor_commands RENAME TO dag_actor_commands_v23_source;
    CREATE TABLE dag_actor_commands (
      command_id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      round_id TEXT NOT NULL,
      target_generation INTEGER NOT NULL CHECK(target_generation >= 1),
      status TEXT NOT NULL CHECK(status IN ('pending', 'delivered', 'claimed', 'acknowledged', 'failed')),
      idempotency_key TEXT NOT NULL,
      payload_digest TEXT NOT NULL CHECK(length(payload_digest) = 64),
      payload_json TEXT NOT NULL,
      claimed_generation INTEGER CHECK(claimed_generation IS NULL OR claimed_generation >= 1),
      created_at INTEGER NOT NULL CHECK(created_at >= 0),
      delivered_at INTEGER CHECK(delivered_at IS NULL OR delivered_at >= created_at),
      claimed_at INTEGER CHECK(claimed_at IS NULL OR claimed_at >= created_at),
      completed_at INTEGER CHECK(completed_at IS NULL OR completed_at >= created_at),
      failure_json TEXT,
      CHECK(
        (status = 'pending' AND delivered_at IS NULL AND claimed_generation IS NULL AND claimed_at IS NULL AND completed_at IS NULL AND failure_json IS NULL)
        OR (status = 'delivered' AND delivered_at IS NOT NULL AND claimed_generation IS NULL AND claimed_at IS NULL AND completed_at IS NULL AND failure_json IS NULL)
        OR (status = 'claimed' AND claimed_generation IS NOT NULL AND claimed_at IS NOT NULL AND completed_at IS NULL AND failure_json IS NULL)
        OR (status = 'acknowledged' AND claimed_generation IS NOT NULL AND claimed_at IS NOT NULL AND completed_at IS NOT NULL AND failure_json IS NULL)
        OR (status = 'failed' AND claimed_generation IS NOT NULL AND claimed_at IS NOT NULL AND completed_at IS NOT NULL AND failure_json IS NOT NULL)
      ),
      FOREIGN KEY(run_id, actor_id) REFERENCES dag_actors(run_id, actor_id) ON DELETE CASCADE
    );
    INSERT INTO dag_actor_commands SELECT * FROM dag_actor_commands_v23_source;
    DROP TABLE dag_actor_commands_v23_source;
    CREATE UNIQUE INDEX idx_dag_actor_commands_idempotency
      ON dag_actor_commands(run_id, actor_id, idempotency_key);
    CREATE INDEX idx_dag_actor_commands_actor_status
      ON dag_actor_commands(run_id, actor_id, status, created_at, command_id);
    CREATE INDEX idx_dag_actor_commands_round
      ON dag_actor_commands(run_id, round_id, created_at, command_id);
    DELETE FROM schema_migrations WHERE version = 23;
    INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (21, 'parallel-21');
    INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (22, 'parallel-22');
  `)).immediate();
}

describe("DAG run round persistence", () => {
  let home: string;
  let oldHome: string | undefined;

  beforeEach(() => {
    closeDb();
    oldHome = process.env.HOMERAIL_HOME;
    home = fs.mkdtempSync(path.join(os.tmpdir(), "homerail-dag-rounds-"));
    process.env.HOMERAIL_HOME = home;
    ensureRunDir("run-1");
  });

  afterEach(() => {
    closeDb();
    if (oldHome === undefined) delete process.env.HOMERAIL_HOME;
    else process.env.HOMERAIL_HOME = oldHome;
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("migrates v20 actor commands without data loss and tolerates reserved v21/v22 markers", () => {
    getDb().transaction(() => {
      registerActor();
      for (const commandId of ["pending", "delivered", "claimed", "acknowledged", "failed"]) {
        createCommand(commandId);
      }
      markDagActorCommandDelivered("delivered");
      claimDagActorCommand({ command_id: "claimed", run_id: "run-1", actor_id: "researcher", generation: 1 });
      claimDagActorCommand({ command_id: "acknowledged", run_id: "run-1", actor_id: "researcher", generation: 1 });
      acknowledgeDagActorCommand({ command_id: "acknowledged", generation: 1 });
      claimDagActorCommand({ command_id: "failed", run_id: "run-1", actor_id: "researcher", generation: 1 });
      failDagActorCommand({ command_id: "failed", generation: 1, failure: { message: "expected" } });
    }).immediate();

    const expectedRows = getDb().prepare("SELECT * FROM dag_actor_commands ORDER BY command_id").all();
    downgradeActorCommandsToV20();
    closeDb();

    const migrated = getDb();
    expect(migrated.prepare("SELECT version FROM schema_migrations WHERE version >= 21 ORDER BY version").all())
      .toEqual([
        { version: 21 },
        { version: 22 },
        { version: 23 },
        { version: 24 },
        { version: 25 },
        { version: 26 },
        { version: 27 },
      ]);
    expect(migrated.prepare("SELECT * FROM dag_actor_commands ORDER BY command_id").all())
      .toEqual(expectedRows);
    expect(migrated.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(migrated.prepare("PRAGMA index_list(dag_run_rounds)").all())
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ name: "idx_dag_run_rounds_run_ordinal", unique: 1, partial: 0 }),
        expect.objectContaining({ name: "idx_dag_run_rounds_current", unique: 1, partial: 1 }),
      ]));
    expect(migrated.prepare("PRAGMA foreign_key_list(dag_run_rounds)").all())
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ table: "dag_runs", from: "run_id", to: "run_id", on_delete: "CASCADE" }),
      ]));
    expect(migrated.prepare("PRAGMA index_list(dag_actor_commands)").all())
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ name: "idx_dag_actor_commands_idempotency", unique: 1 }),
        expect.objectContaining({ name: "idx_dag_actor_commands_actor_status", unique: 0 }),
        expect.objectContaining({ name: "idx_dag_actor_commands_round", unique: 0 }),
      ]));
    expect((migrated.prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'dag_actor_commands'",
    ).get() as { sql: string }).sql).toContain("'cancelled'");

    migrated.prepare("DELETE FROM schema_migrations WHERE version = 23").run();
    closeDb();
    const reapplied = getDb();
    expect(reapplied.prepare("SELECT COUNT(*) AS count FROM schema_migrations WHERE version = 23").get())
      .toEqual({ count: 1 });
    expect(reapplied.prepare("SELECT * FROM dag_actor_commands ORDER BY command_id").all())
      .toEqual(expectedRows);
  });

  it("fails closed when the current-round index is not unique and partial", () => {
    getDb().exec(`
      DROP INDEX idx_dag_run_rounds_current;
      CREATE UNIQUE INDEX idx_dag_run_rounds_current ON dag_run_rounds(run_id);
    `);
    closeDb();

    expect(() => getDb()).toThrow(
      "Schema migration 23 is incomplete: index idx_dag_run_rounds_current is missing or invalid",
    );
  });

  it("closes an active round to waiting exactly once", () => {
    const initial = createInitialDagRunRound({
      run_id: "run-1",
      round_id: "round-0001",
      target_actor_ids: ["writer", "researcher", "writer"],
      opened_at: 100,
    });
    expect(initial).toMatchObject({
      ordinal: 1,
      status: "active",
      target_actor_ids: ["researcher", "writer"],
    });

    const waiting = transitionDagRunRoundToWaiting({
      run_id: "run-1",
      round_id: "round-0001",
      await_node_id: "await-next-command",
      closed_at: 200,
      expires_at: 500,
    });
    expect(waiting).toMatchObject({
      status: "waiting",
      await_node_id: "await-next-command",
      closed_at: 200,
      expires_at: 500,
    });
    expect(() => transitionDagRunRoundToWaiting({
      run_id: "run-1",
      round_id: "round-0001",
      await_node_id: "await-next-command",
      closed_at: 200,
    })).toThrowError(expect.objectContaining<DagRunRoundConflictError>({ code: "round_status_conflict" }));
  });

  it("enforces one current round and one ordinal per run", () => {
    createInitialDagRunRound({
      run_id: "run-1",
      round_id: "round-0001",
      target_actor_ids: ["researcher"],
      opened_at: 100,
    });
    expect(() => createInitialDagRunRound({
      run_id: "run-1",
      round_id: "round-other",
      target_actor_ids: ["writer"],
      opened_at: 100,
    })).toThrowError(expect.objectContaining<DagRunRoundConflictError>({ code: "initial_round_conflict" }));

    expect(() => getDb().prepare(`
      INSERT INTO dag_run_rounds(
        run_id, round_id, ordinal, status, target_actor_ids_json, opened_at
      ) VALUES (?, ?, ?, 'active', '[]', ?)
    `).run("run-1", "round-0002", 2, 200)).toThrow(/UNIQUE constraint failed/);
    expect(() => getDb().prepare(`
      INSERT INTO dag_run_rounds(
        run_id, round_id, ordinal, status, target_actor_ids_json, opened_at, closed_at
      ) VALUES (?, ?, ?, 'completed', '[]', ?, ?)
    `).run("run-1", "round-same-ordinal", 1, 200, 200)).toThrow(/UNIQUE constraint failed/);
  });

  it("completes the waiting round and opens monotonically increasing ordinals atomically", () => {
    createInitialDagRunRound({
      run_id: "run-1",
      round_id: "round-0001",
      target_actor_ids: ["researcher"],
      opened_at: 100,
    });
    transitionDagRunRoundToWaiting({
      run_id: "run-1",
      round_id: "round-0001",
      await_node_id: "await",
      closed_at: 200,
    });
    const second = openNextDagRunRound({
      run_id: "run-1",
      expected_round_id: "round-0001",
      round_id: "round-0002",
      target_actor_ids: ["writer"],
      opened_at: 300,
    });
    expect(second).toMatchObject({ round_id: "round-0002", ordinal: 2, status: "active" });
    expect(getDagRunRound("run-1", "round-0001")?.status).toBe("completed");
    expect(getCurrentDagRunRound("run-1")?.round_id).toBe("round-0002");

    transitionDagRunRoundToWaiting({
      run_id: "run-1",
      round_id: "round-0002",
      await_node_id: "await",
      closed_at: 400,
    });
    const third = openNextDagRunRound({
      run_id: "run-1",
      expected_round_id: "round-0002",
      round_id: "round-0003",
      target_actor_ids: ["researcher", "writer"],
      opened_at: 500,
    });
    expect(third.ordinal).toBe(3);
    expect(listDagRunRounds("run-1").map((round) => [round.ordinal, round.status]))
      .toEqual([[1, "completed"], [2, "completed"], [3, "active"]]);
  });

  it("terminalizes the expected current round and rejects stale repeats", () => {
    createInitialDagRunRound({
      run_id: "run-1",
      round_id: "round-0001",
      target_actor_ids: ["researcher"],
      opened_at: 100,
    });
    expect(terminalizeCurrentDagRunRound({
      run_id: "run-1",
      round_id: "round-0001",
      status: "failed",
      closed_at: 200,
    })).toMatchObject({ status: "failed", closed_at: 200 });
    expect(getCurrentDagRunRound("run-1")).toBeUndefined();
    expect(() => terminalizeCurrentDagRunRound({
      run_id: "run-1",
      round_id: "round-0001",
      status: "failed",
      closed_at: 200,
    })).toThrowError(expect.objectContaining<DagRunRoundConflictError>({ code: "current_round_conflict" }));
  });

  it("serializes round and DAG runtime state deterministically while reading legacy metadata", () => {
    const metadata = serializeRunMetadata({
      runId: "run-1",
      createdAt: 100,
      status: "waiting",
      currentRound: {
        round_id: "round-0001",
        ordinal: 1,
        status: "waiting",
        target_actor_ids: ["writer", "researcher", "writer"],
        await_node_id: "await",
        opened_at: 100,
        closed_at: 200,
        expires_at: 500,
      },
      dagRun: {
        nodeStates: new Map([["writer", "READY"], ["researcher", "COMPLETED"]]),
        handoffedNodes: new Set(["writer", "researcher"]),
        graph: { nodes: [], edges: [] },
        afterSatisfied: new Map([
          ["writer", new Set(["researcher", "source"])],
          ["researcher", new Set()],
        ]),
        inputSatisfied: new Map([
          ["writer", new Set(["source", "researcher"])],
          ["researcher", new Set()],
        ]),
        mailboxes: new Map([
          ["writer", new Map([["z-port", [{ z: 1 }]], ["a-port", [{ a: 1 }]]])],
          ["researcher", new Map()],
        ]),
        loopSources: new Set(["writer", "researcher"]),
      },
    });

    expect(metadata.currentRound).toEqual({
      round_id: "round-0001",
      ordinal: 1,
      status: "waiting",
      target_actor_ids: ["researcher", "writer"],
      await_node_id: "await",
      opened_at: 100,
      closed_at: 200,
      expires_at: 500,
    });
    expect(metadata.dagRuntimeState).toEqual({
      after_satisfied: { researcher: [], writer: ["researcher", "source"] },
      input_satisfied: { researcher: [], writer: ["researcher", "source"] },
      mailboxes: {
        researcher: {},
        writer: { "a-port": [{ a: 1 }], "z-port": [{ z: 1 }] },
      },
      loop_sources: ["researcher", "writer"],
    });
    expect(Object.keys(metadata.nodeStates)).toEqual(["researcher", "writer"]);
    expect(metadata.handoffedNodes).toEqual(["researcher", "writer"]);

    writeRunMetadata("run-1", metadata);
    expect(loadRunMetadata("run-1")).toMatchObject({
      currentRound: metadata.currentRound,
      dagRuntimeState: metadata.dagRuntimeState,
    });
    appendHandoff("run-1", {
      runId: "run-1",
      fromNode: "legacy",
      port: "done",
      timestamp: 300,
    });
    appendHandoff("run-1", {
      runId: "run-1",
      roundId: "round-0001",
      fromNode: "researcher",
      port: "done",
      timestamp: 400,
    });
    expect(loadRunSnapshot("run-1")?.handoffs.map((handoff) => handoff.roundId))
      .toEqual([undefined, "round-0001"]);

    const legacy = serializeRunMetadata({
      runId: "legacy-run",
      createdAt: 100,
      status: "active",
      dagRun: {
        nodeStates: new Map(),
        handoffedNodes: new Set(),
        graph: { nodes: [], edges: [] },
      },
    });
    expect(legacy).not.toHaveProperty("currentRound");
    expect(legacy).not.toHaveProperty("dagRuntimeState");
  });
});
