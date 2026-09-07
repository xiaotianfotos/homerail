import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { closeDb, getDb } from "../src/persistence/db.js";
import { _clearAllPersistence, ensureRunDir } from "../src/persistence/store.js";
import { _clearListeners } from "../src/events/bus.js";
import { parseDAGYaml } from "../src/orchestration/yaml-loader.js";
import {
  _clearActiveRuns,
  createActiveRun,
  dispatchReadyNodes,
  getActiveRun,
  isReviewEvidenceNode,
  requestNodeCorrection,
} from "../src/runtime/active-runs.js";
import type { DAGDispatcher } from "../src/orchestration/dag-dispatcher.js";
import {
  buildReviewEvidenceProjectionFor,
  listReviewEvidenceRecords,
  loadReviewEvidence,
  recordAttemptDiagnostic,
  recordReviewCoverage,
  recordReviewFinding,
  reviewEvidenceProjectionPath,
  reviewEvidenceProjectionWorkspacePath,
  writeReviewEvidenceProjectionFile,
  type ReviewEvidenceFence,
  type ReviewEvidenceIdentity,
} from "../src/persistence/dag-review-evidence.js";
import { REVIEW_FINDING_FIELD_LIMITS, reviewFindingDedupKey } from "homerail-protocol";

function identity(overrides: Partial<ReviewEvidenceIdentity> = {}): ReviewEvidenceIdentity {
  return {
    runId: "run-1",
    reviewer: "qwen",
    nodeId: "qwen_review",
    sessionId: "session-1",
    roundId: "round-0001",
    generation: 1,
    attempt: 1,
    ...overrides,
  };
}

function fence(overrides: Partial<ReviewEvidenceFence> = {}): ReviewEvidenceFence {
  return {
    runId: "run-1",
    reviewer: "qwen",
    nodeId: "qwen_review",
    sessionId: "session-1",
    roundId: "round-0001",
    generation: 1,
    ...overrides,
  };
}

function finding(overrides: Record<string, unknown> = {}) {
  return {
    category: "security",
    severity: "high",
    title: "Unchecked response",
    file: "src/app.ts",
    line: 12,
    evidence: "fetch('/api') is not awaited",
    recommendation: "Await and validate the response",
    confidence: "high",
    ...overrides,
  };
}

describe("durable DAG review evidence", () => {
  let tmpHome: string;
  let oldHome: string | undefined;

  beforeEach(() => {
    oldHome = process.env.HOMERAIL_HOME;
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "homerail-review-evidence-"));
    process.env.HOMERAIL_HOME = tmpHome;
    closeDb();
    ensureRunDir("run-1");
    ensureRunDir("run-2");
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

  it("persists findings idempotently by deterministic finding id", () => {
    const first = recordReviewFinding({ identity: identity(), finding: finding() });
    const second = recordReviewFinding({ identity: identity(), finding: finding() });

    expect(first.status).toBe("inserted");
    expect(second.status).toBe("deduplicated");
    const loaded = loadReviewEvidence("run-1", "qwen");
    expect(loaded.findings).toHaveLength(1);
    expect(loaded.findings[0]?.id).toBe(reviewFindingDedupKey("src/app.ts", 12, "Unchecked response"));
  });

  it("keeps accepted findings when a later handoff is incomplete", () => {
    recordReviewFinding({ identity: identity({ attempt: 1 }), finding: finding() });
    recordReviewFinding({ identity: identity({ attempt: 2 }), finding: finding({ title: "Second issue" }) });
    recordAttemptDiagnostic({
      identity: identity({ attempt: 1 }),
      diagnostic: { finish_reason: "max_tokens", output_tokens: 900 },
    });
    recordAttemptDiagnostic({
      identity: identity({ attempt: 2 }),
      diagnostic: { finish_reason: "end_turn" },
    });

    const loaded = loadReviewEvidence("run-1", "qwen");
    expect(loaded.findings.map((item) => item.title)).toEqual(["Unchecked response", "Second issue"]);
    expect(loaded.diagnostics.map((item) => item.attempt)).toEqual([1, 2]);

    // The same dispatch accumulates both attempts, while a fresh generation
    // starts with an empty projection.
    const current = loadReviewEvidence("run-1", "qwen", fence());
    expect(current.findings.map((item) => item.title)).toEqual(["Unchecked response", "Second issue"]);
    expect(current.diagnostics.map((item) => item.attempt)).toEqual([1, 2]);
    const fresh = loadReviewEvidence("run-1", "qwen", fence({ generation: 2 }));
    expect(fresh.findings).toHaveLength(0);
    expect(fresh.diagnostics).toHaveLength(0);
  });

  it("fences evidence to the exact run/reviewer/session/generation/attempt", () => {
    recordReviewFinding({ identity: identity(), finding: finding() });
    recordReviewFinding({ identity: identity({ reviewer: "kimi" }), finding: finding() });
    recordReviewFinding({ identity: identity({ runId: "run-2" }), finding: finding() });

    expect(loadReviewEvidence("run-1", "qwen").findings).toHaveLength(1);
    expect(loadReviewEvidence("run-1", "kimi").findings).toHaveLength(1);
    expect(loadReviewEvidence("run-2", "qwen").findings).toHaveLength(1);

    recordAttemptDiagnostic({
      identity: identity({ attempt: 1 }),
      diagnostic: { finish_reason: "end_turn" },
    });
    recordAttemptDiagnostic({
      identity: identity({ attempt: 2 }),
      diagnostic: { finish_reason: "max_tokens" },
    });
    expect(loadReviewEvidence("run-1", "qwen").diagnostics.map((item) => item.attempt)).toEqual([1, 2]);

    expect(() => recordReviewFinding({
      identity: { ...identity(), generation: 0 },
      finding: finding(),
    })).toThrow(/generation/);
    expect(() => recordAttemptDiagnostic({
      identity: { ...identity(), attempt: 0 },
      diagnostic: {},
    })).toThrow(/attempt/);
  });

  it("deduplicates same-fence redelivery while fresh sessions/generations stay independent", () => {
    expect(recordReviewFinding({ identity: identity(), finding: finding() }).status).toBe("inserted");
    // Redelivery on a later attempt of the same logical dispatch deduplicates.
    expect(recordReviewFinding({ identity: identity({ attempt: 2 }), finding: finding() }).status).toBe("deduplicated");
    // The same finding id is independently durable in every fresh fence
    // component: generation, session, round, and node.
    expect(recordReviewFinding({ identity: identity({ generation: 2 }), finding: finding() }).status).toBe("inserted");
    expect(recordReviewFinding({ identity: identity({ sessionId: "session-2" }), finding: finding() }).status).toBe("inserted");
    expect(recordReviewFinding({ identity: identity({ roundId: "round-0002" }), finding: finding() }).status).toBe("inserted");
    expect(recordReviewFinding({ identity: identity({ nodeId: "qwen_review_2" }), finding: finding() }).status).toBe("inserted");
    expect(listReviewEvidenceRecords("run-1", "qwen")).toHaveLength(5);

    for (const selected of [
      fence(),
      fence({ generation: 2 }),
      fence({ sessionId: "session-2" }),
      fence({ roundId: "round-0002" }),
      fence({ nodeId: "qwen_review_2" }),
    ]) {
      expect(loadReviewEvidence("run-1", "qwen", selected).findings).toHaveLength(1);
    }

    const current = buildReviewEvidenceProjectionFor("run-1", "qwen", fence());
    const fresh = buildReviewEvidenceProjectionFor("run-1", "qwen", fence({ generation: 2 }));
    expect(current?.accepted_findings).toHaveLength(1);
    expect(fresh?.accepted_findings).toHaveLength(1);
    expect(fresh?.accepted_findings[0]?.id).toBe(current?.accepted_findings[0]?.id);
  });

  it("stores attempt 1 diagnostics independently across fresh fences", () => {
    const diagnostic = { finish_reason: "max_tokens", output_tokens: 700 };
    expect(recordAttemptDiagnostic({
      identity: identity({ attempt: 1, generation: 1 }),
      diagnostic,
    }).status).toBe("inserted");
    expect(recordAttemptDiagnostic({
      identity: identity({ attempt: 1, generation: 2 }),
      diagnostic,
    }).status).toBe("inserted");
    expect(recordAttemptDiagnostic({
      identity: identity({ attempt: 1, sessionId: "session-2" }),
      diagnostic,
    }).status).toBe("inserted");
    expect(listReviewEvidenceRecords("run-1", "qwen")).toHaveLength(3);

    const first = loadReviewEvidence("run-1", "qwen", fence());
    expect(first.diagnostics).toHaveLength(1);
    expect(first.diagnostics[0]?.attempt).toBe(1);
    const second = loadReviewEvidence("run-1", "qwen", fence({ generation: 2 }));
    expect(second.diagnostics).toHaveLength(1);
    expect(second.diagnostics[0]?.attempt).toBe(1);
    const third = loadReviewEvidence("run-1", "qwen", fence({ sessionId: "session-2" }));
    expect(third.diagnostics).toHaveLength(1);
    expect(third.diagnostics[0]?.attempt).toBe(1);
  });

  it("fails closed on invalid fence identity components", () => {
    expect(() => recordReviewFinding({
      identity: identity({ nodeId: "" }),
      finding: finding(),
    })).toThrow(/node_id/);
    expect(() => recordReviewFinding({
      identity: identity({ sessionId: "   " }),
      finding: finding(),
    })).toThrow(/session_id/);
    expect(() => recordReviewFinding({
      identity: identity({ roundId: "r".repeat(257) }),
      finding: finding(),
    })).toThrow(/round_id/);
    expect(() => loadReviewEvidence("run-1", "qwen", fence({ generation: 0 }))).toThrow(/generation/);
    expect(() => buildReviewEvidenceProjectionFor("run-1", "qwen", fence({ sessionId: "" }))).toThrow(/session_id/);
    expect(() => loadReviewEvidence("run-2", "qwen", fence())).toThrow(/does not match/);
    expect(() => loadReviewEvidence("run-1", "kimi", fence())).toThrow(/does not match/);
  });

  it("stores compact coverage per round and rebuilds a projection", () => {
    const attestation = {
      schema: "changed-file-coverage-v1",
      digest: "a".repeat(64),
      count: 1,
    };
    expect(recordReviewCoverage({ identity: identity(), attestation }).status).toBe("inserted");
    expect(recordReviewCoverage({ identity: identity(), attestation }).status).toBe("deduplicated");
    recordReviewFinding({ identity: identity(), finding: finding() });

    const projection = buildReviewEvidenceProjectionFor("run-1", "qwen", fence());
    expect(projection?.reviewer).toBe("qwen");
    expect(projection?.accepted_findings).toHaveLength(1);
    expect(projection?.coverage_attestation).toEqual(attestation);
    expect(projection?.attempt_diagnostics).toHaveLength(0);
  });

  it("redacts and bounds diagnostic payloads", () => {
    recordAttemptDiagnostic({
      identity: identity(),
      diagnostic: {
        finish_reason: "max_tokens",
        failure_reason: "apiKey=sk-secret-value-1234567890 output limit",
        output_tokens: 1e12,
      },
    });
    const loaded = loadReviewEvidence("run-1", "qwen");
    expect(loaded.diagnostics[0]?.failure_category).toBe("provider_output_truncated");
    expect(loaded.diagnostics[0]?.output_tokens).toBeNull();
    expect(JSON.stringify(loaded.diagnostics)).not.toContain("sk-secret");

    const bounded = recordReviewFinding({
      identity: identity(),
      finding: finding({ evidence: "x".repeat(20000) }),
    });
    expect(bounded.status).toBe("inserted");
    const reloaded = loadReviewEvidence("run-1", "qwen");
    expect(reloaded.findings[0]?.evidence.length ?? 0)
      .toBeLessThanOrEqual(REVIEW_FINDING_FIELD_LIMITS.evidence);
    expect(() => recordReviewFinding({
      identity: identity(),
      finding: finding({ title: "y".repeat(301) }),
    })).toThrow(/bounded/);
    expect(listReviewEvidenceRecords("run-1", "qwen")).toHaveLength(2);
  });

  it("mirrors a bounded projection file for deterministic normalizers", () => {
    recordReviewFinding({ identity: identity(), finding: finding() });
    expect(writeReviewEvidenceProjectionFile("run-1", "qwen")).toBe(true);
    const target = reviewEvidenceProjectionPath("run-1", "qwen");
    expect(target).toBeDefined();
    const projection = JSON.parse(fs.readFileSync(target!, "utf8")) as {
      schema: string;
      reviewer: string;
      accepted_findings: unknown[];
    };
    expect(projection.schema).toBe("review-evidence-projection-v1");
    expect(projection.reviewer).toBe("qwen");
    expect(projection.accepted_findings).toHaveLength(1);
    if (process.platform !== "win32") {
      expect(fs.statSync(target!).mode & 0o777).toBe(0o600);
    }
  });

  it("survives database reopen (recovery-safe persistence)", () => {
    recordReviewFinding({ identity: identity(), finding: finding() });
    recordAttemptDiagnostic({ identity: identity(), diagnostic: { finish_reason: "end_turn" } });
    closeDb();
    const reopened = getDb();
    expect(reopened.prepare("SELECT 1 FROM dag_review_evidence").get()).toBeDefined();
    const loaded = loadReviewEvidence("run-1", "qwen");
    expect(loaded.findings).toHaveLength(1);
    expect(loaded.diagnostics).toHaveLength(1);
  });

  it("excludes stale fences and keeps all attempts of the current dispatch after reopen", () => {
    recordReviewFinding({ identity: identity({ attempt: 1 }), finding: finding() });
    recordReviewFinding({ identity: identity({ attempt: 2 }), finding: finding({ title: "Second issue" }) });
    recordAttemptDiagnostic({
      identity: identity({ attempt: 1 }),
      diagnostic: { finish_reason: "max_tokens" },
    });
    recordAttemptDiagnostic({
      identity: identity({ attempt: 2 }),
      diagnostic: { finish_reason: "end_turn" },
    });
    // Same finding id and attempt number in a stale generation must never be
    // selected by the current projection after reopen.
    recordReviewFinding({ identity: identity({ generation: 2 }), finding: finding() });
    recordAttemptDiagnostic({
      identity: identity({ generation: 2 }),
      diagnostic: { finish_reason: "end_turn" },
    });

    closeDb();
    getDb();

    const current = loadReviewEvidence("run-1", "qwen", fence());
    expect(current.findings.map((item) => item.title)).toEqual(["Unchecked response", "Second issue"]);
    expect(current.diagnostics.map((item) => item.attempt)).toEqual([1, 2]);

    const projection = buildReviewEvidenceProjectionFor("run-1", "qwen", fence());
    expect(projection?.accepted_findings).toHaveLength(2);
    expect(projection?.attempt_diagnostics).toHaveLength(2);

    const stale = loadReviewEvidence("run-1", "qwen", fence({ generation: 2 }));
    expect(stale.findings.map((item) => item.title)).toEqual(["Unchecked response"]);
    expect(stale.diagnostics.map((item) => item.attempt)).toEqual([1]);
    expect(listReviewEvidenceRecords("run-1", "qwen")).toHaveLength(6);
  });

  it("injects persisted accepted evidence into the correction input projection", () => {
    _clearActiveRuns();
    _clearAllPersistence();
    _clearListeners();
    const parsed = parseDAGYaml(`
name: review-evidence-correction
limits:
  max_corrections_per_node: 1
agents:
  reviewer:
    agent_type: deterministic
nodes:
  qwen_review:
    agent: reviewer
    outputs:
      voted:
        to: ""
  kimi_review:
    agent: reviewer
    outputs:
      voted:
        to: ""
`);
    createActiveRun("run-evidence-correction", parsed);
    const run = getActiveRun("run-evidence-correction")!;
    for (const nodeId of ["qwen_review", "kimi_review"]) {
      const node = run.dagRun.graph.nodes.find((candidate) => candidate.node_id === nodeId)!;
      node.extra = {
        ...node.extra,
        agent_runtime: {
          workspace_access: {
            writable_paths: [],
            readonly_paths: ["repository", "review-evidence"],
          },
        },
        workflow_spec_v1: {
          ...(node.extra?.workflow_spec_v1 && typeof node.extra.workflow_spec_v1 === "object"
            ? node.extra.workflow_spec_v1 as Record<string, unknown>
            : {}),
          review_evidence: true,
        },
      };
    }
    const dispatched: Parameters<DAGDispatcher["dispatch"]>[0][] = [];
    const dispatcher: DAGDispatcher = {
      dispatched: [],
      dispatch(envelope) {
        dispatched.push(envelope);
        return { status: "dispatched", targetType: "fake", targetId: "fake" };
      },
    };
    expect(dispatchReadyNodes("run-evidence-correction", dispatcher)).toBe(2);

    const identityFor = {
      runId: "run-evidence-correction",
      reviewer: "qwen_review",
      nodeId: "qwen_review",
      sessionId: getActiveRun("run-evidence-correction")!.nodeSessions.get("qwen_review")!.sessionId,
      roundId: getActiveRun("run-evidence-correction")!.currentRound.round_id,
      generation: 1,
      attempt: 1,
    };
    const kimiIdentity = {
      ...identityFor,
      reviewer: "kimi_review",
      nodeId: "kimi_review",
      sessionId: getActiveRun("run-evidence-correction")!.nodeSessions.get("kimi_review")!.sessionId,
    };
    const expectedProjectionExclusions = [identityFor, kimiIdentity]
      .map(reviewEvidenceProjectionWorkspacePath)
      .sort();
    expect(dispatched).toHaveLength(2);
    for (const envelope of dispatched) {
      expect(envelope.workspaceAccess?.snapshot_exclude_paths).toEqual(expectedProjectionExclusions);
    }
    recordReviewFinding({ identity: identityFor, finding: finding() });

    const correction = requestNodeCorrection(
      "run-evidence-correction",
      "qwen_review",
      "DAG_HANDOFF_CONTRACT_VIOLATION qwen_review.voted",
      { finish_reason: "max_tokens", output_tokens: 900 },
    );
    expect(correction.status).toBe("scheduled");

    const projection = getActiveRun("run-evidence-correction")!
      .dagRun.mailboxes.get("qwen_review")!
      .get("review_evidence")?.[0] as Record<string, unknown>;
    expect(projection).toMatchObject({
      schema: "review-evidence-projection-v1",
      reviewer: "qwen_review",
    });
    expect(projection.accepted_findings).toHaveLength(1);
    expect(projection.attempt_diagnostics).toEqual([
      expect.objectContaining({
        attempt: 1,
        finish_reason: "max_tokens",
        failure_category: "contract_validation_failed",
      }),
    ]);
    _clearActiveRuns();
    _clearAllPersistence();
    _clearListeners();
  });

  it("gates the runtime evidence bridge on the runtime_evidence capability", () => {
    _clearActiveRuns();
    _clearAllPersistence();
    _clearListeners();
    const parsed = parseDAGYaml(`
name: review-evidence-capability
agents:
  reviewer:
    agent_type: deterministic
nodes:
  qwen_review:
    agent: reviewer
    outputs:
      voted:
        to: ""
`);
    createActiveRun("run-evidence-capability", parsed);
    const run = getActiveRun("run-evidence-capability")!;
    const node = run.dagRun.graph.nodes.find((candidate) => candidate.node_id === "qwen_review")!;
    expect(isReviewEvidenceNode("run-evidence-capability", "qwen_review")).toBe(false);
    node.extra = {
      ...node.extra,
      workflow_spec_v1: {
        ...(node.extra?.workflow_spec_v1 && typeof node.extra.workflow_spec_v1 === "object"
          ? node.extra.workflow_spec_v1 as Record<string, unknown>
          : {}),
        capabilities: ["runtime_evidence"],
      },
    };
    expect(isReviewEvidenceNode("run-evidence-capability", "qwen_review")).toBe(true);
    _clearActiveRuns();
    _clearAllPersistence();
    _clearListeners();
  });
});
