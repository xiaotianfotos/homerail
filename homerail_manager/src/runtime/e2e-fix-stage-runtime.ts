import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { getDb } from "../persistence/db.js";

export interface E2eFixReviewRecoveryRequest {
  request_id: string; expected_state_sha256: string; reason: string;
  task_directory: string; runtime_directory: string; runtime_sha256: string;
}
export interface E2eFixReviewRecoveryRecord {
  run_id: string; policy_sha256: string; request_json: string; before_json: string; receipt_json: string;
}
export function getE2eFixReviewRecovery(runId: string): E2eFixReviewRecoveryRecord | undefined {
  return getDb().prepare("SELECT * FROM dag_e2e_fix_review_recoveries WHERE run_id = ?").get(runId) as E2eFixReviewRecoveryRecord | undefined;
}
export function reviewRecoveryArgv(request: E2eFixReviewRecoveryRequest): string[] {
  return [path.join(request.runtime_directory, "node"), path.join(request.runtime_directory, "bootstrap.mjs"),
    request.runtime_sha256, request.task_directory, "review_evidence"];
}

/** The original policy and all other role runtimes remain frozen. Only the
 * explicitly recorded, host-authorized review aggregation command may change. */
export function assertE2eFixStageRuntime(directory: string, stage: string,
  config: { root_run_id: string; runtime_sha256?: string }, policyDigest: string, argv: string[]): void {
  if (!config.runtime_sha256 || config.runtime_sha256 === process.env.HOMERAIL_E2E_FIX_RUNTIME_SHA256) return;
  const record = stage === "review_evidence" && getE2eFixReviewRecovery(config.root_run_id);
  const request: E2eFixReviewRecoveryRequest | undefined = record ? JSON.parse(record.request_json) : undefined;
  if (!record || !request || record.policy_sha256 !== policyDigest || request.task_directory !== directory
    || request.runtime_sha256 !== process.env.HOMERAIL_E2E_FIX_RUNTIME_SHA256
    || !isDeepStrictEqual(argv, reviewRecoveryArgv(request))) throw new Error("task runtime identity mismatch");
}
