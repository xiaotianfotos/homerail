import { getDb } from "./db.js";

export interface WorkflowConcurrencyPolicy {
  overlap: "skip" | "allow";
  max_concurrency: number;
  trigger_ids: string[];
}

export class WorkflowRunAdmissionError extends Error {
  constructor(
    readonly reason: "overlap_policy" | "max_concurrency",
    readonly workflowId: string,
    readonly activeCount: number,
    readonly policy: WorkflowConcurrencyPolicy,
  ) {
    super(
      `Workflow '${workflowId}' rejected a new run: ${reason} `
        + `(active=${activeCount}, max=${policy.max_concurrency}, triggers=${policy.trigger_ids.join(",")})`,
    );
    this.name = "WorkflowRunAdmissionError";
  }
}

type TriggerConfig = {
  overlap: "skip" | "allow";
  max_concurrency: number;
  enabled: boolean;
};

export function deriveWorkflowConcurrencyPolicy(
  triggers: Record<string, TriggerConfig> | undefined,
): WorkflowConcurrencyPolicy | undefined {
  const enabled = Object.entries(triggers ?? {})
    .filter(([, config]) => config.enabled)
    .sort(([left], [right]) => left.localeCompare(right));
  if (enabled.length === 0) return undefined;
  return {
    overlap: enabled.some(([, config]) => config.overlap === "skip") ? "skip" : "allow",
    max_concurrency: Math.min(...enabled.map(([, config]) => config.max_concurrency)),
    trigger_ids: enabled.map(([id]) => id),
  };
}

export function reserveWorkflowRun(input: {
  runId: string;
  workflowId: string;
  source: string;
  policy?: WorkflowConcurrencyPolicy;
}): { reserved: boolean; policy?: WorkflowConcurrencyPolicy } {
  if (!input.policy) return { reserved: false };
  const policy = input.policy;
  const outcome = getDb().transaction((): {
    reserved: true;
    policy: WorkflowConcurrencyPolicy;
  } | {
    reserved: false;
    error: WorkflowRunAdmissionError;
  } => {
    const now = Date.now();
    getDb().prepare(`
      DELETE FROM dag_run_admissions
      WHERE created_at < ?
        OR EXISTS (
          SELECT 1 FROM dag_runs
          WHERE dag_runs.run_id = dag_run_admissions.run_id
        )
    `).run(now - 300_000);
    const activeRuns = Number((getDb().prepare(`
      SELECT COUNT(*) AS count
      FROM dag_runs
      WHERE workflow_id = ? AND status = 'active'
    `).get(input.workflowId) as { count: number }).count);
    const pendingAdmissions = Number((getDb().prepare(`
      SELECT COUNT(*) AS count
      FROM dag_run_admissions AS admission
      WHERE admission.workflow_id = ?
    `).get(input.workflowId) as { count: number }).count);
    const activeCount = activeRuns + pendingAdmissions;
    if (policy.overlap === "skip" && activeCount > 0) {
      return {
        reserved: false,
        error: new WorkflowRunAdmissionError("overlap_policy", input.workflowId, activeCount, policy),
      };
    }
    if (activeCount >= policy.max_concurrency) {
      return {
        reserved: false,
        error: new WorkflowRunAdmissionError("max_concurrency", input.workflowId, activeCount, policy),
      };
    }
    getDb().prepare(`
      INSERT INTO dag_run_admissions(run_id, workflow_id, source, created_at)
      VALUES (?, ?, ?, ?)
    `).run(input.runId, input.workflowId, input.source, now);
    return { reserved: true, policy } as const;
  })();
  if (!outcome.reserved) throw outcome.error;
  return outcome;
}

export function releaseWorkflowRunReservation(runId: string): void {
  getDb().prepare("DELETE FROM dag_run_admissions WHERE run_id = ?").run(runId);
}
