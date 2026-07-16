import { clearDagActorDispatchExclusion } from "../persistence/dag-actor-interventions.js";

export type DispatchState = "provisioning" | "dispatched" | "failed";

export interface DispatchTarget {
  state: DispatchState;
  targetType?: "worker" | "node";
  targetId?: string;
  dispatchedAt: number;
}

const dispatches = new Map<string, DispatchTarget>();
const exclusions = new Map<string, { targetType: "worker" | "node"; targetId: string }>();

function key(runId: string, nodeId: string): string {
  return `${runId}:${nodeId}`;
}

export function recordDispatch(
  runId: string,
  nodeId: string,
  targetType: "worker" | "node",
  targetId: string,
): void {
  dispatches.set(key(runId, nodeId), {
    state: "dispatched",
    targetType,
    targetId,
    dispatchedAt: Date.now(),
  });
  exclusions.delete(key(runId, nodeId));
  clearDagActorDispatchExclusion({ run_id: runId, node_id: nodeId });
}

export function recordProvisioning(runId: string, nodeId: string): void {
  dispatches.set(key(runId, nodeId), {
    state: "provisioning",
    dispatchedAt: Date.now(),
  });
}

export function recordDispatchFailed(runId: string, nodeId: string): void {
  dispatches.set(key(runId, nodeId), {
    state: "failed",
    dispatchedAt: Date.now(),
  });
}

export function isProvisioning(runId: string, nodeId: string): boolean {
  const entry = dispatches.get(key(runId, nodeId));
  return entry?.state === "provisioning";
}

export function findDispatchTarget(
  runId: string,
  nodeId: string,
): DispatchTarget | undefined {
  return dispatches.get(key(runId, nodeId));
}

export function findDispatchExclusion(
  runId: string,
  nodeId: string,
): { targetType: "worker" | "node"; targetId: string } | undefined {
  return exclusions.get(key(runId, nodeId));
}

export function restoreDispatchExclusion(
  runId: string,
  nodeId: string,
  targetType: "worker" | "node",
  targetId: string,
): void {
  exclusions.set(key(runId, nodeId), { targetType, targetId });
}

/** Fence the current physical target for the next dispatch without exposing it to callers. */
export function excludeCurrentDispatchTarget(
  runId: string,
  nodeId: string,
): DispatchTarget | undefined {
  const dispatchKey = key(runId, nodeId);
  const current = dispatches.get(dispatchKey);
  if (current?.state === "dispatched" && current.targetType && current.targetId) {
    exclusions.set(dispatchKey, { targetType: current.targetType, targetId: current.targetId });
  }
  dispatches.delete(dispatchKey);
  return current;
}

/** Bind an inbound transport message to the exact target selected at dispatch. */
export function isCurrentDispatchTarget(
  runId: string,
  nodeId: string,
  targetType: "worker" | "node",
  targetId: string,
): boolean {
  const target = findDispatchTarget(runId, nodeId);
  return target?.state === "dispatched"
    && target.targetType === targetType
    && target.targetId === targetId;
}

export function clearDispatchTarget(runId: string, nodeId: string): void {
  dispatches.delete(key(runId, nodeId));
  exclusions.delete(key(runId, nodeId));
  clearDagActorDispatchExclusion({ run_id: runId, node_id: nodeId });
}

export function clearByTargetId(targetId: string): void {
  for (const [k, target] of dispatches.entries()) {
    if (target.targetId && target.targetId === targetId) {
      dispatches.delete(k);
    }
  }
}

export function _clearAllDispatches(): void {
  dispatches.clear();
  exclusions.clear();
}
