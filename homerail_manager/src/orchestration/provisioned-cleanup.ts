import { emit } from "../events/bus.js";
import {
  getDagActorLease,
  listDagProvisionedWorkers,
  registerDagProvisionedWorker,
  transitionDagProvisionedWorker,
  type DagProvisionedWorkerRecord,
} from "../persistence/dag-actor-leases.js";
import { getDagActorByNode } from "../persistence/dag-actors.js";
import {
  deprovisionWorkerContainer,
  type ProvisionerOptions,
} from "../node/worker-provisioner.js";

export interface ProvisionedWorkerEntry {
  runId: string;
  nodeId: string;
  actorId: string;
  leaseGeneration: number;
  workerId: string;
  containerId: string;
  dockerNodeId: string;
  provisionedAt: number;
}

export interface RegisterProvisionedWorkerInput {
  runId: string;
  nodeId: string;
  workerId: string;
  containerId: string;
  dockerNodeId: string;
  actorId?: string;
  leaseGeneration?: number;
}

const inflightCleanups = new Set<string>();
const inflightWorkers = new Set<string>();

function workerKey(entry: Pick<ProvisionedWorkerEntry, "runId" | "actorId" | "leaseGeneration" | "workerId">): string {
  return `${entry.runId}\u0000${entry.actorId}\u0000${entry.leaseGeneration}\u0000${entry.workerId}`;
}

function entryFromRecord(record: DagProvisionedWorkerRecord): ProvisionedWorkerEntry {
  return {
    runId: record.run_id,
    nodeId: record.node_id,
    actorId: record.actor_id,
    leaseGeneration: record.lease_generation,
    workerId: record.worker_id,
    containerId: record.container_id,
    dockerNodeId: record.docker_node_id,
    provisionedAt: record.registered_at,
  };
}

function resolveRegistration(input: RegisterProvisionedWorkerInput): Required<RegisterProvisionedWorkerInput> {
  if (input.actorId !== undefined || input.leaseGeneration !== undefined) {
    if (!input.actorId || input.leaseGeneration === undefined) {
      throw new Error("actorId and leaseGeneration must be provided together for a provisioned worker");
    }
    return input as Required<RegisterProvisionedWorkerInput>;
  }

  // Compatibility for callers that predate lease-aware provisioning. Production
  // dispatches provide actorId and leaseGeneration explicitly.
  const actor = getDagActorByNode(input.runId, input.nodeId);
  if (!actor) throw new Error(`No logical actor for provisioned worker ${input.runId}/${input.nodeId}`);
  const lease = getDagActorLease({ run_id: input.runId, actor_id: actor.actor_id });
  if (!lease || lease.state !== "leased" || lease.target_id !== input.workerId) {
    throw new Error(`No current lease for provisioned worker ${input.runId}/${input.nodeId}/${input.workerId}`);
  }
  return { ...input, actorId: actor.actor_id, leaseGeneration: lease.lease_generation };
}

export function registerProvisionedWorker(input: RegisterProvisionedWorkerInput): ProvisionedWorkerEntry {
  const resolved = resolveRegistration(input);
  return entryFromRecord(registerDagProvisionedWorker({
    run_id: resolved.runId,
    node_id: resolved.nodeId,
    actor_id: resolved.actorId,
    lease_generation: resolved.leaseGeneration,
    worker_id: resolved.workerId,
    container_id: resolved.containerId,
    docker_node_id: resolved.dockerNodeId,
  }));
}

export function listProvisionedForRun(runId: string): ProvisionedWorkerEntry[] {
  return listDagProvisionedWorkers({ run_id: runId }).map(entryFromRecord);
}

/** @deprecated Durable rows are retained until actor retention expiry. */
export function clearProvisionedForRun(_runId: string): void {
  // Intentionally no-op: clearing durable failures would make restart retry impossible.
}

export function _clearAllProvisionedWorkers(): void {
  inflightCleanups.clear();
  inflightWorkers.clear();
}

export function _isCleanupInflight(runId: string): boolean {
  return inflightCleanups.has(runId);
}

export interface DeprovisionOptions {
  deprovisionerOpts?: ProvisionerOptions;
  deprovisionFn?: typeof deprovisionWorkerContainer;
}

async function transitionToReleasing(entry: ProvisionedWorkerEntry): Promise<DagProvisionedWorkerRecord | undefined> {
  const current = listDagProvisionedWorkers({
    run_id: entry.runId,
    actor_id: entry.actorId,
    lease_generation: entry.leaseGeneration,
  }).find((record) => record.worker_id === entry.workerId);
  if (!current || current.status === "released") return undefined;
  if (current.status === "releasing") return current;
  return transitionDagProvisionedWorker({
    run_id: current.run_id,
    actor_id: current.actor_id,
    lease_generation: current.lease_generation,
    worker_id: current.worker_id,
    expected_status: current.status,
    status: "releasing",
    expected_version: current.version,
  });
}

export async function deprovisionProvisionedWorker(
  entry: ProvisionedWorkerEntry,
  options: DeprovisionOptions = {},
  emitRequested = true,
): Promise<boolean> {
  const key = workerKey(entry);
  if (inflightWorkers.has(key)) return false;
  inflightWorkers.add(key);
  if (emitRequested) emit("dag:cleanup_requested", { runId: entry.runId, workerCount: 1 });

  try {
    const releasing = await transitionToReleasing(entry);
    if (!releasing) return false;
    const deprovisionFn = options.deprovisionFn ?? deprovisionWorkerContainer;
    try {
      const result = await deprovisionFn(
        releasing.docker_node_id,
        releasing.container_id,
        options.deprovisionerOpts,
      );
      if (!result.removed && !result.dockerCleanupVerified) {
        throw new Error(
          `Provisioned worker ${releasing.worker_id} cleanup did not confirm container removal`,
        );
      }
      transitionDagProvisionedWorker({
        run_id: releasing.run_id,
        actor_id: releasing.actor_id,
        lease_generation: releasing.lease_generation,
        worker_id: releasing.worker_id,
        expected_status: "releasing",
        status: "released",
        expected_version: releasing.version,
      });
      emit("dag:cleanup_completed", {
        runId: releasing.run_id,
        workerId: releasing.worker_id,
        nodeId: releasing.node_id,
        containerId: releasing.container_id,
        stopped: result.stopped,
        removed: result.removed,
      });
      return true;
    } catch (error) {
      const failure = error instanceof Error ? error.message : String(error);
      const current = listDagProvisionedWorkers({
        run_id: releasing.run_id,
        actor_id: releasing.actor_id,
        lease_generation: releasing.lease_generation,
      }).find((record) => record.worker_id === releasing.worker_id);
      if (current?.status === "releasing") {
        transitionDagProvisionedWorker({
          run_id: current.run_id,
          actor_id: current.actor_id,
          lease_generation: current.lease_generation,
          worker_id: current.worker_id,
          expected_status: "releasing",
          status: "failed",
          expected_version: current.version,
          failure: { message: failure },
        });
      }
      emit("dag:cleanup_failed", {
        runId: releasing.run_id,
        workerId: releasing.worker_id,
        nodeId: releasing.node_id,
        containerId: releasing.container_id,
        reason: failure,
      });
      return false;
    }
  } catch {
    // A concurrent transition changed the durable row. Re-read on the next
    // scheduler pass rather than leaving a fire-and-forget rejection behind.
    return false;
  } finally {
    inflightWorkers.delete(key);
  }
}

/**
 * Trigger async cleanup for every non-terminal durable provisioned worker in a run.
 * The boolean return remains compatible with the former fire-and-forget API.
 */
export function deprovisionProvisionedForRun(
  runId: string,
  options: DeprovisionOptions = {},
): boolean {
  if (inflightCleanups.has(runId)) return false;
  const entries = listDagProvisionedForCleanup(runId);
  if (entries.length === 0) return false;
  inflightCleanups.add(runId);
  emit("dag:cleanup_requested", { runId, workerCount: entries.length });
  void Promise.all(entries.map((entry) => deprovisionProvisionedWorker(entry, options, false)))
    .finally(() => inflightCleanups.delete(runId));
  return true;
}

export function listDagProvisionedForCleanup(runId: string): ProvisionedWorkerEntry[] {
  return listDagProvisionedWorkers({
    run_id: runId,
    statuses: ["active", "releasing", "failed"],
  }).map(entryFromRecord);
}
