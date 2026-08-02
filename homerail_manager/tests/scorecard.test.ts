import { describe, expect, it } from "vitest";

import type { ScorecardPolicyConfig } from "../src/orchestration/graph.js";
import type { PersistedRunMetadata, PersistedRunSnapshot } from "../src/persistence/types.js";
import { buildEvalReport } from "../src/server/eval.js";
import { computeScorecard } from "../src/server/scorecard.js";

const deploymentDiagnosisScorecard: ScorecardPolicyConfig = {
  profile: "deployment-diagnosis",
  enforcement: "advisory",
  handoff_blockers: {
    enabled: true,
    statuses: [
      "ISSUE_CREATION_BLOCKED",
      "DEPLOYMENT_BLOCKED",
      "DEPLOYMENT_COVERAGE_BLOCKED",
      "DIAGNOSIS_ENVIRONMENT_BLOCKED",
    ],
    fields: [
      "issue_creation_blocked",
      "deployment_blocker",
      "deployment_coverage_blocker",
      "warm_start_only",
    ],
  },
};

const strictDeploymentDiagnosisScorecard: ScorecardPolicyConfig = {
  ...deploymentDiagnosisScorecard,
  enforcement: "strict",
  handoff_blockers: {
    ...deploymentDiagnosisScorecard.handoff_blockers,
    success_statuses: ["DEPLOYMENT_OK"],
    success_forbidden_terms: [
      "Manager already healthy",
      "http://localhost:19191",
      "http://127.0.0.1:19191",
      "warm-start-only",
      "default-port warm-start",
    ],
  },
};

function snapshotWithHandoff(
  content: unknown,
  scorecard: ScorecardPolicyConfig | null = deploymentDiagnosisScorecard,
): PersistedRunSnapshot {
  return {
    metadata: {
      runId: "diagnosis-run",
      workflowId: "qwen36-cli-deploy-diagnosis",
      workflowName: "qwen36-cli-deploy-diagnosis",
      scorecard: scorecard ?? undefined,
      nodeCount: 1,
      createdAt: Date.now(),
      completedAt: Date.now(),
      status: "completed",
      nodeStates: { diagnose: "COMPLETED" },
      handoffedNodes: ["diagnose"],
      graph: {
        nodes: [
          {
            node_id: "diagnose",
            name: "Diagnose",
            description: "",
            node_type: "agent",
            agent: "deployment_diagnoser",
            after: [],
            outputs: { done: { to: "" } },
          },
        ],
        edges: [],
      },
    },
    events: [
      {
        type: "dag:run_created",
        payload: { runId: "diagnosis-run", workflowId: "qwen36-cli-deploy-diagnosis", nodeCount: 1 },
        timestamp: Date.now(),
      },
    ],
    handoffs: [
      {
        runId: "diagnosis-run",
        fromNode: "diagnose",
        port: "done",
        content,
        timestamp: Date.now(),
      },
    ],
    chats: {
      diagnose: [
        {
          role: "worker",
          type: "response",
          content: { type: "tool_use", name: "Bash", input: { command: "npm run build" } },
          timestamp: Date.now(),
        },
      ],
    },
  };
}

function snapshotWithRunStatus(
  status: string,
  nodeStates: Record<string, string>,
): PersistedRunSnapshot {
  return {
    metadata: {
      runId: `run-${status}`,
      workflowId: "status-run",
      workflowName: "status-run",
      nodeCount: Object.keys(nodeStates).length,
      createdAt: Date.now(),
      completedAt: ["completed", "failed", "cancelled"].includes(status)
        ? Date.now()
        : undefined,
      status: status as PersistedRunMetadata["status"],
      nodeStates,
      handoffedNodes: [],
    },
    events: [],
    handoffs: [],
    chats: {},
  };
}

describe("scorecard DAG run terminal status", () => {
  it.each(["completed", "failed", "cancelled"])(
    "treats %s as terminal",
    (status) => {
      const scorecard = computeScorecard(snapshotWithRunStatus(status, { work: "COMPLETED" }));
      const terminalCheck = scorecard.checks.find((check) => check.name === "run_terminal");

      expect(terminalCheck?.passed).toBe(true);
      expect(terminalCheck?.detail).toBe(`run status: ${status}`);
      expect(terminalCheck?.detail).not.toContain("run still active");
    },
  );

  it.each(["active", "waiting"])(
    "keeps %s non-terminal",
    (status) => {
      const scorecard = computeScorecard(snapshotWithRunStatus(status, { work: "READY" }));
      const terminalCheck = scorecard.checks.find((check) => check.name === "run_terminal");

      expect(terminalCheck?.passed).toBe(false);
      expect(terminalCheck?.detail).toBe(`run still active: ${status}`);
    },
  );

  it("does not treat a failed run as healthy", () => {
    const scorecard = computeScorecard(snapshotWithRunStatus("failed", { work: "FAILED" }));
    const terminalCheck = scorecard.checks.find((check) => check.name === "run_terminal");
    const failedNodesCheck = scorecard.checks.find((check) => check.name === "no_failed_nodes");

    expect(terminalCheck?.passed).toBe(true);
    expect(failedNodesCheck?.passed).toBe(false);
    expect(scorecard.passed).toBe(false);
    expect(scorecard.verdict).toBe("fail");
  });

  it("allows a cancelled run with no failed nodes to score as healthy execution", () => {
    const snapshot = snapshotWithRunStatus("cancelled", { work: "COMPLETED" });
    snapshot.handoffs = [
      {
        runId: "run-cancelled",
        fromNode: "work",
        port: "done",
        content: "work complete",
        timestamp: Date.now(),
      },
    ];
    snapshot.chats = {
      work: [
        {
          role: "worker",
          type: "response",
          content: { type: "tool_use", name: "Bash", input: { command: "true" } },
          timestamp: Date.now(),
        },
      ],
    };
    snapshot.events = [
      {
        type: "dag:run_cancelled",
        payload: { runId: "run-cancelled" },
        timestamp: Date.now(),
      },
    ];

    const scorecard = computeScorecard(snapshot);
    const terminalCheck = scorecard.checks.find((check) => check.name === "run_terminal");
    const failedNodesCheck = scorecard.checks.find((check) => check.name === "no_failed_nodes");

    expect(terminalCheck?.passed).toBe(true);
    expect(failedNodesCheck?.passed).toBe(true);
    expect(scorecard.passed).toBe(true);
    expect(scorecard.verdict).toBe("pass");
  });
});

describe("scorecard handoff blocker detection", () => {
  it("does not apply DAG-specific blocker terms without a scorecard policy", () => {
    const scorecard = computeScorecard(snapshotWithHandoff({
      status: "DEPLOYMENT_BLOCKED",
      deployment_blocker: {
        first_failing_command: "node homerail_cli/dist/cli.js start",
      },
    }, null));

    const blockerCheck = scorecard.checks.find((check) => check.name === "handoff_reported_blockers");

    expect(blockerCheck).toBeUndefined();
    expect(scorecard.passed).toBe(true);
  });

  it("reports advisory findings without failing the scorecard gate by default", () => {
    const snapshot = snapshotWithHandoff({
      status: "ISSUE_CREATION_BLOCKED",
      deployment_blocker: {
        first_failing_command: "node homerail_cli/dist/cli.js start",
      },
      issue_creation_blocked: "HOMERAIL_GITEA_TOKEN env var is not set",
      issue_created: "no",
    });

    const scorecard = computeScorecard(snapshot);
    const blockerCheck = scorecard.checks.find((check) => check.name === "handoff_reported_blockers");

    expect(blockerCheck?.passed).toBe(false);
    expect(blockerCheck?.severity).toBe("warning");
    expect(scorecard.enforcement).toBe("advisory");
    expect(scorecard.passed).toBe(true);
    expect(scorecard.gate_verdict).toBe("pass");
    expect(scorecard.verdict).toBe("pass_with_warnings");
    expect(scorecard.scorecard_profile).toBe("deployment-diagnosis");

    const evalReport = buildEvalReport(snapshot, scorecard);
    expect(evalReport.verdict).toBe("pass_with_warnings");
    expect(evalReport.scorecard_failures.join("\n")).toContain("handoff_reported_blockers");
  });

  it("fails when a strict diagnosis handoff reports blocked issue creation", () => {
    const snapshot = snapshotWithHandoff({
      status: "ISSUE_CREATION_BLOCKED",
      deployment_blocker: {
        first_failing_command: "node homerail_cli/dist/cli.js start",
      },
      issue_creation_blocked: "HOMERAIL_GITEA_TOKEN env var is not set",
      issue_created: "no",
    }, strictDeploymentDiagnosisScorecard);

    const scorecard = computeScorecard(snapshot);
    const blockerCheck = scorecard.checks.find((check) => check.name === "handoff_reported_blockers");

    expect(blockerCheck?.passed).toBe(false);
    expect(blockerCheck?.severity).toBe("error");
    expect(scorecard.enforcement).toBe("strict");
    expect(scorecard.passed).toBe(false);
    expect(scorecard.gate_verdict).toBe("fail");
    expect(scorecard.verdict).toBe("fail");
  });

  it("passes blocker detection for a successful deployment handoff", () => {
    const scorecard = computeScorecard(snapshotWithHandoff({
      status: "DEPLOYMENT_OK",
      commit_hash: "abc123",
      issue_created: "no",
    }));
    const blockerCheck = scorecard.checks.find((check) => check.name === "handoff_reported_blockers");

    expect(blockerCheck?.passed).toBe(true);
    expect(scorecard.passed).toBe(true);
  });

  it("fails auto handoff fallback records even when policy enforcement is advisory", () => {
    const snapshot = snapshotWithHandoff({
      auto_handoff: true,
      reason: "Claude SDK error: Claude Code process exited with code 1",
    });

    const scorecard = computeScorecard(snapshot);
    const autoHandoffCheck = scorecard.checks.find((check) => check.name === "auto_handoffs_absent");

    expect(autoHandoffCheck?.passed).toBe(false);
    expect(autoHandoffCheck?.severity).toBe("error");
    expect(autoHandoffCheck?.detail).toContain("Claude SDK error");
    expect(scorecard.enforcement).toBe("advisory");
    expect(scorecard.passed).toBe(false);
    expect(scorecard.gate_verdict).toBe("fail");
    expect(scorecard.verdict).toBe("fail");

    const evalReport = buildEvalReport(snapshot, scorecard);
    expect(evalReport.verdict).toBe("fail");
    expect(evalReport.artifact_contracts.auto_handoff_count).toBe(1);
    expect(evalReport.scorecard_failures.join("\n")).toContain("auto_handoffs_absent");
  });

  it("treats expected pre-start unreachable evidence as advisory when policy is advisory", () => {
    const advisoryContradictionScorecard: ScorecardPolicyConfig = {
      ...strictDeploymentDiagnosisScorecard,
      enforcement: "advisory",
    };
    const snapshot = snapshotWithHandoff([
      "DEPLOYMENT_OK: Deployment completed.",
      "",
      "- commands_run:",
      "  - node homerail_cli/dist/cli.js runtime status (pre-start: FAIL)",
      "configured_manager_url: http://127.0.0.1:44735",
      "manager_started: yes",
      "node_connected: yes",
      "worker_connected: yes",
    ].join("\n"), advisoryContradictionScorecard);
    const scorecard = computeScorecard(snapshot);
    const contradictionCheck = scorecard.checks.find(
      (check) => check.name === "handoff_success_contradictions",
    );

    expect(contradictionCheck?.passed).toBe(false);
    expect(contradictionCheck?.severity).toBe("warning");
    expect(scorecard.passed).toBe(true);
    expect(scorecard.gate_verdict).toBe("pass");

    const evalReport = buildEvalReport(snapshot, scorecard);
    expect(evalReport.verdict).toBe("pass_with_warnings");
  });

  it("fails in strict mode when a deployment OK handoff includes failed command evidence", () => {
    const scorecard = computeScorecard(snapshotWithHandoff([
      "DEPLOYMENT_OK: Deployment completed.",
      "",
      "- commands_run:",
      "  - node homerail_cli/dist/cli.js start (PASS - exit 1 due to missing model key)",
    ].join("\n"), strictDeploymentDiagnosisScorecard));
    const contradictionCheck = scorecard.checks.find(
      (check) => check.name === "handoff_success_contradictions",
    );

    expect(contradictionCheck?.passed).toBe(false);
    expect(scorecard.passed).toBe(false);
    expect(scorecard.verdict).toBe("fail");
  });

  it("fails in strict mode when a deployment OK handoff includes default-port warm-start evidence", () => {
    const scorecard = computeScorecard(snapshotWithHandoff([
      "DEPLOYMENT_OK: Deployment completed.",
      "",
      "- commands_run:",
      "  - node homerail_cli/dist/cli.js start - success (Manager already healthy at http://localhost:19191)",
    ].join("\n"), strictDeploymentDiagnosisScorecard));
    const contradictionCheck = scorecard.checks.find(
      (check) => check.name === "handoff_success_contradictions",
    );

    expect(contradictionCheck?.passed).toBe(false);
    expect(contradictionCheck?.detail).toContain("forbidden success term");
    expect(scorecard.passed).toBe(false);
    expect(scorecard.verdict).toBe("fail");
  });

  it("fails when a diagnosis handoff reports cold-start coverage blocked", () => {
    const scorecard = computeScorecard(snapshotWithHandoff({
      status: "DEPLOYMENT_COVERAGE_BLOCKED",
      deployment_coverage_blocker: "Manager was already healthy before start",
      warm_start_only: true,
    }, strictDeploymentDiagnosisScorecard));
    const blockerCheck = scorecard.checks.find((check) => check.name === "handoff_reported_blockers");

    expect(blockerCheck?.passed).toBe(false);
    expect(scorecard.verdict).toBe("fail");
  });

  it("fails when a diagnosis handoff reports an unsuitable execution environment", () => {
    const scorecard = computeScorecard(snapshotWithHandoff({
      status: "DIAGNOSIS_ENVIRONMENT_BLOCKED",
      reason: "run-scoped Worker workspace is unavailable",
    }, strictDeploymentDiagnosisScorecard));
    const blockerCheck = scorecard.checks.find((check) => check.name === "handoff_reported_blockers");

    expect(blockerCheck?.passed).toBe(false);
    expect(scorecard.verdict).toBe("fail");
  });

  it("skips DAG-specific policy checks when enforcement is off", () => {
    const scorecard = computeScorecard(snapshotWithHandoff({
      status: "DEPLOYMENT_BLOCKED",
      deployment_blocker: "would normally be reported by policy",
    }, {
      ...deploymentDiagnosisScorecard,
      enforcement: "off",
    }));

    expect(scorecard.enforcement).toBe("off");
    expect(scorecard.checks.find((check) => check.name === "handoff_reported_blockers")).toBeUndefined();
    expect(scorecard.passed).toBe(true);
    expect(scorecard.verdict).toBe("pass");
  });
});

describe("scorecard declarative quality gate policy", () => {
  it("parses declared quality gate nodes and categories", () => {
    const snapshot: PersistedRunSnapshot = {
      metadata: {
        runId: "selfdev-run",
        workflowId: "selfdev-template",
        workflowName: "selfdev-template",
        scorecard: {
          profile: "selfdev",
          quality_gate: {
            enabled: true,
            nodes: ["verify"],
            required_categories: ["lint", "unit-tests"],
          },
        },
        nodeCount: 1,
        createdAt: Date.now(),
        completedAt: Date.now(),
        status: "completed",
        nodeStates: { verify: "COMPLETED" },
        handoffedNodes: ["verify"],
        graph: {
          nodes: [
            {
              node_id: "verify",
              name: "Verify",
              description: "",
              node_type: "agent",
              agent: "verifier",
              after: [],
              outputs: { done: { to: "" } },
            },
          ],
          edges: [],
        },
      },
      events: [
        {
          type: "dag:run_created",
          payload: { runId: "selfdev-run", workflowId: "selfdev-template", nodeCount: 1 },
          timestamp: Date.now(),
        },
      ],
      handoffs: [
        {
          runId: "selfdev-run",
          fromNode: "verify",
          port: "done",
          content: [
            "Quality Gate",
            "lint: PASS",
            "unit tests: PASS",
          ].join("\n"),
          timestamp: Date.now(),
        },
      ],
      chats: {
        verify: [
          {
            role: "worker",
            type: "response",
            content: { type: "tool_use", name: "Bash", input: { command: "npm run ci" } },
            timestamp: Date.now(),
          },
        ],
      },
    };

    const scorecard = computeScorecard(snapshot);
    const qgCheck = scorecard.checks.find((check) => check.name === "tester_quality_gate");

    expect(qgCheck?.passed).toBe(true);
    expect(scorecard.is_selfdev).toBe(true);
    expect(scorecard.quality_gate_applicable).toBe(true);
    expect(scorecard.quality_gate_categories).toEqual({ lint: true, "unit-tests": true });

    const evalReport = buildEvalReport(snapshot, scorecard);
    expect(evalReport.quality_gate.status).toBe("pass");
    expect(evalReport.quality_gate.categories).toEqual({ lint: true, "unit-tests": true });
  });
});
