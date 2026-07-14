import YAML from "yaml";

import { createIssueDiagnosisPattern } from "./issue-diagnosis-pattern.js";
import { assertGraphValid, validateGraph, type GraphValidationResult } from "./graph-validator.js";
import type { ParsedDAG } from "./graph.js";
import { assertRuntimeGraphParity } from "./runtime-graph-parity.js";
import {
  canonicalWorkflowToV1Document,
  compileWorkflowSource,
  projectCanonicalWorkflowToParsedDAG,
} from "./workflow-spec-v1.js";
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
  category: "execution" | "governance" | "decision" | "continuous-improvement";
  invariants: string[];
  external_dependencies: Array<{ id: string; required: boolean; description: string }>;
  evidence_contract: { required: string[]; success: string };
  composition_ports: { inputs: string[]; outputs: string[] };
  failure_semantics: Record<string, string>;
  roles: DAGPatternRole[];
  typical_uses: string[];
  avoid_when: string[];
  required_primitives: string[];
  parameters: Record<string, DAGPatternParameter>;
  source: typeof DAG_PATTERN_SOURCE;
  workflow_template: Record<string, unknown>;
}

function patternContract(input: Pick<
  DAGPatternDefinition,
  "category" | "invariants" | "external_dependencies" | "evidence_contract" | "composition_ports" | "failure_semantics"
>): typeof input {
  return input;
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
  version: "1.0.9",
  name: "Heartbeat",
  summary: "Triage one signal, route one actionable item, execute it, and independently verify the result.",
  intent: "Keep periodic autonomous work bounded by a quiet-path exit, a single selected action, and a separate verifier.",
  ...patternContract({
    category: "continuous-improvement",
    invariants: ["quiet signals terminate without worker dispatch", "at most one actionable item is selected per tick", "the worker never supplies the final verdict"],
    external_dependencies: [{ id: "trigger", required: true, description: "Manager interval or event trigger" }],
    evidence_contract: { required: ["signal evidence", "bounded work order", "independent verdict"], success: "deterministic final check and verifier both pass" },
    composition_ports: { inputs: ["signals"], outputs: ["quiet", "verified", "review"] },
    failure_semantics: { triage: "quiet", execution: "review", verification: "review" },
  }),
  roles: [
    { id: "triage", responsibility: "Reduce raw signals to actionable or quiet status." },
    { id: "conductor", responsibility: "Select exactly one item and issue a bounded work order." },
    { id: "worker", responsibility: "Execute only the selected work order." },
    { id: "verifier", responsibility: "Judge the result against explicit completion criteria." },
  ],
  typical_uses: ["scheduled repository maintenance", "issue triage", "bounded operational automation"],
  avoid_when: ["the input cannot be classified reliably", "multiple actions must commit atomically"],
  required_primitives: ["Manager trigger", "condition gateway", "deterministic command check", "independent verifier"],
  parameters: {
    ...identityParameters("heartbeat", "Heartbeat Pattern"),
    interval_ms: { type: "number", description: "Manager-owned heartbeat interval.", default: 86400000, minimum: 1000, maximum: 31536000000, integer: true },
  },
  source: DAG_PATTERN_SOURCE,
  workflow_template: {
    api_version: "homerail.ai/v1",
    kind: "Workflow",
    metadata: { id: "{{workflow_id}}", name: "{{name}}" },
    spec: {
      description: "Triggered quiet-path triage, one bounded action, independent review, and a deterministic final predicate.",
      workspace: { mode: "isolated" },
      triggers: { heartbeat: { type: "interval", every_ms: "{{interval_ms}}", overlap: "skip", max_concurrency: 1 } },
      contracts: {
        Signals: {},
        Classification: { type: "object", required: ["status"], properties: { status: { type: "string", enum: ["actionable", "quiet"] } } },
        WorkOrder: {
          type: "object",
          additionalProperties: false,
          required: ["done_when", "evidence", "check_command"],
          properties: {
            done_when: { type: "string", minLength: 1 },
            evidence: {},
            check_command: { type: "array", minItems: 1, maxItems: 32, items: { type: "string" } },
          },
        },
        WorkResult: {
          type: "object",
          additionalProperties: false,
          required: ["status", "evidence"],
          properties: {
            status: { type: "string", enum: ["completed", "failed"] },
            evidence: {},
          },
        },
        Check: { type: "object", required: ["verdict"], properties: { verdict: { type: "string", enum: ["pass", "fail"] } } },
      },
      agents: {
        triage: { system: "Do not execute check_command and do not use Bash, Read, or any tool except handoff. Your first and only tool call must hand off on port classified. Its content must be one JSON object with top-level status set to actionable or quiet, top-level evidence, and the exact check_command JSON array copied from the input when present." },
        conductor: { system: "Select exactly one actionable item. Do not execute check_command and do not use Bash, Read, or any tool except handoff. Your first and only tool call must hand off on port ordered with exactly one JSON object containing top-level done_when, evidence, and the exact allowlisted check_command JSON array copied from the input; do not describe check_command as the action itself." },
        worker: { system: "Execute only the non-command work order. Never execute check_command because the deterministic gateway owns that independent check. Do not answer with text. Your final tool call must hand off on port completed with exactly one JSON object containing top-level status set to completed or failed and top-level evidence describing the bounded action result. Do not copy or modify check_command." },
        verifier: { system: "Independently compare input:result with input:order.done_when. Judge only whether the worker's bounded result has status=completed and evidence satisfying the work order; the Manager-owned check_command runs after this verdict, so never fail merely because that command has not run yet. Do not execute check_command and do not use Bash, Read, or any tool except handoff. Your first and only tool call must hand off on port checked with exactly one JSON object containing top-level verdict set to pass or fail and top-level evidence. Never nest verdict and never claim the deterministic command ran." },
      },
      nodes: {
        triage: { kind: "agent", agent: "triage", inputs: { signals: { contract: "Signals" } }, outputs: { classified: { contract: "Classification" } } },
        signal_gate: { kind: "condition", inputs: { signal: { contract: "Classification" } }, outputs: { act: { contract: "Classification" }, quiet: { contract: "Classification" } }, config: { field: "status", routes: { actionable: "act", quiet: "quiet" }, default: "quiet" } },
        conduct: { kind: "agent", agent: "conductor", inputs: { signal: { contract: "Classification" } }, outputs: { ordered: { contract: "WorkOrder" } } },
        execute: { kind: "agent", agent: "worker", inputs: { order: { contract: "WorkOrder" } }, outputs: { completed: { contract: "WorkResult" } } },
        verify: { kind: "agent", agent: "verifier", inputs: { order: { contract: "WorkOrder" }, result: { contract: "WorkResult" } }, outputs: { checked: { contract: "Check" } } },
        verdict_gate: { kind: "condition", inputs: { check: { contract: "Check" } }, outputs: { check: { contract: "Check" }, failed: { contract: "Check" } }, config: { field: "verdict", routes: { pass: "check", fail: "failed" }, default: "failed" } },
        deterministic_check: { kind: "command", inputs: { order: { contract: "WorkOrder" }, verdict: { contract: "Check" } }, outputs: { passed: {}, failed: {} }, config: { input: "order", command_field: "check_command", timeout_ms: 120000, success_port: "passed", failure_port: "failed", parse_stdout: "text" } },
        quiet: { kind: "terminal", outcome: "success", inputs: { result: { contract: "Classification" } } },
        done: { kind: "terminal", outcome: "success", inputs: { result: {} } },
        review_model: { kind: "terminal", outcome: "failure", inputs: { result: {} } },
        review_check: { kind: "terminal", outcome: "failure", inputs: { result: {} } },
      },
      edges: [
        { from: "$run.input", to: "triage.signals" },
        { from: "triage.classified", to: "signal_gate.signal" },
        { from: "signal_gate.act", to: "conduct.signal" },
        { from: "signal_gate.quiet", to: "quiet.result" },
        { from: "conduct.ordered", to: "execute.order" },
        { from: "conduct.ordered", to: "verify.order" },
        { from: "conduct.ordered", to: "deterministic_check.order" },
        { from: "execute.completed", to: "verify.result" },
        { from: "verify.checked", to: "verdict_gate.check" },
        { from: "verdict_gate.check", to: "deterministic_check.verdict" },
        { from: "verdict_gate.failed", to: "review_model.result", condition: "on_failure" },
        { from: "deterministic_check.passed", to: "done.result" },
        { from: "deterministic_check.failed", to: "review_check.result", condition: "on_failure" },
      ],
      policies: { max_corrections_per_node: 3 },
    },
  },
};

const issueDiagnosis = createIssueDiagnosisPattern(DAG_PATTERN_SOURCE);

const orchestratorWorkers: DAGPatternDefinition = {
  id: "orchestrator-workers",
  version: "1.2.0",
  name: "Orchestrator and Workers",
  summary: "Separate planning from parallel execution, then aggregate and verify all worker results.",
  intent: "Give one planner ownership of decomposition while independent workers execute bounded parts in parallel.",
  ...patternContract({
    category: "execution",
    invariants: ["the orchestrator plans but does not execute", "worker items are bounded and isolated", "aggregate verification uses all admitted results"],
    external_dependencies: [],
    evidence_contract: { required: ["work item list", "per-item result", "aggregate verdict"], success: "completion policy and aggregate verification pass" },
    composition_ports: { inputs: ["objective"], outputs: ["verified", "failed"] },
    failure_semantics: { planning: "fail", worker: "aggregate according to completion policy", verification: "review" },
  }),
  roles: [
    { id: "orchestrator", responsibility: "Decompose the objective into non-overlapping work orders." },
    { id: "worker", responsibility: "Complete one work order and report structured status." },
    { id: "verifier", responsibility: "Verify the aggregate rather than trusting worker self-assessment." },
  ],
  typical_uses: ["parallel research", "multi-module implementation", "independent evidence collection"],
  avoid_when: ["workers must edit the same state concurrently", "the objective is too small to decompose"],
  required_primitives: ["fanout gateway", "bounded parallelism", "independent verification"],
  parameters: {
    ...identityParameters("orchestrator-workers", "Orchestrator and Workers Pattern"),
    max_workers: { type: "number", description: "Maximum data-driven worker items.", default: 16, minimum: 1, maximum: 256, integer: true },
    max_parallelism: { type: "number", description: "Maximum concurrently active workers.", default: 4, minimum: 1, maximum: 16, integer: true },
  },
  source: DAG_PATTERN_SOURCE,
  workflow_template: {
    api_version: "homerail.ai/v1",
    kind: "Workflow",
    metadata: { id: "{{workflow_id}}", name: "{{name}}" },
    spec: {
      description: "Planner-led data-driven fan-out with bounded parallelism and fresh verification.",
      workspace: { mode: "isolated" },
      contracts: {
        Objective: { type: "string", minLength: 1 },
        Plan: {
          type: "object",
          required: ["context", "work_items"],
          properties: {
            context: { type: "string", minLength: 1 },
            work_items: {
              type: "array",
              minItems: 1,
              maxItems: "{{max_workers}}",
              items: {
                type: "object",
                required: ["id", "task", "acceptance_criteria"],
                properties: {
                  id: { type: "string", minLength: 1 },
                  task: { type: "string", minLength: 1 },
                  acceptance_criteria: { type: "array", minItems: 1, items: { type: "string", minLength: 1 } },
                },
              },
            },
          },
        },
        WorkerResult: {
          type: "object",
          required: ["status", "evidence"],
          properties: {
            status: { enum: ["success", "failed"] },
            evidence: {},
          },
        },
      },
      agents: {
        orchestrator: { system: "Plan only: never inspect repositories, read task files, call shell tools, or execute any work item. Copy the supplied objective verbatim into the top-level context field so every worker receives the same immutable source context, then decompose it into 1..N non-overlapping work_items. Every item must contain exactly id as a non-empty string, task as a non-empty string, and acceptance_criteria as a non-empty JSON array of strings; acceptance_criteria must never be a single string. Workers must report status using exactly success or failed; never ask for pass/fail or any alternative status vocabulary. Never precompute findings, evidence, status, or result values for a worker. The DAG already has a separate verifier after fan-out: never add verifier, reviewer, aggregator, coordinator, or summary items to work_items. Your first and only tool call must hand off on the exact port planned, never plan or plan.planned, with only top-level context and work_items." },
        worker: { system: "Execute only the supplied fan-out item. Its envelope contains item plus the original immutable context; use that context as source evidence and inspect additional real inputs only when the task requires them. Use the minimum tools needed to produce grounded evidence and do not wait for other workers. After the work is complete, your final tool call must hand off on the exact port result, with exactly one JSON object containing top-level status set to success or failed and top-level evidence grounded in the work performed. Use status failed when an acceptance criterion cannot be checked. Never use done, completed, pass, or any other port or status vocabulary; never copy planner claims as evidence; never omit, nest, or rename status or evidence." },
        verifier: { system: "Verify the combined fan-out evidence against the original objective. Your first and only tool call must hand off on the exact port verified when every result is grounded and satisfies the objective, otherwise on the exact port failed." },
      },
      nodes: {
        plan: { kind: "agent", agent: "orchestrator", allowed_builtin_tools: [], allowed_dag_tools: ["handoff"], inputs: { objective: { contract: "Objective" } }, outputs: { planned: { contract: "Plan" } } },
        fanout: {
          kind: "fanout",
          inputs: { plan: { contract: "Plan" } },
          outputs: { passed: {}, failed: {} },
          config: { input: "plan", item_field: "work_items", context_field: "context", worker_agent: "worker", max_items: "{{max_workers}}", max_parallelism: "{{max_parallelism}}", completion: "all", result_contract: "WorkerResult", success_field: "status", success_values: ["success"], result_port: "passed", failed_port: "failed", cancel_remaining: false },
        },
        verify: { kind: "agent", agent: "verifier", allowed_builtin_tools: [], allowed_dag_tools: ["handoff"], inputs: { aggregate: {} }, outputs: { verified: {}, failed: {} } },
        done: { kind: "terminal", outcome: "success", inputs: { result: {} } },
        worker_failed: { kind: "terminal", outcome: "failure", inputs: { result: {} } },
        verification_failed: { kind: "terminal", outcome: "failure", inputs: { result: {} } },
      },
      edges: [
        { from: "$run.input", to: "plan.objective" },
        { from: "plan.planned", to: "fanout.plan" },
        { from: "fanout.passed", to: "verify.aggregate" },
        { from: "fanout.failed", to: "worker_failed.result", condition: "on_failure" },
        { from: "verify.verified", to: "done.result" },
        { from: "verify.failed", to: "verification_failed.result", condition: "on_failure" },
      ],
      policies: { max_nodes: 300, max_parallelism: "{{max_parallelism}}", max_dispatches: 1000, max_corrections_per_node: 3 },
    },
  },
};

const executorAdvisor: DAGPatternDefinition = {
  id: "executor-advisor",
  version: "1.0.1",
  name: "Executor and Advisor",
  summary: "Keep a bounded executor in one context while allowing explicit, audited consultation with a stronger advisor.",
  intent: "Spend expensive reasoning only at ambiguity boundaries without transferring ownership of execution.",
  ...patternContract({
    category: "decision",
    invariants: ["the executor owns the task and final handoff", "advisor calls are explicit and bounded", "advisor responses return to the same executor turn", "executor and advisor runtime bindings are independent"],
    external_dependencies: [],
    evidence_contract: { required: ["advisor request", "advisor identity", "advisor response", "usage", "executor continuation"], success: "executor completes after zero or more policy-compliant consultations" },
    composition_ports: { inputs: ["task"], outputs: ["done", "failed"] },
    failure_semantics: { advisor_timeout: "return tool error to executor", advisor_limit: "deny additional consultation", execution: "failed" },
  }),
  roles: [
    { id: "executor", responsibility: "Own execution, consult only when a high-value decision is genuinely ambiguous, and continue in the same context." },
    { id: "advisor", responsibility: "Answer a bounded decision question without taking over execution." },
  ],
  typical_uses: ["local-model execution with expert architecture advice", "security decision escalation", "bounded implementation with expensive review on demand"],
  avoid_when: ["every step requires the strongest model", "the executor cannot identify ambiguity boundaries"],
  required_primitives: ["consult_advisor tool", "per-agent runtime binding", "advisor audit events", "call/token/timeout limits"],
  parameters: {
    ...identityParameters("executor-advisor", "Executor and Advisor Pattern"),
    max_advisor_calls: { type: "number", description: "Maximum consultations in one executor turn.", default: 2, minimum: 1, maximum: 32, integer: true },
    advisor_timeout_ms: { type: "number", description: "Timeout for each advisor call.", default: 120000, minimum: 100, maximum: 3600000, integer: true },
    advisor_max_tokens: { type: "number", description: "Maximum reported input plus output tokens per advisor call.", default: 64000, minimum: 1, maximum: 1000000, integer: true },
  },
  source: DAG_PATTERN_SOURCE,
  workflow_template: {
    api_version: "homerail.ai/v1",
    kind: "Workflow",
    metadata: { id: "{{workflow_id}}", name: "{{name}}" },
    spec: {
      description: "Executor retains context and consults a separately bound advisor only at ambiguity boundaries.",
      workspace: { mode: "isolated" },
      contracts: { Task: { type: "string", minLength: 1 } },
      agents: {
        executor: { system: "Execute the supplied task. Use consult_advisor only for a concrete ambiguity whose answer changes the action. Continue this same turn after advice and hand off done or failed with evidence. If input:correction is present, do not consult the advisor again; use the original task and completed decision work, then immediately hand off a contract-valid result." },
        advisor: { system: "Answer only the bounded decision question. Give a recommendation with constraints and evidence; do not execute the task." },
      },
      nodes: {
        execute: {
          kind: "agent",
          agent: "executor",
          advisors: [{ id: "expert", agent: "advisor", max_calls: "{{max_advisor_calls}}", timeout_ms: "{{advisor_timeout_ms}}", max_tokens: "{{advisor_max_tokens}}" }],
          inputs: { task: { contract: "Task" } },
          outputs: { done: {}, failed: {} },
        },
        completed: { kind: "terminal", inputs: { result: {} }, outcome: "success" },
        failed: { kind: "terminal", inputs: { result: {} }, outcome: "failure" },
      },
      edges: [
        { from: "$run.input", to: "execute.task" },
        { from: "execute.done", to: "completed.result" },
        { from: "execute.failed", to: "failed.result", condition: "on_failure" },
      ],
      policies: { max_tool_calls_per_node: "{{max_advisor_calls}}" },
    },
  },
};

const budgetGate: DAGPatternDefinition = {
  id: "budget-gate",
  version: "1.1.0",
  name: "Budget Gate",
  summary: "Atomically reserve declared usage before execution and route over-budget work to a stop path.",
  intent: "Make concurrent budget reservation a deterministic decision before expensive work starts.",
  ...patternContract({
    category: "governance",
    invariants: ["declared usage is reserved atomically", "spent plus requested usage cannot exceed the limit at admission", "over-budget work never reaches the expensive worker"],
    external_dependencies: [{ id: "usage-ledger", required: true, description: "Manager-owned usage state" }],
    evidence_contract: { required: ["spent", "requested", "budget limit", "remaining", "admission decision"], success: "declared usage is reserved before work starts" },
    composition_ports: { inputs: ["work", "usage"], outputs: ["admitted", "stopped", "audited"] },
    failure_semantics: { measurement: "stop", admission: "stop", execution: "audit failure" },
  }),
  roles: [
    { id: "accountant", responsibility: "Reserve declared usage against the configured budget." },
    { id: "worker", responsibility: "Execute only work admitted by the gate." },
    { id: "auditor", responsibility: "Retain the worker's actual usage evidence with the outcome." },
  ],
  typical_uses: ["metered model workflows", "bounded batch processing", "daily automation budgets"],
  avoid_when: ["a conservative usage reservation cannot be declared", "the operation must run regardless of cost"],
  required_primitives: ["transactional usage reservation", "deterministic budget admission", "terminal stop branch"],
  parameters: {
    ...identityParameters("budget-gate", "Budget Gate Pattern"),
    budget_limit: {
      type: "number",
      description: "Maximum budget admitted by the accounting role.",
      default: 5,
      minimum: 0,
    },
    budget_key: { type: "string", description: "Namespaced usage ledger key.", default: "daily" },
  },
  source: DAG_PATTERN_SOURCE,
  workflow_template: {
    api_version: "homerail.ai/v1",
    kind: "Workflow",
    metadata: { id: "{{workflow_id}}", name: "{{name}}" },
    spec: {
      description: "Authoritative Manager state atomically reserves declared usage before expensive work.",
      workspace: { mode: "isolated" },
      contracts: {
        Work: { type: "object", required: ["expected_usage"], properties: { expected_usage: { type: "number", minimum: 0 } } },
        Result: { type: "object", required: ["usage"], properties: { usage: { type: "number", minimum: 0 } } },
      },
      agents: { worker: { system: "Execute only the admitted input.input work within its reserved expected_usage. Do not inspect graph context and do not copy the budget-gate payload. Your first tool call must hand off on port completed. Its content must be one JSON object with top-level numeric usage and top-level evidence. Never omit, nest, or rename usage." } },
      nodes: {
        budget_gate: { kind: "state", inputs: { work: { contract: "Work" } }, outputs: { admit: {}, block: {} }, config: { namespace: "budget", key: "{{budget_key}}", operation: "budget_admit", value_field: "expected_usage", budget_limit: "{{budget_limit}}", success_port: "admit", conflict_port: "block" } },
        execute: { kind: "agent", agent: "worker", inputs: { budget: {} }, outputs: { completed: { contract: "Result" }, failed: {} } },
        audited: { kind: "terminal", outcome: "success", inputs: { result: {} } },
        blocked: { kind: "terminal", outcome: "cancelled", inputs: { result: {} } },
        execution_failed: { kind: "terminal", outcome: "failure", inputs: { result: {} } },
      },
      edges: [
        { from: "$run.input", to: "budget_gate.work" },
        { from: "budget_gate.admit", to: "execute.budget" },
        { from: "budget_gate.block", to: "blocked.result" },
        { from: "execute.completed", to: "audited.result" },
        { from: "execute.failed", to: "execution_failed.result", condition: "on_failure" },
      ],
    },
  },
};

const trustLedger: DAGPatternDefinition = {
  id: "trust-ledger",
  version: "1.0.2",
  name: "Trust Ledger",
  summary: "Route each recurring skill according to measured pass history: auto, queue, or watch.",
  intent: "Grant autonomy per skill from evidence instead of assigning one global automation level.",
  ...patternContract({
    category: "governance",
    invariants: ["trust is namespaced per skill", "tier is derived from persisted runs and passes", "a failure can demote without model discretion"],
    external_dependencies: [{ id: "trust-ledger", required: true, description: "Transactional Manager state record" }],
    evidence_contract: { required: ["before record", "verified outcome", "after record", "tier"], success: "atomic ledger update commits" },
    composition_ports: { inputs: ["skill outcome"], outputs: ["auto", "queue", "watch"] },
    failure_semantics: { verification: "record failure", conflict: "retry or queue", demotion: "watch" },
  }),
  roles: [
    { id: "assessor", responsibility: "Read the skill's run history and assign a trust tier." },
    { id: "worker", responsibility: "Produce a candidate result regardless of tier." },
    { id: "verifier", responsibility: "Emit the pass/fail evidence used to update trust." },
  ],
  typical_uses: ["recurring maintenance skills", "graduated autonomy", "automatic demotion after failures"],
  avoid_when: ["tasks do not repeat", "pass/fail cannot be measured consistently"],
  required_primitives: ["transactional state gateway", "deterministic trust tier", "per-skill identity"],
  parameters: identityParameters("trust-ledger", "Trust Ledger Pattern"),
  source: DAG_PATTERN_SOURCE,
  workflow_template: {
    api_version: "homerail.ai/v1",
    kind: "Workflow",
    metadata: { id: "{{workflow_id}}", name: "{{name}}" },
    spec: {
      description: "Verified per-skill outcomes update a transactional trust ledger and route by computed tier.",
      workspace: { mode: "isolated" },
      contracts: {
        Work: { type: "object", required: ["skill_id"], properties: { skill_id: { type: "string", minLength: 1 } } },
        Verdict: { type: "object", required: ["skill_id", "verdict"], properties: { skill_id: { type: "string" }, verdict: { type: "string", enum: ["pass", "fail"] } } },
      },
      agents: {
        worker: { system: "Execute the recurring skill. Your completed handoff content must be one JSON object with top-level skill_id copied exactly from the input and top-level evidence." },
        verifier: { system: "Independently grade the result against the original work request and its acceptance criteria. Your verified handoff content must be one JSON object with top-level skill_id copied exactly from the input, top-level verdict set to pass or fail, and top-level evidence. Never nest or rename skill_id or verdict. Do not choose a trust tier." },
      },
      nodes: {
        execute: { kind: "agent", agent: "worker", inputs: { work: { contract: "Work" } }, outputs: { completed: {} } },
        verify: { kind: "agent", agent: "verifier", inputs: { work: { contract: "Work" }, result: {} }, outputs: { verified: { contract: "Verdict" } } },
        update_trust: { kind: "state", inputs: { verdict: { contract: "Verdict" } }, outputs: { updated: {}, conflict: {} }, config: { namespace: "trust", key: "unknown", key_field: "skill_id", operation: "trust_update", pass_field: "verdict", auto_min_runs: 20, auto_min_rate: 0.95, watch_min_rate: 0.9, success_port: "updated", conflict_port: "conflict" } },
        tier_gate: { kind: "condition", inputs: { record: {} }, outputs: { auto: {}, queue: {}, watch: {} }, config: { field: "record.value.tier", routes: { auto: "auto", queue: "queue", watch: "watch" }, default: "watch" } },
        auto: { kind: "terminal", outcome: "success", inputs: { result: {} } },
        queued: { kind: "terminal", outcome: "success", inputs: { result: {} } },
        watched: { kind: "terminal", outcome: "success", inputs: { result: {} } },
        conflict: { kind: "terminal", outcome: "failure", inputs: { result: {} } },
      },
      edges: [
        { from: "$run.input", to: "execute.work" },
        { from: "$run.input", to: "verify.work" },
        { from: "execute.completed", to: "verify.result" },
        { from: "verify.verified", to: "update_trust.verdict" },
        { from: "update_trust.updated", to: "tier_gate.record" },
        { from: "update_trust.conflict", to: "conflict.result", condition: "on_failure" },
        { from: "tier_gate.auto", to: "auto.result" },
        { from: "tier_gate.queue", to: "queued.result" },
        { from: "tier_gate.watch", to: "watched.result" },
      ],
    },
  },
};

const standingGoalSentinel: DAGPatternDefinition = {
  id: "standing-goal-sentinel",
  version: "1.0.0",
  name: "Standing Goal Sentinel",
  summary: "Iterate over previously satisfied goals, re-run their predicates, and report violations.",
  intent: "Turn completed goals into continuously checked invariants instead of one-time claims.",
  ...patternContract({
    category: "continuous-improvement",
    invariants: ["predicates are bounded and deterministic", "verification never auto-fixes", "last-pass and violations are durable"],
    external_dependencies: [{ id: "goal-ledger", required: true, description: "Persisted standing-goal records" }, { id: "trigger", required: true, description: "Manager interval trigger" }],
    evidence_contract: { required: ["predicate", "exit evidence", "previous state", "new state"], success: "all active predicates pass" },
    composition_ports: { inputs: ["active goals"], outputs: ["satisfied", "violated"] },
    failure_semantics: { predicate: "mark violated", timeout: "mark violated", repair: "route to normal pipeline" },
  }),
  roles: [
    { id: "loader", responsibility: "Load active goal predicates as a finite item list." },
    { id: "verifier", responsibility: "Evaluate one predicate and emit structured evidence." },
    { id: "reporter", responsibility: "Summarize all current violations without silently fixing them." },
  ],
  typical_uses: ["regression sentinels", "operational invariants", "periodic acceptance checks"],
  avoid_when: ["predicates mutate production state", "verification cannot finish within a bounded time"],
  required_primitives: ["Manager interval trigger", "transactional goal ledger", "deterministic command predicate", "finite loop"],
  parameters: {
    ...identityParameters("standing-goal-sentinel", "Standing Goal Sentinel Pattern"),
    interval_ms: { type: "number", description: "Manager-owned recheck interval.", default: 86400000, minimum: 1000, maximum: 31536000000, integer: true },
    goals_key: { type: "string", description: "State key containing active goal records.", default: "active" },
    max_goals: { type: "number", description: "Maximum predicates checked per run.", default: 100, minimum: 1, maximum: 10000, integer: true },
  },
  source: DAG_PATTERN_SOURCE,
  workflow_template: {
    api_version: "homerail.ai/v1",
    kind: "Workflow",
    metadata: { id: "{{workflow_id}}", name: "{{name}}" },
    spec: {
      description: "Manager-scheduled deterministic re-verification of persisted standing goal commands.",
      workspace: { mode: "shared" },
      triggers: { sentinel: { type: "interval", every_ms: "{{interval_ms}}", overlap: "skip", max_concurrency: 1 } },
      agents: {},
      nodes: {
        load_goals: { kind: "state", outputs: { loaded: {} }, config: { namespace: "standing-goals", key: "{{goals_key}}", operation: "get", success_port: "loaded" } },
        goal_loop: { kind: "foreach", inputs: { items: {}, result: {} }, outputs: { next_goal: {}, done: {} }, config: { input: "items", field: "record.value", item_port: "next_goal", result_port: "result", done_port: "done", max_items: "{{max_goals}}" } },
        check_goal: { kind: "command", inputs: { goal: {} }, outputs: { checked: {} }, config: { command_field: "item.command", timeout_ms: 60000, success_port: "checked", failure_port: "checked", parse_stdout: "text" } },
        audit_results: { kind: "command", inputs: { summary: {} }, outputs: { passed: {}, failed: {} }, config: { command: ["node", "-e", "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const r=JSON.parse(s)||[];process.exit(r.some(x=>x&&x.ok===false)?1:0)})"], stdin_field: "results", timeout_ms: 10000, success_port: "passed", failure_port: "failed" } },
        record_pass: { kind: "state", inputs: { summary: {} }, outputs: { recorded: {}, conflict: {} }, config: { namespace: "standing-goal-runs", key: "{{goals_key}}", operation: "set", value_field: "input.results", success_port: "recorded", conflict_port: "conflict" } },
        record_failure: { kind: "state", inputs: { summary: {} }, outputs: { recorded: {}, conflict: {} }, config: { namespace: "standing-goal-runs", key: "{{goals_key}}", operation: "set", value_field: "input.results", success_port: "recorded", conflict_port: "conflict" } },
        satisfied: { kind: "terminal", outcome: "success", inputs: { result: {} } },
        violated: { kind: "terminal", outcome: "failure", inputs: { result: {} } },
        record_pass_failed: { kind: "terminal", outcome: "failure", inputs: { result: {} } },
        record_failure_failed: { kind: "terminal", outcome: "failure", inputs: { result: {} } },
      },
      edges: [
        { from: "load_goals.loaded", to: "goal_loop.items" },
        { from: "goal_loop.next_goal", to: "check_goal.goal" },
        { kind: "feedback", from: "check_goal.checked", to: "goal_loop.result", max_traversals: "{{max_goals}}" },
        { from: "goal_loop.done", to: "audit_results.summary" },
        { from: "audit_results.passed", to: "record_pass.summary" },
        { from: "audit_results.failed", to: "record_failure.summary", condition: "on_failure" },
        { from: "record_pass.recorded", to: "satisfied.result" },
        { from: "record_pass.conflict", to: "record_pass_failed.result", condition: "on_failure" },
        { from: "record_failure.recorded", to: "violated.result" },
        { from: "record_failure.conflict", to: "record_failure_failed.result", condition: "on_failure" },
      ],
    },
  },
};

const quorum: DAGPatternDefinition = {
  id: "quorum",
  version: "1.0.0",
  name: "Quorum",
  summary: "Collect independent votes and continue only when an n-of-m threshold is met.",
  intent: "Reduce false wake-ups or risky decisions by requiring independent agreement before expensive action.",
  ...patternContract({
    category: "decision",
    invariants: ["voters do not observe peer votes", "voters may bind heterogeneous runtimes", "only the deterministic threshold opens the action path"],
    external_dependencies: [],
    evidence_contract: { required: ["shared evidence", "independent votes", "threshold aggregate"], success: "n-of-m threshold is met" },
    composition_ports: { inputs: ["evidence"], outputs: ["act", "stop"] },
    failure_semantics: { voter: "count as non-success", threshold: "stop", action: "fail" },
  }),
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
      voter_one: { system: "Evaluate the supplied evidence independently. Return JSON with top-level vote (act or stop) and evidence. Do not inspect or infer other voters' decisions." },
      voter_two: { system: "Evaluate the supplied evidence independently. Return JSON with top-level vote (act or stop) and evidence. Do not inspect or infer other voters' decisions." },
      voter_three: { system: "Evaluate the supplied evidence independently. Return JSON with top-level vote (act or stop) and evidence. Do not inspect or infer other voters' decisions." },
      conductor: { system: "Receive the quorum aggregate and create one bounded action." },
      reporter: { system: "Report the aggregate vote and why action did or did not proceed." },
    },
    nodes: {
      collect_signal: {
        agent: "signal",
        outputs: { collected: { to: ["voter_one.in:signal", "voter_two.in:signal", "voter_three.in:signal"] } },
      },
      voter_one: { agent: "voter_one", after: ["collect_signal"], outputs: { vote: { to: "quorum.in:one" } } },
      voter_two: { agent: "voter_two", after: ["collect_signal"], outputs: { vote: { to: "quorum.in:two" } } },
      voter_three: { agent: "voter_three", after: ["collect_signal"], outputs: { vote: { to: "quorum.in:three" } } },
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
  version: "1.2.0",
  name: "Sparring",
  summary: "A breaker creates a concrete challenge, a builder addresses it, and a fresh verifier settles the result.",
  intent: "Separate adversarial discovery from repair so neither role grades its own output.",
  ...patternContract({
    category: "continuous-improvement",
    invariants: ["breaker artifacts are immutable to the builder", "builder writes stay in declared paths", "a Manager-owned check precedes the fresh verifier"],
    external_dependencies: [
      { id: "workspace-policy", required: true, description: "Worker file snapshot enforcement" },
      { id: "command-policy", required: true, description: "Operator-approved allowlist for the supplied test command" },
    ],
    evidence_contract: { required: ["original artifact hash", "builder diff", "Manager-owned check", "fresh verdict"], success: "artifact remains unchanged and deterministic verification passes" },
    composition_ports: { inputs: ["target"], outputs: ["verified", "dispute"] },
    failure_semantics: { mutation: "fail deterministically", test: "dispute", repair: "dispute", verification: "dispute" },
  }),
  roles: [
    { id: "breaker", responsibility: "Produce one reproducible failing challenge without fixing it." },
    { id: "builder", responsibility: "Fix the implementation without weakening the challenge." },
    { id: "verifier", responsibility: "Judge the challenge and repair from fresh context." },
  ],
  typical_uses: ["regression test generation", "security review", "specification hardening"],
  avoid_when: ["the breaker cannot produce reproducible evidence", "the challenged surface is unsafe for autonomous edits"],
  required_primitives: ["workspace access policy", "immutable artifact snapshot", "command gateway", "fresh verifier"],
  parameters: {
    ...identityParameters("sparring", "Sparring Pattern"),
    protected_path: { type: "string", description: "Breaker-owned path exposed read-only to builder.", default: "tests/sparring" },
    writable_path: { type: "string", description: "Implementation path writable by builder.", default: "src" },
  },
  source: DAG_PATTERN_SOURCE,
  workflow_template: {
    api_version: "homerail.ai/v1",
    kind: "Workflow",
    metadata: { id: "{{workflow_id}}", name: "{{name}}" },
    spec: {
      description: "Breaker-owned artifacts are hash-protected from the builder and checked by a fresh verifier.",
      workspace: { mode: "shared" },
      contracts: {
        Target: { type: "string", minLength: 1 },
        Challenge: {
          type: "object",
          additionalProperties: false,
          required: ["artifact_path", "test_command", "evidence"],
          properties: {
            artifact_path: { type: "string", minLength: 1 },
            test_command: { type: "array", minItems: 1, items: { type: "string" } },
            evidence: { type: "string", minLength: 1 },
          },
        },
        Repair: {
          type: "object",
          additionalProperties: false,
          required: ["test_command", "evidence"],
          properties: {
            test_command: { type: "array", minItems: 1, items: { type: "string" } },
            evidence: { type: "string", minLength: 1 },
          },
        },
        Verdict: { type: "object", additionalProperties: false, required: ["verdict", "evidence"], properties: { verdict: { type: "string", enum: ["pass", "fail"] }, evidence: { type: "string", minLength: 1 } } },
      },
      agents: {
        breaker: { system: "Create the smallest reproducible challenge under {{protected_path}} that satisfies the supplied task. Your final action must call handoff on challenge with content shaped exactly as {artifact_path: string, test_command: string[], evidence: string}. Copy any supplied test_command exactly. If input:correction is present, do not call Write, Read, Bash, or any other tool except handoff; immediately hand off the existing challenge. Do not rename fields, add fields, scaffold unrelated files, repeatedly refine the artifact, or fix implementation code." },
        builder: { system: "Read input:challenge as one object. Make the smallest requested fix only under {{writable_path}}. Your final action must call handoff on repaired with content shaped exactly as {test_command: string[], evidence: string}. Set test_command to the exact input:challenge.test_command array. If input:correction is present, the previous attempt already performed the file work: do not call Write, Read, Bash, or any other tool except handoff; immediately hand off the existing result. Never use alternate fields such as fix_applied or test_result. The breaker artifact is read-only and must never be weakened, deleted, or replaced." },
        verifier: { system: "From fresh context, inspect input:challenge, input:repair, and the Manager-owned input:check. Never execute test_command yourself and do not use Bash, Read, Write, or any tool except handoff. If challenge.test_command and repair.test_command are identical, check.ok is true, and check.exit_code is 0, immediately call handoff on verdict with exactly {verdict:'pass',evidence:string}; otherwise hand off exactly {verdict:'fail',evidence:string}. Do not add fields, answer with text, or modify files." },
      },
      nodes: {
        break: { kind: "agent", agent: "breaker", allowed_builtin_tools: ["Write"], allowed_dag_tools: ["handoff"], workspace_access: { writable_paths: ["{{protected_path}}"], readonly_paths: ["{{writable_path}}"] }, inputs: { target: { contract: "Target" } }, outputs: { challenge: { contract: "Challenge" } } },
        build: { kind: "agent", agent: "builder", allowed_builtin_tools: ["Write"], allowed_dag_tools: ["handoff"], workspace_access: { writable_paths: ["{{writable_path}}"], readonly_paths: ["{{protected_path}}"] }, inputs: { challenge: { contract: "Challenge" } }, outputs: { repaired: { contract: "Repair" } } },
        deterministic_check: { kind: "command", inputs: { challenge: { contract: "Challenge" }, repair: { contract: "Repair" } }, outputs: { passed: {}, failed: {} }, config: { input: "challenge", command_field: "test_command", cwd: "$run_workspace", timeout_ms: 120000, success_port: "passed", failure_port: "failed", parse_stdout: "text" } },
        verify: { kind: "agent", agent: "verifier", allowed_builtin_tools: [], allowed_dag_tools: ["handoff"], workspace_access: { writable_paths: [], readonly_paths: ["{{protected_path}}", "{{writable_path}}"] }, inputs: { challenge: { contract: "Challenge" }, repair: { contract: "Repair" }, check: {} }, outputs: { verdict: { contract: "Verdict" } } },
        verdict_gate: { kind: "condition", inputs: { verdict: { contract: "Verdict" } }, outputs: { passed: { contract: "Verdict" }, disputed: { contract: "Verdict" } }, config: { field: "verdict", routes: { pass: "passed", fail: "disputed" }, default: "disputed" } },
        done: { kind: "terminal", outcome: "success", inputs: { result: { contract: "Verdict" } } },
        check_dispute: { kind: "terminal", outcome: "failure", inputs: { result: {} } },
        dispute: { kind: "terminal", outcome: "failure", inputs: { result: { contract: "Verdict" } } },
      },
      edges: [
        { from: "$run.input", to: "break.target" },
        { from: "break.challenge", to: "build.challenge" },
        { from: "break.challenge", to: "deterministic_check.challenge" },
        { from: "break.challenge", to: "verify.challenge" },
        { from: "build.repaired", to: "deterministic_check.repair" },
        { from: "build.repaired", to: "verify.repair" },
        { from: "deterministic_check.passed", to: "verify.check" },
        { from: "deterministic_check.failed", to: "check_dispute.result", condition: "on_failure" },
        { from: "verify.verdict", to: "verdict_gate.verdict" },
        { from: "verdict_gate.passed", to: "done.result" },
        { from: "verdict_gate.disputed", to: "dispute.result", condition: "on_failure" },
      ],
      policies: { max_corrections_per_node: 3 },
    },
  },
};

const ratchet: DAGPatternDefinition = {
  id: "ratchet",
  version: "1.1.2",
  name: "Ratchet",
  summary: "Repeat measured improvements until a target is reached or a bounded iteration limit is exhausted.",
  intent: "Make progress monotonic and bounded by checking the metric before every additional attempt.",
  ...patternContract({
    category: "continuous-improvement",
    invariants: ["measurement is independent from improvement", "a non-improving change routes to compensation", "attempts are bounded", "the achieved floor is persisted"],
    external_dependencies: [{ id: "metric-command", required: true, description: "Allowlisted deterministic measurement" }, { id: "standing-goal-ledger", required: false, description: "Target floor enrollment" }],
    evidence_contract: { required: ["baseline", "change", "remeasurement", "rollback result"], success: "target is measured independently and enrolled" },
    composition_ports: { inputs: ["objective"], outputs: ["achieved", "exhausted", "rolled_back"] },
    failure_semantics: { regression: "compensate", timeout: "compensate", exhaustion: "stop with evidence" },
  }),
  roles: [
    { id: "measurer", responsibility: "Establish and report the current metric." },
    { id: "improver", responsibility: "Make one bounded change and re-measure without gaming the metric." },
    { id: "reporter", responsibility: "Record target achievement or bounded exhaustion." },
  ],
  typical_uses: ["warning reduction", "performance improvement", "coverage or quality targets"],
  avoid_when: ["the metric is noisy or gameable", "individual attempts cannot be reverted safely"],
  required_primitives: ["while_gateway", "independent command measurement", "previous/current evidence join", "monotonic command gate", "compensation command", "standing-goal state"],
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
    api_version: "homerail.ai/v1",
    kind: "Workflow",
    metadata: { id: "{{workflow_id}}", name: "{{name}}" },
    spec: {
      description: "Independent measurement, bounded improvement, monotonic gate, compensation, and standing-goal enrollment.",
      workspace: { mode: "shared" },
      contracts: {
        Task: { type: "object", required: ["measure_command"], properties: { measure_command: { type: "array", minItems: 1 }, rollback_command: { type: "array", minItems: 1 } } },
        Change: { type: "object", required: ["measure_command", "rollback_command"], properties: { measure_command: { type: "array", minItems: 1 }, rollback_command: { type: "array", minItems: 1 } } },
      },
      agents: { improver: { system: "Make exactly one bounded change. Do not answer with text or call unrelated tools. Your first tool call must hand off on port changed with one JSON object containing the exact measure_command JSON array and exact rollback_command JSON array copied from the input. The DAG owns the previous metric; never declare previous_metric. Never self-report a new metric." } },
      nodes: {
        baseline: { kind: "command", inputs: { task: { contract: "Task" } }, outputs: { measured: {}, failed: {} }, config: { command_field: "measure_command", timeout_ms: 120000, success_port: "measured", failure_port: "failed", parse_stdout: "number" } },
        target_gate: { kind: "while", inputs: { measurement: {} }, outputs: { improve: {}, reached: {}, exhausted: {} }, config: { field: "value", operator: "lte", value: "{{target}}", continue_port: "improve", done_port: "reached", exhausted_port: "exhausted", max_iterations: "{{max_iterations}}" } },
        previous_measurement: { kind: "command", depends_on: ["target_gate"], inputs: { measurement: {} }, outputs: { measured: {}, failed: {} }, config: { command: ["node", "-e", "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const m=JSON.parse(s),v=m&&m.input&&m.input.value;console.log(v);process.exit(Number.isFinite(v)?0:1)})"], stdin_field: "$", timeout_ms: 10000, success_port: "measured", failure_port: "failed", parse_stdout: "number" } },
        improve: { kind: "agent", agent: "improver", inputs: { measurement: {} }, outputs: { changed: { contract: "Change" }, failed: {} } },
        remeasure: { kind: "command", inputs: { change: { contract: "Change" } }, outputs: { measured: {}, failed: {} }, config: { command_field: "measure_command", timeout_ms: 120000, success_port: "measured", failure_port: "failed", parse_stdout: "number" } },
        compare_measurements: { kind: "join", inputs: { previous: {}, current: {} }, outputs: { ready: {}, failed: {} }, config: { mode: "all", field: "ok", success_values: [true], passed_port: "ready", failed_port: "failed" } },
        monotonic_gate: { kind: "command", depends_on: ["target_gate"], inputs: { measurements: {} }, outputs: { passed: {}, failed: {} }, config: { command: ["node", "-e", "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const m=JSON.parse(s),v=m.values||[],p=v.find(x=>x&&x.ok===true&&Number.isInteger(x.input?.iteration))?.value,n=v.find(x=>x&&x.ok===true&&Array.isArray(x.input?.measure_command))?.value;console.log(n);process.exit(Number.isFinite(n)&&Number.isFinite(p)&&n<p?0:1)})"], stdin_field: "$", timeout_ms: 10000, success_port: "passed", failure_port: "failed", parse_stdout: "number" } },
        rollback_regression: { kind: "command", inputs: { evidence: {} }, outputs: { rolled_back: {}, failed: {} }, config: { command_field: "input.values.1.input.rollback_command", timeout_ms: 120000, success_port: "rolled_back", failure_port: "failed" } },
        rollback_comparison: { kind: "command", inputs: { evidence: {} }, outputs: { rolled_back: {}, failed: {} }, config: { command_field: "values.1.input.rollback_command", timeout_ms: 120000, success_port: "rolled_back", failure_port: "failed" } },
        rollback_measurement: { kind: "command", inputs: { evidence: {} }, outputs: { rolled_back: {}, failed: {} }, config: { command_field: "input.rollback_command", timeout_ms: 120000, success_port: "rolled_back", failure_port: "failed" } },
        enroll_floor: { kind: "state", inputs: { measurement: {} }, outputs: { enrolled: {}, conflict: {} }, config: { namespace: "standing-goal-floors", key: "{{workflow_id}}", operation: "set", value_field: "input.value", success_port: "enrolled", conflict_port: "conflict" } },
        achieved: { kind: "terminal", outcome: "success", inputs: { result: {} } },
        baseline_failed: { kind: "terminal", outcome: "failure", inputs: { result: {} } },
        exhausted: { kind: "terminal", outcome: "failure", inputs: { result: {} } },
        improve_failed: { kind: "terminal", outcome: "failure", inputs: { result: {} } },
        rollback_regression_done: { kind: "terminal", outcome: "failure", inputs: { result: {} } },
        rollback_regression_failed: { kind: "terminal", outcome: "failure", inputs: { result: {} } },
        rollback_comparison_done: { kind: "terminal", outcome: "failure", inputs: { result: {} } },
        rollback_comparison_failed: { kind: "terminal", outcome: "failure", inputs: { result: {} } },
        rollback_measurement_done: { kind: "terminal", outcome: "failure", inputs: { result: {} } },
        rollback_measurement_failed: { kind: "terminal", outcome: "failure", inputs: { result: {} } },
        previous_measurement_failed: { kind: "terminal", outcome: "failure", inputs: { result: {} } },
        enrollment_failed: { kind: "terminal", outcome: "failure", inputs: { result: {} } },
      },
      edges: [
        { from: "$run.input", to: "baseline.task" },
        { from: "baseline.measured", to: "target_gate.measurement" },
        { from: "baseline.failed", to: "baseline_failed.result", condition: "on_failure" },
        { from: "target_gate.improve", to: "improve.measurement" },
        { from: "target_gate.improve", to: "previous_measurement.measurement" },
        { from: "target_gate.reached", to: "enroll_floor.measurement" },
        { from: "target_gate.exhausted", to: "exhausted.result", condition: "on_failure" },
        { from: "previous_measurement.measured", to: "compare_measurements.previous" },
        { from: "previous_measurement.failed", to: "previous_measurement_failed.result", condition: "on_failure" },
        { from: "improve.changed", to: "remeasure.change" },
        { from: "improve.failed", to: "improve_failed.result", condition: "on_failure" },
        { from: "remeasure.measured", to: "compare_measurements.current" },
        { from: "remeasure.failed", to: "rollback_measurement.evidence", condition: "on_failure" },
        { from: "compare_measurements.ready", to: "monotonic_gate.measurements" },
        { from: "compare_measurements.failed", to: "rollback_comparison.evidence", condition: "on_failure" },
        { kind: "feedback", from: "monotonic_gate.passed", to: "target_gate.measurement", max_traversals: "{{max_iterations}}" },
        { from: "monotonic_gate.failed", to: "rollback_regression.evidence", condition: "on_failure" },
        { from: "rollback_regression.rolled_back", to: "rollback_regression_done.result" },
        { from: "rollback_regression.failed", to: "rollback_regression_failed.result", condition: "on_failure" },
        { from: "rollback_comparison.rolled_back", to: "rollback_comparison_done.result" },
        { from: "rollback_comparison.failed", to: "rollback_comparison_failed.result", condition: "on_failure" },
        { from: "rollback_measurement.rolled_back", to: "rollback_measurement_done.result" },
        { from: "rollback_measurement.failed", to: "rollback_measurement_failed.result", condition: "on_failure" },
        { from: "enroll_floor.enrolled", to: "achieved.result" },
        { from: "enroll_floor.conflict", to: "enrollment_failed.result", condition: "on_failure" },
      ],
    },
  },
};

const compost: DAGPatternDefinition = {
  id: "compost",
  version: "1.1.0",
  name: "Compost",
  summary: "Turn repeated failures into a small set of proposed laws, skill changes, or standing goals.",
  intent: "Let operational evidence improve the system while keeping policy changes behind explicit review.",
  ...patternContract({
    category: "governance",
    invariants: ["proposals are bounded", "policy changes never apply before authenticated approval", "approval survives restart"],
    external_dependencies: [{ id: "failure-ledgers", required: true, description: "Failed runs, trust, and goal evidence" }, { id: "human-approval", required: true, description: "Durable Manager approval node" }],
    evidence_contract: { required: ["incident references", "bounded proposals", "proposal hash", "human decision"], success: "authorized actor approves the exact proposal hash" },
    composition_ports: { inputs: ["operational exhaust"], outputs: ["approved", "rejected", "no_change"] },
    failure_semantics: { no_evidence: "no change", rejection: "terminate without apply", expiry: "reject" },
  }),
  roles: [
    { id: "collector", responsibility: "Collect recent failures and rejected work with evidence." },
    { id: "proposer", responsibility: "Produce a bounded set of system-improvement proposals." },
    { id: "reviewer", responsibility: "Present proposals for explicit human acceptance; never auto-apply policy." },
  ],
  typical_uses: ["weekly process review", "recurring failure analysis", "guardrail evolution"],
  avoid_when: ["there is too little evidence", "policy changes may be applied without human ownership"],
  required_primitives: ["condition_gateway", "bounded proposal contract", "durable approval gateway"],
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
    authorized_actor: { type: "string", description: "Actor identity allowed to sign the proposal hash.", default: "owner" },
  },
  source: DAG_PATTERN_SOURCE,
  workflow_template: {
    api_version: "homerail.ai/v1",
    kind: "Workflow",
    metadata: { id: "{{workflow_id}}", name: "{{name}}" },
    spec: {
      description: "Evidence-driven process proposals paused behind an authenticated, restart-safe approval.",
      workspace: { mode: "isolated" },
      contracts: {
        Evidence: { type: "object" },
        Proposal: { type: "object", required: ["status", "proposals"], properties: { status: { type: "string", enum: ["proposed", "no_change"] }, proposals: { type: "array", maxItems: "{{max_proposals}}" } } },
      },
      agents: {
        collector: { system: "Normalize supplied failed-run, trust, and standing-goal evidence without inventing incidents. Hand off evidence." },
        proposer: { system: "Produce at most {{max_proposals}} grounded proposals. Hand off recommendation with top-level status proposed or no_change and proposals array. Never approve or apply them." },
      },
      nodes: {
        collect: { kind: "agent", agent: "collector", inputs: { source: { contract: "Evidence" } }, outputs: { evidence: { contract: "Evidence" } } },
        propose: { kind: "agent", agent: "proposer", inputs: { evidence: { contract: "Evidence" } }, outputs: { recommendation: { contract: "Proposal" } } },
        proposal_gate: { kind: "condition", inputs: { recommendation: { contract: "Proposal" } }, outputs: { review: { contract: "Proposal" }, quiet: { contract: "Proposal" } }, config: { field: "status", routes: { proposed: "review", no_change: "quiet" }, default: "quiet" } },
        human_review: { kind: "approval", inputs: { proposal: { contract: "Proposal" } }, outputs: { approved: {}, rejected: {} }, config: { approval_id: "compost-change", proposer_actor: "agent:proposer", authorized_actors: ["{{authorized_actor}}"], approved_port: "approved", rejected_port: "rejected" } },
        applied: { kind: "terminal", outcome: "success", inputs: { result: {} } },
        rejected: { kind: "terminal", outcome: "failure", inputs: { result: {} } },
        no_change: { kind: "terminal", outcome: "success", inputs: { result: { contract: "Proposal" } } },
      },
      edges: [
        { from: "$run.input", to: "collect.source" },
        { from: "collect.evidence", to: "propose.evidence" },
        { from: "propose.recommendation", to: "proposal_gate.recommendation" },
        { from: "proposal_gate.review", to: "human_review.proposal" },
        { from: "proposal_gate.quiet", to: "no_change.result" },
        { from: "human_review.approved", to: "applied.result" },
        { from: "human_review.rejected", to: "rejected.result", condition: "on_failure" },
      ],
    },
  },
};

const definitions = [
  heartbeat,
  issueDiagnosis,
  orchestratorWorkers,
  executorAdvisor,
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
  const parameters = resolveParameters(definition, {});
  return {
    ...clone(definition),
    workflow_template: buildPatternWorkflow(definition, parameters).workflow,
  };
}

export function listDAGPatterns(): DAGPatternSummary[] {
  return definitions.map((definition) => ({
    id: definition.id,
    version: definition.version,
    name: definition.name,
    summary: definition.summary,
    intent: definition.intent,
    category: definition.category,
    invariants: [...definition.invariants],
    external_dependencies: clone(definition.external_dependencies),
    evidence_contract: clone(definition.evidence_contract),
    composition_ports: clone(definition.composition_ports),
    failure_semantics: clone(definition.failure_semantics),
    roles: clone(definition.roles),
    typical_uses: [...definition.typical_uses],
    avoid_when: [...definition.avoid_when],
    required_primitives: [...definition.required_primitives],
    parameters: clone(definition.parameters),
    source: clone(definition.source),
    node_count: Object.keys(
      (definition.workflow_template.spec as Record<string, unknown> | undefined)?.nodes as Record<string, unknown>
        ?? definition.workflow_template.nodes as Record<string, unknown>,
    ).length,
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
  const built = buildPatternWorkflow(definition, parameters);
  return {
    pattern: publicDefinition(definition),
    parameters,
    ...built,
  };
}

function buildPatternWorkflow(
  definition: DAGPatternDefinition,
  parameters: Record<string, string | number | boolean>,
): Omit<InstantiatedDAGPattern, "pattern" | "parameters"> {
  const workflow = interpolate(definition.workflow_template, parameters) as Record<string, unknown>;
  if (workflow.api_version === "homerail.ai/v1") {
    const spec = workflow.spec as Record<string, unknown>;
    spec.pattern = {
      id: definition.id,
      version: definition.version,
      source: definition.source.url,
      parameters,
    };
    const yamlText = YAML.stringify(workflow, { lineWidth: 0 });
    const compilation = compileWorkflowSource(yamlText);
    if (!compilation.valid || !compilation.canonical) {
      throw new Error(`Built-in DAG pattern '${definition.id}' failed WorkflowSpec v1 compilation: ${compilation.diagnostics.map((entry) => `${entry.code} ${entry.path}: ${entry.message}`).join("; ")}`);
    }
    const parsed = projectCanonicalWorkflowToParsedDAG(compilation.canonical);
    const validation = validateGraph(parsed.graph);
    assertGraphValid(parsed.graph);
    return { workflow, yaml_text: yamlText, parsed, validation };
  }
  workflow.pattern = {
    id: definition.id,
    version: definition.version,
    source: definition.source.url,
    parameters,
  };
  const legacyYaml = YAML.stringify(workflow, { lineWidth: 0 });
  const legacyParsed = parseDAGYaml(legacyYaml);
  const legacyCompilation = compileWorkflowSource(legacyYaml);
  if (!legacyCompilation.valid || !legacyCompilation.canonical) {
    throw new Error(`Built-in DAG pattern '${definition.id}' failed legacy compilation: ${legacyCompilation.diagnostics.map((entry) => entry.message).join("; ")}`);
  }
  const v1Workflow = canonicalWorkflowToV1Document(legacyCompilation.canonical);
  const yamlText = YAML.stringify(v1Workflow, { lineWidth: 0 });
  const compilation = compileWorkflowSource(yamlText);
  if (!compilation.valid || !compilation.canonical) {
    throw new Error(`Built-in DAG pattern '${definition.id}' failed WorkflowSpec v1 compilation: ${compilation.diagnostics.map((entry) => `${entry.code} ${entry.path}: ${entry.message}`).join("; ")}`);
  }
  const parsed = projectCanonicalWorkflowToParsedDAG(compilation.canonical);
  assertRuntimeGraphParity(`Built-in DAG pattern '${definition.id}'`, legacyParsed, parsed);
  const validation = validateGraph(parsed.graph);
  assertGraphValid(parsed.graph);
  return {
    workflow: v1Workflow,
    yaml_text: yamlText,
    parsed,
    validation,
  };
}
