import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  manualRunEnvelope,
  resolvePrReviewInput,
} from "../src/commands/dag-run-template.js";
import { createProgram } from "../src/index.js";
import { orchestrationsDir, resolveTemplatePath } from "../src/commands/templates.js";

function response(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

function pullMetadata(
  baseRepo = "xiaotianfotos/homerail",
  headRepo = baseRepo,
  host = "github.com",
): Record<string, unknown> {
  return {
    title: "Add review DAG",
    user: { login: "matrix" },
    base: {
      sha: "a".repeat(40),
      repo: { full_name: baseRepo, clone_url: `https://${host}/${baseRepo}.git` },
    },
    head: {
      sha: "b".repeat(40),
      repo: { full_name: headRepo, clone_url: `https://${host}/${headRepo}.git` },
    },
  };
}

describe("PR Review run-template", () => {
  let tmpDir: string;
  let oldHome: string | undefined;
  let oldAssetDir: string | undefined;

  beforeEach(() => {
    vi.restoreAllMocks();
    process.exitCode = undefined;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "homerail-pr-review-cli-"));
    oldHome = process.env.HOMERAIL_HOME;
    oldAssetDir = process.env.HOMERAIL_ASSET_DIR;
    process.env.HOMERAIL_HOME = tmpDir;
    delete process.env.HOMERAIL_ASSET_DIR;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = undefined;
    if (oldHome === undefined) delete process.env.HOMERAIL_HOME;
    else process.env.HOMERAIL_HOME = oldHome;
    if (oldAssetDir === undefined) delete process.env.HOMERAIL_ASSET_DIR;
    else process.env.HOMERAIL_ASSET_DIR = oldAssetDir;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("resolves immutable PR metadata from GitHub and wraps a manual envelope", async () => {
    const fetchImpl = vi.fn(async () => response(pullMetadata()));

    const input = await resolvePrReviewInput(
      { repo: "xiaotianfotos/homerail", pr: 25 },
      { fetchImpl: fetchImpl as typeof fetch, now: new Date("2026-07-12T00:00:00Z"), env: {} },
    );

    expect(fetchImpl).toHaveBeenCalledWith(
      "https://api.github.com/repos/xiaotianfotos/homerail/pulls/25",
      expect.objectContaining({ headers: expect.objectContaining({ "User-Agent": "HomeRail-PR-Review" }) }),
    );
    expect(input).toMatchObject({
      repo: "xiaotianfotos/homerail",
      pr: 25,
      base: "a".repeat(40),
      head: "b".repeat(40),
      base_clone_url: "https://github.com/xiaotianfotos/homerail.git",
      head_clone_url: "https://github.com/xiaotianfotos/homerail.git",
      expected_usage: 8,
      budget_key: "pr-review:xiaotianfotos/homerail:2026-07-12",
    });
    expect(manualRunEnvelope(input)).toMatchObject({
      trigger_id: "manual",
      trigger_type: "manual",
      payload: input,
    });
  });

  it("resolves trusted fork clone URLs through the configured GitHub Enterprise API", async () => {
    const fetchImpl = vi.fn(async () => response(pullMetadata(
      "enterprise/homerail",
      "contributor/homerail",
      "github.example",
    )));

    const input = await resolvePrReviewInput(
      {
        repo: "enterprise/homerail",
        pr: 8,
        base: "c".repeat(40),
        head: "d".repeat(40),
        base_clone_url: "https://attacker.example/enterprise/homerail.git",
      },
      { fetchImpl: fetchImpl as typeof fetch, env: { HOMERAIL_GITHUB_API_BASE_URL: "https://github.example/api/v3/" } },
    );

    expect(fetchImpl).toHaveBeenCalledWith(
      "https://github.example/api/v3/repos/enterprise/homerail/pulls/8",
      expect.any(Object),
    );
    expect(input).toMatchObject({
      base: "c".repeat(40),
      head: "d".repeat(40),
      base_clone_url: "https://github.example/enterprise/homerail.git",
      head_clone_url: "https://github.example/contributor/homerail.git",
    });
  });

  it("rejects credential-bearing clone URLs returned by GitHub metadata", async () => {
    const metadata = pullMetadata();
    const base = metadata.base as { repo: { clone_url: string } };
    base.repo.clone_url = "https://token@github.com/xiaotianfotos/homerail.git";

    await expect(resolvePrReviewInput(
      { repo: "xiaotianfotos/homerail", pr: 25 },
      { fetchImpl: (async () => response(metadata)) as typeof fetch, env: {} },
    )).rejects.toThrow("base clone_url must be credential-free HTTPS");
  });

  it("syncs the tracked template and starts a run from structured input", async () => {
    const assetRoot = path.join(tmpDir, "asset");
    fs.mkdirSync(path.join(assetRoot, "orchestrations"), { recursive: true });
    fs.writeFileSync(path.join(assetRoot, "orchestrations", "pr-review.yaml.template"), "api_version: homerail.ai/v1\n");
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      calls.push({ url: String(url), init });
      if (String(url) === "https://api.github.com/repos/xiaotianfotos/homerail/pulls/25") {
        return response(pullMetadata());
      }
      if (String(url).endsWith("/api/dag/workflows/sync")) {
        return response({ success: true, data: { workflow: { workflow_id: "pr-review" } } });
      }
      if (String(url).endsWith("/api/runs/create-and-run")) {
        return response({ success: true, data: { run_id: "review-run-25" } });
      }
      throw new Error(`unexpected URL: ${String(url)}`);
    });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    await createProgram().parseAsync([
      "node", "hr", "--json", "dag", "run-template", "pr-review",
      "--input", JSON.stringify({
        repo: "xiaotianfotos/homerail",
        pr: 25,
        base: "a".repeat(40),
        head: "b".repeat(40),
      }),
    ]);

    expect(calls.map((call) => call.url)).toEqual([
      "https://api.github.com/repos/xiaotianfotos/homerail/pulls/25",
      "http://localhost:19191/api/dag/workflows/sync",
      "http://localhost:19191/api/runs/create-and-run",
    ]);
    const runBody = JSON.parse(String(calls[2].init?.body));
    expect(JSON.parse(runBody.prompt)).toMatchObject({
      trigger_type: "manual",
      payload: {
        repo: "xiaotianfotos/homerail",
        pr: 25,
        base_clone_url: "https://github.com/xiaotianfotos/homerail.git",
        head_clone_url: "https://github.com/xiaotianfotos/homerail.git",
      },
    });
    expect(JSON.parse(String(log.mock.calls[0][0]))).toMatchObject({
      run_id: "review-run-25",
      workflow_id: "pr-review",
    });
  });

  it("waits for declared artifacts without materializing scenario-specific files", async () => {
    const assetRoot = path.join(tmpDir, "asset");
    fs.mkdirSync(path.join(assetRoot, "orchestrations"), { recursive: true });
    fs.writeFileSync(path.join(assetRoot, "orchestrations", "pr-review.yaml.template"), "api_version: homerail.ai/v1\n");
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      const target = String(url);
      if (target === "https://api.github.com/repos/xiaotianfotos/homerail/pulls/25") {
        return response(pullMetadata());
      }
      if (target.endsWith("/api/dag/workflows/sync")) {
        return response({ success: true, data: { workflow: { workflow_id: "pr-review" } } });
      }
      if (target.endsWith("/api/runs/create-and-run")) {
        return response({ success: true, data: { run_id: "review-run-artifacts" } });
      }
      if (target.endsWith("/api/runs/review-run-artifacts/status")) {
        return response({ success: true, data: { status: "completed" } });
      }
      if (target.endsWith("/api/runs/review-run-artifacts/artifacts")) {
        return response({ success: true, data: { artifacts: [
          { name: "pr-review.json", status: "ready", media_type: "application/json", sha256: "a".repeat(64) },
          { name: "pr-review.md", status: "ready", media_type: "text/markdown", sha256: "b".repeat(64) },
        ] } });
      }
      throw new Error(`unexpected URL: ${target}`);
    });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    await createProgram().parseAsync([
      "node", "hr", "--json", "dag", "run-template", "pr-review",
      "--input", JSON.stringify({
        repo: "xiaotianfotos/homerail",
        pr: 25,
        base: "a".repeat(40),
        head: "b".repeat(40),
      }),
      "--wait", "--interval", "0.001",
    ]);

    expect(JSON.parse(String(log.mock.calls[0][0]))).toMatchObject({
      run_id: "review-run-artifacts",
      status: "completed",
      artifacts: [
        { name: "pr-review.json", status: "ready" },
        { name: "pr-review.md", status: "ready" },
      ],
    });
  });

  it("isolates template discovery by HOMERAIL_HOME", () => {
    const firstHome = path.join(tmpDir, "first-home");
    const secondHome = path.join(tmpDir, "second-home");
    for (const [home, marker] of [[firstHome, "first"], [secondHome, "second"]] as const) {
      const dir = path.join(home, "asset", "orchestrations");
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "pr-review.yaml.template"), marker);
    }

    process.env.HOMERAIL_HOME = firstHome;
    const first = resolveTemplatePath(orchestrationsDir(), "pr-review");
    process.env.HOMERAIL_HOME = secondHome;
    const second = resolveTemplatePath(orchestrationsDir(), "pr-review");

    expect(fs.readFileSync(first, "utf8")).toBe("first");
    expect(fs.readFileSync(second, "utf8")).toBe("second");
    expect(first).not.toBe(second);
  });
});
