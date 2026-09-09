import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeDb, getDb } from "../src/persistence/db.js";
import { createSetting, upsertProvider } from "../src/persistence/llm-settings.js";
import { parseWorkflowSource } from "../src/orchestration/workflow-spec-v1.js";
import { GraphExecutor } from "../src/orchestration/graph-executor.js";
import { ChangeOrchestrator } from "../src/orchestration/change-orchestrator.js";
import { _clearActiveRuns, getActiveRun, recoverPreDispatchRun, restoreActiveRun, migrateLegacyReasoningEffortFailure, cancelActiveRun } from "../src/runtime/active-runs.js";
import { inspectDispatchRecovery, recoveryDigest, type DispatchRecoveryRequest } from "../src/runtime/dag-dispatch-recovery.js";
import { preflightDagAgentRuntimes } from "../src/runtime/dag-runtime-preflight.js";
import { loadRunMetadata, appendEvent, writeRunMetadata } from "../src/persistence/store.js";
import { getDagSessionIndex } from "../src/persistence/dag-session-index.js";
import { listDagRunRounds } from "../src/persistence/dag-run-rounds.js";
import { subscribe } from "../src/events/bus.js";
import { createServer } from "../src/server/http.js";
import { upsertDagWorkflowFromYaml, upsertDagRuntimeProfileFromYaml } from "../src/persistence/dag-workflows.js";

describe.skipIf(process.platform !== "linux")("pre-dispatch recovery", () => {
  let root: string;
  let setting: string;
  let savedHome: string | undefined;
  let savedAllowlist: string | undefined;
  let unsubscribe: () => void;
  const dispatch = vi.fn(() => ({ status: "dispatched" as const, targetType: "worker", targetId: "fixture" }));
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "hr-pre-dispatch-"));
    savedHome = process.env.HOMERAIL_HOME; savedAllowlist = process.env.HOMERAIL_DAG_COMMAND_ALLOWLIST;
    process.env.HOMERAIL_HOME = root; process.env.HOMERAIL_DAG_COMMAND_ALLOWLIST = process.execPath;
    closeDb(); _clearActiveRuns(); dispatch.mockClear();
    upsertProvider({ id: "local", default_model: "qwen", base_url: "http://127.0.0.1:1/v1" });
    setting = createSetting({ provider_id: "local", model_name: "qwen", api_key: "test-only", protocol: "openai_compatible",
      base_url: "http://127.0.0.1:1/v1", is_active: true }).id;
    unsubscribe = subscribe("dag:node_failed", payload => appendEvent("root", { type: "dag:node_failed", payload, timestamp: Date.now() }));
  });
  afterEach(() => {
    unsubscribe(); _clearActiveRuns(); closeDb();
    if (savedHome === undefined) delete process.env.HOMERAIL_HOME; else process.env.HOMERAIL_HOME = savedHome;
    if (savedAllowlist === undefined) delete process.env.HOMERAIL_DAG_COMMAND_ALLOWLIST; else process.env.HOMERAIL_DAG_COMMAND_ALLOWLIST = savedAllowlist;
    fs.rmSync(root, { recursive: true, force: true });
  });
  function source() {
    return JSON.stringify({ api_version: "homerail.ai/v1", kind: "Workflow", metadata: { id: "recovery", name: "Recovery fixture" }, spec: {
      agents: { fixer: { system: "Fix" }, reviewer: { system: "Review" } },
      nodes: {
        plan: { kind: "command", inputs: { task: { contract: "Task" } }, outputs: { result: {}, failed: {} }, config: {
          command: [process.execPath, "-e", `require('fs').appendFileSync(${JSON.stringify(path.join(root, "planner-count"))}, 'x'); console.log('{"plan":"preserve-me"}')`],
          durable: true, timeout_ms: 3000, parse_stdout: "json", result_payload: "value", success_port: "result", failure_port: "failed" } },
        failure: { kind: "terminal", outcome: "failure", inputs: { result: {} } },
        fix: { kind: "agent", agent: "fixer", inputs: { evidence: {} }, outputs: { result: {} } },
        review: { kind: "agent", agent: "reviewer", inputs: { evidence: {} }, outputs: { result: {} } },
        done: { kind: "terminal", outcome: "success", inputs: { result: {} } },
      }, contracts: { Task: { type: "object" } },
      edges: [{ from: "$run.input", to: "plan.task" }, { from: "plan.failed", to: "failure.result", condition: "on_failure" }, { from: "plan.result", to: "fix.evidence" },
        { from: "fix.result", to: "review.evidence" }, { from: "review.result", to: "done.result" }],
    } });
  }
  function parsed() {
    const workflow = parseWorkflowSource(source());
    for (const agent of Object.values(workflow.meta.agents!)) Object.assign(agent, {
      agent_type: "deepseek_harness", llm_setting_id: setting, llm: { reasoning_effort: "low" },
    });
    return workflow;
  }
  async function failed() {
    // Direct executor bypass models configuration becoming invalid after
    // admission; normal ChangeOrchestrator admission now catches it first.
    const executor = new GraphExecutor({ dispatch });
    executor.createRun("root", parsed(), "{}"); executor.tick("root");
    await vi.waitFor(() => expect(getActiveRun("root")?.status).toBe("failed"), { timeout: 5000, interval: 20 });
    expect(dispatch).not.toHaveBeenCalled();
    return executor;
  }
  function request(): DispatchRecoveryRequest {
    return { request_id: "recovery-1", expected_state_sha256: inspectDispatchRecovery("root").expected_state_sha256,
      clear_reasoning_effort_for: ["fixer", "reviewer"], reason: "Remove unsupported selection; preserve original model and plan" };
  }
  it("rejects downstream runtime config before spending on a host Planner", () => {
    const workflow = parsed();
    delete workflow.meta.agents!.fixer.llm!.reasoning_effort;
    expect(() => preflightDagAgentRuntimes(workflow.graph, workflow.meta.agents)).toThrow(/reviewer.*selectable/);
    upsertDagWorkflowFromYaml({ yaml_text: source() });
    upsertDagRuntimeProfileFromYaml({ workflow_id: "recovery", yaml_text: JSON.stringify({ profile_id: "local",
      default: { agent_type: "deepseek_harness", llm_setting_id: setting, reasoning_effort: "low" } }) });
    const orchestrator = new ChangeOrchestrator(new GraphExecutor({ dispatch }));
    expect(() => orchestrator.createAndRun({ workflowId: "recovery", profile: "local", runId: "root", prompt: "{}" })).toThrow(/preflight/);
    expect(loadRunMetadata("root")).toBeUndefined(); expect(fs.existsSync(path.join(root, "planner-count"))).toBe(false);
  });
  it("keeps the plan and round, clears every affected role, and dispatches once after commit/restart", async () => {
    await failed();
    const previous = loadRunMetadata("root")!;
    const oldSession = getDagSessionIndex("root", "fix")!;
    const intent = request();
    const result = recoverPreDispatchRun("root", intent);
    expect(result.receipt.preserved_nodes).toEqual(["plan"]);
    expect(result.receipt.round_id).toBe(previous.currentRound!.round_id);
    expect(getActiveRun("root")!.createdAt).toBe(previous.createdAt);
    expect(getActiveRun("root")!.counters).toEqual(previous.counters);
    expect(getDagSessionIndex("root", "fix")!.session_id).not.toBe(oldSession.session_id);
    expect(getDagSessionIndex("root", "plan")!.attempt).toBe(1);
    _clearActiveRuns(); closeDb(); // crash after recovery commit, before dispatch
    const recovered = restoreActiveRun(loadRunMetadata("root")!);
    expect(recovered.status).toBe("restored");
    const executor = new GraphExecutor({ dispatch }); executor.tick("root"); executor.tick("root");
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect((dispatch.mock.calls as any)[0][0].inputs.evidence).toEqual([{ plan: "preserve-me" }]);
    expect(recoverPreDispatchRun("root", intent)).toEqual({ ...result, deduplicated: true });
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(fs.readFileSync(path.join(root, "planner-count"), "utf8")).toBe("x");
    expect(listDagRunRounds("root")).toHaveLength(1);
    expect(getActiveRun("root")!.agents!.reviewer.llm!.reasoning_effort).toBeUndefined();
  });
  it("rejects stale or incomplete correction and conflicting duplicate requests atomically", async () => {
    await failed(); const intent = request(); const previous = loadRunMetadata("root");
    expect(() => recoverPreDispatchRun("root", { ...intent, expected_state_sha256: "0".repeat(64) })).toThrow(/state conflict/);
    expect(() => recoverPreDispatchRun("root", { ...intent, clear_reasoning_effort_for: ["fixer"] })).toThrow(/reviewer.*preflight/);
    expect(loadRunMetadata("root")).toEqual(previous);
    expect(listDagRunRounds("root")[0].status).toBe("failed");
    recoverPreDispatchRun("root", intent);
    expect(() => recoverPreDispatchRun("root", { ...intent, request_id: "different" })).toThrow(/request conflict/);
  });
  it("rejects possible Worker execution even when usage and dispatch counters are empty", async () => {
    await failed(); const intent = request();
    getDb().prepare("UPDATE dag_actor_runtimes SET lease_generation = 1 WHERE run_id = ?").run("root");
    expect(() => recoverPreDispatchRun("root", intent)).toThrow(/previously leased/);
    expect(loadRunMetadata("root")!.status).toBe("failed");
  });
  it("does not reuse a modified trusted command log", async () => {
    await failed(); const intent = request();
    const command = getDb().prepare("SELECT execution_id FROM dag_durable_commands WHERE run_id = ?").get("root") as { execution_id: string };
    fs.appendFileSync(path.join(root, "trusted-commands", command.execution_id, "stdout.log"), "tampered");
    expect(() => recoverPreDispatchRun("root", intent)).toThrow(/uncertain native command/);
  });
  it("migrates only an exactly reproducible legacy resolver failure", async () => {
    await failed(); const previous = loadRunMetadata("root")!;
    getDb().prepare("DELETE FROM dag_dispatch_recoveries WHERE run_id = ?").run("root");
    migrateLegacyReasoningEffortFailure("root", recoveryDigest(previous));
    recoverPreDispatchRun("root", request());
    expect(getActiveRun("root")!.dagRun.nodeStates.get("fix")).toBe("READY");
    expect(fs.readFileSync(path.join(root, "planner-count"), "utf8")).toBe("x");
  });
  it("rolls back round, session, metadata and memory when recovery receipt commit fails", async () => {
    await failed(); const intent = request(); const previous = loadRunMetadata("root")!;
    const session = getDagSessionIndex("root", "fix");
    getDb().exec("CREATE TEMP TRIGGER reject_recovery BEFORE UPDATE ON dag_dispatch_recoveries BEGIN SELECT RAISE(ABORT, 'injected commit failure'); END");
    expect(() => recoverPreDispatchRun("root", intent)).toThrow(/injected commit failure/);
    expect(loadRunMetadata("root")).toEqual(previous);
    expect(getActiveRun("root")!.status).toBe("failed");
    expect(getDagSessionIndex("root", "fix")).toEqual(session);
    expect(listDagRunRounds("root")[0].status).toBe("failed");
    expect(inspectDispatchRecovery("root").receipt).toBeUndefined();
    expect(dispatch).not.toHaveBeenCalled();
    getDb().exec("DROP TRIGGER reject_recovery");
    expect(recoverPreDispatchRun("root", intent).deduplicated).toBe(false);
  });
  it.each(["completed", "cancelled"] as const)("cannot reopen a %s root", async status => {
    await failed(); const intent = request(); const metadata = loadRunMetadata("root")!;
    metadata.status = status; writeRunMetadata("root", metadata);
    expect(() => recoverPreDispatchRun("root", intent)).toThrow(/state conflict/);
    expect(dispatch).not.toHaveBeenCalled();
  });
  it("refuses a legacy state whose mailbox cannot be reconstructed from handoffs", async () => {
    await failed(); const metadata = loadRunMetadata("root")!;
    getDb().prepare("DELETE FROM dag_dispatch_recoveries WHERE run_id = ?").run("root");
    metadata.dagRuntimeState!.mailboxes.fix.evidence = [{ plan: "invented" }]; writeRunMetadata("root", metadata);
    expect(() => migrateLegacyReasoningEffortFailure("root", recoveryDigest(metadata))).toThrow(/differs from persisted/);
    expect(loadRunMetadata("root")!.status).toBe("failed");
  });
  it("re-admits a terminal root under workflow concurrency policy and leaves no leaked reservation", async () => {
    await failed(); const intent = request();
    const workflow = JSON.parse(source());
    workflow.spec.triggers = { push: { type: "event", event: "repo.push", overlap: "allow", max_concurrency: 1 } };
    upsertDagWorkflowFromYaml({ yaml_text: JSON.stringify(workflow) });
    const executor = new GraphExecutor({ dispatch }); executor.createRun("occupied", parsed(), "{}");
    expect(() => recoverPreDispatchRun("root", intent)).toThrow(/admission conflict/);
    expect(loadRunMetadata("root")!.status).toBe("failed");
    expect(inspectDispatchRecovery("root").receipt).toBeUndefined();
    cancelActiveRun("occupied");
    expect(recoverPreDispatchRun("root", intent).deduplicated).toBe(false);
    expect(recoverPreDispatchRun("root", intent).deduplicated).toBe(true);
    expect(getDb().prepare("SELECT COUNT(*) AS count FROM dag_run_admissions").get()).toEqual({ count: 0 });
  });
  it("exposes inspection and idempotent recovery through the real HTTP router", async () => {
    await failed();
    const server = createServer(0, undefined, { dispatch }, false);
    try {
      await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
      const address = server.address() as { port: number };
      const url = `http://127.0.0.1:${address.port}/api/runs/root/pre-dispatch-recovery`;
      const inspection = await fetch(url); const inspected = await inspection.json();
      expect(inspection.status).toBe(200);
      expect(inspected.data.expected_state_sha256).toBe(recoveryDigest(loadRunMetadata("root")));
      const options = { method: "POST", headers: { "content-type": "application/json",
        "x-homerail-dag-token": process.env.HOMERAIL_DAG_MUTATION_TOKEN ?? "" }, body: JSON.stringify(request()) };
      const response = await fetch(url, options); const first = await response.json();
      expect(response.status).toBe(200); expect(first.data.deduplicated).toBe(false);
      const repeated = await fetch(url, options); const second = await repeated.json();
      expect(repeated.status).toBe(200); expect(second.data.deduplicated).toBe(true);
      expect(second.data.receipt).toEqual(first.data.receipt);
      expect(dispatch).toHaveBeenCalledTimes(1);
      expect(fs.readFileSync(path.join(root, "planner-count"), "utf8")).toBe("x");
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });
});
