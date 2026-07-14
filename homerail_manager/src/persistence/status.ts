export const PERSISTENCE_STATUS_VALUES = {
  dag_run: ["active", "waiting", "completed", "failed", "cancelled"] as const,
  session: [
    "active",
    "closed",
    "idle",
    "running",
    "done",
    "failed",
    "cancelled",
    "blocked",
    "clarifying",
    "needs_confirmation",
    "waiting_for_confirmation",
    "submitted",
    "interrupted",
  ] as const,
  project: ["active", "paused", "archived", "deleted"] as const,
  change: ["open", "active", "running", "completed", "failed", "cancelled", "archived"] as const,
  change_run: ["created", "pending", "running", "completed", "failed", "cancelled"] as const,
  experience_ingest: ["pending", "running", "completed", "failed", "cancelled"] as const,
  provider: ["active", "paused"] as const,
  node: ["idle", "connected", "disconnected", "active", "busy", "unavailable", "failed"] as const,
  node_session: ["connected", "disconnected", "active", "idle", "failed"] as const,
  worker_container: ["created", "starting", "running", "idle", "completed", "stopped", "failed"] as const,
  storage_node: ["mounted", "unmounted", "connecting", "synced", "stale", "error"] as const,
} as const;

export type PersistenceStatusDomain = keyof typeof PERSISTENCE_STATUS_VALUES;
export type DagRunStatus = typeof PERSISTENCE_STATUS_VALUES.dag_run[number];
export type SessionStatus = typeof PERSISTENCE_STATUS_VALUES.session[number];
export type ProjectStatus = typeof PERSISTENCE_STATUS_VALUES.project[number];
export type ChangeStatus = typeof PERSISTENCE_STATUS_VALUES.change[number];
export type ChangeRunStatus = typeof PERSISTENCE_STATUS_VALUES.change_run[number];
export type ExperienceIngestStatus = typeof PERSISTENCE_STATUS_VALUES.experience_ingest[number];
export type ProviderStatus = typeof PERSISTENCE_STATUS_VALUES.provider[number];
export type NodeStatus = typeof PERSISTENCE_STATUS_VALUES.node[number];
export type NodeSessionStatus = typeof PERSISTENCE_STATUS_VALUES.node_session[number];
export type WorkerContainerStatus = typeof PERSISTENCE_STATUS_VALUES.worker_container[number];
export type StorageNodeStatus = typeof PERSISTENCE_STATUS_VALUES.storage_node[number];

export type PersistenceStatus =
  | DagRunStatus
  | SessionStatus
  | ProjectStatus
  | ChangeStatus
  | ChangeRunStatus
  | ExperienceIngestStatus
  | ProviderStatus
  | NodeStatus
  | NodeSessionStatus
  | WorkerContainerStatus
  | StorageNodeStatus;

export function statusValues(domain: PersistenceStatusDomain): readonly string[] {
  return PERSISTENCE_STATUS_VALUES[domain];
}

export function assertStatus<D extends PersistenceStatusDomain>(
  domain: D,
  value: string,
): asserts value is typeof PERSISTENCE_STATUS_VALUES[D][number] {
  if (!statusValues(domain).includes(value)) {
    throw new Error(`Invalid ${domain} status: ${value}`);
  }
}

export function normalizeStatus<D extends PersistenceStatusDomain>(
  domain: D,
  value: string | undefined | null,
  fallback: typeof PERSISTENCE_STATUS_VALUES[D][number],
): typeof PERSISTENCE_STATUS_VALUES[D][number] {
  const status = value?.trim() || fallback;
  assertStatus(domain, status);
  return status;
}
