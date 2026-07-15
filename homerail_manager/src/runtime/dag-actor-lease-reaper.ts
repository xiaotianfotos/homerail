import { emit } from "../events/bus.js";
import {
  acquireDagActorLease,
  deleteExpiredDagActorRuntime,
  getDagActorLease,
  listDagProvisionedWorkers,
  listExpiredDagActorLeases,
  releaseDagActorLease,
} from "../persistence/dag-actor-leases.js";
import { listDagActors } from "../persistence/dag-actors.js";
import { listPersistedRunIds, loadRunMetadata } from "../persistence/store.js";
import type { DagRunStatus } from "../persistence/status.js";
import { loadDagActorLeaseSettings } from "../config/dag-actor-lease-settings.js";
import {
  deprovisionProvisionedWorker,
  type DeprovisionOptions,
  type ProvisionedWorkerEntry,
} from "../orchestration/provisioned-cleanup.js";

export const DEFAULT_DAG_ACTOR_LEASE_REAPER_INTERVAL_MS = 1_000;

export interface DagActorLeaseReaperReport {
  renewed: number;
  released: number;
  worker_cleanup_attempted: number;
  worker_cleanup_failed: number;
  runtimes_deleted: number;
}

export interface DagActorLeaseReaperOptions extends DeprovisionOptions {
  now?: number;
  limit?: number;
}

function recordEntry(record: ReturnType<typeof listDagProvisionedWorkers>[number]): ProvisionedWorkerEntry {
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

function runStatus(runId: string): DagRunStatus | undefined {
  return loadRunMetadata(runId)?.status;
}

export async function reapDagActorLeases(
  options: DagActorLeaseReaperOptions = {},
): Promise<DagActorLeaseReaperReport> {
  const now = options.now ?? Date.now();
  const report: DagActorLeaseReaperReport = {
    renewed: 0,
    released: 0,
    worker_cleanup_attempted: 0,
    worker_cleanup_failed: 0,
    runtimes_deleted: 0,
  };

  const renewalThreshold = Math.floor(loadDagActorLeaseSettings().worker_idle_ttl_ms / 2);
  for (const runId of listPersistedRunIds()) {
    if (runStatus(runId) !== "active") continue;
    for (const actor of listDagActors(runId)) {
      const lease = getDagActorLease({ run_id: runId, actor_id: actor.actor_id });
      if (!lease || lease.state !== "leased" || lease.pinned || lease.idle_deadline! - now > renewalThreshold) continue;
      try {
        acquireDagActorLease({
          run_id: lease.run_id,
          actor_id: lease.actor_id,
          target_type: lease.target_type!,
          target_id: lease.target_id!,
          expected_version: lease.version,
          now,
        });
        report.renewed++;
      } catch {
        // A concurrent dispatch or release owns the newer lease state.
      }
    }
  }

  // Retry interrupted cleanup and reclaim any physical Worker that is no
  // longer owned by the actor's current physical lease generation. This also
  // closes the crash window between terminal lease retirement and async
  // container cleanup.
  const pending = listDagProvisionedWorkers({ statuses: ["active", "releasing", "failed"], limit: options.limit });
  for (const worker of pending) {
    if (worker.status === "active") {
      const lease = getDagActorLease({ run_id: worker.run_id, actor_id: worker.actor_id });
      const stillOwned = lease?.state === "leased"
        && lease.lease_generation === worker.lease_generation
        && (lease.target_type === "worker" || lease.target_type === "provisioned_worker")
        && lease.target_id === worker.worker_id;
      if (stillOwned) continue;
    }
    report.worker_cleanup_attempted++;
    if (!await deprovisionProvisionedWorker(recordEntry(worker), options)) report.worker_cleanup_failed++;
  }

  for (const lease of listExpiredDagActorLeases({ now, limit: options.limit })) {
    if (runStatus(lease.run_id) === "active") continue;
    try {
      // This versioned transition is the physical-generation fence. Once it
      // commits, late results from the released worker are no longer current.
      releaseDagActorLease({
        run_id: lease.run_id,
        actor_id: lease.actor_id,
        lease_generation: lease.lease_generation,
        target_type: lease.target_type!,
        target_id: lease.target_id!,
        expected_version: lease.version,
        now,
      });
      report.released++;
      emit("dag:actor_lease_released", {
        runId: lease.run_id,
        actorId: lease.actor_id,
        leaseGeneration: lease.lease_generation,
        reason: "idle_ttl_expired",
      });
    } catch {
      // A concurrent renewal or release won the version race. Its current
      // state is authoritative and must not be overwritten by the reaper.
      continue;
    }

    const workers = listDagProvisionedWorkers({
      run_id: lease.run_id,
      actor_id: lease.actor_id,
      lease_generation: lease.lease_generation,
      statuses: ["active", "releasing", "failed"],
    });
    for (const worker of workers) {
      report.worker_cleanup_attempted++;
      if (!await deprovisionProvisionedWorker(recordEntry(worker), options)) report.worker_cleanup_failed++;
    }
  }

  for (const runId of listPersistedRunIds()) {
    const status = runStatus(runId);
    if (status === "active" || status === "waiting") continue;
    for (const actor of listDagActors(runId)) {
      const lease = getDagActorLease({ run_id: runId, actor_id: actor.actor_id });
      if (!lease || lease.state === "leased" || lease.pinned || lease.retained_until! > now) continue;
      if (deleteExpiredDagActorRuntime({ run_id: runId, actor_id: actor.actor_id, now }).deleted) {
        report.runtimes_deleted++;
      }
    }
  }
  return report;
}

function resolveIntervalMs(env: NodeJS.ProcessEnv): number {
  const raw = env.HOMERAIL_DAG_ACTOR_LEASE_REAPER_INTERVAL_MS;
  if (raw === undefined || raw.trim() === "") return DEFAULT_DAG_ACTOR_LEASE_REAPER_INTERVAL_MS;
  if (!/^\d+$/.test(raw.trim())) return DEFAULT_DAG_ACTOR_LEASE_REAPER_INTERVAL_MS;
  return Math.max(100, Number(raw));
}

export function startDagActorLeaseReaper(
  intervalMs = resolveIntervalMs(process.env),
): () => void {
  let running = false;
  const tick = () => {
    if (running) return;
    running = true;
    void reapDagActorLeases()
      .catch((error) => {
        console.error(
          `[homerail_manager] DAG actor lease reaper failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      })
      .finally(() => { running = false; });
  };
  const timer = setInterval(tick, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
