import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { DAGDispatcher, DispatchEnvelope, DispatchResult } from "../src/orchestration/dag-dispatcher.js";
import { parseDAGYaml } from "../src/orchestration/yaml-loader.js";
import { _clearListeners, subscribe } from "../src/events/bus.js";
import { closeDb } from "../src/persistence/db.js";
import { getDagSessionIndex } from "../src/persistence/dag-session-index.js";
import { appendSessionTranscriptForTest, loadSessionTranscript } from "../src/persistence/dag-session-files.js";
import { getDagActorByNode } from "../src/persistence/dag-actors.js";
import { _clearAllPersistence } from "../src/persistence/store.js";
import {
  _clearActiveRuns,
  checkpointResumeActiveRun,
  createActiveRun,
  dispatchReadyNodes,
  getCurrentNodeSession,
  isCurrentNodeSession,
} from "../src/runtime/active-runs.js";

class CaptureDispatcher implements DAGDispatcher {
  readonly dispatched: DispatchEnvelope[] = [];

  dispatch(envelope: DispatchEnvelope): DispatchResult {
    this.dispatched.push(envelope);
    return { status: "dispatched", targetType: "fake", targetId: "fake" };
  }
}

function simpleDag() {
  return parseDAGYaml(`
name: session-resume
workflow_id: session-resume
workspace:
  project_id: project-a
agents:
  worker:
    agent_type: deterministic
    system: "HANDOFF port=done content=ok"
nodes:
  work:
    agent: worker
    outputs:
      done:
        to: ""
`);
}

function twoEntryNodeDag() {
  return parseDAGYaml(`
name: two-node-session-resume
workflow_id: two-node-session-resume
workspace:
  project_id: project-a
agents:
  worker:
    agent_type: deterministic
    system: "HANDOFF port=done content=ok"
nodes:
  coder:
    agent: worker
    outputs:
      done:
        to: ""
  tester:
    agent: worker
    outputs:
      done:
        to: ""
`);
}

describe("DAG node SessionStore resume control plane", () => {
  let tmpHome: string;
  let oldHome: string | undefined;

  beforeEach(() => {
    oldHome = process.env.HOMERAIL_HOME;
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "homerail-dag-session-resume-"));
    process.env.HOMERAIL_HOME = tmpHome;
    closeDb();
    _clearActiveRuns();
    _clearAllPersistence();
    _clearListeners();
  });

  afterEach(() => {
    _clearActiveRuns();
    _clearAllPersistence();
    _clearListeners();
    closeDb();
    if (oldHome === undefined) delete process.env.HOMERAIL_HOME;
    else process.env.HOMERAIL_HOME = oldHome;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it("creates a per-node session index and sends it in the dispatch envelope", () => {
    createActiveRun("run-session-index", simpleDag());
    const dispatcher = new CaptureDispatcher();

    expect(dispatchReadyNodes("run-session-index", dispatcher)).toBe(1);
    const envelope = dispatcher.dispatched[0];
    expect(envelope.sessionId).toMatch(/^dag-run-session-index-work-/);
    expect(envelope.checkpointResume).toBeUndefined();

    const persisted = getDagSessionIndex("run-session-index", "work");
    expect(persisted).toMatchObject({
      run_id: "run-session-index",
      node_id: "work",
      project_key: "project-a",
      session_id: envelope.sessionId,
      attempt: 1,
      status: "running",
    });
  });

  it("assigns independent sessions to multiple nodes in the same run", () => {
    createActiveRun("run-two-node-sessions", twoEntryNodeDag());
    const dispatcher = new CaptureDispatcher();

    expect(dispatchReadyNodes("run-two-node-sessions", dispatcher)).toBe(2);
    const sessionIds = dispatcher.dispatched.map((envelope) => envelope.sessionId);
    expect(new Set(sessionIds).size).toBe(2);
    expect(getDagSessionIndex("run-two-node-sessions", "coder")?.session_id)
      .toBe(dispatcher.dispatched.find((envelope) => envelope.nodeId === "coder")?.sessionId);
    expect(getDagSessionIndex("run-two-node-sessions", "tester")?.session_id)
      .toBe(dispatcher.dispatched.find((envelope) => envelope.nodeId === "tester")?.sessionId);
  });

  it("forks a new node session and injects checkpoint resume into the next prompt", () => {
    createActiveRun("run-checkpoint-resume", simpleDag());
    const dispatcher = new CaptureDispatcher();
    expect(dispatchReadyNodes("run-checkpoint-resume", dispatcher)).toBe(1);
    const parentSessionId = dispatcher.dispatched[0].sessionId!;
    expect(getDagActorByNode("run-checkpoint-resume", "work")).toMatchObject({
      generation: 1,
      attempt: 1,
      session_id: parentSessionId,
    });
    appendSessionTranscriptForTest(parentSessionId, [
      { uuid: "entry-1", type: "prompt_start", runId: "run-checkpoint-resume", nodeId: "work", content: "first" },
      { uuid: "entry-123", parentUuid: "entry-1", type: "text", runId: "run-checkpoint-resume", nodeId: "work", content: "checkpoint" },
      { uuid: "entry-after", parentUuid: "entry-123", type: "text", runId: "run-checkpoint-resume", nodeId: "work", content: "discarded" },
    ]);
    const events: unknown[] = [];
    subscribe("dag:checkpoint_resume", (payload) => events.push(payload));

    const scheduled = checkpointResumeActiveRun("run-checkpoint-resume", "work", {
      entryUuid: "entry-123",
      instruction: "Resume from the checkpoint and keep the original handoff contract.",
    });

    expect(scheduled).toMatchObject({
      status: "scheduled",
      runId: "run-checkpoint-resume",
      nodeId: "work",
      parentSessionId,
      attempt: 2,
      entryUuid: "entry-123",
      keptEntries: 2,
      totalEntries: 3,
    });
    expect(events).toHaveLength(1);
    expect(isCurrentNodeSession("run-checkpoint-resume", "work", parentSessionId)).toBe(false);

    expect(dispatchReadyNodes("run-checkpoint-resume", dispatcher)).toBe(1);
    const resumeEnvelope = dispatcher.dispatched[1];
    expect(resumeEnvelope.sessionId).toBe((scheduled as { sessionId: string }).sessionId);
    expect(resumeEnvelope.sessionId).not.toBe(parentSessionId);
    expect(resumeEnvelope.inputs.checkpoint_resume).toEqual([
      "Resume from the checkpoint and keep the original handoff contract.",
    ]);
    expect(resumeEnvelope.checkpointResume).toMatchObject({
      parentSessionId,
      entryUuid: "entry-123",
      attempt: 2,
    });
    expect(resumeEnvelope.activity).toMatchObject({ generation: 2 });
    expect(getDagActorByNode("run-checkpoint-resume", "work")).toMatchObject({
      generation: 2,
      attempt: 2,
      session_id: resumeEnvelope.sessionId,
      checkpoint_ref: "entry-123",
    });

    const current = getCurrentNodeSession("run-checkpoint-resume", "work");
    expect(current?.sessionId).toBe(resumeEnvelope.sessionId);
    expect(current?.parentSessionId).toBe(parentSessionId);
    expect(getDagSessionIndex("run-checkpoint-resume", "work")).toMatchObject({
      session_id: resumeEnvelope.sessionId,
      parent_session_id: parentSessionId,
      forked_from_entry_uuid: "entry-123",
      attempt: 2,
      status: "running",
    });
    expect(loadSessionTranscript(parentSessionId)).toHaveLength(3);
    const forkedTranscript = loadSessionTranscript(resumeEnvelope.sessionId!);
    expect(forkedTranscript).toHaveLength(2);
    expect(forkedTranscript.map((entry) => entry.uuid)).not.toEqual(["entry-1", "entry-123"]);
    expect(forkedTranscript[1]?.parentUuid).toBe(forkedTranscript[0]?.uuid);
    expect(JSON.stringify(forkedTranscript)).toContain("rewoundFromEntryUuid");
    expect(JSON.stringify(forkedTranscript)).toContain("entry-123");
    expect(forkedTranscript.map((entry) => entry.sessionId)).toEqual([
      resumeEnvelope.sessionId,
      resumeEnvelope.sessionId,
    ]);
  });

  it("resolves --last against the parent transcript before forking", () => {
    createActiveRun("run-checkpoint-last", simpleDag());
    const dispatcher = new CaptureDispatcher();
    expect(dispatchReadyNodes("run-checkpoint-last", dispatcher)).toBe(1);
    const parentSessionId = dispatcher.dispatched[0].sessionId!;
    appendSessionTranscriptForTest(parentSessionId, [
      { uuid: "entry-1", type: "prompt_start", runId: "run-checkpoint-last", nodeId: "work" },
      { uuid: "entry-2", type: "text", runId: "run-checkpoint-last", nodeId: "work" },
      { uuid: "entry-3", type: "text", runId: "run-checkpoint-last", nodeId: "work" },
    ]);

    const scheduled = checkpointResumeActiveRun("run-checkpoint-last", "work", {
      last: 2,
      instruction: "Resume from the second latest transcript entry.",
    });

    expect(scheduled).toMatchObject({
      status: "scheduled",
      entryUuid: "entry-2",
      keptEntries: 2,
      totalEntries: 3,
    });
    expect(dispatchReadyNodes("run-checkpoint-last", dispatcher)).toBe(1);
    const forkedTranscript = loadSessionTranscript(dispatcher.dispatched[1].sessionId!);
    expect(forkedTranscript).toHaveLength(2);
    expect(forkedTranscript.map((entry) => entry.uuid)).not.toEqual(["entry-1", "entry-2"]);
    expect(JSON.stringify(forkedTranscript)).toContain("entry-2");
  });

  it("fails checkpoint resume when no parent transcript exists", () => {
    createActiveRun("run-no-transcript", simpleDag());
    const dispatcher = new CaptureDispatcher();
    expect(dispatchReadyNodes("run-no-transcript", dispatcher)).toBe(1);
    const parentSessionId = dispatcher.dispatched[0].sessionId!;

    const result = checkpointResumeActiveRun("run-no-transcript", "work", {
      last: 1,
      instruction: "Resume from missing transcript.",
    });

    expect(result).toMatchObject({ status: "unavailable" });
    expect((result as { reason: string }).reason).toContain(`No transcript found for parent session ${parentSessionId}`);
    expect(getCurrentNodeSession("run-no-transcript", "work")?.sessionId).toBe(parentSessionId);
  });

  it("fails checkpoint resume explicitly when the run only exists in persisted replay data", () => {
    createActiveRun("run-replay-only-resume", simpleDag());
    const dispatcher = new CaptureDispatcher();
    expect(dispatchReadyNodes("run-replay-only-resume", dispatcher)).toBe(1);
    const persisted = getDagSessionIndex("run-replay-only-resume", "work");
    expect(persisted?.session_id).toBe(dispatcher.dispatched[0].sessionId);

    _clearActiveRuns();

    const result = checkpointResumeActiveRun("run-replay-only-resume", "work", {
      last: 1,
      instruction: "Resume this persisted run.",
    });

    expect(result).toMatchObject({ status: "unavailable" });
    expect((result as { reason: string }).reason).toContain("not active in this Manager process");
    expect(getDagSessionIndex("run-replay-only-resume", "work")?.session_id).toBe(persisted?.session_id);
  });

  it("refuses to reuse the parent session id for a checkpoint resume fork", () => {
    createActiveRun("run-parent-session-reuse", simpleDag());
    const dispatcher = new CaptureDispatcher();
    expect(dispatchReadyNodes("run-parent-session-reuse", dispatcher)).toBe(1);
    const parentSessionId = dispatcher.dispatched[0].sessionId!;

    const result = checkpointResumeActiveRun("run-parent-session-reuse", "work", {
      instruction: "Resume without modifying the original transcript.",
      sessionId: parentSessionId,
    });

    expect(result).toMatchObject({ status: "unavailable" });
    expect((result as { reason: string }).reason).toContain("refusing to reuse the parent session");
    expect(getCurrentNodeSession("run-parent-session-reuse", "work")?.sessionId).toBe(parentSessionId);
    expect(getDagSessionIndex("run-parent-session-reuse", "work")?.session_id).toBe(parentSessionId);
  });
});
