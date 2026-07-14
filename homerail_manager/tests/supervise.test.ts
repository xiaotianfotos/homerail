import { describe, expect, it } from "vitest";

import type { PersistedRunMetadata } from "../src/persistence/types.js";
import {
  computeSuperviseTick,
  isTerminalDagRunEvent,
  isTerminalDagRunStatus,
} from "../src/server/supervise.js";

function metadata(status: string): PersistedRunMetadata {
  return {
    runId: `run-${status}`,
    createdAt: 1,
    status: status as PersistedRunMetadata["status"],
    nodeStates: { work: status === "completed" ? "COMPLETED" : "READY" },
    handoffedNodes: [],
  };
}

describe("DAG supervise terminal boundaries", () => {
  it.each(["completed", "failed", "cancelled", "expired"])(
    "treats %s as terminal everywhere",
    (status) => {
      expect(isTerminalDagRunStatus(status)).toBe(true);
      expect(computeSuperviseTick(`run-${status}`, metadata(status), [], 0).terminal).toBe(true);
    },
  );

  it.each(["active", "waiting"])("keeps %s non-terminal", (status) => {
    expect(isTerminalDagRunStatus(status)).toBe(false);
    expect(computeSuperviseTick(`run-${status}`, metadata(status), [], 0).terminal).toBe(false);
  });

  it.each([
    "dag:run_completed",
    "dag:run_failed",
    "dag:run_cancelled",
    "dag:run_expired",
  ])("closes SSE on %s", (eventType) => {
    expect(isTerminalDagRunEvent(eventType)).toBe(true);
  });

  it("does not close SSE when a run starts waiting", () => {
    expect(isTerminalDagRunEvent("dag:run_waiting")).toBe(false);
  });
});
