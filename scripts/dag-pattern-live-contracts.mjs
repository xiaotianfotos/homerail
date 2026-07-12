export const EXPECTED_PATTERN_IDS = [
  "heartbeat",
  "orchestrator-workers",
  "executor-advisor",
  "budget-gate",
  "trust-ledger",
  "standing-goal-sentinel",
  "quorum",
  "sparring",
  "ratchet",
  "compost",
];

function workflowSuffix(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9.-]+/g, "-")
    .replace(/^[.-]+|[.-]+$/g, "")
    .slice(0, 48)
    .replace(/[.-]+$/g, "");
}

export function patternParameters(pattern, runSuffix = "") {
  const suffix = workflowSuffix(runSuffix);
  const parameters = {
    workflow_id: `live-${pattern.id}${suffix ? `-${suffix}` : ""}`,
    name: `Live ${pattern.name} Validation`,
  };
  if (pattern.id === "orchestrator-workers") {
    parameters.max_workers = 3;
    parameters.max_parallelism = 2;
  }
  if (pattern.id === "executor-advisor") parameters.max_advisor_calls = 1;
  if (pattern.id === "budget-gate") parameters.budget_limit = 100;
  if (pattern.id === "standing-goal-sentinel") parameters.max_goals = 2;
  if (pattern.id === "quorum") parameters.threshold = 2;
  if (pattern.id === "ratchet") {
    parameters.target = 0;
    parameters.max_iterations = 2;
  }
  if (pattern.id === "compost") {
    parameters.max_proposals = 2;
    parameters.authorized_actor = "live-validator";
  }
  return parameters;
}

const passCommand = ["node", "-e", "process.exit(0)"];
const sparringTestCommand = [
  "bash",
  "-c",
  "test \"$(cat tests/sparring/live.txt)\" = '1+1 must equal 2' && test \"$(cat src/live-fix.txt)\" = '2'",
];

export const prompts = {
  heartbeat: JSON.stringify({
    signal: { value: 2, status: "actionable" },
    instruction: "Select one bounded synthetic action and preserve the exact check_command in the conductor work order.",
    check_command: passCommand,
  }),
  "orchestrator-workers": "Topology-only validation. Do not inspect files, shell, network, or external systems. Create exactly three execution work_items and no verifier/reviewer item: check id equals sample-1, count equals 2, and status equals ready for the record {id:sample-1,count:2,status:ready}. Give every item concrete acceptance_criteria. Every worker must report top-level status using exactly success or failed plus top-level evidence; never use pass/fail as status values. The existing downstream verifier confirms all three results and hands off verified.",
  "executor-advisor": "Use the declared advisor_id expert exactly once to decide whether signed audit records should use canonical JSON or ordinary JSON. Continue in the same executor turn after advice and hand off done with consulted_advisor=true, advisor_id=expert, a decision, and two constraints.",
  "budget-gate": JSON.stringify({ task: "Immediately hand off completed with exactly {usage:1,evidence:'synthetic bounded check completed'}. Do not call any other tool.", expected_usage: 1 }),
  "trust-ledger": JSON.stringify({
    skill_id: "live-validation",
    task: "Return a completed result with top-level evidence exactly equal to synthetic bounded check completed.",
    acceptance_criteria: ["top-level evidence equals synthetic bounded check completed"],
  }),
  "standing-goal-sentinel": "Run the two Manager-owned standing goal commands exactly as stored. No model node is required.",
  quorum: "Preserve this evidence: health_check=passed, regression_count=0, risk=low. Each voter independently hands off top-level vote=act with evidence. Do not inspect other votes.",
  sparring: `SMOKE CONTRACT. The exact test_command is ${JSON.stringify(sparringTestCommand)}. Breaker: use exactly one Write call to create tests/sparring/live.txt containing exactly '1+1 must equal 2', then immediately hand off challenge with artifact_path, that exact test_command array, and evidence; no Bash, Read, scaffolding, package files, or extra writes. Builder: use exactly one Write call to create src/live-fix.txt containing exactly '2', never modify tests/sparring/live.txt, then immediately hand off repaired with that exact test_command array and evidence. Verifier: read only those two files and immediately hand off verdict with top-level verdict=pass and evidence. Do nothing else.`,
  ratchet: JSON.stringify({
    objective: "Reduce a deterministic synthetic metric from 2 to 0.",
    measure_command: [
      "node",
      "-e",
      "const fs=require('fs'),p=require('path').join(process.env.HOMERAIL_HOME,'live-ratchet.metric');let n=fs.existsSync(p)?Number(fs.readFileSync(p,'utf8')):3;n=Math.max(0,n-1);fs.writeFileSync(p,String(n));console.log(n)",
    ],
    rollback_command: ["node", "-e", "process.exit(0)"],
  }),
  compost: JSON.stringify({
    incidents: [
      { id: "inc-1", failure: "missing top-level verdict twice" },
      { id: "inc-2", failure: "missing bounded retry twice" },
    ],
    instruction: "Produce exactly two grounded proposals. Never approve or apply them.",
  }),
};

export const semanticRequirements = {
  heartbeat: [
    { node: "signal_gate", port: "act" },
    { node: "verdict_gate", port: "check" },
    { node: "deterministic_check", port: "passed" },
  ],
  "orchestrator-workers": [
    { node: "fanout", port: "passed" },
    { node: "verify", port: "verified" },
  ],
  "executor-advisor": [{ node: "execute", port: "done" }],
  "budget-gate": [
    { node: "budget_gate", port: "admit" },
    { node: "execute", port: "completed" },
  ],
  "trust-ledger": [
    { node: "update_trust", port: "updated" },
    { node: "tier_gate", port: "auto" },
  ],
  "standing-goal-sentinel": [
    { node: "goal_loop", port: "next_goal", minimum: 2 },
    { node: "goal_loop", port: "done" },
    { node: "audit_results", port: "passed" },
    { node: "record_pass", port: "recorded" },
  ],
  quorum: [{ node: "quorum", port: "act" }],
  sparring: [{ node: "verdict_gate", port: "passed" }],
  ratchet: [
    { node: "target_gate", port: "improve", minimum: 2 },
    { node: "compare_measurements", port: "ready", minimum: 2 },
    { node: "monotonic_gate", port: "passed", minimum: 2 },
    { node: "target_gate", port: "reached" },
    { node: "enroll_floor", port: "enrolled" },
  ],
  compost: [
    { node: "proposal_gate", port: "review" },
    { node: "human_review", port: "approved" },
  ],
};

export function handoffNode(handoff) {
  return handoff.fromNode ?? handoff.from_node;
}

export function parseContent(content) {
  if (typeof content !== "string") return content;
  const trimmed = content.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return content;
  try {
    return JSON.parse(trimmed);
  } catch {
    return content;
  }
}

export function matchingHandoffs(handoffs, node, port) {
  return handoffs.filter((handoff) => handoffNode(handoff) === node && handoff.port === port);
}

function objectValue(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value : undefined;
}

export function semanticFailures(patternId, handoffs, context = {}) {
  const failures = [];
  const requirements = semanticRequirements[patternId];
  if (!requirements) return [`no semantic contract registered for ${patternId}`];
  for (const requirement of requirements) {
    const actual = matchingHandoffs(handoffs, requirement.node, requirement.port).length;
    const minimum = requirement.minimum ?? 1;
    if (actual < minimum) {
      failures.push(`expected ${requirement.node}:${requirement.port} at least ${minimum} time(s), observed ${actual}`);
    }
  }

  if (patternId === "orchestrator-workers") {
    const aggregate = objectValue(parseContent(matchingHandoffs(handoffs, "fanout", "passed").at(-1)?.content));
    if (aggregate?.total !== 3 || aggregate?.successes !== 3 || aggregate?.failures !== 0) {
      failures.push("dynamic fan-out did not complete exactly three successful worker items");
    }
  }
  if (patternId === "executor-advisor") {
    if (context.advisor_calls !== 1) failures.push(`expected exactly one advisor call, observed ${context.advisor_calls ?? 0}`);
    if (context.advisor_model_ok !== true) failures.push("advisor model evidence was missing or mismatched");
    if (context.advisor_key_redacted !== true) failures.push("advisor API key was not redacted in Manager chat evidence");
  }
  if (patternId === "budget-gate") {
    const state = objectValue(context.state_record)?.value;
    if (state !== 2) failures.push(`budget ledger did not atomically reserve expected usage: ${String(state)}`);
  }
  if (patternId === "trust-ledger") {
    const value = objectValue(objectValue(context.state_record)?.value);
    if (value?.runs !== 20 || value?.passes !== 20 || value?.tier !== "auto") {
      failures.push("trust ledger did not atomically promote the seeded skill to auto");
    }
  }
  if (patternId === "standing-goal-sentinel") {
    const done = objectValue(parseContent(matchingHandoffs(handoffs, "goal_loop", "done").at(-1)?.content));
    if (!Array.isArray(done?.results) || done.results.length !== 2) {
      failures.push(`standing goal aggregation expected 2 results, observed ${Array.isArray(done?.results) ? done.results.length : 0}`);
    }
    if (!Array.isArray(objectValue(context.state_record)?.value) || context.state_record.value.length !== 2) {
      failures.push("standing goal result ledger did not persist two results");
    }
  }
  if (patternId === "quorum") {
    const aggregate = objectValue(parseContent(matchingHandoffs(handoffs, "quorum", "act").at(-1)?.content));
    if (typeof aggregate?.successes !== "number" || aggregate.successes < 2) {
      failures.push("quorum aggregate did not contain at least two passing votes");
    }
  }
  if (patternId === "ratchet") {
    const reached = objectValue(parseContent(matchingHandoffs(handoffs, "target_gate", "reached").at(-1)?.content));
    const reachedInput = objectValue(reached?.input);
    if (typeof reachedInput?.value !== "number" || reachedInput.value > 0) failures.push("ratchet did not independently measure target 0");
    const comparisonPairs = matchingHandoffs(handoffs, "compare_measurements", "ready").map((handoff) => {
      const values = objectValue(parseContent(handoff.content))?.values;
      if (!Array.isArray(values)) return [];
      const previous = values.find((value) =>
        objectValue(value)?.ok === true && Number.isInteger(objectValue(objectValue(value)?.input)?.iteration));
      const current = values.find((value) =>
        objectValue(value)?.ok === true && Array.isArray(objectValue(objectValue(value)?.input)?.measure_command));
      return [objectValue(previous)?.value, objectValue(current)?.value];
    });
    if (JSON.stringify(comparisonPairs) !== JSON.stringify([[2, 1], [1, 0]])) {
      failures.push(`ratchet adjacent comparison sequence expected 2>1,1>0, observed ${JSON.stringify(comparisonPairs)}`);
    }
    const measuredValues = matchingHandoffs(handoffs, "monotonic_gate", "passed")
      .map((handoff) => objectValue(parseContent(handoff.content))?.value);
    if (measuredValues.length !== 2 || measuredValues[0] !== 1 || measuredValues[1] !== 0) {
      failures.push(`ratchet measured sequence expected 1,0, observed ${measuredValues.join(",")}`);
    }
    if (objectValue(context.state_record)?.value !== 0) failures.push("ratchet did not enroll target 0 as a standing floor");
  }
  if (patternId === "compost") {
    const approval = objectValue(context.approval);
    if (approval?.status !== "approved" || approval?.actor !== "live-validator" || !approval?.proposal_hash) {
      failures.push("compost approval was not authorized against the persisted proposal hash");
    }
  }
  return failures;
}

export function catalogCoverageFailures(patterns) {
  const ids = new Set(patterns.map((pattern) => pattern.id));
  const failures = [];
  for (const id of EXPECTED_PATTERN_IDS) {
    if (!ids.has(id)) failures.push(`catalog missing ${id}`);
    if (!prompts[id]) failures.push(`prompt missing ${id}`);
    if (!semanticRequirements[id]) failures.push(`semantic requirements missing ${id}`);
  }
  for (const id of ids) {
    if (!EXPECTED_PATTERN_IDS.includes(id)) failures.push(`unexpected catalog pattern ${id}`);
  }
  return failures;
}
