import fs from "node:fs";
import { runE2eFixHostCodex, type E2eFixHostCodexRole } from "./e2e-fix-host-codex.js";
import { runE2eFixStage } from "./e2e-fix-stage.js";
import type { E2eFixStage } from "../orchestration/e2e-fix-workflow.js";
import { e2eFixGitHubProviders } from "./e2e-fix-github.js";

// The frozen workflow supplies this argv. No model-selectable executable or
// task directory is accepted through the handoff payload.
try {
  const [directory, stage, role] = process.argv.slice(2);
  if (stage === "host-codex") {
    process.stdout.write(JSON.stringify(await runE2eFixHostCodex(directory, role as E2eFixHostCodexRole, fs.readFileSync(0, "utf8"))));
  } else {
    process.stdout.write(JSON.stringify(runE2eFixStage(directory, stage as E2eFixStage, fs.readFileSync(0, "utf8"), process.env.HOMERAIL_DAG_COMMAND_ID, e2eFixGitHubProviders())));
  }
} catch (error) {
  process.stderr.write(`E2E Fix stage failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
