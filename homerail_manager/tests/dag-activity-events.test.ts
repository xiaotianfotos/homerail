import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DAG_ACTIVITY_EVENT_SCHEMA_VERSION,
  type DagActivityEventV1,
} from "homerail-protocol";
import {
  appendDagActivityEvent,
  DagActivityJournalConflictError,
  getDagActivityContiguousSequenceCursor,
  listDagActivityEvents,
  MAX_DAG_ACTIVITY_EVENT_BYTES,
  MAX_DAG_ACTIVITY_REPLAY_LIMIT,
  MAX_DAG_ACTIVITY_SEQUENCE_AHEAD,
} from "../src/persistence/dag-activity-journal.js";
import { clearTables, closeDb, getDb } from "../src/persistence/db.js";
import { appendEvent, ensureRunDir } from "../src/persistence/store.js";

function activity(overrides: Partial<DagActivityEventV1> = {}): DagActivityEventV1 {
  return {
    schema_version: DAG_ACTIVITY_EVENT_SCHEMA_VERSION,
    event_id: "activity-1",
    run_id: "run-1",
    round_id: "round-1",
    node_id: "research-node",
    actor_id: "researcher",
    generation: 1,
    surface_id: "surface-news",
    sequence: 1,
    timestamp: 1_784_000_000_000,
    type: "progress",
    payload: { message: "checking sources", percent: 10 },
    ...overrides,
  };
}

describe("DAG activity journal persistence", () => {
  let home: string;
  let oldHome: string | undefined;

  beforeEach(() => {
    closeDb();
    oldHome = process.env.HOMERAIL_HOME;
    home = fs.mkdtempSync(path.join(os.tmpdir(), "homerail-activity-journal-"));
    process.env.HOMERAIL_HOME = home;
  });

  afterEach(() => {
    closeDb();
    if (oldHome === undefined) delete process.env.HOMERAIL_HOME;
    else process.env.HOMERAIL_HOME = oldHome;
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("upgrades a v18 database without changing legacy dag_events", () => {
    ensureRunDir("legacy-run");
    appendEvent("legacy-run", {
      type: "RUN_CREATED",
      payload: { source: "legacy" },
      timestamp: 1_700_000_000_000,
    });
    getDb().exec(`
      DROP TABLE dag_activity_events;
      DELETE FROM schema_migrations WHERE version IN (19, 25);
    `);
    closeDb();

    const migrated = getDb();
    expect(migrated.prepare("SELECT version FROM schema_migrations WHERE version = 19").get())
      .toEqual({ version: 19 });
    expect(migrated.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'dag_activity_events'",
    ).get()).toEqual({ name: "dag_activity_events" });
    expect(migrated.prepare("SELECT event_type, data FROM dag_events WHERE run_id = ?").get("legacy-run"))
      .toMatchObject({ event_type: "RUN_CREATED" });
  });

  it("validates migration v19 on repeated startup without duplicating schema state", () => {
    const first = getDb();
    expect(first.prepare("SELECT COUNT(*) AS count FROM schema_migrations WHERE version = 19").get())
      .toEqual({ count: 1 });
    closeDb();

    const reopened = getDb();
    expect(reopened.prepare("SELECT COUNT(*) AS count FROM schema_migrations WHERE version = 19").get())
      .toEqual({ count: 1 });
    expect(reopened.prepare("PRAGMA index_list(dag_activity_events)").all())
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ name: "idx_dag_activity_events_event_id", unique: 1 }),
        expect.objectContaining({ name: "idx_dag_activity_events_actor_sequence", unique: 1 }),
        expect.objectContaining({ name: "idx_dag_activity_events_run_seq", unique: 0 }),
        expect.objectContaining({ name: "idx_dag_activity_events_run_actor_seq", unique: 0 }),
      ]));
  });

  it("fails closed when a v19 migration marker points at an invalid uniqueness index", () => {
    getDb().exec(`
      DROP INDEX idx_dag_activity_events_actor_sequence;
      CREATE UNIQUE INDEX idx_dag_activity_events_actor_sequence
        ON dag_activity_events(run_id, actor_id, round_id, activity_sequence);
    `);
    closeDb();

    expect(() => getDb()).toThrow(
      "Schema migration 19 is incomplete: index idx_dag_activity_events_actor_sequence has invalid columns",
    );
  });

  it("deduplicates the same semantic event_id and rejects semantic reuse", () => {
    ensureRunDir("run-1");
    const first = appendDagActivityEvent(activity({
      payload: { message: "checking sources", detail: { z: 2, a: 1 } },
    }));
    const duplicate = appendDagActivityEvent(activity({
      payload: { detail: { a: 1, z: 2 }, message: "checking sources" },
    }));

    expect(first).toMatchObject({ inserted: true, deduplicated: false });
    expect(duplicate).toMatchObject({
      seq: first.seq,
      inserted: false,
      deduplicated: true,
    });
    expect(getDb().prepare("SELECT COUNT(*) AS count FROM dag_activity_events").get())
      .toEqual({ count: 1 });

    expect(() => appendDagActivityEvent(activity({ payload: { message: "different meaning" } })))
      .toThrowError(expect.objectContaining<DagActivityJournalConflictError>({ code: "event_id_collision" }));
  });

  it("enforces sequence identity across rounds but scopes it by actor generation", () => {
    ensureRunDir("run-1");
    appendDagActivityEvent(activity());

    expect(() => appendDagActivityEvent(activity({
      event_id: "activity-round-2",
      round_id: "round-2",
    }))).toThrowError(expect.objectContaining<DagActivityJournalConflictError>({ code: "sequence_collision" }));

    expect(appendDagActivityEvent(activity({
      event_id: "activity-other-actor",
      actor_id: "writer",
      round_id: "round-2",
    })).inserted).toBe(true);
    expect(appendDagActivityEvent(activity({
      event_id: "activity-next-generation",
      generation: 2,
      round_id: "round-2",
    })).inserted).toBe(true);
  });

  it("bounds out-of-order activity around the earliest gap and advances after repair", () => {
    ensureRunDir("run-1");
    appendDagActivityEvent(activity({ event_id: "activity-2", sequence: 2 }));
    expect(getDagActivityContiguousSequenceCursor("run-1", "researcher", 1)).toBe(0);

    expect(() => appendDagActivityEvent(activity({
      event_id: "activity-too-far",
      sequence: MAX_DAG_ACTIVITY_SEQUENCE_AHEAD + 1,
    }))).toThrowError(expect.objectContaining<DagActivityJournalConflictError>({ code: "sequence_gap" }));

    appendDagActivityEvent(activity({ event_id: "activity-1-repair", sequence: 1 }));
    expect(getDagActivityContiguousSequenceCursor("run-1", "researcher", 1)).toBe(2);
    expect(appendDagActivityEvent(activity({ event_id: "activity-3", sequence: 3 })).inserted).toBe(true);
    expect(getDagActivityContiguousSequenceCursor("run-1", "researcher", 1)).toBe(3);
  });

  it("redacts secrets before persistence and supports explicit journal clearing", () => {
    ensureRunDir("run-1");
    appendDagActivityEvent(activity({
      type: "tool_used",
      payload: {
        api_key: "sk-supersecretvalue123456",
        nested: {
          authorization: "Bearer abcdefghijklmnopqrstuvwxyz",
          message: "request failed token=plain-secret-value",
        },
      },
    }));

    const raw = getDb().prepare("SELECT event_json FROM dag_activity_events").get() as { event_json: string };
    expect(raw.event_json).not.toContain("supersecretvalue");
    expect(raw.event_json).not.toContain("abcdefghijklmnopqrstuvwxyz");
    expect(raw.event_json).not.toContain("plain-secret-value");
    expect(listDagActivityEvents({ run_id: "run-1" }).events[0].event.payload)
      .toEqual({
        api_key: "***REDACTED***",
        nested: {
          authorization: "***REDACTED***",
          message: "request failed token=***REDACTED***",
        },
      });

    clearTables(["dag_activity_events"]);
    expect(getDb().prepare("SELECT COUNT(*) AS count FROM dag_activity_events").get())
      .toEqual({ count: 0 });
  });

  it("rejects an oversized event at the Manager persistence boundary", () => {
    ensureRunDir("run-1");
    expect(() => appendDagActivityEvent(activity({
      payload: { message: "x".repeat(MAX_DAG_ACTIVITY_EVENT_BYTES) },
    }))).toThrow(`exceeds ${MAX_DAG_ACTIVITY_EVENT_BYTES} bytes`);
    expect(getDb().prepare("SELECT COUNT(*) AS count FROM dag_activity_events").get())
      .toEqual({ count: 0 });
  });

  it("replays in journal order with actor filtering and an after_seq cursor", () => {
    ensureRunDir("run-1");
    const first = appendDagActivityEvent(activity({ event_id: "a-1", actor_id: "actor-a", sequence: 1 }));
    const second = appendDagActivityEvent(activity({ event_id: "b-1", actor_id: "actor-b", sequence: 1 }));
    const third = appendDagActivityEvent(activity({ event_id: "a-2", actor_id: "actor-a", sequence: 2 }));

    expect(listDagActivityEvents({ run_id: "run-1" }).events.map((entry) => entry.event.event_id))
      .toEqual(["a-1", "b-1", "a-2"]);
    expect(listDagActivityEvents({ run_id: "run-1", actor_id: "actor-a" }).events.map((entry) => entry.seq))
      .toEqual([first.seq, third.seq]);
    const afterFirst = listDagActivityEvents({ run_id: "run-1", after_seq: first.seq, limit: 1 });
    expect(afterFirst).toMatchObject({
      has_more: true,
      next_after_seq: second.seq,
      limit: 1,
    });
    expect(afterFirst.events.map((entry) => entry.event.event_id)).toEqual(["b-1"]);
  });

  it("replays the complete durable sequence after a Manager database restart", () => {
    ensureRunDir("restart-run");
    appendDagActivityEvent(activity({
      event_id: "restart-1",
      run_id: "restart-run",
      sequence: 1,
      type: "started",
    }));
    appendDagActivityEvent(activity({
      event_id: "restart-2",
      run_id: "restart-run",
      sequence: 2,
      type: "completed",
    }));

    closeDb();

    const replay = listDagActivityEvents({ run_id: "restart-run" });
    expect(replay.events.map((entry) => ({
      event_id: entry.event.event_id,
      sequence: entry.event.sequence,
      type: entry.event.type,
    }))).toEqual([
      { event_id: "restart-1", sequence: 1, type: "started" },
      { event_id: "restart-2", sequence: 2, type: "completed" },
    ]);
  });

  it("caps oversized replay pages and returns a resumable cursor", () => {
    ensureRunDir("large-run");
    for (let sequence = 1; sequence <= MAX_DAG_ACTIVITY_REPLAY_LIMIT + 1; sequence += 1) {
      appendDagActivityEvent(activity({
        event_id: `large-${sequence}`,
        run_id: "large-run",
        sequence,
      }));
    }

    const first = listDagActivityEvents({ run_id: "large-run", limit: 50_000 });
    expect(first.limit).toBe(MAX_DAG_ACTIVITY_REPLAY_LIMIT);
    expect(first.events).toHaveLength(MAX_DAG_ACTIVITY_REPLAY_LIMIT);
    expect(first.has_more).toBe(true);
    const last = listDagActivityEvents({ run_id: "large-run", after_seq: first.next_after_seq });
    expect(last.events.map((entry) => entry.event.event_id)).toEqual([
      `large-${MAX_DAG_ACTIVITY_REPLAY_LIMIT + 1}`,
    ]);
    expect(last.has_more).toBe(false);
  });
});
