import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { parseWorkflowSource } from "../src/orchestration/workflow-spec-v1.js";
import type { DAGDispatcher, DispatchEnvelope } from "../src/orchestration/dag-dispatcher.js";
import { GraphExecutor } from "../src/orchestration/graph-executor.js";
import { closeDb, getDb } from "../src/persistence/db.js";
import { createCredential } from "../src/persistence/credentials.js";
import { getDagActorByNode } from "../src/persistence/dag-actors.js";
import { acquireDagActorLease } from "../src/persistence/dag-actor-leases.js";
import {
  resolveDagRunInputBindings,
  stageDagRunInputArtifact,
} from "../src/persistence/run-input-artifacts.js";
import {
  _clearActiveRuns,
  cancelActiveRun,
  createActiveRun,
  getActiveRun,
  getCurrentNodeSession,
  handoffActiveRun,
  markNodeDispatched,
  recoverAllActiveRuns,
} from "../src/runtime/active-runs.js";
import { executeCredentialBrokerCall } from "../src/runtime/credential-broker.js";

const INITIAL_HEAD = "a".repeat(40);
const BASE_HEAD = "b".repeat(40);
const BASE_TREE = "c".repeat(40);
const BLOB = "d".repeat(40);
const NEXT_HEAD = "e".repeat(40);
const NEXT_TREE = "f".repeat(40);

function workflow(): string {
  const binding = (actions: string) => `
        - credential_ref: github-autofix
          purpose: bounded Draft PR access
          inject:
            mode: manager_broker
            broker: github_pr
            allowed_actions: [${actions}]`;
  return `
api_version: homerail.ai/v1
kind: Workflow
metadata: { id: github-broker-test, name: GitHub broker test }
spec:
  contracts:
    Task: { type: object }
  agents:
    actor: { system: Use only the declared GitHub broker actions. }
  nodes:
    aggregate:
      kind: agent
      agent: actor
      allowed_dag_tools: [handoff, credential_broker_call]
      workspace_access: { writable_paths: [repo], readonly_paths: [input] }
      credentials:${binding("pull_request_snapshot, commit_files, commit_workspace")}
      inputs: { task: { contract: Task } }
      outputs: { done: {} }
    reviewer:
      kind: agent
      agent: actor
      allowed_dag_tools: [handoff, credential_broker_call]
      credentials:${binding("pull_request_snapshot, read_diff, read_file, assess_review, checks_snapshot, required_checks, validate_head")}
      inputs: { task: {} }
      outputs:
        reviewed:
          required_broker_actions:
            - credential_ref: github-autofix
              broker: github_pr
              action: required_checks
              when: { field: verdict, equals: approve }
    implementer:
      kind: agent
      agent: actor
      inputs: { task: {} }
      outputs: { done: {} }
    done: { kind: terminal, outcome: success, inputs: { result: {} } }
  edges:
    - { from: $run.input, to: aggregate.task }
    - { from: aggregate.done, to: reviewer.task }
    - { from: reviewer.reviewed, to: implementer.task }
    - { from: implementer.done, to: done.result }
`;
}

describe("bounded GitHub Draft PR credential broker", () => {
  let home: string;
  let previousHome: string | undefined;
  let remoteHead: string;
  let pullState: string;
  let headRepository: string;
  let checkName: string;
  let checkConclusion: string;
  let pullFileCount: number;
  let pullBody: string;
  let pullPatch: string;
  let readFileContent: string;
  let createdTreeSha: string;
  let checkRunsResponses: Array<Array<Record<string, unknown>>> | undefined;
  let workflowRunsResponses: Array<Array<Record<string, unknown>>> | undefined;
  let workflowJobs: Map<number, Array<Record<string, unknown>>>;
  let workflowDispatches: Array<Record<string, unknown>>;
  let jobLogs: Map<number, string>;
  let jobLogRequests: number[];
  let brokerRequestSequence: number;
  let refUpdateStarted: (() => void) | undefined;
  let refUpdateGate: Promise<void> | undefined;
  let refUpdateFailureStatus: number | undefined;
  let refUpdateTransportError: boolean;
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  class RecordingDispatcher implements DAGDispatcher {
    readonly dispatched: DispatchEnvelope[] = [];

    dispatch(envelope: DispatchEnvelope) {
      this.dispatched.push(envelope);
      return { status: "dispatched" as const, targetType: "fake" as const, targetId: "fake" };
    }
  }

  async function tickUntil(
    executor: GraphExecutor,
    runId: string,
    predicate: () => boolean,
    message: string,
  ): Promise<void> {
    for (let attempt = 0; attempt < 100; attempt++) {
      executor.tick(runId);
      if (predicate()) return;
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
    throw new Error(message);
  }

  async function waitUntil(predicate: () => boolean, message: string): Promise<void> {
    for (let attempt = 0; attempt < 100; attempt++) {
      if (predicate()) return;
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
    throw new Error(message);
  }

  function createBoundRun(
    runId: string,
    writablePaths: string[] = ["src", "tests", ".github"],
    initialHead = INITIAL_HEAD,
    validationWorkflow?: { workflow_id: string; inputs: Record<string, string> },
    workflowSource = workflow(),
    requiredChecks: string[] | null = ["unit"],
  ): void {
    const taskArtifact = stageDagRunInputArtifact({
      scope_id: runId,
      name: "task.md",
      media_type: "text/markdown",
      content: "# Bounded task\n",
    });
    const prArtifact = stageDagRunInputArtifact({
      scope_id: runId,
      name: "pr-context.json",
      media_type: "application/json",
      content: JSON.stringify({
        version: 1,
        owner: "acme",
        repo: "widget",
        pull_number: 7,
        clone_url: "https://github.com/acme/widget.git",
        head_ref: "autofix/issue-172",
        base_ref: "main",
        initial_head_sha: initialHead,
        base_sha: BASE_HEAD,
        task_document_sha256: taskArtifact.sha256,
        require_draft: true,
        writable_paths: writablePaths,
        ...(requiredChecks ? { required_checks: requiredChecks } : {}),
        ...(validationWorkflow ? { validation_workflow: validationWorkflow } : {}),
      }),
    });
    const bindings = resolveDagRunInputBindings(runId, [
      {
        artifact_id: taskArtifact.artifact_id,
        logical_name: "task_document",
        mount_path: "input/task.md",
      },
      {
        artifact_id: prArtifact.artifact_id,
        logical_name: "pr_context",
        mount_path: "input/pr-context.json",
      },
    ]);
    const parsed = parseWorkflowSource(workflowSource);
    for (const agent of Object.values(parsed.meta.agents ?? {})) agent.agent_type = "deterministic";
    createActiveRun(runId, parsed, { initialPrompt: "{}", inputArtifacts: bindings });
  }

  beforeEach(() => {
    previousHome = process.env.HOMERAIL_HOME;
    home = fs.mkdtempSync(path.join(os.tmpdir(), "homerail-github-broker-"));
    process.env.HOMERAIL_HOME = home;
    closeDb();
    _clearActiveRuns();
    remoteHead = INITIAL_HEAD;
    pullState = "open";
    headRepository = "acme/widget";
    checkName = "unit";
    checkConclusion = "success";
    pullFileCount = 1;
    pullBody = "Bound task";
    pullPatch = "@@ fake";
    readFileContent = "export const fixed = true;\n";
    createdTreeSha = NEXT_TREE;
    checkRunsResponses = undefined;
    workflowRunsResponses = undefined;
    workflowJobs = new Map();
    workflowDispatches = [];
    jobLogs = new Map();
    jobLogRequests = [];
    brokerRequestSequence = 0;
    refUpdateStarted = undefined;
    refUpdateGate = undefined;
    refUpdateFailureStatus = undefined;
    refUpdateTransportError = false;
    fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = new URL(String(input));
      const method = String(init?.method ?? "GET").toUpperCase();
      const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      });
      if (method === "GET" && url.pathname === "/repos/acme/widget/pulls/7") {
        return json({
          number: 7,
          title: "WIP autofix",
          body: pullBody,
          draft: true,
          state: pullState,
          html_url: "https://github.example/acme/widget/pull/7",
          head: { sha: remoteHead, ref: "autofix/issue-172", repo: { full_name: headRepository } },
          base: { sha: BASE_HEAD, ref: "main", repo: { full_name: "acme/widget" } },
        });
      }
      if (method === "GET" && url.pathname === "/repos/acme/widget/pulls/7/files") {
        const page = Number(url.searchParams.get("page") ?? 1);
        const offset = (page - 1) * 100;
        const count = Math.max(0, Math.min(100, pullFileCount - offset));
        return json(Array.from({ length: count }, (_, index) => ({
          filename: `src/fix-${offset + index}.ts`,
          sha: BLOB,
          status: "modified",
          additions: 2,
          deletions: 1,
          changes: 3,
          patch: pullPatch,
        })));
      }
      if (method === "GET" && url.pathname === "/repos/acme/widget/contents/src/fix.ts") {
        const content = Buffer.from(readFileContent).toString("base64");
        return json({ type: "file", encoding: "base64", content, sha: BLOB, size: Buffer.byteLength(readFileContent) });
      }
      if (method === "GET" && url.pathname.endsWith("/check-runs")) {
        const queued = checkRunsResponses?.shift();
        return json({
          check_runs: queued ?? [{ id: 1, name: checkName, status: "completed", conclusion: checkConclusion }],
        });
      }
      if (
        method === "GET"
        && url.pathname === "/repos/acme/widget/actions/workflows/autofix-validate.yml/runs"
      ) {
        return json({ workflow_runs: workflowRunsResponses?.shift() ?? [] });
      }
      if (method === "POST" && url.pathname === "/repos/acme/widget/actions/workflows/autofix-validate.yml/dispatches") {
        workflowDispatches.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return new Response(null, { status: 204 });
      }
      const workflowJobsMatch = url.pathname.match(/^\/repos\/acme\/widget\/actions\/runs\/(\d+)\/jobs$/);
      if (method === "GET" && workflowJobsMatch) {
        return json({ jobs: workflowJobs.get(Number(workflowJobsMatch[1])) ?? [] });
      }
      const jobLogMatch = url.pathname.match(/^\/repos\/acme\/widget\/actions\/jobs\/(\d+)\/logs$/);
      if (method === "GET" && jobLogMatch) {
        const jobId = Number(jobLogMatch[1]);
        jobLogRequests.push(jobId);
        const body = jobLogs.get(jobId);
        if (body !== undefined) {
          return new Response(body, {
            status: 200,
            headers: { "content-type": "text/plain", "content-length": String(Buffer.byteLength(body)) },
          });
        }
        return json({ message: "job log unavailable" }, 404);
      }
      if (method === "GET" && url.pathname === `/repos/acme/widget/git/commits/${remoteHead}`) {
        return json({ tree: { sha: BASE_TREE } });
      }
      if (method === "POST" && url.pathname === "/repos/acme/widget/git/blobs") return json({ sha: BLOB }, 201);
      if (method === "POST" && url.pathname === "/repos/acme/widget/git/trees") return json({ sha: createdTreeSha }, 201);
      if (method === "POST" && url.pathname === "/repos/acme/widget/git/commits") return json({ sha: NEXT_HEAD }, 201);
      if (method === "PATCH" && url.pathname === "/repos/acme/widget/git/refs/heads/autofix/issue-172") {
        refUpdateStarted?.();
        if (refUpdateGate) await refUpdateGate;
        if (refUpdateTransportError) throw new TypeError("GitHub connection reset");
        if (refUpdateFailureStatus !== undefined) {
          return json({ message: "ref update failed" }, refUpdateFailureStatus);
        }
        remoteHead = NEXT_HEAD;
        return json({ object: { sha: NEXT_HEAD } });
      }
      return json({ message: `unhandled ${method} ${url.pathname}` }, 404);
    });

    createCredential({
      id: "github-autofix",
      credential_type: "api_key",
      name: "GitHub Autofix App token",
      secret: { value: "github-secret-token-value" },
    }, { actor: "test" });
    createBoundRun("github-broker-run");
  });

  afterEach(() => {
    vi.useRealTimers();
    fetchSpy.mockRestore();
    _clearActiveRuns();
    closeDb();
    if (previousHome === undefined) delete process.env.HOMERAIL_HOME;
    else process.env.HOMERAIL_HOME = previousHome;
    const workspaceRoot = path.join(home, "workspace");
    if (fs.existsSync(workspaceRoot)) {
      for (const runId of fs.readdirSync(workspaceRoot)) {
        const inputRoot = path.join(workspaceRoot, runId, "input");
        if (fs.existsSync(inputRoot)) fs.chmodSync(inputRoot, 0o700);
      }
    }
    fs.rmSync(home, { recursive: true, force: true });
  });

  function call(
    nodeId: string,
    action: string,
    input: Record<string, unknown> = {},
    runId = "github-broker-run",
    sessionId = `session-${nodeId}`,
  ) {
    const run = getActiveRun(runId);
    if (!run) throw new Error(`unknown broker test run ${runId}`);
    if (run.dagRun.nodeStates.get(nodeId) !== "RUNNING") {
      // These provider-contract tests call individual nodes directly instead
      // of dispatching the whole graph. Give each call a real active Actor
      // turn so the production transport fence remains fully enforced.
      run.dagRun.nodeStates.set(nodeId, "READY");
      if (!markNodeDispatched(runId, nodeId)) {
        throw new Error(`could not start broker test node ${runId}/${nodeId}`);
      }
    }
    const actor = getDagActorByNode(runId, nodeId);
    const session = getCurrentNodeSession(runId, nodeId);
    if (!actor || !session) throw new Error(`missing broker test Actor fence ${runId}/${nodeId}`);
    const lease = acquireDagActorLease({
      run_id: runId,
      actor_id: actor.actor_id,
      target_type: "worker",
      target_id: "worker-one",
    });
    const requestId = `${nodeId}-${action}-${++brokerRequestSequence}`;
    return executeCredentialBrokerCall("worker-one", {
      request_id: requestId,
      idempotency_key: requestId,
      transport_kind: "worker_actor",
      run_id: runId,
      node_id: nodeId,
      session_id: session.sessionId,
      round_id: run.currentRound.round_id,
      actor_id: actor.actor_id,
      generation: actor.generation,
      lease_generation: lease.lease_generation,
      credential_ref: "github-autofix",
      broker: "github_pr",
      action,
      input,
    });
  }

  function initializeRepository(runId: string): {
    repository: string;
    git: (args: string[]) => string;
    head: string;
  } {
    const repository = path.join(home, "workspace", runId, "repo");
    fs.mkdirSync(path.join(repository, "src"), { recursive: true });
    const git = (args: string[]) => {
      const result = spawnSync("git", ["-C", repository, ...args], { encoding: "utf8", shell: false });
      if (result.status !== 0) throw new Error(String(result.stderr || result.error));
      return String(result.stdout).trim();
    };
    git(["init", "--initial-branch=main"]);
    git(["config", "user.name", "HomeRail Test"]);
    git(["config", "user.email", "homerail@example.invalid"]);
    fs.writeFileSync(path.join(repository, "src", "fix.ts"), "before\n");
    fs.writeFileSync(path.join(repository, "src", "remove.ts"), "remove me\n");
    git(["add", "src/fix.ts", "src/remove.ts"]);
    git(["commit", "-m", "fixture"]);
    return { repository, git, head: git(["rev-parse", "HEAD"]) };
  }

  it("keeps the token host-side and enforces per-node action and path allowlists", async () => {
    const snapshot = await call("reviewer", "pull_request_snapshot");
    expect(snapshot).toMatchObject({
      ok: true,
      result: { repository: "acme/widget", pull_number: 7, draft: true, head_sha: INITIAL_HEAD },
    });
    expect(JSON.stringify(snapshot)).not.toContain("github-secret-token-value");

    await expect(call("reviewer", "commit_files", {})).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining("not permitted"),
    });
    await expect(call("implementer", "pull_request_snapshot")).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining("not declared"),
    });
    const deniedWorkflow = await call("aggregate", "commit_files", {
      expected_head_sha: INITIAL_HEAD,
      message: "attempt workflow change",
      files: [{ path: ".github/workflows/pwn.yml", content_base64: Buffer.from("bad").toString("base64") }],
    });
    expect(deniedWorkflow).toMatchObject({ ok: false, error: expect.stringContaining("outside the PR write allowlist") });
    const deniedAction = await call("aggregate", "commit_files", {
      expected_head_sha: INITIAL_HEAD,
      message: "attempt local action change",
      files: [{ path: ".github/actions/pwn/action.yml", content_base64: Buffer.from("bad").toString("base64") }],
    });
    expect(deniedAction).toMatchObject({ ok: false, error: expect.stringContaining("outside the PR write allowlist") });
  });

  it("allows PR-only runs to omit CI configuration", async () => {
    createBoundRun("github-no-checks-run", ["src"], INITIAL_HEAD, undefined, workflow(), null);
    await expect(call("reviewer", "pull_request_snapshot", {}, "github-no-checks-run"))
      .resolves.toMatchObject({ ok: true, result: { head_sha: INITIAL_HEAD } });
    await expect(call("reviewer", "validate_head", {
      expected_head_sha: INITIAL_HEAD,
      manifest_sha256: "1".repeat(64),
      summary: "candidate",
      tests: ["focused"],
    }, "github-no-checks-run")).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining("not configured"),
    });
  });

  it("reads UTF-8 source bytes from the exact immutable PR head", async () => {
    const result = await call("reviewer", "read_file", {
      expected_head_sha: INITIAL_HEAD,
      path: "src/fix.ts",
    });
    expect(result).toMatchObject({
      ok: true,
      result: {
        head_sha: INITIAL_HEAD,
        path: "src/fix.ts",
        blob_sha: BLOB,
        offset: 0,
        next_offset: null,
        truncated: false,
        content: "export const fixed = true;\n",
      },
    });
    await expect(call("reviewer", "read_file", {
      expected_head_sha: "9".repeat(40),
      path: "src/fix.ts",
    })).resolves.toMatchObject({ ok: false, error: expect.stringContaining("stale") });
  });

  it("reads a large exact-head UTF-8 file through bounded inline chunks", async () => {
    readFileContent = "0123456789\n".repeat(25_000);
    let offset = 0;
    let reconstructed = "";
    let chunks = 0;
    do {
      const response = await call("reviewer", "read_file", {
        expected_head_sha: INITIAL_HEAD,
        path: "src/fix.ts",
        offset,
        max_chars: 24_000,
      }) as {
        ok: boolean;
        result: {
          content: string;
          offset: number;
          next_offset: number | null;
          total_chars: number;
          truncated: boolean;
        };
      };
      expect(response.ok).toBe(true);
      expect(response.result.offset).toBe(offset);
      expect(Buffer.byteLength(JSON.stringify(response), "utf8")).toBeLessThan(32 * 1024);
      reconstructed += response.result.content;
      chunks += 1;
      if (response.result.next_offset === null) {
        expect(response.result.truncated).toBe(false);
        break;
      }
      expect(response.result.truncated).toBe(true);
      expect(response.result.next_offset).toBeGreaterThan(offset);
      offset = response.result.next_offset;
    } while (chunks < 100);

    expect(chunks).toBeGreaterThan(1);
    expect(reconstructed).toBe(readFileContent);
  });

  it("rejects invalid read_file chunk bounds", async () => {
    await expect(call("reviewer", "read_file", {
      expected_head_sha: INITIAL_HEAD,
      path: "src/fix.ts",
      offset: -1,
    })).resolves.toMatchObject({ ok: false, error: expect.stringContaining("offset is invalid") });
    await expect(call("reviewer", "read_file", {
      expected_head_sha: INITIAL_HEAD,
      path: "src/fix.ts",
      max_chars: 24_001,
    })).resolves.toMatchObject({ ok: false, error: expect.stringContaining("max_chars") });
  });

  it("accepts exactly 100 PR files but rejects an unbounded second page", async () => {
    pullFileCount = 100;
    const exactBound = await call("reviewer", "pull_request_snapshot");
    expect(exactBound).toMatchObject({ ok: true });
    expect((exactBound as { result: { files: unknown[] } }).result.files).toHaveLength(100);
    pullFileCount = 101;
    await expect(call("reviewer", "pull_request_snapshot", {}, "github-broker-run", "second-page-session"))
      .resolves.toMatchObject({ ok: false, error: expect.stringContaining("exceeds the bounded snapshot") });
  });

  it("keeps a large PR snapshot inline by omitting per-file patches", async () => {
    pullFileCount = 100;
    pullBody = "body".repeat(20_000);
    pullPatch = "patch".repeat(20_000);

    const snapshot = await call("reviewer", "pull_request_snapshot") as {
      ok: boolean;
      result: { body: string; files: Array<Record<string, unknown>> };
    };

    expect(snapshot.ok).toBe(true);
    expect(snapshot.result.body.length).toBe(8_000);
    expect(snapshot.result.files).toHaveLength(100);
    expect(snapshot.result.files.every((file) => !("patch" in file))).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(snapshot), "utf8")).toBeLessThan(32 * 1024);
  });

  it("reads an exact-head PR patch through bounded inline chunks", async () => {
    pullPatch = "@@ -1 +1 @@\n-old\n+new\n".repeat(4_000);
    let offset = 0;
    let reconstructed = "";
    let chunks = 0;
    do {
      const response = await call("reviewer", "read_diff", {
        expected_head_sha: INITIAL_HEAD,
        path: "src/fix-0.ts",
        offset,
        max_chars: 24_000,
      }) as {
        ok: boolean;
        result: {
          head_sha: string;
          path: string;
          patch: string;
          patch_available: boolean;
          offset: number;
          next_offset: number | null;
        };
      };
      expect(response).toMatchObject({
        ok: true,
        result: {
          head_sha: INITIAL_HEAD,
          path: "src/fix-0.ts",
          patch_available: true,
          offset,
        },
      });
      expect(Buffer.byteLength(JSON.stringify(response), "utf8")).toBeLessThan(32 * 1024);
      reconstructed += response.result.patch;
      chunks += 1;
      if (response.result.next_offset === null) break;
      expect(response.result.next_offset).toBeGreaterThan(offset);
      offset = response.result.next_offset;
    } while (chunks < 100);

    expect(chunks).toBeGreaterThan(1);
    expect(reconstructed).toBe(pullPatch);
    await expect(call("reviewer", "read_diff", {
      expected_head_sha: "9".repeat(40),
      path: "src/fix-0.ts",
    })).resolves.toMatchObject({ ok: false, error: expect.stringContaining("stale") });
    await expect(call("reviewer", "read_diff", {
      expected_head_sha: INITIAL_HEAD,
      path: "src/not-changed.ts",
    })).resolves.toMatchObject({ ok: false, error: expect.stringContaining("not in the bound pull request") });
  });

  it("requires every exact-head diff before assessing review quality", async () => {
    pullFileCount = 2;
    await expect(call("reviewer", "assess_review", {
      expected_head_sha: INITIAL_HEAD,
      findings: [{
        severity: "low",
        actionable: false,
        file: "src/fix-0.ts",
        title: "Alias-shaped finding",
        body: "This shape cannot be handed off as ReviewDecision.",
        advisory_reason: "optional_preference",
      }],
    })).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining("use the final ReviewDecision finding fields exactly"),
    });

    await expect(call("reviewer", "assess_review", {
      expected_head_sha: INITIAL_HEAD,
      findings: [{
        id: "valid-advisory",
        severity: "low",
        category: "tests",
        actionable: false,
        advisory_reason: "optional_preference",
        path: "src/fix-0.ts",
        line: 1,
        evidence: "The optional assertion is not present.",
        recommendation: "Consider adding the optional assertion later.",
      }],
    })).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining("complete diff coverage (0/2 files)"),
    });

    await expect(call("reviewer", "assess_review", {
      expected_head_sha: INITIAL_HEAD,
      findings: [],
    })).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining("complete diff coverage (0/2 files)"),
    });

    for (const pathname of ["src/fix-0.ts", "src/fix-1.ts"]) {
      await expect(call("reviewer", "read_diff", {
        expected_head_sha: INITIAL_HEAD,
        path: pathname,
      })).resolves.toMatchObject({ ok: true, result: { next_offset: null } });
    }
    await expect(call("reviewer", "assess_review", {
      expected_head_sha: INITIAL_HEAD,
      findings: [],
    })).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining("no Manager-verified TestReport"),
    });
  });

  it("binds workspace commits to the caller node's sole writable path", async () => {
    const denied = await call("aggregate", "commit_workspace", {
      expected_head_sha: INITIAL_HEAD,
      workspace_path: "workers/other-node",
      message: "attempt another workspace",
    });
    expect(denied).toMatchObject({
      ok: false,
      error: expect.stringContaining("does not match the node write boundary"),
    });
  });

  it("rejects repository-wide writable paths instead of treating dot as an allow-all prefix", async () => {
    createBoundRun("github-broker-dot-run", ["."]);
    const snapshot = await call(
      "reviewer",
      "pull_request_snapshot",
      {},
      "github-broker-dot-run",
    );
    expect(snapshot).toMatchObject({ ok: false, error: expect.stringContaining("not a safe repository path") });
  });

  it("requires successful immutable checks in the current reviewer dispatch before approval", async () => {
    expect(markNodeDispatched("github-broker-run", "aggregate")).toBe(true);
    handoffActiveRun("github-broker-run", "aggregate", "done", {});
    expect(markNodeDispatched("github-broker-run", "reviewer")).toBe(true);
    const sessionId = getCurrentNodeSession("github-broker-run", "reviewer")?.sessionId;
    if (!sessionId) throw new Error("reviewer session was not created");

    const approval = { verdict: "approve" };
    expect(() => handoffActiveRun("github-broker-run", "reviewer", "reviewed", approval))
      .toThrow(/DAG_HANDOFF_BROKER_REQUIREMENT_MISSING/);

    checkName = "unrelated";
    await expect(call("reviewer", "required_checks", {}, "github-broker-run", sessionId))
      .resolves.toMatchObject({ ok: false, error: expect.stringContaining("unit") });
    checkName = "unit";
    checkConclusion = "failure";
    await expect(call("reviewer", "required_checks", {}, "github-broker-run", sessionId))
      .resolves.toMatchObject({ ok: false, error: expect.stringContaining("unit") });
    expect(() => handoffActiveRun("github-broker-run", "reviewer", "reviewed", approval))
      .toThrow(/DAG_HANDOFF_BROKER_REQUIREMENT_MISSING/);

    checkConclusion = "success";
    await expect(call("reviewer", "required_checks", {}, "github-broker-run", sessionId))
      .resolves.toMatchObject({
        ok: true,
        result: {
          passed: true,
          head_sha: INITIAL_HEAD,
          required_checks: [{ name: "unit", status: "completed", conclusion: "success" }],
        },
      });
    expect(() => handoffActiveRun("github-broker-run", "reviewer", "reviewed", approval)).not.toThrow();
  });

  it("validates an already-successful exact head without dispatching another workflow", async () => {
    const validated = await call("reviewer", "validate_head", {
      expected_head_sha: INITIAL_HEAD,
      manifest_sha256: "1".repeat(64),
      summary: "candidate",
      tests: ["npm test"],
    });
    expect(validated).toMatchObject({
      ok: true,
      result: {
        status: "passed",
        verdict: "validated",
        head_sha: INITIAL_HEAD,
        validation: {
          workflow_dispatched: false,
          required_checks: [{ id: 1, name: "unit", status: "completed", conclusion: "success" }],
        },
        feedback: [],
        fix_tasks: [],
      },
    });
    expect(workflowDispatches).toEqual([]);
  });

  it("dispatches trusted validation and polls the exact head from pending to success", async () => {
    createBoundRun("github-validation-poll-run", ["src"], INITIAL_HEAD, {
      workflow_id: "autofix-validate.yml",
      inputs: { head_sha: "$head_sha", mode: "trusted" },
    });
    workflowRunsResponses = [
      [],
      [{
        id: 101,
        head_sha: INITIAL_HEAD,
        head_branch: "autofix/issue-172",
        event: "workflow_dispatch",
        status: "in_progress",
        conclusion: null,
      }],
      [{
        id: 101,
        head_sha: INITIAL_HEAD,
        head_branch: "autofix/issue-172",
        event: "workflow_dispatch",
        status: "completed",
        conclusion: "success",
      }],
    ];
    workflowJobs.set(101, [{
      id: 2,
      name: "unit",
      status: "completed",
      conclusion: "success",
      html_url: "https://github.com/acme/widget/actions/runs/101/job/2",
      steps: [],
    }]);
    vi.useFakeTimers();

    const validation = call("reviewer", "validate_head", {
      expected_head_sha: INITIAL_HEAD,
      manifest_sha256: "2".repeat(64),
      summary: "candidate after fixes",
      tests: ["npm test"],
    }, "github-validation-poll-run", "validation-session");
    await vi.advanceTimersByTimeAsync(0);
    expect(workflowDispatches).toEqual([{
      ref: "autofix/issue-172",
      inputs: { head_sha: INITIAL_HEAD, mode: "trusted" },
    }]);
    await vi.advanceTimersByTimeAsync(5_000);

    await expect(validation).resolves.toMatchObject({
      ok: true,
      result: {
        status: "passed",
        verdict: "validated",
        head_sha: INITIAL_HEAD,
        manifest_sha256: "2".repeat(64),
        validation: {
          workflow_dispatched: true,
          required_checks: [{ id: 2, name: "unit", status: "completed", conclusion: "success" }],
        },
      },
    });
  });

  it("waits for the whole dispatched workflow and reports a non-required failing job", async () => {
    createBoundRun("github-validation-whole-run", ["src"], INITIAL_HEAD, {
      workflow_id: "autofix-validate.yml",
      inputs: { head_sha: "$head_sha" },
    });
    const failedRun = {
      id: 202,
      head_sha: INITIAL_HEAD,
      head_branch: "autofix/issue-172",
      event: "workflow_dispatch",
      status: "completed",
      conclusion: "failure",
      html_url: "https://github.com/acme/widget/actions/runs/202",
    };
    workflowRunsResponses = [[], [failedRun]];
    workflowJobs.set(202, [
      {
        id: 2,
        name: "unit",
        status: "completed",
        conclusion: "success",
        html_url: "https://github.com/acme/widget/actions/runs/202/job/2",
        steps: [],
      },
      {
        id: 42,
        name: "Core (Windows, Node 24)",
        status: "completed",
        conclusion: "failure",
        html_url: "https://github.com/acme/widget/actions/runs/202/job/42",
        steps: [{ name: "Typecheck, build, and test", conclusion: "failure" }],
      },
    ]);
    jobLogs.set(42, "AssertionError: expected commit does not exist, received invalid worktree binding");

    const failed = await call("reviewer", "validate_head", {
      expected_head_sha: INITIAL_HEAD,
      manifest_sha256: "7".repeat(64),
      summary: "candidate with one successful anchor job",
      tests: ["npm test"],
    }, "github-validation-whole-run", "validation-session");

    expect(failed).toMatchObject({
      ok: true,
      result: {
        status: "failed",
        verdict: "changes_requested",
        validation: {
          workflow_dispatched: true,
          required_checks: [{ id: 2, name: "unit", status: "completed", conclusion: "success" }],
        },
        feedback: [expect.stringContaining("Core (Windows, Node 24)")],
        fix_tasks: [{
          id: "trusted-validation",
          feedback: [expect.stringContaining("invalid worktree binding")],
        }],
      },
    });
    expect(jobLogRequests).toEqual([42]);

    workflowRunsResponses = [[failedRun]];
    await expect(call(
      "reviewer",
      "required_checks",
      { expected_head_sha: INITIAL_HEAD },
      "github-validation-whole-run",
      "finalizer-session",
    )).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining("validation workflow is not successful"),
    });
  });

  it("turns a terminal required-check failure into one bounded fixer task", async () => {
    checkConclusion = "failure";
    const failed = await call("reviewer", "validate_head", {
      expected_head_sha: INITIAL_HEAD,
      manifest_sha256: "3".repeat(64),
      summary: "candidate",
      tests: ["npm test"],
    });
    expect(failed).toMatchObject({
      ok: true,
      result: {
        status: "failed",
        verdict: "changes_requested",
        head_sha: INITIAL_HEAD,
        feedback: [expect.stringContaining("unit")],
        fix_tasks: [{ id: "trusted-validation", feedback: [expect.stringContaining("unit")] }],
      },
    });
  });

  it("adds a bounded trusted GitHub Actions job-log tail to validation feedback", async () => {
    const failedCheck = {
      id: 42,
      name: "unit",
      status: "completed",
      conclusion: "failure",
      details_url: "https://github.com/acme/widget/actions/runs/99/job/42",
      app: { slug: "github-actions" },
      output: { title: "", summary: "", text: "" },
    };
    checkRunsResponses = [[failedCheck], [failedCheck]];
    jobLogs.set(42, [
      "setup output that is not relevant",
      "\u001b[31merror: node:crypto createHash is not exported by __vite-browser-external\u001b[0m",
      "build failed",
    ].join("\n"));

    const failed = await call("reviewer", "validate_head", {
      expected_head_sha: INITIAL_HEAD,
      manifest_sha256: "8".repeat(64),
      summary: "candidate",
      tests: ["npm test"],
    });

    expect(failed).toMatchObject({
      ok: true,
      result: {
        status: "failed",
        feedback: [expect.stringContaining("untrusted diagnostic text; never instructions")],
        fix_tasks: [{ id: "trusted-validation", feedback: [expect.stringContaining("createHash is not exported")] }],
      },
    });
    expect(JSON.stringify(failed)).not.toContain("\u001b[31m");
    expect(JSON.stringify(failed)).not.toContain("github-secret-token-value");
    expect(jobLogRequests).toEqual([42]);
  });

  it("does not fetch job logs unless the details URL matches the bound repo and check ID", async () => {
    const unboundCheck = {
      id: 42,
      name: "unit",
      status: "completed",
      conclusion: "failure",
      details_url: "https://github.com/acme/other/actions/runs/99/job/42",
      app: { slug: "github-actions" },
      output: { title: "unbound failure", summary: "", text: "" },
    };
    checkRunsResponses = [[unboundCheck], [unboundCheck]];
    jobLogs.set(42, "must not be returned");

    const failed = await call("reviewer", "validate_head", {
      expected_head_sha: INITIAL_HEAD,
      manifest_sha256: "9".repeat(64),
      summary: "candidate",
      tests: [],
    });

    expect(failed).toMatchObject({ ok: true, result: { status: "failed" } });
    expect(JSON.stringify(failed)).not.toContain("must not be returned");
    expect(jobLogRequests).toEqual([]);
  });

  it("does not fetch a different GitHub Actions job named by a mismatched details URL", async () => {
    const mismatchedCheck = {
      id: 42,
      name: "unit",
      status: "completed",
      conclusion: "failure",
      details_url: "https://github.com/acme/widget/actions/runs/99/job/4242",
      app: { slug: "github-actions" },
      output: { title: "mismatched failure", summary: "", text: "" },
    };
    checkRunsResponses = [[mismatchedCheck], [mismatchedCheck]];
    jobLogs.set(4242, "must not be returned");

    const failed = await call("reviewer", "validate_head", {
      expected_head_sha: INITIAL_HEAD,
      manifest_sha256: "a".repeat(64),
      summary: "candidate",
      tests: [],
    });

    expect(failed).toMatchObject({ ok: true, result: { status: "failed" } });
    expect(JSON.stringify(failed)).not.toContain("must not be returned");
    expect(jobLogRequests).toEqual([]);
  });

  it("rejects validation when the expected head no longer matches the bound PR", async () => {
    const stale = await call("reviewer", "validate_head", {
      expected_head_sha: "9".repeat(40),
      manifest_sha256: "4".repeat(64),
      summary: "stale candidate",
      tests: [],
    });
    expect(stale).toMatchObject({ ok: false, error: expect.stringContaining("stale") });
  });

  it("routes trusted validation failure through a fixer before fresh review", async () => {
    const runId = "github-validation-fix-loop";
    createBoundRun(runId, ["src"], INITIAL_HEAD, undefined, `
api_version: homerail.ai/v1
kind: Workflow
metadata: { id: validation-fix-loop, name: Validation fix loop }
spec:
  contracts:
    Task: { type: object }
  agents:
    worker: { system: Return the declared result. }
  nodes:
    candidate:
      kind: agent
      agent: worker
      inputs: { task: { contract: Task } }
      outputs: { ready: {} }
    validate_initial:
      kind: broker
      inputs: { candidate: {} }
      outputs: { result: {}, error: {} }
      config:
        input: candidate
        input_map:
          expected_head_sha: head_sha
          manifest_sha256: manifest_sha256
          summary: summary
          tests: tests
        credential_ref: github-autofix
        purpose: validate the initial exact head
        broker: github_pr
        action: validate_head
        result_port: result
        error_port: error
    initial_gate:
      kind: condition
      inputs: { validation: {} }
      outputs: { passed: {}, changes: {}, blocked: {} }
      config:
        field: status
        routes: { passed: passed, failed: changes }
        default: blocked
    initial_review:
      kind: agent
      agent: worker
      inputs: { validation: {} }
      outputs: { reviewed: {}, failed: {} }
    initial_decision:
      kind: join
      inputs: { validation: {}, review: {} }
      outputs: { ready: {}, missing: {} }
      config:
        mode: any
        field: verdict
        success_values: [approve, changes_requested]
        passed_port: ready
        failed_port: missing
    review_gate:
      kind: while
      inputs: { state: {} }
      outputs: { fix: {}, approved: {}, exhausted: {} }
      config:
        field: values.0.verdict
        operator: eq
        value: approve
        continue_port: fix
        done_port: approved
        exhausted_port: exhausted
        max_iterations: 2
    fix:
      kind: agent
      agent: worker
      depends_on: [review_gate]
      inputs: { review: {} }
      outputs: { fixed: {}, failed: {} }
    validate_revision:
      kind: broker
      inputs: { candidate: {} }
      outputs: { result: {}, error: {} }
      config:
        input: candidate
        input_map:
          expected_head_sha: head_sha
          manifest_sha256: manifest_sha256
          summary: summary
          tests: tests
        credential_ref: github-autofix
        purpose: validate the revised exact head
        broker: github_pr
        action: validate_head
        result_port: result
        error_port: error
    revision_gate:
      kind: condition
      inputs: { validation: {} }
      outputs: { passed: {}, changes: {}, blocked: {} }
      config:
        field: status
        routes: { passed: passed, failed: changes }
        default: blocked
    revision_review:
      kind: agent
      agent: worker
      depends_on: [review_gate]
      inputs: { validation: {} }
      outputs: { reviewed: {}, failed: {} }
    revision_decision:
      kind: join
      inputs: { validation: {}, review: {} }
      outputs: { ready: {}, missing: {} }
      config:
        mode: any
        field: verdict
        success_values: [approve, changes_requested]
        passed_port: ready
        failed_port: missing
    done: { kind: terminal, outcome: success, inputs: { result: {} } }
    initial_validation_error: { kind: terminal, outcome: failure, inputs: { result: {} } }
    initial_review_error: { kind: terminal, outcome: failure, inputs: { result: {} } }
    initial_missing: { kind: terminal, outcome: failure, inputs: { result: {} } }
    initial_blocked: { kind: terminal, outcome: failure, inputs: { result: {} } }
    fix_error: { kind: terminal, outcome: failure, inputs: { result: {} } }
    revision_validation_error: { kind: terminal, outcome: failure, inputs: { result: {} } }
    revision_review_error: { kind: terminal, outcome: failure, inputs: { result: {} } }
    revision_missing: { kind: terminal, outcome: failure, inputs: { result: {} } }
    revision_blocked: { kind: terminal, outcome: failure, inputs: { result: {} } }
    exhausted: { kind: terminal, outcome: cancelled, inputs: { result: {} } }
  edges:
    - { from: $run.input, to: candidate.task }
    - { from: candidate.ready, to: validate_initial.candidate }
    - { from: validate_initial.result, to: initial_gate.validation }
    - { from: validate_initial.error, to: initial_validation_error.result, condition: on_failure }
    - { from: initial_gate.passed, to: initial_review.validation }
    - { from: initial_gate.changes, to: initial_decision.validation }
    - { from: initial_gate.blocked, to: initial_blocked.result }
    - { from: initial_review.reviewed, to: initial_decision.review }
    - { from: initial_review.failed, to: initial_review_error.result, condition: on_failure }
    - { from: initial_decision.ready, to: review_gate.state }
    - { from: initial_decision.missing, to: initial_missing.result }
    - { from: review_gate.fix, to: fix.review }
    - { from: review_gate.approved, to: done.result }
    - { from: review_gate.exhausted, to: exhausted.result }
    - { from: fix.fixed, to: validate_revision.candidate }
    - { from: fix.failed, to: fix_error.result, condition: on_failure }
    - { from: validate_revision.result, to: revision_gate.validation }
    - { from: validate_revision.error, to: revision_validation_error.result, condition: on_failure }
    - { from: revision_gate.passed, to: revision_review.validation }
    - { from: revision_gate.changes, to: revision_decision.validation }
    - { from: revision_gate.blocked, to: revision_blocked.result }
    - { from: revision_review.reviewed, to: revision_decision.review }
    - { from: revision_review.failed, to: revision_review_error.result, condition: on_failure }
    - { from: revision_decision.missing, to: revision_missing.result }
    - kind: feedback
      from: revision_decision.ready
      to: review_gate.state
      max_traversals: 2
`);
    checkConclusion = "failure";
    const dispatcher = new RecordingDispatcher();
    const executor = new GraphExecutor(dispatcher);
    handoffActiveRun(runId, "candidate", "ready", {
      head_sha: INITIAL_HEAD,
      manifest_sha256: "5".repeat(64),
      summary: "candidate",
      tests: ["npm test"],
    });

    executor.tick(runId);
    await waitUntil(
      () => dispatcher.dispatched.some((entry) => entry.nodeId === "fix"),
      "trusted validation broker callback did not drain the gateway chain to the fixer",
    );
    const fixDispatch = dispatcher.dispatched.find((entry) => entry.nodeId === "fix")!;
    expect(fixDispatch.inputs.review[0]).toMatchObject({
      input: {
        values: [{
          verdict: "changes_requested",
          fix_tasks: [{ id: "trusted-validation", feedback: [expect.stringContaining("unit")] }],
        }],
      },
    });

    checkConclusion = "success";
    handoffActiveRun(runId, "fix", "fixed", {
      head_sha: INITIAL_HEAD,
      manifest_sha256: "6".repeat(64),
      summary: "fixed trusted validation",
      tests: ["npm test"],
    });
    executor.tick(runId);
    await waitUntil(
      () => dispatcher.dispatched.some((entry) => entry.nodeId === "revision_review"),
      "successful re-validation broker callback did not drain the gateway chain to fresh review",
    );
    handoffActiveRun(runId, "revision_review", "reviewed", {
      verdict: "approve",
      head_sha: INITIAL_HEAD,
      summary: "approved",
      feedback: [],
      fix_tasks: [],
    });
    await tickUntil(
      executor,
      runId,
      () => getActiveRun(runId)?.status === "completed",
      "approved revised head did not complete",
    );

    expect(getActiveRun(runId)?.counters.gateway_iterations.review_gate).toBe(1);
    expect(getActiveRun(runId)?.dagRun.nodeStates.get("initial_review")).toBe("SKIPPED");
    expect(getActiveRun(runId)?.status).toBe("completed");
  });

  it("commits through a non-force expected-head fence and restores the advanced head", async () => {
    const committed = await call("aggregate", "commit_files", {
      expected_head_sha: INITIAL_HEAD,
      message: "fix: bounded change",
      files: [{ path: "src/fix.ts", content_base64: Buffer.from("export const fixed = true;\n").toString("base64") }],
    });
    expect(committed).toMatchObject({
      ok: true,
      result: {
        previous_head_sha: INITIAL_HEAD,
        head_sha: NEXT_HEAD,
        committed_files: ["src/fix.ts"],
      },
    });
    expect(remoteHead).toBe(NEXT_HEAD);
    expect(fetchSpy.mock.calls.find(([, init]) => init?.method === "PATCH")?.[1]?.body)
      .toContain('"force":false');

    handoffActiveRun("github-broker-run", "aggregate", "done", {});
    _clearActiveRuns();
    closeDb();
    expect(recoverAllActiveRuns().recovered).toContain("github-broker-run");
    const recovered = await call("reviewer", "pull_request_snapshot");
    expect(recovered).toMatchObject({ ok: true, result: { head_sha: NEXT_HEAD } });

    createBoundRun("github-stale-after-recovery", ["src"], NEXT_HEAD);
    const stale = await call("aggregate", "commit_files", {
      expected_head_sha: INITIAL_HEAD,
      message: "stale write",
      files: [{ path: "src/fix.ts", content_base64: Buffer.from("stale\n").toString("base64") }],
    }, "github-stale-after-recovery");
    expect(stale).toMatchObject({ ok: false, error: expect.stringContaining("expected head is stale") });
  });

  it("releases the semantic target after a ref update returns an error and read-back confirms absence", async () => {
    refUpdateFailureStatus = 500;
    const failed = await call("aggregate", "commit_files", {
      expected_head_sha: INITIAL_HEAD,
      message: "fix: first ref update attempt",
      files: [{ path: "src/fix.ts", content_base64: Buffer.from("first\n").toString("base64") }],
    });

    expect(failed).toMatchObject({
      ok: false,
      outcome: "reconciled",
      reconciliation: "absent",
      error: expect.stringContaining("GitHub API request failed (500)"),
    });
    expect(remoteHead).toBe(INITIAL_HEAD);
    expect(getDb().prepare(`
      SELECT state, resolution, provider_state_json
      FROM credential_broker_mutation_attempts
      WHERE request_id = ?
    `).get(failed.request_id)).toMatchObject({
      state: "reconciled",
      resolution: "absent",
      provider_state_json: expect.stringContaining('"phase":"ref_update_failed"'),
    });

    refUpdateFailureStatus = undefined;
    const retried = await call("aggregate", "commit_files", {
      expected_head_sha: INITIAL_HEAD,
      message: "fix: retry ref update",
      files: [{ path: "src/fix.ts", content_base64: Buffer.from("retry\n").toString("base64") }],
    });
    expect(retried).toMatchObject({ ok: true, outcome: "completed" });
    expect(remoteHead).toBe(NEXT_HEAD);
  });

  it("keeps a response-less ref update transport failure indeterminate", async () => {
    refUpdateTransportError = true;
    const uncertain = await call("aggregate", "commit_files", {
      expected_head_sha: INITIAL_HEAD,
      message: "fix: uncertain ref update",
      files: [{ path: "src/fix.ts", content_base64: Buffer.from("uncertain\n").toString("base64") }],
    });

    expect(uncertain).toMatchObject({
      ok: false,
      outcome: "indeterminate",
      error: expect.stringContaining("connection reset"),
    });
    expect(remoteHead).toBe(INITIAL_HEAD);
    expect(getDb().prepare(`
      SELECT state, resolution, provider_state_json
      FROM credential_broker_mutation_attempts
      WHERE request_id = ?
    `).get(uncertain.request_id)).toMatchObject({
      state: "indeterminate",
      resolution: null,
      provider_state_json: expect.stringContaining('"phase":"ref_update_dispatched"'),
    });
  });

  it("reconciles a ref update that completes after the Actor run is cancelled", async () => {
    let releaseRefUpdate!: () => void;
    const enteredRefUpdate = new Promise<void>((resolve) => { refUpdateStarted = resolve; });
    refUpdateGate = new Promise<void>((resolve) => { releaseRefUpdate = resolve; });
    const pending = call("aggregate", "commit_files", {
      expected_head_sha: INITIAL_HEAD,
      message: "fix: cancellation race",
      files: [{
        path: "src/fix.ts",
        content_base64: Buffer.from("export const raced = true;\n").toString("base64"),
      }],
    });

    await enteredRefUpdate;
    cancelActiveRun("github-broker-run");
    releaseRefUpdate();

    await expect(pending).resolves.toMatchObject({
      ok: false,
      outcome: "reconciled",
      reconciliation: "completed",
    });
    expect(remoteHead).toBe(NEXT_HEAD);
    expect(getDb().prepare(`
      SELECT state, resolution, result_json
      FROM credential_broker_mutation_attempts
      WHERE run_id = ? AND broker = 'github_pr' AND action = 'commit_files'
    `).get("github-broker-run")).toMatchObject({
      state: "reconciled",
      resolution: "completed",
      result_json: expect.stringContaining(NEXT_HEAD),
    });
  });

  it("rejects a no-op tree instead of advancing the PR with an empty commit", async () => {
    createdTreeSha = BASE_TREE;
    const denied = await call("aggregate", "commit_files", {
      expected_head_sha: INITIAL_HEAD,
      message: "attempt empty commit",
      files: [{ path: "src/fix.ts", content_base64: Buffer.from("unchanged\n").toString("base64") }],
    });
    expect(denied).toMatchObject({ ok: false, error: expect.stringContaining("would not change") });
    expect(remoteHead).toBe(INITIAL_HEAD);
    expect(fetchSpy.mock.calls.some(([, init]) => init?.method === "PATCH")).toBe(false);
  });

  it("atomically derives every dirty file from the node's only writable worktree", async () => {
    const runId = "github-workspace-commit-run";
    const { repository, head } = initializeRepository(runId);
    remoteHead = head;
    createBoundRun(runId, ["src"], remoteHead);
    fs.writeFileSync(path.join(repository, "src", "fix.ts"), "after\n");
    fs.writeFileSync(path.join(repository, "src", "also.ts"), "export const also = true;\n");
    fs.rmSync(path.join(repository, "src", "remove.ts"));

    const committed = await call("aggregate", "commit_workspace", {
      expected_head_sha: remoteHead,
      workspace_path: "repo",
      message: "fix: complete workspace change",
    }, runId);
    expect(committed).toMatchObject({
      ok: true,
      result: {
        previous_head_sha: expect.stringMatching(/^[0-9a-f]{40}$/),
        head_sha: NEXT_HEAD,
        workspace_path: "repo",
        manifest_sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
        committed_files: ["src/also.ts", "src/fix.ts", "src/remove.ts"],
      },
    });
    const blobBodies = fetchSpy.mock.calls
      .filter(([input, init]) => new URL(String(input)).pathname === "/repos/acme/widget/git/blobs" && init?.method === "POST")
      .map(([, init]) => JSON.parse(String(init?.body)) as { content: string });
    expect(blobBodies.map((body) => Buffer.from(body.content, "base64").toString("utf8")))
      .toEqual(["export const also = true;\n", "after\n"]);
    const treeBody = fetchSpy.mock.calls
      .filter(([input, init]) => new URL(String(input)).pathname === "/repos/acme/widget/git/trees" && init?.method === "POST")
      .map(([, init]) => JSON.parse(String(init?.body)) as { tree: Array<{ path: string; sha: string | null }> })[0];
    expect(treeBody?.tree.map((entry) => entry.path)).toEqual(["src/also.ts", "src/fix.ts", "src/remove.ts"]);
    expect(treeBody?.tree.find((entry) => entry.path === "src/remove.ts")?.sha).toBeNull();
  });

  it("rejects dirty workspace paths outside the PR allowlist", async () => {
    const runId = "github-workspace-outside-run";
    const { repository, head } = initializeRepository(runId);
    remoteHead = head;
    createBoundRun(runId, ["src"], head);
    fs.writeFileSync(path.join(repository, "README.md"), "not allowed\n");

    const denied = await call("aggregate", "commit_workspace", {
      expected_head_sha: head,
      workspace_path: "repo",
      message: "attempt unrelated file",
    }, runId, "outside-session");
    expect(denied).toMatchObject({ ok: false, error: expect.stringContaining("outside the PR write allowlist") });
  });

  it("rejects symlinks in a derived workspace commit", async () => {
    const runId = "github-workspace-symlink-run";
    const { repository, head } = initializeRepository(runId);
    remoteHead = head;
    createBoundRun(runId, ["src"], head);
    fs.symlinkSync("fix.ts", path.join(repository, "src", "alias.ts"));

    const denied = await call("aggregate", "commit_workspace", {
      expected_head_sha: head,
      workspace_path: "repo",
      message: "attempt symlink",
    }, runId, "symlink-session");
    expect(denied).toMatchObject({ ok: false, error: expect.stringContaining("rejects symlink") });
  });

  it("rejects deleting a tracked symlink through a derived workspace commit", async () => {
    const runId = "github-workspace-delete-symlink-run";
    const { repository, git } = initializeRepository(runId);
    fs.symlinkSync("fix.ts", path.join(repository, "src", "tracked-link.ts"));
    git(["add", "src/tracked-link.ts"]);
    git(["commit", "-m", "add tracked symlink"]);
    const head = git(["rev-parse", "HEAD"]);
    remoteHead = head;
    createBoundRun(runId, ["src"], head);
    fs.rmSync(path.join(repository, "src", "tracked-link.ts"));

    const denied = await call("aggregate", "commit_workspace", {
      expected_head_sha: head,
      workspace_path: "repo",
      message: "attempt tracked symlink deletion",
    }, runId, "delete-symlink-session");
    expect(denied).toMatchObject({ ok: false, error: expect.stringContaining("non-regular tracked path mode 120000") });
  });

  it("accepts commit payloads above the generic broker input limit within the 1 MiB file bound", async () => {
    const content = Buffer.alloc(100 * 1024, "a");
    const committed = await call("aggregate", "commit_files", {
      expected_head_sha: INITIAL_HEAD,
      message: "fix: larger bounded change",
      files: [{ path: "src/fix.ts", content_base64: content.toString("base64") }],
    });
    expect(committed).toMatchObject({
      ok: true,
      result: {
        previous_head_sha: INITIAL_HEAD,
        head_sha: NEXT_HEAD,
        committed_files: ["src/fix.ts"],
      },
    });
  });

  it("fails closed when the Draft PR head changes outside the broker", async () => {
    await call("reviewer", "pull_request_snapshot");
    remoteHead = "9".repeat(40);
    const drifted = await call("reviewer", "checks_snapshot");
    expect(drifted).toMatchObject({ ok: false, error: expect.stringContaining("outside the HomeRail broker") });
  });

  it("rejects a closed or cross-repository pull request", async () => {
    pullState = "closed";
    await expect(call("reviewer", "pull_request_snapshot")).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining("identity differs"),
    });

    pullState = "open";
    headRepository = "someone-else/widget";
    await expect(call("reviewer", "pull_request_snapshot")).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining("identity differs"),
    });
  });
});
