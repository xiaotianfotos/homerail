import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { closeDb, getDb } from "../src/persistence/db.js";
import { upsertDagSessionIndex } from "../src/persistence/dag-session-index.js";
import { _clearAllChanges, _clearAllProjects } from "../src/persistence/projects-changes.js";
import { createServer } from "../src/server/http.js";

async function listen(server: http.Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const addr = server.address();
  if (!addr || typeof addr !== "object") throw new Error("server did not bind");
  return addr.port;
}

async function close(server: http.Server): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

describe("project settings API contract", () => {
  let server: http.Server;
  let tmpHome: string;
  let workspaceDir: string;
  let oldHome: string | undefined;

  beforeEach(() => {
    oldHome = process.env.HOMERAIL_HOME;
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "homerail-project-contract-"));
    workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "homerail-project-workspace-"));
    process.env.HOMERAIL_HOME = tmpHome;
    _clearAllProjects();
    _clearAllChanges();
    server = createServer(0, undefined, undefined, false);
  });

  afterEach(async () => {
    _clearAllProjects();
    _clearAllChanges();
    await close(server);
    if (oldHome === undefined) delete process.env.HOMERAIL_HOME;
    else process.env.HOMERAIL_HOME = oldHome;
    closeDb();
    fs.rmSync(tmpHome, { recursive: true, force: true });
    fs.rmSync(workspaceDir, { recursive: true, force: true });
  });

  it("supports update, storage listing, safe directory browse, and delete", async () => {
    const port = await listen(server);
    const created = await fetch(`http://127.0.0.1:${port}/api/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "OSS", workspace_path: workspaceDir }),
    });
    const createdBody = await created.json() as { data: { id: string } };
    const projectId = createdBody.data.id;

    const updated = await fetch(`http://127.0.0.1:${port}/api/projects/${projectId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ description: "Public release", git_repository: "HomeRail" }),
    });
    const updatedBody = await updated.json() as { success: boolean; data: { description: string; git_repository: string } };
    expect(updated.status).toBe(200);
    expect(updatedBody.success).toBe(true);
    expect(updatedBody.data.description).toBe("Public release");
    expect(updatedBody.data.git_repository).toBe("HomeRail");

    const updatedGitAlias = await fetch(`http://127.0.0.1:${port}/api/projects/${projectId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ git_server_id: "gitea-main", git_owner: "your-org", git_repo_name: "HomeRail" }),
    });
    const updatedGitAliasBody = await updatedGitAlias.json() as {
      success: boolean;
      data: { git_server_id: string; git_repository: string; git_repo_name: string };
    };
    expect(updatedGitAlias.status).toBe(200);
    expect(updatedGitAliasBody.success).toBe(true);
    expect(updatedGitAliasBody.data.git_server_id).toBe("gitea-main");
    expect(updatedGitAliasBody.data.git_repository).toBe("your-org/HomeRail");
    expect(updatedGitAliasBody.data.git_repo_name).toBe("your-org/HomeRail");

    const storages = await fetch(`http://127.0.0.1:${port}/api/projects/${projectId}/storages`);
    const storagesBody = await storages.json() as { success: boolean; data: { storages: Array<{ id: string; path?: string }> } };
    expect(storages.status).toBe(200);
    expect(storagesBody.data.storages[0].path).toBe(workspaceDir);

    const defaultWorkspace = path.join(tmpHome, "workspace", "default");
    expect(fs.existsSync(defaultWorkspace)).toBe(false);
    const roots = await fetch(`http://127.0.0.1:${port}/api/projects/directories/roots`);
    const rootsBody = await roots.json() as {
      success: boolean;
      data: {
        servers: Array<{ id: string; can_browse: boolean }>;
        roots: Array<{ id: string; name: string; path: string; writable: boolean }>;
        default_path: string;
      };
    };
    expect(roots.status).toBe(200);
    expect(rootsBody.data.servers).toEqual([
      expect.objectContaining({ id: "manager", can_browse: true }),
    ]);
    expect(rootsBody.data.default_path).toBe(path.resolve(os.homedir()));
    expect(rootsBody.data.roots).toEqual([
      expect.objectContaining({
        id: `project:${projectId}`,
        name: "OSS",
        path: workspaceDir,
        writable: true,
      }),
    ]);
    expect(fs.existsSync(defaultWorkspace)).toBe(false);

    const defaultBrowse = await fetch(`http://127.0.0.1:${port}/api/projects/directories/browse`);
    const defaultBrowseBody = await defaultBrowse.json() as { data: { path: string } };
    expect(defaultBrowse.status).toBe(200);
    expect(defaultBrowseBody.data.path).toBe(path.resolve(os.homedir()));

    fs.writeFileSync(path.join(workspaceDir, "README.md"), "ok");
    const browse = await fetch(`http://127.0.0.1:${port}/api/projects/directories/browse?path=${encodeURIComponent(workspaceDir)}`);
    const browseBody = await browse.json() as { success: boolean; data: { entries: Array<{ name: string; type: string }> } };
    expect(browse.status).toBe(200);
    expect(browseBody.data.entries).toContainEqual(expect.objectContaining({ name: "README.md", type: "file" }));

    const deleted = await fetch(`http://127.0.0.1:${port}/api/projects/${projectId}`, { method: "DELETE" });
    const deletedBody = await deleted.json() as { success: boolean; data: { id: string; summary: Record<string, unknown> } };
    expect(deleted.status).toBe(200);
    expect(deletedBody.success).toBe(true);
    expect(deletedBody.data.id).toBe(projectId);
    expect(deletedBody.data.summary).toMatchObject({
      removed_project_reference: true,
      removed_local_directory: false,
      removed_sessions: false,
      removed_dag_workspace: false,
    });
    expect(fs.existsSync(path.join(workspaceDir, "README.md"))).toBe(true);
  });

  it("deletes only the project reference and preserves linked work and sessions", async () => {
    const port = await listen(server);
    const created = await fetch(`http://127.0.0.1:${port}/api/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Linked", workspace_path: workspaceDir }),
    });
    const projectId = ((await created.json()) as { data: { id: string } }).data.id;
    const createdChange = await fetch(`http://127.0.0.1:${port}/api/projects/${projectId}/changes`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "linked work" }),
    });
    expect(createdChange.status).toBe(201);

    const now = new Date().toISOString();
    const db = getDb();
    db.prepare(`
      INSERT INTO sessions(id, session_id, session_type, project_id, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run("session-row-1", "session-1", "manager_chat", projectId, "active", now, now);
    db.prepare(`
      INSERT INTO session_messages(id, session_id, sequence, message_type, content, timestamp)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run("message-1", "session-1", 0, "text", "hello", now);
    db.prepare(`
      INSERT INTO agent_sessions(session_id, project_id, updated_at, data)
      VALUES (?, ?, ?, ?)
    `).run("agent-session-1", projectId, now, JSON.stringify({ session_id: "agent-session-1", project_id: projectId }));
    db.prepare(`
      INSERT INTO voice_agent_sessions(session_id, project_id, updated_at, data)
      VALUES (?, ?, ?, ?)
    `).run("voice-session-1", projectId, now, JSON.stringify({ session_id: "voice-session-1", project_id: projectId }));
    upsertDagSessionIndex({
      run_id: "dag-run-1",
      node_id: "dag-node-1",
      project_key: projectId,
      session_id: "dag-session-1",
      status: "running",
    });
    fs.writeFileSync(path.join(workspaceDir, "KEEP.md"), "keep");
    const count = (sql: string, value: string) => (db.prepare(sql).get(value) as { n: number }).n;

    const deleted = await fetch(`http://127.0.0.1:${port}/api/projects/${projectId}?cascade=true`, { method: "DELETE" });
    const deletedBody = await deleted.json() as { success: boolean; data: { id: string; summary: Record<string, unknown> } };

    expect(deleted.status).toBe(200);
    expect(deletedBody.success).toBe(true);
    expect(deletedBody.data.id).toBe(projectId);
    expect(deletedBody.data.summary).toMatchObject({
      ignored_cascade_request: true,
      retained_linked_changes: 1,
      removed_local_directory: false,
      removed_sessions: false,
      removed_dag_workspace: false,
    });
    expect(fs.existsSync(path.join(workspaceDir, "KEEP.md"))).toBe(true);
    expect(count("SELECT COUNT(*) AS n FROM projects WHERE id = ?", projectId)).toBe(0);
    expect(count("SELECT COUNT(*) AS n FROM changes WHERE project_id = ?", projectId)).toBe(1);
    expect(count("SELECT COUNT(*) AS n FROM sessions WHERE project_id = ?", projectId)).toBe(2);
    expect(count("SELECT COUNT(*) AS n FROM sessions WHERE session_id = ? AND session_type = 'dag_node'", "dag-session-1")).toBe(1);
    expect(count("SELECT COUNT(*) AS n FROM session_messages WHERE session_id = ?", "session-1")).toBe(1);
    expect(count("SELECT COUNT(*) AS n FROM agent_sessions WHERE project_id = ?", projectId)).toBe(1);
    expect(count("SELECT COUNT(*) AS n FROM voice_agent_sessions WHERE project_id = ?", projectId)).toBe(1);
    expect(count("SELECT COUNT(*) AS n FROM dag_session_index WHERE session_id = ?", "dag-session-1")).toBe(1);
  });
});
