#!/usr/bin/env node

import * as fs from "node:fs";
import * as path from "node:path";

import {
  catalogCoverageFailures,
  diagnosticFailureHandoffs,
  matchingHandoffs,
  parseContent,
  patternParameters,
  prompts,
  semanticFailures,
  semanticRequirements,
} from "./dag-pattern-live-contracts.mjs";

const args = process.argv.slice(2);

function option(name, fallback) {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
}

function repeatedOption(name) {
  const values = [];
  for (let index = 0; index < args.length; index++) {
    if (args[index] === name && args[index + 1]) values.push(args[index + 1]);
  }
  return values;
}

const baseUrl = option("--base-url", process.env.HOMERAIL_MANAGER_URL ?? "http://127.0.0.1:19191").replace(/\/+$/, "");
const settingId = option("--setting-id", process.env.HOMERAIL_PATTERN_SETTING_ID);
const expectedModel = option("--expected-model", process.env.HOMERAIL_PATTERN_EXPECTED_MODEL ?? "");
const profileId = option("--profile-id", "live-pattern-validation");
const workflowSuffix = option("--workflow-suffix", process.env.HOMERAIL_LIVE_WORKFLOW_SUFFIX ?? "");
const timeoutMs = Number(option("--timeout-ms", "360000"));
const maxAttempts = Number(option("--max-attempts", process.env.HOMERAIL_LIVE_PATTERN_ATTEMPTS ?? "2"));
const outputPath = option("--output", "");
const requestedPatterns = repeatedOption("--pattern");
const approvalToken = process.env.HOMERAIL_DAG_APPROVAL_TOKEN ?? "";
const mutationToken = process.env.HOMERAIL_DAG_MUTATION_TOKEN ?? approvalToken;
const agentType = process.env.HOMERAIL_PATTERN_AGENT_TYPE ?? "claude-sdk";

if (!settingId) {
  console.error("Missing --setting-id or HOMERAIL_PATTERN_SETTING_ID.");
  process.exit(2);
}
if (!Number.isFinite(timeoutMs) || timeoutMs < 1_000) {
  console.error("--timeout-ms must be at least 1000.");
  process.exit(2);
}
if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 3) {
  console.error("--max-attempts must be an integer from 1 to 3.");
  process.exit(2);
}

async function request(pathname, init) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    ...init,
    headers: {
      ...(init?.headers ?? {}),
      ...(mutationToken && init?.method && init.method !== "GET"
        ? { "X-Homerail-Dag-Token": mutationToken }
        : {}),
    },
  });
  const body = await response.json();
  if (!response.ok || body.success === false) {
    throw new Error(`${init?.method ?? "GET"} ${pathname}: ${body.error ?? body.message ?? `HTTP ${response.status}`}`);
  }
  return body.data;
}

function profileYaml(workflowId) {
  return [
    `profile_id: ${profileId}`,
    `workflow_id: ${workflowId}`,
    "description: Live model-backed DAG pattern validation.",
    "default:",
    `  llm_setting_id: ${settingId}`,
    `  agent_type: ${agentType}`,
    "",
  ].join("\n");
}

async function setState(namespace, key, value) {
  return request(`/api/dag/state/${encodeURIComponent(namespace)}/${encodeURIComponent(key)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ value, ...(mutationToken ? { authorization_token: mutationToken } : {}) }),
  });
}

async function prepareRuntimeState(patternId) {
  if (patternId === "budget-gate") await setState("budget", "daily", 1);
  if (patternId === "trust-ledger") {
    await setState("trust", "live-validation", {
      runs: 19,
      passes: 19,
      rate: 1,
      tier: "queue",
      last_result: "pass",
    });
  }
  if (patternId === "standing-goal-sentinel") {
    await setState("standing-goals", "active", [
      { id: "goal-a", command: ["node", "-e", "process.exit(0)"] },
      { id: "goal-b", command: ["node", "-e", "process.exit(0)"] },
    ]);
  }
  if (patternId === "ratchet" && process.env.HOMERAIL_HOME) {
    fs.rmSync(path.join(process.env.HOMERAIL_HOME, "live-ratchet.metric"), { force: true });
  }
}

async function preparePattern(pattern, attempt) {
  const attemptSuffix = `${workflowSuffix.slice(0, 32) || "live"}-attempt-${attempt}`;
  const parameters = patternParameters(pattern, attemptSuffix);
  const instance = await request(`/api/dag/patterns/${encodeURIComponent(pattern.id)}/instantiate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ parameters }),
  });
  await request("/api/dag/workflows/sync", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ yaml_text: instance.yaml_text, source_path: `builtin:${pattern.id}` }),
  });
  await request("/api/dag/profiles/sync", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ yaml_text: profileYaml(parameters.workflow_id), source_path: "validation:live-patterns" }),
  });
  await prepareRuntimeState(pattern.id);
  return parameters.workflow_id;
}

async function decidePendingApproval(runId) {
  const data = await request("/api/dag/approvals");
  const approval = (data.approvals ?? []).find((item) => item.run_id === runId);
  if (!approval) return undefined;
  const headers = { "Content-Type": "application/json" };
  if (approvalToken) headers["x-homerail-approval-token"] = approvalToken;
  const result = await request(
    `/api/runs/${encodeURIComponent(runId)}/node/${encodeURIComponent(approval.node_id)}/approval`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({
        decision: "approved",
        actor: "live-validator",
        proposal_hash: approval.proposal_hash,
      }),
    },
  );
  return result.approval ?? result;
}

async function waitForTerminal(runId, patternId) {
  const deadline = Date.now() + timeoutMs;
  let nextProgress = 0;
  let approval;
  while (Date.now() < deadline) {
    const status = await request(`/api/runs/${encodeURIComponent(runId)}/status`);
    if (patternId === "compost" && !approval) approval = await decidePendingApproval(runId);
    if (["completed", "failed", "cancelled"].includes(status.status)) return { status, approval };
    if (Date.now() >= nextProgress) {
      console.log(`${patternId}: ${status.status}`);
      nextProgress = Date.now() + 10_000;
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  await request(`/api/runs/${encodeURIComponent(runId)}/cancel`, { method: "POST" }).catch(() => undefined);
  throw new Error(`Timed out after ${timeoutMs}ms`);
}

async function modelEvidence(runId) {
  const dag = await request(`/api/dag-status/${encodeURIComponent(runId)}`);
  const status = await request(`/api/runs/${encodeURIComponent(runId)}/status`);
  const nodeStates = status.node_states ?? {};
  const agentNodes = dag.graph.nodes.filter((node) => node.node_type === "agent");
  const executedAgentNodes = agentNodes.filter((node) =>
    ["COMPLETED", "FAILED"].includes(String(nodeStates[node.node_id] ?? "")),
  );
  const nodes = [];
  const advisors = [];
  let advisorCalls = 0;
  for (const node of agentNodes) {
    const chat = await request(`/api/dag-status/${encodeURIComponent(runId)}/node/${encodeURIComponent(node.node_id)}/chat`);
    const prompt = chat.messages.find((message) => message.role === "manager" && message.type === "prompt");
    const config = prompt?.content?.agentConfig;
    if (config) {
      nodes.push({
        node_id: node.node_id,
        setting_id: config.llm_setting_id,
        model: config.llm?.model,
        provider: config.llm?.provider,
        agent_type: config.agent_type,
        errors: chat.messages
          .filter((message) => message.type === "node_error" || message.content?.event === "agent_debug" && message.content?.message)
          .slice(-3)
          .map((message) => message.content?.message ?? message.content ?? message.data?.message ?? message.type),
      });
    }
    for (const advisor of prompt?.content?.advisors ?? []) {
      advisors.push({
        node_id: node.node_id,
        id: advisor.id,
        model: advisor.model,
        provider: advisor.provider,
        api_key_redacted: advisor.api_key === "***REDACTED***",
      });
    }
    advisorCalls += chat.messages.filter((message) => message.content?.event === "advisor_call_started").length;
  }
  return { expected_agent_nodes: executedAgentNodes.length, nodes, advisors, advisor_calls: advisorCalls };
}

async function runtimeEvidence(patternId, workflowId) {
  const key = {
    "budget-gate": ["budget", "daily"],
    "trust-ledger": ["trust", "live-validation"],
    "standing-goal-sentinel": ["standing-goal-runs", "active"],
    ratchet: ["standing-goal-floors", workflowId],
  }[patternId];
  if (!key) return undefined;
  try {
    const data = await request(`/api/dag/state/${encodeURIComponent(key[0])}/${encodeURIComponent(key[1])}`);
    return data.record;
  } catch (error) {
    if (error instanceof Error && error.message.includes("DAG state not found")) return undefined;
    throw error;
  }
}

async function runPattern(pattern, attempt) {
  const workflowId = await preparePattern(pattern, attempt);
  const created = await request("/api/runs/create-and-run", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      workflow_id: workflowId,
      profile: profileId,
      prompt: prompts[pattern.id],
    }),
  });
  const runId = created.run_id ?? created.runId;
  if (!runId) throw new Error("Manager did not return run_id");
  console.log(`${pattern.id}: run ${runId}`);
  const terminal = await waitForTerminal(runId, pattern.id);
  const handoffData = await request(`/api/runs/${encodeURIComponent(runId)}/handoffs`);
  const handoffs = handoffData.handoffs ?? [];
  const evidence = await modelEvidence(runId);
  const stateRecord = await runtimeEvidence(pattern.id, workflowId);
  const evaluation = await request(`/api/runs/${encodeURIComponent(runId)}/eval-run`);
  const wrongModels = evidence.nodes.filter((item) =>
    item.setting_id !== settingId || (expectedModel && item.model !== expectedModel),
  );
  const advisorModelOk = evidence.advisors.length === 1
    && evidence.advisors.every((item) => !expectedModel || item.model === expectedModel);
  const advisorKeyRedacted = evidence.advisors.length === 1
    && evidence.advisors.every((item) => item.api_key_redacted);
  const failures = semanticFailures(pattern.id, handoffs, {
    advisor_calls: evidence.advisor_calls,
    advisor_model_ok: advisorModelOk,
    advisor_key_redacted: advisorKeyRedacted,
    approval: terminal.approval,
    state_record: stateRecord,
  });
  if (terminal.status.status !== "completed") failures.push(`terminal status ${terminal.status.status}`);
  if (handoffs.length === 0) failures.push("no handoffs");
  if (evidence.expected_agent_nodes > 0 && evidence.nodes.length !== evidence.expected_agent_nodes) {
    failures.push(`model dispatch evidence expected ${evidence.expected_agent_nodes} node(s), observed ${evidence.nodes.length}`);
  }
  if (wrongModels.length > 0) failures.push(`wrong model evidence on: ${wrongModels.map((item) => item.node_id).join(", ")}`);
  const acceptableEvaluation = evaluation.verdict === "pass"
    || (evaluation.verdict === "pass_with_warnings"
      && (evaluation.worker_behavior?.hard_errors ?? 0) === 0
      && (evaluation.dag_health?.failed_nodes ?? []).length === 0);
  if (!acceptableEvaluation) failures.push(`eval verdict ${evaluation.verdict ?? "missing"}`);
  if ((evaluation.artifact_contracts?.empty_handoff_count ?? 0) > 0) failures.push("eval reported empty handoffs");
  if ((evaluation.artifact_contracts?.auto_handoff_count ?? 0) > 0) failures.push("eval reported automatic handoffs");
  if ((evaluation.dag_health?.failed_nodes ?? []).length > 0) failures.push("eval reported failed nodes");
  return {
    attempt,
    pattern_id: pattern.id,
    workflow_id: workflowId,
    run_id: runId,
    status: terminal.status.status,
    node_states: terminal.status.node_states ?? {},
    abort_reason: terminal.status.counters?.abort_reason ?? null,
    corrections: terminal.status.counters?.corrections ?? {},
    handoff_count: handoffs.length,
    handoff_ports: handoffs.map((handoff) => ({
      node: handoff.fromNode ?? handoff.from_node,
      port: handoff.port,
      content_keys: Object.keys(parseContent(handoff.content) ?? {}).slice(0, 20),
    })),
    diagnostic_failure_handoffs: diagnosticFailureHandoffs(handoffs),
    semantic_handoffs: semanticRequirements[pattern.id].map((requirement) => ({
      node: requirement.node,
      port: requirement.port,
      count: matchingHandoffs(handoffs, requirement.node, requirement.port).length,
      last_content: parseContent(matchingHandoffs(handoffs, requirement.node, requirement.port).at(-1)?.content),
    })),
    model_evidence: evidence,
    state_evidence: stateRecord ?? null,
    approval_evidence: terminal.approval ?? null,
    evaluation: {
      verdict: evaluation.verdict,
      failed_nodes: evaluation.dag_health?.failed_nodes ?? [],
      empty_handoff_count: evaluation.artifact_contracts?.empty_handoff_count ?? 0,
      auto_handoff_count: evaluation.artifact_contracts?.auto_handoff_count ?? 0,
    },
    passed: failures.length === 0,
    failures,
  };
}

const catalog = await request("/api/dag/patterns");
const coverageFailures = catalogCoverageFailures(catalog.patterns);
if (coverageFailures.length > 0) {
  console.error(`DAG pattern catalog contract failed: ${coverageFailures.join("; ")}`);
  process.exit(2);
}
const unknownPatterns = requestedPatterns.filter((id) => !catalog.patterns.some((pattern) => pattern.id === id));
if (unknownPatterns.length > 0) {
  console.error(`Unknown DAG patterns: ${unknownPatterns.join(", ")}`);
  process.exit(2);
}
const selected = catalog.patterns.filter((pattern) =>
  requestedPatterns.length === 0 || requestedPatterns.includes(pattern.id),
);
if (selected.length === 0) {
  console.error("No matching DAG patterns.");
  process.exit(2);
}

const results = [];
for (const pattern of selected) {
  const attempts = [];
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    let result;
    try {
      result = await runPattern(pattern, attempt);
    } catch (error) {
      result = {
        attempt,
        pattern_id: pattern.id,
        passed: false,
        failures: [error instanceof Error ? error.message : String(error)],
      };
    }
    attempts.push(result);
    console.log(`${pattern.id}: attempt ${attempt}/${maxAttempts} ${result.passed ? "PASS" : "FAIL"}`);
    if (result.passed) break;
  }
  const final = attempts.at(-1);
  results.push({
    ...final,
    attempt_count: attempts.length,
    attempts: attempts.map((attempt) => ({
      attempt: attempt.attempt,
      workflow_id: attempt.workflow_id,
      run_id: attempt.run_id,
      status: attempt.status,
      passed: attempt.passed,
      failures: attempt.failures,
      corrections: attempt.corrections,
      node_states: attempt.node_states,
      evaluation: attempt.evaluation,
    })),
  });
}

const report = {
  generated_at: new Date().toISOString(),
  manager_url: baseUrl,
  setting_id: settingId,
  expected_model: expectedModel || null,
  workflow_suffix: workflowSuffix || null,
  max_attempts: maxAttempts,
  catalog_contract: { passed: true, pattern_count: catalog.patterns.length },
  passed: results.every((result) => result.passed),
  results,
};
if (outputPath) fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(JSON.stringify(report, null, 2));
if (!report.passed) process.exitCode = 1;
