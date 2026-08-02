import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  getCompatRecord,
  listCompatRecords,
  upsertCompatRecord,
} from "../src/persistence/compat-records.js";
import { closeDb, getDb } from "../src/persistence/db.js";
import { createInitialDagRunRound } from "../src/persistence/dag-run-rounds.js";
import {
  appendSessionTranscriptEntry,
  checkpointForkSession,
  loadSessionTranscript,
} from "../src/persistence/dag-session-files.js";
import { createChangeRun } from "../src/persistence/change-runs.js";
import { createChange, createProject, updateProject } from "../src/persistence/projects-changes.js";
import {
  ensureRunDir,
  listPersistedRunIdsByStatus,
  listPersistedRunSummaries,
  loadPersistedRunControlState,
  writeRunMetadata,
} from "../src/persistence/store.js";
import { assertEpochMs, epochMsFromUnknown, nowEpochMs, nowIso } from "../src/persistence/time.js";

describe("SQLite persistence contracts", () => {
  let tmpHome: string;
  let oldHome: string | undefined;

  beforeEach(() => {
    oldHome = process.env.HOMERAIL_HOME;
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "homerail-persistence-contracts-"));
    process.env.HOMERAIL_HOME = tmpHome;
    closeDb();
  });

  afterEach(() => {
    closeDb();
    if (oldHome === undefined) {
      delete process.env.HOMERAIL_HOME;
    } else {
      process.env.HOMERAIL_HOME = oldHome;
    }
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it("validates central status domains before writing core records", () => {
    const project = createProject({ name: "Contracts" });
    expect(() => updateProject(project.id, { status: "misspelled" })).toThrow(/Invalid project status/);

    const change = createChange({ title: "Close gaps", project_id: project.id });
    expect(() => createChangeRun({
      change_id: change.id,
      project_id: project.id,
      status: "half_done",
    })).toThrow(/Invalid change_run status/);

    expect(() => writeRunMetadata("run-bad-status", {
      runId: "run-bad-status",
      createdAt: Date.now(),
      status: "stuck",
      nodeStates: {},
      handoffedNodes: [],
    } as never)).toThrow(/Invalid dag_run status/);

    writeRunMetadata("run-waiting", {
      runId: "run-waiting",
      createdAt: Date.now(),
      status: "waiting",
      nodeStates: { await: "WAITING_FOR_COMMAND" },
      handoffedNodes: [],
    });
    expect(getDb().prepare("SELECT status FROM dag_runs WHERE run_id = ?").get("run-waiting"))
      .toEqual({ status: "waiting" });
  });

  it("uses explicit timestamp helpers for ISO and epoch-ms domains", () => {
    expect(Date.parse(nowIso())).toBeGreaterThan(0);
    expect(assertEpochMs(nowEpochMs(), "sample")).toBeGreaterThan(0);
    expect(epochMsFromUnknown("2026-06-23T00:00:00.000Z", "sample")).toBe(1782172800000);
    expect(() => assertEpochMs(1.5, "sample")).toThrow(/epoch millisecond integer/);
  });

  it("provides read/write repositories for Python parity compatibility tables", () => {
    const node = upsertCompatRecord("nodes", {
      id: "node-1",
      name: "Local node",
      status: "connected",
      capabilities: ["docker", "claude"],
      metadata: { host: "mac" },
    });

    expect(node).toMatchObject({
      id: "node-1",
      status: "connected",
      capabilities: ["docker", "claude"],
      metadata: { host: "mac" },
    });
    expect(getCompatRecord("nodes", "node-1")).toMatchObject({ id: "node-1" });
    expect(listCompatRecords("nodes")).toHaveLength(1);

    upsertCompatRecord("event_records", {
      id: "event-1",
      event_type: "dag:engine_started",
      event_data: { runId: "run-1" },
    });
    const row = getDb()
      .prepare("SELECT event_type, event_data FROM event_records WHERE id = ?")
      .get("event-1") as { event_type: string; event_data: string };
    expect(row.event_type).toBe("dag:engine_started");
    expect(JSON.parse(row.event_data)).toEqual({ runId: "run-1" });
  });

  it("serves run hot paths from expanded columns without parsing terminal metadata", () => {
    const createdAt = Date.now();
    writeRunMetadata("run-summary", {
      runId: "run-summary",
      workflowId: "workflow-summary",
      workflowName: "Summary workflow",
      createdAt,
      completedAt: createdAt + 10,
      status: "completed",
      nodeStates: { research: "COMPLETED", review: "COMPLETED" },
      handoffedNodes: ["research", "review"],
      graph: {
        nodes: [
          { node_id: "research", name: "Research" },
          { node_id: "review", name: "Review" },
        ],
        edges: [],
      },
    });
    createInitialDagRunRound({
      run_id: "run-summary",
      round_id: "round-0001",
      target_actor_ids: ["reviewer", "researcher"],
      status: "completed",
      opened_at: createdAt,
      closed_at: createdAt + 10,
    });
    getDb().prepare("UPDATE dag_runs SET metadata = ? WHERE run_id = ?")
      .run("{ intentionally invalid terminal metadata", "run-summary");

    expect(listPersistedRunIdsByStatus(["active", "waiting"])).toEqual([]);
    expect(loadPersistedRunControlState("run-summary")).toEqual({
      status: "completed",
      nodeStates: { research: "COMPLETED", review: "COMPLETED" },
    });
    expect(listPersistedRunSummaries()).toEqual([{
      runId: "run-summary",
      workflowId: "workflow-summary",
      workflowName: "Summary workflow",
      nodeCount: 2,
      status: "completed",
      currentRound: {
        round_id: "round-0001",
        ordinal: 1,
        status: "completed",
        target_actor_ids: ["researcher", "reviewer"],
        opened_at: createdAt,
        closed_at: createdAt + 10,
      },
      createdAt,
      completedAt: createdAt + 10,
    }]);
  });

  it("reports zero nodes for a minimal persisted run", () => {
    ensureRunDir("minimal-run");

    expect(listPersistedRunSummaries()).toEqual([
      expect.objectContaining({
        runId: "minimal-run",
        nodeCount: 0,
        status: "active",
      }),
    ]);
  });

  it("installs indexes for status filtering and updated-time run ordering", () => {
    const db = getDb();
    expect(db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get())
      .toEqual({ version: 35 });
    expect(db.prepare("PRAGMA index_info(idx_dag_runs_updated)").all())
      .toEqual([
        expect.objectContaining({ seqno: 0, name: "updated_at" }),
        expect.objectContaining({ seqno: 1, name: "run_id" }),
      ]);
    expect(db.prepare("PRAGMA index_info(idx_dag_runs_status_updated)").all())
      .toEqual([
        expect.objectContaining({ seqno: 0, name: "status" }),
        expect.objectContaining({ seqno: 1, name: "updated_at" }),
        expect.objectContaining({ seqno: 2, name: "run_id" }),
      ]);

    db.exec(`
      DROP INDEX idx_dag_runs_updated;
      DROP INDEX idx_dag_runs_status_updated;
      DELETE FROM schema_migrations WHERE version = 33;
    `);
    closeDb();
    const migrated = getDb();
    expect(migrated.prepare("SELECT version FROM schema_migrations WHERE version = 33").get())
      .toEqual({ version: 33 });
    expect(migrated.prepare("PRAGMA index_info(idx_dag_runs_status_updated)").all())
      .toHaveLength(3);
  });

  it("appends session transcript JSONL without changing existing entries", () => {
    const baseDir = path.join(tmpHome, "session-store");
    const first = appendSessionTranscriptEntry({
      type: "assistant",
      sessionId: "append-only",
      content: { text: "first" },
      timestamp: 1,
    }, baseDir);
    const firstBytes = fs.readFileSync(
      path.join(baseDir, "append-only", "transcript.jsonl"),
      "utf8",
    );
    const second = appendSessionTranscriptEntry({
      type: "tool_result",
      sessionId: "append-only",
      content: { text: "second" },
      timestamp: 2,
    }, baseDir);
    const finalBytes = fs.readFileSync(
      path.join(baseDir, "append-only", "transcript.jsonl"),
      "utf8",
    );

    expect(finalBytes.startsWith(firstBytes)).toBe(true);
    expect(finalBytes.split("\n").filter(Boolean)).toHaveLength(2);
    expect(loadSessionTranscript("append-only", baseDir)).toEqual([first, second]);
  });

  it.runIf(process.platform !== "win32")(
    "creates and repairs private session-store paths",
    () => {
      const baseDir = path.join(tmpHome, "private-session-store");
      const sessionId = "private-session";
      const sessionRoot = path.join(baseDir, sessionId);
      const transcript = path.join(sessionRoot, "transcript.jsonl");
      const snapshot = path.join(sessionRoot, "session.json");

      appendSessionTranscriptEntry({
        type: "assistant",
        sessionId,
        content: { text: "first" },
        timestamp: 1,
      }, baseDir);

      expect(fs.statSync(sessionRoot).mode & 0o777).toBe(0o700);
      expect(fs.statSync(transcript).mode & 0o777).toBe(0o600);
      expect(fs.statSync(snapshot).mode & 0o777).toBe(0o600);

      fs.chmodSync(sessionRoot, 0o755);
      fs.chmodSync(transcript, 0o644);
      fs.chmodSync(snapshot, 0o644);
      appendSessionTranscriptEntry({
        type: "assistant",
        sessionId,
        content: { text: "second" },
        timestamp: 2,
      }, baseDir);

      expect(fs.statSync(sessionRoot).mode & 0o777).toBe(0o700);
      expect(fs.statSync(transcript).mode & 0o777).toBe(0o600);
      expect(fs.statSync(snapshot).mode & 0o777).toBe(0o600);

      checkpointForkSession({
        runId: "run-private-fork",
        nodeId: "worker",
        parentSessionId: sessionId,
        newSessionId: "private-fork",
        last: 1,
      }, baseDir);
      const forkRoot = path.join(baseDir, "private-fork");
      expect(fs.statSync(forkRoot).mode & 0o777).toBe(0o700);
      expect(fs.statSync(path.join(forkRoot, "transcript.jsonl")).mode & 0o777).toBe(0o600);
      expect(fs.statSync(path.join(forkRoot, "session.json")).mode & 0o777).toBe(0o600);
    },
  );

  it("rejects invalid status and missing required secret payloads in compatibility records", () => {
    expect(() => upsertCompatRecord("nodes", {
      id: "node-invalid",
      status: "probably_connected",
    })).toThrow(/Invalid node status/);

    expect(() => upsertCompatRecord("encrypted_credentials", {
      id: "cred-1",
      credential_type: "api_key",
      name: "Provider key",
    })).toThrow(/Missing required encrypted_credentials.encrypted_payload/);
  });
});
