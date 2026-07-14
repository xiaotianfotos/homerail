/**
 * - Settings Storage Info Route.
 *
 * Source Issue: #956
 *
 * Returns real storage location and retention information for
 * persisted runs, sessions, events, and evidence.
 *
 * Read-only endpoint; no mutation.
 */

import * as http from "node:http";
import { getDataRoot, getDbPath, getSessionStoreRoot } from "../config/env.js";
import { listPersistedRunIds } from "../persistence/store.js";
import { sessionsDir } from "../persistence/agent-sessions.js";
import {
  loadWorkspaceRetentionSettings,
  saveWorkspaceRetentionSettings,
  type WorkspaceRetentionSettings,
} from "../persistence/workspace-retention-settings.js";

interface StorageInfoData {
  data_root: string;
  db_path: string;
  runs_count: number;
  sessions_dir: string;
  session_store_root: string;
  retention_supported: boolean;
  cleanup_supported: boolean;
  cleanup_tracked_gap: boolean;
  cleanup_next_action: string;
  workspace_retention: WorkspaceRetentionSettings;
  export_supported: boolean;
  export_tracked_gap: boolean;
  export_next_action: string;
}

function json(res: http.ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

async function readJsonBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => { data += chunk; });
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) as Record<string, unknown> : {});
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

export function settingsStorageInfoHandler(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): boolean {
  const pathname = new URL(req.url || "/", "http://localhost").pathname;
  if (pathname === "/api/settings/workspace-retention" && req.method === "POST") {
    void readJsonBody(req)
      .then((body) => {
        const settings = saveWorkspaceRetentionSettings(body);
        json(res, 200, {
          success: true,
          message: "workspace retention settings updated",
          data: settings,
        });
      })
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        json(res, 400, { success: false, message, error: message });
      });
    return true;
  }
  if (pathname !== "/api/settings/storage-info" || req.method !== "GET") return false;

  const data: StorageInfoData = {
    data_root: getDataRoot(),
    db_path: getDbPath(),
    runs_count: listPersistedRunIds().length,
    sessions_dir: sessionsDir(),
    session_store_root: getSessionStoreRoot(),
    retention_supported: true,
    cleanup_supported: true,
    cleanup_tracked_gap: false,
    cleanup_next_action: "",
    workspace_retention: loadWorkspaceRetentionSettings(),
    export_supported: false,
    export_tracked_gap: true,
    export_next_action:
      "Implement run evidence export API in TS Manager backend",
  };

  json(res, 200, {
    success: true,
    message: "settings storage-info retrieved",
    data,
  });

  return true;
}
