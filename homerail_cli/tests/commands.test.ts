import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { EventEmitter } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Readable } from "node:stream";
import type { ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createProgram } from "../src/index.js";
import { readLineFromStdin, redactSecret } from "../src/commands/llm-settings.js";
import {
  agentUiDevServerCommand,
  dockerMissingMessage,
  isMissingModelCredential,
  shouldAbortStartForModelConfig,
  shouldServeStaticAgentUi,
  runWorkerImageDockerBuild,
  workerImageBuildReason,
  workerImageDockerBuildSpawnOptions,
  workerImageSourceFingerprint,
} from "../src/commands/runtime.js";
import { createLaunchAgentPlist, installRuntimeService, uninstallRuntimeService } from "../src/local-service-lifecycle.js";

/**
 * These tests exercise each command handler with a mocked HomeRailClient.
 * We spy on the global fetch so that HomeRailClient never makes real HTTP calls.
 */

function mockFetch(responseData: unknown, status = 200): void {
  vi.spyOn(globalThis, "fetch").mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: async () => responseData,
  } as unknown as Response);
}

let tempHome: string;
let previousHome: string | undefined;
let previousConfigPath: string | undefined;
let previousSecretsPath: string | undefined;
let previousManagerUrl: string | undefined;
let previousPublicHost: string | undefined;
let previousAssetDir: string | undefined;
let previousUiServeStatic: string | undefined;

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

beforeEach(() => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
  tempHome = mkdtempSync(join(tmpdir(), "homerail-cli-command-test-"));
  previousHome = process.env.HOMERAIL_HOME;
  previousConfigPath = process.env.HOMERAIL_CONFIG_PATH;
  previousSecretsPath = process.env.HOMERAIL_SECRETS_PATH;
  previousManagerUrl = process.env.HOMERAIL_MANAGER_URL;
  previousPublicHost = process.env.HOMERAIL_PUBLIC_HOST;
  previousAssetDir = process.env.HOMERAIL_ASSET_DIR;
  previousUiServeStatic = process.env.HOMERAIL_UI_SERVE_STATIC;
  process.env.HOMERAIL_HOME = tempHome;
  delete process.env.HOMERAIL_CONFIG_PATH;
  delete process.env.HOMERAIL_SECRETS_PATH;
  delete process.env.HOMERAIL_MANAGER_URL;
  delete process.env.HOMERAIL_PUBLIC_HOST;
  delete process.env.HOMERAIL_ASSET_DIR;
  delete process.env.HOMERAIL_UI_SERVE_STATIC;
});

afterEach(() => {
  restoreEnv("HOMERAIL_HOME", previousHome);
  restoreEnv("HOMERAIL_CONFIG_PATH", previousConfigPath);
  restoreEnv("HOMERAIL_SECRETS_PATH", previousSecretsPath);
  restoreEnv("HOMERAIL_MANAGER_URL", previousManagerUrl);
  restoreEnv("HOMERAIL_PUBLIC_HOST", previousPublicHost);
  restoreEnv("HOMERAIL_ASSET_DIR", previousAssetDir);
  restoreEnv("HOMERAIL_UI_SERVE_STATIC", previousUiServeStatic);
  rmSync(tempHome, { recursive: true, force: true });
});

describe("runs command", () => {
  it("prints run table in human-readable mode", async () => {
    mockFetch({
      success: true,
      message: "Found 2 runs",
      data: {
        runs: [
          {
            runId: "run-001",
            status: "completed",
            workflowName: "test-template",
            createdAt: "2025-01-01T00:00:00Z",
          },
          {
            runId: "run-002",
            status: "running",
            workflowName: "other-template",
            createdAt: "2025-01-02T00:00:00Z",
          },
        ],
      },
    });

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const program = createProgram();
    await program.parseAsync(["node", "homerail", "runs"]);

    const output = logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(output).toContain("run-001");
    expect(output).toContain("completed");
    expect(output).toContain("run-002");
    expect(output).toContain("running");
  });

  it("prints JSON with --json flag", async () => {
    const runs = [
      { runId: "run-001", status: "completed", createdAt: "2025-01-01" },
    ];
    mockFetch({ success: true, message: "ok", data: { runs } });

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const program = createProgram();
    await program.parseAsync(["node", "homerail", "--json", "runs"]);

    const output = logSpy.mock.calls[0][0];
    const parsed = JSON.parse(output);
    expect(parsed).toEqual(runs);
  });
});

describe("status command", () => {
  it("prints run status in human-readable mode", async () => {
    mockFetch({
      success: true,
      message: "Run status retrieved",
      data: {
        run_id: "run-123",
        status: "completed",
        current_phase: "completed",
        created_at: "2025-01-01T00:00:00Z",
        completed_at: "2025-01-01T01:00:00Z",
        node_states: { "coding-agent": "COMPLETED" },
      },
    });

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const program = createProgram();
    await program.parseAsync(["node", "homerail", "status", "run-123"]);

    const output = logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(output).toContain("run-123");
    expect(output).toContain("completed");
    expect(output).toContain("coding-agent");
  });

  it("prints JSON with --json flag", async () => {
    const data = {
      run_id: "run-123",
      status: "running",
    };
    mockFetch({ success: true, message: "ok", data });

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const program = createProgram();
    await program.parseAsync(["node", "homerail", "--json", "status", "run-123"]);

    const parsed = JSON.parse(logSpy.mock.calls[0][0]);
    expect(parsed.run_id).toBe("run-123");
    expect(parsed.status).toBe("running");
  });
});

describe("stop command", () => {
  it("prints confirmation in human-readable mode", async () => {
    mockFetch({ success: true, message: "Run cancelled" });

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const program = createProgram();
    await program.parseAsync(["node", "homerail", "stop", "run-456"]);

    const output = logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(output).toContain("run-456 stopped");
    expect(output).toContain("Run cancelled");
  });

  it("prints JSON with --json flag", async () => {
    mockFetch({ success: true, message: "Run cancelled" });

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const program = createProgram();
    await program.parseAsync(["node", "homerail", "--json", "stop", "run-456"]);

    const parsed = JSON.parse(logSpy.mock.calls[0][0]);
    expect(parsed.success).toBe(true);
  });

  it("reports error on failure", async () => {
    mockFetch({ success: false, message: "Run not found" }, 404);

    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const program = createProgram();
    await program.parseAsync(["node", "homerail", "stop", "missing-run"]);

    const output = errSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(output).toContain("Error");
    expect(output).toContain("Run not found");
  });
});

describe("run command", () => {
  it("sends create-and-run request and prints run ID", async () => {
    mockFetch({
      success: true,
      message: "Run started",
      data: { run_id: "new-run-789" },
    });

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const program = createProgram();
    await program.parseAsync([
      "node",
      "hr",
      "run",
      "test-template",
      "--prompt",
      "do something",
      "--profile",
      "mimo-only",
    ]);

    const output = logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(output).toContain("new-run-789");
    expect(output).toContain("Run started");
    expect(globalThis.fetch).toHaveBeenCalledWith(
      "http://localhost:19191/api/runs/create-and-run",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          prompt: "do something",
          yamlPath: "test-template",
          profile: "mimo-only",
        }),
      }),
    );
  });

  it("runs a database workflow with a server-side profile", async () => {
    mockFetch({
      success: true,
      message: "Run started",
      data: { run_id: "db-run-1" },
    });

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const program = createProgram();
    await program.parseAsync([
      "node",
      "hr",
      "run",
      "--workflow",
      "public-dev-5node-template",
      "--profile",
      "qwen-main",
      "--prompt",
      "do something",
    ]);

    expect(logSpy.mock.calls.map((c) => c.join(" ")).join("\n")).toContain("db-run-1");
    expect(globalThis.fetch).toHaveBeenCalledWith(
      "http://localhost:19191/api/runs/create-and-run",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          prompt: "do something",
          workflow_id: "public-dev-5node-template",
          profile: "qwen-main",
        }),
      }),
    );
  });

  it("syncs a DAG asset and profile YAML before running", async () => {
    const assetRoot = mkdtempSync(join(tmpdir(), "homerail-cli-run-sync-assets-"));
    const profilePath = join(tempHome, "qwen.profile.yaml");
    try {
      mkdirSync(join(assetRoot, "orchestrations"), { recursive: true });
      writeFileSync(join(assetRoot, "orchestrations", "demo.yaml.template"), `
name: demo
workflow_id: demo-workflow
nodes:
  only:
    agent: worker
    after: []
`);
      writeFileSync(profilePath, `
profile_id: qwen-main
workflow_id: demo-workflow
default:
  model_alias: local-qwen
  agent_type: claude-sdk
`);
      process.env.HOMERAIL_ASSET_DIR = assetRoot;
      vi.spyOn(globalThis, "fetch")
        .mockResolvedValueOnce({
          ok: true,
          status: 201,
          json: async () => ({
            success: true,
            message: "synced",
            data: { workflow: { workflow_id: "demo-workflow" } },
          }),
        } as unknown as Response)
        .mockResolvedValueOnce({
          ok: true,
          status: 201,
          json: async () => ({
            success: true,
            message: "profile synced",
            data: { profile: { profile_id: "qwen-main" } },
          }),
        } as unknown as Response)
        .mockResolvedValueOnce({
          ok: true,
          status: 201,
          json: async () => ({
            success: true,
            message: "Run started",
            data: { run_id: "synced-run-1" },
          }),
        } as unknown as Response);

      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      const program = createProgram();
      await program.parseAsync([
        "node",
        "hr",
        "run",
        "demo",
        "--sync",
        "--profile",
        profilePath,
        "--prompt",
        "do something",
      ]);

      expect(logSpy.mock.calls.map((c) => c.join(" ")).join("\n")).toContain("synced-run-1");
      expect(globalThis.fetch).toHaveBeenNthCalledWith(
        1,
        "http://localhost:19191/api/dag/workflows/sync",
        expect.objectContaining({ method: "POST" }),
      );
      expect(globalThis.fetch).toHaveBeenNthCalledWith(
        2,
        "http://localhost:19191/api/dag/profiles/sync",
        expect.objectContaining({ method: "POST" }),
      );
      expect(globalThis.fetch).toHaveBeenNthCalledWith(
        3,
        "http://localhost:19191/api/runs/create-and-run",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({
            prompt: "do something",
            workflow_id: "demo-workflow",
            profile: "qwen-main",
          }),
        }),
      );
    } finally {
      rmSync(assetRoot, { recursive: true, force: true });
    }
  });

  it("requires --prompt", async () => {
    const errSpy = vi.spyOn(process.stderr, "write").mockImplementation(
      () => true,
    );

    const program = createProgram();
    // commander calls process.exit on required option missing; catch it
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("exit called");
    });

    try {
      await program.parseAsync(["node", "homerail", "run", "template"]);
    } catch {
      // expected
    }

    exitSpy.mockRestore();
    errSpy.mockRestore();
  });
});

describe("global options", () => {
  it("accepts a positive timeout option", async () => {
    mockFetch({ success: true, message: "ok", data: { run_id: "run-123" } });

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const program = createProgram();
    await program.parseAsync([
      "node",
      "hr",
      "--request-timeout",
      "1234",
      "--json",
      "status",
      "run-123",
    ]);

    expect(logSpy).toHaveBeenCalled();
    expect(globalThis.fetch).toHaveBeenCalledWith(
      "http://localhost:19191/api/runs/run-123/status",
      expect.objectContaining({ method: "GET" }),
    );
  });
});

describe("templates command", () => {
  it("lists local templates without probing Manager catalog APIs", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("should not fetch"));

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const program = createProgram();
    await program.parseAsync(["node", "homerail", "templates", "list"]);

    const output = logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(output).toContain("public-dev-5node-template");
    expect(output).toContain("public-two-node-template");
  });

  it("counts only direct nodes in local templates", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const program = createProgram();
    await program.parseAsync(["node", "homerail", "templates", "list"]);

    const output = logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(output).toMatch(/public-dev-5node-template\s+5\s+/);
    expect(output).toMatch(/public-two-node-template\s+2\s+/);
    expect(output).toMatch(/local-harness-cli-deploy-diagnosis\s+1\s+/);
    expect(output).not.toContain("qwen36");
  });

  it("lists templates from HOMERAIL_ASSET_DIR when configured", async () => {
    const assetRoot = mkdtempSync(join(tmpdir(), "homerail-cli-assets-"));
    try {
      mkdirSync(join(assetRoot, "orchestrations"), { recursive: true });
      writeFileSync(join(assetRoot, "orchestrations", "external.yaml.template"), `
name: external-asset-template
description: External asset template.
nodes:
  only:
    agent: worker
    after: []
`);
      process.env.HOMERAIL_ASSET_DIR = assetRoot;

      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      const program = createProgram();
      await program.parseAsync(["node", "homerail", "--json", "templates", "list"]);

      const output = logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
      const items = JSON.parse(output) as Array<{ name: string; path: string; node_count: number }>;
      expect(items).toEqual([
        expect.objectContaining({
          name: "external-asset-template",
          node_count: 1,
          path: join(assetRoot, "orchestrations", "external.yaml.template"),
        }),
      ]);
    } finally {
      rmSync(assetRoot, { recursive: true, force: true });
    }
  });

  it("keeps the public five-node smoke template self-contained", () => {
    const yaml = readFileSync(
      new URL("../../assets/orchestrations/public-dev-5node.yaml.template", import.meta.url),
      "utf8",
    );

    expect(yaml).toContain("The Manager injects upstream");
    expect(yaml).toContain("Do not call receive_message");
    expect(yaml).toContain("Do not create or edit files");
    expect(yaml).toContain("/workspace/snake-game/index.html");
    expect(yaml).toContain("/workspace/snake-game/TESTS.md");
    expect(yaml).toContain("Do not PASS by inspecting files outside /workspace/snake-game");
  });

  it("keeps the local harness deployment diagnosis template single-node and read-only", () => {
    const yaml = readFileSync(
      new URL("../../assets/orchestrations/local-harness-cli-deploy-diagnosis.yaml.template", import.meta.url),
      "utf8",
    );

    expect(yaml).toContain("name: local-harness-cli-deploy-diagnosis");
    expect(yaml).toContain("DB LLM setting");
    expect(yaml).not.toContain("provider: local-harness");
    expect(yaml).not.toContain("model: custom-model");
    expect(yaml).toContain("mode: isolated");
    expect(yaml).not.toContain("qwen36");
    expect(yaml).not.toContain("qwen3.6");
    expect(yaml).not.toContain("allow_prohibited_local_qwen");
    expect(yaml).toContain("Do not modify source code, docs, tests, package manifests, lockfiles, or DAG templates.");
    expect(yaml).toContain("Do not use Write, Edit, or MultiEdit on repository files.");
    expect(yaml).toContain("MANAGER_WORKER_WS_URL");
    expect(yaml).toContain("HOMERAIL_WORKER_ID");
    expect(yaml).toContain("config set manager.url");
    expect(yaml).toContain("runtime status");
    expect(yaml).toContain("current_worker_connected: yes");
    expect(yaml).toContain("fixed host Worker process");
    expect(yaml).toContain("Docker-in-Docker");
    expect(yaml).toContain("DEPLOYMENT_COVERAGE_BLOCKED");
    expect(yaml).toContain("enforcement: advisory");
    expect(yaml).not.toContain("start --host-worker");
    expect(yaml).not.toContain("host-diagnosis-worker");
    expect(yaml).not.toContain("host-docker");
    expect(yaml).not.toContain("success_forbidden_terms");
    expect(yaml).not.toContain("start --require-cold-manager");
    expect(yaml.replace(/\r\n/g, "\n")).toContain("nodes:\n  diagnose:");
    expect(yaml).not.toContain("192.168.");
  });

  it("keeps public templates provider-neutral", () => {
    const templatePaths = [
      "../../assets/README.md",
      "../../assets/orchestrations/README.md",
      "../../assets/orchestrations/public-two-node.yaml.template",
      "../../assets/orchestrations/public-dev-5node.yaml.template",
      "../../assets/orchestrations/local-harness-cli-deploy-diagnosis.yaml.template",
      "../../assets/profiles/example-runtime.profile.yaml.template",
    ];
    const combined = templatePaths
      .map((templatePath) => readFileSync(new URL(templatePath, import.meta.url), "utf8"))
      .join("\n");

    expect(combined).not.toContain("qwen36");
    expect(combined).not.toContain("qwen3.6");
    expect(combined).not.toContain("mimo-v2.5-pro");
    expect(combined).not.toContain("allow_prohibited_local_qwen");
    expect(combined).not.toContain("token-plan-cn.xiaomimimo.com");
  });

  it("requires public orchestration templates to define a stable workflow identity", () => {
    const orchestrationsDir = new URL("../../assets/orchestrations/", import.meta.url);
    const templatePaths = readdirSync(orchestrationsDir)
      .filter((name) => name.endsWith(".yaml.template"))
      .map((name) => new URL(name, orchestrationsDir));

    expect(templatePaths.length).toBeGreaterThan(0);
    for (const templatePath of templatePaths) {
      const yaml = readFileSync(templatePath, "utf8");
      expect(yaml, templatePath.pathname).toMatch(/^(?:workflow_id:\s*\S+|\s+id:\s*\S+)/m);
    }
  });
});

describe("dag WorkflowSpec commands", () => {
  it("prints structured validation output for AI clients", async () => {
    const sourcePath = join(tempHome, "workflow.yaml");
    writeFileSync(sourcePath, "api_version: homerail.ai/v1\nkind: Workflow\n");
    mockFetch({
      success: true,
      message: "DAG workflow is valid",
      data: {
        valid: true,
        source_format: "yaml",
        source_api_version: "homerail.ai/v1",
        canonical_hash: "a".repeat(64),
        diagnostics: [],
        summary: {
          workflow_id: "cli-workflow",
          node_count: 2,
          edge_count: 2,
          entry_nodes: ["execute"],
          terminal_nodes: ["done"],
        },
      },
    });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const program = createProgram();
    await program.parseAsync(["node", "homerail", "--json", "dag", "validate", sourcePath]);

    expect(JSON.parse(String(logSpy.mock.calls[0][0]))).toMatchObject({
      valid: true,
      source_api_version: "homerail.ai/v1",
      summary: { workflow_id: "cli-workflow" },
    });
    expect(fetch).toHaveBeenCalledWith(
      "http://localhost:19191/api/dag/validate",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ source: "api_version: homerail.ai/v1\nkind: Workflow\n" }),
      }),
    );
  });

  it("prints source diagnostics and exits non-zero for an invalid workflow", async () => {
    const sourcePath = join(tempHome, "invalid.yaml");
    writeFileSync(sourcePath, "api_version: homerail.ai/v1\nkind: Workflow\n");
    mockFetch({
      success: false,
      message: "DAG workflow validation failed",
      data: {
        valid: false,
        source_format: "yaml",
        source_api_version: "homerail.ai/v1",
        diagnostics: [{
          severity: "error",
          code: "DAG_SCHEMA_REQUIRED_FIELD",
          path: "/metadata",
          message: "Expected required property",
          line: 1,
          column: 1,
        }],
      },
    });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const program = createProgram();
    await program.parseAsync(["node", "homerail", "dag", "validate", sourcePath]);

    expect(process.exitCode).toBe(1);
    expect(errorSpy.mock.calls.flat().join("\n")).toContain(
      "DAG_SCHEMA_REQUIRED_FIELD /metadata line 1:1",
    );
  });

  it("fetches the live schema from Manager", async () => {
    mockFetch({
      success: true,
      message: "WorkflowSpec v1 schema retrieved",
      data: {
        api_version: "homerail.ai/v1",
        compiler_version: "1",
        schema_hash: "b".repeat(64),
        schema: { type: "object" },
      },
    });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const program = createProgram();
    await program.parseAsync(["node", "homerail", "--json", "dag", "schema"]);

    expect(JSON.parse(String(logSpy.mock.calls[0][0]))).toMatchObject({
      api_version: "homerail.ai/v1",
      schema: { type: "object" },
    });
  });
});

describe("provider command", () => {
  it("provider list prints provider table in human-readable mode", async () => {
    mockFetch({
      success: true,
      message: "ok",
      data: {
        providers: [
          { id: "openai", name: "OpenAI", display_name: "OpenAI" },
          { id: "glm", name: "GLM", display_name: "ChatGLM" },
        ],
      },
    });

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const program = createProgram();
    await program.parseAsync(["node", "homerail", "provider", "list"]);

    const output = logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(output).toContain("openai");
    expect(output).toContain("OpenAI");
    expect(output).toContain("glm");
    expect(output).toContain("ChatGLM");
  });

  it("provider list prints JSON with --json flag", async () => {
    const providers = [
      { id: "openai", name: "OpenAI", display_name: "OpenAI" },
    ];
    mockFetch({ success: true, message: "ok", data: { providers } });

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const program = createProgram();
    await program.parseAsync(["node", "homerail", "--json", "provider", "list"]);

    const output = logSpy.mock.calls[0][0];
    const parsed = JSON.parse(output);
    expect(parsed.providers).toHaveLength(1);
    expect(parsed.providers[0].id).toBe("openai");
  });

  it("provider get prints details for a specific provider", async () => {
    mockFetch({
      success: true,
      message: "ok",
      data: {
        providers: [
          { id: "openai", name: "OpenAI", display_name: "OpenAI" },
          { id: "glm", name: "GLM", display_name: "ChatGLM" },
        ],
      },
    });

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const program = createProgram();
    await program.parseAsync(["node", "homerail", "provider", "get", "openai"]);

    const output = logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(output).toContain("openai");
    expect(output).toContain("OpenAI");
    expect(output).not.toContain("ChatGLM");
  });

  it("provider get reports error for unknown id", async () => {
    mockFetch({
      success: true,
      message: "ok",
      data: { providers: [{ id: "openai", name: "OpenAI" }] },
    });

    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const program = createProgram();
    await program.parseAsync(["node", "homerail", "provider", "get", "unknown"]);

    const output = errSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(output).toContain("not found");
    expect(process.exitCode).toBe(1);
  });

  it("provider upsert posts custom provider metadata", async () => {
    mockFetch({
      success: true,
      message: "Provider upserted",
      data: {
        id: "kimi-fast",
        name: "Kimi Fast",
        default_model: "kimi-for-coding",
        base_url: "https://api.kimi.com/coding/v1",
      },
    });

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const program = createProgram();
    await program.parseAsync([
      "node",
      "hr",
      "provider",
      "upsert",
      "--id",
      "kimi-fast",
      "--name",
      "Kimi Fast",
      "--default-model",
      "kimi-for-coding",
      "--provider-base-url",
      "https://api.kimi.com/coding/v1",
      "--chat-completions-base-url",
      "https://api.kimi.com/v1",
      "--responses-base-url",
      "https://api.kimi.com/responses",
      "--anthropic-base-url",
      "https://api.kimi.com/anthropic",
    ]);

    expect(globalThis.fetch).toHaveBeenCalledWith(
      "http://localhost:19191/api/llm/providers",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          id: "kimi-fast",
          name: "Kimi Fast",
          status: "active",
          default_model: "kimi-for-coding",
          supports_asr: false,
          supports_tts: false,
          supports_audio_input: false,
          base_url: "https://api.kimi.com/coding/v1",
          chat_completions_base_url: "https://api.kimi.com/v1",
          responses_base_url: "https://api.kimi.com/responses",
          anthropic_base_url: "https://api.kimi.com/anthropic",
        }),
      }),
    );

    const output = logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(output).toContain("kimi-fast");
  });
});

describe("llm-settings command", () => {
  it("reads piped API keys without requiring a trailing newline", async () => {
    const input = Readable.from(["pk-no-newline-secret"]);

    await expect(readLineFromStdin(input)).resolves.toBe("pk-no-newline-secret");
  });

  it("llm-settings list redacts api_key in human-readable output", async () => {
    mockFetch({
      success: true,
      message: "ok",
      data: {
        settings: [
          {
            id: "set-001",
            provider_id: "openai",
            model_name: "gpt-4",
            is_active: true,
            api_key: "pk-super-secret-key-12345",
          },
        ],
      },
    });

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const program = createProgram();
    await program.parseAsync(["node", "homerail", "llm-settings", "list"]);

    const output = logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(output).toContain("set-001");
    expect(output).toContain("gpt-4");
    expect(output).toContain("***REDACTED***");
    expect(output).not.toContain("pk-super-secret-key-12345");
  });

  it("llm-settings list --json redacts api_key", async () => {
    mockFetch({
      success: true,
      message: "ok",
      data: {
        settings: [
          {
            id: "set-001",
            provider_id: "openai",
            model_name: "gpt-4",
            api_key: "pk-super-secret-key-12345",
          },
        ],
      },
    });

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const program = createProgram();
    await program.parseAsync(["node", "homerail", "--json", "llm-settings", "list"]);

    const output = logSpy.mock.calls[0][0];
    const parsed = JSON.parse(output);
    expect(parsed.settings[0].api_key).toBe("***REDACTED***");
    expect(output).not.toContain("pk-super-secret-key-12345");
  });

  it("llm-settings add sends POST with api_key but does not echo it", async () => {
    mockFetch({
      success: true,
      message: "Setting created",
      data: { id: "set-new-001" },
    });

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const program = createProgram();
    await program.parseAsync([
      "node",
      "hr",
      "llm-settings",
      "add",
      "--provider-id",
      "openai",
      "--model-name",
      "gpt-4",
      "--api-key",
      "pk-super-secret-key-12345",
    ]);

    // Verify the POST was made with the key
    expect(globalThis.fetch).toHaveBeenCalledWith(
      "http://localhost:19191/api/llm/settings",
      expect.objectContaining({
        method: "POST",
        body: expect.stringContaining("pk-super-secret-key-12345"),
      }),
    );

    // Verify the key is NOT in console output
    const output = logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(output).toContain("set-new-001");
    expect(output).not.toContain("pk-super-secret-key-12345");
  });

  it("llm-settings add sends optional base_url", async () => {
    mockFetch({
      success: true,
      message: "Setting created",
      data: { id: "set-qwen-001" },
    });

    const program = createProgram();
    await program.parseAsync([
      "node",
      "hr",
      "llm-settings",
      "add",
      "--provider-id",
      "local-qwen-fast",
      "--model-name",
      "qwen3.6",
      "--model-base-url",
      "http://model-endpoint.test/v1",
      "--api-key",
      "local-key",
    ]);

    expect(globalThis.fetch).toHaveBeenCalledWith(
      "http://localhost:19191/api/llm/settings",
      expect.objectContaining({
        method: "POST",
        body: expect.stringContaining("http://model-endpoint.test/v1"),
      }),
    );
  });

  it("llm-settings add sends voice endpoint metadata", async () => {
    mockFetch({
      success: true,
      message: "Setting created",
      data: { id: "qwen-asr-setting", api_key: "secret-key" },
    });

    const program = createProgram();
    await program.parseAsync([
      "node",
      "hr",
      "llm-settings",
      "add",
      "--provider-id",
      "qwen36",
      "--model-name",
      "qwen3-asr-realtime",
      "--display-name",
      "Qwen Realtime ASR",
      "--endpoint-id",
      "qwen36_custom",
      "--endpoint-name",
      "Qwen Realtime ASR",
      "--plan-type",
      "custom",
      "--protocol",
      "custom",
      "--auth-type",
      "bearer",
      "--key-hint",
      "Local Qwen API key",
      "--model-base-url",
      "http://127.0.0.1:5000",
      "--asr-realtime-url",
      "ws://127.0.0.1:5002/v1/realtime",
      "--supports-asr",
      "--api-key",
      "secret-key",
    ]);

    const init = vi.mocked(globalThis.fetch).mock.calls[0][1] as RequestInit;
    expect(JSON.parse(String(init.body))).toMatchObject({
      provider_id: "qwen36",
      model_name: "qwen3-asr-realtime",
      display_name: "Qwen Realtime ASR",
      endpoint_id: "qwen36_custom",
      endpoint_name: "Qwen Realtime ASR",
      plan_type: "custom",
      protocol: "custom",
      auth_type: "bearer",
      key_hint: "Local Qwen API key",
      base_url: "http://127.0.0.1:5000",
      asr_realtime_url: "ws://127.0.0.1:5002/v1/realtime",
      supports_llm: false,
      supports_asr: true,
      supports_tts: false,
      api_key: "secret-key",
    });
  });

  it("llm-settings update sends patch fields and redacts API key output", async () => {
    mockFetch({
      success: true,
      message: "Setting updated",
      data: {
        id: "qwen-asr-setting",
        api_key: "secret-key",
        asr_realtime_url: "ws://127.0.0.1:5002/v1/realtime",
      },
    });

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const program = createProgram();
    await program.parseAsync([
      "node",
      "hr",
      "llm-settings",
      "update",
      "qwen-asr-setting",
      "--asr-realtime-url",
      "ws://127.0.0.1:5002/v1/realtime",
      "--supports-asr",
      "--no-supports-llm",
      "--inactive",
      "--no-default",
      "--api-key",
      "secret-key",
    ]);

    expect(globalThis.fetch).toHaveBeenCalledWith(
      "http://localhost:19191/api/llm/settings/qwen-asr-setting",
      expect.objectContaining({ method: "PUT" }),
    );
    const init = vi.mocked(globalThis.fetch).mock.calls[0][1] as RequestInit;
    expect(JSON.parse(String(init.body))).toMatchObject({
      asr_realtime_url: "ws://127.0.0.1:5002/v1/realtime",
      supports_asr: true,
      supports_llm: false,
      is_active: false,
      is_default: false,
      api_key: "secret-key",
    });
    const output = logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(output).not.toContain("secret-key");
  });

  it("llm-settings add uses HOMERAIL_API_KEY env var", async () => {
    const originalEnv = process.env.HOMERAIL_API_KEY;
    process.env.HOMERAIL_API_KEY = "pk-env-key-999";

    mockFetch({
      success: true,
      message: "Setting created",
      data: { id: "set-env-001" },
    });

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const program = createProgram();
    await program.parseAsync([
      "node",
      "hr",
      "llm-settings",
      "add",
      "--provider-id",
      "glm",
      "--model-name",
      "chatglm",
    ]);

    expect(globalThis.fetch).toHaveBeenCalledWith(
      "http://localhost:19191/api/llm/settings",
      expect.objectContaining({
        method: "POST",
        body: expect.stringContaining("pk-env-key-999"),
      }),
    );

    const output = logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(output).not.toContain("pk-env-key-999");

    if (originalEnv === undefined) {
      delete process.env.HOMERAIL_API_KEY;
    } else {
      process.env.HOMERAIL_API_KEY = originalEnv;
    }
  });

  it("llm-settings delete removes a setting", async () => {
    mockFetch({ success: true, message: "Setting deleted" });

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const program = createProgram();
    await program.parseAsync([
      "node",
      "hr",
      "llm-settings",
      "delete",
      "set-001",
    ]);

    const output = logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(output).toContain("set-001");
    expect(output).toContain("deleted");

    expect(globalThis.fetch).toHaveBeenCalledWith(
      "http://localhost:19191/api/llm/settings/set-001",
      expect.objectContaining({ method: "DELETE" }),
    );
  });

  it("llm-settings get shows redacted details", async () => {
    mockFetch({
      success: true,
      message: "ok",
      data: {
        settings: [
          {
            id: "set-001",
            provider_id: "openai",
            model_name: "gpt-4",
            api_key: "pk-super-secret-key-12345",
          },
        ],
      },
    });

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const program = createProgram();
    await program.parseAsync(["node", "homerail", "llm-settings", "get", "set-001"]);

    const output = logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(output).toContain("set-001");
    expect(output).toContain("***REDACTED***");
    expect(output).not.toContain("pk-super-secret-key-12345");
  });

  it("llm-settings get --json shows redacted details", async () => {
    mockFetch({
      success: true,
      message: "ok",
      data: {
        settings: [
          {
            id: "set-002",
            provider_id: "glm",
            model_name: "chatglm",
            api_key: "pk-another-secret-67890",
          },
        ],
      },
    });

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const program = createProgram();
    await program.parseAsync(["node", "homerail", "--json", "llm-settings", "get", "set-002"]);

    const output = logSpy.mock.calls[0][0];
    expect(output).not.toContain("pk-another-secret-67890");
    const parsed = JSON.parse(output);
    expect(parsed.api_key).toBe("***REDACTED***");
  });
});

describe("voice command", () => {
  it("configures current ASR setting with realtime URL", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          success: true,
          data: {
            recognition_mode: "asr",
            llm_base_url: "http://llm.local",
            llm_model: "qwen3.6",
            llm_setting_id: "llm-1",
            asr_base_url: "https://api.xiaomimimo.com/v1",
            asr_realtime_url: "/api/voice/asr/realtime",
            asr_model: "mimo-v2.5-asr",
            asr_llm_setting_id: "mimo-asr",
            asr_token_set: true,
            tts_base_url: "https://api.xiaomimimo.com/v1",
            tts_model: "mimo-v2.5-tts",
            tts_llm_setting_id: "tts-1",
            tts_voice: "mimo_default",
            tts_speed: null,
            tts_stream: false,
            tts_output_channels: ["commentary", "final"],
          },
        }),
      } as unknown as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          success: true,
          data: {
            settings: [
              {
                id: "qwen-asr",
                provider_id: "qwen36",
                model_name: "qwen3-asr-realtime",
                display_name: "Qwen Realtime ASR",
                base_url: "http://127.0.0.1:5000",
                asr_realtime_url: "ws://127.0.0.1:5002/v1/realtime",
                is_active: true,
                supports_asr: true,
              },
            ],
          },
        }),
      } as unknown as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          success: true,
          data: {
            recognition_mode: "asr",
            asr_base_url: "http://127.0.0.1:5000",
            asr_realtime_url: "ws://127.0.0.1:5002/v1/realtime",
            asr_model: "qwen3-asr-realtime",
            asr_llm_setting_id: "qwen-asr",
            tts_output_channels: ["final"],
          },
        }),
      } as unknown as Response);

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const program = createProgram();
    await program.parseAsync([
      "node",
      "hr",
      "voice",
      "configure",
      "--asr-setting-id",
      "qwen-asr",
      "--tts-output-channel",
      "final",
    ]);

    expect(globalThis.fetch).toHaveBeenNthCalledWith(
      3,
      "http://localhost:19191/api/voice",
      expect.objectContaining({ method: "PUT" }),
    );
    const putInit = vi.mocked(globalThis.fetch).mock.calls[2][1] as RequestInit;
    expect(JSON.parse(String(putInit.body))).toMatchObject({
      recognition_mode: "asr",
      asr_base_url: "http://127.0.0.1:5000",
      asr_realtime_url: "ws://127.0.0.1:5002/v1/realtime",
      asr_model: "qwen3-asr-realtime",
      asr_llm_setting_id: "qwen-asr",
      tts_output_channels: ["final"],
    });
    expect(String(putInit.body)).not.toContain("asr_token_set");
    expect(logSpy.mock.calls.map((c) => c.join(" ")).join("\n")).toContain("qwen3-asr-realtime");
  });

  it("rejects using an LLM-only setting as ASR", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ success: true, data: { recognition_mode: "asr" } }),
      } as unknown as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          success: true,
          data: {
            settings: [
              {
                id: "qwen-llm",
                provider_id: "qwen36",
                model_name: "qwen3.6",
                is_active: true,
                supports_llm: true,
                supports_asr: false,
              },
            ],
          },
        }),
      } as unknown as Response);

    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const program = createProgram();
    await program.parseAsync([
      "node",
      "hr",
      "voice",
      "configure",
      "--asr-setting-id",
      "qwen-llm",
    ]);

    expect(process.exitCode).toBe(1);
    expect(errSpy.mock.calls.map((c) => c.join(" ")).join("\n")).toContain("supports_asr=false");
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
  });
});

describe("model command", () => {
  it("configures a custom provider without echoing the API key", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          success: true,
          message: "Found providers",
          data: { providers: [] },
        }),
      } as unknown as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          success: true,
          message: "Provider upserted",
          data: { id: "local-harness" },
        }),
      } as unknown as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          success: true,
          message: "Setting created",
          data: { id: "local-setting", api_key: "secret-key" },
        }),
      } as unknown as Response);

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const program = createProgram();
    await program.parseAsync([
      "node",
      "hr",
      "model",
      "configure",
      "local-harness",
      "--model-name",
      "local-model",
      "--chat-completions-endpoint",
      "http://model-endpoint.test/v1",
      "--api-key",
      "secret-key",
    ]);

    expect(globalThis.fetch).toHaveBeenNthCalledWith(
      1,
      "http://localhost:19191/api/llm/providers",
      expect.objectContaining({ method: "GET" }),
    );
    expect(globalThis.fetch).toHaveBeenNthCalledWith(
      2,
      "http://localhost:19191/api/llm/providers",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          id: "local-harness",
          name: "local-harness",
          status: "active",
          default_model: "local-model",
          base_url: "http://model-endpoint.test/v1",
          chat_completions_base_url: "http://model-endpoint.test/v1",
          supports_llm: true,
        }),
      }),
    );
    expect(globalThis.fetch).toHaveBeenNthCalledWith(
      3,
      "http://localhost:19191/api/llm/settings",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          provider_id: "local-harness",
          model_name: "local-model",
          endpoint_id: "custom",
          plan_type: "custom",
          protocol: "openai_compatible",
          base_url: "http://model-endpoint.test/v1",
          chat_completions_base_url: "http://model-endpoint.test/v1",
          api_key: "secret-key",
          is_active: true,
          is_default: true,
          supports_llm: true,
        }),
      }),
    );

    const output = logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(output).toContain("local-harness/local-model");
    expect(output).not.toContain("secret-key");
  });

  it("configures custom protocol endpoints independently", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          success: true,
          message: "Found providers",
          data: { providers: [] },
        }),
      } as unknown as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          success: true,
          message: "Provider upserted",
          data: { id: "local-harness" },
        }),
      } as unknown as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          success: true,
          message: "Setting created",
          data: { id: "local-setting", api_key: "secret-key" },
        }),
      } as unknown as Response);

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const program = createProgram();
    await program.parseAsync([
      "node",
      "hr",
      "model",
      "configure",
      "local-harness",
      "--model-name",
      "local-model",
      "--chat-completions-endpoint",
      "http://chat-endpoint.test/v1",
      "--responses-endpoint",
      "http://responses-endpoint.test/v1",
      "--anthropic-endpoint",
      "http://anthropic-endpoint.test",
      "--api-key",
      "secret-key",
    ]);

    expect(globalThis.fetch).toHaveBeenNthCalledWith(
      2,
      "http://localhost:19191/api/llm/providers",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          id: "local-harness",
          name: "local-harness",
          status: "active",
          default_model: "local-model",
          base_url: "http://chat-endpoint.test/v1",
          chat_completions_base_url: "http://chat-endpoint.test/v1",
          responses_base_url: "http://responses-endpoint.test/v1",
          anthropic_base_url: "http://anthropic-endpoint.test",
          supports_llm: true,
        }),
      }),
    );
    expect(globalThis.fetch).toHaveBeenNthCalledWith(
      3,
      "http://localhost:19191/api/llm/settings",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          provider_id: "local-harness",
          model_name: "local-model",
          endpoint_id: "custom",
          plan_type: "custom",
          protocol: "openai_compatible",
          base_url: "http://chat-endpoint.test/v1",
          chat_completions_base_url: "http://chat-endpoint.test/v1",
          responses_base_url: "http://responses-endpoint.test/v1",
          anthropic_base_url: "http://anthropic-endpoint.test",
          api_key: "secret-key",
          is_active: true,
          is_default: true,
          supports_llm: true,
        }),
      }),
    );

    const output = logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(output).toContain("local-harness/local-model");
    expect(output).not.toContain("secret-key");
  });

  it("requires an API key for catalog/custom model configuration", async () => {
    const originalEnv = process.env.HOMERAIL_API_KEY;
    const originalHomeRailHome = process.env.HOMERAIL_HOME;
    const tempHome = mkdtempSync(join(tmpdir(), "homerail-cli-model-test-"));
    delete process.env.HOMERAIL_API_KEY;
    process.env.HOMERAIL_HOME = tempHome;
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        success: true,
        message: "Found providers",
        data: { providers: [] },
      }),
    } as unknown as Response);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const program = createProgram();

    try {
      await program.parseAsync([
        "node",
        "homerail",
        "model",
        "configure",
        "local-harness",
        "--model-name",
        "local-model",
        "--chat-completions-endpoint",
        "http://model-endpoint.test/v1",
      ]);

      expect(errSpy.mock.calls.map((c) => c.join(" ")).join("\n")).toContain(
        "API key is required",
      );
      expect(process.exitCode).toBe(1);
    } finally {
      if (originalEnv === undefined) delete process.env.HOMERAIL_API_KEY;
      else process.env.HOMERAIL_API_KEY = originalEnv;
      if (originalHomeRailHome === undefined) delete process.env.HOMERAIL_HOME;
      else process.env.HOMERAIL_HOME = originalHomeRailHome;
      rmSync(tempHome, { recursive: true, force: true });
    }
  });

  it("configures a catalog endpoint alias without echoing the API key", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          success: true,
          message: "Found providers",
          data: {
            providers: [
              {
                id: "catalog-provider",
                endpoints: [
                  {
                    id: "catalog_endpoint",
                    plan_type: "token_plan",
                    protocol: "openai_compatible",
                    auth_type: "bearer",
                    base_url: "https://catalog.example.test/v1",
                    chat_completions_base_url: "https://catalog.example.test/v1",
                    anthropic_base_url: "https://catalog.example.test/anthropic",
                    default_model: "catalog-model",
                    key_hint: "Catalog provider key",
                    models: [{ id: "catalog-model", recommended: true }],
                  },
                ],
              },
            ],
          },
        }),
      } as unknown as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          success: true,
          message: "Setting created",
          data: { id: "catalog-setting", api_key: "catalog-secret-key" },
        }),
      } as unknown as Response);

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const program = createProgram();
    await program.parseAsync([
      "node",
      "hr",
      "model",
      "configure",
      "catalog_endpoint",
      "--api-key",
      "catalog-secret-key",
    ]);

    expect(globalThis.fetch).toHaveBeenNthCalledWith(
      1,
      "http://localhost:19191/api/llm/providers",
      expect.objectContaining({ method: "GET" }),
    );
    expect(globalThis.fetch).toHaveBeenNthCalledWith(
      2,
      "http://localhost:19191/api/llm/settings",
      expect.objectContaining({
        method: "POST",
      }),
    );
    const postInit = vi.mocked(globalThis.fetch).mock.calls[1][1] as RequestInit;
    expect(JSON.parse(String(postInit.body))).toMatchObject({
      provider_id: "catalog-provider",
      model_name: "catalog-model",
      endpoint_id: "catalog_endpoint",
      plan_type: "token_plan",
      protocol: "openai_compatible",
      auth_type: "bearer",
      key_hint: "Catalog provider key",
      base_url: "https://catalog.example.test/v1",
      chat_completions_base_url: "https://catalog.example.test/v1",
      anthropic_base_url: "https://catalog.example.test/anthropic",
      api_key: "catalog-secret-key",
      is_active: true,
      is_default: true,
      supports_llm: true,
    });

    const output = logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(output).toContain("catalog-provider/catalog-model");
    expect(output).not.toContain("catalog-secret-key");
  });

  it("reports incomplete custom model configuration", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        success: true,
        message: "Found providers",
        data: { providers: [] },
      }),
    } as unknown as Response);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const program = createProgram();
    await program.parseAsync(["node", "homerail", "model", "configure", "unknown"]);

    expect(errSpy.mock.calls.map((c) => c.join(" ")).join("\n")).toContain(
      "requires --model-name",
    );
    expect(process.exitCode).toBe(1);
  });
});

describe("doctor command", () => {
  it("passes when manager, runtime, and an active setting are available", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ status: "ok" }),
      } as unknown as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ connected_nodes: 1, connected_workers: 1, active_runs: 0 }),
      } as unknown as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          success: true,
          data: {
            settings: [
              {
                provider_id: "catalog-provider",
                model_name: "catalog-model",
                is_active: true,
                supports_llm: true,
                anthropic_base_url: "https://catalog.example.test/anthropic",
              },
            ],
          },
        }),
      } as unknown as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          success: true,
          data: {
            harness: "claude_agent_sdk",
            provider_name: "catalog-provider",
            model_name: "catalog-model",
          },
        }),
      } as unknown as Response);

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const program = createProgram();
    await program.parseAsync(["node", "homerail", "doctor"]);

    const output = logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(output).toContain("PASS manager");
    expect(output).toContain("PASS node");
    expect(output).toContain("PASS model");
    expect(output).toContain("catalog-provider/catalog-model");
    expect(output).toContain("HomeRail is ready.");
  });
});

describe("runtime command", () => {
  it("detects missing, forced, and stale worker images from the source fingerprint", () => {
    expect(workerImageBuildReason(false, undefined, "source")).toBe("missing");
    expect(workerImageBuildReason(true, "source", "source", true)).toBe("forced");
    expect(workerImageBuildReason(true, "", "source")).toBe("stale");
    expect(workerImageBuildReason(true, "<no value>", "source")).toBe("stale");
    expect(workerImageBuildReason(true, "old", "source")).toBe("stale");
    expect(workerImageBuildReason(true, "source", "source")).toBeNull();
  });

  it("changes the worker image source fingerprint when worker sources change", () => {
    const repoRoot = join(tempHome, "repo");
    mkdirSync(join(repoRoot, "homerail_worker", "src"), { recursive: true });
    mkdirSync(join(repoRoot, "homerail_protocol", "src"), { recursive: true });
    writeFileSync(join(repoRoot, "homerail_worker", "Dockerfile"), "FROM node:22-slim\n");
    writeFileSync(join(repoRoot, "homerail_worker", "package.json"), "{}\n");
    writeFileSync(join(repoRoot, "homerail_worker", "tsconfig.json"), "{}\n");
    writeFileSync(join(repoRoot, "homerail_worker", "src", "index.ts"), "export const worker = 1;\n");
    writeFileSync(join(repoRoot, "homerail_protocol", "package.json"), "{}\n");
    writeFileSync(join(repoRoot, "homerail_protocol", "tsconfig.json"), "{}\n");
    writeFileSync(join(repoRoot, "homerail_protocol", "src", "index.ts"), "export const protocol = 1;\n");

    const first = workerImageSourceFingerprint(repoRoot);
    writeFileSync(join(repoRoot, "homerail_worker", "src", "index.ts"), "export const worker = 2;\n");
    const second = workerImageSourceFingerprint(repoRoot);

    expect(first).toMatch(/^[a-f0-9]{16}$/);
    expect(second).toMatch(/^[a-f0-9]{16}$/);
    expect(second).not.toBe(first);
  });

  it("does not expose fixed host Worker startup through homerail start", () => {
    const program = createProgram();
    const startCommand = program.commands.find((command) => command.name() === "start");

    expect(startCommand?.options.map((option) => option.long)).not.toContain("--host-worker");
    expect(startCommand?.options.map((option) => option.long)).toContain("--rebuild-worker-image");
    expect(startCommand?.options.map((option) => option.long)).toContain("--host");
    expect(startCommand?.options.map((option) => option.long)).toContain("--public");
    expect(startCommand?.options.map((option) => option.long)).toContain("--public-url");
    expect(startCommand?.options.map((option) => option.long)).toContain("--ui");
    expect(startCommand?.options.map((option) => option.long)).toContain("--ui-public-url");
    expect(startCommand?.options.map((option) => option.long)).toContain("--enable-text-mode");
  });

  it("exposes Agent UI lifecycle commands", () => {
    const program = createProgram();
    const uiCommand = program.commands.find((command) => command.name() === "ui");
    const uiStartCommand = uiCommand?.commands.find((command) => command.name() === "start");

    expect(uiCommand?.commands.map((command) => command.name())).toEqual([
      "start",
      "status",
      "stop",
      "logs",
    ]);
    expect(uiStartCommand?.options.map((option) => option.long)).toContain("--public");
    expect(uiStartCommand?.options.map((option) => option.long)).toContain("--enable-text-mode");
  });

  it("exposes a unified runtime service lifecycle command surface", () => {
    const program = createProgram();
    const runtimeCommand = program.commands.find((command) => command.name() === "runtime");

    expect(runtimeCommand?.commands.map((command) => command.name())).toEqual([
      "status",
      "stop",
      "restart",
      "logs",
      "install",
      "uninstall",
      "delete-service",
    ]);
    expect(runtimeCommand?.commands.find((command) => command.name() === "install")?.aliases()).toContain("register");
    expect(runtimeCommand?.commands.find((command) => command.name() === "uninstall")?.aliases()).toContain("unregister");
  });

  it("exposes Docker readiness checks through doctor", () => {
    const program = createProgram();
    const doctorCommand = program.commands.find((command) => command.name() === "doctor");

    expect(doctorCommand?.options.map((option) => option.long)).toContain("--docker");
  });

  it("reports the default Agent UI port in JSON status", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const program = createProgram();

    await program.parseAsync(["node", "homerail", "--json", "ui", "status"]);

    const parsed = JSON.parse(logSpy.mock.calls[0][0]);
    expect(parsed.uiPort).toBe(19192);
    expect(parsed.uiUrl).toBe("https://localhost:19192");
    expect(parsed.uiHost).toBe("127.0.0.1");
    expect(parsed.uiHttpsPort).toBe(19192);
    expect(parsed.uiHttpPort).toBe(19193);
    expect(parsed.uiTextModeEnabled).toBe(false);
    expect(parsed.uiPidRunning).toBe(false);
    expect(parsed.uiHttpsPidRunning).toBe(false);
    expect(parsed.uiHttpPidRunning).toBe(false);
  });

  it("reports the Agent UI port from persisted service state", async () => {
    const pidsDir = join(tempHome, "pids");
    mkdirSync(pidsDir, { recursive: true });
    writeFileSync(join(pidsDir, "ui-https.pid"), `${process.pid}\n`);
    writeFileSync(join(pidsDir, "ui-https.json"), JSON.stringify({
      pid: process.pid,
      host: "127.0.0.1",
      port: 19292,
      protocol: "https",
      managerUrl: "http://localhost:19191",
      publicUrl: "https://homerail.example.test/ui",
      textModeEnabled: true,
      startedAt: Date.now(),
    }));
    writeFileSync(join(pidsDir, "ui.pid"), `${process.pid}\n`);
    writeFileSync(join(pidsDir, "ui.json"), JSON.stringify({
      pid: process.pid,
      host: "127.0.0.1",
      port: 19293,
      protocol: "http",
      managerUrl: "http://localhost:19191",
      publicUrl: "http://homerail.example.test/ui",
      textModeEnabled: true,
      startedAt: Date.now(),
    }));
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const program = createProgram();

    await program.parseAsync(["node", "homerail", "--json", "ui", "status"]);

    const parsed = JSON.parse(logSpy.mock.calls[0][0]);
    expect(parsed.uiPid).toBe(process.pid);
    expect(parsed.uiPidRunning).toBe(true);
    expect(parsed.uiPort).toBe(19292);
    expect(parsed.uiUrl).toBe("https://homerail.example.test/ui");
    expect(parsed.uiPublicUrl).toBe("https://homerail.example.test/ui");
    expect(parsed.uiHttpsPort).toBe(19292);
    expect(parsed.uiHttpPort).toBe(19293);
    expect(parsed.uiHttpUrl).toBe("http://homerail.example.test/ui");
    expect(parsed.uiTextModeEnabled).toBe(true);
  });

  it("reports HTTP as the active Agent UI URL when HTTPS is unavailable", async () => {
    const pidsDir = join(tempHome, "pids");
    mkdirSync(pidsDir, { recursive: true });
    writeFileSync(join(pidsDir, "ui.pid"), `${process.pid}\n`);
    writeFileSync(join(pidsDir, "ui.json"), JSON.stringify({
      pid: process.pid,
      host: "127.0.0.1",
      port: 19293,
      protocol: "http",
      managerUrl: "http://localhost:19191",
      publicUrl: "http://homerail.example.test/ui",
      textModeEnabled: true,
      startedAt: Date.now(),
    }));
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const program = createProgram();

    await program.parseAsync(["node", "homerail", "--json", "ui", "status"]);

    const parsed = JSON.parse(logSpy.mock.calls[0][0]);
    expect(parsed.uiPid).toBe(process.pid);
    expect(parsed.uiPidRunning).toBe(true);
    expect(parsed.uiHttpsPidRunning).toBe(false);
    expect(parsed.uiHttpPidRunning).toBe(true);
    expect(parsed.uiUrl).toBe("http://homerail.example.test/ui");
    expect(parsed.uiPublicUrl).toBe("http://homerail.example.test/ui");
  });

  it("uses local HTTPS and HTTP URLs for public UI bind without an explicit public URL", async () => {
    process.env.HOMERAIL_PUBLIC_HOST = "192.0.2.10";
    const pidsDir = join(tempHome, "pids");
    mkdirSync(pidsDir, { recursive: true });
    writeFileSync(join(pidsDir, "ui-https.pid"), `${process.pid}\n`);
    writeFileSync(join(pidsDir, "ui-https.json"), JSON.stringify({
      pid: process.pid,
      host: "0.0.0.0",
      port: 19192,
      protocol: "https",
      managerUrl: "https://homerail.example.test",
      startedAt: Date.now(),
    }));
    writeFileSync(join(pidsDir, "ui.pid"), `${process.pid}\n`);
    writeFileSync(join(pidsDir, "ui.json"), JSON.stringify({
      pid: process.pid,
      host: "0.0.0.0",
      port: 19193,
      protocol: "http",
      managerUrl: "https://homerail.example.test",
      startedAt: Date.now(),
    }));
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const program = createProgram();

    await program.parseAsync(["node", "homerail", "--json", "ui", "status"]);

    const parsed = JSON.parse(logSpy.mock.calls[0][0]);
    expect(parsed.uiHost).toBe("0.0.0.0");
    expect(parsed.uiUrl).toBe("https://192.0.2.10:19192");
    expect(parsed.uiPublicUrl).toBe("https://192.0.2.10:19192");
    expect(parsed.uiHttpUrl).toBe("http://192.0.2.10:19193");
    expect(parsed.uiHttpPublicUrl).toBe("http://192.0.2.10:19193");
  });

  it("reports Manager bind host and access URL in runtime status", async () => {
    mockFetch({ success: true, data: { connected_nodes: 0, connected_workers: 0 } });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const program = createProgram();

    await program.parseAsync(["node", "homerail", "--json", "runtime", "status"]);

    const parsed = JSON.parse(logSpy.mock.calls[0][0]);
    expect(parsed.managerBindHost).toBe("127.0.0.1");
    expect(parsed.managerAccessUrl).toBe("http://localhost:19191");
    expect(parsed.uiBindHost).toBe("127.0.0.1");
    expect(parsed.serviceControl.service_id).toBe("homerail-runtime");
    expect(parsed.services.map((service: { id: string }) => service.id)).toEqual([
      "manager",
      "node",
      "ui-https",
      "ui-http",
      "worker-image",
    ]);
  });

  it("reports Manager bind host and access URL from persisted service state", async () => {
    const pidsDir = join(tempHome, "pids");
    mkdirSync(pidsDir, { recursive: true });
    writeFileSync(join(pidsDir, "manager.pid"), `${process.pid}\n`);
    writeFileSync(join(pidsDir, "manager.json"), JSON.stringify({
      pid: process.pid,
      host: "0.0.0.0",
      port: 19191,
      accessUrl: "http://localhost:19191",
      publicUrl: "https://homerail.example.test",
      startedAt: Date.now(),
    }));
    mockFetch({ success: true, data: { connected_nodes: 0, connected_workers: 0 } });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const program = createProgram();

    await program.parseAsync(["node", "homerail", "--json", "runtime", "status"]);

    const parsed = JSON.parse(logSpy.mock.calls[0][0]);
    expect(parsed.managerPid).toBe(process.pid);
    expect(parsed.managerPidRunning).toBe(true);
    expect(parsed.managerBindHost).toBe("0.0.0.0");
    expect(parsed.managerUrl).toBe("http://localhost:19191");
    expect(parsed.managerAccessUrl).toBe("https://homerail.example.test");
    expect(parsed.managerPublicUrl).toBe("https://homerail.example.test");
  });

  it("aborts start when stored model config cannot be applied", () => {
    expect(shouldAbortStartForModelConfig({
      applied: false,
      action: "failed",
      detail: "Unknown provider_id: local-qwen-fast",
    })).toBe(true);

    expect(shouldAbortStartForModelConfig({
      applied: false,
      action: "skipped",
      detail: "no model config",
    })).toBe(false);

    expect(shouldAbortStartForModelConfig({
      applied: false,
      action: "failed",
      detail: "API key is required. Use --api-key or set HOMERAIL_PROVIDER_API_KEY.",
    })).toBe(false);
  });

  it("detects missing model credentials as a first-run configuration gap", () => {
    expect(isMissingModelCredential("API key is required. Use --api-key or set HOMERAIL_PROVIDER_API_KEY.")).toBe(true);
    expect(isMissingModelCredential("Unknown provider_id: local-qwen-fast")).toBe(false);
  });

  it("renders and manages a macOS LaunchAgent service definition without loading it", () => {
    const plist = createLaunchAgentPlist({
      homerailHome: tempHome,
      homeDir: tempHome,
      repoRoot: "/repo/HomeRail",
      cliPath: "/repo/HomeRail/homerail_cli/dist/cli.js",
      nodePath: "/opt/homebrew/bin/node",
    });
    expect(plist).toContain("com.homerail.runtime");
    expect(plist).toContain("<string>/opt/homebrew/bin/node</string>");
    expect(plist).toContain("<string>/repo/HomeRail/homerail_cli/dist/cli.js</string>");
    expect(plist).toContain("<string>start</string>");
    expect(plist).toContain("<string>--ui</string>");
    expect(plist).toContain("<key>HOMERAIL_HOME</key>");
    expect(plist).toContain(tempHome);

    const installed = installRuntimeService({
      platform: "darwin",
      homerailHome: tempHome,
      homeDir: tempHome,
      repoRoot: "/repo/HomeRail",
      cliPath: "/repo/HomeRail/homerail_cli/dist/cli.js",
      nodePath: "/opt/homebrew/bin/node",
      load: false,
    });
    expect(installed.loaded).toBe(false);
    expect(installed.status.installed).toBe(true);
    expect(existsSync(installed.status.config_path)).toBe(true);

    const uninstalled = uninstallRuntimeService({
      platform: "darwin",
      homerailHome: tempHome,
      homeDir: tempHome,
      unload: false,
    });
    expect(uninstalled.unloaded).toBe(false);
    expect(uninstalled.status.installed).toBe(false);
    expect(existsSync(installed.status.config_path)).toBe(false);
  });

  it("explains missing Docker before worker image build", () => {
    expect(dockerMissingMessage("docker")).toContain("Docker CLI was not found");
    expect(dockerMissingMessage("docker")).toContain("HOMERAIL_DOCKER_BIN");
    expect(dockerMissingMessage()).toContain("hr start --no-build-worker-image");
  });

  it("builds the worker image without inheriting a Windows console", () => {
    const options = workerImageDockerBuildSpawnOptions();
    expect(options.stdio).toEqual(["ignore", "pipe", "pipe"]);
    expect(options.shell).toBe(false);
    expect(options.windowsHide).toBe(true);
    expect(options).not.toHaveProperty("maxBuffer");
    expect(options.env?.HOMERAIL_HOME).toBe(tempHome);
  });

  it("streams worker image build output without buffering it", async () => {
    class FakeChildProcess extends EventEmitter {
      stdin = new PassThrough();
      stdout = new PassThrough();
      stderr = new PassThrough();
    }
    const child = new FakeChildProcess();
    let stdout = "";
    let stderr = "";
    const build = runWorkerImageDockerBuild(
      "docker",
      ["build", "."],
      (() => child as unknown as ChildProcessWithoutNullStreams) as typeof spawn,
      (chunk) => { stdout += chunk.toString(); },
      (chunk) => { stderr += chunk.toString(); },
    );

    child.stdout.write("build output\n");
    child.stderr.write("build warning\n");
    child.emit("close", 0, null);

    await build;
    expect(stdout).toBe("build output\n");
    expect(stderr).toBe("build warning\n");
  });

  it("reports worker image build exit failures after streaming output", async () => {
    class FakeChildProcess extends EventEmitter {
      stdin = new PassThrough();
      stdout = new PassThrough();
      stderr = new PassThrough();
    }
    const child = new FakeChildProcess();
    let stderr = "";
    const build = runWorkerImageDockerBuild(
      "docker",
      ["build", "."],
      (() => child as unknown as ChildProcessWithoutNullStreams) as typeof spawn,
      () => {},
      (chunk) => { stderr += chunk.toString(); },
    );

    child.stderr.write("docker failed\n");
    child.emit("close", 17, null);

    await expect(build).rejects.toThrow("failed to build homerail-worker:latest (exit code 17)");
    expect(stderr).toBe("docker failed\n");
  });

  it("launches the Agent UI dev server directly through Node", () => {
    const uiDir = join(tempHome, "agent-ui");
    const command = agentUiDevServerCommand(uiDir);

    expect(command.command).toBe(process.execPath);
    expect(command.args).toEqual([join(uiDir, "node_modules", "vite", "bin", "vite.js")]);
    expect(command.command.toLowerCase()).not.toMatch(/\.(cmd|bat)$/);
  });

  it("serves prebuilt Agent UI statically on Windows when dist exists", () => {
    const uiDir = join(tempHome, "agent-ui");
    mkdirSync(join(uiDir, "dist"), { recursive: true });
    mkdirSync(join(uiDir, "node_modules"), { recursive: true });
    writeFileSync(join(uiDir, "dist", "index.html"), "<!doctype html>");

    expect(shouldServeStaticAgentUi(uiDir, "win32")).toBe(true);
  });

  it("allows forcing Agent UI dev server mode", () => {
    const uiDir = join(tempHome, "agent-ui");
    mkdirSync(join(uiDir, "dist"), { recursive: true });
    writeFileSync(join(uiDir, "dist", "index.html"), "<!doctype html>");
    process.env.HOMERAIL_UI_SERVE_STATIC = "0";

    expect(shouldServeStaticAgentUi(uiDir, "win32")).toBe(false);
  });
});

describe("dag handoffs command", () => {
  it("prints persisted handoff content from the manager API", async () => {
    mockFetch({
      success: true,
      message: "ok",
      data: {
        handoffs: [
          {
            fromNode: "plan",
            port: "planned",
            content: "public smoke handoff",
          },
        ],
      },
    });

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const program = createProgram();
    await program.parseAsync(["node", "homerail", "dag", "handoffs", "run-123"]);

    const output = logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(output).toContain("handoff from plan:planned");
    expect(output).toContain("public smoke handoff");
    expect(globalThis.fetch).toHaveBeenCalledWith(
      "http://localhost:19191/api/runs/run-123/handoffs",
      expect.objectContaining({ method: "GET" }),
    );
  });
});

describe("dag chats command", () => {
  function mockDagChatsFetch(): void {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          success: true,
          message: "Run status retrieved",
          data: { status: "completed" },
        }),
      } as unknown as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          success: true,
          message: "DAG status retrieved",
          data: {
            status: "completed",
            execution: {
              nodes: { diagnose: { status: "completed" } },
              ready_nodes: [],
              failed_nodes: [],
            },
          },
        }),
      } as unknown as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          success: true,
          message: "Events retrieved",
          data: { events: [] },
        }),
      } as unknown as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          success: true,
          message: "Chat history retrieved",
          data: {
            messages: [
              {
                role: "worker",
                type: "response",
                content: {
                  type: "tool_use",
                  event: "tool_use",
                  tool_name: "Bash",
                  tool_id: "tool-1",
                  tool_input: {
                    command: "node homerail_cli/dist/cli.js doctor",
                    token: "***REDACTED***",
                  },
                },
              },
              {
                role: "worker",
                type: "response",
                content: {
                  type: "tool_result",
                  event: "tool_result",
                  tool_use_id: "tool-1",
                  is_error: false,
                  result_preview: "Doctor checks passed token=***REDACTED***",
                },
              },
            ],
          },
        }),
      } as unknown as Response);
  }

  it("prints redacted tool command details with --raw-tools", async () => {
    mockDagChatsFetch();

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const program = createProgram();
    await program.parseAsync(["node", "homerail", "dag", "chats", "run-raw", "--raw-tools"]);

    const output = logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(output).toContain("Bash: node homerail_cli/dist/cli.js doctor");
    expect(output).toContain("result_error=no");
    expect(output).toContain("Doctor checks passed token=***REDACTED***");
  });
});

describe("smoke command", () => {
  it("runs the Windows smoke DAG after runtime preflight", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          runtime: "homerail_manager",
          connected_nodes: 1,
          node_ids: ["local-docker-node"],
          node_capabilities: { "local-docker-node": ["docker-cli"] },
        }),
      } as unknown as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          success: true,
          message: "Run started",
          data: { run_id: "windows-smoke-run-1" },
        }),
      } as unknown as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          success: true,
          message: "Run status retrieved",
          data: { status: "completed" },
        }),
      } as unknown as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          success: true,
          message: "Scorecard retrieved",
          data: { passed: true, score: 5, total: 5 },
        }),
      } as unknown as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          success: true,
          message: "Eval report retrieved",
          data: { verdict: "pass" },
        }),
      } as unknown as Response);

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const program = createProgram();
    await program.parseAsync([
      "node",
      "hr",
      "smoke",
      "windows",
      "--no-docker-check",
      "--interval",
      "0",
      "--timeout",
      "1",
    ]);

    const output = logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(output).toContain("Windows smoke preflight: PASS");
    expect(output).toContain("Smoke DAG started: windows-smoke-run-1");
    expect(output).toContain("Final status: completed");
    expect(process.exitCode).toBeUndefined();
    expect(globalThis.fetch).toHaveBeenCalledWith(
      "http://localhost:19191/api/runs/create-and-run",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          yamlPath: "assets/orchestrations/public-two-node.yaml.template",
          prompt: "Draft a short checklist for a Windows HomeRail runtime smoke.",
          profile: "offline-deterministic",
        }),
      }),
    );
  });

  it("fails Windows smoke preflight without a Docker-capable node", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          runtime: "homerail_manager",
          connected_nodes: 1,
          node_ids: ["plain-node"],
          node_capabilities: { "plain-node": ["browser"] },
        }),
      } as unknown as Response);

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const program = createProgram();
    await program.parseAsync([
      "node",
      "hr",
      "smoke",
      "windows",
      "--no-docker-check",
    ]);

    const output = logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(output).toContain("Windows smoke preflight: FAIL");
    expect(output).toContain("FAIL docker-node");
    expect(process.exitCode).toBe(1);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  it("waits for an explicit DAG smoke run and checks scorecard plus eval-run", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          success: true,
          message: "Run started",
          data: { run_id: "smoke-run-1" },
        }),
      } as unknown as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          success: true,
          message: "Run status retrieved",
          data: { status: "completed" },
        }),
      } as unknown as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          success: true,
          message: "Scorecard retrieved",
          data: { passed: true, score: 10, total: 11 },
        }),
      } as unknown as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          success: true,
          message: "Eval report retrieved",
          data: { verdict: "pass" },
        }),
      } as unknown as Response);

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const program = createProgram();
    await program.parseAsync([
      "node",
      "hr",
      "smoke",
      "dag",
      "--template",
      "assets/orchestrations/public-dev-5node.yaml.template",
      "--interval",
      "0",
      "--timeout",
      "1",
    ]);

    const output = logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(output).toContain("Smoke DAG started: smoke-run-1");
    expect(output).toContain("Final status: completed");
    expect(output).toContain("Scorecard: PASS (10/11)");
    expect(output).toContain("Eval: PASS (pass)");
    expect(process.exitCode).toBeUndefined();
    expect(globalThis.fetch).toHaveBeenCalledWith(
      "http://localhost:19191/api/runs/create-and-run",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          yamlPath: "assets/orchestrations/public-dev-5node.yaml.template",
          prompt: "Create a concise implementation checklist for a small README improvement.",
        }),
      }),
    );
    expect(globalThis.fetch).toHaveBeenCalledWith(
      "http://localhost:19191/api/runs/smoke-run-1/eval-run",
      expect.objectContaining({ method: "GET" }),
    );
  });
});

describe("redactSecret helper", () => {
  it("redacts api_key, apiKey, secret, token, password fields", () => {
    const input = {
      id: "abc",
      api_key: "pk-secret-123",
      apiKey: "pk-secret-456",
      secret: "my-secret",
      token: "tok-abc",
      password: "pw-123",
      safe: "visible",
    };
    const result = redactSecret(input);
    expect(result).toEqual({
      id: "abc",
      api_key: "***REDACTED***",
      apiKey: "***REDACTED***",
      secret: "***REDACTED***",
      token: "***REDACTED***",
      password: "***REDACTED***",
      safe: "visible",
    });
  });

  it("redacts nested objects and arrays", () => {
    const input = {
      settings: [
        { id: "1", api_key: "pk-nested-secret" },
        { id: "2", token: "tok-nested" },
      ],
    };
    const result = redactSecret(input);
    expect(result.settings[0].api_key).toBe("***REDACTED***");
    expect(result.settings[1].token).toBe("***REDACTED***");
  });

  it("redacts likely secrets embedded in error strings", () => {
    const result = redactSecret(
      "request failed: api_key=pk-super-secret-key-12345 token=tok-test-999 Authorization: Bearer testBearerTokenValue",
    );

    expect(result).toContain("api_key=***REDACTED***");
    expect(result).toContain("token=***REDACTED***");
    expect(result).toContain("Bearer ***REDACTED***");
    expect(result).not.toContain("pk-super-secret-key-12345");
    expect(result).not.toContain("tok-test-999");
    expect(result).not.toContain("abcdefghijklmnop");
  });

  it("handles null and undefined gracefully", () => {
    expect(redactSecret(null)).toBeNull();
    expect(redactSecret(undefined)).toBeUndefined();
  });
});
