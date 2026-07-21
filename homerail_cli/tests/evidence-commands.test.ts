import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createProgram } from "../src/index.js";

/**
 * Tests for the evidence commands (scorecard, eval-run, replay, trace, stats).
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

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

beforeEach(() => {
  vi.restoreAllMocks();
  tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "homerail-cli-evidence-test-"));
  previousHome = process.env.HOMERAIL_HOME;
  previousConfigPath = process.env.HOMERAIL_CONFIG_PATH;
  previousSecretsPath = process.env.HOMERAIL_SECRETS_PATH;
  previousManagerUrl = process.env.HOMERAIL_MANAGER_URL;
  process.env.HOMERAIL_HOME = tempHome;
  delete process.env.HOMERAIL_CONFIG_PATH;
  delete process.env.HOMERAIL_SECRETS_PATH;
  delete process.env.HOMERAIL_MANAGER_URL;
});

afterEach(() => {
  restoreEnv("HOMERAIL_HOME", previousHome);
  restoreEnv("HOMERAIL_CONFIG_PATH", previousConfigPath);
  restoreEnv("HOMERAIL_SECRETS_PATH", previousSecretsPath);
  restoreEnv("HOMERAIL_MANAGER_URL", previousManagerUrl);
  fs.rmSync(tempHome, { recursive: true, force: true });
});

// -- Scorecard ---------------------------------------------------------------

describe("scorecard command", () => {
  it("renders text with PASS for all-checks-passing response", async () => {
    mockFetch({
      success: true,
      message: "ok",
      data: {
        run_id: "run-001",
        is_selfdev: true,
        passed: true,
        verdict: "pass",
        score: 6,
        total: 6,
        hard_error_count: 0,
        soft_warning_count: 0,
        blind_spot_count: 0,
        checks: [
          { name: "run_terminal", passed: true, severity: "error", gate: "hard", source_type: "event", detail: "run status: completed" },
          { name: "all_nodes_completed", passed: true, severity: "error", gate: "hard", source_type: "event", detail: "2/2, 2 nodes total" },
        ],
        intervention: { total: 0, by_node: {}, by_mode: {}, by_direction: {} },
        quality_gate: { applicable: true, categories: { linter: true, "type-check": true, regression: true }, aggregate: { name: "artifact.tester_quality_gate", passed: true, status: "pass" } },
      },
    });

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const program = createProgram();
    await program.parseAsync(["node", "homerail", "scorecard", "run-001"]);

    const output = logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(output).toContain("PASS");
    expect(output).toContain("Result: PASS");
    expect(output).toContain("Scorecard: run-001");
    expect(output).toContain("Score: 6/6");
    expect(process.exitCode).toBe(0);
  });

  it("renders text with FAIL for hard errors and exits 1", async () => {
    mockFetch({
      success: true,
      message: "ok",
      data: {
        run_id: "run-002",
        is_selfdev: false,
        passed: false,
        verdict: "fail",
        score: 3,
        total: 6,
        hard_error_count: 2,
        soft_warning_count: 1,
        blind_spot_count: 0,
        checks: [
          { name: "run_terminal", passed: true, severity: "error", gate: "hard", source_type: "event", detail: "run status: completed" },
          { name: "no_failed_nodes", passed: false, severity: "error", gate: "hard", source_type: "event", detail: "failed: coder" },
        ],
        intervention: { total: 0, by_node: {}, by_mode: {}, by_direction: {} },
        quality_gate: { applicable: false, categories: {}, aggregate: { name: "artifact.tester_quality_gate", passed: true, status: "n/a" } },
      },
    });

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const program = createProgram();
    await program.parseAsync(["node", "homerail", "scorecard", "run-002"]);

    const output = logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(output).toContain("FAIL");
    expect(output).toContain("Result: FAIL");
    expect(process.exitCode).toBe(1);
  });

  it("renders text with pass_with_warnings for soft warnings", async () => {
    mockFetch({
      success: true,
      message: "ok",
      data: {
        run_id: "run-003",
        is_selfdev: true,
        passed: true,
        verdict: "pass_with_warnings",
        score: 5,
        total: 6,
        hard_error_count: 0,
        soft_warning_count: 1,
        blind_spot_count: 0,
        checks: [
          { name: "run_terminal", passed: true, severity: "error", gate: "hard", source_type: "event", detail: "run status: completed" },
          { name: "worker.triage.budget_ok", passed: false, severity: "warning", gate: "soft", source_type: "chat", detail: "triage tool_count=20; threshold=15" },
        ],
        intervention: { total: 0, by_node: {}, by_mode: {}, by_direction: {} },
        quality_gate: { applicable: true, categories: { linter: true }, aggregate: { name: "artifact.tester_quality_gate", passed: true, status: "pass" } },
      },
    });

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const program = createProgram();
    await program.parseAsync(["node", "homerail", "scorecard", "run-003"]);

    const output = logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(output).toContain("pass_with_warnings");
    expect(process.exitCode).toBe(0);
  });

  it("outputs JSON with --json flag", async () => {
    const data = {
      run_id: "run-004",
      is_selfdev: true,
      passed: true,
      verdict: "pass",
      score: 6,
      total: 6,
      hard_error_count: 0,
      soft_warning_count: 0,
      blind_spot_count: 0,
      checks: [],
      intervention: { total: 0, by_node: {}, by_mode: {}, by_direction: {} },
      quality_gate: { applicable: true, categories: {}, aggregate: {} },
    };
    mockFetch({ success: true, message: "ok", data });

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const program = createProgram();
    await program.parseAsync(["node", "homerail", "--json", "scorecard", "run-004"]);

    const parsed = JSON.parse(logSpy.mock.calls[0][0]);
    expect(parsed.run_id).toBe("run-004");
    expect(parsed.passed).toBe(true);
    expect(parsed.verdict).toBe("pass");
    expect(parsed.checks).toEqual([]);
    expect(parsed.intervention).toBeDefined();
    expect(parsed.quality_gate).toBeDefined();
  });

  it("passes source issue to the scorecard endpoint", async () => {
    mockFetch({
      success: true,
      message: "ok",
      data: {
        run_id: "run-004",
        is_selfdev: true,
        passed: true,
        verdict: "pass",
        score: 1,
        total: 1,
        hard_error_count: 0,
        soft_warning_count: 0,
        blind_spot_count: 0,
        checks: [],
        intervention: { total: 0, by_node: {}, by_mode: {}, by_direction: {} },
        quality_gate: { applicable: true, categories: {}, aggregate: {} },
      },
    });

    const program = createProgram();
    await program.parseAsync([
      "node",
      "homerail",
      "scorecard",
      "run-004",
      "--source-issue",
      "986",
    ]);

    expect(globalThis.fetch).toHaveBeenCalledWith(
      "http://localhost:19191/api/runs/run-004/scorecard?source_issue=986",
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("reports API error", async () => {
    mockFetch({ success: false, message: "Run not found" }, 404);

    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const program = createProgram();
    await program.parseAsync(["node", "homerail", "scorecard", "missing-run"]);

    const output = errSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(output).toContain("Error");
    expect(process.exitCode).toBe(1);
  });
});

// -- Eval-run ----------------------------------------------------------------

describe("eval-run command", () => {
  const baseEvalData = {
    run_id: "run-100",
    verdict: "pass",
    dag_health: { run_status: "completed", node_counts: "completed: 3", failed_nodes: [], event_count: 42, stalled_hint: "terminal" },
    worker_behavior: { passed: true, score: 8, total: 8, hard_errors: 0, soft_warnings: 0, blind_spots: 0, errors: [], warnings: [] },
    artifact_contracts: { handoff_count: 5, empty_handoff_count: 0 },
    chat_activity: { message_count: 120, tool_call_count: 45 },
    triage_activity: { tool_count: 5, handoff_count: 2, budget_threshold: 15, budget_exceeded: false, intervention_count: 0, intervention_ignored: false },
    interventions: { total: 0, by_node: {}, by_mode: {}, by_direction: {} },
    quality_gate: { status: "pass", passed: true, detail: "ok", categories: { linter: true, "type-check": true }, category_details: {} },
    scorecard_failures: [],
  };

  it("renders text with PASS for passing eval", async () => {
    mockFetch({ success: true, message: "ok", data: baseEvalData });

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const program = createProgram();
    await program.parseAsync(["node", "homerail", "eval-run", "run-100"]);

    const output = logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(output).toContain("PASS");
    expect(output).toContain("Verdict: PASS");
    expect(output).toContain("All checks passed");
    expect(process.exitCode).toBe(0);
  });

  it("renders FAIL and exits 1 for failing eval", async () => {
    mockFetch({
      success: true,
      message: "ok",
      data: { ...baseEvalData, verdict: "fail", worker_behavior: { ...baseEvalData.worker_behavior, passed: false, score: 5, hard_errors: 3 }, scorecard_failures: ["[error] no_failed_nodes: failed: coder"] },
    });

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const program = createProgram();
    await program.parseAsync(["node", "homerail", "eval-run", "run-100"]);

    const output = logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(output).toContain("FAIL");
    expect(output).toContain("Verdict: FAIL");
    expect(process.exitCode).toBe(1);
  });

  it("renders pass_with_warnings and exits 0", async () => {
    mockFetch({
      success: true,
      message: "ok",
      data: { ...baseEvalData, verdict: "pass_with_warnings" },
    });

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const program = createProgram();
    await program.parseAsync(["node", "homerail", "eval-run", "run-100"]);

    const output = logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(output).toContain("PASS_WITH_WARNINGS");
    expect(process.exitCode).toBe(0);
  });

  it("passes eval options to the endpoint", async () => {
    mockFetch({ success: true, message: "ok", data: baseEvalData });

    const program = createProgram();
    await program.parseAsync([
      "node",
      "homerail",
      "eval-run",
      "run-100",
      "--events",
      "9",
      "--tools",
      "4",
      "--content-limit",
      "123",
      "--source-issue",
      "986",
    ]);

    expect(globalThis.fetch).toHaveBeenCalledWith(
      "http://localhost:19191/api/runs/run-100/eval-run?events=9&tools=4&content_limit=123&source_issue=986",
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("renders TS Manager eval responses without triage_activity", async () => {
    const { triage_activity: _triageActivity, ...withoutTriage } = baseEvalData;
    mockFetch({ success: true, message: "ok", data: withoutTriage });

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const program = createProgram();
    await program.parseAsync(["node", "homerail", "eval-run", "run-100"]);

    const output = logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(output).toContain("Verdict: PASS");
    expect(output).not.toContain("Triage Activity:");
    expect(process.exitCode).toBe(0);
  });
});

// -- Replay ------------------------------------------------------------------

describe("replay command", () => {
  it("renders no improvements needed for all-pass scorecard", async () => {
    mockFetch({
      success: true,
      message: "ok",
      data: {
        run_id: "run-200",
        source_issue: null,
        summary: "All 6 checks passed — no improvements needed.",
        score_passed: true,
        score: 6,
        total: 6,
        categories: {},
        next_steps: ["No failures to address."],
        acceptance: ["Scorecard passes with 6/6 checks.", "Replay plan categories are empty after fixes.", "Next DAG run produces clean scorecard."],
      },
    });

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const program = createProgram();
    await program.parseAsync(["node", "homerail", "replay", "run-200"]);

    const output = logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(output).toContain("no improvements needed");
    expect(output).toContain("Categories: none (all checks passed)");
    expect(process.exitCode).toBe(0);
  });

  it("passes source issue to the replay endpoint", async () => {
    mockFetch({
      success: true,
      message: "ok",
      data: {
        run_id: "run-200",
        source_issue: "986",
        summary: "All checks passed.",
        score_passed: true,
        score: 1,
        total: 1,
        categories: {},
        next_steps: ["No failures to address."],
        acceptance: ["Scorecard passes."],
      },
    });

    const program = createProgram();
    await program.parseAsync([
      "node",
      "homerail",
      "replay",
      "run-200",
      "--source-issue",
      "986",
    ]);

    expect(globalThis.fetch).toHaveBeenCalledWith(
      "http://localhost:19191/api/runs/run-200/replay?source_issue=986",
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("renders categories and next steps for failures and exits 1", async () => {
    mockFetch({
      success: true,
      message: "ok",
      data: {
        run_id: "run-201",
        source_issue: "42",
        summary: "2 of 6 checks failed across 1 category(ies).",
        score_passed: false,
        score: 4,
        total: 6,
        categories: { prompt: ["worker.triage.handoff_present", "worker.triage.budget_ok"] },
        next_steps: ["[prompt] Refine node system prompt or handoff contract for clarity"],
        acceptance: ["Scorecard passes with 6/6 checks.", "Replay plan categories are empty after fixes.", "Next DAG run produces clean scorecard."],
      },
    });

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const program = createProgram();
    await program.parseAsync(["node", "homerail", "replay", "run-201"]);

    const output = logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(output).toContain("[prompt]");
    expect(output).toContain("Refine node system prompt");
    expect(output).toContain("Source Issue: #42");
    expect(process.exitCode).toBe(1);
  });

  it("degrades gracefully when replay metadata omits acceptance and next steps", async () => {
    mockFetch({
      success: true,
      message: "ok",
      data: {
        run_id: "run-deploy-diagnosis",
        source_issue: null,
        summary: "Deployment diagnosis completed.",
        score_passed: true,
        score: 0,
        total: 0,
      },
    });

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const program = createProgram();
    await program.parseAsync(["node", "homerail", "replay", "run-deploy-diagnosis"]);

    const output = logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(output).toContain("Deployment diagnosis completed.");
    expect(output).toContain("Categories: none");
    expect(output).toContain("No replay next steps provided by this run.");
    expect(output).toContain("No replay acceptance criteria were recorded for this run.");
    expect(process.exitCode).toBe(0);
  });
});

// -- Trace -------------------------------------------------------------------

describe("trace command", () => {
  it("renders sessions with tool calls from API", async () => {
    // First call: getDagStatus
    const dagFetch = vi.spyOn(globalThis, "fetch");

    // DAG status response
    dagFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        success: true,
        message: "ok",
        data: {
          execution: {
            nodes: {
              coder: { status: "completed" },
              tester: { status: "completed" },
            },
          },
        },
      }),
    } as unknown as Response);

    // Node chat for coder
    dagFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        success: true,
        message: "ok",
        data: {
          messages: [
            { tool_name: "read", tool_input: { path: "/src/main.ts" } },
            { tool_name: "edit", tool_input: { path: "/src/main.ts" } },
            { tool_name: "handoff", tool_input: { port: "done", content: "Implementation complete" } },
          ],
        },
      }),
    } as unknown as Response);

    // Node chat for tester
    dagFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        success: true,
        message: "ok",
        data: {
          messages: [
            { tool_name: "bash", tool_input: { command: "npm test" } },
          ],
        },
      }),
    } as unknown as Response);

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const program = createProgram();
    await program.parseAsync(["node", "homerail", "trace", "run-300"]);

    const output = logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(output).toContain("Trace: (2 sessions)");
    expect(output).toContain("node coder");
    expect(output).toContain("node tester");
    expect(output).toContain("read");
    expect(output).toContain("/src/main.ts");
    expect(output).toContain("handoff");
    expect(output).toContain("npm test");
    expect(process.exitCode).toBe(0);
  });

  it("renders single node trace with --node filter", async () => {
    const dagFetch = vi.spyOn(globalThis, "fetch");

    // Node chat for coder (no DAG status call needed when --node is specified)
    dagFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        success: true,
        message: "ok",
        data: {
          messages: [
            { tool_name: "read", tool_input: { path: "/src/index.ts" } },
          ],
        },
      }),
    } as unknown as Response);

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const program = createProgram();
    await program.parseAsync(["node", "homerail", "trace", "run-301", "--node", "coder"]);

    const output = logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(output).toContain("Trace: (1 sessions)");
    expect(output).toContain("node coder");
    expect(process.exitCode).toBe(0);
  });

  it("renders JSON with --json flag", async () => {
    const dagFetch = vi.spyOn(globalThis, "fetch");

    dagFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        success: true,
        message: "ok",
        data: {
          execution: {
            nodes: { coder: { status: "completed" } },
          },
        },
      }),
    } as unknown as Response);

    dagFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        success: true,
        message: "ok",
        data: {
          messages: [
            { tool_name: "bash", tool_input: { command: "ls" } },
          ],
        },
      }),
    } as unknown as Response);

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const program = createProgram();
    await program.parseAsync(["node", "homerail", "--json", "trace", "run-302"]);

    const parsed = JSON.parse(logSpy.mock.calls[0][0]);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.length).toBe(1);
    expect(parsed[0].node_id).toBe("coder");
    expect(parsed[0].tool_calls.length).toBe(1);
    expect(process.exitCode).toBe(0);
  });

  it("falls back to run-scoped local Worker tool audit when Manager evidence is unavailable", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("manager unavailable"));
    const auditDir = path.join(tempHome, "audit", "tool-events");
    fs.mkdirSync(auditDir, { recursive: true });
    fs.writeFileSync(
      path.join(auditDir, "run-local.jsonl"),
      JSON.stringify({
        event: "tool_use",
        tool_name: "Bash",
        input: { command: "node homerail_cli/dist/cli.js doctor" },
        node_id: "diagnose",
        run_id: "run-local",
        ts: 1,
      }) + "\n",
    );

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const program = createProgram();
    await program.parseAsync(["node", "homerail", "trace", "run-local"]);

    const output = logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(output).toContain("Trace: (1 sessions)");
    expect(output).toContain("node diagnose");
    expect(output).toContain("Bash");
    expect(output).toContain("node homerail_cli/dist/cli.js doctor");
    expect(process.exitCode).toBe(0);
  });

  it("falls back to legacy global Worker tool audit filtered by run_id", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("manager unavailable"));
    const auditDir = path.join(tempHome, "audit");
    fs.mkdirSync(auditDir, { recursive: true });
    fs.writeFileSync(
      path.join(auditDir, "tool-events.jsonl"),
      [
        JSON.stringify({
          event: "tool_use",
          tool_name: "Bash",
          input: { command: "npm test" },
          node_id: "coder",
          run_id: "run-legacy",
          ts: 1,
        }),
        JSON.stringify({
          event: "tool_use",
          tool_name: "Bash",
          input: { command: "should-not-render" },
          node_id: "other",
          run_id: "run-other",
          ts: 2,
        }),
      ].join("\n"),
    );

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const program = createProgram();
    await program.parseAsync(["node", "homerail", "trace", "run-legacy", "--node", "coder"]);

    const output = logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(output).toContain("Trace: (1 sessions)");
    expect(output).toContain("node coder");
    expect(output).toContain("npm test");
    expect(output).not.toContain("should-not-render");
    expect(process.exitCode).toBe(0);
  });

  it("prints the complete local Claude SDK trace only when --raw is explicit", async () => {
    const traceDir = path.join(
      tempHome,
      "workspace",
      "run-raw",
      ".homerail-runtime",
      "audit",
      "claude-sdk-traces",
      "run-raw",
    );
    fs.mkdirSync(traceDir, { recursive: true });
    fs.writeFileSync(
      path.join(traceDir, "triage.jsonl"),
      [
        JSON.stringify({ record_type: "query_start", prompt: "diagnose" }),
        JSON.stringify({
          record_type: "sdk_message",
          sequence: 1,
          message: { type: "system", subtype: "thinking_tokens" },
        }),
      ].join("\n") + "\n",
    );
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const program = createProgram();
    await program.parseAsync([
      "node",
      "homerail",
      "trace",
      "run-raw",
      "--node",
      "triage",
      "--raw",
    ]);

    const output = logSpy.mock.calls.map((call) => call.join(" ")).join("\n");
    expect(output).toContain('"record_type":"query_start"');
    expect(output).toContain('"subtype":"thinking_tokens"');
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(0);
  });
});

// -- Stats -------------------------------------------------------------------

describe("stats command", () => {
  it("shows empty stats message when no stats file exists", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const program = createProgram();
    await program.parseAsync(["node", "homerail", "stats"]);

    const output = logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(output).toContain("No stats recorded yet");
    expect(process.exitCode).toBe(0);
  });

  it("renders JSON for empty stats with --json", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const program = createProgram();
    await program.parseAsync(["node", "homerail", "--json", "stats"]);

    const parsed = JSON.parse(logSpy.mock.calls[0][0]);
    expect(parsed.summary.total).toBe(0);
    expect(parsed.summary.earliest).toBeNull();
  });

  it("reads stats from HOMERAIL_HOME when configured", async () => {
    const previousHome = process.env.HOMERAIL_HOME;
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "homerail-cli-stats-"));
    try {
      process.env.HOMERAIL_HOME = tempHome;
      const statsDir = path.join(tempHome, "cli");
      fs.mkdirSync(statsDir, { recursive: true });
      fs.writeFileSync(
        path.join(statsDir, "stats.jsonl"),
        JSON.stringify({
          timestamp: "2026-06-18T00:00:00.000Z",
          template: "public-dev-5node",
          agents: ["planner", "implementer"],
        }) + "\n",
      );

      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      const program = createProgram();
      await program.parseAsync(["node", "homerail", "--json", "stats"]);

      const parsed = JSON.parse(logSpy.mock.calls[0][0]);
      expect(parsed.summary.total).toBe(1);
      expect(parsed.top_orchestrations[0].template).toBe("public-dev-5node");
    } finally {
      if (previousHome === undefined) {
        delete process.env.HOMERAIL_HOME;
      } else {
        process.env.HOMERAIL_HOME = previousHome;
      }
      fs.rmSync(tempHome, { recursive: true, force: true });
    }
  });
});
