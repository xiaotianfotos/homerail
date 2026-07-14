import assert from "node:assert/strict";
import test from "node:test";

import {
  EXPECTED_PATTERN_IDS,
  LIVE_ISSUE_REVISION,
  catalogCoverageFailures,
  diagnosticFailureHandoffs,
  parseContent,
  patternParameters,
  prompts,
  semanticFailures,
  semanticRequirements,
} from "./dag-pattern-live-contracts.mjs";

test("covers the complete eleven-pattern catalog", () => {
  const catalog = EXPECTED_PATTERN_IDS.map((id) => ({ id, name: id }));
  assert.deepEqual(catalogCoverageFailures(catalog), []);
  assert.equal(Object.keys(prompts).length, 11);
  assert.equal(Object.keys(semanticRequirements).length, 11);
  assert.match(LIVE_ISSUE_REVISION, /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/);
  assert.deepEqual(JSON.parse(prompts["trust-ledger"]).acceptance_criteria, [
    "top-level evidence equals synthetic bounded check completed",
  ]);
});

test("uses current runtime-backed topology contracts", () => {
  assert.deepEqual(semanticRequirements["orchestrator-workers"], [
    { node: "fanout", port: "passed" },
    { node: "verify", port: "verified" },
  ]);
  assert.match(prompts["orchestrator-workers"], /Plan\.context/);
  assert.match(prompts["orchestrator-workers"], /input:item\.context/);
  assert.deepEqual(semanticRequirements.compost.at(-1), { node: "human_review", port: "approved" });
  assert.deepEqual(semanticRequirements["executor-advisor"], [{ node: "execute", port: "done" }]);
  assert.deepEqual(semanticRequirements.sparring, [
    { node: "deterministic_check", port: "passed" },
    { node: "verdict_gate", port: "passed" },
  ]);
  assert.match(prompts.sparring, /test_command/);
  assert.match(prompts.sparring, /Manager runs test_command/);
  assert.match(prompts.sparring, /\[\"node\",\"-e\"/);
  assert.match(prompts.sparring, /src\/live-fix\.txt/);
  assert.match(prompts.sparring, /trimEnd/);
});

test("bounds fan-out, advisor, and approval parameters", () => {
  assert.deepEqual(patternParameters({ id: "orchestrator-workers", name: "x" }), {
    workflow_id: "live-orchestrator-workers",
    name: "Live x Validation",
    max_workers: 3,
    max_parallelism: 2,
  });
  assert.equal(
    patternParameters({ id: "heartbeat", name: "x" }, "Run 42/Attempt 1").workflow_id,
    "live-heartbeat-run-42-attempt-1",
  );
  assert.equal(
    patternParameters({ id: "heartbeat", name: "x" }, `${"x".repeat(47)}--tail`).workflow_id,
    `live-heartbeat-${"x".repeat(47)}`,
  );
  assert.equal(patternParameters({ id: "executor-advisor", name: "x" }).max_advisor_calls, 1);
  assert.equal(patternParameters({ id: "compost", name: "x" }).authorized_actor, "live-validator");
});

test("parses structured handoff strings without coercing plain text", () => {
  assert.deepEqual(parseContent('{"status":"success"}'), { status: "success" });
  assert.equal(parseContent("plain text"), "plain text");
  assert.equal(parseContent("{broken}"), "{broken}");
});

test("retains complete negative handoffs for live failure diagnostics", () => {
  assert.deepEqual(diagnosticFailureHandoffs([
    { from_node: "check", port: "failed", content: '{"exit_code":1,"stderr":"missing file"}' },
    { from_node: "done", port: "passed", content: { ok: true } },
  ]), [{
    node: "check",
    port: "failed",
    content: { exit_code: 1, stderr: "missing file" },
  }]);
});

test("requires real advisor and durable approval evidence", () => {
  const advisorHandoffs = [{ from_node: "execute", port: "done", content: {} }];
  assert.deepEqual(semanticFailures("executor-advisor", advisorHandoffs, {
    advisor_calls: 1,
    advisor_model_ok: true,
    advisor_key_redacted: true,
  }), []);
  assert.match(semanticFailures("executor-advisor", advisorHandoffs, {})[0], /advisor call/);

  const compostHandoffs = [
    { from_node: "proposal_gate", port: "review", content: {} },
    { from_node: "human_review", port: "approved", content: {} },
  ];
  assert.deepEqual(semanticFailures("compost", compostHandoffs, {
    approval: { status: "approved", actor: "live-validator", proposal_hash: "abc" },
  }), []);
  assert.match(semanticFailures("compost", compostHandoffs, {})[0], /approval/);
});

test("requires a complete independently verified issue diagnosis", () => {
  const report = {
    schema_version: "2.0",
    issue_id: "live-synthetic",
    outcome: "not_reproduced",
    tested_revision: LIVE_ISSUE_REVISION,
    consensus: { decision: "unanimous", issue_match: "exact" },
    findings: [],
    evidence: [{ id: "arbiter-e001" }],
    tests: [],
    recommendations: [],
    limitations: [],
  };
  const votes = ["scenario", "evidence", "adversarial"].map((reviewer_id) => ({
    reviewer_id,
    verdict: "pass",
    issue_match: "exact",
    checked_revision: report.tested_revision,
    checked_evidence_ids: ["arbiter-e001"],
    evidence: ["checked"],
    defects: [],
  }));
  const verification = {
    verdict: "pass",
    policy: "unanimous-three-reviewers",
    checked_revision: report.tested_revision,
    votes,
    evidence: ["unanimous"],
    defects: [],
  };
  const handoffs = [
    {
      from_node: "checkout_repository",
      port: "checked",
      content: { ok: true, value: `${report.tested_revision}\n` },
    },
    {
      from_node: "match_repository_revision",
      port: "checked",
      content: { ok: true, value: `${report.tested_revision}\n` },
    },
    { from_node: "arbitrate", port: "reported", content: report },
    { from_node: "verify_scenario", port: "voted", content: votes[0] },
    { from_node: "verify_evidence", port: "voted", content: votes[1] },
    { from_node: "verify_adversarial", port: "voted", content: votes[2] },
    { from_node: "consensus", port: "checked", content: verification },
    { from_node: "consensus_gate", port: "accepted", content: verification },
    { from_node: "normalize_reproduction", port: "reviewed", content: { reviewer_id: "reproduction" } },
    { from_node: "normalize_dataflow", port: "reviewed", content: { reviewer_id: "dataflow" } },
    { from_node: "normalize_history", port: "reviewed", content: { reviewer_id: "history" } },
    {
      from_node: "snapshot_focus_paths",
      port: "snapshotted",
      content: {
        revision_verified: true,
        tested_revision: report.tested_revision,
        files: [
          { path: "homerail_manager/src/orchestration/dag-patterns.ts" },
          { path: "homerail_manager/tests/dag-patterns.test.ts" },
        ],
        limitations: [],
      },
    },
  ];
  assert.deepEqual(semanticFailures("issue-diagnosis", handoffs), []);
  const focusedSnapshot = handoffs.at(-1).content;
  handoffs.at(-1).content = { ...focusedSnapshot, revision_verified: false };
  assert.match(semanticFailures("issue-diagnosis", handoffs).join(";"), /focused source files/);
  handoffs.at(-1).content = focusedSnapshot;
  const conservativeHandoffs = handoffs.map((handoff) => handoff.from_node === "arbitrate"
    ? {
        ...handoff,
        content: {
          ...report,
          outcome: "insufficient_evidence",
          confidence: "medium",
          limitations: ["Two reviewers could not independently execute their preferred source checks."],
        },
      }
    : handoff);
  conservativeHandoffs.push({
    from_node: "normalize_reproduction",
    port: "reviewed",
    content: {
      reviewer_id: "reproduction",
      tested_revision: report.tested_revision,
      issue_match: "exact",
      reproduction: "not_reproduced",
    },
  });
  assert.deepEqual(semanticFailures("issue-diagnosis", conservativeHandoffs), []);
  handoffs[2].content = { ...report, outcome: "confirmed" };
  assert.match(semanticFailures("issue-diagnosis", handoffs).join(";"), /safe negative or conservative outcome/);
  handoffs[2].content = {
    ...report,
    consensus: { ...report.consensus, decision: "majority" },
  };
  assert.deepEqual(semanticFailures("issue-diagnosis", handoffs), []);
  handoffs[2].content = {
    ...report,
    consensus: { ...report.consensus, decision: "disputed" },
  };
  assert.deepEqual(semanticFailures("issue-diagnosis", handoffs), []);
  handoffs[2].content = report;
  handoffs[2].content = { ...report, tested_revision: "main" };
  assert.match(semanticFailures("issue-diagnosis", handoffs).join(";"), /exact requested full commit revision/);
  handoffs[2].content = report;
  handoffs[6].content = { ...verification, verdict: "fail" };
  assert.match(semanticFailures("issue-diagnosis", handoffs).join(";"), /verification/);
});

test("requires adjacent Manager-owned ratchet measurements", () => {
  const handoffs = [
    { from_node: "target_gate", port: "improve", content: {} },
    { from_node: "target_gate", port: "improve", content: {} },
    { from_node: "compare_measurements", port: "ready", content: { values: [{ ok: true, value: 2, input: { iteration: 1 } }, { ok: true, value: 1, input: { measure_command: ["node"] } }] } },
    { from_node: "compare_measurements", port: "ready", content: { values: [{ ok: true, value: 1, input: { iteration: 2 } }, { ok: true, value: 0, input: { measure_command: ["node"] } }] } },
    { from_node: "monotonic_gate", port: "passed", content: { value: 1 } },
    { from_node: "monotonic_gate", port: "passed", content: { value: 0 } },
    { from_node: "target_gate", port: "reached", content: { input: { value: 0 } } },
    { from_node: "enroll_floor", port: "enrolled", content: {} },
  ];
  assert.deepEqual(semanticFailures("ratchet", handoffs, { state_record: { value: 0 } }), []);
  handoffs[3].content = { values: [{ ok: true, value: 2, input: { iteration: 2 } }, { ok: true, value: 0, input: { measure_command: ["node"] } }] };
  assert.match(semanticFailures("ratchet", handoffs, { state_record: { value: 0 } }).join(";"), /adjacent comparison/);
});
