import type { DAGDispatcher } from "./dag-dispatcher.js";
import type { ParsedDAG } from "./graph.js";
import type { ActiveRun } from "../runtime/active-runs.js";
import {
  createActiveRun,
  dispatchReadyNodes,
  getActiveRun,
} from "../runtime/active-runs.js";
import { isRunTerminal } from "./dag-engine.js";

export class GraphExecutor {
  constructor(private dispatcher: DAGDispatcher) {}

  createRun(runId: string, parsedDAG: ParsedDAG, initialPrompt?: string): ActiveRun {
    return createActiveRun(runId, parsedDAG, { initialPrompt });
  }

  tick(runId: string): number {
    const run = getActiveRun(runId);
    if (!run) return 0;
    const maxPasses = Math.max(1, run.dagRun.graph.nodes.length * 2);
    let total = 0;
    for (let pass = 0; pass < maxPasses; pass++) {
      const advanced = dispatchReadyNodes(runId, this.dispatcher);
      total += advanced;
      if (advanced === 0) break;
    }
    return total;
  }

  getRun(runId: string): ActiveRun | undefined {
    return getActiveRun(runId);
  }

  isTerminal(runId: string): boolean {
    const run = getActiveRun(runId);
    if (!run) return false;
    return isRunTerminal(run.dagRun);
  }
}
