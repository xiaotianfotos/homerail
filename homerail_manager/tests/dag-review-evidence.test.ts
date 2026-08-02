import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { changedFilesCoverage } from "homerail-protocol";

import { registerDagActor } from "../src/persistence/dag-actors.js";
import { closeDb, getDb } from "../src/persistence/db.js";
import {
  injectReviewerEvidenceMailbox,
  loadReviewAttemptEvidence,
  persistReviewAttemptEvidence,
  reviewEvidenceCorrectionState,
} from "../src/persistence/dag-review-evidence.js";
import { writeRunMetadata } from "../src/persistence/store.js";
import { createDAGRun } from "../src/orchestration/dag-engine.js";
import { parseDAGYaml } from "../src/orchestration/yaml-loader.js";

const files = Array.from({ length: 49 }, (_, index) => `src/file-${String(index + 1).padStart(2, "0")}.ts`);
const coverage = changedFilesCoverage(files);

const threeFindings = [
  { category: "runtime", severity: "high", title: "Finding one", file: "src/run.ts", line: 1, evidence: "e1", recommendation: "r1", confidence: "high" },
  { category: "security", severity: "medium", title: "Finding two", file: "src/auth.ts", line: 2, evidence: "e2", recommendation: "r2", confidence: "medium" },
  { category: "tests", severity: "low", title: "Finding three", file: "src/spec.ts", line: 3, evidence: "e3", recommendation: "r3", confidence: "low" },
];

function reviewGraph() {
  return parseDAGYaml(`
name: pr-review-evidence-fixture
workflow_id: pr-review-evidence-fixture
agents:
  qwen_reviewer:
    agent_type: deterministic
    system: "HANDOFF port=voted content=ok"
nodes:
  qwen_review:
    agent: qwen_reviewer
    outputs:
      voted:
        to: normalize_qwen_review
  normalize_qwen_review:
    agent: qwen_reviewer
    after: [qwen_review]
    outputs:
      reviewed:
        to: ""
`);
}

function minimalRun(runId: string): void {
  writeRunMetadata(runId, {
    runId,
    createdAt: Date.now(),
    status: "active",
    nodeStates: { qwen_review: "RUNNING", normalize_qwen_review: "PENDING" },
    handoffedNodes: [],
  });
}

describe("Manager PR review evidence", () => {
  let oldHome: string | undefined;
  let tmpHome: string;

  beforeEach(() => {
    oldHome = process.env.HOMERAIL_HOME;
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "homerail-review-evidence-"));
    process.env.HOMERAIL_HOME = tmpHome;
    closeDb();
  });

  afterEach(() => {
    closeDb();
    if (oldHome === undefined) delete process.env.HOMERAIL_HOME;
    else process.env.HOMERAIL_HOME = oldHome;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  function seedActor(runId: string, sessionId = "session-a", generation = 1): void {
    registerDagActor({
      run_id: runId,
      actor_id: `actor-${runId}`,
      node_id: "qwen_review",
      role: "reviewer",
      surface_id: "surface-a",
      session_id: sessionId,
    });
    if (generation !== 1) {
      getDb().prepare("UPDATE dag_actors SET generation = ? WHERE run_id = ? AND node_id = ?")
        .run(generation, runId, "qwen_review");
    }
  }

  it("persists bounded findings, attempts, and trusted coverage with fencing", () => {
    const runId = "evidence-fenced";
    minimalRun(runId);
    seedActor(runId, "session-a", 2);

    const stored = persistReviewAttemptEvidence({
      runId,
      nodeId: "qwen_review",
      attempt: 1,
      sessionId: "session-a",
      generation: 2,
      category: "accepted",
      terminationReason: "end_turn",
      outputTokens: 120,
      outputTokenLimit: null,
      toolArgumentParse: "ok",
      contractStage: "accepted",
      findings: threeFindings,
      coverage,
    });
    expect(stored).toEqual({ stored: true });

    const evidence = loadReviewAttemptEvidence(runId, "qwen_review");
    expect(evidence.findings).toEqual(threeFindings);
    expect(evidence.attempts).toMatchObject([{ attempt: 1, category: "accepted", output_tokens: 120 }]);
    expect(evidence.coverage).toEqual(coverage);

    // Stale session and stale generation are rejected fail-closed.
    expect(persistReviewAttemptEvidence({
      runId,
      nodeId: "qwen_review",
      attempt: 2,
      sessionId: "session-stale",
      generation: 2,
      category: "provider_output_truncated",
      coverage,
    })).toMatchObject({ stored: false, reason: "review evidence session fence mismatch" });
    expect(persistReviewAttemptEvidence({
      runId,
      nodeId: "qwen_review",
      attempt: 2,
      sessionId: "session-a",
      generation: 1,
      category: "provider_output_truncated",
      coverage,
    })).toMatchObject({ stored: false, reason: "review evidence generation fence mismatch" });

    // Cross-node writes are rejected; non-reviewer nodes are ignored.
    expect(persistReviewAttemptEvidence({
      runId,
      nodeId: "kimi_review",
      attempt: 1,
      sessionId: "session-a",
      generation: 2,
      category: "accepted",
      coverage,
    })).toMatchObject({ stored: false, reason: "review actor record is missing" });
    expect(persistReviewAttemptEvidence({
      runId,
      nodeId: "decide",
      attempt: 1,
      sessionId: "session-a",
      generation: 2,
      category: "accepted",
      coverage,
    })).toMatchObject({ stored: false, reason: "evidence node is not a PR review reviewer node" });

    // Duplicate attempt writes are idempotent.
    expect(persistReviewAttemptEvidence({
      runId,
      nodeId: "qwen_review",
      attempt: 1,
      sessionId: "session-a",
      generation: 2,
      category: "accepted",
      findings: threeFindings,
      coverage,
    })).toEqual({ stored: true });
    expect(loadReviewAttemptEvidence(runId, "qwen_review").attempts).toHaveLength(1);
    expect(loadReviewAttemptEvidence(runId, "qwen_review").findings).toHaveLength(3);
  });

  it("rejects oversized evidence and caps accepted findings", () => {
    const runId = "evidence-bounded";
    minimalRun(runId);
    seedActor(runId);
    const oversized = Array.from({ length: 40 }, (_, index) => ({
      ...threeFindings[0]!,
      evidence: "x".repeat(30_000),
      title: `Oversized ${index}`,
      line: index + 1,
    }));
    expect(persistReviewAttemptEvidence({
      runId,
      nodeId: "qwen_review",
      attempt: 1,
      sessionId: "session-a",
      generation: 1,
      category: "accepted",
      findings: oversized,
      coverage,
    })).toMatchObject({ stored: false, reason: "findings evidence exceeds the bounded size" });

    const many = Array.from({ length: 60 }, (_, index) => ({
      ...threeFindings[0]!,
      title: `Finding ${index}`,
      line: index + 1,
    }));
    expect(persistReviewAttemptEvidence({
      runId,
      nodeId: "qwen_review",
      attempt: 1,
      sessionId: "session-a",
      generation: 1,
      category: "accepted",
      findings: many,
      coverage,
    })).toEqual({ stored: true });
    expect(loadReviewAttemptEvidence(runId, "qwen_review").findings).toHaveLength(50);
  });

  it("survives a cold DB reopen and injects evidence into the normalize mailbox", () => {
    const runId = "evidence-cold-recovery";
    minimalRun(runId);
    seedActor(runId);
    expect(persistReviewAttemptEvidence({
      runId,
      nodeId: "qwen_review",
      attempt: 1,
      sessionId: "session-a",
      generation: 1,
      category: "contract_validation_failed",
      contractStage: "rejected",
      redactedReason: "coverage attestation mismatch",
      findings: threeFindings,
      coverage,
    })).toEqual({ stored: true });

    const parsed = reviewGraph();
    const dagRun = createDAGRun(parsed, runId);
    const mailboxRun = {
      runId,
      dagRun,
    };
    expect(injectReviewerEvidenceMailbox(mailboxRun, "qwen_review")).toBe(true);
    const evidence = mailboxRun.dagRun.mailboxes.get("normalize_qwen_review")?.get("evidence")?.at(-1);
    expect(evidence).toMatchObject({
      findings: threeFindings,
      coverage,
    });

    // Simulated Manager restart: the table persists and the correction state
    // still exposes the bounded accepted findings.
    closeDb();
    getDb();
    const recovered = loadReviewAttemptEvidence(runId, "qwen_review");
    expect(recovered.findings).toEqual(threeFindings);
    expect(recovered.attempts.at(-1)).toMatchObject({
      category: "contract_validation_failed",
      contract_stage: "rejected",
    });
    expect(reviewEvidenceCorrectionState(runId, "qwen_review")).toMatchObject({
      findings: threeFindings,
      coverage,
    });
  });
});
