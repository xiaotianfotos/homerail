import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { FakeDAGDispatcher } from "../src/orchestration/dag-dispatcher.js";
import { instantiateDAGPattern } from "../src/orchestration/dag-patterns.js";
import { closeDb } from "../src/persistence/db.js";
import { _clearAllPersistence, loadRunSnapshot } from "../src/persistence/store.js";
import { listRunArtifacts } from "../src/persistence/run-artifacts.js";
import {
  _clearActiveRuns,
  createActiveRun,
  dispatchReadyNodes,
  failActiveRun,
  getActiveRun,
  handoffActiveRun,
} from "../src/runtime/active-runs.js";
import { finalizeRunArtifacts } from "../src/runtime/run-artifact-service.js";

const revision = "0123456789012345678901234567890123456789";

const request = {
  issue: {
    id: "runtime-28",
    title: "TTS model configuration fails during onboarding",
    body: "Saving a TTS model during initial setup fails.",
    discussion: [{
      author: "reporter",
      body: "MiMo ASR is saved first; adding MiMo TTS with the same provider key then fails.",
    }],
  },
  target: {
    repository_url: "https://example.test/owner/repository",
    revision,
  },
  constraints: {
    max_test_seconds: 300,
    focus_paths: [
      "homerail_manager/src/orchestration/dag-patterns.ts",
      "../outside-secret",
    ],
  },
};

const plan = {
  scope: "Check the state-dependent MiMo ASR to TTS onboarding path.",
  stated_facts: [
    "MiMo ASR is saved before MiMo TTS.",
    "The same MiMo provider key should be reused.",
  ],
  ambiguities: ["Whether the onboarding caller and Manager use the same key-reuse contract."],
  hypotheses: [
    "The onboarding caller sends a legacy reuse marker rejected by Manager.",
    "MiMo TTS metadata is invalid independently of key reuse.",
  ],
  checks: [
    {
      id: "runtime-reproduction",
      objective: "Reproduce ASR save followed by TTS key reuse.",
      evidence_needed: "Executable request/response evidence.",
    },
    {
      id: "contract-history",
      objective: "Compare caller, server, and pre-regression contracts.",
      evidence_needed: "Exact source locators and parent/current history.",
    },
  ],
};

const preparation = {
  status: "prepared",
  tested_revision: revision,
  source_path: "source",
  evidence: ["Checked out " + revision + " into source."],
  limitations: [],
};

const reproductionReview = {
  reviewer_id: "reproduction",
  tested_revision: revision,
  issue_match: "exact",
  reproduction: "confirmed",
  hypothesis: "The legacy onboarding reuse marker is rejected after ASR creates a reusable MiMo credential.",
  root_cause: {
    status: "identified",
    explanation: "The exact ASR then TTS request sequence returns 400 for the legacy marker and 201 for the boolean contract.",
    evidence_ids: ["repro-e001", "repro-e002"],
  },
  findings: [{
    id: "repro-f001",
    severity: "high",
    claim: "The state-dependent MiMo TTS save failure is reproducible.",
    evidence_ids: ["repro-e001", "repro-e002"],
  }],
  evidence: [
    {
      id: "repro-e001",
      type: "test",
      locator: "homerail_manager/tests/llm-providers.test.ts:420-480",
      observation: "The focused API test accepts reuse_existing_api_key and rejects the reserved sentinel.",
    },
    {
      id: "repro-e002",
      type: "command",
      locator: "npm --prefix homerail_manager exec vitest run tests/llm-providers.test.ts",
      observation: "The focused regression test passed.",
    },
  ],
  tests: [{
    command: "npm --prefix homerail_manager exec vitest run tests/llm-providers.test.ts",
    status: "passed",
    summary: "The MiMo same-endpoint reuse control passed and the legacy marker was rejected.",
  }],
  limitations: [],
  confidence: "high",
};

const dataflowReview = {
  reviewer_id: "dataflow",
  tested_revision: revision,
  issue_match: "exact",
  reproduction: "inconclusive",
  hypothesis: "Onboarding serializes api_key=__reuse_existing__ while Manager requires reuse_existing_api_key=true.",
  root_cause: {
    status: "identified",
    explanation: "Caller and route use incompatible key-reuse fields.",
    evidence_ids: ["dataflow-e001", "dataflow-e002"],
  },
  findings: [{
    id: "dataflow-f001",
    severity: "high",
    claim: "The onboarding request uses the legacy marker rejected by the current route.",
    evidence_ids: ["dataflow-e001", "dataflow-e002"],
  }],
  evidence: [
    {
      id: "dataflow-e001",
      type: "source",
      locator: "agent-ui/src/components/agent/onboarding/OnboardingStepForm.vue:345-373",
      observation: "The existing-key branch sends api_key=__reuse_existing__.",
    },
    {
      id: "dataflow-e002",
      type: "source",
      locator: "homerail_manager/src/server/llm-settings.ts:438-447",
      observation: "Manager rejects the marker and accepts only the boolean reuse contract.",
    },
  ],
  tests: [],
  limitations: ["This review traced source but did not execute the UI."],
  confidence: "high",
};

const historyReview = {
  reviewer_id: "history",
  tested_revision: revision,
  issue_match: "exact",
  reproduction: "inconclusive",
  hypothesis: "The Manager contract migration entered main without migrating the onboarding caller.",
  root_cause: {
    status: "identified",
    explanation: "Parent accepted the marker; the regression commit rejects it while onboarding remains unchanged.",
    evidence_ids: ["history-e001", "history-e002"],
  },
  findings: [{
    id: "history-f001",
    severity: "high",
    claim: "The failure is a recent caller/server contract regression.",
    evidence_ids: ["history-e001", "history-e002"],
  }],
  evidence: [
    {
      id: "history-e001",
      type: "history",
      locator: "git show e2ad824^:homerail_manager/src/persistence/llm-settings.ts",
      observation: "The parent reused a key for api_key=__reuse_existing__.",
    },
    {
      id: "history-e002",
      type: "history",
      locator: "git show e2ad824:homerail_manager/src/server/llm-settings.ts",
      observation: "The regression commit rejects the marker in favor of reuse_existing_api_key.",
    },
  ],
  tests: [],
  limitations: [],
  confidence: "high",
};

const reviews = [reproductionReview, dataflowReview, historyReview] as const;

const report = {
  schema_version: "2.0",
  issue_id: "runtime-28",
  outcome: "confirmed",
  summary: "MiMo TTS onboarding fails after MiMo ASR because the caller sends a retired key-reuse marker.",
  tested_revision: revision,
  consensus: {
    decision: "unanimous",
    issue_match: "exact",
    supporting_review_ids: ["reproduction", "dataflow", "history"],
    dissenting_review_ids: [],
    rationale: "Runtime, data-flow, and history evidence identify the same state-dependent contract regression.",
    review_summaries: reviews.map((review) => ({
      reviewer_id: review.reviewer_id,
      issue_match: review.issue_match,
      reproduction: review.reproduction,
      position: "support",
      summary: review.hypothesis,
    })),
  },
  root_cause: {
    status: "identified",
    explanation: "Onboarding sends api_key=__reuse_existing__, but Manager now requires reuse_existing_api_key=true.",
    evidence_ids: ["repro-e001", "dataflow-e001", "dataflow-e002", "history-e001", "history-e002"],
  },
  findings: reviews.flatMap((review) => review.findings),
  evidence: reviews.flatMap((review) => review.evidence),
  tests: reproductionReview.tests,
  recommendations: [{
    priority: "now",
    action: "Migrate onboarding to the boolean key-reuse field and add an ASR-to-TTS regression test.",
    rationale: "The existing-key onboarding path is the only caller still using the rejected marker.",
  }],
  limitations: dataflowReview.limitations,
  confidence: "high",
};

function vote(reviewerId: "scenario" | "evidence" | "adversarial", verdict: "pass" | "fail") {
  return {
    reviewer_id: reviewerId,
    verdict,
    issue_match: verdict === "pass" ? "exact" : "mismatch",
    checked_revision: revision,
    checked_evidence_ids: ["repro-e001", "dataflow-e001", "dataflow-e002", "history-e001"],
    evidence: [reviewerId + " independently checked the decisive regression chain."],
    defects: verdict === "pass" ? [] : ["The selected diagnosis does not match the issue scenario."],
  };
}

function prepareDiagnosisRun(
  runId: string,
  repositoryPreparation = preparation,
  focusedFiles: Record<string, string> = {},
): FakeDAGDispatcher {
  const dispatcher = new FakeDAGDispatcher();
  const parsed = instantiateDAGPattern("issue-diagnosis").parsed;
  const checkout = parsed.graph.nodes.find((node) => node.node_id === "checkout_repository");
  if (!checkout?.gateway_config) throw new Error("checkout_repository command is missing");
  checkout.gateway_config = {
    ...checkout.gateway_config,
    command: ["node", "-e", `process.stdout.write(${JSON.stringify(revision)})`],
    cwd: undefined,
  };
  const resolver = parsed.graph.nodes.find((node) => node.node_id === "resolve_repository_head");
  if (!resolver?.gateway_config) throw new Error("resolve_repository_head command is missing");
  resolver.gateway_config = {
    ...resolver.gateway_config,
    command: ["node", "-e", `process.stdout.write(${JSON.stringify(revision)})`],
    cwd: undefined,
  };
  parsed.meta.agents = Object.fromEntries(Object.entries(parsed.meta.agents).map(([id, agent]) => [
    id,
    { ...agent, agent_type: "deterministic" },
  ]));
  createActiveRun(runId, parsed, { initialPrompt: JSON.stringify(request) });
  const runWorkspace = path.join(process.env.HOMERAIL_HOME!, "workspace", ...runId.split("/"));
  for (const [relativePath, content] of Object.entries(focusedFiles)) {
    const target = path.join(runWorkspace, "source", relativePath);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
  fs.mkdirSync(runWorkspace, { recursive: true });
  fs.writeFileSync(path.join(runWorkspace, "outside-secret"), "must-not-be-captured");

  expect(dispatchReadyNodes(runId, dispatcher)).toBe(1);
  handoffActiveRun(runId, "triage", "planned", plan);

  expect(dispatchReadyNodes(runId, dispatcher)).toBe(1);
  handoffActiveRun(runId, "prepare_repository", "prepared", repositoryPreparation);

  expect(dispatchReadyNodes(runId, dispatcher)).toBe(1);
  expect(dispatchReadyNodes(runId, dispatcher)).toBe(1);
  expect(dispatchReadyNodes(runId, dispatcher)).toBe(1);
  expect(dispatchReadyNodes(runId, dispatcher)).toBe(1);
  return dispatcher;
}

function runToConsensus(runId: string, repositoryPreparation = preparation): {
  dispatcher: FakeDAGDispatcher;
  votes: ReturnType<typeof vote>[];
} {
  const dispatcher = prepareDiagnosisRun(runId, repositoryPreparation);
  handoffActiveRun(runId, "review_reproduction", "reviewed", reproductionReview);

  expect(dispatchReadyNodes(runId, dispatcher)).toBe(1);
  expect(dispatchReadyNodes(runId, dispatcher)).toBe(2);
  handoffActiveRun(runId, "review_dataflow", "reviewed", dataflowReview);
  handoffActiveRun(runId, "review_history", "reviewed", historyReview);

  expect(dispatchReadyNodes(runId, dispatcher)).toBe(2);
  expect(dispatchReadyNodes(runId, dispatcher)).toBe(1);
  handoffActiveRun(runId, "arbitrate", "reported", report);

  expect(dispatchReadyNodes(runId, dispatcher)).toBe(3);
  const votes = [
    vote("scenario", "pass"),
    vote("evidence", "pass"),
    vote("adversarial", "pass"),
  ];
  handoffActiveRun(runId, "verify_scenario", "voted", votes[0]);
  handoffActiveRun(runId, "verify_evidence", "voted", votes[1]);
  handoffActiveRun(runId, "verify_adversarial", "voted", votes[2]);

  expect(dispatchReadyNodes(runId, dispatcher)).toBe(1);
  return { dispatcher, votes };
}

describe("issue-diagnosis pattern runtime", () => {
  let tmpHome: string;
  let oldHome: string | undefined;
  let oldAllowlist: string | undefined;

  beforeEach(() => {
    oldHome = process.env.HOMERAIL_HOME;
    oldAllowlist = process.env.HOMERAIL_DAG_COMMAND_ALLOWLIST;
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "homerail-issue-diagnosis-"));
    process.env.HOMERAIL_HOME = tmpHome;
    process.env.HOMERAIL_DAG_COMMAND_ALLOWLIST = "node";
    closeDb();
    _clearActiveRuns();
    _clearAllPersistence();
  });

  afterEach(() => {
    _clearActiveRuns();
    _clearAllPersistence();
    closeDb();
    if (oldHome === undefined) delete process.env.HOMERAIL_HOME;
    else process.env.HOMERAIL_HOME = oldHome;
    if (oldAllowlist === undefined) delete process.env.HOMERAIL_DAG_COMMAND_ALLOWLIST;
    else process.env.HOMERAIL_DAG_COMMAND_ALLOWLIST = oldAllowlist;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it("normalizes a failed independent reviewer into bounded inconclusive evidence", () => {
    const runId = "issue-diagnosis-reviewer-fallback";
    const dispatcher = prepareDiagnosisRun(runId);

    failActiveRun(runId, "review_reproduction", "agent ended without DAG handoff");
    expect(dispatchReadyNodes(runId, dispatcher)).toBe(1);

    expect(getActiveRun(runId)?.dagRun.nodeStates.get("review_reproduction")).toBe("FAILED");
    expect(getActiveRun(runId)?.dagRun.nodeStates.get("normalize_reproduction")).toBe("COMPLETED");
    expect(loadRunSnapshot(runId)?.handoffs.find((handoff) => handoff.fromNode === "normalize_reproduction")?.content)
      .toMatchObject({
        reviewer_id: "reproduction",
        tested_revision: revision,
        issue_match: "unknown",
        reproduction: "inconclusive",
        root_cause: { status: "unknown", evidence_ids: ["repro-e001"] },
        evidence: [{
          id: "repro-e001",
          type: "runtime",
          locator: "dag:review_reproduction",
          observation: expect.stringContaining("agent ended without DAG handoff"),
        }],
        tests: [],
        confidence: "low",
      });

    expect(dispatchReadyNodes(runId, dispatcher)).toBe(2);
    expect(getActiveRun(runId)?.dagRun.nodeStates.get("review_dataflow")).toBe("RUNNING");
    expect(getActiveRun(runId)?.dagRun.nodeStates.get("review_history")).toBe("RUNNING");
  });

  it("captures bounded line-numbered focus evidence without reading traversal paths", () => {
    const runId = "issue-diagnosis-focused-source-snapshot";
    prepareDiagnosisRun(runId, preparation, {
      "homerail_manager/src/orchestration/dag-patterns.ts": [
        "const heartbeat = { id: 'heartbeat' };",
        "export const patterns = [heartbeat];",
      ].join("\n"),
    });

    const snapshot = loadRunSnapshot(runId)?.handoffs.find(
      (handoff) => handoff.fromNode === "snapshot_focus_paths",
    )?.content as {
      revision_verified?: boolean;
      tested_revision?: string;
      files?: Array<{ path?: string; content?: string; content_sha256?: string }>;
      limitations?: string[];
    };
    expect(snapshot).toMatchObject({
      revision_verified: true,
      tested_revision: revision,
      files: [{
        path: "homerail_manager/src/orchestration/dag-patterns.ts",
        content: "1:const heartbeat = { id: 'heartbeat' };\n2:export const patterns = [heartbeat];",
        content_sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      }],
    });
    expect(snapshot.limitations).toContain("../outside-secret: unsafe relative path");
    expect(JSON.stringify(snapshot)).not.toContain("must-not-be-captured");
  });

  it("does not trust a contract-free failure handoff that resembles an independent review", () => {
    const runId = "issue-diagnosis-malformed-reviewer-failure";
    const dispatcher = prepareDiagnosisRun(runId);

    handoffActiveRun(runId, "review_reproduction", "reviewed", reproductionReview);
    expect(dispatchReadyNodes(runId, dispatcher)).toBe(1);
    expect(dispatchReadyNodes(runId, dispatcher)).toBe(2);

    handoffActiveRun(runId, "review_dataflow", "failed", {
      reviewer_id: "dataflow",
      tested_revision: revision,
      issue_match: "exact",
      reproduction: "inconclusive",
      hypothesis: { summary: "not a string" },
      root_cause: { status: "unknown", explanation: "incomplete", evidence_ids: [] },
      findings: [],
      evidence: [],
      tests: [],
      limitations: [],
      confidence: "low",
    });

    expect(() => dispatchReadyNodes(runId, dispatcher)).not.toThrow();
    expect(getActiveRun(runId)?.dagRun.nodeStates.get("normalize_dataflow")).toBe("COMPLETED");
    expect(loadRunSnapshot(runId)?.handoffs.find((handoff) => handoff.fromNode === "normalize_dataflow")?.content)
      .toMatchObject({
        reviewer_id: "dataflow",
        tested_revision: revision,
        issue_match: "unknown",
        reproduction: "inconclusive",
        hypothesis: "The dataflow reviewer did not produce a contract-valid investigation result.",
        root_cause: { status: "unknown", evidence_ids: ["dataflow-e001"] },
        evidence: [{
          id: "dataflow-e001",
          type: "runtime",
          locator: "dag:review_dataflow",
        }],
        confidence: "low",
      });
    expect(getActiveRun(runId)?.status).toBe("active");
  });

  it("publishes the arbitrated report after unanimous verification", async () => {
    const runId = "issue-diagnosis-pass";
    const { dispatcher, votes } = runToConsensus(runId, {
      ...preparation,
      status: "unavailable",
      limitations: ["The correction handoff was conservative; deterministic Git HEAD verification is authoritative."],
    });
    const verification = {
      verdict: "pass",
      policy: "unanimous-three-reviewers",
      checked_revision: revision,
      votes,
      evidence: ["All three independent verification roles passed at the report revision."],
      defects: [],
    };

    handoffActiveRun(runId, "consensus", "checked", verification);
    expect(dispatchReadyNodes(runId, dispatcher)).toBe(1);

    const run = getActiveRun(runId);
    expect(run?.status).toBe("completed");
    expect(run?.dagRun.nodeStates.get("consensus_gate")).toBe("COMPLETED");
    expect(loadRunSnapshot(runId)?.handoffs.at(-1)).toMatchObject({
      fromNode: "consensus_gate",
      port: "accepted",
      content: verification,
    });
    await finalizeRunArtifacts(runId, "success");
    expect(listRunArtifacts(runId)).toEqual([
      expect.objectContaining({ name: "diagnosis.json", status: "ready" }),
      expect.objectContaining({ name: "verification.json", status: "ready" }),
    ]);
  }, 15_000);

  it("preserves the report and all votes when one verifier dissents", async () => {
    const runId = "issue-diagnosis-review";
    const { dispatcher, votes } = runToConsensus(runId);
    votes[0] = vote("scenario", "fail");
    const verification = {
      verdict: "fail",
      policy: "unanimous-three-reviewers",
      checked_revision: revision,
      votes,
      evidence: ["The scenario verifier found a mismatch."],
      defects: ["Scenario verification did not pass."],
    };

    handoffActiveRun(runId, "consensus", "checked", verification);
    expect(dispatchReadyNodes(runId, dispatcher)).toBe(1);

    const run = getActiveRun(runId);
    expect(run?.status).toBe("failed");
    expect(run?.dagRun.nodeStates.get("consensus_gate")).toBe("FAILED");
    expect(loadRunSnapshot(runId)?.handoffs.at(-1)).toMatchObject({
      fromNode: "consensus_gate",
      port: "rejected",
      content: verification,
    });
    await finalizeRunArtifacts(runId, "failure");
    expect(listRunArtifacts(runId)).toEqual([
      expect.objectContaining({ name: "diagnosis.json", status: "ready" }),
      expect.objectContaining({ name: "verification.json", status: "ready" }),
    ]);
  });
});
