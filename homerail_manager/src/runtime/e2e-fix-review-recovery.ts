import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { getDb } from "../persistence/db.js";
import { loadRunSnapshot } from "../persistence/store.js";
import { getDagSessionIndex } from "../persistence/dag-session-index.js";
import { observeDurableCommand, type DurableCommandRecord } from "./durable-command.js";
import { recoveryDigest } from "./dag-dispatch-recovery.js";
import { E2eFixCandidates, e2eFixDigest } from "./e2e-fix-candidates.js";
import { loadFrozenE2eFixRuntime } from "./e2e-fix-runtime.js";
import type { E2eFixTaskConfig } from "./e2e-fix-stage.js";
import type { E2eFixReviewRecoveryRequest } from "./e2e-fix-stage-runtime.js";
import { readE2eFixHostCodexEvidence } from "./e2e-fix-host-codex.js";

export function parseE2eFixReviewRecoveryRequest(value: unknown): E2eFixReviewRecoveryRequest {
  const v = value as E2eFixReviewRecoveryRequest;
  if (!v || typeof v !== "object" || Array.isArray(v)
    || Object.keys(v).some(k => !["request_id", "expected_state_sha256", "reason", "task_directory", "runtime_directory", "runtime_sha256"].includes(k))
    || typeof v.request_id !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(v.request_id)
    || typeof v.reason !== "string" || !v.reason.trim() || v.reason.length > 2000
    || [v.expected_state_sha256, v.runtime_sha256].some(s => typeof s !== "string" || !/^[a-f0-9]{64}$/.test(s))
    || [v.task_directory, v.runtime_directory].some(s => typeof s !== "string" || !path.isAbsolute(s) || s.includes("\0") || path.resolve(s) !== s)) {
    throw new Error("Invalid E2E Fix review recovery request");
  }
  return { request_id: v.request_id, expected_state_sha256: v.expected_state_sha256, reason: v.reason,
    task_directory: v.task_directory, runtime_directory: v.runtime_directory, runtime_sha256: v.runtime_sha256 };
}

/** Inspect every file before admitting the replacement interpreter. Bootstrap
 * repeats these checks at execution; changing a pinned file never authorizes it. */
export function verifyReviewRecoveryRuntime(request: E2eFixReviewRecoveryRequest): void {
  const root = request.runtime_directory;
  loadFrozenE2eFixRuntime(root, request.runtime_sha256);
  if (!fs.lstatSync(root).isDirectory() || (fs.statSync(root).mode & 0o077)) throw new Error("Recovery runtime custody must be private");
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
  if (manifest.version !== 1 || !Array.isArray(manifest.entries) || manifest.entries.length > 20000) throw new Error("Invalid recovery runtime inventory");
  const names = new Set<string>();
  for (const entry of manifest.entries) {
    const relative = entry.path;
    if (typeof relative !== "string" || path.isAbsolute(relative) || relative.includes("\\")
      || relative.split("/").some(p => !p || p === "." || p === "..") || names.has(relative)) throw new Error("Invalid recovery runtime path");
    names.add(relative);
    const file = path.join(root, relative); const stat = fs.lstatSync(file);
    if (!fs.realpathSync(file).startsWith(fs.realpathSync(root) + path.sep)) throw new Error("Recovery runtime escapes custody");
    if (entry.link !== undefined) {
      if (!stat.isSymbolicLink() || fs.readlinkSync(file) !== entry.link) throw new Error("Recovery runtime link changed");
    } else if (!stat.isFile() || e2eFixDigest(fs.readFileSync(file)) !== entry.sha256
      || Boolean(stat.mode & 0o111) !== entry.executable) throw new Error("Recovery runtime file changed");
  }
  if (!["node", "bootstrap.mjs", manifest.entry].every(n => names.has(n))) throw new Error("Recovery runtime entry missing");
  const walk = (dir: string, prefix = "") => {
    for (const name of fs.readdirSync(dir)) {
      const key = prefix ? prefix + "/" + name : name;
      if (key === "manifest.json") continue;
      const file = path.join(dir, name);
      if (fs.lstatSync(file).isDirectory()) walk(file, key);
      else if (!names.has(key)) throw new Error("Unexpected recovery runtime file");
    }
  };
  walk(root);
}

/** Only the known, side-effect-free aggregation overflow is eligible. A known
 * nonzero exit alone is not proof that an arbitrary command can be repeated. */
export function inspectE2eFixReviewRecovery(runId: string, request: E2eFixReviewRecoveryRequest) {
  const snapshot = loadRunSnapshot(runId); const failed = snapshot?.metadata;
  if (!snapshot || !failed || failed.status !== "failed" || recoveryDigest(failed) !== request.expected_state_sha256) throw new Error("E2E Fix review recovery state conflict");
  const read = (file: string) => JSON.parse(fs.readFileSync(file, "utf8"));
  const task = request.task_directory;
  if (!fs.lstatSync(task).isDirectory() || (fs.statSync(task).mode & 0o077)) throw new Error("Recovery task custody must be private");
  const config = read(path.join(task, "config.json")) as E2eFixTaskConfig;
  const policy = e2eFixDigest(JSON.stringify(config));
  if (config.version !== 1 || config.root_run_id !== runId
    || fs.readFileSync(path.join(task, "config.sha256"), "utf8").trim() !== policy
    || !Number.isSafeInteger(config.total_timeout_ms) || Date.now() >= failed.createdAt + config.total_timeout_ms
    || config.max_infra_retries < 1 || failed.currentRound?.ordinal !== 1
    || config.runtime_sha256 === request.runtime_sha256) throw new Error("E2E Fix review recovery policy or deadline mismatch");
  const node = failed.graph?.nodes.find(n => n.node_id === "review_evidence");
  if (node?.node_type !== "command_gateway" || !node.gateway_config?.durable || node.gateway_config.command_field
    || (config.mode === "production" && (!config.runtime_sha256
      || !isDeepStrictEqual(node.gateway_config.command?.slice(-3), [config.runtime_sha256, task, "review_evidence"])))) throw new Error("Recovery requires the frozen review aggregation command");
  const last = snapshot.handoffs.at(-1);
  const commands = getDb().prepare("SELECT * FROM dag_durable_commands WHERE run_id = ?").all(runId) as DurableCommandRecord[];
  let failedExecution: string | undefined;
  for (const command of commands) {
    const identity = JSON.parse(command.identity_json);
    const session = getDagSessionIndex(runId, identity.node_id);
    const result = observeDurableCommand(command);
    if (!command.consumed || !command.receipt_digest || result.status !== "finished"
      || result.receipt_digest !== command.receipt_digest || result.error || result.signal || result.cancelled || result.timed_out || result.overflow
      || identity.round_id !== failed.currentRound.round_id || !session || session.session_id !== identity.session_id || session.attempt !== identity.attempt) throw new Error("Recovery found uncertain or superseded command execution");
    if (identity.node_id === "review_evidence") {
      const failure = last?.content as { receipt_digest?: string } | undefined;
      if (failedExecution || result.exit_code !== 1 || result.stdout !== ""
        || result.stderr !== "E2E Fix stage failed: stage output exceeds frozen context bound\n"
        || last?.fromNode !== "review_evidence" || failure?.receipt_digest !== command.receipt_digest
        || !isDeepStrictEqual(JSON.parse(command.spec_json).argv, node.gateway_config.command)) throw new Error("Recovery lacks exact aggregation failure evidence");
      failedExecution = command.execution_id;
    } else {
      const completed = snapshot.handoffs.filter(h => h.fromNode === identity.node_id).at(-1);
      if (result.exit_code !== 0 || failed.nodeStates[identity.node_id] !== "COMPLETED"
        || !completed || !isDeepStrictEqual(JSON.parse(result.stdout), completed.content)) throw new Error("Recovery completed command evidence mismatch");
      if (!["plan", "judge_candidate", "judge_ci"].includes(identity.node_id)
        && !(identity.node_id === "fix" && config.host_codex?.fixer)) {
        const output = JSON.parse(result.stdout);
        if (![0, 1].includes(output.round) || !isDeepStrictEqual(read(path.join(task, "rounds", String(output.round), identity.node_id + ".json")), output)) throw new Error("Recovery stage artifact differs from native output");
      }
    }
  }
  if (!failedExecution) throw new Error("Recovery aggregation execution missing");
  const folder = path.join(task, "rounds", "1");
  if (fs.existsSync(path.join(folder, "review_evidence.json")) || fs.existsSync(path.join(folder, "executions/review_evidence.json"))) throw new Error("Recovery cannot overwrite completed aggregation");
  const candidate = read(path.join(folder, "capture.json")).candidate;
  const plan = read(path.join(folder, "freeze_plan.json"));
  if (!candidate || candidate.policy_sha256 !== policy || candidate.plan_sha256 !== e2eFixDigest(JSON.stringify(plan.plan))) throw new Error("Recovery candidate binding mismatch");
  const candidates = new E2eFixCandidates(path.join(task, "candidates"));
  candidates.verifyCandidate(candidate);
  candidates.verifySnapshot(candidate.tree, path.join(task, "candidates/snapshots", candidate.tree));
  const tested = read(path.join(folder, "test.json"));
  if (!isDeepStrictEqual(tested.candidate, candidate) || tested.outcome !== "passed"
    || !isDeepStrictEqual(tested.tests.map((t: any) => t.check_id).sort(), [...config.policy.required_tests].sort())) throw new Error("Recovery test evidence missing");
  for (const test of tested.tests) {
    const directory = path.join(folder, "tests", test.check_id);
    const attempts = fs.readdirSync(directory);
    if (!attempts.length || attempts.some(n => !/^[1-9]\d*$/.test(n) || Number(n) > config.max_infra_retries + 1)) throw new Error("Recovery test attempt mismatch");
    const latest = path.join(directory, String(Math.max(...attempts.map(Number))));
    const bytes = fs.readFileSync(path.join(latest, "receipt.json")); const receipt = JSON.parse(bytes.toString());
    if (e2eFixDigest(bytes) !== test.artifact_sha256 || fs.readFileSync(path.join(latest, "receipt.sha256"), "utf8").trim() !== test.artifact_sha256
      || receipt.log_digest !== e2eFixDigest(fs.readFileSync(path.join(latest, "test.log")))
      || !isDeepStrictEqual(receipt.candidate, candidate) || receipt.execution_id !== test.execution_id
      || receipt.result !== "passed" || receipt.exit_code !== 0 || receipt.signal !== null) throw new Error("Recovery trusted test receipt mismatch");
  }
  for (const role of ["fix", "review_a", "review_b", "review_c"]) {
    const artifact = read(path.join(folder, (role === "fix" ? "fixer" : role) + ".json"));
    const session = getDagSessionIndex(runId, role);
    const handoff = snapshot.handoffs.filter(h => h.fromNode === role && h.port === "result").at(-1);
    if (failed.nodeStates[role] !== "COMPLETED" || session?.status !== "completed" || artifact.session_id !== session.session_id
      || !handoff || !isDeepStrictEqual(artifact.value, handoff.content)) throw new Error("Recovery model evidence mismatch");
    if (role === "fix" && config.host_codex?.fixer) {
      const host = readE2eFixHostCodexEvidence(task, "fix", 1, { run_id: runId, node_id: role,
        session_id: session.session_id, round_id: failed.currentRound!.round_id, attempt: session.attempt });
      if (!isDeepStrictEqual(host.value, artifact.value) || artifact.dispatch_id !== host.command_id
        || artifact.artifact_sha256 !== e2eFixDigest(JSON.stringify(host))) throw new Error("Recovery host Fixer evidence mismatch");
    } else if (artifact.artifact_sha256 !== e2eFixDigest(JSON.stringify({ node: role, session: session.session_id, value: artifact.value }))) {
      throw new Error("Recovery model evidence mismatch");
    }
  }
  verifyReviewRecoveryRuntime(request);
  return { snapshot, config, policy, failedExecution, candidate };
}
