export const DEFAULT_DAG_WORKER_IDLE_TTL_MS = 5 * 60_000;
export const DEFAULT_DAG_ACTOR_RETENTION_TTL_MS = 7 * 24 * 60 * 60_000;

export const MIN_DAG_ACTOR_TTL_MS = 1;
export const MAX_DAG_WORKER_IDLE_TTL_MS = 7 * 24 * 60 * 60_000;
export const MAX_DAG_ACTOR_RETENTION_TTL_MS = 3_650 * 24 * 60 * 60_000;

export interface DagActorLeaseSettings {
  worker_idle_ttl_ms: number;
  actor_retention_ttl_ms: number;
}

function validateTtl(value: number, name: string, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < MIN_DAG_ACTOR_TTL_MS || value > maximum) {
    throw new Error(
      `${name} must be a safe integer between ${MIN_DAG_ACTOR_TTL_MS} and ${maximum} milliseconds`,
    );
  }
  return value;
}

function parseEnvironmentTtl(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  maximum: number,
): number {
  const raw = env[name];
  if (raw === undefined) return fallback;
  const normalized = raw.trim();
  if (!/^\d+$/.test(normalized)) {
    throw new Error(`${name} must be a base-10 integer number of milliseconds`);
  }
  return validateTtl(Number(normalized), name, maximum);
}

export function validateDagWorkerIdleTtlMs(value: number): number {
  return validateTtl(value, "worker_idle_ttl_ms", MAX_DAG_WORKER_IDLE_TTL_MS);
}

export function validateDagActorRetentionTtlMs(value: number): number {
  return validateTtl(value, "actor_retention_ttl_ms", MAX_DAG_ACTOR_RETENTION_TTL_MS);
}

export function loadDagActorLeaseSettings(
  env: NodeJS.ProcessEnv = process.env,
): DagActorLeaseSettings {
  return {
    worker_idle_ttl_ms: parseEnvironmentTtl(
      env,
      "HOMERAIL_DAG_WORKER_IDLE_TTL_MS",
      DEFAULT_DAG_WORKER_IDLE_TTL_MS,
      MAX_DAG_WORKER_IDLE_TTL_MS,
    ),
    actor_retention_ttl_ms: parseEnvironmentTtl(
      env,
      "HOMERAIL_DAG_ACTOR_RETENTION_TTL_MS",
      DEFAULT_DAG_ACTOR_RETENTION_TTL_MS,
      MAX_DAG_ACTOR_RETENTION_TTL_MS,
    ),
  };
}
