import { describe, expect, it, vi } from "vitest";

import { resolvePrCloseoutInput } from "../src/commands/dag-pr-closeout.js";

function response(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

function githubFetch(options: {
  draft: boolean;
  mergeable?: boolean;
  mergeableState?: string;
  baseRef?: string;
  checks?: Record<string, unknown>[];
  statuses?: Record<string, unknown>[];
  reviews?: Record<string, unknown>[];
  dependency?: Record<string, unknown>[];
  files?: string[];
  unresolvedThreads?: number;
}) {
  return vi.fn(async (url: string | URL | Request) => {
    const pathname = new URL(String(url)).pathname;
    const search = new URL(String(url)).search;
    if (pathname === "/repos/xiaotianfotos/homerail") return response({ default_branch: "main" });
    if (pathname === "/repos/xiaotianfotos/homerail/pulls/26" && !search) {
      return response({
        draft: options.draft,
        mergeable: options.mergeable ?? true,
        mergeable_state: options.mergeableState ?? "clean",
        base: { sha: "a".repeat(40), ref: options.baseRef ?? "main" },
        head: { sha: "b".repeat(40), ref: "feat/pr-closeout" },
      });
    }
    if (pathname.endsWith(`/commits/${"b".repeat(40)}/check-runs`)) {
      return response({ check_runs: options.checks ?? [] });
    }
    if (pathname.endsWith(`/commits/${"b".repeat(40)}/status`)) {
      return response({ statuses: options.statuses ?? [] });
    }
    if (pathname.endsWith("/pulls/26/reviews")) return response(options.reviews ?? []);
    if (pathname.endsWith("/pulls/26/files")) {
      return response((options.files ?? ["src/index.ts"]).map((filename) => ({ filename })));
    }
    if (pathname === "/graphql") {
      return response({
        data: {
          repository: {
            pullRequest: {
              reviewThreads: {
                nodes: Array.from({ length: options.unresolvedThreads ?? 0 }, () => ({ isResolved: false })),
              },
            },
          },
        },
      });
    }
    if (pathname.endsWith("/pulls") && search) return response(options.dependency ?? []);
    throw new Error(`unexpected GitHub URL: ${String(url)}`);
  });
}

function managerClient(): HomeRailClient {
  return {
    async get(url: string) {
      if (url === "/api/runs/review-run-26") return { data: { workflowId: "pr-review" } };
      if (url.endsWith("/status")) return { data: { status: "completed" } };
      if (url.endsWith("/handoffs")) {
        return { data: { handoffs: [{
          fromNode: "publish",
          port: "published",
          content: passingPublication(),
        }] } };
      }
      throw new Error(`unexpected Manager URL: ${url}`);
    },
  } as HomeRailClient;
}

function passingPublication(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    report: {
      repo: "xiaotianfotos/homerail",
      pr: 26,
      base: "a".repeat(40),
      head: "b".repeat(40),
      status: "pass",
      confidence: "high",
      summary: "No actionable findings",
      actionable_count: 0,
      findings: [],
      reviewer_results: ["runtime", "security", "tests", "frontend"].map((reviewer) => ({
        reviewer,
        status: "complete",
        summary: `${reviewer} review complete`,
        findings: [],
      })),
    },
    markdown: "# HomeRail PR Review\n\nNo actionable findings.",
    quorum: { passed: true, successes: 3, total: 3, threshold: 2 },
    ...overrides,
  };
}

describe("PR closeout input", () => {
  it("reuses head-bound local evidence to mark a draft ready for review", async () => {
    const result = await resolvePrCloseoutInput({
      repo: "xiaotianfotos/homerail",
      pr: 26,
      local_evidence: [{
        name: "macOS npm run ci",
        head: "b".repeat(40),
        status: "passed",
        platform: "macos",
        command: "npm run ci",
      }],
    }, {
      fetchImpl: githubFetch({ draft: true, baseRef: "feature/dag-runtime-pattern-primitives", dependency: [{ number: 21, state: "open" }] }) as typeof fetch,
      env: {},
    });

    expect(result).toMatchObject({
      phase: "draft",
      closeout_status: "ready_for_review",
      blockers: [],
      github: { dependency: { number: 21 } },
    });
  });

  it("rejects validation evidence from an older head", async () => {
    const result = await resolvePrCloseoutInput({
      repo: "xiaotianfotos/homerail",
      pr: 26,
      local_evidence: [{ name: "old CI", head: "c".repeat(40), status: "passed" }],
    }, { fetchImpl: githubFetch({ draft: true }) as typeof fetch, env: {} });

    expect(result.closeout_status).toBe("stale_evidence");
    expect(result.blockers).toContainEqual(expect.objectContaining({ code: "validation_evidence_missing" }));
  });

  it("does not treat another completed closeout run as validation evidence", async () => {
    const client = {
      async get(url: string) {
        if (url === "/api/runs/old-closeout-run") return { data: { workflowId: "pr-closeout" } };
        if (url.endsWith("/status")) return { data: { status: "completed" } };
        if (url.endsWith("/handoffs")) {
          return { data: { handoffs: [{
            fromNode: "status_gate",
            content: {
              payload: {
                head: "b".repeat(40),
                closeout_status: "ready_for_review",
                blockers: [],
              },
            },
          }] } };
        }
        throw new Error(`unexpected Manager URL: ${url}`);
      },
    } as HomeRailClient;
    const result = await resolvePrCloseoutInput({
      repo: "xiaotianfotos/homerail",
      pr: 26,
      validation_runs: ["old-closeout-run"],
    }, { client, fetchImpl: githubFetch({ draft: true }) as typeof fetch, env: {} });

    expect(result.closeout_status).toBe("blocked");
    expect(result.evidence).toContainEqual(expect.objectContaining({ validated: false }));
    expect(result.blockers).toContainEqual(expect.objectContaining({ code: "validation_evidence_missing" }));
  });

  it("rejects an unrelated completed run with a nested pass status", async () => {
    const client = {
      async get(url: string) {
        if (url === "/api/runs/unrelated-run") return { data: { workflowId: "unrelated" } };
        if (url.endsWith("/status")) return { data: { status: "completed" } };
        if (url.endsWith("/handoffs")) {
          return { data: { handoffs: [{
            fromNode: "result",
            port: "done",
            content: { head: "b".repeat(40), nested: { status: "pass" } },
          }] } };
        }
        throw new Error(`unexpected Manager URL: ${url}`);
      },
    } as HomeRailClient;
    const result = await resolvePrCloseoutInput({
      repo: "xiaotianfotos/homerail",
      pr: 26,
      validation_runs: ["unrelated-run"],
    }, { client, fetchImpl: githubFetch({ draft: true }) as typeof fetch, env: {} });

    expect(result.closeout_status).toBe("blocked");
    expect(result.evidence).toContainEqual(expect.objectContaining({
      kind: "unrecognized_run",
      evidence_valid: false,
      validated: false,
      validation_error: "run workflow_id is not pr-review",
    }));
    expect(result.blockers).toContainEqual(expect.objectContaining({ code: "validation_evidence_missing" }));
  });

  it("does not treat a malformed PR Review report as a zero-finding merge review", async () => {
    const client = {
      async get(url: string) {
        if (url === "/api/runs/malformed-review") return { data: { workflowId: "pr-review" } };
        if (url.endsWith("/status")) return { data: { status: "completed" } };
        if (url.endsWith("/handoffs")) {
          return { data: { handoffs: [{
            fromNode: "publish",
            port: "published",
            content: { head: "b".repeat(40), report: { status: "pass", head: "b".repeat(40) } },
          }] } };
        }
        throw new Error(`unexpected Manager URL: ${url}`);
      },
    } as HomeRailClient;
    const result = await resolvePrCloseoutInput({
      repo: "xiaotianfotos/homerail",
      pr: 26,
      phase: "merge",
      validation_runs: ["malformed-review"],
    }, {
      client,
      fetchImpl: githubFetch({
        draft: false,
        checks: [{ name: "Core Linux", status: "completed", conclusion: "success" }],
        statuses: [{ context: "branch-policy", state: "success" }],
      }) as typeof fetch,
      env: { GH_TOKEN: "test-token" },
    });

    expect(result.closeout_status).toBe("blocked");
    expect(result.evidence).toContainEqual(expect.objectContaining({
      kind: "pr_review",
      evidence_valid: false,
      validated: false,
      validation_error: expect.stringContaining("repository identity"),
    }));
    expect(result.blockers.map((item) => item.code)).toEqual(expect.arrayContaining([
      "validation_evidence_missing",
      "pr_review_missing",
    ]));
  });

  it("requires successful remote gates and a zero-finding HomeRail review before human merge approval", async () => {
    const result = await resolvePrCloseoutInput({
      repo: "xiaotianfotos/homerail",
      pr: 26,
      phase: "merge",
      validation_runs: ["review-run-26"],
    }, {
      client: managerClient(),
      fetchImpl: githubFetch({
        draft: false,
        checks: [{ name: "Core Linux", status: "completed", conclusion: "success" }],
        statuses: [{ context: "branch-policy", state: "success" }],
        reviews: [{ user: { login: "reviewer" }, state: "APPROVED" }],
      }) as typeof fetch,
      env: { GH_TOKEN: "test-token" },
    });

    expect(result.closeout_status).toBe("ready_for_human_merge_candidate");
    expect(result.blockers).toEqual([]);
    expect(result.evidence).toContainEqual(expect.objectContaining({
      run_id: "review-run-26",
      kind: "pr_review",
      fresh: true,
      actionable_count: 0,
    }));
  });

  it("blocks merge closeout on skipped checks, open dependencies, and requested changes", async () => {
    const result = await resolvePrCloseoutInput({
      repo: "xiaotianfotos/homerail",
      pr: 26,
      phase: "merge",
      local_evidence: [{ name: "local CI", head: "b".repeat(40), status: "passed" }],
    }, {
      fetchImpl: githubFetch({
        draft: false,
        baseRef: "feature/dag-runtime-pattern-primitives",
        dependency: [{ number: 21, state: "open" }],
        checks: [{ name: "Core Linux", status: "completed", conclusion: "skipped" }],
        reviews: [{ user: { login: "reviewer" }, state: "CHANGES_REQUESTED" }],
      }) as typeof fetch,
      env: {},
    });

    expect(result.closeout_status).toBe("blocked");
    expect(result.blockers.map((item) => item.code)).toEqual(expect.arrayContaining([
      "dependency_open",
      "checks_failed",
      "changes_requested",
      "pr_review_missing",
    ]));
  });

  it("derives platform coverage from changed files and blocks unresolved threads", async () => {
    const result = await resolvePrCloseoutInput({
      repo: "xiaotianfotos/homerail",
      pr: 26,
      phase: "merge",
      local_evidence: [{ name: "Linux CI", head: "b".repeat(40), status: "passed", platform: "linux" }],
    }, {
      fetchImpl: githubFetch({
        draft: false,
        files: ["electron/main.ts"],
        checks: [{ name: "Core Linux", status: "completed", conclusion: "success" }],
        unresolvedThreads: 2,
      }) as typeof fetch,
      env: { GH_TOKEN: "test-token" },
    });

    expect(result.blockers).toContainEqual(expect.objectContaining({ code: "review_threads_open" }));
    expect(result.blockers).toContainEqual(expect.objectContaining({
      code: "platform_evidence_missing",
      message: expect.stringContaining("macos"),
    }));
    expect(result.blockers).toContainEqual(expect.objectContaining({
      code: "platform_evidence_missing",
      message: expect.stringContaining("windows"),
    }));
  });

});
