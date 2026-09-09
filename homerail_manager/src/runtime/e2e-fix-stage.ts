import fs from "node:fs";
import { readE2eFixHostCodexEvidence } from "./e2e-fix-host-codex.js";
import { readE2eFixModelFailure } from "./e2e-fix-model-failure.js";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { E2eFixAcceptancePolicySchema, evaluateE2eFixAcceptance, sameE2eFixCandidate, type E2eFixAcceptanceInput, type E2eFixCandidate } from "homerail-protocol";
import { getDurableCommand, type DurableCommandIdentity } from "./durable-command.js";
import { getDagSessionIndex } from "../persistence/dag-session-index.js";
import { loadRunMetadata, loadRunSnapshot, loadNodeUsages } from "../persistence/store.js";
import { E2eFixCandidates, E2eFixProposalError, e2eFixDigest, e2eFixPath, immutableE2eFixFile, type E2eFixEdit } from "./e2e-fix-candidates.js";
import { E2eFixIsolatedTest, validateE2eFixTestDefinition, type E2eFixTestDefinition } from "./e2e-fix-test.js";
import type { E2eFixStage } from "../orchestration/e2e-fix-workflow.js";
import { validateE2eFixGitHub, type E2eFixGitHubConfig } from "./e2e-fix-github.js";
import { assertE2eFixStageRuntime } from "./e2e-fix-stage-runtime.js";
import { projectE2eFixReviewContext } from "./e2e-fix-review-context.js";
import { readE2eFixModelRuntime, verifyLegacyE2eFixModelArtifact } from "./e2e-fix-model-runtime.js";
import { assessE2eFixProgress, e2eFixFailureFingerprint, sameE2eFixPlan, type E2eFixFailureObservation } from "./e2e-fix-progress.js";

const digest = (value: unknown) => e2eFixDigest(JSON.stringify(value));
type Policy = E2eFixAcceptanceInput["policy"];
export interface E2eFixTaskConfig {
  version: 1; task_id: string; root_run_id: string; mode: "production" | "simulation";
  source_repo: string; repo: string; base: string;
  issue: { number: number; title: string; body: string };
  allowed_paths: string[]; protected_paths: string[];
  tests: E2eFixTestDefinition[]; policy: Omit<Policy, "sha256">;
  max_rounds: number; max_infra_retries: number; context_bytes: number; total_timeout_ms: number;
  runtime_sha256?: string;
  github?: E2eFixGitHubConfig;
  host_codex?: { model: string; timeout_ms: number; output_bytes: number; fixer?: boolean };
}
export interface E2eFixStageProviders {
  mode: "production" | "simulation";
  publish(config: E2eFixTaskConfig, candidate: E2eFixCandidate, directory: string): E2eFixAcceptanceInput["publication"];
  ci(config: E2eFixTaskConfig, candidate: E2eFixCandidate, publication: E2eFixAcceptanceInput["publication"], directory: string): E2eFixAcceptanceInput["ci"] & { feedback?: unknown };
}
interface ModelEvidence {
  node_id: string; dispatch_id: string; session_id: string; attempt: number;
  agent_type: string; model: string | null; artifact_sha256: string; value: any; usage_status: "reported_session_snapshots" | "reported_host_turn" | "unknown"; usages: unknown[];
  runtime?: ReturnType<typeof readE2eFixModelRuntime>;
}

/** Host API only. Never construct this policy from issue text or model output. */
export function freezeE2eFixTask(directory: string, config: E2eFixTaskConfig): string {
  if (!path.isAbsolute(directory) || config.version !== 1 || !["production", "simulation"].includes(config.mode)
    || !/^[A-Za-z0-9_-]{1,100}$/.test(config.task_id) || !/^[A-Za-z0-9_-]{1,100}$/.test(config.root_run_id)
    || !path.isAbsolute(config.source_repo) || !/^[a-f0-9]{40}$/.test(config.base)
    || !Number.isInteger(config.max_rounds) || config.max_rounds < 1 || config.max_rounds > 20
    || !Number.isInteger(config.max_infra_retries) || config.max_infra_retries < 0 || config.max_infra_retries > 2
    || !Number.isInteger(config.context_bytes) || config.context_bytes < 1000 || config.context_bytes > 96000
    || !Number.isInteger(config.total_timeout_ms) || config.total_timeout_ms < 1000 || config.total_timeout_ms > 86_400_000
    || !config.allowed_paths.length || config.allowed_paths.length > 20
    || (config.mode === "production" && !/^[a-f0-9]{64}$/.test(config.runtime_sha256 ?? ""))
    || (config.runtime_sha256 !== undefined && !/^[a-f0-9]{64}$/.test(config.runtime_sha256))
    || new Set(config.allowed_paths).size !== config.allowed_paths.length) throw new Error("invalid frozen E2E Fix configuration");
  if (config.host_codex && ((config.host_codex.fixer !== undefined && typeof config.host_codex.fixer !== "boolean") || !config.host_codex.model?.trim()
    || !Number.isInteger(config.host_codex.timeout_ms) || config.host_codex.timeout_ms < 1000 || config.host_codex.timeout_ms > 3_500_000
    || !Number.isInteger(config.host_codex.output_bytes) || config.host_codex.output_bytes < 1000 || config.host_codex.output_bytes > 96000)) throw new Error("invalid frozen host Codex bounds");
  [...config.allowed_paths, ...config.protected_paths].forEach(e2eFixPath);
  config.tests.forEach(validateE2eFixTestDefinition);
  if (new Set(config.tests.map(t => t.id)).size !== config.tests.length
    || !isDeepStrictEqual([...config.tests.map(t => t.id)].sort(), [...config.policy.required_tests].sort())
    || !isDeepStrictEqual([...config.policy.reviewer_ids].sort(), ["review_a", "review_b", "review_c"])) throw new Error("frozen test/reviewer set mismatch");
  E2eFixAcceptancePolicySchema.parse({ ...config.policy, sha256: digest(config) });
  if (config.github || config.mode === "production") validateE2eFixGitHub(config);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (!fs.lstatSync(directory).isDirectory() || (fs.statSync(directory).mode & 0o077)) throw new Error("task custody must be private");
  immutableE2eFixFile(path.join(directory, "config.json"), JSON.stringify(config));
  immutableE2eFixFile(path.join(directory, "config.sha256"), digest(config));
  return digest(config);
}

export function authenticateE2eFixInvocation(directory: string, stage: string, rawInput: string, commandId?: string) {
  if (!commandId) throw new Error("E2E Fix stages require native durable command authority");
  const command = getDurableCommand(commandId);
  if (!command || command.consumed) throw new Error("command authority missing or already consumed");
  const identity = JSON.parse(command.identity_json) as DurableCommandIdentity;
  const spec = JSON.parse(command.spec_json);
  const config = JSON.parse(fs.readFileSync(path.join(directory, "config.json"), "utf8")) as E2eFixTaskConfig;
  const policyDigest = freezeE2eFixTask(directory, config);
  assertE2eFixStageRuntime(directory, stage, config, policyDigest, spec.argv);
  const metadata = loadRunMetadata(identity.run_id);
  const commandSession = getDagSessionIndex(identity.run_id, stage);
  if (identity.run_id !== config.root_run_id || identity.node_id !== stage || spec.stdin !== rawInput
    || metadata?.status !== "active" || metadata.currentRound?.round_id !== identity.round_id || metadata.nodeStates[stage] !== "RUNNING"
    || commandSession?.session_id !== identity.session_id || commandSession.attempt !== identity.attempt) throw new Error("native stage identity/input mismatch");
  const now = Date.now();
  if (now - metadata.createdAt > config.total_timeout_ms) throw new Error("root execution deadline exceeded");
  const round = stage === "initialize" ? 0 : metadata.counters?.gateway_iterations.cycle ?? 0;
  if (stage !== "initialize" && (!Number.isInteger(round) || round < 1 || round > config.max_rounds)) throw new Error("native round budget exceeded");
  return { config, policyDigest, metadata, round, identity, command, spec };
}

/** Each invocation executes exactly one native node. No repair/dispatch loop is
 * hidden here. Model evidence comes from Manager persistence, not self-reports. */
export function runE2eFixStage(directory: string, stage: E2eFixStage, rawInput: string,
  commandId = process.env.HOMERAIL_DAG_COMMAND_ID, providers?: E2eFixStageProviders): unknown {
  const { config, policyDigest, round, identity } = authenticateE2eFixInvocation(directory, stage, rawInput, commandId);
  const inputs = JSON.parse(rawInput) as Record<string, unknown[]>;
  const one = (name: string): any => inputs[name]?.at(-1);
  const folder = path.join(directory, "rounds", String(round));
  const read = (name: string): any => JSON.parse(fs.readFileSync(path.join(folder, name + ".json"), "utf8"));
  const write = (name: string, value: unknown) => immutableE2eFixFile(path.join(folder, name + ".json"), JSON.stringify(value));
  const reference = () => ({ task_id: config.task_id, root_run_id: config.root_run_id, round, policy_sha256: policyDigest });
  const bound = (candidate: E2eFixCandidate, value: unknown) => ({ candidate, artifact_sha256: digest(value) });
  const candidates = new E2eFixCandidates(path.join(directory, "candidates"));
  const policy: Policy = { ...config.policy, sha256: policyDigest };
  const recordProgress = (decision: any, observation: E2eFixFailureObservation) => {
    if (decision.action !== "revise") return decision;
    const previous: Array<string | null> = [];
    for (let prior = 1; prior < round; prior++) {
      const dir = path.join(directory, "rounds", String(prior));
      const file = path.join(dir, fs.existsSync(path.join(dir, "complete.json")) ? "complete.json" : "record_candidate_judgment.json");
      previous.push(JSON.parse(fs.readFileSync(file, "utf8")).stagnation?.failure_sha256 ?? null);
    }
    const stagnation = assessE2eFixProgress(e2eFixFailureFingerprint(observation), previous);
    return { ...decision, stagnation,
      action: stagnation.action === "pause" ? "pause" : decision.action,
      reason: stagnation.action === "pause" ? `Three consecutive unchanged failures; retained candidates require a new external decision. Judger: ${decision.reason}` : decision.reason,
      feedback: { ...decision.feedback, stagnation,
        ...(stagnation.action === "replan" ? { previous_plan: read("freeze_plan").plan,
          previous_plan_sha256: read("freeze_plan").plan_sha256 } : {}) } };
  };
  const modelEvidence = (node: string, submitted: unknown): ModelEvidence => {
    const current = loadRunMetadata(config.root_run_id)!;
    const session = getDagSessionIndex(config.root_run_id, node);
    const latest = loadRunSnapshot(config.root_run_id)?.handoffs.filter(h => h.fromNode === node && h.port === "result").at(-1);
    if (!session || current.nodeStates[node] !== "COMPLETED" || session.status !== "completed"
      || !latest || !isDeepStrictEqual(latest.content, submitted)) throw new Error(`model handoff provenance mismatch: ${node}`);
    const graphNode = current.graph?.nodes.find(n => n.node_id === node);
    if (config.host_codex && (["plan", "judge_candidate", "judge_ci"].includes(node) || (node === "fix" && config.host_codex.fixer))) {
      if (graphNode?.node_type !== "command_gateway" || !current.currentRound?.round_id) throw new Error("host Codex role requires a native command");
      const evidence = readE2eFixHostCodexEvidence(directory, node, round, {
        run_id: config.root_run_id, node_id: node, session_id: session.session_id,
        round_id: current.currentRound.round_id, attempt: session.attempt,
      });
      if (!isDeepStrictEqual(evidence.value, latest.content)) throw new Error("host Codex handoff differs from receipt");
      return { node_id: node, session_id: session.session_id, attempt: session.attempt,
        dispatch_id: evidence.command_id, agent_type: "codex_appserver", model: evidence.model,
        artifact_sha256: digest(evidence), value: evidence.value,
        usage_status: evidence.usages.length ? "reported_host_turn" : "unknown", usages: evidence.usages };
    }
    const agent = graphNode && current.agents?.[graphNode.agent];
    const type = agent?.agent_type ?? "unknown";
    if (config.mode === "production" && (["plan", "judge_candidate", "judge_ci"].includes(node) ? type !== "codex_appserver" : type === "deterministic" || type === "unknown")) throw new Error(`unapproved role backend: ${node}`);
    const usages = loadNodeUsages(config.root_run_id).filter(u => u.nodeId === node && u.scope?.session_id === session.session_id);
    const runtime = readE2eFixModelRuntime(loadRunSnapshot(config.root_run_id)!, {
      run_id: config.root_run_id, node_id: node, session_id: session.session_id,
      round_id: current.currentRound!.round_id,
    });
    if (config.mode === "production" && (runtime.status !== "verified_dispatch" || runtime.agent_type !== type)) {
      throw new Error(`verified model dispatch runtime required: ${node}`);
    }
    return { node_id: node, session_id: session.session_id, attempt: session.attempt,
      dispatch_id: `${config.root_run_id}:${node}:${session.session_id}:${session.attempt}`,
      agent_type: type, model: runtime.status === "verified_dispatch" ? runtime.model : null, runtime,
      artifact_sha256: digest({ node, session: session.session_id, value: latest.content, runtime }),
      value: latest.content, usage_status: usages.length ? "reported_session_snapshots" : "unknown", usages };
  };
  let result: any;
  if (stage === "initialize") {
    if (one("task")?.task_id !== config.task_id) throw new Error("task reference mismatch");
    candidates.seed(config.source_repo, config.base);
    result = { ...reference(), status: "next", mode: config.mode };
  } else if (stage === "context") {
    let parent = config.base; let previous: unknown = null;
    if (round > 1) {
      const prior = path.join(directory, "rounds", String(round - 1));
      const decision = JSON.parse(fs.readFileSync(path.join(prior, fs.existsSync(path.join(prior, "complete.json")) ? "complete.json" : "record_candidate_judgment.json"), "utf8"));
      if (decision.action !== "revise") throw new Error("next round lacks a trusted revision decision");
      parent = JSON.parse(fs.readFileSync(path.join(prior, "capture.json"), "utf8")).candidate?.head
        ?? JSON.parse(fs.readFileSync(path.join(prior, "freeze_plan.json"), "utf8")).parent;
      previous = { reason: decision.reason, evidence: decision.feedback, previous_head: parent };
    }
    result = { ...reference(), issue: config.issue, allowed_paths: config.allowed_paths,
      sources: candidates.source(parent, config.allowed_paths), parent, previous };
  } else if (stage === "freeze_plan") {
    const context = read("context"); const evidence = modelEvidence("plan", one("plan")); const plan = evidence.value;
    if (!Array.isArray(plan.allowed_paths) || !plan.allowed_paths.length || plan.allowed_paths.some((p: string) => !config.allowed_paths.includes(p))) throw new Error("Codex plan exceeds frozen scope");
    const previousPlan = context.previous?.evidence?.previous_plan;
    if (context.previous?.evidence?.stagnation?.action === "replan"
      && (!previousPlan || sameE2eFixPlan(plan, previousPlan))) {
      throw new Error("repeated failure requires a changed Codex plan before another Fixer dispatch");
    }
    if (context.previous?.evidence?.model_failure && previousPlan
      && plan.strategy.trim() === previousPlan.strategy.trim()
      && isDeepStrictEqual([...new Set(plan.allowed_paths)].sort(), [...new Set(previousPlan.allowed_paths)].sort())) {
      throw new Error("model failure recovery requires a changed Codex plan");
    }
    write("planner", evidence);
    result = { ...reference(), plan, plan_sha256: digest(plan), sources: Object.fromEntries(plan.allowed_paths.map((p: string) => [p, context.sources[p]])), parent: context.parent, issue: config.issue, previous: context.previous };
  } else if (stage === "capture") {
    const frozen = read("freeze_plan");
    if (one("failure") !== undefined) {
      const failure = readE2eFixModelFailure(config.root_run_id, "fix", one("failure"));
      write("fixer_failure", failure);
      result = { ...reference(), candidate: null, outcome: "model_failure", model_failure: failure };
    } else {
      const fixer = modelEvidence("fix", one("patch")); write("fixer", fixer);
      try {
        const candidate = candidates.capture({ ...reference(), plan_sha256: frozen.plan_sha256, base: config.base,
          repo: config.repo, parent: frozen.parent, allowed_paths: frozen.plan.allowed_paths, protected_paths: config.protected_paths,
          summary: fixer.value.summary, edits: fixer.value.edits as E2eFixEdit[] });
        result = { ...reference(), candidate };
      } catch (error) {
        if (!(error instanceof E2eFixProposalError)) throw error;
        result = { ...reference(), candidate: null, outcome: "proposal_rejected", error: error.message };
      }
    }
  } else if (stage === "test") {
    const captured = read("capture");
    if (!captured.candidate) {
      result = { ...reference(), candidate: null, tests: [], outcome: captured.outcome,
        ...(captured.model_failure ? { model_failure: captured.model_failure } : { proposal_error: captured.error }),
        sources: read("context").sources, issue: config.issue, test_summaries: [] };
    } else {
      const candidate = captured.candidate as E2eFixCandidate;
      const snapshot = candidates.snapshot(candidate.tree);
      const tests: E2eFixAcceptanceInput["tests"] = [];
      for (const definition of config.tests) {
        for (let attempt = 1; attempt <= config.max_infra_retries + 1; attempt++) {
          const test = new E2eFixIsolatedTest(path.join(folder, "tests", definition.id, String(attempt)), {
            candidate, definition, snapshot, candidate_store: candidates.directory, attempt,
          });
          const receipt = test.run();
          candidates.verifySnapshot(candidate.tree, snapshot);
          if (receipt.result === "interrupted" && attempt <= config.max_infra_retries) continue;
          tests.push({ ...bound(candidate, receipt), check_id: definition.id, execution_id: receipt.execution_id,
            result: receipt.result, exit_code: receipt.exit_code, signal: receipt.signal });
          break;
        }
      }
      result = { ...reference(), candidate, tests,
        outcome: tests.every(t => t.result === "passed") ? "passed" : tests.some(t => ["unknown", "interrupted"].includes(t.result)) ? "infrastructure_failure" : "code_failure",
        sources: candidates.source(candidate.head, config.allowed_paths), issue: config.issue,
        test_summaries: config.tests.map(d => {
          const dir = path.join(folder, "tests", d.id); const attempts = fs.readdirSync(dir).map(Number).sort((a, b) => a - b);
          return { check_id: d.id, attempts: attempts.length, log_tail: fs.readFileSync(path.join(dir, String(attempts.at(-1)), "test.log"), "utf8").slice(-5000) };
        }) };
    }
  } else if (stage === "review_evidence") {
    const tested = read("test");
    const reports = config.policy.reviewer_ids.map(node => {
      const latest = loadRunSnapshot(config.root_run_id)?.handoffs.filter(h => h.fromNode === node && h.port === "result").at(-1);
      let evidence = modelEvidence(node, latest?.content);
      if (fs.existsSync(path.join(folder, node + ".json")) && read(node).runtime === undefined && evidence.runtime) {
        const current = loadRunMetadata(config.root_run_id)!;
        const graphNode = current.graph?.nodes.find(n => n.node_id === node);
        const legacyModel = (graphNode && current.agents?.[graphNode.agent]?.model) ?? null;
        const original = verifyLegacyE2eFixModelArtifact(read(node), evidence, legacyModel) as ModelEvidence;
        write(node + "_runtime", evidence.runtime);
        evidence = original;
      }
      write(node, evidence);
      const findings = evidence.value.findings.map((message: string) => ({ id: digest({ candidate: tested.candidate, node, message }), message }));
      return { ...bound(tested.candidate, evidence), reviewer_id: node, dispatch_id: evidence.dispatch_id, session_id: evidence.session_id,
        status: "complete" as const, vote: evidence.value.vote, finding_ids: findings.map((f: { id: string }) => f.id), findings, summary: evidence.value.summary };
    });
    // Keep each finding body once. Reports reference those bodies by ID; the
    // complete original reviewer output remains in its immutable artifact.
    result = { ...tested, outcome: "reviewed", reports: reports.map(({ findings: _, ...report }) => report), findings: reports.flatMap(r => r.findings),
      evidence_sha256: [...tested.tests.map((t: { artifact_sha256: string }) => t.artifact_sha256), ...reports.map(r => r.artifact_sha256)] };
    const invalidApprovals = reports.filter(r => r.vote === "approve" && r.finding_ids.length);
    if (invalidApprovals.length) result.review_contract_errors = invalidApprovals.map(r => ({ reviewer_id: r.reviewer_id,
      code: "approve_with_findings", reason: "Approval requires empty findings. This report cannot count toward publication, even if the Judger dismisses its findings." }));
    result = projectE2eFixReviewContext(result, candidates, config.context_bytes);
  } else if (stage === "record_candidate_judgment") {
    const tested = read("test"); const reviewed = fs.existsSync(path.join(folder, "review_evidence.json")) ? read("review_evidence") : null;
    const evidence = modelEvidence("judge_candidate", one("judgment")); write("candidate_judger", evidence);
    const proposed = evidence.value;
    const findings = reviewed?.findings ?? [];
    const dispositions = proposed.dispositions ?? [];
    const dispositionIds = dispositions.map((d: any) => d.finding_id);
    const exactDispositions = dispositionIds.length === findings.length && new Set(dispositionIds).size === dispositionIds.length
      && dispositionIds.every((id: string) => findings.some((f: { id: string }) => f.id === id));
    const isDismissed = (f: { id: string }) => exactDispositions && dispositions.some((d: any) => d.finding_id === f.id && d.action === "dismiss"
      && typeof d.reason === "string" && d.reason.trim() && d.evidence_sha256?.length && d.evidence_sha256.every((sha: string) => reviewed.evidence_sha256.includes(sha)));
    const dismissed = exactDispositions && findings.every(isDismissed);
    const independentSessions = [tested.model_failure?.session_id ?? read("fixer").session_id, evidence.session_id, ...(reviewed?.reports.map((r: any) => r.session_id) ?? [])];
    const approved = tested.outcome === "passed" && new Set(independentSessions).size === independentSessions.length
      && reviewed?.reports.every((r: any) => r.vote !== "approve" || !r.finding_ids.length)
      && reviewed?.reports.filter((r: any) => r.vote === "approve").length >= policy.review_approvals && dismissed;
    const canRevise = !tested.model_failure || (tested.model_failure.outcome === "output_truncated"
      && typeof proposed.retry_strategy === "string" && proposed.retry_strategy.trim().length > 0);
    result = { ...reference(), candidate: tested.candidate, action: proposed.verdict === "revise" && canRevise ? "revise" : proposed.verdict === "accept" && approved ? "publish" : "pause",
      // Keep full reviewer findings and Judger dispositions in their immutable
      // artifacts; the next fresh-context plan needs only unresolved concerns.
      reason: proposed.reason, feedback: { tests: tested.test_summaries, findings: findings.filter((f: { id: string }) => !isDismissed(f)),
        retry_strategy: proposed.retry_strategy ?? null, ...(tested.proposal_error ? { proposal_error: tested.proposal_error } : {}),
        ...(tested.model_failure ? { model_failure: tested.model_failure,
          previous_plan: read("freeze_plan").plan, previous_plan_sha256: read("freeze_plan").plan_sha256 } : {}) }, dispositions };
    result = recordProgress(result, { phase: "candidate", outcome: tested.outcome,
      checks: tested.tests.map((t: any) => ({ id: t.check_id, result: t.result,
        diagnostic: t.result === "passed" ? "" : tested.test_summaries.find((s: any) => s.check_id === t.check_id)?.log_tail ?? "" })),
      findings: result.feedback.findings.map((f: any) => f.message),
      detail: tested.proposal_error ?? tested.model_failure?.outcome ?? "" });
  } else if (stage === "publish" || stage === "ci") {
    if (!providers || providers.mode !== config.mode) throw new Error("publication/CI provider is not configured for this run mode");
    const decision = read("record_candidate_judgment");
    if (decision.action !== "publish") throw new Error("publication lacks trusted candidate judgment");
    const candidate = decision.candidate;
    if (stage === "publish") result = { ...reference(), candidate, publication: providers.publish(config, candidate, directory) };
    else {
      const publication = read("publish").publication; const { feedback, ...ci } = providers.ci(config, candidate, publication, directory);
      const conclusions = policy.required_ci_jobs.map(key => ci.jobs.find(j => j.key === key)?.conclusion);
      const known = sameE2eFixCandidate(ci.candidate, candidate) && publication.state === "open"
        && publication.observed_head === candidate.head && ci.observed_pr_head === candidate.head
        && ci.pr === publication.pr && ci.workflow_path === policy.ci_workflow_path
        && new Set(ci.jobs.map(j => j.key)).size === ci.jobs.length
        && ci.status === "completed" && conclusions.every(c => c === "success" || c === "failure");
      result = { ...reference(), candidate, ci, ci_feedback: feedback ?? null, review_reports: read("review_evidence").reports,
        candidate_judgment: decision, policy,
        outcome: !known ? "infrastructure_failure" : conclusions.every(c => c === "success") ? "ci_passed" : "code_failure" };
    }
  } else if (stage === "complete") {
    const candidate = read("capture").candidate; const fixer = read("fixer"); const reports = read("review_evidence").reports;
    const evidence = modelEvidence("judge_ci", one("judgment")); write("ci_judger", evidence);
    const judgment = { ...bound(candidate, evidence), dispatch_id: evidence.dispatch_id, session_id: evidence.session_id,
      verdict: evidence.value.verdict, review_artifact_sha256: reports.map((r: any) => r.artifact_sha256), dispositions: read("record_candidate_judgment").dispositions };
    // Strip rendering-only report fields before the strict shared gate.
    const reviews = reports.map(({ findings: _findings, summary: _summary, ...report }: any) => report);
    const acceptance = evaluateE2eFixAcceptance({ candidate, policy, fixer_dispatch_id: fixer.dispatch_id, fixer_session_id: fixer.session_id,
      tests: read("test").tests, reviews, judgment, publication: read("publish").publication, ci: read("ci").ci });
    result = { ...reference(), candidate, action: evidence.value.verdict === "revise" && read("ci").outcome === "code_failure" ? "revise" : acceptance.eligible ? "complete" : "pause",
      reason: evidence.value.reason, feedback: { ci: read("ci").ci, details: read("ci").ci_feedback }, acceptance, mode: config.mode, production_eligible: config.mode === "production" && acceptance.eligible };
    result = recordProgress(result, { phase: "ci", outcome: read("ci").outcome,
      checks: read("ci").ci.jobs.map((job: any) => ({ id: job.key, result: job.conclusion,
        diagnostic: job.conclusion === "success" ? "" : read("ci").ci_feedback?.logs?.find((log: any) => log.job === config.github?.job_names[job.key])?.tail ?? "" })),
      findings: [], detail: JSON.stringify((read("ci").ci_feedback?.logs ?? []).map((log: any) => ({ job: log.job ?? "", tail: log.tail ?? "" }))) });
  } else throw new Error("unknown E2E Fix stage");
  if (Buffer.byteLength(JSON.stringify(result)) > config.context_bytes) throw new Error("stage output exceeds frozen context bound");
  write(stage, result);
  immutableE2eFixFile(path.join(folder, "executions", `${stage}.json`), JSON.stringify({ execution_id: commandId, identity, policy_sha256: policyDigest,
    runtime_sha256: process.env.HOMERAIL_E2E_FIX_RUNTIME_SHA256 ?? null, output_sha256: digest(result) }));
  return result;
}
