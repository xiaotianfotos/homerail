import assert from "node:assert/strict";
import test from "node:test";

import { managerOnlyRestartEvidence } from "./manager-only-restart-evidence.mjs";

test("proves a Manager-only restart without exposing process identities", () => {
  const evidence = managerOnlyRestartEvidence({
    managerPid: 101,
    managerPidRunning: true,
    managerHealthy: true,
    nodePid: 201,
    nodePidRunning: true,
    uiHttpsPid: 301,
    uiHttpsPidRunning: true,
    uiHttpPidRunning: false,
  }, {
    managerPid: 102,
    managerPidRunning: true,
    managerHealthy: true,
    nodePid: 201,
    nodePidRunning: true,
    uiHttpsPid: 301,
    uiHttpsPidRunning: true,
    uiHttpPidRunning: false,
  });

  assert.equal(evidence.passed, true);
  assert.equal(evidence.manager_pid_changed, true);
  assert.equal(evidence.node_pid_preserved, true);
  assert.doesNotMatch(JSON.stringify(evidence), /101|102|201|301/);
});

test("fails when Manager is reused or a preserved service changes", () => {
  const evidence = managerOnlyRestartEvidence({
    managerPid: 101,
    managerPidRunning: true,
    nodePid: 201,
    nodePidRunning: true,
    uiHttpsPidRunning: false,
    uiHttpPidRunning: false,
  }, {
    managerPid: 101,
    managerPidRunning: true,
    managerHealthy: true,
    nodePid: 202,
    nodePidRunning: true,
    uiHttpsPidRunning: false,
    uiHttpPidRunning: false,
  });

  assert.equal(evidence.passed, false);
  assert.equal(evidence.manager_pid_changed, false);
  assert.equal(evidence.node_pid_preserved, false);
});
