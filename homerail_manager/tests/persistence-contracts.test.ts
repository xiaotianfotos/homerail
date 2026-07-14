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
import { createChangeRun } from "../src/persistence/change-runs.js";
import { createChange, createProject, updateProject } from "../src/persistence/projects-changes.js";
import { writeRunMetadata } from "../src/persistence/store.js";
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
