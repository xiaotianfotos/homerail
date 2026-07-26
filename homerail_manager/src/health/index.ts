import * as os from "node:os";
import { MANAGER_RUNTIME_VERSION } from "../runtime-version.js";

const startTime = Date.now();

/**
 * Cold-recovery gate. Until `markRecoveryComplete()` runs at startup, the
 * process is replaying persisted runs into memory and is not ready to accept
 * new create-run traffic. `/health` reports `recovering` (still HTTP 200 so a
 * liveness probe keeps the process alive) so a readiness probe or load
 * balancer can withhold traffic until recovery finishes.
 */
let recoveryComplete = false;

export function markRecoveryComplete(): void {
  recoveryComplete = true;
}

export function _resetRecoveryGateForTest(): void {
  recoveryComplete = false;
}

export function healthHandler(port: number) {
  const uptimeSeconds = Math.floor((Date.now() - startTime) / 1000);
  return {
    status: recoveryComplete ? "ok" : "recovering",
    runtime: "homerail_manager",
    port,
    uptime: uptimeSeconds,
  };
}

export function versionHandler() {
  return {
    version: MANAGER_RUNTIME_VERSION,
    runtime: "typescript",
    commit: process.env.GIT_COMMIT || "unknown",
  };
}
