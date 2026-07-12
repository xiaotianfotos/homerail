import * as fs from "node:fs";
import * as path from "node:path";

import { getDefaultWorkspacePath, getHomerailHome } from "../config/env.js";
import { emit } from "../events/bus.js";
import {
  _isCleanupInflight,
  listProvisionedForRun,
} from "../orchestration/provisioned-cleanup.js";
import {
  listPersistedRunIds,
  loadRunMetadata,
  serializeRunMetadata,
  writeRunMetadata,
} from "../persistence/store.js";
import type { DagRunStatus } from "../persistence/status.js";
import type { RunWorkspaceRetention } from "../persistence/types.js";
import { loadWorkspaceRetentionSettings } from "../persistence/workspace-retention-settings.js";
import { getActiveRun } from "./active-runs.js";

const DAY_MS = 24 * 60 * 60 * 1_000;

export interface WorkspaceRetentionPolicy {
  enabled: boolean;
  successMs: number;
  failureMs: number;
  intervalMs: number;
}

export interface WorkspaceCleanupItem {
  run_id: string;
  status: DagRunStatus;
  workspace_path: string;
  eligible: boolean;
  removed: boolean;
  reason?: string;
}

export interface WorkspaceCleanupReport {
  dry_run: boolean;
  scanned: number;
  eligible: number;
  removed: number;
  skipped: number;
  failed: number;
  items: WorkspaceCleanupItem[];
}

function nonNegativeNumber(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return parsed;
}

export function resolveWorkspaceRetentionPolicy(
  env: NodeJS.ProcessEnv = process.env,
): WorkspaceRetentionPolicy {
  const settings = loadWorkspaceRetentionSettings(env);
  return {
    enabled: settings.enabled,
    successMs: settings.success_days * DAY_MS,
    failureMs: settings.failure_days * DAY_MS,
    intervalMs: Math.max(
      60_000,
      nonNegativeNumber(env.HOMERAIL_WORKSPACE_CLEANUP_INTERVAL_MS, 6 * 60 * 60 * 1_000),
    ),
  };
}

export function runWorkspacePath(runId: string): string {
  const root = path.resolve(getHomerailHome(), "workspace");
  const target = path.resolve(root, ...runId.split("/"));
  if (target === root || !target.startsWith(`${root}${path.sep}`)) {
    throw new Error(`Unsafe run workspace path for '${runId}'`);
  }
  return target;
}

export function setRunWorkspacePinned(runId: string, pinned: boolean): RunWorkspaceRetention {
  const metadata = loadRunMetadata(runId);
  if (!metadata) throw new Error(`Run not found: ${runId}`);
  const retention: RunWorkspaceRetention = {
    ...metadata.workspaceRetention,
    pinned,
    updatedAt: Date.now(),
  };
  const active = getActiveRun(runId);
  if (active) {
    active.workspaceRetention = retention;
    writeRunMetadata(runId, serializeRunMetadata(active));
  } else {
    writeRunMetadata(runId, { ...metadata, workspaceRetention: retention });
  }
  emit("dag:workspace_retention_updated", { runId, pinned });
  return retention;
}

function retentionForStatus(status: DagRunStatus, policy: WorkspaceRetentionPolicy): number | undefined {
  if (status === "completed") return policy.successMs;
  if (status === "failed" || status === "cancelled") return policy.failureMs;
  return undefined;
}

function removeWorkspace(target: string): void {
  const stat = fs.lstatSync(target);
  fs.rmSync(target, {
    recursive: stat.isDirectory() && !stat.isSymbolicLink(),
    force: true,
  });
}

function workspaceExists(target: string): boolean {
  try {
    fs.lstatSync(target);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export function cleanupRunWorkspaces(options: {
  dryRun?: boolean;
  now?: number;
  policy?: WorkspaceRetentionPolicy;
} = {}): WorkspaceCleanupReport {
  const dryRun = options.dryRun ?? true;
  const now = options.now ?? Date.now();
  const policy = options.policy ?? resolveWorkspaceRetentionPolicy();
  const items: WorkspaceCleanupItem[] = [];
  if (!policy.enabled) {
    return { dry_run: dryRun, scanned: 0, eligible: 0, removed: 0, skipped: 0, failed: 0, items };
  }

  for (const runId of listPersistedRunIds()) {
    const metadata = loadRunMetadata(runId);
    if (!metadata) continue;
    let workspacePath: string;
    try {
      workspacePath = runWorkspacePath(runId);
    } catch (error) {
      items.push({
        run_id: runId,
        status: metadata.status,
        workspace_path: "",
        eligible: false,
        removed: false,
        reason: error instanceof Error ? error.message : String(error),
      });
      continue;
    }
    const item: WorkspaceCleanupItem = {
      run_id: runId,
      status: metadata.status,
      workspace_path: workspacePath,
      eligible: false,
      removed: false,
    };
    items.push(item);
    if (workspacePath === path.resolve(getDefaultWorkspacePath())) {
      item.reason = "reserved_default_workspace";
      continue;
    }
    if (getActiveRun(runId)) {
      item.reason = "run_active_in_memory";
      continue;
    }
    const retentionMs = retentionForStatus(metadata.status, policy);
    if (retentionMs === undefined) {
      item.reason = "run_not_terminal";
      continue;
    }
    if (metadata.workspaceRetention?.pinned) {
      item.reason = "pinned";
      continue;
    }
    if (metadata.completedAt === undefined) {
      item.reason = "missing_completed_at";
      continue;
    }
    if (now - metadata.completedAt < retentionMs) {
      item.reason = "retention_not_expired";
      continue;
    }
    if (_isCleanupInflight(runId) || listProvisionedForRun(runId).length > 0) {
      item.reason = "worker_cleanup_pending";
      continue;
    }
    if (!workspaceExists(workspacePath)) {
      item.reason = "workspace_missing";
      continue;
    }
    item.eligible = true;
    if (dryRun) {
      item.reason = "dry_run";
      continue;
    }
    emit("dag:workspace_cleanup_requested", { runId, workspacePath });
    try {
      removeWorkspace(workspacePath);
      item.removed = true;
      const cleanedAt = Date.now();
      const current = loadRunMetadata(runId);
      if (current) {
        writeRunMetadata(runId, {
          ...current,
          workspaceRetention: {
            ...(current.workspaceRetention ?? { pinned: false, updatedAt: cleanedAt }),
            cleanedAt,
          },
        });
      }
      emit("dag:workspace_cleanup_completed", { runId, workspacePath, cleanedAt });
    } catch (error) {
      item.reason = error instanceof Error ? error.message : String(error);
      emit("dag:workspace_cleanup_failed", { runId, workspacePath, reason: item.reason });
    }
  }

  return {
    dry_run: dryRun,
    scanned: items.length,
    eligible: items.filter((item) => item.eligible).length,
    removed: items.filter((item) => item.removed).length,
    skipped: items.filter((item) => !item.eligible).length,
    failed: items.filter((item) => item.eligible && item.reason !== undefined && item.reason !== "dry_run").length,
    items,
  };
}

export function startWorkspaceCleanupScheduler(
  intervalMs = resolveWorkspaceRetentionPolicy().intervalMs,
): () => void {
  const timer = setInterval(() => {
    try {
      cleanupRunWorkspaces({ dryRun: false });
    } catch (error) {
      console.error(
        `[workspace-retention] Scheduled cleanup failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
