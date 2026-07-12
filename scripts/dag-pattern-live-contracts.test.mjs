import assert from "node:assert/strict";
import test from "node:test";

import {
  EXPECTED_PATTERN_IDS,
  catalogCoverageFailures,
  parseContent,
  patternParameters,
  prompts,
  semanticFailures,
  semanticRequirements,
} from "./dag-pattern-live-contracts.mjs";

test("covers the complete ten-pattern catalog", () => {
  const catalog = EXPECTED_PATTERN_IDS.map((id) => ({ id, name: id }));
  assert.deepEqual(catalogCoverageFailures(catalog), []);
  assert.equal(Object.keys(prompts).length, 10);
  assert.equal(Object.keys(semanticRequirements).length, 10);
  assert.deepEqual(JSON.parse(prompts["trust-ledger"]).acceptance_criteria, [
    "top-level evidence equals synthetic bounded check completed",
  ]);
});

test("uses current runtime-backed topology contracts", () => {
  assert.deepEqual(semanticRequirements["orchestrator-workers"], [
    { node: "fanout", port: "passed" },
    { node: "verify", port: "verified" },
  ]);
  assert.deepEqual(semanticRequirements.compost.at(-1), { node: "human_review", port: "approved" });
  assert.deepEqual(semanticRequirements["executor-advisor"], [{ node: "execute", port: "done" }]);
  assert.match(prompts.sparring, /test_command/);
  assert.match(prompts.sparring, /src\/live-fix\.txt/);
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
