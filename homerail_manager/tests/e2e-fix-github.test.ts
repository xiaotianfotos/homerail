import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { E2eFixCandidates } from "../src/runtime/e2e-fix-candidates.js";
import { e2eFixGitHubProviders, e2eFixCheckoutHead, type E2eFixGitHubTransport } from "../src/runtime/e2e-fix-github.js";
import type { E2eFixTaskConfig } from "../src/runtime/e2e-fix-stage.js";

class GitHub implements E2eFixGitHubTransport {
  head: string | null = null; branch = ""; pr: any = null; run: any = null;
  pushes = 0; creates = 0; dispatches = 0; time = 0;
  lostPush = false; lostCreate = false; lostDispatch = false; rejectCreate = false;
  duplicateRun = false; driftAttempt = false; jobs: any[] = [{ id: 10, name: "Unit (Linux)", status: "completed", conclusion: "success" }];
  now = () => this.time;
  sleep = (ms: number) => { this.time += ms; };
  wrongCheckout = false;
  logs = () => `##[group]Run actions/checkout@${"f".repeat(40)}\n[command]/usr/bin/git log -1 --format=%H\n${this.wrongCheckout ? "d".repeat(40) : this.head}\n##[group]Run npm test\nAssertionError: expected signed addition; actual result was incorrect`;
  push(_store: string, _repo: string, branch: string, head: string, expected: string | null) {
    expect(this.head).toBe(expected); this.pushes++; this.head = head; this.branch = branch;
    if (this.pr) this.pr.head.sha = head;
    if (this.lostPush) throw new Error("lost push response");
  }
  api(method: string, endpoint: string, body?: any): any {
    let value: any;
    if (endpoint.includes("/git/matching-refs/")) value = this.head ? [{ ref: "refs/heads/" + this.branch, object: { sha: this.head } }] : [];
    else if (endpoint.includes("/pulls?")) value = this.pr ? [this.pr] : [];
    else if (endpoint.endsWith("/pulls") && method === "POST") {
      this.creates++; if (this.rejectCreate) throw new Error("request outcome unavailable");
      this.pr = { number: 11, state: "open", body: body.body,
        head: { sha: this.head, ref: this.branch, repo: { full_name: "fixture/repo" } },
        base: { ref: body.base, repo: { full_name: "fixture/repo" } } };
      if (this.lostCreate) throw new Error("lost creation response"); value = this.pr;
    } else if (endpoint.endsWith("/pulls/11")) value = this.pr;
    else if (endpoint.endsWith("/workflows/ci.yml")) value = { id: 7, path: ".github/workflows/ci.yml", state: "active" };
    else if (endpoint.endsWith("/dispatches")) {
      expect(body.inputs.target_ref).toBe(this.head); expect(body.ref).toBe(this.branch);
      this.dispatches++; this.run = { id: 99, run_attempt: 1, head_sha: this.head, head_branch: this.branch,
        event: "workflow_dispatch", workflow_id: 7, path: ".github/workflows/ci.yml", status: "completed" };
      if (this.lostDispatch) throw new Error("lost dispatch response"); value = null;
    } else if (endpoint.includes("/workflows/7/runs?")) value = { workflow_runs: this.run ? this.duplicateRun ? [this.run, { ...this.run, id: 100 }] : [this.run] : [] };
    else if (endpoint.endsWith("/actions/runs/99")) value = { ...this.run, run_attempt: this.driftAttempt ? 2 : 1 };
    else if (endpoint.endsWith("/attempts/1/jobs?per_page=100")) value = { total_count: this.jobs.length, jobs: this.jobs };
    else throw new Error("unexpected fixture endpoint: " + endpoint);
    return JSON.parse(JSON.stringify(value));
  }
}

describe.skipIf(process.platform !== "linux")("trusted GitHub stage providers with injected API transport", () => {
  let root: string; let config: E2eFixTaskConfig; let store: E2eFixCandidates; let github: GitHub;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "homerail-e2e-github-")); const repo = path.join(root, "repo");
    fs.mkdirSync(path.join(repo, ".github/workflows"), { recursive: true });
    const git = (...args: string[]) => { const r = spawnSync("git", ["-C", repo, ...args], { encoding: "utf8" }); if (r.status !== 0) throw new Error(r.stderr); return r.stdout.trim(); };
    git("init"); git("config", "user.name", "fixture"); git("config", "user.email", "fixture@example.invalid");
    fs.writeFileSync(path.join(repo, "sum.cjs"), "module.exports=0;"); fs.writeFileSync(path.join(repo, ".github/workflows/ci.yml"), "name: CI\n");
    git("add", "."); git("-c", "commit.gpgsign=false", "commit", "-m", "base");
    config = { version: 1, task_id: "issue", root_run_id: "root", mode: "production", source_repo: repo, repo: "fixture/repo", base: git("rev-parse", "HEAD"),
      issue: { number: 1, title: "Signed addition", body: "Fix sum" }, allowed_paths: ["sum.cjs"], protected_paths: [".github"], tests: [],
      policy: { required_tests: ["check"], required_ci_jobs: ["unit"], ci_workflow_path: ".github/workflows/ci.yml", reviewer_ids: ["review_a", "review_b", "review_c"], review_approvals: 2 },
      max_rounds: 4, max_infra_retries: 1, context_bytes: 96000, total_timeout_ms: 60000, runtime_sha256: "a".repeat(64),
      github: { base_ref: "main", job_names: { unit: "Unit (Linux)" }, wait_ms: 1000, poll_ms: 1000, checkout_ref: "f".repeat(40) } };
    store = new E2eFixCandidates(path.join(root, "candidates")); store.seed(repo, config.base); github = new GitHub();
  });
  const children: ChildProcess[] = [];
  afterEach(async () => {
    await Promise.all(children.splice(0).map(child => new Promise<void>(resolve => {
      if (child.exitCode !== null || child.signalCode !== null) return resolve();
      child.once("exit", () => resolve()); child.kill("SIGKILL");
    })));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const candidate = (round = 1, parent?: string) => store.capture({ task_id: config.task_id, root_run_id: config.root_run_id, round,
    plan_sha256: "b".repeat(64), policy_sha256: "c".repeat(64), repo: config.repo, base: config.base, parent: parent ?? config.base,
    allowed_paths: ["sum.cjs"], protected_paths: [".github"], summary: "Repair addition", edits: [{ path: "sum.cjs", old: `module.exports=${round - 1};`, new: `module.exports=${round};` }] });
  it("reconciles lost push/create/dispatch acknowledgements and updates the same PR in the next round", () => {
    github.lostPush = github.lostCreate = github.lostDispatch = true;
    const provider = e2eFixGitHubProviders(github); const a = candidate();
    const first = provider.publish(config, a, root); expect(provider.publish(config, a, root)).toEqual(first);
    const ci = provider.ci(config, a, first, root); expect(ci).toMatchObject({ status: "completed", jobs: [{ key: "unit", conclusion: "success" }] });
    expect(provider.ci(config, a, first, root)).toEqual(ci);
    const b = candidate(2, a.head); const second = provider.publish(config, b, root);
    expect(second.pr).toBe(first.pr); expect(second.observed_head).toBe(b.head);
    expect([github.pushes, github.creates, github.dispatches]).toEqual([2, 1, 1]);
  });
  it("does not create again when an attempted creation remains unknown", () => {
    github.rejectCreate = true; const provider = e2eFixGitHubProviders(github); const a = candidate();
    expect(() => provider.publish(config, a, root)).toThrow(/not confirmed/);
    expect(() => provider.publish(config, a, root)).toThrow(/refusing repeat/);
    expect(github.creates).toBe(1); expect(github.pushes).toBe(1);
  });
  it("refuses branch drift before pushing", () => {
    const provider = e2eFixGitHubProviders(github); const a = candidate();
    provider.publish(config, a, root);
    github.head = "e".repeat(40);
    expect(() => provider.publish(config, candidate(2, a.head), root)).toThrow(/branch drift/);
    expect(github.pushes).toBe(1);
  });
  it.each(["duplicate-run", "attempt-drift", "missing-job", "skipped-job", "wrong-checkout"])("does not approve %s", kind => {
    const provider = e2eFixGitHubProviders(github); const a = candidate(); const publication = provider.publish(config, a, root);
    github.duplicateRun = kind === "duplicate-run"; github.driftAttempt = kind === "attempt-drift";
    github.wrongCheckout = kind === "wrong-checkout";
    if (kind === "missing-job") github.jobs = [];
    if (kind === "skipped-job") github.jobs[0].conclusion = "skipped";
    const result = provider.ci(config, a, publication, root);
    expect(result.status !== "completed" || result.jobs.some(j => j.conclusion !== "success")).toBe(true);
    expect(github.dispatches).toBe(1);
  });
  it("ignores candidate-printed checkout claims after the trusted checkout step", () => {
    const spoof = github.logs();
    expect(e2eFixCheckoutHead(`##[group]Run npm test\n${spoof}`, "f".repeat(40))).toBeNull();
    github.head = "a".repeat(40);
    expect(e2eFixCheckoutHead(github.logs() + `\n[command]/usr/bin/git log -1 --format=%H\n${"b".repeat(40)}`, "f".repeat(40))).toBe(github.head);
  });
  it("recovers a transient run read failure without repeating publication or dispatch", () => {
    const provider = e2eFixGitHubProviders(github); const a = candidate();
    const publication = provider.publish(config, a, root);
    const api = github.api.bind(github); let reads = 0;
    github.api = (method, endpoint, body) => {
      if (endpoint.endsWith("/actions/runs/99") && ++reads === 1) throw new Error("network unavailable");
      return api(method, endpoint, body);
    };
    expect(provider.ci(config, a, publication, root).status).toBe("completed");
    expect(reads).toBe(2);
    expect([github.pushes, github.creates, github.dispatches]).toEqual([1, 1, 1]);
  });
  it("reuses terminal evidence when GitHub adds later run metadata", () => {
    const provider = e2eFixGitHubProviders(github); const a = candidate();
    const publication = provider.publish(config, a, root);
    const first = provider.ci(config, a, publication, root);
    github.run.updated_at = "2026-09-09T00:00:00Z";
    expect(e2eFixGitHubProviders(github).ci(config, a, publication, root)).toEqual(first);
    expect(github.dispatches).toBe(1);
  });
  it("preserves the observation deadline and owned run after observer interruption", () => {
    const provider = e2eFixGitHubProviders(github); const a = candidate();
    const publication = provider.publish(config, a, root);
    const api = github.api.bind(github);
    github.api = (method, endpoint, body) => {
      const value = api(method, endpoint, body);
      if (endpoint.endsWith("/actions/runs/99")) value.status = "in_progress";
      return value;
    };
    github.sleep = () => { throw new Error("observer process stopped"); };
    expect(() => provider.ci(config, a, publication, root)).toThrow("observer process stopped");
    const custody = fs.readFileSync(path.join(root, "github/1/ci-run.json"), "utf8");
    github.time = 1001;
    github.sleep = ms => { github.time += ms; };
    github.api = api;
    expect(() => e2eFixGitHubProviders(github).ci(config, a, publication, root)).toThrow(/deadline/);
    expect(fs.readFileSync(path.join(root, "github/1/ci-run.json"), "utf8")).toBe(custody);
    expect([github.pushes, github.creates, github.dispatches]).toEqual([1, 1, 1]);
  });
  it("recovers the same owned CI after SIGKILL of its observer process", async () => {
    config.github!.wait_ms = 60000;
    const a = candidate(); const publication = e2eFixGitHubProviders(github).publish(config, a, root);
    fs.writeFileSync(path.join(root, "observer-input.json"), JSON.stringify({ config, candidate: a, publication }));
    fs.writeFileSync(path.join(root, "observer-remote.json"), JSON.stringify({ pr: github.pr, run: null }));
    const observer = () => {
      const child = spawn(process.execPath, ["--import", "tsx", path.resolve("tests/fixtures/e2e-ci-observer.ts"), root], { stdio: ["ignore", "ignore", "pipe"] });
      children.push(child); let errors = "";
      child.stderr.on("data", chunk => { errors += chunk; });
      return { child, errors: () => errors };
    };
    const first = observer();
    await vi.waitFor(() => {
      if (first.child.exitCode !== null) throw new Error(first.errors());
      expect(fs.existsSync(path.join(root, "observer-waiting.json"))).toBe(true);
    }, { timeout: 8000 });
    const ended = new Promise(resolve => first.child.once("exit", resolve));
    first.child.kill("SIGKILL"); await ended;
    expect(first.child.signalCode).toBe("SIGKILL");
    const custodyFile = path.join(root, "github/1/ci-run.json");
    const deadlineFile = path.join(root, "github/1/ci-deadline.json");
    const custody = fs.readFileSync(custodyFile, "utf8"); const deadline = fs.readFileSync(deadlineFile, "utf8");
    const remote = JSON.parse(fs.readFileSync(path.join(root, "observer-remote.json"), "utf8"));
    remote.run.status = "completed";
    fs.writeFileSync(path.join(root, "observer-remote.json"), JSON.stringify(remote));
    const second = observer();
    await vi.waitFor(() => {
      if (second.child.exitCode !== null && second.child.exitCode !== 0) throw new Error(second.errors());
      expect(fs.existsSync(path.join(root, "observer-result.json"))).toBe(true);
    }, { timeout: 8000 });
    const recovered = JSON.parse(fs.readFileSync(path.join(root, "observer-result.json"), "utf8"));
    expect(recovered.pid).not.toBe(first.child.pid);
    expect(recovered.result).toMatchObject({ status: "completed", workflow_run_id: "99", workflow_attempt: 1, candidate: a });
    expect(fs.readFileSync(custodyFile, "utf8")).toBe(custody);
    expect(fs.readFileSync(deadlineFile, "utf8")).toBe(deadline);
    const requests = fs.readFileSync(path.join(root, "observer-requests.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
    expect(requests.filter(r => r.method === "POST")).toHaveLength(1);
    expect(requests.filter(r => r.pid === recovered.pid).every(r => r.method === "GET")).toBe(true);
    expect([github.pushes, github.creates]).toEqual([1, 1]);
    const exportDir = process.env.HOMERAIL_E2E_FIX_EVIDENCE_DIR;
    if (exportDir) {
      const destination = path.join(exportDir, "ci-observer-sigkill", path.basename(root));
      fs.mkdirSync(destination, { recursive: true });
      for (const name of ["observer-input.json", "observer-remote.json", "observer-result.json", "observer-requests.jsonl", "observer-waiting.json"])
        fs.copyFileSync(path.join(root, name), path.join(destination, name));
      fs.cpSync(path.join(root, "github"), path.join(destination, "github"), { recursive: true });
      fs.writeFileSync(path.join(destination, "proof.json"), JSON.stringify({ process_fault: "SIGKILL", first_pid: first.child.pid,
        recovered_pid: recovered.pid, same_custody: true, same_deadline: true, dispatches: 1, github_transport: "injected", model_calls: 0 }));
    }
  }, 20000);
  it.each(["inflight", "finished-unconsumed"])("recovers the native CI gateway after Manager SIGKILL with %s work", async phase => {
    config.github!.wait_ms = 60000;
    const a = candidate(); const publication = e2eFixGitHubProviders(github).publish(config, a, root);
    fs.writeFileSync(path.join(root, "observer-input.json"), JSON.stringify({ config, candidate: a, publication }));
    fs.writeFileSync(path.join(root, "observer-remote.json"), JSON.stringify({ pr: github.pr, run: null }));
    const read = (name: string) => JSON.parse(fs.readFileSync(path.join(root, name), "utf8"));
    const manager = (mode: string) => {
      const child = spawn(process.execPath, ["--import", "tsx", path.resolve("tests/fixtures/durable-ci-manager.ts"), root, mode],
        { stdio: ["ignore", "ignore", "pipe"] });
      children.push(child); let errors = ""; child.stderr.on("data", chunk => { errors += chunk; });
      return { child, errors: () => errors };
    };
    const first = manager("start");
    await vi.waitFor(() => {
      if (first.child.exitCode !== null) throw new Error(first.errors());
      expect(fs.existsSync(path.join(root, "observer-waiting.json"))).toBe(true);
    }, { timeout: 10000 });
    const before = read("start-ci-manager.json"), observer = read("observer-waiting.json");
    expect(before.commands).toHaveLength(1);
    const custody = fs.readFileSync(path.join(root, "github/1/ci-run.json"), "utf8");
    const deadline = fs.readFileSync(path.join(root, "github/1/ci-deadline.json"), "utf8");
    const ended = new Promise(resolve => first.child.once("exit", resolve));
    first.child.kill("SIGKILL"); await ended;
    expect(first.child.signalCode).toBe("SIGKILL");
    fs.writeFileSync(path.join(root, "manager-fault.json"), JSON.stringify({ phase, first_pid: first.child.pid,
      signal: first.child.signalCode, observer_pid: observer.pid, custody, deadline }));
    const release = () => {
      const remote = read("observer-remote.json"); remote.run.status = "completed";
      fs.writeFileSync(path.join(root, "observer-remote.tmp"), JSON.stringify(remote));
      fs.renameSync(path.join(root, "observer-remote.tmp"), path.join(root, "observer-remote.json"));
    };
    if (phase === "finished-unconsumed") {
      release();
      await vi.waitFor(() => {
        expect(fs.existsSync(path.join(root, "manager-home/trusted-commands", before.commands[0].execution_id, "receipt.json"))).toBe(true);
      }, { timeout: 5000 });
    }
    const second = manager("recover");
    await vi.waitFor(() => {
      if (second.child.exitCode !== null && second.child.exitCode !== 0) throw new Error(second.errors());
      expect(fs.existsSync(path.join(root, "recover-ci-manager.json"))).toBe(true);
    }, { timeout: 10000 });
    const restored = read("recover-ci-manager.json");
    expect(restored.pid).not.toBe(before.pid); expect(restored.session.sessionId).toBe(before.session.sessionId);
    if (phase === "inflight") release();
    await vi.waitFor(() => expect(fs.existsSync(path.join(root, "ci-manager-proof.json"))).toBe(true), { timeout: 5000 });
    const proof = read("ci-manager-proof.json"), result = read("observer-result.json");
    expect(result.pid).toBe(observer.pid);
    expect(proof.snapshot.metadata.status).toBe("completed"); expect(proof.model_dispatches).toBe(0);
    expect(proof.snapshot.handoffs).toHaveLength(1);
    expect(proof.snapshot.handoffs[0].content).toMatchObject({ status: "completed", workflow_run_id: "99", workflow_attempt: 1, candidate: a });
    expect(proof.commands).toEqual([{ ...before.commands[0], consumed: 1, owner_epoch: 2 }]);
    expect(fs.readFileSync(path.join(root, "github/1/ci-run.json"), "utf8")).toBe(custody);
    expect(fs.readFileSync(path.join(root, "github/1/ci-deadline.json"), "utf8")).toBe(deadline);
    const requests = fs.readFileSync(path.join(root, "observer-requests.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
    expect(new Set(requests.map(r => r.pid))).toEqual(new Set([observer.pid]));
    expect(requests.filter(r => r.method === "POST")).toHaveLength(1);
    expect([github.pushes, github.creates]).toEqual([1, 1]);
    const exported = process.env.HOMERAIL_E2E_FIX_EVIDENCE_DIR;
    if (exported) {
      const destination = path.join(exported, "ci-manager-sigkill", phase, path.basename(root));
      fs.mkdirSync(destination, { recursive: true });
      for (const name of ["manager-fault.json", "start-ci-manager.json", "recover-ci-manager.json", "ci-manager-proof.json", "observer-input.json", "observer-remote.json", "observer-result.json", "observer-requests.jsonl"])
        fs.copyFileSync(path.join(root, name), path.join(destination, name));
      fs.cpSync(path.join(root, "manager-home/trusted-commands"), path.join(destination, "trusted-commands"), { recursive: true });
      fs.cpSync(path.join(root, "github"), path.join(destination, "github"), { recursive: true });
    }
  }, 35000);
  it("retries unavailable checkout logs within the same deadline", () => {
    const a = candidate(); const provider = e2eFixGitHubProviders(github);
    const publication = provider.publish(config, a, root); const logs = github.logs.bind(github); let reads = 0;
    github.logs = () => { if (++reads === 1) throw new Error("logs temporarily unavailable"); return logs(); };
    expect(provider.ci(config, a, publication, root).status).toBe("completed");
    expect(reads).toBe(2); expect(github.dispatches).toBe(1);
  });
  it("keeps an exhausted observation unknown and does not refresh its deadline on replay", () => {
    const a = candidate(); const provider = e2eFixGitHubProviders(github);
    const publication = provider.publish(config, a, root); const api = github.api.bind(github);
    github.api = (method, endpoint, body) => {
      if (endpoint.endsWith("/actions/runs/99")) throw new Error("persistent outage");
      return api(method, endpoint, body);
    };
    const first = provider.ci(config, a, publication, root);
    expect(first.status).toBe("unknown"); expect(github.time).toBe(1000);
    github.api = api; github.time = 5000;
    expect(provider.ci(config, a, publication, root)).toEqual(first);
    expect(github.dispatches).toBe(1);
  });
  it("refuses current head or attempt drift when replaying retained CI evidence", () => {
    const a = candidate(); const provider = e2eFixGitHubProviders(github);
    const publication = provider.publish(config, a, root); provider.ci(config, a, publication, root);
    github.driftAttempt = true;
    expect(() => provider.ci(config, a, publication, root)).toThrow(/identity drift/);
    github.driftAttempt = false; github.pr.head.sha = "f".repeat(40);
    expect(() => provider.ci(config, a, publication, root)).toThrow(/PR changed/);
    expect(github.dispatches).toBe(1);
  });
  it("retains failed-job logs for the next Codex plan", () => {
    github.jobs[0].conclusion = "failure"; const provider = e2eFixGitHubProviders(github); const a = candidate();
    const result = provider.ci(config, a, provider.publish(config, a, root), root);
    expect(result).toMatchObject({ status: "completed", jobs: [{ key: "unit", conclusion: "failure" }], feedback: { logs: [{ tail: expect.stringContaining("AssertionError") }] } });
  });
});
