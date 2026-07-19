import * as http from "node:http";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  listProjects,
  getProject,
  createProject,
  updateProject,
  deleteProject,
  listProjectStorages,
  listChanges,
  getChange,
  createChange,
  type Project,
} from "../persistence/projects-changes.js";
import {
  listChangeRuns,
  getChangeRun,
  createChangeRun,
  updateChangeRun,
  deleteChangeRun,
  type ChangeRunInput,
} from "../persistence/change-runs.js";

function json(res: http.ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function badRequest(res: http.ServerResponse, message: string) {
  json(res, 400, { success: false, message, error: message });
}

function notFound(res: http.ServerResponse, message: string) {
  json(res, 404, { success: false, message, error: message });
}

function ok(res: http.ServerResponse, message: string, data?: unknown) {
  json(res, 200, { success: true, message, data });
}

function created(res: http.ServerResponse, message: string, data: unknown) {
  json(res, 201, { success: true, message, data });
}

async function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => { data += chunk; });
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

function _idFromSegment(base: string, pathname: string): string | undefined {
  const prefix = `${base}/`;
  if (pathname.startsWith(prefix)) {
    const id = pathname.slice(prefix.length);
    return id && !id.includes("/") ? decodeURIComponent(id) : undefined;
  }
  return undefined;
}

function _projectIdFromNestedPath(pathname: string): string | undefined {
  const prefix = "/api/projects/";
  if (!pathname.startsWith(prefix)) return undefined;
  const rest = pathname.slice(prefix.length);
  const slashIdx = rest.indexOf("/");
  if (slashIdx === -1) return undefined;
  const projectId = rest.slice(0, slashIdx);
  return projectId ? decodeURIComponent(projectId) : undefined;
}

function _nestedChangeRunsPath(pathname: string): string | undefined {
  const match = pathname.match(/^\/api\/changes\/([^/]+)\/runs$/);
  return match ? decodeURIComponent(match[1]) : undefined;
}

function _trimmedString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function _metadata(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function _stringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : undefined;
}

function _gitRepositoryFromBody(body: Record<string, unknown>): string | undefined {
  const explicit =
    _trimmedString(body.git_repository) ??
    _trimmedString(body.gitRepository);
  if (explicit) return explicit;

  const repoName =
    _trimmedString(body.git_repo_name) ??
    _trimmedString(body.gitRepoName);
  if (!repoName) return undefined;

  const owner =
    _trimmedString(body.git_owner) ??
    _trimmedString(body.gitOwner);
  if (owner && !repoName.includes("/")) return `${owner}/${repoName}`;
  return repoName;
}

function _projectForResponse(project: Project): Project & { git_repo_name?: string; git_default_branch?: string } {
  return {
    ...project,
    git_repo_name: project.git_repository,
    git_default_branch: project.git_branch,
  };
}

function _projectInput(body: Record<string, unknown>): {
  name?: string;
  description?: string;
  workspace_path?: string;
  project_root?: string;
  git_server_id?: string;
  git_repository?: string;
  git_branch?: string;
  storage_configurations?: string[];
  metadata?: Record<string, unknown>;
  status?: string;
} {
  const metadata = _metadata(body.metadata) ?? {};
  const workspacePath =
    _trimmedString(body.workspace_path) ??
    _trimmedString(body.workspacePath) ??
    _trimmedString(body.root_path) ??
    _trimmedString(metadata.workspace_path);
  const projectRoot =
    _trimmedString(body.project_root) ??
    _trimmedString(body.projectRoot) ??
    _trimmedString(metadata.project_root);
  return {
    name: _trimmedString(body.name),
    description: typeof body.description === "string" ? body.description : undefined,
    workspace_path: workspacePath,
    project_root: projectRoot,
    git_server_id: _trimmedString(body.git_server_id) ?? _trimmedString(body.gitServerId),
    git_repository: _gitRepositoryFromBody(body),
    git_branch: _trimmedString(body.git_branch) ?? _trimmedString(body.gitBranch),
    storage_configurations: _stringArray(body.storage_configurations) ?? _stringArray(body.storageConfigurations),
    metadata: Object.keys(metadata).length ? metadata : undefined,
    status: _trimmedString(body.status),
  };
}

function _changeRunInput(body: Record<string, unknown>, changeIdOverride?: string): ChangeRunInput {
  const objectField = (value: unknown): Record<string, unknown> | undefined => _metadata(value);
  const phases = Array.isArray(body.phases) ? body.phases : undefined;
  return {
    change_id: changeIdOverride ?? _trimmedString(body.change_id) ?? "",
    project_id: _trimmedString(body.project_id),
    worker_container_id: _trimmedString(body.worker_container_id),
    workspace_id: _trimmedString(body.workspace_id),
    name: _trimmedString(body.name),
    description: typeof body.description === "string" ? body.description : undefined,
    orchestration_id: _trimmedString(body.orchestration_id),
    orchestration_yaml_snapshot: typeof body.orchestration_yaml_snapshot === "string" ? body.orchestration_yaml_snapshot : undefined,
    orchestration_version: _trimmedString(body.orchestration_version),
    run_number: typeof body.run_number === "number" ? body.run_number : undefined,
    git_branch: _trimmedString(body.git_branch),
    worktree_path: _trimmedString(body.worktree_path),
    storage_backend: _trimmedString(body.storage_backend),
    manager_agent_config: objectField(body.manager_agent_config),
    worker_model_config: objectField(body.worker_model_config),
    manager_provider_name: _trimmedString(body.manager_provider_name),
    manager_model_name: _trimmedString(body.manager_model_name),
    worker_provider_name: _trimmedString(body.worker_provider_name),
    worker_model_name: _trimmedString(body.worker_model_name),
    runtime_profile: _trimmedString(body.runtime_profile),
    model_map: objectField(body.model_map),
    status: _trimmedString(body.status),
    current_phase: _trimmedString(body.current_phase),
    phases,
    started_at: _trimmedString(body.started_at),
    completed_at: _trimmedString(body.completed_at),
    result_summary: typeof body.result_summary === "string" ? body.result_summary : undefined,
    error_message: typeof body.error_message === "string" ? body.error_message : undefined,
    metadata: objectField(body.metadata),
  };
}

function _pathIsWritable(targetPath: string): boolean {
  try {
    fs.accessSync(targetPath, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function _defaultDirectoryPath(): string {
  for (const candidate of [os.homedir(), process.cwd()]) {
    try {
      const resolved = path.resolve(candidate);
      if (fs.statSync(resolved).isDirectory()) return resolved;
    } catch {
      // Try the next runtime-derived directory.
    }
  }
  return path.resolve(process.cwd());
}

function _directoryRoots(): Array<{ id: string; name: string; path: string; writable: boolean }> {
  const roots = new Map<string, { id: string; name: string; path: string; writable: boolean }>();
  const add = (id: string, name: string, rawPath?: string) => {
    if (!rawPath) return;
    try {
      const resolved = path.resolve(rawPath.replace(/^~/, os.homedir()));
      if (!fs.statSync(resolved).isDirectory()) return;
      roots.set(resolved, { id, name, path: resolved, writable: _pathIsWritable(resolved) });
    } catch {
      // A deleted or inaccessible project directory is not a usable shortcut.
    }
  };
  for (const project of listProjects()) {
    add(`project:${project.id}`, project.name, project.workspace_path ?? project.project_root);
  }
  return [...roots.values()];
}

function _resolveBrowsePath(rawPath?: string): string {
  return rawPath?.trim()
    ? path.resolve(rawPath.trim().replace(/^~/, os.homedir()))
    : _defaultDirectoryPath();
}

function _pathIsGitRepo(targetPath: string): boolean {
  return fs.existsSync(path.join(targetPath, ".git"));
}

function _projectDeleteSummary(
  project: Project,
  options: { linkedChanges: number; linkedChangeRuns: number; cascadeRequested: boolean; forceRequested: boolean },
): Record<string, unknown> {
  return {
    project_id: project.id,
    removed_project_reference: true,
    removed_local_directory: false,
    removed_sessions: false,
    removed_dag_workspace: false,
    retained_linked_changes: options.linkedChanges,
    retained_linked_change_runs: options.linkedChangeRuns,
    ignored_cascade_request: options.cascadeRequested || options.forceRequested,
  };
}

function _handleCreateChangeForProject(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  projectId: string,
): void {
  const project = getProject(projectId);
  if (!project) {
    notFound(res, `Project not found: ${projectId}`);
    return;
  }
  readJsonBody(req)
    .then((body) => {
      const b = body as Record<string, unknown>;
      const title = typeof b.title === "string" && b.title.trim()
        ? b.title.trim()
        : (typeof b.task === "string" && b.task.trim() ? b.task.trim() : undefined);
      if (!title) {
        badRequest(res, "Missing required field: title (or task)");
        return;
      }
      const description = typeof b.description === "string" ? b.description : undefined;
      const source_issue = typeof b.source_issue === "string" ? b.source_issue : undefined;
      const metadata = _metadata(b.metadata);
      try {
        const change = createChange({ title, project_id: projectId, description, source_issue, metadata });
        created(res, "Change created", change);
      } catch (err) {
        badRequest(res, err instanceof Error ? err.message : String(err));
      }
    })
    .catch((err) => {
      badRequest(res, err instanceof Error ? err.message : "Invalid JSON body");
    });
}

export function projectsChangesRoutesHandler(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): boolean {
  const url = new URL(req.url || "/", "http://localhost");
  const pathname = url.pathname;

  // POST /api/projects/:project_id/changes (must check before GET /api/projects/:id)
  const nestedProjectId = _projectIdFromNestedPath(pathname);
  if (nestedProjectId && pathname.endsWith("/changes") && req.method === "POST") {
    _handleCreateChangeForProject(req, res, nestedProjectId);
    return true;
  }

  // POST /api/projects
  if (pathname === "/api/projects" && req.method === "POST") {
    readJsonBody(req)
      .then((body) => {
        const b = body as Record<string, unknown>;
        const name = _trimmedString(b.name);
        if (!name) {
          badRequest(res, "Missing required field: name");
          return;
        }
        const input = _projectInput(b);
        try {
          const project = createProject({ ...input, name });
          created(res, "Project created", _projectForResponse(project));
        } catch (err) {
          badRequest(res, err instanceof Error ? err.message : String(err));
        }
      })
      .catch((err) => {
        badRequest(res, err instanceof Error ? err.message : "Invalid JSON body");
      });
    return true;
  }

  // GET /api/projects/directories/roots
  if (pathname === "/api/projects/directories/roots" && req.method === "GET") {
    ok(res, "Directory roots retrieved", {
      servers: [{ id: "manager", name: "Manager", kind: "manager", can_browse: true }],
      roots: _directoryRoots(),
      default_path: _defaultDirectoryPath(),
    });
    return true;
  }

  // GET /api/projects/directories/browse
  if (pathname === "/api/projects/directories/browse" && req.method === "GET") {
    try {
      const resolved = _resolveBrowsePath(url.searchParams.get("path") || undefined);
      if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
        notFound(res, `Directory not found: ${resolved}`);
        return true;
      }
      const showHidden = url.searchParams.get("show_hidden") === "true";
      const limit = Math.max(1, Math.min(Number(url.searchParams.get("limit") || "200") || 200, 500));
      const entries = fs.readdirSync(resolved, { withFileTypes: true })
        .filter((entry) => showHidden || !entry.name.startsWith("."))
        .slice(0, limit)
        .map((entry) => {
          const entryPath = path.join(resolved, entry.name);
          const isDirectory = entry.isDirectory();
          return {
            name: entry.name,
            path: entryPath,
            type: isDirectory ? "directory" : "file",
            is_directory: isDirectory,
            is_hidden: entry.name.startsWith("."),
            is_git_repo: isDirectory && _pathIsGitRepo(entryPath),
            writable: isDirectory && _pathIsWritable(entryPath),
          };
        });
      ok(res, "Directory browsed", {
        server_id: url.searchParams.get("server_id") || "manager",
        path: resolved,
        parent: path.dirname(resolved),
        writable: _pathIsWritable(resolved),
        is_git_repo: _pathIsGitRepo(resolved),
        entries,
      });
    } catch (err) {
      badRequest(res, err instanceof Error ? err.message : String(err));
    }
    return true;
  }

  // GET /api/projects
  if (pathname === "/api/projects" && req.method === "GET") {
    const projects = listProjects().map(_projectForResponse);
    ok(res, `Found ${projects.length} projects`, { projects, total: projects.length });
    return true;
  }

  const storageProjectId = _projectIdFromNestedPath(pathname);
  if (storageProjectId && pathname.endsWith("/storages") && req.method === "GET") {
    const storages = listProjectStorages(storageProjectId);
    if (!storages) {
      notFound(res, `Project not found: ${storageProjectId}`);
      return true;
    }
    ok(res, "Project storages retrieved", { storages, total: storages.length });
    return true;
  }

  // GET /api/projects/:project_id
  const projectId = _idFromSegment("/api/projects", pathname);
  if (projectId && req.method === "GET") {
    const project = getProject(projectId);
    if (!project) {
      notFound(res, `Project not found: ${projectId}`);
      return true;
    }
    ok(res, "Project retrieved", _projectForResponse(project));
    return true;
  }

  if (projectId && req.method === "PUT") {
    readJsonBody(req)
      .then((body) => {
        const b = body as Record<string, unknown>;
        try {
          const project = updateProject(projectId, _projectInput(b));
          if (!project) {
            notFound(res, `Project not found: ${projectId}`);
            return;
          }
          ok(res, "Project updated", _projectForResponse(project));
        } catch (err) {
          badRequest(res, err instanceof Error ? err.message : String(err));
        }
      })
      .catch((err) => {
        badRequest(res, err instanceof Error ? err.message : "Invalid JSON body");
      });
    return true;
  }

  if (projectId && req.method === "DELETE") {
    const cascadeRequested = url.searchParams.get("cascade") === "true";
    const forceRequested = url.searchParams.get("force") === "true";
    const project = getProject(projectId);
    if (!project) {
      notFound(res, `Project not found: ${projectId}`);
      return true;
    }
    const linkedChanges = listChanges(project.id).length + (project.project_id !== project.id ? listChanges(project.project_id).length : 0);
    const linkedChangeRuns =
      listChangeRuns({ project_id: project.id }).length +
      (project.project_id !== project.id ? listChangeRuns({ project_id: project.project_id }).length : 0);
    const deleted = deleteProject(projectId)!;
    ok(res, "Project reference deleted", {
      id: deleted.id,
      summary: _projectDeleteSummary(deleted, {
        linkedChanges,
        linkedChangeRuns,
        cascadeRequested,
        forceRequested,
      }),
    });
    return true;
  }

  const nestedChangeId = _nestedChangeRunsPath(pathname);
  if (nestedChangeId && req.method === "GET") {
    const runs = listChangeRuns({ change_id: nestedChangeId });
    ok(res, `Found ${runs.length} change runs`, { runs, total: runs.length });
    return true;
  }

  if (nestedChangeId && req.method === "POST") {
    readJsonBody(req)
      .then((body) => {
        try {
          const run = createChangeRun(_changeRunInput(body as Record<string, unknown>, nestedChangeId));
          created(res, "Change run created", run);
        } catch (err) {
          badRequest(res, err instanceof Error ? err.message : String(err));
        }
      })
      .catch((err) => {
        badRequest(res, err instanceof Error ? err.message : "Invalid JSON body");
      });
    return true;
  }

  // POST /api/changes
  if (pathname === "/api/changes" && req.method === "POST") {
    readJsonBody(req)
      .then((body) => {
        const b = body as Record<string, unknown>;
        const title = _trimmedString(b.title) ?? _trimmedString(b.task);
        if (!title) {
          badRequest(res, "Missing required field: title (or task)");
          return;
        }
        let project_id: string | undefined;
        if ("project_id" in b) {
          project_id = _trimmedString(b.project_id);
          if (!project_id) {
            badRequest(res, "Invalid field: project_id");
            return;
          }
        }
        const description = typeof b.description === "string" ? b.description : undefined;
        const source_issue = typeof b.source_issue === "string" ? b.source_issue : undefined;
        const metadata = _metadata(b.metadata);
        try {
          const change = createChange({ title, project_id, description, source_issue, metadata });
          created(res, "Change created", change);
        } catch (err) {
          badRequest(res, err instanceof Error ? err.message : String(err));
        }
      })
      .catch((err) => {
        badRequest(res, err instanceof Error ? err.message : "Invalid JSON body");
      });
    return true;
  }

  // GET /api/changes
  if (pathname === "/api/changes" && req.method === "GET") {
    const filterProjectId = url.searchParams.get("project_id") || undefined;
    const changes = listChanges(filterProjectId);
    ok(res, `Found ${changes.length} changes`, { changes, total: changes.length });
    return true;
  }

  // POST /api/change-runs
  if (pathname === "/api/change-runs" && req.method === "POST") {
    readJsonBody(req)
      .then((body) => {
        try {
          const run = createChangeRun(_changeRunInput(body as Record<string, unknown>));
          created(res, "Change run created", run);
        } catch (err) {
          badRequest(res, err instanceof Error ? err.message : String(err));
        }
      })
      .catch((err) => {
        badRequest(res, err instanceof Error ? err.message : "Invalid JSON body");
      });
    return true;
  }

  // GET /api/change-runs
  if (pathname === "/api/change-runs" && req.method === "GET") {
    const runs = listChangeRuns({
      change_id: url.searchParams.get("change_id") || undefined,
      project_id: url.searchParams.get("project_id") || undefined,
    });
    ok(res, `Found ${runs.length} change runs`, { runs, total: runs.length });
    return true;
  }

  const changeRunId = _idFromSegment("/api/change-runs", pathname);
  if (changeRunId && req.method === "GET") {
    const run = getChangeRun(changeRunId);
    if (!run) {
      notFound(res, `Change run not found: ${changeRunId}`);
      return true;
    }
    ok(res, "Change run retrieved", run);
    return true;
  }

  if (changeRunId && req.method === "PUT") {
    readJsonBody(req)
      .then((body) => {
        try {
          const run = updateChangeRun(changeRunId, _changeRunInput(body as Record<string, unknown>));
          if (!run) {
            notFound(res, `Change run not found: ${changeRunId}`);
            return;
          }
          ok(res, "Change run updated", run);
        } catch (err) {
          badRequest(res, err instanceof Error ? err.message : String(err));
        }
      })
      .catch((err) => {
        badRequest(res, err instanceof Error ? err.message : "Invalid JSON body");
      });
    return true;
  }

  if (changeRunId && req.method === "DELETE") {
    const removed = deleteChangeRun(changeRunId);
    if (!removed) {
      notFound(res, `Change run not found: ${changeRunId}`);
      return true;
    }
    ok(res, "Change run deleted", { id: changeRunId });
    return true;
  }

  // GET /api/changes/:change_id
  const changeId = _idFromSegment("/api/changes", pathname);
  if (changeId && req.method === "GET") {
    const change = getChange(changeId);
    if (!change) {
      notFound(res, `Change not found: ${changeId}`);
      return true;
    }
    ok(res, "Change retrieved", change);
    return true;
  }

  return false;
}
