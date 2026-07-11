import * as http from "node:http";
import {
  getDagWorkflow,
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

function workflowIdFromPath(pathname: string): string | undefined {
  const prefix = "/api/dag/workflows/";
  if (!pathname.startsWith(prefix)) return undefined;
  const id = pathname.slice(prefix.length);
  return id && !id.includes("/") ? decodeURIComponent(id) : undefined;
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
        const yamlText = stringField(body, "yaml_text", "yaml", "content");
        if (!yamlText) {
          badRequest(res, "Missing required field: yaml_text");
          return;
        }
        const sourcePath = stringField(body, "source_path", "sourcePath");
        const result = upsertDagWorkflowFromYaml({ yaml_text: yamlText, source_path: sourcePath });
        created(res, result.created ? "DAG workflow synced" : "DAG workflow updated", {
          workflow: result.workflow,
          created: result.created,
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
