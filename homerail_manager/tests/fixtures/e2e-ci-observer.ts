import fs from "node:fs";
import path from "node:path";
import { e2eFixGitHubProviders } from "../../src/runtime/e2e-fix-github.js";

// Real observer process, injected GitHub transport. No network or model calls.
const directory = process.argv[2];
const read = (name: string) => JSON.parse(fs.readFileSync(path.join(directory, name), "utf8"));
const write = (name: string, value: unknown) => fs.writeFileSync(path.join(directory, name), JSON.stringify(value));
const { config, candidate, publication } = read("observer-input.json");
const provider = e2eFixGitHubProviders({
  now: Date.now,
  sleep(ms) {
    write("observer-waiting.json", { pid: process.pid });
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  },
  push() { throw new Error("observer must never push"); },
  logs() {
    return `##[group]Run actions/checkout@${config.github.checkout_ref}\n[command]/usr/bin/git log -1 --format=%H\n${candidate.head}\n##[group]Run npm test\n`;
  },
  api(method, endpoint) {
    fs.appendFileSync(path.join(directory, "observer-requests.jsonl"), JSON.stringify({ pid: process.pid, method, endpoint }) + "\n");
    const state = read("observer-remote.json");
    if (endpoint.endsWith("/workflows/ci.yml")) return { id: 7, path: ".github/workflows/ci.yml", state: "active" };
    if (endpoint.endsWith("/pulls/11")) return state.pr;
    if (endpoint.endsWith("/dispatches") && method === "POST") {
      if (state.run) throw new Error("duplicate dispatch");
      state.run = { id: 99, run_attempt: 1, head_sha: candidate.head, head_branch: state.pr.head.ref,
        event: "workflow_dispatch", workflow_id: 7, path: ".github/workflows/ci.yml", status: "in_progress" };
      write("observer-remote.json", state);
      return null;
    }
    if (endpoint.includes("/workflows/7/runs?")) return { workflow_runs: state.run ? [state.run] : [] };
    if (endpoint.endsWith("/actions/runs/99")) return state.run;
    if (endpoint.endsWith("/attempts/1/jobs?per_page=100")) return {
      total_count: 1, jobs: [{ id: 10, name: "Unit (Linux)", status: "completed", conclusion: "success" }],
    };
    throw new Error("unexpected fixture request");
  },
});
const result = provider.ci(config, candidate, publication, directory);
write("observer-result.json", { pid: process.pid, result });
