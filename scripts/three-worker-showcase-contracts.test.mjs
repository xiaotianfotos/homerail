import assert from "node:assert/strict";
import test from "node:test";

import {
  EXPECTED_ACTOR_IDS,
  activityConcurrencyEvidence,
  activityRoundFailures,
  coldResumeGroupFailures,
  dispatchGroupFailures,
  physicalWorkerLifecycleEvidence,
  sanitizeForReport,
  surfaceSemanticTermEvidence,
  surfaceSemanticTermFailures,
  unexpectedTerminalDiagnostic,
  unsafeReportPaths,
} from "./three-worker-showcase-contracts.mjs";

function activity(actorId, type, receivedAt, roundId = "round-1", payload = {}) {
  return {
    seq: receivedAt,
    received_at: receivedAt,
    event: { actor_id: actorId, round_id: roundId, type, payload },
  };
}

function surfaceAnalysis(revision, suffix) {
  return {
    actors: EXPECTED_ACTOR_IDS.map((actorId) => ({
      actor_id: actorId,
      node_id: actorId,
      surface_id: `surface-${actorId}`,
      generation: actorId === "systems_guide" ? 2 : 1,
      surface_revision: revision,
      node_canonical: `${actorId}:${suffix}`,
    })),
  };
}

test("requires every actor Surface to retain the selected mission evidence", () => {
  const analysis = surfaceAnalysis(2, "幻悦蝶 route to 阿努比斯");
  assert.deepEqual(
    surfaceSemanticTermFailures(analysis, ["幻悦蝶", "阿努比斯"]),
    [],
  );
  analysis.actors[0].node_canonical = "generic advice without the original route";
  assert.match(
    surfaceSemanticTermFailures(analysis, ["幻悦蝶", "阿努比斯"]).join("; "),
    /Surface lost required mission evidence/,
  );
  const evidence = surfaceSemanticTermEvidence(analysis, ["幻悦蝶", "阿努比斯"]);
  assert.equal(evidence.required_term_digests.length, 2);
  assert.equal(evidence.actors.find((actor) => actor.actor_id === analysis.actors[0].actor_id)?.matched_required_terms, 0);
  assert.doesNotMatch(JSON.stringify(evidence), /幻悦蝶|阿努比斯/);
});

function dispatchEvidence(count) {
  return {
    actors: EXPECTED_ACTOR_IDS.map((actorId) => ({ actor_id: actorId, dispatch_count: count })),
  };
}

test("proves all three Actor executions overlap before the first terminal event", () => {
  const entries = [
    activity("goal_scout", "started", 10),
    activity("systems_guide", "started", 20),
    activity("session_coach", "started", 30),
    activity("goal_scout", "completed", 40),
    activity("systems_guide", "completed", 50),
    activity("session_coach", "completed", 60),
  ];
  const result = activityConcurrencyEvidence(entries, EXPECTED_ACTOR_IDS, "round-1");

  assert.deepEqual(result.failures, []);
  assert.equal(result.evidence.all_started_before_first_terminal, true);
  assert.equal(result.evidence.overlap_ms, 10);
});

test("rejects a serial Actor execution", () => {
  const entries = [
    activity("goal_scout", "started", 10),
    activity("goal_scout", "completed", 20),
    activity("systems_guide", "started", 30),
    activity("systems_guide", "completed", 40),
    activity("session_coach", "started", 50),
    activity("session_coach", "completed", 60),
  ];
  const result = activityConcurrencyEvidence(entries, EXPECTED_ACTOR_IDS, "round-1");

  assert.match(result.failures.join("; "), /did not overlap/);
  assert.equal(result.evidence.all_started_before_first_terminal, false);
});

test("accepts a corrected Actor attempt when its final terminal activity completed", () => {
  const entries = [
    activity("goal_scout", "started", 10),
    activity("goal_scout", "progress", 20),
    activity("goal_scout", "finding", 30),
    activity("goal_scout", "failed", 40),
    activity("goal_scout", "completed", 50),
  ];

  assert.deepEqual(activityRoundFailures(entries, ["goal_scout"], "round-1"), []);
  entries.push(activity("goal_scout", "failed", 60));
  assert.match(
    activityRoundFailures(entries, ["goal_scout"], "round-1").join("; "),
    /did not finish with completed activity/,
  );
});

test("accepts a result-bearing completion when a real model skips explicit finding activity", () => {
  const entries = [
    activity("goal_scout", "started", 10),
    activity("goal_scout", "progress", 20),
    activity("goal_scout", "completed", 30, "round-1", { summary: "Verified shortest route" }),
  ];

  assert.deepEqual(activityRoundFailures(entries, ["goal_scout"], "round-1"), []);
  entries[2].event.payload = {};
  assert.match(
    activityRoundFailures(entries, ["goal_scout"], "round-1").join("; "),
    /no finding or result-bearing completed activity/,
  );
});

test("allows later supervised rounds to omit optional progress chatter", () => {
  const entries = [
    activity("systems_guide", "started", 10, "round-2"),
    activity("systems_guide", "completed", 20, "round-2", { summary: "Updated verified route" }),
  ];

  assert.deepEqual(
    activityRoundFailures(entries, ["systems_guide"], "round-2", {}, { require_progress: false }),
    [],
  );
  assert.match(
    activityRoundFailures(entries, ["systems_guide"], "round-2").join("; "),
    /no progress activity/,
  );
});

test("proves physical allocation, idle cleanup, and reprovision without leaking identities", () => {
  const rawEvents = EXPECTED_ACTOR_IDS.flatMap((nodeId, index) => [{
    type: "dag:provisioning_completed",
    payload: { nodeId, workerId: `private-worker-${index}`, containerId: `private-container-${index}` },
  }]);
  rawEvents.push(
    {
      type: "dag:actor_lease_released",
      payload: { actorId: "systems_guide", reason: "idle_ttl_expired" },
    },
    {
      type: "dag:cleanup_completed",
      payload: {
        nodeId: "systems_guide",
        workerId: "private-worker-1",
        containerId: "private-container-1",
      },
    },
    {
      type: "dag:provisioning_completed",
      payload: {
        nodeId: "systems_guide",
        workerId: "private-worker-4",
        containerId: "private-container-4",
      },
    },
  );

  const result = physicalWorkerLifecycleEvidence({ raw_events: rawEvents }, {
    expected_node_ids: EXPECTED_ACTOR_IDS,
    minimum_distinct_workers: 3,
    require_idle_release_actor: "systems_guide",
    require_reprovisioned_node_ids: ["systems_guide"],
  });

  assert.deepEqual(result.failures, []);
  assert.deepEqual(result.evidence.reprovisioned_node_ids, ["systems_guide"]);
  assert.deepEqual(unsafeReportPaths(result.evidence), []);
  assert.doesNotMatch(JSON.stringify(result.evidence), /private-worker|private-container/);
});

test("requires every logical Surface and dispatch to advance on group resume", () => {
  const before = surfaceAnalysis(3, "before");
  const after = surfaceAnalysis(4, "after");

  assert.deepEqual(coldResumeGroupFailures(before, after, EXPECTED_ACTOR_IDS), []);
  assert.deepEqual(dispatchGroupFailures(dispatchEvidence(2), dispatchEvidence(3)), []);
  assert.deepEqual(dispatchGroupFailures(dispatchEvidence(2), dispatchEvidence(5)), []);

  after.actors[0].node_canonical = before.actors[0].node_canonical;
  assert.match(coldResumeGroupFailures(before, after).join("; "), /semantic Surface did not change/);
  assert.match(dispatchGroupFailures(dispatchEvidence(2), dispatchEvidence(2)).join("; "), /expected between 1 and 4/);
  assert.match(dispatchGroupFailures(dispatchEvidence(2), dispatchEvidence(7)).join("; "), /expected between 1 and 4/);
});

test("sanitizes credentials and private paths from acceptance evidence", () => {
  const sanitized = sanitizeForReport({
    api_key: "sk-private-value",
    note: "Bearer secret-token at /Users/example/private/file",
    nested: { worker_id: "private-worker", safe: "visible" },
  }, { secrets: ["secret-token"] });

  assert.deepEqual(unsafeReportPaths(sanitized), []);
  assert.equal(sanitized.nested.safe, "visible");
  assert.doesNotMatch(JSON.stringify(sanitized), /sk-private|secret-token|private-worker|\/Users\/example/);
});

test("captures terminal graph diagnostics without model content or physical identities", () => {
  const diagnostic = unexpectedTerminalDiagnostic({
    status: {
      status: "completed",
      current_round: { round_id: "round-1", ordinal: 1, status: "completed" },
      node_states: { goal_scout: "COMPLETED", collect_round: "SKIPPED", wait_for_command: "SKIPPED" },
      counters: {
        dispatches: 3,
        handoffs: 3,
        gateway_results: { collect_round: ["private model response"] },
      },
    },
    rounds: { rounds: [{ round_id: "round-1", ordinal: 1, status: "completed" }] },
    handoffs: {
      handoffs: [{
        roundId: "round-1",
        fromNode: "goal_scout",
        port: "done",
        content: "private model response",
      }],
    },
    actors: {
      actors: [{
        actor_id: "goal_scout",
        role: "Goal Scout",
        actor_state: "completed",
        activity_state: "completed",
        visibility_state: "visible",
        round_targeted: true,
        lease: { state: "leased", pinned: false, idle_deadline: 100 },
        worker_id: "private-worker",
      }],
    },
    surfaces: {
      surface_states: [{ actor_id: "goal_scout", generation_state: "current", superseded_count: 0 }],
    },
    activities: [{ actor_id: "goal_scout", type: "finding", detail: "private finding" }],
    events: {
      events: [
        {
          event_type: "handoff",
          node_id: "goal_scout",
          details: { port: "done", api_key: "sk-private-value", content: "private event content" },
        },
        {
          event_type: "response_handoff_failed",
          node_id: "goal_scout",
          details: { reason: "contract rejected api_key=sk-private-value" },
        },
      ],
      raw_events: [{ payload: { workerId: "private-worker" } }],
    },
  });
  const sanitized = sanitizeForReport(diagnostic);

  assert.equal(sanitized.status, "completed");
  assert.equal(sanitized.handoffs[0].port, "done");
  assert.equal(sanitized.events[0].port, "done");
  assert.equal(sanitized.events[1].reason, "contract rejected api_key=***REDACTED***");
  assert.deepEqual(sanitized.activity_counts, { goal_scout: { finding: 1 } });
  assert.equal(sanitized.counters.gateway_results, undefined);
  assert.deepEqual(unsafeReportPaths(sanitized), []);
  assert.doesNotMatch(JSON.stringify(sanitized), /private model|private event|private finding|private-worker|sk-private/);
});
