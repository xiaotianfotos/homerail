import * as http from "node:http";
import {
  getDagWorkflow,
  getDagWorkflowRevision,
  listDagWorkflowRevisions,
  listDagRuntimeProfiles,
  listDagWorkflows,
  upsertDagRuntimeProfileFromYaml,
  upsertDagWorkflowFromYaml,
} from "../persistence/dag-workflows.js";
import {
  getDAGPattern,
  instantiateDAGPattern,
  listDAGPatterns,
} from "../orchestration/dag-patterns.js";
import {
  compileWorkflowSource,
  workflowSchemaResponse,
} from "../orchestration/workflow-spec-v1.js";

interface BaseResponse {
  success: boolean;
  message: string;
  data?: unknown;
  error?: string;
}

function json(res: http.ServerResponse, status: number, body: BaseResponse): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function ok(res: http.ServerResponse, message: string, data?: unknown): void {
  json(res, 200, { success: true, message, data });
}

function created(res: http.ServerResponse, message: string, data: unknown): void {
  json(res, 201, { success: true, message, data });
}

function badRequest(res: http.ServerResponse, message: string): void {
  json(res, 400, { success: false, message, error: message });
}

function notFound(res: http.ServerResponse, message: string): void {
  json(res, 404, { success: false, message, error: message });
}

async function readJsonBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => { data += chunk; });
    req.on("end", () => {
      try {
        const parsed = data ? JSON.parse(data) : {};
        resolve(parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

function stringField(body: Record<string, unknown>, ...names: string[]): string | undefined {
  for (const name of names) {
    const value = body[name];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function sourceField(body: Record<string, unknown>, ...names: string[]): string | undefined {
  for (const name of names) {
    const value = body[name];
    if (typeof value === "string" && value.trim()) return value;
  }
  return undefined;
}

function workflowIdFromPath(pathname: string): string | undefined {
  const prefix = "/api/dag/workflows/";
  if (!pathname.startsWith(prefix)) return undefined;
  const id = pathname.slice(prefix.length);
  return id && !id.includes("/") ? decodeURIComponent(id) : undefined;
}

function workflowRevisionPath(pathname: string): { workflowId: string; revision?: number } | undefined {
  const match = pathname.match(/^\/api\/dag\/workflows\/([^/]+)\/revisions(?:\/(\d+))?$/);
  if (!match) return undefined;
  return {
    workflowId: decodeURIComponent(match[1]),
    ...(match[2] ? { revision: Number(match[2]) } : {}),
  };
}

function patternPath(pathname: string): { id: string; action?: "instantiate" } | undefined {
  const prefix = "/api/dag/patterns/";
  if (!pathname.startsWith(prefix)) return undefined;
  const parts = pathname.slice(prefix.length).split("/").filter(Boolean);
  if (parts.length === 1) return { id: decodeURIComponent(parts[0]) };
  if (parts.length === 2 && parts[1] === "instantiate") {
    return { id: decodeURIComponent(parts[0]), action: "instantiate" };
  }
  return undefined;
}

function objectField(body: Record<string, unknown>, name: string): Record<string, unknown> | undefined {
  const value = body[name];
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

export function dagWorkflowRoutesHandler(req: http.IncomingMessage, res: http.ServerResponse): boolean {
  const url = new URL(req.url || "/", "http://localhost");
  const pathname = url.pathname;

  if (pathname === "/api/dag/schema" && req.method === "GET") {
    const data = workflowSchemaResponse();
    const etag = `"${data.schema_hash}"`;
    res.setHeader("Cache-Control", "public, max-age=300");
    res.setHeader("ETag", etag);
    if (req.headers["if-none-match"] === etag) {
      res.writeHead(304);
      res.end();
    } else {
      ok(res, "WorkflowSpec v1 schema retrieved", data);
    }
    return true;
  }

  if (pathname === "/api/dag/validate" && req.method === "POST") {
    readJsonBody(req)
      .then((body) => {
        const source = sourceField(body, "source", "yaml_text", "yaml", "content");
        if (!source) {
          badRequest(res, "Missing required field: source");
          return;
        }
        const result = compileWorkflowSource(source);
        json(res, 200, {
          success: result.valid,
          message: result.valid ? "DAG workflow is valid" : "DAG workflow validation failed",
          data: result,
          ...(result.valid ? {} : { error: "DAG workflow validation failed" }),
        });
      })
      .catch((err) => badRequest(res, err instanceof Error ? err.message : String(err)));
    return true;
  }

  if (pathname === "/api/dag/patterns" && req.method === "GET") {
    const patterns = listDAGPatterns();
    ok(res, `Found ${patterns.length} built-in DAG pattern(s)`, { patterns, total: patterns.length });
    return true;
  }

  const patternRoute = patternPath(pathname);
  if (patternRoute && !patternRoute.action && req.method === "GET") {
    const pattern = getDAGPattern(patternRoute.id);
    if (!pattern) notFound(res, `DAG pattern not found: ${patternRoute.id}`);
    else ok(res, "DAG pattern retrieved", pattern);
    return true;
  }

  if (patternRoute?.action === "instantiate" && req.method === "POST") {
    readJsonBody(req)
      .then((body) => {
        const parameters = objectField(body, "parameters");
        if (body.parameters !== undefined && !parameters) {
          throw new Error("Field 'parameters' must be an object.");
        }
        const instance = instantiateDAGPattern(patternRoute.id, parameters ?? {});
        ok(res, "DAG pattern instantiated", {
          pattern: instance.pattern,
          parameters: instance.parameters,
          workflow: instance.workflow,
          yaml_text: instance.yaml_text,
          validation: instance.validation,
        });
      })
      .catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        if (message.startsWith("DAG pattern not found:")) notFound(res, message);
        else badRequest(res, message);
      });
    return true;
  }

  if (pathname === "/api/dag/workflows" && req.method === "GET") {
    const workflows = listDagWorkflows();
    ok(res, `Found ${workflows.length} DAG workflow(s)`, { workflows, total: workflows.length });
    return true;
  }

  const revisionRoute = workflowRevisionPath(pathname);
  if (revisionRoute && req.method === "GET") {
    const workflow = getDagWorkflow(revisionRoute.workflowId);
    if (!workflow) {
      notFound(res, `DAG workflow not found: ${revisionRoute.workflowId}`);
      return true;
    }
    if (revisionRoute.revision !== undefined) {
      const revision = getDagWorkflowRevision(revisionRoute.workflowId, revisionRoute.revision);
      if (!revision) notFound(res, `DAG workflow revision not found: ${revisionRoute.workflowId}@${revisionRoute.revision}`);
      else ok(res, "DAG workflow revision retrieved", revision);
      return true;
    }
    const revisions = listDagWorkflowRevisions(revisionRoute.workflowId).map((revision) => ({
      workflow_id: revision.workflow_id,
      revision: revision.revision,
      api_version: revision.api_version,
      source_format: revision.source_format,
      source_hash: revision.source_hash,
      canonical_hash: revision.canonical_hash,
      compiler_version: revision.compiler_version,
      created_at: revision.created_at,
    }));
    ok(res, `Found ${revisions.length} DAG workflow revision(s)`, { revisions, total: revisions.length });
    return true;
  }

  const workflowId = workflowIdFromPath(pathname);
  if (workflowId && req.method === "GET") {
    const workflow = getDagWorkflow(workflowId);
    if (!workflow) notFound(res, `DAG workflow not found: ${workflowId}`);
    else ok(res, "DAG workflow retrieved", workflow);
    return true;
  }

  if (pathname === "/api/dag/workflows/sync" && req.method === "POST") {
    readJsonBody(req)
      .then((body) => {
        const yamlText = sourceField(body, "yaml_text", "yaml", "content");
        if (!yamlText) {
          badRequest(res, "Missing required field: yaml_text");
          return;
        }
        const sourcePath = stringField(body, "source_path", "sourcePath");
        const result = upsertDagWorkflowFromYaml({ yaml_text: yamlText, source_path: sourcePath });
        created(res, result.created ? "DAG workflow synced" : "DAG workflow updated", {
          workflow: result.workflow,
          created: result.created,
          revision_created: result.revision_created,
          warning: "workflow_id is the stable database identity. Editing YAML should keep workflow_id unchanged unless creating a new workflow/version.",
        });
      })
      .catch((err) => badRequest(res, err instanceof Error ? err.message : String(err)));
    return true;
  }

  if (pathname === "/api/dag/profiles" && req.method === "GET") {
    const workflowIdParam = url.searchParams.get("workflow_id") ?? url.searchParams.get("workflowId") ?? undefined;
    const profiles = listDagRuntimeProfiles(workflowIdParam || undefined);
    ok(res, `Found ${profiles.length} DAG runtime profile(s)`, { profiles, total: profiles.length });
    return true;
  }

  if (pathname === "/api/dag/profiles/sync" && req.method === "POST") {
    readJsonBody(req)
      .then((body) => {
        const yamlText = stringField(body, "yaml_text", "yaml", "content");
        if (!yamlText) {
          badRequest(res, "Missing required field: yaml_text");
          return;
        }
        const workflowId = stringField(body, "workflow_id", "workflowId");
        const sourcePath = stringField(body, "source_path", "sourcePath");
        const result = upsertDagRuntimeProfileFromYaml({
          yaml_text: yamlText,
          workflow_id: workflowId,
          source_path: sourcePath,
        });
        created(res, result.created ? "DAG runtime profile synced" : "DAG runtime profile updated", {
          profile: result.profile,
          created: result.created,
        });
      })
      .catch((err) => badRequest(res, err instanceof Error ? err.message : String(err)));
    return true;
  }

  return false;
}
