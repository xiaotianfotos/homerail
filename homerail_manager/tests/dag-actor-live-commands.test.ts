import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createDagActorLiveCommandBatch,
  DagActorLiveCommandConflictError,
  getDagActorLiveCommand,
  listDagActorLiveCommands,
  listOutstandingDagActorLiveCommands,
  MAX_DAG_ACTOR_OUTSTANDING_LIVE_COMMANDS_PER_RUN,
  markDagActorLiveCommandFallback,
  recordDagActorLiveCommandSendAttempt,
  transitionDagActorLiveCommand,
} from "../src/persistence/dag-actor-live-commands.js";
import { registerDagActor } from "../src/persistence/dag-actors.js";
import { closeDb, getDb } from "../src/persistence/db.js";
import { expectCurrentSchemaMigrationVersion } from "./schema-migration-helpers.js";
import { ensureRunDir } from "../src/persistence/store.js";

const token = "a".repeat(64);

describe("durable DAG Actor live commands", () => {
  let home: string;
  let previousHome: string | undefined;

  beforeEach(() => {
    closeDb();
    previousHome = process.env.HOMERAIL_HOME;
    home = fs.mkdtempSync(path.join(os.tmpdir(), "homerail-live-commands-"));
    process.env.HOMERAIL_HOME = home;
    ensureRunDir("run-1");
    registerDagActor({
      run_id: "run-1",
      actor_id: "actor-1",
      node_id: "node-1",
      role: "first",
      surface_id: "surface-1",
      session_id: "session-1",
    });
    registerDagActor({
      run_id: "run-1",
      actor_id: "actor-2",
      node_id: "node-2",
      role: "second",
      surface_id: "surface-2",
      session_id: "session-2",
    });
  });

  afterEach(() => {
    closeDb();
    if (previousHome === undefined) delete process.env.HOMERAIL_HOME;
    else process.env.HOMERAIL_HOME = previousHome;
    fs.rmSync(home, { recursive: true, force: true });
  });

  function input(actorId: "actor-1" | "actor-2", key: string, payload: unknown = { instruction: key }) {
    const suffix = actorId.at(-1)!;
    return {
      run_id: "run-1",
      actor_id: actorId,
      node_id: `node-${suffix}`,
      session_id: `session-${suffix}`,
      round_id: "round-0001",
      target_generation: 1,
      target_lease_generation: 0,
      expected_state_token: token,
      idempotency_key: key,
      payload,
    };
  }

  it("creates, validates, and reapplies migration 28 on repeated startup", () => {
    expectCurrentSchemaMigrationVersion();
    expect(getDb().prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    getDb().exec(`
      DROP TABLE dag_actor_live_commands;
      DELETE FROM schema_migrations WHERE version = 28;
    `);
    closeDb();
    expect(getDb().prepare("SELECT version FROM schema_migrations WHERE version = 28").get())
      .toEqual({ version: 28 });
    closeDb();
    expect(getDb().prepare("SELECT COUNT(*) AS count FROM schema_migrations WHERE version = 28").get())
      .toEqual({ count: 1 });
  });

  it("fails closed when a migration marker hides an invalid idempotency index", () => {
    getDb().exec(`
      DROP INDEX idx_dag_actor_live_commands_idempotency;
      CREATE INDEX idx_dag_actor_live_commands_idempotency
        ON dag_actor_live_commands(run_id, actor_id, idempotency_key);
    `);
    closeDb();
    expect(() => getDb()).toThrow(
      "Schema migration 28 is incomplete: index idx_dag_actor_live_commands_idempotency is missing or invalid",
    );
  });

  it("atomically allocates per-Actor sequence and deduplicates stable command identity", () => {
    const first = createDagActorLiveCommandBatch([input("actor-1", "turn-1", {
      instruction: "continue",
      api_key: "sk-private-value",
    })])[0];
    expect(first).toMatchObject({ changed: true, deduplicated: false, command: { sequence: 1, status: "queued" } });
    expect(first.command.command_id).toMatch(/^dag-live-[0-9a-f]{64}$/);
    expect(JSON.stringify(first.command)).not.toContain("sk-private-value");
    expect(createDagActorLiveCommandBatch([input("actor-1", "turn-1", {
      instruction: "continue",
      api_key: "different-secret-is-redacted",
    })])[0]).toMatchObject({
      changed: false,
      deduplicated: true,
      command: { command_id: first.command.command_id, sequence: 1 },
    });

    const second = createDagActorLiveCommandBatch([input("actor-1", "turn-2")])[0].command;
    expect(second.sequence).toBe(2);
    expect(() => createDagActorLiveCommandBatch([input("actor-1", "turn-2", { instruction: "different" })]))
      .toThrowError(expect.objectContaining<DagActorLiveCommandConflictError>({
        code: "live_command_identity_conflict",
      }));

    expect(() => createDagActorLiveCommandBatch(
      [input("actor-1", "atomic-new"), input("actor-2", "atomic-fail")],
      { validate_new: (candidate) => {
        if (candidate.actor_id === "actor-2") throw new Error("stale sibling token");
      } },
    )).toThrow("stale sibling token");
    expect(listDagActorLiveCommands({ run_id: "run-1" }).map((command) => command.idempotency_key))
      .not.toContain("atomic-new");
  });

  it("keeps socket attempts queued and advances only explicit lifecycle status", () => {
    const command = createDagActorLiveCommandBatch([input("actor-1", "lifecycle")])[0].command;
    const attempted = recordDagActorLiveCommandSendAttempt({
      command_id: command.command_id,
      session_id: "session-live",
      round_id: "round-0001",
      lease_generation: 3,
    }).command;
    expect(attempted).toMatchObject({ status: "queued", delivery_attempts: 1, target_lease_generation: 3 });
    expect(transitionDagActorLiveCommand({ command_id: command.command_id, status: "delivered" }).command.status)
      .toBe("delivered");
    expect(transitionDagActorLiveCommand({ command_id: command.command_id, status: "applied" }).command.status)
      .toBe("applied");
    expect(transitionDagActorLiveCommand({ command_id: command.command_id, status: "completed" }).command)
      .toMatchObject({ status: "completed", delivered_at: expect.any(Number), applied_at: expect.any(Number) });
  });

  it("rejects outstanding-command overflow without partially inserting a batch", () => {
    const db = getDb();
    const insert = db.prepare(`
      INSERT INTO dag_actor_live_commands(
        command_id, run_id, actor_id, node_id, session_id, round_id,
        target_generation, target_lease_generation, expected_state_token, sequence,
        status, idempotency_key, payload_digest, payload_json, created_at, updated_at
      ) VALUES (?, 'run-1', 'actor-2', 'node-2', 'session-2', 'round-0001',
        1, 0, ?, ?, 'queued', ?, ?, '{}', ?, ?)
    `);
    db.transaction(() => {
      for (let sequence = 1; sequence < MAX_DAG_ACTOR_OUTSTANDING_LIVE_COMMANDS_PER_RUN; sequence++) {
        insert.run(
          `capacity-seed-${sequence}`,
          token,
          sequence,
          `capacity-key-${sequence}`,
          "0".repeat(64),
          sequence,
          sequence,
        );
      }
    }).immediate();

    expect(() => createDagActorLiveCommandBatch([
      input("actor-1", "overflow-first"),
      input("actor-2", "overflow-second"),
    ])).toThrowError(expect.objectContaining<DagActorLiveCommandConflictError>({
      code: "live_command_capacity_exceeded",
    }));
    expect(db.prepare(`
      SELECT COUNT(*) AS count FROM dag_actor_live_commands
      WHERE run_id = 'run-1' AND status IN ('queued', 'delivered', 'applied')
    `).get()).toEqual({ count: MAX_DAG_ACTOR_OUTSTANDING_LIVE_COMMANDS_PER_RUN - 1 });
    expect(db.prepare(`
      SELECT command_id FROM dag_actor_live_commands
      WHERE idempotency_key IN ('overflow-first', 'overflow-second')
    `).all()).toEqual([]);
    expect(listOutstandingDagActorLiveCommands("run-1")).toHaveLength(
      MAX_DAG_ACTOR_OUTSTANDING_LIVE_COMMANDS_PER_RUN - 1,
    );
  });

  it("persists bounded redacted fallback and terminal reasons", () => {
    const fallbackCommand = createDagActorLiveCommandBatch([input("actor-1", "fallback")])[0].command;
    const queued = markDagActorLiveCommandFallback({
      command_id: fallbackCommand.command_id,
      reason: `Authorization: Bearer ${"x".repeat(64)}`,
    }).command;
    expect(queued.status).toBe("queued");
    expect(queued.fallback_reason).toContain("REDACTED");
    expect(queued.fallback_reason).not.toContain("x".repeat(64));

    const failedCommand = createDagActorLiveCommandBatch([input("actor-2", "failed")])[0].command;
    const failed = transitionDagActorLiveCommand({
      command_id: failedCommand.command_id,
      status: "failed",
      reason: `${"reason ".repeat(1000)} token=private-value`,
    }).command;
    expect(failed.status).toBe("failed");
    expect(Buffer.byteLength(failed.terminal_reason ?? "", "utf8")).toBeLessThan(4096);
    expect(failed.terminal_reason).not.toContain("private-value");
    expect(getDagActorLiveCommand(failed.command_id)).toEqual(failed);
  });
});
