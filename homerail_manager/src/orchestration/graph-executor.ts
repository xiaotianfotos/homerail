import type { DAGDispatcher } from "./dag-dispatcher.js";
import type { ParsedDAG } from "./graph.js";
import type { ActiveRun } from "../runtime/active-runs.js";
import type { DagRunInputBinding } from "homerail-protocol";
import {
  createActiveRun,
  dispatchReadyNodesUntilStable,
  getActiveRun,
} from "../runtime/active-runs.js";
import { isRunTerminal } from "./dag-engine.js";

export class GraphExecutor {
  constructor(private dispatcher: DAGDispatcher) {}

  createRun(
    runId: string,
    parsedDAG: ParsedDAG,
    initialPrompt?: string,
    inputArtifacts?: DagRunInputBinding[],
  ): ActiveRun {
    return createActiveRun(runId, parsedDAG, { initialPrompt, inputArtifacts });
  }

  tick(runId: string): number {
    return dispatchReadyNodesUntilStable(runId, this.dispatcher);
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
