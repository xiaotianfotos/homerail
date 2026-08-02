import type { DagRunStatus } from "../persistence/status.js";

const TERMINAL_DAG_RUN_STATUSES: ReadonlySet<DagRunStatus> = new Set([
  "completed",
  "failed",
  "cancelled",
]);

/**
 * Returns true when a DAG run has reached a terminal status. Terminal
 * classification is separate from execution health: a failed run is terminal
 * but not healthy.
 */
export function isTerminalDagRunStatus(status: string): boolean {
  return TERMINAL_DAG_RUN_STATUSES.has(status as DagRunStatus);
}
