// Provider substitutes only. Every actual program stage uses production code.
import fs from "node:fs";
import path from "node:path";
import { runE2eFixStage, type E2eFixStageProviders } from "../../src/runtime/e2e-fix-stage.js";
import { e2eFixDigest, immutableE2eFixFile } from "../../src/runtime/e2e-fix-candidates.js";
import type { E2eFixStage } from "../../src/orchestration/e2e-fix-workflow.js";

const [directory, stage] = process.argv.slice(2);
const providers: E2eFixStageProviders = {
  mode: "simulation",
  publish(_config, candidate, directory) {
    // No GitHub request here. Simulation is explicitly carried in the result.
    immutableE2eFixFile(path.join(directory, "simulated-pr.json"), JSON.stringify({ pr: 7 }));
    return { candidate, artifact_sha256: e2eFixDigest(JSON.stringify(candidate)), pr: 7, observed_head: candidate.head, state: "open" };
  },
  ci(config, candidate, publication, directory) {
    const scenario = JSON.parse(fs.readFileSync(path.join(directory, "fixture-scenario.json"), "utf8"));
    const unknown = scenario === "unknown-ci";
    const stale = scenario === "stale-ci";
    const failed = scenario === "ci-feedback" && candidate.round === 1;
    return { candidate, artifact_sha256: e2eFixDigest("simulated-ci:" + candidate.head), pr: publication.pr,
      workflow_run_id: "simulated-ci", workflow_attempt: 1, workflow_path: config.policy.ci_workflow_path,
      observed_pr_head: stale ? config.base : candidate.head, status: unknown ? "unknown" : "completed", jobs: config.policy.required_ci_jobs.map(key => ({ key, conclusion: stale || failed ? "failure" : "success" })),
      feedback: failed ? { logs: [{ tail: "CI fixture assertion failure requiring a revision" }] } : null };
  },
};
try {
  process.stdout.write(JSON.stringify(runE2eFixStage(directory, stage as E2eFixStage, fs.readFileSync(0, "utf8"), process.env.HOMERAIL_DAG_COMMAND_ID, providers)));
} catch (error) { process.stderr.write("E2E Fix stage failed: " + (error instanceof Error ? error.message : String(error)) + "\n"); process.exitCode = 1; }
