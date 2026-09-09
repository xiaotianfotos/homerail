import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import type { E2eFixAcceptanceInput, E2eFixCandidate } from "homerail-protocol";
import { E2eFixCandidates, e2eFixDigest, immutableE2eFixFile } from "./e2e-fix-candidates.js";
import type { E2eFixStageProviders, E2eFixTaskConfig } from "./e2e-fix-stage.js";

export interface E2eFixGitHubConfig {
  base_ref: string;
  job_names: Record<string, string>;
  wait_ms: number;
  poll_ms: number;
  checkout_ref: string;
}
export interface E2eFixGitHubTransport {
  api(method: "GET" | "POST", endpoint: string, body?: unknown): any;
  push(store: string, repo: string, branch: string, head: string, expected: string | null): void;
  logs(repo: string, job: number): string;
  now(): number;
  sleep(ms: number): void;
}
function gh(args: string[], input?: string): string {
  const result = spawnSync("gh", ["api", "--hostname", "github.com", ...args], { input, encoding: "utf8", timeout: 30000, maxBuffer: 8 * 1024 * 1024 });
  if (result.error || result.status !== 0) throw new Error("GitHub request did not return a successful response");
  return result.stdout;
}
const live: E2eFixGitHubTransport = {
  api(method, endpoint, body) { return JSON.parse(gh(["--method", method, endpoint, ...(body === undefined ? [] : ["--input", "-"])], body === undefined ? undefined : JSON.stringify(body)) || "null"); },
  push(store, repo, branch, head, expected) {
    const result = spawnSync("git", ["--git-dir", path.join(store, "objects.git"), "-c", "core.hooksPath=/dev/null", "-c", "credential.helper=",
      "-c", "credential.helper=!gh auth git-credential", "push", `--force-with-lease=refs/heads/${branch}:${expected ?? ""}`,
      `https://github.com/${repo}.git`, `${head}:refs/heads/${branch}`], { encoding: "utf8", timeout: 60000, maxBuffer: 1024 * 1024,
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
    if (result.error || result.status !== 0) throw new Error("GitHub branch update did not return a successful response");
  },
  logs(repo, job) { return gh([`repos/${repo}/actions/jobs/${job}/logs`]); },
  now: Date.now,
  sleep(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); },
};
const digest = (value: unknown) => e2eFixDigest(JSON.stringify(value));
const read = (file: string): any => JSON.parse(fs.readFileSync(file, "utf8"));
const save = (file: string, value: unknown) => immutableE2eFixFile(file, JSON.stringify(value));
function claim(file: string): boolean {
  let fd: number;
  try { fd = fs.openSync(file, "wx", 0o600); } catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") return false; throw error; }
  try { fs.writeFileSync(fd, "claimed"); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  const dir = fs.openSync(path.dirname(file), "r"); try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
  return true;
}
export function validateE2eFixGitHub(config: E2eFixTaskConfig): E2eFixGitHubConfig {
  const github = config.github;
  if (!github || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(config.repo)
    || !/^[A-Za-z0-9][A-Za-z0-9_./-]{0,150}$/.test(github.base_ref) || github.base_ref.includes("..") || github.base_ref.endsWith(".lock")
    || !/^\.github\/workflows\/[A-Za-z0-9_.-]+\.ya?ml$/.test(config.policy.ci_workflow_path)
    || !Number.isSafeInteger(github.wait_ms) || github.wait_ms < 1000 || github.wait_ms > 3_000_000
    || !Number.isSafeInteger(github.poll_ms) || github.poll_ms < 1000 || github.poll_ms > 60000
    || !/^[a-f0-9]{40}$/.test(github.checkout_ref)
    || !github.job_names || Object.keys(github.job_names).length !== config.policy.required_ci_jobs.length
    || config.policy.required_ci_jobs.some(key => typeof github.job_names[key] !== "string" || !github.job_names[key].trim())
    || new Set(Object.values(github.job_names)).size !== Object.keys(github.job_names).length) throw new Error("invalid frozen GitHub policy");
  return github;
}

/** HomeRail's frozen workflow runs pinned checkout as its first action. Only
 * accept its log section, before the next step can execute candidate code. */
export function e2eFixCheckoutHead(log: string, checkoutRef: string): string | null {
  const lines = log.split(/\r?\n/).map(line => line.replace(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z /, ""));
  const start = lines.findIndex(line => line.startsWith("##[group]Run "));
  if (start < 0 || lines[start] !== `##[group]Run actions/checkout@${checkoutRef}`) return null;
  const next = lines.findIndex((line, i) => i > start && line.startsWith("##[group]Run "));
  if (next < 0) return null;
  const section = lines.slice(start, next);
  const commands = section.flatMap((line, i) => /^\[command\].+ log -1 --format=%H$/.test(line) ? [i] : []);
  if (commands.length !== 1) return null;
  const head = section[commands[0] + 1];
  return /^[a-f0-9]{40}$/.test(head ?? "") ? head : null;
}

/** Native stage providers. Waiting is ordinary host code; it never dispatches a
 * model or advances the next node. Unacknowledged writes are only reconciled. */
export function e2eFixGitHubProviders(transport: E2eFixGitHubTransport = live): E2eFixStageProviders {
  const context = (config: E2eFixTaskConfig, candidate: E2eFixCandidate, directory: string) => {
    const github = validateE2eFixGitHub(config);
    const store = new E2eFixCandidates(path.join(directory, "candidates")); store.verifyCandidate(candidate);
    if (candidate.task_id !== config.task_id || candidate.root_run_id !== config.root_run_id || candidate.repo !== config.repo || candidate.base !== config.base) throw new Error("GitHub candidate/task mismatch");
    const base = path.join(directory, "github"); const round = path.join(base, String(candidate.round));
    fs.mkdirSync(round, { recursive: true, mode: 0o700 });
    const branch = `codex/e2e-fix-${config.task_id}-${digest(config.root_run_id).slice(0, 10)}`;
    const marker = `<!-- homerail-e2e-fix:${config.task_id}:${config.root_run_id} -->`;
    const body = `Related to #${config.issue.number}\n\n${config.issue.title}\n\nThis PR is maintained by the E2E Fix workflow. Trusted tests and independent review gate each published candidate.\n\n${marker}`;
    save(path.join(base, "identity.json"), { repo: config.repo, branch, base: github.base_ref, marker, body });
    const api = `repos/${config.repo}`;
    const prValid = (pr: any) => pr.state === "open" && pr.head?.sha === candidate.head && pr.head?.ref === branch
      && pr.head?.repo?.full_name?.toLowerCase() === config.repo.toLowerCase() && pr.base?.ref === github.base_ref
      && pr.base?.repo?.full_name?.toLowerCase() === config.repo.toLowerCase() && pr.body === body;
    const observation = (name: string, value: unknown) => save(path.join(round, "observations", `${name}-${digest(value)}.json`), value);
    return { github, store, base, round, branch, body, api, prValid, observation };
  };
  return {
    mode: "production",
    publish(config, candidate, directory) {
      const c = context(config, candidate, directory);
      // The workflow definition executed on the candidate must be identical to
      // the frozen base. Candidate edits cannot weaken the CI entrypoint.
      const workflowBlob = (head: string) => {
        const r = spawnSync("git", ["--git-dir", c.store.gitDir, "rev-parse", `${head}:${config.policy.ci_workflow_path}`], { encoding: "utf8" });
        if (r.status !== 0) throw new Error("frozen CI workflow missing from candidate/base"); return r.stdout.trim();
      };
      if (workflowBlob(candidate.head) !== workflowBlob(config.base)) throw new Error("candidate changed frozen CI workflow");
      const previous = fs.readdirSync(c.base).filter(n => /^\d+$/.test(n) && Number(n) < candidate.round)
        .sort((a, b) => Number(b) - Number(a)).map(n => path.join(c.base, n, "published.json")).find(p => fs.existsSync(p));
      const expected = previous ? read(previous).observed_head as string : null;
      if (expected && spawnSync("git", ["--git-dir", c.store.gitDir, "merge-base", "--is-ancestor", expected, candidate.head]).status !== 0) throw new Error("candidate would discard previously published history");
      save(path.join(c.round, "push-intent.json"), { candidate, branch: c.branch, expected });
      const remote = () => {
        const refs = transport.api("GET", `${c.api}/git/matching-refs/heads/${c.branch}`);
        if (!Array.isArray(refs)) throw new Error("invalid GitHub refs observation");
        const matches = refs.filter(r => r.ref === "refs/heads/" + c.branch);
        if (matches.length > 1) throw new Error("ambiguous GitHub branch"); return matches[0]?.object?.sha ?? null;
      };
      let head = remote();
      if (head === candidate.head) {
        if (!fs.existsSync(path.join(c.round, "push.claim"))) throw new Error("unowned existing branch");
      } else {
        if (head !== expected) throw new Error("GitHub branch drift; refusing overwrite");
        if (!claim(path.join(c.round, "push.claim"))) throw new Error("prior push outcome unknown; refusing repeat");
        try { transport.push(c.store.directory, config.repo, c.branch, candidate.head, expected); }
        catch { /* A lost acknowledgement must be reconciled before any retry. */ }
        head = remote();
        if (head !== candidate.head) throw new Error("branch update not confirmed; preserved intent requires reconciliation");
      }
      const prs = () => transport.api("GET", `${c.api}/pulls?state=all&head=${encodeURIComponent(config.repo.split("/")[0] + ":" + c.branch)}&per_page=100`);
      let matches = prs();
      if (!Array.isArray(matches)) throw new Error("invalid PR observation");
      if (!matches.length) {
        if (fs.existsSync(path.join(c.base, "pr.json"))) throw new Error("owned PR missing; refusing replacement");
        save(path.join(c.base, "create-intent.json"), { repo: config.repo, branch: c.branch, base: c.github.base_ref, body: c.body });
        if (!claim(path.join(c.base, "create.claim"))) throw new Error("prior PR creation outcome unknown; refusing repeat");
        try { transport.api("POST", `${c.api}/pulls`, { head: c.branch, base: c.github.base_ref, title: `fix: ${config.issue.title}`.slice(0, 200), body: c.body, draft: true }); }
        catch { /* Read the same owned branch after an uncertain response. */ }
        matches = prs();
      } else if (!fs.existsSync(path.join(c.base, "create.claim"))) throw new Error("unowned existing PR");
      if (!Array.isArray(matches) || matches.length !== 1 || !c.prValid(matches[0])) throw new Error("PR identity/state/head not confirmed");
      const pr = matches[0]; save(path.join(c.base, "pr.json"), { number: pr.number }); c.observation("pr", pr);
      const result = { candidate, artifact_sha256: digest(pr), pr: pr.number, observed_head: pr.head.sha, state: "open" as const };
      save(path.join(c.round, "published.json"), result); return result;
    },
    ci(config, candidate, publication, directory) {
      const c = context(config, candidate, directory);
      if (read(path.join(c.base, "pr.json")).number !== publication.pr) throw new Error("CI publication custody mismatch");
      const evidenceFile = path.join(c.round, "ci-evidence.json");
      const retained = fs.existsSync(evidenceFile) ? read(evidenceFile) : null;
      const deadlineFile = path.join(c.round, "ci-deadline.json");
      if (!fs.existsSync(deadlineFile)) save(deadlineFile, { deadline: transport.now() + c.github.wait_ms });
      const { deadline } = read(deadlineFile);
      if (!Number.isSafeInteger(deadline)) throw new Error("invalid CI observation deadline");
      // Only transport failures are retried. Identity/inventory validation stays
      // outside this wrapper and fails immediately. No mutation is retried here.
      const retryRead = <T>(operation: string, readRemote: () => T): T => {
        if (retained) return readRemote();
        for (;;) {
          if (transport.now() > deadline) throw new Error("CI observation deadline");
          let value: T;
          try { value = readRemote(); }
          catch {
            c.observation("ci-read-error", { operation, at: transport.now() });
            const remaining = deadline - transport.now();
            if (remaining <= 0) throw new Error("CI observation deadline");
            transport.sleep(Math.min(c.github.poll_ms, remaining));
            continue;
          }
          if (transport.now() > deadline) throw new Error("CI observation deadline");
          return value;
        }
      };
      const get = (endpoint: string) => retryRead(endpoint, () => transport.api("GET", endpoint));
      const workflow = get(`${c.api}/actions/workflows/${encodeURIComponent(path.basename(config.policy.ci_workflow_path))}`);
      if (workflow.path !== config.policy.ci_workflow_path || workflow.state !== "active") throw new Error("CI workflow identity/state mismatch");
      save(path.join(c.round, "ci-intent.json"), { candidate, pr: publication.pr, workflow: workflow.id, branch: c.branch, target_ref: candidate.head });
      const pr = () => { const value = get(`${c.api}/pulls/${publication.pr}`); c.observation("pr", value); if (!c.prValid(value)) throw new Error("PR changed during CI observation"); return value; };
      pr();
      const custody = path.join(c.round, "ci-run.json");
      let run: any = fs.existsSync(custody) ? read(custody) : null;
      const result = (raw: any) => {
        const complete = !raw.failure && raw.run?.status === "completed" && raw.jobs.length > 0;
        const checkoutVerified = raw.checkout.length === config.policy.required_ci_jobs.length
          && raw.checkout.every((item: any) => item.head === candidate.head);
        const mapped = config.policy.required_ci_jobs.map(key => {
          const matches = raw.jobs.filter((job: any) => job.name === c.github.job_names[key]);
          const conclusion = matches.length === 1 && matches[0].status === "completed" ? matches[0].conclusion : "unknown";
          return { key, conclusion: (["success", "failure", "skipped", "cancelled", "timed_out"].includes(conclusion) ? conclusion : "unknown") as E2eFixAcceptanceInput["ci"]["jobs"][number]["conclusion"] };
        });
        return { candidate, artifact_sha256: digest(raw), pr: publication.pr, workflow_run_id: String(run?.id ?? "unknown"), workflow_attempt: run?.attempt ?? 1,
          workflow_path: config.policy.ci_workflow_path, observed_pr_head: candidate.head, status: complete && checkoutVerified ? "completed" as const : "unknown" as const, jobs: mapped,
          feedback: { failure: raw.failure ?? (!complete ? "CI observation deadline" : !checkoutVerified ? "CI checkout identity unverified" : null), logs: raw.logs, checkout: raw.checkout } };
      };
      if (retained) {
        // Recheck current custody, but never replace the already consumed verdict
        // with a later observation or dispatch another workflow.
        if (run) {
          const current = get(`${c.api}/actions/runs/${run.id}`);
          if (current.id !== run.id || current.run_attempt !== run.attempt || current.head_sha !== candidate.head
            || current.head_branch !== c.branch || current.event !== "workflow_dispatch" || current.workflow_id !== workflow.id
            || !(current.path === workflow.path || current.path?.startsWith(workflow.path + "@"))) throw new Error("CI run/attempt identity drift");
        }
        return result(retained);
      }
      const listing = `${c.api}/actions/workflows/${workflow.id}/runs?event=workflow_dispatch&head_sha=${candidate.head}&branch=${encodeURIComponent(c.branch)}&per_page=100`;
      const baselineFile = path.join(c.round, "ci-before-dispatch.json");
      if (!fs.existsSync(baselineFile)) {
        const before = get(listing);
        if (!Array.isArray(before.workflow_runs) || before.workflow_runs.length >= 100) throw new Error("incomplete pre-dispatch CI inventory");
        save(baselineFile, before.workflow_runs.map((r: any) => r.id));
      }
      const baseline = read(baselineFile) as number[];
      if (!run && claim(path.join(c.round, "ci-dispatch.claim"))) {
        try { transport.api("POST", `${c.api}/actions/workflows/${workflow.id}/dispatches`, { ref: c.branch, inputs: { target_ref: candidate.head } }); }
        catch { /* The dispatch may be running; query before making any claim. */ }
      }
      let observation: any = null; let jobs: any[] = []; let failure: string | null = null;
      const validRun = (r: any) => r.head_sha === candidate.head && r.head_branch === c.branch && r.event === "workflow_dispatch"
        && r.workflow_id === workflow.id && (r.path === workflow.path || r.path?.startsWith(workflow.path + "@"));
      while (transport.now() <= deadline) {
        try {
          pr();
          if (!run) {
            const listed = get(listing);
            if (!Array.isArray(listed.workflow_runs) || listed.workflow_runs.length >= 100) throw new Error("incomplete CI dispatch inventory");
            const runs = listed.workflow_runs.filter((r: any) => !baseline.includes(r.id));
            if (runs.length > 1 || runs.some((r: any) => !validRun(r))) throw new Error("ambiguous or mismatched CI dispatch");
            if (runs.length) { run = { id: runs[0].id, attempt: runs[0].run_attempt }; save(custody, run); }
          }
          if (run) {
            observation = get(`${c.api}/actions/runs/${run.id}`); c.observation("ci-run", observation);
            if (!validRun(observation) || observation.id !== run.id || observation.run_attempt !== run.attempt) throw new Error("CI run/attempt identity drift");
            if (observation.status === "completed") {
              const response = get(`${c.api}/actions/runs/${run.id}/attempts/${run.attempt}/jobs?per_page=100`);
              if (!Array.isArray(response.jobs) || response.total_count !== response.jobs.length) throw new Error("incomplete CI job inventory");
              jobs = response.jobs; c.observation("ci-jobs", response); pr(); break;
            }
          }
        } catch { failure = "CI observation unavailable or identity changed"; break; }
        const remaining = deadline - transport.now();
        if (remaining <= 0) break;
        transport.sleep(Math.min(c.github.poll_ms, remaining));
      }
      const logs: unknown[] = []; const checkout: Array<{ key: string; head: string | null; log_sha256?: string }> = [];
      for (const key of config.policy.required_ci_jobs) {
        const matching = jobs.filter(j => j.name === c.github.job_names[key]);
        if (matching.length !== 1 || matching[0].status !== "completed") { checkout.push({ key, head: null }); continue; }
        const job = matching[0];
        try {
          const log = retryRead(`job-${job.id}-log`, () => transport.logs(config.repo, job.id)); c.observation(`job-${job.id}-log`, log);
          checkout.push({ key, head: e2eFixCheckoutHead(log, c.github.checkout_ref), log_sha256: digest(log) });
          if (job.conclusion === "failure") logs.push({ job: job.name, tail: log.slice(-6000) });
        } catch { checkout.push({ key, head: null }); logs.push({ job: job.name, log_status: "unavailable" }); }
      }
      const raw = { run: observation, jobs, failure, logs, checkout }; save(evidenceFile, raw);
      return result(raw);
    },
  };
}
