import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));
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
  it("retains failed-job logs for the next Codex plan", () => {
    github.jobs[0].conclusion = "failure"; const provider = e2eFixGitHubProviders(github); const a = candidate();
    const result = provider.ci(config, a, provider.publish(config, a, root), root);
    expect(result).toMatchObject({ status: "completed", jobs: [{ key: "unit", conclusion: "failure" }], feedback: { logs: [{ tail: expect.stringContaining("AssertionError") }] } });
  });
});
