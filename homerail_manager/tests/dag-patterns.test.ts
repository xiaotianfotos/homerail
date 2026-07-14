import { describe, expect, it } from "vitest";
import * as path from "node:path";

import {
  DAG_PATTERN_SOURCE,
  getDAGPattern,
  instantiateDAGPattern,
  listDAGPatterns,
} from "../src/orchestration/dag-patterns.js";
import { validateJsonContract } from "../src/orchestration/json-contract.js";
import { parseDAGYamlFile } from "../src/orchestration/yaml-loader.js";

describe("built-in DAG patterns", () => {
  it("ships the complete pattern catalog with AI-readable guidance", () => {
    const patterns = listDAGPatterns();

    expect(patterns.map((pattern) => pattern.id)).toEqual([
      "heartbeat",
      "issue-diagnosis",
      "orchestrator-workers",
      "executor-advisor",
      "budget-gate",
      "trust-ledger",
      "standing-goal-sentinel",
      "quorum",
      "sparring",
      "ratchet",
      "compost",
    ]);
    for (const pattern of patterns) {
      expect(pattern.roles.length).toBeGreaterThan(1);
      expect(pattern.typical_uses.length).toBeGreaterThan(0);
      expect(pattern.avoid_when.length).toBeGreaterThan(0);
      expect(pattern.required_primitives.length).toBeGreaterThan(0);
      expect(pattern.invariants.length).toBeGreaterThan(0);
      expect(pattern.evidence_contract.required.length).toBeGreaterThan(0);
      expect(pattern.composition_ports.outputs.length).toBeGreaterThan(0);
      expect(Object.keys(pattern.failure_semantics).length).toBeGreaterThan(0);
      expect(pattern.node_count).toBeGreaterThan(1);
      expect(pattern.source).toEqual(DAG_PATTERN_SOURCE);
    }
  });

  it("keeps issue diagnosis platform-neutral, read-only, and contract driven", () => {
    const pattern = instantiateDAGPattern("issue-diagnosis");
    const spec = pattern.workflow.spec as Record<string, unknown>;
    const nodes = spec.nodes as Record<string, Record<string, unknown>>;
    const contracts = pattern.parsed.meta.contracts;
    const exactRevision = "0123456789012345678901234567890123456789";
    const request = {
      issue: {
        id: "local-17",
        title: "Heartbeat pattern appears to be missing",
        body: "Check the built-in catalog at the supplied revision.",
        source: "manual",
        discussion: [{ author: "reporter", body: "The catalog response did not show heartbeat." }],
      },
      target: {
        repository_url: "https://example.test/owner/repository",
        revision: exactRevision,
      },
      constraints: {
        max_test_seconds: 120,
        focus_paths: ["homerail_manager/src/orchestration/dag-patterns.ts"],
      },
    };

    expect(spec.triggers).toBeUndefined();
    expect(spec.workspace).toEqual({ mode: "shared" });
    expect(spec.artifacts).toEqual([
      expect.objectContaining({ name: "diagnosis.json", contract: "DiagnosisReport", required: true, publish: "always" }),
      expect.objectContaining({ name: "verification.json", contract: "ConsensusVerification", required: true, publish: "always" }),
    ]);
    expect(pattern.parsed.meta.artifacts).toEqual([
      expect.objectContaining({ name: "diagnosis.json", media_type: "application/json" }),
      expect.objectContaining({ name: "verification.json", media_type: "application/json" }),
    ]);
    expect(Object.values(nodes).map((node) => node.kind)).toEqual([
      "agent",
      "command",
      "agent",
      "command",
      "command",
      "command",
      "agent",
      "command",
      "agent",
      "command",
      "agent",
      "command",
      "agent",
      "agent",
      "agent",
      "agent",
      "agent",
      "condition",
      "terminal",
      "terminal",
    ]);
    expect(nodes.checkout_repository?.depends_on).toEqual(["triage"]);
    expect(nodes.checkout_repository?.config).toMatchObject({
      command: ["node", "-e", expect.stringMatching(/(?=.*HOME:home)(?=.*credential\.helper=)(?=.*http\.extraHeader=)/)],
      stdin_field: "$inputs",
      cwd: "$run_workspace",
      success_port: "checked",
      failure_port: "checked",
    });
    expect(nodes.checkout_repository?.config).not.toHaveProperty("command_field");
    expect(nodes.prepare_repository?.workspace_access).toEqual({ writable_paths: [], readonly_paths: [] });
    expect(nodes.prepare_repository?.inputs).toHaveProperty("checkout");
    expect(nodes.resolve_repository_head?.config).toMatchObject({
      command: ["git", "-c", "safe.directory=*", "rev-parse", "HEAD"],
      cwd: "$run_workspace/source",
      success_port: "checked",
      failure_port: "checked",
    });
    expect(nodes.match_repository_revision?.config).toMatchObject({
      stdin_field: "$inputs",
      success_port: "checked",
      failure_port: "checked",
    });
    expect(nodes.snapshot_focus_paths?.config).toMatchObject({
      stdin_field: "$inputs",
      cwd: "$run_workspace",
      parse_stdout: "json",
      result_payload: "value",
      success_port: "snapshotted",
      failure_port: "snapshotted",
    });
    expect(nodes.snapshot_focus_paths?.config?.command).toEqual([
      "node",
      "-e",
      expect.stringMatching(/(?=.*realpathSync\('source'\))(?=.*isSymbolicLink)(?=.*O_NOFOLLOW)(?=.*256000)/),
    ]);
    expect(nodes.review_reproduction?.workspace_access).toMatchObject({
      writable_paths: ["scratch/reproduction"],
      readonly_paths: ["source"],
    });
    expect(nodes.review_reproduction?.inputs).toHaveProperty("revision_check");
    for (const nodeId of [
      "review_reproduction",
      "review_dataflow",
      "review_history",
      "verify_scenario",
      "verify_evidence",
      "verify_adversarial",
    ]) {
      expect(nodes[nodeId]?.inputs).toHaveProperty("focus_snapshot");
    }
    expect(nodes.review_dataflow?.depends_on).toEqual(["normalize_reproduction"]);
    expect(nodes.review_history?.depends_on).toEqual(["normalize_reproduction"]);
    for (const nodeId of ["normalize_reproduction", "normalize_dataflow", "normalize_history"]) {
      expect(nodes[nodeId]?.inputs).toMatchObject({ success: {}, failure: {} });
      expect(nodes[nodeId]?.config).toMatchObject({
        stdin_field: "$inputs",
        parse_stdout: "json",
        result_payload: "value",
        success_port: "reviewed",
        failure_port: "reviewed",
      });
    }
    expect(nodes.normalize_reproduction?.depends_on).toEqual(["review_reproduction"]);
    expect(nodes.normalize_dataflow?.depends_on).toEqual(["review_dataflow"]);
    expect(nodes.normalize_history?.depends_on).toEqual(["review_history"]);
    for (const nodeId of ["review_dataflow", "review_history", "verify_scenario", "verify_evidence", "verify_adversarial"]) {
      expect(nodes[nodeId]?.workspace_access).toMatchObject({ writable_paths: [], readonly_paths: ["source"] });
    }
    expect(nodes.consensus_gate?.config).toMatchObject({
      field: "verdict",
      routes: { pass: "accepted", fail: "rejected" },
      default: "rejected",
    });
    expect((spec.policies as Record<string, unknown>).max_parallelism).toBe(3);
    expect((spec.policies as Record<string, unknown>).max_corrections_per_node).toBe(5);
    expect(pattern.parsed.meta.agents.repository_preparer?.system).toContain("Manager already ran the fixed credential-free checkout command");
    expect(pattern.parsed.meta.agents.repository_preparer?.system).toContain("do not prepare, inspect, or mutate");
    expect(pattern.parsed.meta.agents.repository_preparer?.system).toContain("checkout.ok=true");
    expect(pattern.parsed.meta.agents.repository_preparer?.system).toContain("any tool except handoff");
    expect(pattern.parsed.meta.agents.repository_preparer?.system).toContain("Never invent a hash");
    expect(pattern.parsed.meta.agents.reproduction_reviewer?.system).toContain("claim proved true");
    expect(pattern.parsed.meta.agents.reproduction_reviewer?.system).toContain("revision_check.ok=true");
    expect(pattern.parsed.meta.agents.reproduction_reviewer?.system).toContain("reproduction=not_reproduced");
    expect(pattern.parsed.meta.agents.reproduction_reviewer?.system).toContain("focus_snapshot");
    expect(pattern.parsed.meta.agents.reproduction_reviewer?.system).toContain("do not call or simulate Read, Grep, or Bash");
    expect(pattern.parsed.meta.agents.triage?.system).toContain("exactly five top-level keys");
    expect(pattern.parsed.meta.agents.triage?.system).toContain("stated_facts");
    expect(pattern.parsed.meta.agents.reproduction_reviewer?.system).toContain("at least two materially different state variants");
    expect(pattern.parsed.meta.agents.reproduction_reviewer?.system).toContain("static catalog");
    expect(pattern.parsed.meta.agents.reproduction_reviewer?.system).toContain("without installing dependencies");
    expect(pattern.parsed.meta.agents.reproduction_reviewer?.system).toContain("copy source to scratch/reproduction/source");
    expect(pattern.parsed.meta.agents.reproduction_reviewer?.system).toContain("never run npm install");
    expect(pattern.parsed.meta.agents.reproduction_reviewer?.system).toContain("unbuilt local workspace package");
    expect(pattern.parsed.meta.agents.reproduction_reviewer?.system).toContain("failing-case/control pair");
    expect(pattern.parsed.meta.agents.reproduction_reviewer?.system).toContain("history reviewer owns that work");
    expect(pattern.parsed.meta.agents.reproduction_reviewer?.system).toContain("type=test, http, or runtime");
    expect(pattern.parsed.meta.agents.history_reviewer?.system).toContain("pseudo-tool text does not execute");
    expect(pattern.parsed.meta.agents.dataflow_reviewer?.system).toContain("caller or UI payload");
    expect(pattern.parsed.meta.agents.dataflow_reviewer?.system).toContain("at most sixteen tool calls");
    expect(pattern.parsed.meta.agents.dataflow_reviewer?.system).toContain("regression archaeology belongs to the history reviewer");
    expect(pattern.parsed.meta.agents.dataflow_reviewer?.system).toContain("Do not run package managers");
    expect(pattern.parsed.meta.agents.history_reviewer?.system).toContain("parent-versus-current");
    expect(pattern.parsed.meta.agents.history_reviewer?.system).toContain("three phases only");
    expect(pattern.parsed.meta.agents.history_reviewer?.system).toContain("never emit a prose summary");
    expect(pattern.parsed.meta.agents.history_reviewer?.system).toContain("Never clone another checkout");
    expect(pattern.parsed.meta.agents.arbiter?.system).toContain("different scenarios");
    expect(pattern.parsed.meta.agents.arbiter?.system).toContain("consensus.issue_match=exact");
    expect(pattern.parsed.meta.agents.arbiter?.system).toContain("exact, plausible, or unknown");
    expect(pattern.parsed.meta.agents.arbiter?.system).toContain("purely static catalog");
    expect(pattern.parsed.meta.agents.scenario_verifier?.system).toContain("user's exact scenario");
    expect(pattern.parsed.meta.agents.scenario_verifier?.system).toContain("not_reproduced report");
    expect(pattern.parsed.meta.agents.scenario_verifier?.system).toContain("scratch/reproduction/source");
    expect(pattern.parsed.meta.agents.evidence_verifier?.system).toContain("wrong locator");
    expect(pattern.parsed.meta.agents.evidence_verifier?.system).toContain("at most sixteen tool calls");
    expect(pattern.parsed.meta.agents.evidence_verifier?.system).toContain("stop exploring duplicate medium/low evidence");
    expect(pattern.parsed.meta.agents.adversarial_verifier?.system).toContain("strongest competing hypothesis");
    expect(pattern.parsed.meta.agents.consensus?.system).toContain("all three distinct reviewers vote pass");
    expect(pattern.parsed.meta.agents.consensus?.system).toContain("final acceptance authority");
    expect(pattern.parsed.meta.agents.consensus?.system).toContain("Do not reject solely");
    expect(validateJsonContract(contracts?.IssueDiagnosisRequest, request)).toMatchObject({ valid: true });
    expect(validateJsonContract(contracts?.IssueDiagnosisRequest, {
      ...request,
      target: { ...request.target, token: "must-not-be-accepted" },
    })).toMatchObject({ valid: false });
    expect(validateJsonContract(contracts?.IssueDiagnosisRequest, {
      ...request,
      target: { repository_url: "git@example.test:owner/repository", revision: exactRevision },
    })).toMatchObject({ valid: false });
    expect(validateJsonContract(contracts?.IssueDiagnosisRequest, {
      ...request,
      target: { repository_url: "https://user:secret@example.test/owner/repository", revision: exactRevision },
    })).toMatchObject({ valid: false });
    expect(validateJsonContract(contracts?.IssueDiagnosisRequest, {
      ...request,
      target: { ...request.target, revision: "main" },
    })).toMatchObject({ valid: false });
    expect(validateJsonContract(
      contracts?.DiagnosticPlan,
      JSON.stringify({ scope: "same-key ASR to TTS", hypotheses: ["contract drift", "provider error"] }),
    )).toMatchObject({ valid: true });
    expect(validateJsonContract(contracts?.DiagnosticPlan, {
      scope: "same-key ASR to TTS",
      checks: [{ id: "check-tts-validation-logic", objective: "Compare the caller and server contracts" }],
    })).toMatchObject({ valid: true });
    expect(validateJsonContract(contracts?.DiagnosticPlan, 17)).toMatchObject({ valid: false });
    expect(validateJsonContract(contracts?.RepositoryPreparation, {
      status: "prepared",
      tested_revision: "0123456789012345678901234567890123456789",
      source_path: "source",
      evidence: { command: "git rev-parse HEAD", result: "matched" },
    })).toMatchObject({ valid: true });
    expect(validateJsonContract(contracts?.RepositoryPreparation, {
      status: "prepared",
      tested_revision: "main",
      source_path: "source",
    })).toMatchObject({ valid: false });
    expect(validateJsonContract(contracts?.RepositoryPreparation, {
      status: "unavailable",
      tested_revision: "main",
      source_path: "source",
    })).toMatchObject({ valid: true });

    const report = {
      schema_version: "2.0",
      issue_id: "local-17",
      outcome: "not_reproduced",
      summary: "The claimed absence was not reproduced.",
      tested_revision: "0123456789012345678901234567890123456789",
      consensus: {
        decision: "unanimous",
        issue_match: "exact",
        supporting_review_ids: ["reproduction", "dataflow", "history"],
        dissenting_review_ids: [],
        rationale: "All three reviews found heartbeat at the supplied revision.",
        review_summaries: ["reproduction", "dataflow", "history"].map((reviewer_id) => ({
          reviewer_id,
          issue_match: "exact",
          reproduction: "not_reproduced",
          position: "support",
          summary: "Heartbeat is registered at the tested revision.",
        })),
      },
      root_cause: { status: "unknown", explanation: "The pattern is present at this revision.", evidence_ids: ["arbiter-e001"] },
      findings: [{ id: "arbiter-f001", severity: "info", claim: "Heartbeat is present.", evidence_ids: ["arbiter-e001"] }],
      evidence: [{ id: "arbiter-e001", type: "source", locator: "dag-patterns.ts:heartbeat", observation: "The catalog registers heartbeat." }],
      tests: [{ command: "targeted catalog test", status: "passed", summary: "The catalog test includes heartbeat." }],
      recommendations: [{ priority: "next", action: "Verify the caller's revision.", rationale: "The supplied revision is healthy." }],
      limitations: [],
      confidence: "high",
    };
    expect(validateJsonContract(contracts?.DiagnosisReport, report)).toMatchObject({ valid: true });
    expect(validateJsonContract(contracts?.DiagnosisReport, {
      ...report,
      tested_revision: "main",
    })).toMatchObject({ valid: false });
    expect(validateJsonContract(contracts?.DiagnosisReport, {
      ...report,
      outcome: "insufficient_evidence",
      tested_revision: "main",
    })).toMatchObject({ valid: true });
    expect(validateJsonContract(contracts?.DiagnosisReport, {
      ...report,
      consensus: {
        ...report.consensus,
        review_summaries: {
          reproduction: "Same causal chain, behavioral evidence pending.",
          dataflow: "Caller/server mismatch confirmed.",
          history: "Regression commit identified.",
        },
      },
      root_cause: {
        mechanism: "The caller sends a retired key-reuse sentinel.",
        introduced_in: "e2ad824",
      },
      recommendations: [{ priority: "P0", fix: "Migrate onboarding to the boolean reuse field." }],
    })).toMatchObject({ valid: true });
    expect(validateJsonContract(contracts?.DiagnosisReport, { ...report, platform_comment_id: "write-back" }))
      .toMatchObject({ valid: false });
    expect(validateJsonContract(contracts?.DiagnosisReport, {
      ...report,
      outcome: "confirmed",
    })).toMatchObject({ valid: false });
    const passingVote = {
      reviewer_id: "scenario",
      verdict: "pass",
      issue_match: "exact",
      checked_revision: "0123456789012345678901234567890123456789",
      checked_evidence_ids: ["repro-e001"],
      evidence: [{ locator: "OnboardingStepForm.vue:345", result: "matched" }],
      defects: [],
    };
    expect(validateJsonContract(contracts?.VerificationVote, passingVote)).toMatchObject({ valid: true });
    expect(validateJsonContract(contracts?.VerificationVote, {
      ...passingVote,
      checked_revision: "main",
    })).toMatchObject({ valid: false });
    expect(validateJsonContract(contracts?.VerificationVote, {
      ...passingVote,
      verdict: "fail",
      checked_revision: "main",
      defects: ["Repository preparation was unavailable."],
    })).toMatchObject({ valid: true });
    const verificationVotes = ["scenario", "evidence", "adversarial"].map((reviewer_id) => ({
      ...passingVote,
      reviewer_id,
    }));
    const passingConsensus = {
      verdict: "pass",
      policy: "unanimous-three-reviewers",
      checked_revision: passingVote.checked_revision,
      votes: verificationVotes,
      evidence: ["All three reviewers independently passed."],
      defects: [],
    };
    expect(validateJsonContract(contracts?.ConsensusVerification, passingConsensus)).toMatchObject({ valid: true });
    expect(validateJsonContract(contracts?.ConsensusVerification, {
      ...passingConsensus,
      checked_revision: "main",
    })).toMatchObject({ valid: false });
    const reviewWithScalarLimitation = {
      reviewer_id: "reproduction",
      tested_revision: "0123456789012345678901234567890123456789",
      issue_match: "exact",
      reproduction: "confirmed",
      hypothesis: "The caller sends a retired sentinel.",
      root_cause: { status: "identified", explanation: "Caller and server contracts differ.", evidence_ids: ["repro-e001"] },
      findings: [{ id: "repro-f001", severity: "high", claim: "The request is rejected.", evidence_ids: ["repro-e001"] }],
      evidence: [{ id: "repro-e001", type: "http", locator: "POST /api/llm-settings", observation: "Returned 400." }],
      tests: [{ command: "focused request test", status: "passed", summary: "Failing and control variants diverged." }],
      limitations: "The browser toast was not captured.",
      confidence: "high",
    };
    expect(validateJsonContract(contracts?.IndependentReview, reviewWithScalarLimitation))
      .toMatchObject({ valid: true });
    expect(validateJsonContract(contracts?.IndependentReview, {
      ...reviewWithScalarLimitation,
      evidence: [{
        id: "repro-e001",
        type: "source",
        locator: "agent-ui/src/component.ts:17",
        observation: "Source inspection only.",
      }],
    })).toMatchObject({ valid: false });
    expect(validateJsonContract(contracts?.IndependentReview, {
      ...reviewWithScalarLimitation,
      reproduction: "inconclusive",
      tested_revision: "main",
      evidence: [{
        id: "repro-e001",
        type: "source",
        locator: "agent-ui/src/component.ts:17",
        observation: "Source inspection only.",
      }],
    })).toMatchObject({ valid: true });
    expect(validateJsonContract(contracts?.IndependentReview, {
      ...reviewWithScalarLimitation,
      reproduction: "not_reproduced",
      tested_revision: "main",
      evidence: [{
        id: "repro-e001",
        type: "source",
        locator: "agent-ui/src/component.ts:17",
        observation: "The exact reported path is healthy.",
      }],
    })).toMatchObject({ valid: false });
  });

  it("exposes Executor-Advisor as a bounded callable advisor topology", () => {
    const pattern = instantiateDAGPattern("executor-advisor", { max_advisor_calls: 3 });
    const execute = pattern.parsed.graph.nodes.find((node) => node.node_id === "execute");
    const runtime = execute?.extra?.agent_runtime as Record<string, unknown> | undefined;
    expect(runtime?.advisors).toEqual([{
      id: "expert",
      agent: "advisor",
      max_calls: 3,
      timeout_ms: 120000,
      max_tokens: 64000,
    }]);
    expect(pattern.parsed.meta.agents).toHaveProperty("executor");
    expect(pattern.parsed.meta.agents).toHaveProperty("advisor");
  });

  it("reserves declared budget before dispatching expensive work", () => {
    const pattern = instantiateDAGPattern("budget-gate");
    const gate = pattern.parsed.graph.nodes.find((node) => node.node_id === "budget_gate");
    expect(gate?.gateway_config).toMatchObject({
      operation: "budget_admit",
      value_field: "expected_usage",
      budget_limit: 5,
    });
    expect(pattern.parsed.graph.nodes.some((node) => node.node_id === "record_usage")).toBe(false);
  });

  it("gives the trust verifier the original acceptance criteria", () => {
    const pattern = instantiateDAGPattern("trust-ledger");
    const verifier = pattern.parsed.meta.agents.verifier;

    expect(verifier?.system).toContain("original work request and its acceptance criteria");
    expect(pattern.workflow.spec.edges).toContainEqual({ from: "$run.input", to: "verify.work" });
    expect(pattern.parsed.graph.nodes.find((node) => node.node_id === "verify")?.extra?.workflow_spec_v1)
      .toMatchObject({ input_contracts: { work: "Work" } });
    expect(pattern.parsed.graph.edges).toContainEqual(expect.objectContaining({
      from_node: "execute",
      from_port: "completed",
      to_node: "verify",
      to_port: "result",
    }));
  });

  it("instantiates every built-in pattern as valid provider-independent YAML", () => {
    for (const summary of listDAGPatterns()) {
      const instance = instantiateDAGPattern(summary.id);

      expect(instance.validation.valid).toBe(true);
      expect(instance.validation.errors).toEqual([]);
      expect(instance.parsed.meta.workflow_id).toBe(`pattern-${summary.id}`);
      expect(["isolated", "shared"]).toContain(instance.parsed.meta.workspace?.mode);
      expect(instance.parsed.meta.pattern).toMatchObject({
        id: summary.id,
        version: summary.version,
        source: DAG_PATTERN_SOURCE.url,
      });
      expect(instance.workflow).toMatchObject({
        api_version: "homerail.ai/v1",
        kind: "Workflow",
        metadata: { id: `pattern-${summary.id}` },
        spec: { pattern: { id: summary.id } },
      });
      expect(instance.yaml_text).toMatch(/^api_version: homerail\.ai\/v1/m);
      expect(instance.yaml_text).not.toMatch(/^workflow_id:/m);
      expect(instance.yaml_text).not.toMatch(/^\s*(provider|model|api_key):/m);
      expect(instance.yaml_text).not.toContain("{{");
    }
  });

  it("preserves numeric parameter types in gateway configuration", () => {
    const quorum = instantiateDAGPattern("quorum", {
      workflow_id: "release-quorum",
      threshold: 3,
    });
    const join = quorum.parsed.graph.nodes.find((node) => node.node_id === "quorum");
    expect(join?.gateway_config?.threshold).toBe(3);
    expect(quorum.parsed.meta.pattern?.parameters).toMatchObject({
      workflow_id: "release-quorum",
      threshold: 3,
    });

    const ratchet = instantiateDAGPattern("ratchet", { target: 2, max_iterations: 5 });
    const gate = ratchet.parsed.graph.nodes.find((node) => node.node_id === "target_gate");
    expect(gate?.gateway_config).toMatchObject({ value: 2, max_iterations: 5 });
    expect(ratchet.parsed.graph.edges.find(
      (edge) => edge.from_node === "monotonic_gate" && edge.to_node === "target_gate",
    )?.retry_policy?.max_retries).toBe(5);
  });

  it("makes the heartbeat verifier emit the top-level field consumed by its gateway", () => {
    const heartbeat = instantiateDAGPattern("heartbeat");
    const verifier = heartbeat.parsed.meta.agents.verifier;
    const verdictGate = heartbeat.parsed.graph.nodes.find((node) => node.node_id === "verdict_gate");
    const deterministicCheck = heartbeat.parsed.graph.nodes.find((node) => node.node_id === "deterministic_check");

    expect(verifier?.system).toContain("top-level verdict");
    expect(verifier?.system).toContain("Never nest verdict");
    expect(verifier?.system).toContain("input:order.done_when");
    expect(verifier?.system).toContain("never fail merely because that command has not run yet");
    for (const role of ["triage", "conductor", "worker", "verifier"] as const) {
      expect(heartbeat.parsed.meta.agents[role]?.system).toMatch(/(?:do not|never) execute check_command/i);
    }
    expect(verdictGate?.gateway_config?.field).toBe("verdict");
    expect(deterministicCheck?.gateway_config).toMatchObject({ input: "order", command_field: "check_command" });
    expect(heartbeat.parsed.graph.edges).toContainEqual(expect.objectContaining({
      from_node: "conduct",
      from_port: "ordered",
      to_node: "deterministic_check",
      to_port: "order",
    }));
    expect(heartbeat.parsed.graph.edges).toContainEqual(expect.objectContaining({
      from_node: "conduct",
      from_port: "ordered",
      to_node: "verify",
      to_port: "order",
    }));
    expect(validateJsonContract(heartbeat.parsed.meta.contracts?.WorkOrder, {
      done_when: "heartbeat acknowledgement is recorded",
      evidence: "synthetic",
      check_command: ["node", "-e", "process.exit(0)"],
    })).toMatchObject({ valid: true });
    expect(validateJsonContract(heartbeat.parsed.meta.contracts?.WorkResult, {
      status: "pass",
      evidence: "synthetic",
    })).toMatchObject({ valid: false });
    expect(validateJsonContract(heartbeat.parsed.meta.contracts?.Signals, "CLI prompt signal")).toMatchObject({
      valid: true,
    });
    expect(validateJsonContract(heartbeat.parsed.meta.contracts?.Signals, { event: "pull_request" })).toMatchObject({
      valid: true,
    });
  });

  it("uses bounded data-driven fan-out instead of a fixed worker count", () => {
    const pattern = instantiateDAGPattern("orchestrator-workers");
    const planEdges = pattern.parsed.graph.edges.filter(
      (edge) => edge.from_node === "plan" && edge.from_port === "planned" && edge.label !== "after_dep",
    );

    expect(planEdges.map((edge) => [edge.from_port, edge.to_node, edge.to_port])).toEqual([["planned", "fanout", "plan"]]);
    const planner = pattern.parsed.graph.nodes.find((node) => node.node_id === "plan");
    const fanout = pattern.parsed.graph.nodes.find((node) => node.node_id === "fanout");
    const verifier = pattern.parsed.graph.nodes.find((node) => node.node_id === "verify");
    expect(fanout?.gateway_config).toMatchObject({
      type: "fanout",
      max_items: 16,
      max_parallelism: 4,
      worker_agent: "worker",
      context_field: "context",
    });
    expect(pattern.parsed.meta.contracts?.Plan).toMatchObject({
      required: ["context", "work_items"],
      properties: {
        context: { type: "string", minLength: 1 },
        work_items: {
          items: {
            required: ["id", "task", "acceptance_criteria"],
            properties: { acceptance_criteria: { type: "array", minItems: 1 } },
          },
        },
      },
    });
    expect(pattern.parsed.meta.contracts?.WorkerResult).toMatchObject({ required: ["status", "evidence"] });
    expect(fanout?.gateway_config?.result_contract).toBe("WorkerResult");
    expect(pattern.parsed.meta.agents.orchestrator?.system).toContain("1..N");
    expect(pattern.parsed.meta.agents.orchestrator?.system).toContain("Never precompute");
    expect(pattern.parsed.meta.agents.orchestrator?.system).toContain("objective verbatim");
    expect(pattern.parsed.meta.agents.orchestrator?.system).toContain("exactly success or failed");
    expect(pattern.parsed.meta.agents.orchestrator?.system).toContain("non-empty JSON array of strings");
    expect(pattern.parsed.meta.agents.orchestrator?.system).toContain("exact port planned");
    expect(pattern.parsed.meta.agents.worker?.system).toContain("fan-out item");
    expect(pattern.parsed.meta.agents.worker?.system).toContain("original immutable context");
    expect(planner?.extra?.agent_runtime).toMatchObject({
      allowed_builtin_tools: [],
      allowed_dag_tools: ["handoff"],
    });
    expect(verifier?.extra?.agent_runtime).toMatchObject({
      allowed_builtin_tools: [],
      allowed_dag_tools: ["handoff"],
    });
  });

  it("keeps compost proposals behind a durable human approval node", () => {
    const pattern = instantiateDAGPattern("compost");
    const approval = pattern.parsed.graph.nodes.find((node) => node.node_id === "human_review");
    expect(approval?.node_type).toBe("approval_gateway");
    expect(approval?.gateway_config).toMatchObject({
      approval_id: "compost-change",
      proposer_actor: "agent:proposer",
      authorized_actors: ["owner"],
    });
    expect(pattern.parsed.meta.agents.proposer?.system).toContain("Never approve or apply");
  });

  it("requires sparring challenge and repair evidence before downstream work", () => {
    const pattern = instantiateDAGPattern("sparring");
    const breaker = pattern.parsed.graph.nodes.find((node) => node.node_id === "break");
    const builder = pattern.parsed.graph.nodes.find((node) => node.node_id === "build");
    const deterministicCheck = pattern.parsed.graph.nodes.find((node) => node.node_id === "deterministic_check");
    const verifier = pattern.parsed.graph.nodes.find((node) => node.node_id === "verify");

    expect(pattern.parsed.meta.contracts?.Challenge).toMatchObject({
      additionalProperties: false,
      required: ["artifact_path", "test_command", "evidence"],
    });
    expect(pattern.parsed.meta.contracts?.Repair).toMatchObject({
      additionalProperties: false,
      required: ["test_command", "evidence"],
    });
    expect(pattern.parsed.meta.agents.builder?.system).toContain("input:challenge.test_command");
    expect(pattern.parsed.meta.agents.builder?.system).toContain("input:correction");
    expect(pattern.parsed.meta.agents.builder?.system).toContain("fix_applied");
    expect(pattern.parsed.meta.agents.verifier?.system).toContain("Manager-owned input:check");
    expect(pattern.parsed.meta.agents.verifier?.system).toContain("check.ok is true");
    expect(breaker?.extra?.agent_runtime).toMatchObject({
      allowed_builtin_tools: ["Write"],
      allowed_dag_tools: ["handoff"],
    });
    expect(builder?.extra?.agent_runtime).toMatchObject({
      allowed_builtin_tools: ["Write"],
      allowed_dag_tools: ["handoff"],
    });
    expect(verifier?.extra?.agent_runtime).toMatchObject({
      allowed_builtin_tools: [],
      allowed_dag_tools: ["handoff"],
    });
    expect(deterministicCheck?.node_type).toBe("command_gateway");
    expect(deterministicCheck?.gateway_config).toMatchObject({
      input: "challenge",
      command_field: "test_command",
      cwd: "$run_workspace",
      success_port: "passed",
      failure_port: "failed",
    });
    expect(deterministicCheck?.extra?.workflow_spec_v1).toMatchObject({
      input_contracts: { challenge: "Challenge", repair: "Repair" },
    });
    expect(verifier?.extra?.workflow_spec_v1).toMatchObject({
      input_contracts: { challenge: "Challenge", repair: "Repair" },
    });
    expect(pattern.parsed.meta.limits?.max_corrections_per_node).toBe(3);
    expect(pattern.parsed.graph.nodes.find((node) => node.node_id === "break")?.extra?.workflow_spec_v1)
      .toMatchObject({ output_contracts: { challenge: "Challenge" } });
  });

  it("requires ratchet improvers to hand measurement and rollback back to deterministic nodes", () => {
    const pattern = instantiateDAGPattern("ratchet");
    const improver = pattern.parsed.meta.agents.improver;

    expect(improver?.system).toContain("Never self-report a new metric");
    expect(pattern.parsed.graph.nodes.find((node) => node.node_id === "remeasure")?.node_type).toBe("command_gateway");
    expect(pattern.parsed.graph.nodes.find((node) => node.node_id === "previous_measurement")?.node_type).toBe("command_gateway");
    expect(pattern.parsed.graph.nodes.find((node) => node.node_id === "compare_measurements")?.node_type).toBe("join_gateway");
    expect(pattern.parsed.graph.nodes.find((node) => node.node_id === "compare_measurements")?.gateway_config?.mode).toBe("all");
    expect(pattern.parsed.graph.nodes.find((node) => node.node_id === "rollback_regression")?.node_type).toBe("command_gateway");
    expect(pattern.parsed.graph.nodes.find((node) => node.node_id === "enroll_floor")?.node_type).toBe("state_gateway");
  });

  it("rejects unknown, incorrectly typed, and out-of-range parameters", () => {
    expect(() => instantiateDAGPattern("missing")).toThrow("DAG pattern not found");
    expect(() => instantiateDAGPattern("quorum", { surprise: true })).toThrow("Unknown pattern parameter");
    expect(() => instantiateDAGPattern("quorum", { threshold: "2" })).toThrow("must be a finite number");
    expect(() => instantiateDAGPattern("quorum", { threshold: 2.5 })).toThrow("must be an integer");
    expect(() => instantiateDAGPattern("quorum", { threshold: 4 })).toThrow("must be at most 3");
    expect(() => instantiateDAGPattern("heartbeat", { workflow_id: "" })).toThrow("must be a non-empty string");
  });

  it("returns defensive copies of pattern definitions", () => {
    const first = getDAGPattern("quorum");
    expect(first).toBeDefined();
    first!.roles[0].responsibility = "mutated";

    expect(getDAGPattern("quorum")?.roles[0].responsibility).not.toBe("mutated");
  });

  it("keeps concrete offline pattern instances valid and isolated", () => {
    const assets = [
      ["pattern-quorum-offline.yaml", "quorum"],
      ["pattern-ratchet-exhaustion-offline.yaml", "ratchet"],
    ] as const;
    for (const [file, patternId] of assets) {
      const parsed = parseDAGYamlFile(path.resolve("..", "assets", "orchestrations", file));
      expect(parsed.meta.pattern?.id).toBe(patternId);
      expect(parsed.meta.workspace).toEqual({ mode: "isolated" });
    }
  });
});
