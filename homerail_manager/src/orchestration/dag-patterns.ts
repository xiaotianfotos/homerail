import YAML from "yaml";

import { assertGraphValid, validateGraph, type GraphValidationResult } from "./graph-validator.js";
import type { ParsedDAG } from "./graph.js";
import { parseDAGYaml } from "./yaml-loader.js";

export const DAG_PATTERN_SOURCE = {
  title: "How to Build An Agentic OS using Fable 5 (Builder's Guide)",
  author: "Avid (@Av1dlive)",
  url: "https://x.com/i/status/2074169173178212621",
  relationship: "inspiration",
} as const;

export type DAGPatternParameterType = "string" | "number" | "boolean";

export interface DAGPatternParameter {
  type: DAGPatternParameterType;
  description: string;
  default: string | number | boolean;
  minimum?: number;
  maximum?: number;
  integer?: boolean;
  values?: Array<string | number | boolean>;
}

export interface DAGPatternRole {
  id: string;
  responsibility: string;
}

export interface DAGPatternDefinition {
  id: string;
  version: string;
  name: string;
  summary: string;
  intent: string;
  roles: DAGPatternRole[];
  typical_uses: string[];
  avoid_when: string[];
  required_primitives: string[];
  parameters: Record<string, DAGPatternParameter>;
  source: typeof DAG_PATTERN_SOURCE;
  workflow_template: Record<string, unknown>;
}

export interface DAGPatternSummary extends Omit<DAGPatternDefinition, "workflow_template"> {
  node_count: number;
}

export interface InstantiatedDAGPattern {
  pattern: DAGPatternDefinition;
  parameters: Record<string, string | number | boolean>;
  workflow: Record<string, unknown>;
  yaml_text: string;
  parsed: ParsedDAG;
  validation: GraphValidationResult;
}

const identityParameters = (id: string, name: string): Record<string, DAGPatternParameter> => ({
  workflow_id: {
    type: "string",
    description: "Stable workflow identity used when syncing the instance.",
    default: `pattern-${id}`,
  },
  name: {
    type: "string",
    description: "Display name for the instantiated workflow.",
    default: name,
  },
});

const terminalNode = (agent: string, after: string): Record<string, unknown> => ({
  agent,
  after: [after],
  outputs: { done: { to: "" } },
});

const heartbeat: DAGPatternDefinition = {
  id: "heartbeat",
  version: "1.0.1",
  name: "Heartbeat",
  summary: "Triage one signal, route one actionable item, execute it, and independently verify the result.",
  intent: "Keep periodic autonomous work bounded by a quiet-path exit, a single selected action, and a separate verifier.",
  roles: [
    { id: "triage", responsibility: "Reduce raw signals to actionable or quiet status." },
    { id: "conductor", responsibility: "Select exactly one item and issue a bounded work order." },
    { id: "worker", responsibility: "Execute only the selected work order." },
    { id: "verifier", responsibility: "Judge the result against explicit completion criteria." },
  ],
  typical_uses: ["scheduled repository maintenance", "issue triage", "bounded operational automation"],
  avoid_when: ["the input cannot be classified reliably", "multiple actions must commit atomically"],
  required_primitives: ["condition_gateway", "success/failure routing", "independent agent roles"],
  parameters: identityParameters("heartbeat", "Heartbeat Pattern"),
  source: DAG_PATTERN_SOURCE,
  workflow_template: {
    name: "{{name}}",
    workflow_id: "{{workflow_id}}",
    description: "Heartbeat pattern: quiet exit, one bounded action, independent verification.",
    workspace: { mode: "isolated" },
    agents: {
      triage: { system: "Classify the supplied signals. Hand off JSON with status actionable or quiet and evidence." },
      conductor: { system: "Select exactly one highest-value actionable item. Emit a bounded work order with verifiable done_when criteria." },
      worker: { system: "Execute only the supplied work order. Return status success or failure with evidence." },
      verifier: {
        system: "Independently verify every done_when criterion. Hand off one JSON object with top-level verdict set to pass or fail and top-level evidence. Never nest verdict inside another object.",
      },
      reporter: { system: "Report the terminal outcome without claiming unverified work." },
    },
    nodes: {
      triage: { agent: "triage", outputs: { classified: { to: "signal_gate.in:signal" } } },
      signal_gate: {
        type: "condition_gateway",
        gateway_config: {
          field: "status",
          routes: { actionable: "act", quiet: "quiet" },
          default_port: "quiet",
        },
        after: ["triage"],
        outputs: {
          act: { to: "conduct.in:signal" },
          quiet: { to: "quiet.in:result" },
        },
      },
      conduct: { agent: "conductor", after: ["signal_gate"], outputs: { ordered: { to: "execute.in:order" } } },
      execute: { agent: "worker", after: ["conduct"], outputs: { completed: { to: "verify.in:result" } } },
      verify: { agent: "verifier", after: ["execute"], outputs: { verdict: { to: "verdict_gate.in:verdict" } } },
      verdict_gate: {
        type: "condition_gateway",
        gateway_config: { field: "verdict", routes: { pass: "passed", fail: "failed" }, default_port: "failed" },
        after: ["verify"],
        outputs: {
          passed: { to: "done.in:result" },
          failed: { to: "review.in:result" },
        },
      },
      quiet: terminalNode("reporter", "signal_gate"),
      done: terminalNode("reporter", "verdict_gate"),
      review: terminalNode("reporter", "verdict_gate"),
    },
  },
};

const orchestratorWorkers: DAGPatternDefinition = {
  id: "orchestrator-workers",
  version: "1.0.1",
  name: "Orchestrator and Workers",
  summary: "Separate planning from parallel execution, then aggregate and verify all worker results.",
  intent: "Give one planner ownership of decomposition while independent workers execute bounded parts in parallel.",
  roles: [
    { id: "orchestrator", responsibility: "Decompose the objective into non-overlapping work orders." },
    { id: "worker", responsibility: "Complete one work order and report structured status." },
    { id: "verifier", responsibility: "Verify the aggregate rather than trusting worker self-assessment." },
  ],
  typical_uses: ["parallel research", "multi-module implementation", "independent evidence collection"],
  avoid_when: ["workers must edit the same state concurrently", "the objective is too small to decompose"],
  required_primitives: ["fan-out edges", "join_gateway all mode", "independent verification"],
  parameters: identityParameters("orchestrator-workers", "Orchestrator and Workers Pattern"),
  source: DAG_PATTERN_SOURCE,
  workflow_template: {
    name: "{{name}}",
    workflow_id: "{{workflow_id}}",
    description: "Planner-led fan-out, deterministic all-result aggregation, and fresh verification.",
    workspace: { mode: "isolated" },
    agents: {
      orchestrator: { system: "Produce exactly three non-overlapping work orders with explicit acceptance criteria. Return one JSON object whose top-level work_orders object is keyed worker_one, worker_two, and worker_three; each value must be one self-contained work order. Finish with one handoff on planned so the same indexed plan can fan out to all workers." },
      worker: { system: "Input order is the shared indexed plan and may arrive as a JSON string. Parse it, identify the current DAG node id, and execute only work_orders[current_node_id]. Do not execute another worker's order or inspect unrelated workspace state. Finish by calling the handoff tool on result with one JSON object containing top-level status success or failure and top-level evidence." },
      verifier: { system: "Verify the combined worker evidence against the original objective." },
      reporter: { system: "Summarize the verified aggregate or the failed worker set." },
    },
    nodes: {
      plan: {
        agent: "orchestrator",
        outputs: {
          planned: { to: ["worker_one.in:order", "worker_two.in:order", "worker_three.in:order"] },
        },
      },
      worker_one: { agent: "worker", after: ["plan"], outputs: { result: { to: "join.in:one" } } },
      worker_two: { agent: "worker", after: ["plan"], outputs: { result: { to: "join.in:two" } } },
      worker_three: { agent: "worker", after: ["plan"], outputs: { result: { to: "join.in:three" } } },
      join: {
        type: "join_gateway",
        gateway_config: { mode: "all", field: "status", success_values: ["success"] },
        after: ["worker_one", "worker_two", "worker_three"],
        outputs: {
          passed: { to: "verify.in:aggregate" },
          failed: { to: "review.in:aggregate" },
        },
      },
      verify: { agent: "verifier", after: ["join"], outputs: { verified: { to: "done.in:result" } } },
      done: terminalNode("reporter", "verify"),
      review: terminalNode("reporter", "join"),
    },
  },
};

const budgetGate: DAGPatternDefinition = {
  id: "budget-gate",
  version: "1.0.0",
  name: "Budget Gate",
  summary: "Measure expected or accumulated cost before execution and route over-budget work to a stop path.",
  intent: "Make budget approval an explicit routing decision before expensive work starts.",
  roles: [
    { id: "accountant", responsibility: "Calculate usage against the configured budget and emit a status." },
    { id: "worker", responsibility: "Execute only work admitted by the gate." },
    { id: "auditor", responsibility: "Record final usage and outcome." },
  ],
  typical_uses: ["metered model workflows", "bounded batch processing", "daily automation budgets"],
  avoid_when: ["usage cannot be measured", "the operation must run regardless of cost"],
  required_primitives: ["condition_gateway", "structured budget status", "terminal stop branch"],
  parameters: {
    ...identityParameters("budget-gate", "Budget Gate Pattern"),
    budget_limit: {
      type: "number",
      description: "Maximum budget admitted by the accounting role.",
      default: 5,
      minimum: 0,
    },
  },
  source: DAG_PATTERN_SOURCE,
  workflow_template: {
    name: "{{name}}",
    workflow_id: "{{workflow_id}}",
    description: "Explicit budget admission before execution.",
    workspace: { mode: "isolated" },
    agents: {
      accountant: { system: "Calculate current and projected usage. The budget limit is {{budget_limit}}. Return status within_budget or exceeded with evidence." },
      worker: { system: "Execute the admitted work and report measured usage." },
      auditor: { system: "Record the budget decision, measured usage, and terminal outcome." },
    },
    nodes: {
      assess_budget: { agent: "accountant", outputs: { assessed: { to: "budget_gate.in:assessment" } } },
      budget_gate: {
        type: "condition_gateway",
        gateway_config: {
          field: "status",
          routes: { within_budget: "admit", exceeded: "block" },
          default_port: "block",
        },
        after: ["assess_budget"],
        outputs: {
          admit: { to: "execute.in:budget" },
          block: { to: "blocked.in:budget" },
        },
      },
      execute: { agent: "worker", after: ["budget_gate"], outputs: { completed: { to: "audited.in:result" } } },
      audited: terminalNode("auditor", "execute"),
      blocked: terminalNode("auditor", "budget_gate"),
    },
  },
};

const trustLedger: DAGPatternDefinition = {
  id: "trust-ledger",
  version: "1.0.0",
  name: "Trust Ledger",
  summary: "Route each recurring skill according to measured pass history: auto, queue, or watch.",
  intent: "Grant autonomy per skill from evidence instead of assigning one global automation level.",
  roles: [
    { id: "assessor", responsibility: "Read the skill's run history and assign a trust tier." },
    { id: "worker", responsibility: "Produce a candidate result regardless of tier." },
    { id: "verifier", responsibility: "Emit the pass/fail evidence used to update trust." },
  ],
  typical_uses: ["recurring maintenance skills", "graduated autonomy", "automatic demotion after failures"],
  avoid_when: ["tasks do not repeat", "pass/fail cannot be measured consistently"],
  required_primitives: ["condition_gateway", "persistent external ledger", "per-skill identity"],
  parameters: identityParameters("trust-ledger", "Trust Ledger Pattern"),
  source: DAG_PATTERN_SOURCE,
  workflow_template: {
    name: "{{name}}",
    workflow_id: "{{workflow_id}}",
    description: "Per-skill evidence routes verified work to auto, queue, or watch outcomes.",
    workspace: { mode: "isolated" },
    agents: {
      assessor: { system: "Read the supplied skill history and return tier auto, queue, or watch with the measured rate." },
      worker: { system: "Execute the recurring skill and return evidence." },
      verifier: { system: "Independently grade the result and update the supplied trust ledger record. Return JSON with top-level tier (auto, queue, or watch), independent_grade, evidence, and ledger_update." },
      reporter: { system: "Report the resulting autonomy decision and evidence." },
    },
    nodes: {
      assess: { agent: "assessor", outputs: { tiered: { to: "execute.in:tier" } } },
      execute: { agent: "worker", after: ["assess"], outputs: { completed: { to: "verify.in:result" } } },
      verify: { agent: "verifier", after: ["execute"], outputs: { recorded: { to: "tier_gate.in:record" } } },
      tier_gate: {
        type: "condition_gateway",
        gateway_config: {
          field: "tier",
          routes: { auto: "ship", queue: "queue", watch: "watch" },
          default_port: "watch",
        },
        after: ["verify"],
        outputs: {
          ship: { to: "auto.in:result" },
          queue: { to: "queued.in:result" },
          watch: { to: "watched.in:result" },
        },
      },
      auto: terminalNode("reporter", "tier_gate"),
      queued: terminalNode("reporter", "tier_gate"),
      watched: terminalNode("reporter", "tier_gate"),
    },
  },
};

const standingGoalSentinel: DAGPatternDefinition = {
  id: "standing-goal-sentinel",
  version: "1.0.0",
  name: "Standing Goal Sentinel",
  summary: "Iterate over previously satisfied goals, re-run their predicates, and report violations.",
  intent: "Turn completed goals into continuously checked invariants instead of one-time claims.",
  roles: [
    { id: "loader", responsibility: "Load active goal predicates as a finite item list." },
    { id: "verifier", responsibility: "Evaluate one predicate and emit structured evidence." },
    { id: "reporter", responsibility: "Summarize all current violations without silently fixing them." },
  ],
  typical_uses: ["regression sentinels", "operational invariants", "periodic acceptance checks"],
  avoid_when: ["predicates mutate production state", "verification cannot finish within a bounded time"],
  required_primitives: ["loop_gateway", "structured item handoff", "persistent goal ledger"],
  parameters: identityParameters("standing-goal-sentinel", "Standing Goal Sentinel Pattern"),
  source: DAG_PATTERN_SOURCE,
  workflow_template: {
    name: "{{name}}",
    workflow_id: "{{workflow_id}}",
    description: "Finite re-verification of standing goals with a violation report.",
    workspace: { mode: "isolated" },
    agents: {
      loader: { system: "Load all active standing goals and hand off an array of predicate records." },
      verifier: { system: "Evaluate exactly one supplied goal predicate. A boolean predicate is already evaluated: return it directly without tools or workspace inspection. For command predicates, run only the supplied command. Return JSON with top-level result (pass or fail) and evidence; do not expand scope or auto-fix." },
      reporter: { system: "Summarize verified goals and violations, including likely changes since the last pass." },
    },
    nodes: {
      load_goals: { agent: "loader", outputs: { goals: { to: "goal_loop.in:items" } } },
      goal_loop: {
        type: "loop_gateway",
        gateway_config: { item_port: "next_goal", result_port: "result", done_port: "done" },
        after: ["load_goals"],
        outputs: {
          next_goal: { to: "verify_goal.in:goal" },
          done: { to: "report.in:summary" },
        },
      },
      verify_goal: {
        agent: "verifier",
        after: ["goal_loop"],
        outputs: { verified: { to: "goal_loop.in:result" } },
      },
      report: terminalNode("reporter", "goal_loop"),
    },
  },
};

const quorum: DAGPatternDefinition = {
  id: "quorum",
  version: "1.0.0",
  name: "Quorum",
  summary: "Collect independent votes and continue only when an n-of-m threshold is met.",
  intent: "Reduce false wake-ups or risky decisions by requiring independent agreement before expensive action.",
  roles: [
    { id: "signal", responsibility: "Provide one shared evidence bundle to all voters." },
    { id: "voter", responsibility: "Vote independently without seeing other votes." },
    { id: "conductor", responsibility: "Act only on a passing aggregate." },
  ],
  typical_uses: ["actionability filtering", "high-cost wake-up gates", "independent review consensus"],
  avoid_when: ["voters share the same failure mode", "latency matters more than decision confidence"],
  required_primitives: ["fan-out edges", "join_gateway n_of_m mode", "structured independent votes"],
  parameters: {
    ...identityParameters("quorum", "Quorum Pattern"),
    threshold: {
      type: "number",
      description: "Number of passing votes required out of three voters.",
      default: 2,
      minimum: 1,
      maximum: 3,
      integer: true,
    },
  },
  source: DAG_PATTERN_SOURCE,
  workflow_template: {
    name: "{{name}}",
    workflow_id: "{{workflow_id}}",
    description: "Three independent votes aggregated by a configurable n-of-m threshold.",
    workspace: { mode: "isolated" },
    agents: {
      signal: { system: "Collect and normalize the supplied evidence bundle without discarding concrete facts. Return JSON with top-level evidence and status; do not make the final decision." },
      voter: { system: "Evaluate the supplied evidence independently. Return JSON with top-level vote (act or stop) and evidence. Do not inspect or infer other voters' decisions." },
      conductor: { system: "Receive the quorum aggregate and create one bounded action." },
      reporter: { system: "Report the aggregate vote and why action did or did not proceed." },
    },
    nodes: {
      collect_signal: {
        agent: "signal",
        outputs: { collected: { to: ["voter_one.in:signal", "voter_two.in:signal", "voter_three.in:signal"] } },
      },
      voter_one: { agent: "voter", after: ["collect_signal"], outputs: { vote: { to: "quorum.in:one" } } },
      voter_two: { agent: "voter", after: ["collect_signal"], outputs: { vote: { to: "quorum.in:two" } } },
      voter_three: { agent: "voter", after: ["collect_signal"], outputs: { vote: { to: "quorum.in:three" } } },
      quorum: {
        type: "join_gateway",
        gateway_config: {
          mode: "n_of_m",
          threshold: "{{threshold}}",
          field: "vote",
          success_values: ["act"],
          passed_port: "act",
          failed_port: "stop",
        },
        after: ["voter_one", "voter_two", "voter_three"],
        outputs: {
          act: { to: "conduct.in:votes" },
          stop: { to: "stopped.in:votes" },
        },
      },
      conduct: { agent: "conductor", after: ["quorum"], outputs: { decided: { to: "acted.in:result" } } },
      acted: terminalNode("reporter", "conduct"),
      stopped: terminalNode("reporter", "quorum"),
    },
  },
};

const sparring: DAGPatternDefinition = {
  id: "sparring",
  version: "1.0.0",
  name: "Sparring",
  summary: "A breaker creates a concrete challenge, a builder addresses it, and a fresh verifier settles the result.",
  intent: "Separate adversarial discovery from repair so neither role grades its own output.",
  roles: [
    { id: "breaker", responsibility: "Produce one reproducible failing challenge without fixing it." },
    { id: "builder", responsibility: "Fix the implementation without weakening the challenge." },
    { id: "verifier", responsibility: "Judge the challenge and repair from fresh context." },
  ],
  typical_uses: ["regression test generation", "security review", "specification hardening"],
  avoid_when: ["the breaker cannot produce reproducible evidence", "the challenged surface is unsafe for autonomous edits"],
  required_primitives: ["sequential role isolation", "condition_gateway", "dispute terminal"],
  parameters: identityParameters("sparring", "Sparring Pattern"),
  source: DAG_PATTERN_SOURCE,
  workflow_template: {
    name: "{{name}}",
    workflow_id: "{{workflow_id}}",
    description: "Breaker, builder, and fresh verifier with an explicit dispute path.",
    workspace: { mode: "isolated" },
    agents: {
      breaker: { system: "Provide one reproducible failing challenge and JSON evidence. Do not fix it. If the task supplies a self-contained validation case, use it directly without tools or workspace inspection." },
      builder: { system: "Fix only the supplied challenge and return JSON evidence. Do not weaken or delete the check. For a self-contained validation case, return the corrected value without tools or workspace changes." },
      verifier: { system: "Run or evaluate the original challenge and acceptance checks from fresh context. For a self-contained validation case, compare the supplied values without tools or workspace inspection. Return JSON with top-level lowercase verdict (pass or fail) and evidence." },
      reporter: { system: "Report verified success or queue a concrete dispute for human review." },
    },
    nodes: {
      break: { agent: "breaker", outputs: { challenge: { to: "build.in:challenge" } } },
      build: { agent: "builder", after: ["break"], outputs: { repaired: { to: "verify.in:repair" } } },
      verify: { agent: "verifier", after: ["build"], outputs: { verdict: { to: "verdict_gate.in:verdict" } } },
      verdict_gate: {
        type: "condition_gateway",
        gateway_config: { field: "verdict", routes: { pass: "passed", fail: "disputed" }, default_port: "disputed" },
        after: ["verify"],
        outputs: {
          passed: { to: "done.in:result" },
          disputed: { to: "dispute.in:result" },
        },
      },
      done: terminalNode("reporter", "verdict_gate"),
      dispute: terminalNode("reporter", "verdict_gate"),
    },
  },
};

const ratchet: DAGPatternDefinition = {
  id: "ratchet",
  version: "1.0.1",
  name: "Ratchet",
  summary: "Repeat measured improvements until a target is reached or a bounded iteration limit is exhausted.",
  intent: "Make progress monotonic and bounded by checking the metric before every additional attempt.",
  roles: [
    { id: "measurer", responsibility: "Establish and report the current metric." },
    { id: "improver", responsibility: "Make one bounded change and re-measure without gaming the metric." },
    { id: "reporter", responsibility: "Record target achievement or bounded exhaustion." },
  ],
  typical_uses: ["warning reduction", "performance improvement", "coverage or quality targets"],
  avoid_when: ["the metric is noisy or gameable", "individual attempts cannot be reverted safely"],
  required_primitives: ["while_gateway", "comparison predicate", "edge retry limit"],
  parameters: {
    ...identityParameters("ratchet", "Ratchet Pattern"),
    target: {
      type: "number",
      description: "Metric value at or below which the goal is complete.",
      default: 0,
    },
    max_iterations: {
      type: "number",
      description: "Maximum improvement attempts before routing to exhaustion.",
      default: 3,
      minimum: 1,
      maximum: 100,
      integer: true,
    },
  },
  source: DAG_PATTERN_SOURCE,
  workflow_template: {
    name: "{{name}}",
    workflow_id: "{{workflow_id}}",
    description: "Measured bounded improvement until the configured target is reached.",
    workspace: { mode: "isolated" },
    agents: {
      measurer: { system: "Measure only the current objective metric without changing the system. If a starting metric N is supplied, return exactly that current value N. Do not plan, simulate, or perform any improvement; the improver owns all changes. Return JSON with top-level numeric metric and evidence, then hand off immediately." },
      improver: { system: "Read the previous top-level numeric metric and preserve the scope declared by the upstream evidence. If the input is synthetic or in-memory, transform only the supplied metric and never inspect or modify the workspace or call builtin tools. Otherwise make one bounded improvement within the declared scope. Return JSON with a strictly lower top-level numeric metric and evidence. Revert changes that worsen or preserve the metric; never claim the target without the numeric value." },
      reporter: { system: "Report target achievement or bounded exhaustion with the metric history." },
    },
    nodes: {
      baseline: { agent: "measurer", outputs: { measured: { to: "target_gate.in:measurement" } } },
      target_gate: {
        type: "while_gateway",
        gateway_config: {
          field: "metric",
          operator: "lte",
          value: "{{target}}",
          max_iterations: "{{max_iterations}}",
          continue_port: "improve",
          done_port: "reached",
          exhausted_port: "exhausted",
        },
        after: ["baseline"],
        outputs: {
          improve: { to: "improve.in:measurement" },
          reached: { to: "achieved.in:result" },
          exhausted: { to: "stopped.in:result" },
        },
      },
      improve: {
        agent: "improver",
        after: ["target_gate"],
        outputs: {
          measured: {
            to: "target_gate.in:measurement",
            retry_policy: { max_retries: "{{max_iterations}}" },
          },
        },
      },
      achieved: terminalNode("reporter", "target_gate"),
      stopped: terminalNode("reporter", "target_gate"),
    },
  },
};

const compost: DAGPatternDefinition = {
  id: "compost",
  version: "1.0.3",
  name: "Compost",
  summary: "Turn repeated failures into a small set of proposed laws, skill changes, or standing goals.",
  intent: "Let operational evidence improve the system while keeping policy changes behind explicit review.",
  roles: [
    { id: "collector", responsibility: "Collect recent failures and rejected work with evidence." },
    { id: "proposer", responsibility: "Produce a bounded set of system-improvement proposals." },
    { id: "reviewer", responsibility: "Present proposals for explicit human acceptance; never auto-apply policy." },
  ],
  typical_uses: ["weekly process review", "recurring failure analysis", "guardrail evolution"],
  avoid_when: ["there is too little evidence", "policy changes may be applied without human ownership"],
  required_primitives: ["condition_gateway", "bounded proposal contract", "human-review terminal"],
  parameters: {
    ...identityParameters("compost", "Compost Pattern"),
    max_proposals: {
      type: "number",
      description: "Maximum number of proposals emitted in one run.",
      default: 3,
      minimum: 1,
      maximum: 10,
      integer: true,
    },
  },
  source: DAG_PATTERN_SOURCE,
  workflow_template: {
    name: "{{name}}",
    workflow_id: "{{workflow_id}}",
    description: "Evidence-driven process proposals with an explicit human-review boundary.",
    workspace: { mode: "isolated" },
    agents: {
      collector: { system: "Collect recent failures, trust demotions, violated goals, and rejected changes with evidence." },
      proposer: { system: "Produce at most {{max_proposals}} proposals. Each must be a law, skill change, or standing goal grounded in incidents. Return exactly one JSON object with top-level status (proposed or no_change) and top-level proposals array. A status nested inside an individual proposal does not satisfy the contract." },
      reviewer: { system: "You are a review boundary, not the human decision maker. Present proposals for explicit human acceptance, then finish by calling the handoff tool on done with one JSON object. Prefer top-level status awaiting_human_review. An equivalent per-proposal form is allowed only when top-level review_boundary is human_review and every proposal has status awaiting_human_review. Include no approval decision. Never emit approved, rejected, signed, or applied status, and never simulate a human decision." },
    },
    nodes: {
      collect: { agent: "collector", outputs: { evidence: { to: "propose.in:evidence" } } },
      propose: { agent: "proposer", after: ["collect"], outputs: { recommendation: { to: "proposal_gate.in:recommendation" } } },
      proposal_gate: {
        type: "condition_gateway",
        gateway_config: {
          field: "status",
          routes: { proposed: "review", no_change: "quiet" },
          default_port: "quiet",
        },
        after: ["propose"],
        outputs: {
          review: { to: "human_review.in:proposal" },
          quiet: { to: "no_change.in:result" },
        },
      },
      human_review: terminalNode("reviewer", "proposal_gate"),
      no_change: terminalNode("reviewer", "proposal_gate"),
    },
  },
};

const definitions = [
  heartbeat,
  orchestratorWorkers,
  budgetGate,
  trustLedger,
  standingGoalSentinel,
  quorum,
  sparring,
  ratchet,
  compost,
] as const;

const definitionById = new Map(definitions.map((definition) => [definition.id, definition]));

function clone<T>(value: T): T {
  return structuredClone(value);
}

function publicDefinition(definition: DAGPatternDefinition): DAGPatternDefinition {
  return clone(definition);
}

export function listDAGPatterns(): DAGPatternSummary[] {
  return definitions.map((definition) => ({
    id: definition.id,
    version: definition.version,
    name: definition.name,
    summary: definition.summary,
    intent: definition.intent,
    roles: clone(definition.roles),
    typical_uses: [...definition.typical_uses],
    avoid_when: [...definition.avoid_when],
    required_primitives: [...definition.required_primitives],
    parameters: clone(definition.parameters),
    source: clone(definition.source),
    node_count: Object.keys(definition.workflow_template.nodes as Record<string, unknown>).length,
  }));
}

export function getDAGPattern(id: string): DAGPatternDefinition | undefined {
  const definition = definitionById.get(id);
  return definition ? publicDefinition(definition) : undefined;
}

function validateParameter(name: string, definition: DAGPatternParameter, value: unknown): string | number | boolean {
  if (definition.type === "string") {
    if (typeof value !== "string" || !value.trim()) {
      throw new Error(`Pattern parameter '${name}' must be a non-empty string.`);
    }
  } else if (definition.type === "number") {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new Error(`Pattern parameter '${name}' must be a finite number.`);
    }
    if (definition.integer && !Number.isInteger(value)) {
      throw new Error(`Pattern parameter '${name}' must be an integer.`);
    }
    if (definition.minimum !== undefined && value < definition.minimum) {
      throw new Error(`Pattern parameter '${name}' must be at least ${definition.minimum}.`);
    }
    if (definition.maximum !== undefined && value > definition.maximum) {
      throw new Error(`Pattern parameter '${name}' must be at most ${definition.maximum}.`);
    }
  } else if (typeof value !== "boolean") {
    throw new Error(`Pattern parameter '${name}' must be a boolean.`);
  }
  if (definition.values && !definition.values.includes(value as never)) {
    throw new Error(`Pattern parameter '${name}' must be one of: ${definition.values.join(", ")}.`);
  }
  return value as string | number | boolean;
}

function resolveParameters(
  definition: DAGPatternDefinition,
  supplied: Record<string, unknown>,
): Record<string, string | number | boolean> {
  for (const name of Object.keys(supplied)) {
    if (!definition.parameters[name]) throw new Error(`Unknown pattern parameter: ${name}`);
  }
  const resolved: Record<string, string | number | boolean> = {};
  for (const [name, parameter] of Object.entries(definition.parameters)) {
    const value = Object.prototype.hasOwnProperty.call(supplied, name) ? supplied[name] : parameter.default;
    resolved[name] = validateParameter(name, parameter, value);
  }
  return resolved;
}

const wholePlaceholder = /^\{\{([A-Za-z0-9_]+)\}\}$/;
const inlinePlaceholder = /\{\{([A-Za-z0-9_]+)\}\}/g;

function interpolate(value: unknown, parameters: Record<string, string | number | boolean>): unknown {
  if (Array.isArray(value)) return value.map((item) => interpolate(item, parameters));
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, interpolate(item, parameters)]),
    );
  }
  if (typeof value !== "string") return value;
  const whole = value.match(wholePlaceholder);
  if (whole) {
    if (!(whole[1] in parameters)) throw new Error(`Missing pattern parameter: ${whole[1]}`);
    return parameters[whole[1]];
  }
  return value.replace(inlinePlaceholder, (_match, name: string) => {
    if (!(name in parameters)) throw new Error(`Missing pattern parameter: ${name}`);
    return String(parameters[name]);
  });
}

export function instantiateDAGPattern(
  id: string,
  supplied: Record<string, unknown> = {},
): InstantiatedDAGPattern {
  const definition = definitionById.get(id);
  if (!definition) throw new Error(`DAG pattern not found: ${id}`);
  const parameters = resolveParameters(definition, supplied);
  const workflow = interpolate(definition.workflow_template, parameters) as Record<string, unknown>;
  workflow.pattern = {
    id: definition.id,
    version: definition.version,
    source: definition.source.url,
    parameters,
  };
  const yamlText = YAML.stringify(workflow, { lineWidth: 0 });
  const parsed = parseDAGYaml(yamlText);
  const validation = validateGraph(parsed.graph);
  assertGraphValid(parsed.graph);
  return {
    pattern: publicDefinition(definition),
    parameters,
    workflow,
    yaml_text: yamlText,
    parsed,
    validation,
  };
}
