import fs from "node:fs";
import path from "node:path";
import { buildE2eFixWorkflow, parseE2eFixWorkflow } from "../orchestration/e2e-fix-workflow.js";
import { inspectDagRuntimeProfileStructure } from "../persistence/dag-workflows.js";
import { e2eFixDigest, immutableE2eFixFile } from "./e2e-fix-candidates.js";
import { freezeE2eFixTask, type E2eFixTaskConfig } from "./e2e-fix-stage.js";
import { loadFrozenE2eFixRuntime, frozenE2eFixStageCommands, frozenE2eFixHostCodexCommands } from "./e2e-fix-runtime.js";

/** Host-local preparation only: never dispatch a model, run tests or publish.
 * A complete manifest is the commit marker. An interrupted directory is kept
 * for inspection and cannot be silently overwritten on another invocation. */
export function prepareE2eFix(input: {
  directory: string;
  config: E2eFixTaskConfig;
  runtime: { directory: string; sha256: string };
  profile: unknown;
  stage_timeout_ms: number;
}) {
  if (process.platform !== "linux" || !path.isAbsolute(input.directory)) throw new Error("prepare requires an absolute Linux host directory");
  const directory = path.join(fs.realpathSync(path.dirname(input.directory)), path.basename(input.directory));
  const config = structuredClone(input.config);
  // This entrypoint always uses the real GitHub stage adapter.
  if (config.mode !== "production" || !config.host_codex) throw new Error("prepare requires production mode and explicit host Codex planning/judgment");
  const source = fs.realpathSync(config.source_repo);
  if (directory === source || directory.startsWith(source + path.sep)) throw new Error("task artifacts must be outside the source repository");
  const runtime = loadFrozenE2eFixRuntime(input.runtime.directory, input.runtime.sha256);
  if (config.runtime_sha256 !== runtime.sha256) throw new Error("task and runtime digest mismatch");
  const profile = inspectDagRuntimeProfileStructure(JSON.stringify(input.profile));
  if (profile.workflow_id !== config.root_run_id || profile.profile_id !== config.root_run_id) throw new Error("profile/workflow/root identities must match");
  if (!profile.default?.llm_setting_id && !profile.default?.model_alias) throw new Error("prepare requires an explicit default model setting reference");
  const taskDirectory = path.join(directory, "task");
  const options = {
    workflowId: config.root_run_id, maxRounds: config.max_rounds,
    stageTimeoutMs: input.stage_timeout_ms,
    stageCommands: frozenE2eFixStageCommands(runtime, taskDirectory),
    hostCodexCommands: frozenE2eFixHostCodexCommands(runtime, taskDirectory, { fixer: config.host_codex.fixer }),
  };
  parseE2eFixWorkflow(options);
  // mkdir without recursive is the exclusive preparation claim; never remove
  // an existing or partially prepared task on error.
  fs.mkdirSync(directory, { mode: 0o700 });
  fs.chmodSync(directory, 0o700);
  const parent = fs.openSync(path.dirname(directory), "r");
  try { fs.fsyncSync(parent); } finally { fs.closeSync(parent); }
  const save = (name: string, value: unknown) => immutableE2eFixFile(path.join(directory, name), JSON.stringify(value));
  const policy = freezeE2eFixTask(taskDirectory, config);
  save("runtime.json", runtime);
  save("workflow.json", buildE2eFixWorkflow(options));
  save("profile.json", profile);
  const files = Object.fromEntries(["task/config.json", "task/config.sha256", "runtime.json", "workflow.json", "profile.json"]
    .map(name => [name, e2eFixDigest(fs.readFileSync(path.join(directory, name)))]));
  const manifest = { version: 1, root_run_id: config.root_run_id, task_id: config.task_id,
    policy_sha256: policy, runtime_sha256: runtime.sha256, files,
    started: false, scope: "prepared_only; model availability, runtime inventory and actual execution are not yet verified" };
  save("prepared.json", manifest);
  return manifest;
}
