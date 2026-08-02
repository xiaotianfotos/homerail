import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { DAGDispatcher, DispatchEnvelope } from "../src/orchestration/dag-dispatcher.js";
import { GraphExecutor } from "../src/orchestration/graph-executor.js";
import { parseWorkflowSource } from "../src/orchestration/workflow-spec-v1.js";
import { createCredential } from "../src/persistence/credentials.js";
import { closeDb } from "../src/persistence/db.js";
import {
  resolveDagRunInputBindings,
  stageDagRunInputArtifact,
} from "../src/persistence/run-input-artifacts.js";
import {
  _clearActiveRuns,
  createActiveRun,
  getActiveRun,
  handoffActiveRun,
  recordActiveRunBrokerActionSuccess,
  requestNodeCorrection,
  recoverAllActiveRuns,
} from "../src/runtime/active-runs.js";

const TEMPLATE = path.resolve(import.meta.dirname, "../../assets/orchestrations/auto-fix-v2.yaml.template");

class ReentrantDispatcher implements DAGDispatcher {
  dispatched: DispatchEnvelope[] = [];

  dispatch(envelope: DispatchEnvelope) {
    this.dispatched.push(envelope);
    return { status: "dispatched" as const, targetType: "fake" as const, targetId: "fake" };
  }
}

function git(cwd: string, args: string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", shell: false });
  if (result.status !== 0) throw new Error(String(result.stderr || result.error));
  return String(result.stdout).trim();
}

describe("Auto Fix v2 document-first dynamic architecture", () => {
  let home: string;
  let previousHome: string | undefined;
  let head: string;

  beforeEach(() => {
    previousHome = process.env.HOMERAIL_HOME;
    home = fs.mkdtempSync(path.join(os.tmpdir(), "homerail-autofix-v2-"));
    process.env.HOMERAIL_HOME = home;
    closeDb();
    _clearActiveRuns();

    createCredential({
      id: "github-autofix",
      credential_type: "api_key",
      name: "Autofix broker token",
      secret: { value: "fake-github-token" },
    }, { actor: "test" });

    const repository = path.join(home, "workspace", "autofix-v2-run", "repo");
    fs.mkdirSync(repository, { recursive: true });
    git(repository, ["init", "--initial-branch=main"]);
    git(repository, ["config", "user.name", "HomeRail Test"]);
    git(repository, ["config", "user.email", "homerail@example.invalid"]);
    fs.writeFileSync(path.join(repository, "README.md"), "fixture\n");
    git(repository, ["add", "README.md"]);
    git(repository, ["commit", "-m", "fixture"]);
    head = git(repository, ["rev-parse", "HEAD"]);
  });

  afterEach(() => {
    _clearActiveRuns();
    closeDb();
    if (previousHome === undefined) delete process.env.HOMERAIL_HOME;
    else process.env.HOMERAIL_HOME = previousHome;
    const inputRoot = path.join(home, "workspace", "autofix-v2-run", "input");
    if (fs.existsSync(inputRoot)) fs.chmodSync(inputRoot, 0o700);
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("parses to a compact graph and completes five fresh review rounds with recovered dynamic fixers", () => {
    const source = fs.readFileSync(TEMPLATE, "utf8");
    const parsed = parseWorkflowSource(source);
    expect(parsed.meta.workflow_id).toBe("auto-fix-v2");
    expect(parsed.graph.nodes).toHaveLength(8);
    expect(parsed.graph.edges.length).toBeLessThanOrEqual(28);
    expect(source).not.toMatch(/\bmax_[a-z_]*tool_calls[a-z_]*:/);
    for (const nodeId of ["implement", "fix"]) {
      expect(parsed.graph.nodes.find((node) => node.node_id === nodeId)?.gateway_config).toMatchObject({
        workspace_strategy: "isolated_git_worktree",
        worker_policy: {
          workspace_access: { writable_paths: ["{{fanout_workspace}}"], readonly_paths: ["input"] },
        },
      });
    }
    for (const agent of Object.values(parsed.meta.agents ?? {})) agent.agent_type = "deterministic";

    const task = stageDagRunInputArtifact({
      scope_id: "pilot",
      name: "task.md",
      media_type: "text/markdown",
      content: "# Issue 172\n\nImplement the durable document-first Auto Fix v2 acceptance criteria.\n",
    });
    const pr = stageDagRunInputArtifact({
      scope_id: "pilot",
      name: "pr-context.json",
      media_type: "application/json",
      content: JSON.stringify({
        version: 1,
        owner: "acme",
        repo: "widget",
        pull_number: 172,
        clone_url: "https://github.com/acme/widget.git",
        head_ref: "autofix/issue-172",
        base_ref: "main",
        initial_head_sha: head,
        base_sha: head,
        task_document_sha256: task.sha256,
        require_draft: true,
        writable_paths: ["src", "tests"],
        required_checks: ["unit"],
      }),
    });
    const bindings = resolveDagRunInputBindings("pilot", [
      { artifact_id: task.artifact_id, logical_name: "task_document", mount_path: "input/task.md" },
      { artifact_id: pr.artifact_id, logical_name: "pr_context", mount_path: "input/pr-context.json" },
    ]);
    createActiveRun("autofix-v2-run", parsed, { initialPrompt: "{}", inputArtifacts: bindings });
    const dispatcher = new ReentrantDispatcher();
    const executor = new GraphExecutor(dispatcher);

    handoffActiveRun("autofix-v2-run", "prepare_repository", "ready", {
      repository_path: "repo",
      head,
    });
    executor.tick("autofix-v2-run");
    expect(dispatcher.dispatched.at(-1)?.nodeId).toBe("analyze");
    handoffActiveRun("autofix-v2-run", "analyze", "planned", {
      tasks: [
        { id: "runtime", title: "Runtime", description: "Implement runtime", acceptance: ["passes"] },
        { id: "tests", title: "Tests", description: "Add tests", acceptance: ["passes"] },
      ],
      shared: { repository_path: "repo", task_document: "input/task.md", pr_context: "input/pr-context.json" },
    });
    executor.tick("autofix-v2-run");
    expect(dispatcher.dispatched.filter((entry) => entry.nodeId.startsWith("implement__item_"))).toHaveLength(2);
    for (let index = 1; index <= 2; index++) {
      const nodeId = `implement__item_${String(index).padStart(4, "0")}`;
      const workspacePath = `workers/implement/inv_0001/item_${String(index).padStart(4, "0")}`;
      expect(fs.existsSync(path.join(home, "workspace", "autofix-v2-run", workspacePath, ".git"))).toBe(true);
      const child = getActiveRun("autofix-v2-run")?.dagRun.graph.nodes.find((node) => node.node_id === nodeId);
      expect(child?.extra?.agent_runtime).toMatchObject({
        workspace_access: { writable_paths: [workspacePath], readonly_paths: ["input"] },
        allowed_dag_tools: ["handoff"],
        credentials: [],
      });
      if (index === 1) {
        expect(() => handoffActiveRun("autofix-v2-run", nodeId, "result", {
          status: "implemented",
          task_id: "runtime",
          commit_sha: "f".repeat(40),
          workspace_path: workspacePath,
          summary: "fabricated commit",
          tests: [],
        })).toThrow(/^DAG_FANOUT_GIT_RESULT_INVALID /);
        expect(getActiveRun("autofix-v2-run")?.dagRun.nodeStates.get(nodeId)).toBe("RUNNING");
        expect(() => handoffActiveRun("autofix-v2-run", nodeId, "result", {
          status: "implemented",
          task_id: "runtime",
          commit_sha: head,
          workspace_path: "workers/implement/inv_0001/item_0002",
          summary: "wrong workspace",
          tests: [],
        })).toThrow("DAG_FANOUT_GIT_RESULT_INVALID workspace");
        expect(getActiveRun("autofix-v2-run")?.dagRun.nodeStates.get(nodeId)).toBe("RUNNING");
        const dirtyPath = path.join(home, "workspace", "autofix-v2-run", workspacePath, "dirty.tmp");
        fs.writeFileSync(dirtyPath, "uncommitted");
        expect(() => handoffActiveRun("autofix-v2-run", nodeId, "result", {
          status: "implemented",
          task_id: "runtime",
          commit_sha: head,
          workspace_path: workspacePath,
          summary: "dirty workspace",
          tests: [],
        })).toThrow("DAG_FANOUT_GIT_RESULT_INVALID isolated worktree has uncommitted changes");
        expect(getActiveRun("autofix-v2-run")?.dagRun.nodeStates.get(nodeId)).toBe("RUNNING");
        fs.rmSync(dirtyPath);
      }
      handoffActiveRun("autofix-v2-run", nodeId, "result", {
        status: "implemented",
        task_id: index === 1 ? "runtime" : "tests",
        commit_sha: head,
        workspace_path: workspacePath,
        summary: "implemented",
        tests: ["fixture"],
      });
    }
    executor.tick("autofix-v2-run");
    expect(dispatcher.dispatched.at(-1)?.nodeId).toBe("aggregate");
    expect(dispatcher.dispatched.at(-1)?.credentialProjections).toMatchObject([{
      broker: "github_pr",
      allowed_actions: ["pull_request_snapshot", "commit_files"],
    }]);
    handoffActiveRun("autofix-v2-run", "aggregate", "candidate", {
      head_sha: head,
      review_round: 1,
      summary: "candidate",
      tests: ["fixture"],
    });
    executor.tick("autofix-v2-run");
    expect(dispatcher.dispatched.at(-1)?.nodeId).toBe("review_initial");
    const reviewSessions: string[] = [dispatcher.dispatched.at(-1)?.sessionId ?? ""];
    handoffActiveRun("autofix-v2-run", "review_initial", "reviewed", {
      verdict: "changes_requested",
      head_sha: head,
      review_round: 1,
      summary: "round 1",
      feedback: ["fix round 1"],
      fix_tasks: [{ id: "round-1", feedback: ["fix round 1"] }],
    });

    for (let fixRound = 1; fixRound <= 4; fixRound++) {
      executor.tick("autofix-v2-run");
      const fixerId = fixRound === 1
        ? "fix__item_0001"
        : `fix__inv_${String(fixRound).padStart(4, "0")}__item_0001`;
      const fixerEnvelope = dispatcher.dispatched.find((entry) => entry.nodeId === fixerId);
      expect(fixerEnvelope).toBeDefined();
      expect(fixerEnvelope?.credentialProjections).toMatchObject([{
        broker: "github_pr",
        allowed_actions: ["pull_request_snapshot", "commit_files"],
      }]);
      handoffActiveRun("autofix-v2-run", fixerId, "result", {
        status: "fixed",
        previous_head_sha: head,
        head_sha: head,
        summary: `fixed ${fixRound}`,
        tests: ["fixture"],
      });
      executor.tick("autofix-v2-run");
      const reviewEnvelope = dispatcher.dispatched.at(-1)!;
      expect(reviewEnvelope.nodeId).toBe("review_revision");
      reviewSessions.push(reviewEnvelope.sessionId!);
      const reviewRound = fixRound + 1;
      if (reviewRound === 2) {
        recordActiveRunBrokerActionSuccess({
          run_id: "autofix-v2-run",
          node_id: "review_revision",
          session_id: reviewEnvelope.sessionId!,
          credential_ref: "github-autofix",
          broker: "github_pr",
          action: "required_checks",
        });
      }
      if (reviewRound === 5) {
        const approval = {
          verdict: "approve",
          head_sha: head,
          review_round: reviewRound,
          summary: "approved",
          feedback: [],
          fix_tasks: [],
        };
        expect(() => handoffActiveRun("autofix-v2-run", "review_revision", "reviewed", approval))
          .toThrow(/DAG_HANDOFF_BROKER_REQUIREMENT_MISSING/);
        expect(requestNodeCorrection(
          "autofix-v2-run",
          "review_revision",
          "approve handoff omitted required broker verification",
        ).status).toBe("scheduled");
        executor.tick("autofix-v2-run");
        expect(dispatcher.dispatched.at(-1)).toMatchObject({
          nodeId: "review_revision",
          sessionId: reviewEnvelope.sessionId,
        });
        expect(dispatcher.dispatched.at(-1)?.inputs.correction?.[0]).toContain(
          "github-autofix/github_pr/required_checks",
        );
        expect(dispatcher.dispatched.at(-1)?.credentialProjections).toMatchObject([{
          credential_ref: "github-autofix",
          broker: "github_pr",
          allowed_actions: ["required_checks"],
        }]);
        recordActiveRunBrokerActionSuccess({
          run_id: "autofix-v2-run",
          node_id: "review_revision",
          session_id: reviewEnvelope.sessionId!,
          credential_ref: "github-autofix",
          broker: "github_pr",
          action: "required_checks",
        });
        expect(() => handoffActiveRun("autofix-v2-run", "review_revision", "reviewed", {
          verdict: "approve",
          head_sha: head,
          review_round: reviewRound,
          feedback: [],
          fix_tasks: [],
        })).toThrow(/DAG_HANDOFF_CONTRACT_VIOLATION/);
        expect(requestNodeCorrection(
          "autofix-v2-run",
          "review_revision",
          "approve handoff omitted required summary",
        ).status).toBe("scheduled");
        executor.tick("autofix-v2-run");
        expect(dispatcher.dispatched.at(-1)).toMatchObject({
          nodeId: "review_revision",
          sessionId: reviewEnvelope.sessionId,
        });
        handoffActiveRun("autofix-v2-run", "review_revision", "reviewed", approval);
      } else {
        handoffActiveRun("autofix-v2-run", "review_revision", "reviewed", {
          verdict: "changes_requested",
          head_sha: head,
          review_round: reviewRound,
          summary: `round ${reviewRound}`,
          feedback: [`fix round ${reviewRound}`],
          fix_tasks: [{ id: `round-${reviewRound}`, feedback: [`fix round ${reviewRound}`] }],
        });
      }

      if (fixRound === 1) {
        _clearActiveRuns();
        closeDb();
        expect(recoverAllActiveRuns().recovered).toContain("autofix-v2-run");
      }
    }
    executor.tick("autofix-v2-run");

    expect(new Set(reviewSessions).size).toBe(5);
    expect(getActiveRun("autofix-v2-run")?.status).toBe("completed");
    expect(getActiveRun("autofix-v2-run")?.counters.fanout_invocations).toMatchObject({
      implement: 1,
      fix: 4,
    });
    expect(getActiveRun("autofix-v2-run")?.dagRun.nodeStates.get("review_gate")).toBe("COMPLETED");
    expect(getActiveRun("autofix-v2-run")?.dagRun.graph.nodes.some((node) => node.node_id.includes("inv_0005"))).toBe(false);
    expect(getActiveRun("autofix-v2-run")?.dagRun.graph.nodes).toHaveLength(14);
  });
});
