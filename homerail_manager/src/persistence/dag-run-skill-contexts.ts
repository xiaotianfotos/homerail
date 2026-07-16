import {
  DAG_WORKER_SKILL_RUN_MAX_BYTES,
  encodeDagWorkerSkillContextV1,
  parseDagWorkerSkillContextV1,
  summarizeDagWorkerSkillContextV1,
  type DagWorkerSkillContextSummaryV1,
  type DagWorkerSkillContextV1,
} from "homerail-protocol";

import { getDb } from "./db.js";

interface DagRunSkillContextRow {
  run_id: string;
  agent_id: string;
  context_version: number;
  context_digest: string;
  total_bytes: number;
  skill_count: number;
  context_json: string;
  created_at: number;
}

export interface DagRunSkillContextRecord {
  run_id: string;
  agent_id: string;
  context: DagWorkerSkillContextV1;
  created_at: number;
}

export class DagRunSkillContextConflictError extends Error {
  constructor(
    public readonly runId: string,
    public readonly agentId: string,
    message: string,
  ) {
    super(message);
    this.name = "DagRunSkillContextConflictError";
  }
}

function assertIdentifier(value: string, label: string): string {
  if (
    typeof value !== "string"
    || value.length < 1
    || value.length > 256
    || value.trim() !== value
    || value.includes("\0")
  ) {
    throw new Error(`${label} must be between 1 and 256 characters without surrounding whitespace or NUL bytes`);
  }
  return value;
}

function contextFromRow(row: DagRunSkillContextRow): DagRunSkillContextRecord {
  let decoded: unknown;
  try {
    decoded = JSON.parse(row.context_json);
  } catch {
    throw new Error(`DAG Skill Context ${row.run_id}/${row.agent_id} has invalid context_json`);
  }
  const context = parseDagWorkerSkillContextV1(decoded);
  if (
    row.context_version !== context.context_version
    || row.context_digest !== context.context_digest
    || row.total_bytes !== context.total_bytes
    || row.skill_count !== context.skills.length
    || row.context_json !== encodeDagWorkerSkillContextV1(context)
  ) {
    throw new Error(`DAG Skill Context ${row.run_id}/${row.agent_id} has inconsistent persisted metadata`);
  }
  return {
    run_id: row.run_id,
    agent_id: row.agent_id,
    context,
    created_at: Number(row.created_at),
  };
}

function getRow(runId: string, agentId: string): DagRunSkillContextRow | undefined {
  return getDb().prepare(`
    SELECT run_id, agent_id, context_version, context_digest, total_bytes,
           skill_count, context_json, created_at
    FROM dag_run_skill_contexts
    WHERE run_id = ? AND agent_id = ?
  `).get(runId, agentId) as DagRunSkillContextRow | undefined;
}

export function pinDagRunSkillContext(input: {
  run_id: string;
  agent_id: string;
  context: DagWorkerSkillContextV1;
  created_at?: number;
}): DagRunSkillContextRecord {
  const runId = assertIdentifier(input.run_id, "run_id");
  const agentId = assertIdentifier(input.agent_id, "agent_id");
  const context = parseDagWorkerSkillContextV1(input.context);
  const contextJson = encodeDagWorkerSkillContextV1(context);
  const createdAt = input.created_at ?? Date.now();
  if (!Number.isSafeInteger(createdAt) || createdAt < 0) {
    throw new Error("created_at must be a non-negative epoch millisecond integer");
  }

  const existingRow = getRow(runId, agentId);
  if (existingRow) {
    const existing = contextFromRow(existingRow);
    if (
      existing.context.context_digest !== context.context_digest
      || encodeDagWorkerSkillContextV1(existing.context) !== contextJson
    ) {
      throw new DagRunSkillContextConflictError(
        runId,
        agentId,
        `DAG run ${runId} agent ${agentId} cannot replace pinned Skill Context ${existing.context.context_digest} with ${context.context_digest}`,
      );
    }
    return existing;
  }

  const currentBytes = Number((getDb().prepare(`
    SELECT COALESCE(SUM(total_bytes), 0) AS total_bytes
    FROM dag_run_skill_contexts
    WHERE run_id = ?
  `).get(runId) as { total_bytes: number }).total_bytes);
  if (currentBytes + context.total_bytes > DAG_WORKER_SKILL_RUN_MAX_BYTES) {
    throw new DagRunSkillContextConflictError(
      runId,
      agentId,
      `DAG run ${runId} Skill Context total exceeds ${DAG_WORKER_SKILL_RUN_MAX_BYTES} UTF-8 bytes`,
    );
  }

  getDb().prepare(`
    INSERT INTO dag_run_skill_contexts(
      run_id, agent_id, context_version, context_digest, total_bytes,
      skill_count, context_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    runId,
    agentId,
    context.context_version,
    context.context_digest,
    context.total_bytes,
    context.skills.length,
    contextJson,
    createdAt,
  );
  return contextFromRow(getRow(runId, agentId)!);
}

export function pinDagRunSkillContexts(input: {
  run_id: string;
  contexts: Readonly<Record<string, DagWorkerSkillContextV1>>;
  created_at?: number;
}): DagRunSkillContextRecord[] {
  const runId = assertIdentifier(input.run_id, "run_id");
  const entries = Object.entries(input.contexts).sort(([left], [right]) => left.localeCompare(right));
  return getDb().transaction(() => entries.map(([agentId, context]) => pinDagRunSkillContext({
    run_id: runId,
    agent_id: agentId,
    context,
    ...(input.created_at === undefined ? {} : { created_at: input.created_at }),
  })))();
}

export function getDagRunSkillContext(
  runIdInput: string,
  agentIdInput: string,
): DagRunSkillContextRecord | undefined {
  const runId = assertIdentifier(runIdInput, "run_id");
  const agentId = assertIdentifier(agentIdInput, "agent_id");
  const row = getRow(runId, agentId);
  return row ? contextFromRow(row) : undefined;
}

export function listDagRunSkillContexts(runIdInput: string): DagRunSkillContextRecord[] {
  const runId = assertIdentifier(runIdInput, "run_id");
  return (getDb().prepare(`
    SELECT run_id, agent_id, context_version, context_digest, total_bytes,
           skill_count, context_json, created_at
    FROM dag_run_skill_contexts
    WHERE run_id = ?
    ORDER BY agent_id
  `).all(runId) as DagRunSkillContextRow[]).map(contextFromRow);
}

export function getDagRunSkillContextSummary(
  runId: string,
  agentId: string,
): DagWorkerSkillContextSummaryV1 | undefined {
  const record = getDagRunSkillContext(runId, agentId);
  return record ? summarizeDagWorkerSkillContextV1(record.context) : undefined;
}
