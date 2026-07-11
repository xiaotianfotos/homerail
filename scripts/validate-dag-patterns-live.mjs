#!/usr/bin/env node

import * as fs from "node:fs";

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
const timeoutMs = Number(option("--timeout-ms", "360000"));
const outputPath = option("--output", "");
const requestedPatterns = repeatedOption("--pattern");

if (!settingId) {
  console.error("Missing --setting-id or HOMERAIL_PATTERN_SETTING_ID.");
  process.exit(2);
}
if (!Number.isFinite(timeoutMs) || timeoutMs < 1_000) {
  console.error("--timeout-ms must be at least 1000.");
  process.exit(2);
}

async function request(path, init) {
  const response = await fetch(`${baseUrl}${path}`, init);
  const body = await response.json();
  if (!response.ok || body.success === false) {
    throw new Error(`${init?.method ?? "GET"} ${path}: ${body.error ?? body.message ?? `HTTP ${response.status}`}`);
  }
  return body.data;
}

function patternParameters(pattern) {
  const parameters = {
    workflow_id: `live-${pattern.id}`,
    name: `Live ${pattern.name} Validation`,
  };
  if (pattern.id === "budget-gate") parameters.budget_limit = 100;
  if (pattern.id === "quorum") parameters.threshold = 2;
  if (pattern.id === "ratchet") {
    parameters.target = 0;
    parameters.max_iterations = 2;
  }
  if (pattern.id === "compost") parameters.max_proposals = 3;
  return parameters;
}

const prompts = {
  heartbeat: "Use only this synthetic signal and do not inspect or modify the workspace: input value is 2. Classify it actionable and preserve the value in the handoff. The conductor must order exactly one action: multiply the value by 2, with done_when output.value equals 4. The worker returns top-level status success, value 4, and evidence 2 * 2 = 4. The verifier must return top-level verdict pass when value is exactly 4 with that evidence. Use structured object handoffs and declared ports.",
  "orchestrator-workers": "Use only this synthetic record and do not inspect or modify the workspace: {\"id\":\"sample-1\",\"count\":2,\"status\":\"ready\"}. Split it into exactly three independent, self-contained checks: id equals sample-1, count equals 2, and status equals ready. The indexed plan must tell every worker not to use builtin tools. Every worker returns top-level status success with evidence, then verify the aggregate.",
  "budget-gate": "Projected usage is 1 unit against a budget limit of 100. Return status within_budget, execute one bounded check, and audit it.",
  "trust-ledger": "The validation skill has 20 runs and 20 passes. Assign tier auto, execute one check, verify it, and preserve the measured evidence.",
  "standing-goal-sentinel": "Load exactly this JSON array and do not add descriptions: [{\"id\":\"goal-a\",\"predicate\":true},{\"id\":\"goal-b\",\"predicate\":true}]. Treat each predicate as an already evaluated literal boolean. Do not inspect the workspace or use tools.",
  quorum: "Preserve this concrete evidence: health_check=passed, regression_count=0, risk=low. Each independent voter should return top-level vote act with evidence. Continue only after the configured quorum.",
  sparring: "Use this self-contained synthetic case only and do not inspect or modify the workspace: input 1+1, broken output 3, expected output 2. Breaker returns the challenge, builder returns repaired output 2, and fresh verifier returns top-level verdict pass with evidence.",
  ratchet: "Use an in-memory synthetic metric only; do not inspect or modify the workspace. The baseline measurer must return current top-level metric 2 unchanged and stop; it must not simulate improvements. Each later improver returns metric reduced by exactly 1 until target 0.",
  compost: "Use only these two synthetic repeated failures and do not inspect the workspace: missing top-level verdict twice; missing bounded retry twice. Propose no more than three grounded improvements with top-level status proposed. The terminal reviewer must hand off exactly one object whose top-level key is status with literal value awaiting_human_review, plus proposals and no approval decision; do not use a synonym or nest the status.",
};

const semanticRequirements = {
  heartbeat: [{ node: "signal_gate", port: "act" }, { node: "verdict_gate", port: "passed" }],
  "orchestrator-workers": [{ node: "join", port: "passed" }],
  "budget-gate": [{ node: "budget_gate", port: "admit" }],
  "trust-ledger": [{ node: "tier_gate", port: "ship" }],
  "standing-goal-sentinel": [
    { node: "goal_loop", port: "next_goal", minimum: 2 },
    { node: "goal_loop", port: "done" },
  ],
  quorum: [{ node: "quorum", port: "act" }],
  sparring: [{ node: "verdict_gate", port: "passed" }],
  ratchet: [{ node: "target_gate", port: "improve" }, { node: "target_gate", port: "reached" }],
  compost: [{ node: "proposal_gate", port: "review" }, { node: "human_review", port: "done" }],
};

function handoffNode(handoff) {
  return handoff.fromNode ?? handoff.from_node;
}

function parseContent(content) {
  if (typeof content !== "string") return content;
  const trimmed = content.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return content;
  try {
    return JSON.parse(trimmed);
  } catch {
    return content;
  }
}

function matchingHandoffs(handoffs, node, port) {
  return handoffs.filter((handoff) => handoffNode(handoff) === node && handoff.port === port);
}

function preservesHumanReviewBoundary(value) {
  if (typeof value !== "object" || value === null) return false;
  const forbidden = new Set(["approved", "rejected", "signed", "applied"]);
  const proposals = Array.isArray(value.proposals) ? value.proposals : [];
  const statuses = [value.status, value.decision, value.approval, value.outcome]
    .concat(proposals.map((proposal) =>
      typeof proposal === "object" && proposal !== null ? proposal.status : undefined
    ))
    .filter((status) => typeof status === "string")
    .map((status) => status.toLowerCase());
  if (statuses.some((status) => forbidden.has(status))) return false;
  if (value.status === "awaiting_human_review") return true;
  return value.review_boundary === "human_review"
    && proposals.length > 0
    && proposals.every((proposal) =>
      typeof proposal === "object" && proposal !== null && proposal.status === "awaiting_human_review"
    );
}

function semanticFailures(patternId, handoffs) {
  const failures = [];
  for (const requirement of semanticRequirements[patternId]) {
    const actual = matchingHandoffs(handoffs, requirement.node, requirement.port).length;
    const minimum = requirement.minimum ?? 1;
    if (actual < minimum) {
      failures.push(`expected ${requirement.node}:${requirement.port} at least ${minimum} time(s), observed ${actual}`);
    }
  }

  if (patternId === "standing-goal-sentinel") {
    const done = matchingHandoffs(handoffs, "goal_loop", "done").at(-1);
    const results = parseContent(done?.content)?.results;
    if (!Array.isArray(results) || results.length !== 2) {
      failures.push(`standing goal result aggregation expected 2 results, observed ${Array.isArray(results) ? results.length : 0}`);
    }
  }
  if (patternId === "quorum") {
    const aggregate = parseContent(matchingHandoffs(handoffs, "quorum", "act").at(-1)?.content);
    if (typeof aggregate !== "object" || aggregate === null || aggregate.successes < 2) {
      failures.push("quorum aggregate did not contain at least two passing votes");
    }
  }
  if (patternId === "ratchet") {
    const reached = parseContent(matchingHandoffs(handoffs, "target_gate", "reached").at(-1)?.content);
    const measurement = parseContent(reached?.input);
    if (typeof measurement !== "object" || measurement === null || typeof measurement.metric !== "number" || measurement.metric > 0) {
      failures.push("ratchet did not reach a top-level metric at or below target 0");
    }
  }
  if (patternId === "compost") {
    const review = parseContent(matchingHandoffs(handoffs, "human_review", "done").at(-1)?.content);
    if (!preservesHumanReviewBoundary(review)) {
      failures.push("compost terminal did not preserve the awaiting_human_review boundary");
    }
  }
  return failures;
}

function profileYaml(workflowId) {
  return [
    `profile_id: ${profileId}`,
    `workflow_id: ${workflowId}`,
    "description: Live model-backed DAG pattern validation.",
    "default:",
    `  llm_setting_id: ${settingId}`,
    "  agent_type: claude-sdk",
    "",
  ].join("\n");
}

async function preparePattern(pattern) {
  const parameters = patternParameters(pattern);
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
  return parameters.workflow_id;
}

async function waitForTerminal(runId, patternId) {
  const deadline = Date.now() + timeoutMs;
  let nextProgress = 0;
  while (Date.now() < deadline) {
    const status = await request(`/api/runs/${encodeURIComponent(runId)}/status`);
    if (["completed", "failed", "cancelled"].includes(status.status)) return status;
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
  const agentNodes = dag.graph.nodes.filter((node) => node.node_type === "agent");
  const observed = [];
  for (const node of agentNodes) {
    const chat = await request(`/api/dag-status/${encodeURIComponent(runId)}/node/${encodeURIComponent(node.node_id)}/chat`);
    const prompt = chat.messages.find((message) => message.role === "manager" && message.type === "prompt");
    const config = prompt?.content?.agentConfig;
    if (!config) continue;
    observed.push({
      node_id: node.node_id,
      setting_id: config.llm_setting_id,
      model: config.llm?.model,
      provider: config.llm?.provider,
      agent_type: config.agent_type,
    });
  }
  return observed;
}

async function runPattern(pattern) {
  const workflowId = await preparePattern(pattern);
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
  const status = await waitForTerminal(runId, pattern.id);
  const handoffData = await request(`/api/runs/${encodeURIComponent(runId)}/handoffs`);
  const handoffs = handoffData.handoffs ?? [];
  const evidence = await modelEvidence(runId);
  const evaluation = await request(`/api/runs/${encodeURIComponent(runId)}/eval-run`);
  const wrongModels = evidence.filter((item) =>
    item.setting_id !== settingId || (expectedModel && item.model !== expectedModel),
  );
  const failures = semanticFailures(pattern.id, handoffs);
  if (status.status !== "completed") failures.push(`terminal status ${status.status}`);
  if (handoffs.length === 0) failures.push("no handoffs");
  if (evidence.length === 0) failures.push("no model dispatch evidence");
  if (wrongModels.length > 0) failures.push(`wrong model evidence on: ${wrongModels.map((item) => item.node_id).join(", ")}`);
  if (evaluation.verdict !== "pass") failures.push(`eval verdict ${evaluation.verdict ?? "missing"}`);
  if ((evaluation.artifact_contracts?.empty_handoff_count ?? 0) > 0) failures.push("eval reported empty handoffs");
  if ((evaluation.artifact_contracts?.auto_handoff_count ?? 0) > 0) failures.push("eval reported automatic handoffs");
  if ((evaluation.dag_health?.failed_nodes ?? []).length > 0) failures.push("eval reported failed nodes");
  return {
    pattern_id: pattern.id,
    workflow_id: workflowId,
    run_id: runId,
    status: status.status,
    handoff_count: handoffs.length,
    semantic_handoffs: semanticRequirements[pattern.id].map((requirement) => ({
      node: requirement.node,
      port: requirement.port,
      count: matchingHandoffs(handoffs, requirement.node, requirement.port).length,
      last_content: parseContent(matchingHandoffs(handoffs, requirement.node, requirement.port).at(-1)?.content),
    })),
    model_evidence: evidence,
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
const selected = catalog.patterns.filter((pattern) =>
  requestedPatterns.length === 0 || requestedPatterns.includes(pattern.id),
);
if (selected.length === 0) {
  console.error("No matching DAG patterns.");
  process.exit(2);
}

const results = [];
for (const pattern of selected) {
  try {
    const result = await runPattern(pattern);
    results.push(result);
    console.log(`${pattern.id}: ${result.passed ? "PASS" : "FAIL"}`);
  } catch (error) {
    results.push({
      pattern_id: pattern.id,
      passed: false,
      failures: [error instanceof Error ? error.message : String(error)],
    });
    console.error(`${pattern.id}: FAIL ${results.at(-1).failures[0]}`);
  }
}

const report = {
  generated_at: new Date().toISOString(),
  manager_url: baseUrl,
  setting_id: settingId,
  expected_model: expectedModel || null,
  passed: results.every((result) => result.passed),
  results,
};
if (outputPath) fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(JSON.stringify(report, null, 2));
if (!report.passed) process.exitCode = 1;
