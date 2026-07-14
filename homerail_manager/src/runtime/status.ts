import { getAllWorkers } from "../worker/registry.js";
import { getAllNodes } from "../node/registry.js";
import { getActiveRunCount, getWaitingRunCount } from "./active-runs.js";

export function runtimeStatusHandler() {
  const workers = getAllWorkers();
  const nodes = getAllNodes();
  return {
    runtime: "homerail_manager",
    phase: "M10-pre",
    connected_workers: workers.length,
    connected_nodes: nodes.length,
    active_runs: getActiveRunCount(),
    waiting_runs: getWaitingRunCount(),
    worker_ids: workers.map((w) => w.worker_id),
    worker_capabilities: Object.fromEntries(
      workers.map((w) => [w.worker_id, w.capabilities]),
    ),
    node_ids: nodes.map((n) => n.node_id),
    node_capabilities: Object.fromEntries(
      nodes.map((n) => [n.node_id, n.capabilities]),
    ),
  };
}
