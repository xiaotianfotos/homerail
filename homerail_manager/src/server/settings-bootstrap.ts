import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";
import { runtimeStatusHandler } from "../runtime/status.js";
import { getExperienceDir, listExperienceGraphFromDb } from "./experience.js";
import { listPersistedRunIds, loadRunMetadata } from "../persistence/store.js";
import { repoRoot, resolveAssetRoot } from "../assets/root.js";
import {
  ensureManagerSkillsInstalled,
  listManagerSkills,
  readManagerSkill,
} from "./manager-skills.js";
import { isCanonicalHomerailPluginSemver } from "homerail-protocol";

interface BaseResponse {
  success: boolean;
  message: string;
  data?: unknown;
  error?: string;
}

function json(res: http.ServerResponse, status: number, body: BaseResponse) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function _ok(res: http.ServerResponse, message: string, data?: unknown) {
  json(res, 200, { success: true, message, data });
}

function _unsupported(res: http.ServerResponse, message: string, data?: unknown) {
  json(res, 501, { success: false, message, error: message, data });
}

function countFiles(dir: string, predicate: (name: string) => boolean): number {
  if (!fs.existsSync(dir)) return 0;
  return fs.readdirSync(dir).filter(predicate).length;
}

function readJsonBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => { data += chunk; });
    req.on("end", () => {
      if (!data.trim()) {
        resolve({});
        return;
      }
      try {
        const parsed = JSON.parse(data) as unknown;
        resolve(parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

function readSkillsCatalog(includePlugins = true) {
  const install = ensureManagerSkillsInstalled();
  const skills = listManagerSkills(includePlugins ? undefined : null);
  return { skills, total: skills.length, root: install.root, install };
}

function buildAssetDiagnostics() {
  const assetResolution = resolveAssetRoot();
  const assetRoot = assetResolution.assetRoot;
  const root = assetResolution.repoRoot;
  const skills = readSkillsCatalog();
  const catalogPath = path.join(assetRoot, "orchestrations", "catalog.yaml");
  const experienceGraphPath = graphPath();
  const checks = [
    {
      name: "orchestration_templates",
      relative_path: "orchestrations",
      present: fs.existsSync(path.join(assetRoot, "orchestrations")),
      count: countFiles(path.join(assetRoot, "orchestrations"), (name) => name.endsWith(".yaml.template")),
    },
    {
      name: "operator_skills",
      relative_path: "skills",
      present: fs.existsSync(path.join(root, "skills")),
      count: skills.total,
    },
  ];
  const status = checks.every((check) => check.present) ? "healthy" : "degraded";
  const subdirs = Object.fromEntries(
    ["orchestrations", "profiles", "agents", "skills", "prompts"].map((name) => {
      const dir = path.join(assetRoot, name);
      return [name, { exists: fs.existsSync(dir), path: dir }];
    }),
  );
  return {
    status,
    asset_root: assetRoot,
    repo_asset_root: assetResolution.repoAssetRoot,
    source: assetResolution.source,
    exists: fs.existsSync(assetRoot),
    is_symlink: fs.existsSync(assetRoot) ? fs.lstatSync(assetRoot).isSymbolicLink() : false,
    symlink_target: fs.existsSync(assetRoot) && fs.lstatSync(assetRoot).isSymbolicLink() ? fs.readlinkSync(assetRoot) : null,
    repo_seed_path: assetResolution.repoAssetRoot,
    env_source: assetResolution.source,
    subdirs,
    catalog_path: fs.existsSync(catalogPath) ? catalogPath : null,
    experience_graph_path: experienceGraphPath,
    checks,
  };
}

function isYamlFile(name: string): boolean {
  return name.endsWith(".yaml") || name.endsWith(".yml") || name.endsWith(".yaml.template") || name.endsWith(".yml.template");
}

function countTopLevelNodeEntries(content: string): number {
  const lines = content.split(/\r?\n/);
  let inNodes = false;
  let nodeIndent: number | undefined;
  let count = 0;
  for (const line of lines) {
    if (!inNodes) {
      if (/^nodes:\s*(?:#.*)?$/.test(line)) inNodes = true;
      continue;
    }
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const indent = line.match(/^ */)?.[0].length ?? 0;
    if (indent === 0) break;
    if (!/^\s+[A-Za-z0-9_-]+:\s*(?:#.*)?$/.test(line)) continue;
    if (nodeIndent === undefined) nodeIndent = indent;
    if (indent === nodeIndent) count += 1;
  }
  return count;
}

function extractYamlScalar(content: string, key: string): string {
  const match = content.match(new RegExp(`^${key}:\\s*(.+)$`, "m"));
  if (!match) return "";
  return match[1].trim().replace(/^["']|["']$/g, "");
}

function extractRuntimeProfiles(content: string): string[] {
  const lines = content.split(/\r?\n/);
  const profiles: string[] = [];
  let inProfiles = false;
  let profileIndent: number | undefined;
  for (const line of lines) {
    if (!inProfiles) {
      if (/^runtime_profiles:\s*(?:#.*)?$/.test(line)) inProfiles = true;
      continue;
    }
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const indent = line.match(/^ */)?.[0].length ?? 0;
    if (indent === 0) break;
    const match = line.match(/^\s+([A-Za-z0-9_.-]+):\s*(?:#.*)?$/);
    if (!match) continue;
    if (profileIndent === undefined) profileIndent = indent;
    if (indent === profileIndent) profiles.push(match[1]);
  }
  return profiles;
}

function orchestrationCategory(relativePath: string, stem: string): "primary" | "compat" | "test" | "legacy" {
  if (relativePath.startsWith("archive/")) return "legacy";
  if (relativePath.startsWith("tests/") || stem.includes("test")) return "test";
  if (stem.includes("legacy") || stem.includes("compat")) return "compat";
  return "primary";
}

function listOrchestrationTemplates(all = false) {
  const dir = path.join(resolveAssetRoot().assetRoot, "orchestrations");
  const files: string[] = [];
  const walk = (current: string, prefix = "") => {
    if (!fs.existsSync(current)) return;
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const rel = path.posix.join(prefix, entry.name);
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full, rel);
      } else if (isYamlFile(entry.name) && entry.name !== "catalog.yaml") {
        files.push(rel);
      }
    }
  };
  walk(dir);
  const orchestrations = files.map((relativePath) => {
    const fullPath = path.join(dir, relativePath);
    const stem = path.basename(relativePath).replace(/\.(yaml|yml)(\.template)?$/, "");
    let content = "";
    try {
      content = fs.readFileSync(fullPath, "utf-8");
    } catch {
      // Keep file visible with defaults.
    }
    const category = orchestrationCategory(relativePath, stem);
    return {
      id: stem,
      name: extractYamlScalar(content, "name") || stem,
      path: path.posix.join("assets", "orchestrations", relativePath),
      description: extractYamlScalar(content, "description"),
      category,
      node_count: countTopLevelNodeEntries(content),
      supported_profiles: extractRuntimeProfiles(content),
    };
  }).filter((item) => all || item.category === "primary");
  orchestrations.sort((a, b) => a.id.localeCompare(b.id));
  return { orchestrations, total: orchestrations.length };
}

interface ExperienceGraphNode {
  id: string;
  type: string;
  label: string;
  summary: string;
  properties: Record<string, unknown>;
}

interface ExperienceGraphEdge {
  id: string;
  source_id: string;
  target_id: string;
  type: string;
  label: string;
  properties: Record<string, unknown>;
}

function graphPath(): string {
  return "sqlite://manager/experience_graph";
}

function readGraph(): { nodes: ExperienceGraphNode[]; edges: ExperienceGraphEdge[]; updatedAt: string | null } {
  const graph = listExperienceGraphFromDb();
  try {
    const nodes = graph.nodes.map((node) => {
      const id = String(node.id || "");
      const type = String(node.type || "RunSignal");
      const label = String(node.label || node.name || node.summary || node.run_id || id);
      return {
        id,
        type,
        label,
        summary: String(node.summary || node.description || node.action || label),
        properties: { ...node },
      };
    }).filter((node) => node.id);
    const edges = graph.relationships.map((edge, index) => {
      const sourceId = String(edge.source_id || edge.source || "");
      const targetId = String(edge.target_id || edge.target || "");
      const type = String(edge.type || "RelatedTo");
      return {
        id: String(edge.id || `${type}-${sourceId}-${targetId}-${index}`),
        source_id: sourceId,
        target_id: targetId,
        type,
        label: String(edge.label || type),
        properties: { ...edge },
      };
    }).filter((edge) => edge.source_id && edge.target_id);
    return { nodes, edges, updatedAt: graph.updatedAt };
  } catch {
    return { nodes: [], edges: [], updatedAt: null };
  }
}

function persistedRunNodes(): { nodes: ExperienceGraphNode[]; edges: ExperienceGraphEdge[] } {
  const nodes: ExperienceGraphNode[] = [];
  const edges: ExperienceGraphEdge[] = [];
  for (const runId of listPersistedRunIds()) {
    const metadata = loadRunMetadata(runId);
    if (!metadata) continue;
    const runNodeId = `run-${runId}`;
    nodes.push({
      id: runNodeId,
      type: "Run",
      label: metadata.workflowName || runId,
      summary: `${metadata.status} run ${runId}`,
      properties: {
        run_id: runId,
        status: metadata.status,
        template: metadata.workflowName || "",
        ["workflow_id"]: metadata.workflowId || "",
        updated_at: metadata.completedAt ? new Date(metadata.completedAt).toISOString() : new Date(metadata.createdAt).toISOString(),
      },
    });
    const template = metadata.workflowName || metadata.workflowId;
    if (template) {
      const templateNodeId = `template-${template}`;
      if (!nodes.some((node) => node.id === templateNodeId)) {
        nodes.push({
          id: templateNodeId,
          type: "OrchestrationTemplate",
          label: template,
          summary: `Template ${template}`,
          properties: { template },
        });
      }
      edges.push({
        id: `used-template-${runId}`,
        source_id: runNodeId,
        target_id: templateNodeId,
        type: "UsedTemplate",
        label: "used template",
        properties: {},
      });
    }
  }
  return { nodes, edges };
}

function mergedExperienceGraph(): { nodes: ExperienceGraphNode[]; edges: ExperienceGraphEdge[]; updatedAt: string | null; graphBacked: boolean } {
  const graph = readGraph();
  if (graph.nodes.length > 0 || graph.edges.length > 0) {
    return { ...graph, graphBacked: true };
  }
  const runs = persistedRunNodes();
  return { ...runs, updatedAt: runs.nodes.length ? new Date().toISOString() : null, graphBacked: false };
}

function countBy<T>(items: T[], fn: (item: T) => string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of items) {
    const key = fn(item);
    counts[key] = (counts[key] || 0) + 1;
  }
  return counts;
}

function structureCoverage(nodes: ExperienceGraphNode[], edges: ExperienceGraphEdge[]) {
  const checks = {
    has_runs: nodes.some((node) => node.type === "Run"),
    has_templates: nodes.some((node) => node.type === "OrchestrationTemplate"),
    has_scorecards: nodes.some((node) => node.type === "ScorecardResult"),
    has_lessons: nodes.some((node) => node.type === "Lesson"),
    has_relationships: edges.length > 0,
  };
  const okCount = Object.values(checks).filter(Boolean).length;
  const status = nodes.length === 0 ? "empty" : okCount === Object.keys(checks).length ? "healthy" : "partial";
  const message = status === "empty"
    ? "No run experience graph data is available yet."
    : status === "healthy"
      ? "Run experience graph has the expected public structure."
      : "Run experience graph is available but still missing some optional structure.";
  return { status, checks, message };
}

function templateStatsFromRuns() {
  const byTemplate = new Map<string, { runs: number; successes: number; failures: number; scorecard_passes: number; recent_run_ids: string[] }>();
  for (const runId of listPersistedRunIds()) {
    const metadata = loadRunMetadata(runId);
    if (!metadata) continue;
    const template = metadata.workflowName || metadata.workflowId || "unknown";
    const stat = byTemplate.get(template) ?? { runs: 0, successes: 0, failures: 0, scorecard_passes: 0, recent_run_ids: [] };
    stat.runs += 1;
    if (metadata.status === "completed") stat.successes += 1;
    if (metadata.status === "failed") stat.failures += 1;
    stat.recent_run_ids = [runId, ...stat.recent_run_ids].slice(0, 5);
    byTemplate.set(template, stat);
  }
  return Array.from(byTemplate.entries()).map(([template, stat]) => ({
    template,
    ...stat,
    success_rate: stat.runs ? stat.successes / stat.runs : 0,
    problem_categories: [] as string[],
  }));
}

function buildExperienceSummary(limit = 12) {
  const graph = mergedExperienceGraph();
  const runNodes = graph.nodes.filter((node) => node.type === "Run");
  const successfulRuns = runNodes.filter((node) => String(node.properties.status) === "completed").length;
  const failedRuns = runNodes.filter((node) => String(node.properties.status) === "failed").length;
  const recentRuns = runNodes.slice(-Math.max(1, limit)).reverse().map((node) => ({
    id: node.id,
    run_id: String(node.properties.run_id || node.id.replace(/^run-/, "")),
    status: String(node.properties.status || "unknown"),
    template: String(node.properties.template || node.properties.workflow_id || ""),
    ["workflow_id"]: String(node.properties.workflow_id || ""),
    profile_id: String(node.properties.profile_id || ""),
    summary: node.summary,
    updated_at: String(node.properties.updated_at || graph.updatedAt || ""),
  }));
  const lessons = graph.nodes.filter((node) => node.type === "Lesson").slice(0, limit).map((node) => ({
    id: node.id,
    summary: node.summary,
    category: String(node.properties.category || "lesson"),
    action: String(node.properties.action || node.summary),
    updated_at: String(node.properties.updated_at || graph.updatedAt || ""),
  }));
  const problems = graph.nodes.filter((node) => node.type === "FailureRootCause").slice(0, limit).map((node) => ({
    category: String(node.properties.category || "failure"),
    severity: String(node.properties.severity || "warning"),
    count: 1,
    description: node.summary,
    run_ids: [] as string[],
    lesson_actions: [] as string[],
  }));
  return {
    available: graph.nodes.length > 0 || graph.edges.length > 0,
    reason: graph.nodes.length ? (graph.graphBacked ? "graph loaded" : "derived from persisted runs") : "No run experience graph data is available yet.",
    asset_root: path.join(getExperienceDir()),
    graph_path: graphPath(),
    updated_at: graph.updatedAt,
    node_count: graph.nodes.length,
    relationship_count: graph.edges.length,
    node_counts: countBy(graph.nodes, (node) => node.type),
    relationship_counts: countBy(graph.edges, (edge) => edge.type),
    run_count: runNodes.length,
    successful_runs: successfulRuns,
    failed_runs: failedRuns,
    success_rate: runNodes.length ? successfulRuns / runNodes.length : 0,
    structure_coverage: structureCoverage(graph.nodes, graph.edges),
    template_stats: templateStatsFromRuns().slice(0, limit),
    problems,
    lessons,
    recent_runs: recentRuns,
    graph: {
      nodes: graph.nodes.slice(0, limit).map((node) => ({ id: node.id, type: node.type, label: node.label })),
      edges: graph.edges.slice(0, limit).map((edge) => ({ source_id: edge.source_id, target_id: edge.target_id, type: edge.type })),
    },
  };
}

function buildExperienceGraphDetail(url: URL) {
  const graph = mergedExperienceGraph();
  const query = (url.searchParams.get("query") || "").toLowerCase();
  const selectedTypes = url.searchParams.getAll("node_type");
  const limit = Math.max(1, Math.min(Number(url.searchParams.get("limit") || "500") || 500, 2000));
  const includeNeighbors = url.searchParams.get("include_neighbors") !== "false";
  const selectedTypeSet = new Set(selectedTypes);
  let nodes = graph.nodes.filter((node) => {
    if (selectedTypeSet.size && !selectedTypeSet.has(node.type)) return false;
    if (!query) return true;
    return `${node.id} ${node.type} ${node.label} ${node.summary} ${JSON.stringify(node.properties)}`.toLowerCase().includes(query);
  }).slice(0, limit);
  if (includeNeighbors && nodes.length && nodes.length < limit) {
    const ids = new Set(nodes.map((node) => node.id));
    for (const edge of graph.edges) {
      if (ids.has(edge.source_id) || ids.has(edge.target_id)) {
        const source = graph.nodes.find((node) => node.id === edge.source_id);
        const target = graph.nodes.find((node) => node.id === edge.target_id);
        for (const node of [source, target]) {
          if (node && !ids.has(node.id) && nodes.length < limit) {
            nodes.push(node);
            ids.add(node.id);
          }
        }
      }
    }
  }
  const ids = new Set(nodes.map((node) => node.id));
  const edges = graph.edges.filter((edge) => ids.has(edge.source_id) && ids.has(edge.target_id));
  return {
    available: graph.nodes.length > 0 || graph.edges.length > 0,
    reason: graph.nodes.length ? (graph.graphBacked ? "graph loaded" : "derived from persisted runs") : "No run experience graph data is available yet.",
    asset_root: getExperienceDir(),
    graph_path: graphPath(),
    updated_at: graph.updatedAt,
    total_node_count: graph.nodes.length,
    total_relationship_count: graph.edges.length,
    node_count: nodes.length,
    relationship_count: edges.length,
    node_counts: countBy(graph.nodes, (node) => node.type),
    relationship_counts: countBy(graph.edges, (edge) => edge.type),
    query,
    node_types: Object.keys(countBy(graph.nodes, (node) => node.type)),
    selected_node_types: selectedTypes,
    nodes,
    edges,
  };
}

function buildDagContext(query: string, limit = 8) {
  const summary = buildExperienceSummary(limit);
  const queryText = query.trim();
  const matchedItems = summary.graph.nodes
    .filter((node) => !queryText || `${node.id} ${node.type} ${node.label}`.toLowerCase().includes(queryText.toLowerCase()))
    .slice(0, limit)
    .map((node, index) => ({ score: 1 / (index + 1), node }));
  const memoryRefs = summary.lessons.slice(0, limit).map((lesson) => ({
    id: lesson.id,
    title: lesson.category,
    summary: lesson.summary,
    source: "run-experience",
  }));
  return {
    query,
    prompt_context: summary.available
      ? `Run experience graph available with ${summary.node_count} nodes and ${summary.relationship_count} relationships.`
      : "No run experience graph data is available yet.",
    memory_refs: memoryRefs,
    template_stats: summary.template_stats.slice(0, limit),
    matched_items: matchedItems,
  };
}

export function settingsBootstrapHandler(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): boolean {
  const url = new URL(req.url || "/", "http://localhost");
  const pathname = url.pathname;

  if (pathname === "/api/nodes" && req.method === "GET") {
    const runtime = runtimeStatusHandler();
    _ok(res, "Nodes retrieved", {
      nodes: runtime.node_ids.map((nodeId) => ({
        node_id: nodeId,
        capabilities: runtime.node_capabilities[nodeId] ?? {},
      })),
      total: runtime.connected_nodes,
      connected_workers: runtime.connected_workers,
      worker_ids: runtime.worker_ids,
    });
    return true;
  }

  if (pathname === "/api/skills" && req.method === "GET") {
    _ok(res, "Skills retrieved", readSkillsCatalog(url.searchParams.get("local_only") !== "1"));
    return true;
  }

  const skillMatch = pathname.match(/^\/api\/skills\/([^/]+)$/);
  if (skillMatch && req.method === "GET") {
    let skillId = "";
    try {
      skillId = decodeURIComponent(skillMatch[1]);
    } catch {
      json(res, 400, { success: false, message: "Invalid skill id", error: "Invalid skill id" });
      return true;
    }
    const pluginVersion = url.searchParams.get("plugin_version");
    const digest = url.searchParams.get("digest");
    if ((pluginVersion && !digest) || (!pluginVersion && digest)) {
      json(res, 400, { success: false, message: "Exact plugin Skill requires version and digest", error: "Invalid exact Skill reference" });
      return true;
    }
    if (
      pluginVersion
      && digest
      && (
        !isCanonicalHomerailPluginSemver(pluginVersion)
        || !/^[a-f0-9]{64}$/.test(digest)
      )
    ) {
      json(res, 400, { success: false, message: "Invalid exact plugin Skill version or digest", error: "Invalid exact Skill reference" });
      return true;
    }
    const skill = readManagerSkill(
      skillId,
      pluginVersion && digest ? { plugin_version: pluginVersion, digest } : undefined,
    );
    if (!skill) {
      json(res, 404, { success: false, message: "Skill not found", error: "Skill not found" });
    } else {
      _ok(res, "Skill retrieved", skill);
    }
    return true;
  }

  if (pathname === "/api/assets/diagnostics" && req.method === "GET") {
    _ok(res, "Asset diagnostics retrieved", buildAssetDiagnostics());
    return true;
  }

  if (pathname === "/api/manage/orchestrations" && req.method === "GET") {
    _ok(res, "Orchestration templates retrieved", listOrchestrationTemplates(url.searchParams.get("all") === "true"));
    return true;
  }

  if (pathname === "/api/experience/graph/summary" && req.method === "GET") {
    const limit = Number(url.searchParams.get("limit") || "12") || 12;
    _ok(res, "Experience graph summary retrieved", buildExperienceSummary(limit));
    return true;
  }

  if (pathname === "/api/experience/graph" && req.method === "GET") {
    _ok(res, "Experience graph retrieved", buildExperienceGraphDetail(url));
    return true;
  }

  if (pathname === "/api/experience/dag-context" && req.method === "GET") {
    const query = url.searchParams.get("query") || "";
    const limit = Number(url.searchParams.get("limit") || "8") || 8;
    _ok(res, "Experience DAG context retrieved", buildDagContext(query, limit));
    return true;
  }

  if (pathname === "/api/experience/dag-context" && req.method === "POST") {
    readJsonBody(req)
      .then((body) => {
        const query = typeof body.query === "string" ? body.query : "";
        const limit = Number(body.limit || 8) || 8;
        _ok(res, "Experience DAG context retrieved", buildDagContext(query, limit));
      })
      .catch((err) => json(res, 400, {
        success: false,
        message: err instanceof Error ? err.message : "Invalid JSON body",
        error: err instanceof Error ? err.message : "Invalid JSON body",
      }));
    return true;
  }

  if (pathname === "/api/settings/workspace/directory-support" && req.method === "GET") {
    _unsupported(res, "Workspace directory import is not implemented in TS Manager", {
      code: "DIRECTORY_IMPORT_UNSUPPORTED",
      supported: false,
    });
    return true;
  }

  return false;
}
