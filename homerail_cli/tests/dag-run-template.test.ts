import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { HomeRailClient } from "../src/client.js";
import {
  manualRunEnvelope,
  resolvePrReviewInput,
  writePrReviewEvidence,
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
    const fetchImpl = vi.fn(async () => response({
      title: "Add review DAG",
      user: { login: "matrix" },
      base: { sha: "a".repeat(40) },
      head: { sha: "b".repeat(40) },
    }));

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
      expected_usage: 8,
      budget_key: "pr-review:xiaotianfotos/homerail:2026-07-12",
    });
    expect(manualRunEnvelope(input)).toMatchObject({
      trigger_id: "manual",
      trigger_type: "manual",
      payload: input,
    });
  });

  it("resolves PR metadata through the configured GitHub Enterprise API", async () => {
    const fetchImpl = vi.fn(async () => response({
      base: { sha: "a".repeat(40) },
      head: { sha: "b".repeat(40) },
    }));

    await resolvePrReviewInput(
      { repo: "enterprise/homerail", pr: 8 },
      { fetchImpl: fetchImpl as typeof fetch, env: { HOMERAIL_GITHUB_API_BASE_URL: "https://github.example/api/v3/" } },
    );

    expect(fetchImpl).toHaveBeenCalledWith(
      "https://github.example/api/v3/repos/enterprise/homerail/pulls/8",
      expect.any(Object),
    );
  });

  it("syncs the tracked template and starts a run from structured input", async () => {
    const assetRoot = path.join(tmpDir, "asset");
    fs.mkdirSync(path.join(assetRoot, "orchestrations"), { recursive: true });
    fs.writeFileSync(path.join(assetRoot, "orchestrations", "pr-review.yaml.template"), "api_version: homerail.ai/v1\n");
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      calls.push({ url: String(url), init });
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
      "http://localhost:19191/api/dag/workflows/sync",
      "http://localhost:19191/api/runs/create-and-run",
    ]);
    const runBody = JSON.parse(String(calls[1].init?.body));
    expect(JSON.parse(runBody.prompt)).toMatchObject({
      trigger_type: "manual",
      payload: { repo: "xiaotianfotos/homerail", pr: 25 },
    });
    expect(JSON.parse(String(log.mock.calls[0][0]))).toMatchObject({
      run_id: "review-run-25",
      workflow_id: "pr-review",
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

  it("materializes published handoff and metrics as JSON and Markdown", async () => {
    const published = {
      report: {
        repo: "xiaotianfotos/homerail",
        pr: 25,
        base: "a".repeat(40),
        head: "b".repeat(40),
        status: "findings",
        confidence: "high",
        actionable_count: 1,
        findings: [{ title: "Race", file: "src/run.ts", line: 42 }],
      },
      markdown: "# HomeRail PR Review\n\nResult: 1 actionable finding",
      json_path: "artifacts/pr-review/report.json",
      markdown_path: "artifacts/pr-review/report.md",
      quorum: { passed: true, successes: 2, total: 3, threshold: 2 },
    };
    const client = {
      async get(url: string) {
        if (url.endsWith("/status")) {
          return { data: { status: "completed", created_at: "2026-07-12T00:00:00Z", completed_at: "2026-07-12T00:04:32Z" } };
        }
        if (url.endsWith("/handoffs")) {
          return { data: { handoffs: [
            {
              fromNode: "budget",
              port: "admitted",
              content: {
                admitted: true,
                requested: 8,
                spent: 8,
                remaining: 92,
                limit: 100,
                input: { payload: {
                  repo: "xiaotianfotos/homerail",
                  pr: 25,
                  base: "a".repeat(40),
                  head: "b".repeat(40),
                } },
              },
            },
            { fromNode: "synthesize", port: "drafted", content: published.report },
            { fromNode: "evidence_vote", port: "voted", content: { voter: "evidence", vote: "accept", confidence: "high", evidence: "grounded", finding_verdicts: [{ title: "Race", file: "src/run.ts", line: 42, verdict: "confirmed", reason: "reproduced" }] } },
            { fromNode: "false_positive_vote", port: "voted", content: { voter: "false_positive", vote: "accept", confidence: "high", evidence: "confirmed", finding_verdicts: [{ title: "Race", file: "src/run.ts", line: 42, verdict: "confirmed", reason: "not disproven" }] } },
            { fromNode: "coverage_vote", port: "voted", content: { voter: "coverage", vote: "reject", confidence: "high", evidence: "incomplete", finding_verdicts: [] } },
            { fromNode: "verification_quorum", port: "accepted", content: { passed: true, successes: 2, total: 3, threshold: 2 } },
            { fromNode: "publish", port: "published", content: published },
          ] } };
        }
        if (url.endsWith("/metrics")) {
          return { data: { totals: { tokens: { input: 100, output: 50 } } } };
        }
        throw new Error(`unexpected URL: ${url}`);
      },
    } as HomeRailClient;

    const evidence = await writePrReviewEvidence(client, "review-run-25", tmpDir);

    expect(evidence).toMatchObject({
      run_id: "review-run-25",
      run_status: "completed",
      runtime_ms: 272000,
      quorum: { passed: true },
      verification: { votes: expect.arrayContaining([expect.objectContaining({ voter: "evidence" })]) },
      budget: { requested: 8, spent: 8 },
    });
    expect(JSON.parse(fs.readFileSync(path.join(tmpDir, "report.json"), "utf8"))).toMatchObject({
      report: { actionable_count: 1 },
      metrics: { totals: { tokens: { input: 100, output: 50 } } },
      budget: { remaining: 92 },
    });
    expect(fs.readFileSync(path.join(tmpDir, "report.md"), "utf8"))
      .toContain("Run: `review-run-25`");
    expect(fs.readFileSync(path.join(tmpDir, "report.md"), "utf8"))
      .toContain("Runtime: 272s");
    expect(fs.readFileSync(path.join(tmpDir, "report.md"), "utf8"))
      .toContain("false_positive: accept");
  });

  it("rejects a published report whose immutable PR identity drifted", async () => {
    const client = {
      async get(url: string) {
        if (url.endsWith("/status")) return { data: { status: "completed" } };
        if (url.endsWith("/handoffs")) return { data: { handoffs: [
          { fromNode: "budget", content: { admitted: true, input: { payload: {
            repo: "xiaotianfotos/homerail", pr: 25, base: "a".repeat(40), head: "b".repeat(40),
          } } } },
          { fromNode: "synthesize", content: { findings: [] } },
          { fromNode: "evidence_vote", content: { voter: "evidence", finding_verdicts: [] } },
          { fromNode: "false_positive_vote", content: { voter: "false_positive", finding_verdicts: [] } },
          { fromNode: "coverage_vote", content: { voter: "coverage", finding_verdicts: [] } },
          { fromNode: "verification_quorum", content: { passed: false, successes: 0, total: 3, threshold: 2 } },
          { fromNode: "publish", content: {
            report: { repo: "owner/name", pr: 25, base: "", head: "" },
            markdown: "report",
            json_path: "artifacts/pr-review/report.json",
            markdown_path: "artifacts/pr-review/report.md",
            quorum: {},
          } },
        ] } };
        if (url.endsWith("/metrics")) return { data: {} };
        throw new Error(`unexpected URL: ${url}`);
      },
    } as HomeRailClient;

    await expect(writePrReviewEvidence(client, "review-run-drift", tmpDir))
      .rejects.toThrow("identity mismatch for repo");
  });

  it("rejects a published quorum that disagrees with persisted verifier votes", async () => {
    const report = {
      repo: "xiaotianfotos/homerail", pr: 25, base: "a".repeat(40), head: "b".repeat(40),
      status: "pass", findings: [],
    };
    const vote = (voter: string) => ({ voter, vote: "accept", confidence: "high", evidence: "ok", finding_verdicts: [] });
    const client = {
      async get(url: string) {
        if (url.endsWith("/status")) return { data: { status: "completed" } };
        if (url.endsWith("/handoffs")) return { data: { handoffs: [
          { fromNode: "budget", content: { admitted: true, input: { payload: {
            repo: report.repo, pr: report.pr, base: report.base, head: report.head,
          } } } },
          { fromNode: "synthesize", content: report },
          { fromNode: "evidence_vote", content: vote("evidence") },
          { fromNode: "false_positive_vote", content: vote("false_positive") },
          { fromNode: "coverage_vote", content: vote("coverage") },
          { fromNode: "verification_quorum", content: { passed: true, successes: 3, total: 3, threshold: 2 } },
          { fromNode: "publish", content: {
            report, markdown: "report", quorum: { passed: true, successes: 1, total: 1, threshold: 1 },
          } },
        ] } };
        if (url.endsWith("/metrics")) return { data: {} };
        throw new Error(`unexpected URL: ${url}`);
      },
    } as HomeRailClient;

    await expect(writePrReviewEvidence(client, "review-run-quorum-drift", tmpDir))
      .rejects.toThrow("published quorum mismatch");
  });

  it("requires an inconclusive report when verifier quorum fails", async () => {
    const report = {
      repo: "xiaotianfotos/homerail", pr: 25, base: "a".repeat(40), head: "b".repeat(40),
      status: "pass", findings: [],
    };
    const vote = (voter: string, decision: string) => ({
      voter, vote: decision, confidence: "high", evidence: "checked", finding_verdicts: [],
    });
    const quorum = { passed: false, successes: 1, total: 3, threshold: 2 };
    const client = {
      async get(url: string) {
        if (url.endsWith("/status")) return { data: { status: "cancelled" } };
        if (url.endsWith("/handoffs")) return { data: { handoffs: [
          { fromNode: "budget", content: { admitted: true, input: { payload: {
            repo: report.repo, pr: report.pr, base: report.base, head: report.head,
          } } } },
          { fromNode: "synthesize", content: report },
          { fromNode: "evidence_vote", content: vote("evidence", "reject") },
          { fromNode: "false_positive_vote", content: vote("false_positive", "reject") },
          { fromNode: "coverage_vote", content: vote("coverage", "accept") },
          { fromNode: "verification_quorum", content: quorum },
          { fromNode: "publish", content: { report, markdown: "report", quorum } },
        ] } };
        if (url.endsWith("/metrics")) return { data: {} };
        throw new Error(`unexpected URL: ${url}`);
      },
    } as HomeRailClient;

    await expect(writePrReviewEvidence(client, "review-run-not-inconclusive", tmpDir))
      .rejects.toThrow("rejected quorum must publish an inconclusive report");
  });

  it("rejects a published finding that a verifier disproved", async () => {
    const report = {
      repo: "xiaotianfotos/homerail", pr: 25, base: "a".repeat(40), head: "b".repeat(40),
      findings: [{ title: "False alarm", file: "src/run.ts", line: 7 }],
    };
    const client = {
      async get(url: string) {
        if (url.endsWith("/status")) return { data: { status: "completed" } };
        if (url.endsWith("/handoffs")) return { data: { handoffs: [
          { fromNode: "budget", content: { admitted: true, input: { payload: {
            repo: report.repo, pr: report.pr, base: report.base, head: report.head,
          } } } },
          { fromNode: "synthesize", content: report },
          { fromNode: "evidence_vote", content: { voter: "evidence", finding_verdicts: [{ ...report.findings[0], verdict: "confirmed", reason: "grounded" }] } },
          { fromNode: "false_positive_vote", content: { voter: "false_positive", finding_verdicts: [{ ...report.findings[0], verdict: "rejected", reason: "unreachable" }] } },
          { fromNode: "coverage_vote", content: { voter: "coverage", finding_verdicts: [] } },
          { fromNode: "verification_quorum", content: { passed: true, successes: 2, total: 3, threshold: 2 } },
          { fromNode: "publish", content: { report, markdown: "report", quorum: {} } },
        ] } };
        if (url.endsWith("/metrics")) return { data: {} };
        throw new Error(`unexpected URL: ${url}`);
      },
    } as HomeRailClient;

    await expect(writePrReviewEvidence(client, "review-run-false-positive", tmpDir))
      .rejects.toThrow("retained a finding rejected by a verifier");
  });
});
