import assert from "node:assert/strict";
import test from "node:test";

import { observeRunProgress, runProgressFingerprint } from "./live-run-progress.mjs";

test("run progress fingerprint is stable across object key order", () => {
  const left = runProgressFingerprint({
    status: "active",
    node_states: { verify: "PENDING", execute: "RUNNING" },
    counters: { handoffs: 2, dispatches: 3 },
  });
  const right = runProgressFingerprint({
    counters: { dispatches: 3, handoffs: 2 },
    node_states: { execute: "RUNNING", verify: "PENDING" },
    status: "active",
  });

  assert.equal(left, right);
});

test("only runtime state changes reset the no-progress clock", () => {
  const initial = observeRunProgress(undefined, {
    status: "active",
    node_states: { execute: "RUNNING" },
    counters: { handoffs: 0 },
  }, 1_000);
  const unchanged = observeRunProgress(initial, {
    status: "active",
    node_states: { execute: "RUNNING" },
    counters: { handoffs: 0 },
  }, 5_000);
  const advanced = observeRunProgress(unchanged, {
    status: "active",
    node_states: { execute: "COMPLETED", verify: "RUNNING" },
    counters: { handoffs: 1 },
  }, 7_000);

  assert.equal(unchanged.last_progress_at, 1_000);
  assert.equal(advanced.last_progress_at, 7_000);
  assert.notEqual(advanced.fingerprint, initial.fingerprint);
});
