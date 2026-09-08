import { createHash } from "node:crypto";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { CreateRunRequest } from "./change-orchestrator.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = process.env.HOMERAIL_REPO_ROOT
  ? path.resolve(process.env.HOMERAIL_REPO_ROOT)
  : path.resolve(__dirname, "../../..");

export type RunCreationConflictReason = "request_mismatch" | "legacy_run";

export class RunCreationConflictError extends Error {
  constructor(
    readonly runId: string,
    readonly reason: RunCreationConflictReason,
  ) {
    super(`Run creation conflict for run ${runId}: ${reason}`);
    this.name = "RunCreationConflictError";
  }
}

function _sortKeysDeep(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map(_sortKeysDeep);
  if (typeof value === "object") {
    const sorted: Record<string, unknown> = {};
    const keys = Object.keys(value as Record<string, unknown>).sort();
    for (const key of keys) {
      sorted[key] = _sortKeysDeep((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}

export function creationRequestDigest(request: CreateRunRequest): string {
  const semantic = {
    version: 1,
    yamlPath: request.yamlPath != null ? path.resolve(REPO_ROOT, request.yamlPath) : undefined,
    workflowId: request.workflowId,
    profile: request.profile,
    prompt: request.prompt,
    llmSettingId: request.llmSettingId,
    expectedWorkflowRevision: request.expectedWorkflowRevision,
    expectedCanonicalHash: request.expectedCanonicalHash,
    expectedProfileUpdatedAt: request.expectedProfileUpdatedAt,
    inputScope: request.inputScope,
    inputArtifacts: request.inputArtifacts ?? [],
  };
  const normalized = _sortKeysDeep(semantic);
  const serialized = JSON.stringify(normalized);
  return createHash("sha256").update(serialized).digest("hex");
}
