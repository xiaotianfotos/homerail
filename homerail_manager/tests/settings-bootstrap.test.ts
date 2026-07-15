import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { parseDAGYaml } from "../src/orchestration/yaml-loader.js";
import { closeDb } from "../src/persistence/db.js";
import { _clearAllPersistence } from "../src/persistence/store.js";
import { _clearActiveRuns, createActiveRun } from "../src/runtime/active-runs.js";
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

function createTestRun(runId: string): void {
  const dag = parseDAGYaml(`
name: active-list-test
workflow_id: active-list-test
agents:
  worker:
    agent_type: deterministic
    system: HANDOFF port=done content=ok
nodes:
  work:
    agent: worker
    after: []
    outputs:
      done:
        to: ""
`);
  createActiveRun(runId, dag);
}

describe("settings bootstrap routes", () => {
  let server: http.Server;
  let tmpHome: string;
  let oldHome: string | undefined;
  let oldAssetDir: string | undefined;

  beforeEach(() => {
    oldHome = process.env.HOMERAIL_HOME;
    oldAssetDir = process.env.HOMERAIL_ASSET_DIR;
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "homerail-settings-bootstrap-"));
    process.env.HOMERAIL_HOME = tmpHome;
    delete process.env.HOMERAIL_ASSET_DIR;
    _clearActiveRuns();
    _clearAllPersistence();
    server = createServer(0, undefined, undefined, false);
  });

  afterEach(async () => {
    _clearActiveRuns();
    _clearAllPersistence();
    await close(server);
    if (oldHome === undefined) {
      delete process.env.HOMERAIL_HOME;
    } else {
      process.env.HOMERAIL_HOME = oldHome;
    }
    if (oldAssetDir === undefined) {
      delete process.env.HOMERAIL_ASSET_DIR;
    } else {
      process.env.HOMERAIL_ASSET_DIR = oldAssetDir;
    }
    closeDb();
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it("returns the merged HomeRail skill catalog and skill contents", async () => {
    const customDir = path.join(tmpHome, "skills", "custom-runtime-skill");
    fs.mkdirSync(customDir, { recursive: true });
    fs.writeFileSync(path.join(customDir, "SKILL.md"), [
      "---",
      "name: custom-runtime-skill",
      "description: Runtime custom skill",
      "---",
      "",
      "# Runtime custom skill",
    ].join("\n"));
    const port = await listen(server);
    const response = await fetch(`http://127.0.0.1:${port}/api/skills`);
    const body = await response.json() as {
      success: boolean;
      data: { total: number; root: string; skills: Array<{ id: string; relative_path: string; source: string }> };
    };

    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data.total).toBeGreaterThan(0);
    expect(body.data.skills.map((skill) => skill.id)).toContain("homerail-dag-ops");
    expect(body.data.skills).toContainEqual(expect.objectContaining({
      id: "custom-runtime-skill",
      source: "home",
    }));
    expect(body.data.root).toBe(path.join(tmpHome, "skills"));
    expect(body.data.skills.every((skill) => !path.isAbsolute(skill.relative_path))).toBe(true);

    const detailResponse = await fetch(`http://127.0.0.1:${port}/api/skills/custom-runtime-skill`);
    const detail = await detailResponse.json() as { data: { content: string; description: string } };
    expect(detailResponse.status).toBe(200);
    expect(detail.data.description).toBe("Runtime custom skill");
    expect(detail.data.content).toContain("# Runtime custom skill");

    const traversal = await fetch(`http://127.0.0.1:${port}/api/skills/%2E%2E%5Csecrets`);
    expect(traversal.status).toBe(404);
  });

  it("returns asset diagnostics with concrete checks", async () => {
    const port = await listen(server);
    const response = await fetch(`http://127.0.0.1:${port}/api/assets/diagnostics`);
    const body = await response.json() as {
      success: boolean;
      data: {
        status: string;
        asset_root: string;
        subdirs: Record<string, { exists: boolean; path: string }>;
        checks: Array<{ name: string; present: boolean; count: number }>;
      };
    };

    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data.status).toBe("healthy");
    expect(body.data.asset_root).toContain("assets");
    expect(body.data.subdirs.orchestrations.exists).toBe(true);
    expect(body.data.checks.find((check) => check.name === "orchestration_templates")?.count).toBeGreaterThan(0);
  });

  it("falls back to built-in orchestrations when HOME only overrides skills", async () => {
    fs.mkdirSync(path.join(tmpHome, "asset", "skills", "custom-skill"), { recursive: true });
    const port = await listen(server);

    const diagnosticsResponse = await fetch(`http://127.0.0.1:${port}/api/assets/diagnostics`);
    const diagnostics = await diagnosticsResponse.json() as {
      data: { subdirs: Record<string, { exists: boolean; path: string }> };
    };
    expect(diagnostics.data.subdirs.orchestrations.exists).toBe(true);
    expect(diagnostics.data.subdirs.orchestrations.path).toContain(path.join("assets", "orchestrations"));

    const templatesResponse = await fetch(`http://127.0.0.1:${port}/api/manage/orchestrations`);
    const templates = await templatesResponse.json() as {
      data: { orchestrations: Array<{ id: string }> };
    };
    expect(templates.data.orchestrations).toContainEqual(expect.objectContaining({ id: "pr-review" }));
  });

  it("returns asset diagnostics from HOMERAIL_ASSET_DIR when configured", async () => {
    const assetRoot = fs.mkdtempSync(path.join(os.tmpdir(), "homerail-manager-assets-"));
    try {
      fs.mkdirSync(path.join(assetRoot, "orchestrations"), { recursive: true });
      fs.mkdirSync(path.join(assetRoot, "providers"), { recursive: true });
      fs.mkdirSync(path.join(assetRoot, "agents"), { recursive: true });
      fs.mkdirSync(path.join(assetRoot, "skills"), { recursive: true });
      fs.mkdirSync(path.join(assetRoot, "prompts"), { recursive: true });
      fs.writeFileSync(path.join(assetRoot, "orchestrations", "external.yaml.template"), `
name: external-manager-template
nodes:
  only:
    agent: worker
    after: []
`);
      fs.writeFileSync(path.join(assetRoot, "providers", "external.yaml.template"), "id: external\n");
      process.env.HOMERAIL_ASSET_DIR = assetRoot;

      const port = await listen(server);
      const response = await fetch(`http://127.0.0.1:${port}/api/assets/diagnostics`);
      const body = await response.json() as {
        success: boolean;
        data: {
          asset_root: string;
          source: string;
          checks: Array<{ name: string; count: number }>;
        };
      };

      expect(response.status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.data.asset_root).toBe(assetRoot);
      expect(body.data.source).toBe("env");
      expect(body.data.checks.find((check) => check.name === "orchestration_templates")?.count).toBe(1);
    } finally {
      fs.rmSync(assetRoot, { recursive: true, force: true });
    }
  });

  it("returns public orchestration templates for the Agent UI diagnostics panel", async () => {
    const port = await listen(server);
    const response = await fetch(`http://127.0.0.1:${port}/api/manage/orchestrations`);
    const body = await response.json() as {
      success: boolean;
      data: {
        total: number;
        orchestrations: Array<{
          id: string;
          path: string;
          category: string;
          node_count: number;
          supported_profiles: string[];
        }>;
      };
    };

    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data.total).toBeGreaterThan(0);
    expect(body.data.orchestrations.every((item) => item.category === "primary")).toBe(true);
    expect(body.data.orchestrations.every((item) => !path.isAbsolute(item.path))).toBe(true);
    expect(body.data.orchestrations.some((item) => item.node_count > 0 || item.supported_profiles.length > 0)).toBe(true);
  });

  it("returns empty experience graph summary instead of the old unsupported response", async () => {
    const port = await listen(server);
    const response = await fetch(`http://127.0.0.1:${port}/api/experience/graph/summary?limit=12`);
    const body = await response.json() as {
      success: boolean;
      data: {
        available: boolean;
        node_count: number;
        relationship_count: number;
        structure_coverage: { status: string };
        recent_runs: unknown[];
      };
    };

    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data.available).toBe(false);
    expect(body.data.node_count).toBe(0);
    expect(body.data.relationship_count).toBe(0);
    expect(body.data.structure_coverage.status).toBe("empty");
    expect(body.data.recent_runs).toEqual([]);
  });

  it("derives experience graph and DAG context from persisted run metadata", async () => {
    const port = await listen(server);
    createTestRun("active-run-1");

    const summaryResponse = await fetch(`http://127.0.0.1:${port}/api/experience/graph/summary?limit=12`);
    const summary = await summaryResponse.json() as {
      success: boolean;
      data: { available: boolean; run_count: number; recent_runs: Array<{ run_id: string; status: string }> };
    };
    expect(summaryResponse.status).toBe(200);
    expect(summary.success).toBe(true);
    expect(summary.data.available).toBe(true);
    expect(summary.data.run_count).toBe(1);
    expect(summary.data.recent_runs[0]).toMatchObject({ run_id: "active-run-1", status: "active" });

    const graphResponse = await fetch(`http://127.0.0.1:${port}/api/experience/graph?query=active-list-test`);
    const graph = await graphResponse.json() as {
      success: boolean;
      data: { nodes: Array<{ type: string }>; edges: Array<{ type: string }> };
    };
    expect(graphResponse.status).toBe(200);
    expect(graph.success).toBe(true);
    expect(graph.data.nodes.some((node) => node.type === "Run")).toBe(true);
    expect(graph.data.edges.some((edge) => edge.type === "UsedTemplate")).toBe(true);

    const contextResponse = await fetch(`http://127.0.0.1:${port}/api/experience/dag-context`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: "active-list-test", limit: 4 }),
    });
    const context = await contextResponse.json() as {
      success: boolean;
      data: { prompt_context: string; matched_items: unknown[]; template_stats: Array<{ template: string }> };
    };
    expect(contextResponse.status).toBe(200);
    expect(context.success).toBe(true);
    expect(context.data.prompt_context).toContain("Run experience graph available");
    expect(context.data.matched_items.length).toBeGreaterThan(0);
    expect(context.data.template_stats.some((item) => item.template === "active-list-test")).toBe(true);
  });

  it("returns unsupported for unavailable compatibility surfaces", async () => {
    const port = await listen(server);
    const response = await fetch(`http://127.0.0.1:${port}/api/settings/workspace/directory-support`);
    const body = await response.json() as { success: boolean; data: { code: string; supported: boolean } };

    expect(response.status).toBe(501);
    expect(body.success).toBe(false);
    expect(body.data.code).toBe("DIRECTORY_IMPORT_UNSUPPORTED");
    expect(body.data.supported).toBe(false);
  });

  it("returns actual active runs instead of an empty dashboard default", async () => {
    const port = await listen(server);
    createTestRun("active-run-1");

    const response = await fetch(`http://127.0.0.1:${port}/api/runs/active/list`);
    const body = await response.json() as {
      success: boolean;
      data: { total: number; runs: Array<{ runId: string; status: string }> };
    };

    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data.total).toBe(1);
    expect(body.data.runs[0]).toMatchObject({ runId: "active-run-1", status: "active" });
  });
});
