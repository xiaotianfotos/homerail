import type { ParsedDAG } from "./graph.js";
import { parseWorkflowSource } from "./workflow-spec-v1.js";

/**
 * Native E2E Fix control flow. Stage adapters execute one operation, never the
 * repair loop. Only a trusted host configuration may supply their argv.
 * This builder is not registered as a ready-to-run asset until durable stage
 * transport and the authenticated evidence store are wired in.
 */
export const E2E_FIX_STAGES = [
  "initialize", "context", "freeze_plan", "capture", "test", "review_evidence",
  "record_candidate_judgment", "publish", "ci", "complete",
] as const;
export type E2eFixStage = typeof E2E_FIX_STAGES[number];

export interface E2eFixWorkflowOptions {
  workflowId: string;
  maxRounds: number;
  stageCommands: Record<E2eFixStage, string[]>;
  stageTimeoutMs?: number;
  /** Synchronous transport exists only for the original control-flow fixture. */
  durableStages?: boolean;
  /** Explicit trusted host transport for planning/judgment and optional fixing. */
  hostCodexCommands?: Record<"plan" | "judge_candidate" | "judge_ci", string[]> & Partial<Record<"fix", string[]>>;
}

// Strict model output shapes. Stage adapters still have to validate scope,
// identity and provenance against their own persisted task, not these claims.
const text = { type: "string", minLength: 1, maxLength: 8000 };
const plan = {
  type: "object", additionalProperties: false, required: ["strategy", "allowed_paths"],
  properties: { strategy: text, allowed_paths: { type: "array", minItems: 1, maxItems: 20, items: text },
    blocked_reason: { ...text, description: "Set when no evidenced repair is possible within the frozen scope. Stops before Fixer; do not propose unrelated edits merely to obtain another CI run." } },
};
const patch = {
  type: "object", additionalProperties: false, required: ["summary", "edits"],
  properties: {
    summary: text,
    edits: { type: "array", minItems: 1, maxItems: 20, items: {
      type: "object", additionalProperties: false, required: ["path", "old", "new"],
      properties: { path: text, old: { type: "string", maxLength: 96000 }, new: { type: "string", maxLength: 96000 } },
    } },
  },
};
const review = {
  type: "object", additionalProperties: false, required: ["vote", "summary", "findings"],
  allOf: [{ if: { properties: { vote: { const: "approve" } } },
    then: { properties: { findings: { type: "array", maxItems: 0 } } } }],
  properties: {
    vote: { enum: ["approve", "request_changes", "abstain"] }, summary: text,
    findings: { type: "array", maxItems: 100, items: text,
      description: "Actionable unresolved defects only; empty for approve. Positive observations belong in summary." },
  },
};
const judgment = {
  type: "object", additionalProperties: false, required: ["verdict", "reason"],
  properties: { verdict: { enum: ["accept", "revise", "pause"] }, reason: text, retry_strategy: text,
    dispositions: { type: "array", maxItems: 100, items: { type: "object", additionalProperties: false,
      required: ["finding_id", "action", "reason", "evidence_sha256"], properties: {
        finding_id: { type: "string", pattern: "^[a-f0-9]{64}$" }, action: { enum: ["dismiss", "revise", "escalate"] }, reason: text,
        evidence_sha256: { type: "array", minItems: 1, maxItems: 20, items: { type: "string", pattern: "^[a-f0-9]{64}$" } },
      } } },
  },
};

export const E2E_FIX_MODEL_CONTRACTS = { Plan: plan, Patch: patch, Review: review, Judgment: judgment };

export function buildE2eFixWorkflow(options: E2eFixWorkflowOptions) {
  if (!Number.isSafeInteger(options.maxRounds) || options.maxRounds < 1 || options.maxRounds > 20) {
    throw new Error("E2E Fix maxRounds must be an integer from 1 to 20");
  }
  const timeout = options.stageTimeoutMs ?? 30_000;
  if (!Number.isSafeInteger(timeout) || timeout < 100 || timeout > 3_600_000) throw new Error("invalid stage timeout");
  const nodes: Record<string, unknown> = {};
  const edges: Record<string, unknown>[] = [];
  const edge = (from: string, to: string) => edges.push({ from, to });
  const inputs = (...names: string[]) => Object.fromEntries(names.map(name => [name, {}]));
  const command = (name: E2eFixStage, ports: string[]) => {
    const argv = options.stageCommands[name];
    if (!Array.isArray(argv) || !argv.length || argv.some(v => typeof v !== "string" || !v || v.includes("\0"))) {
      throw new Error(`missing trusted argv for ${name}`);
    }
    nodes[name] = {
      kind: "command", inputs: inputs(...ports), outputs: { ready: {}, failed: {} },
      config: { command: [...argv], durable: options.durableStages !== false,
        stdin_field: "$inputs", timeout_ms: timeout, capture_limit: 96000,
        parse_stdout: "json", result_payload: "value", success_port: "ready", failure_port: "failed" },
    };
    nodes[`${name}_failed`] = { kind: "terminal", outcome: "failure", inputs: { evidence: {} } };
    edges.push({ from: `${name}.failed`, to: `${name}_failed.evidence`, condition: "on_failure" });
  };
  const actor = (node: string, agent: string, contract: string) => {
    if (options.hostCodexCommands && (["plan", "judge_candidate", "judge_ci"].includes(node) || (node === "fix" && options.hostCodexCommands.fix !== undefined))) {
      const argv = options.hostCodexCommands[node as keyof typeof options.hostCodexCommands];
      if (!argv?.length || argv.some(v => typeof v !== "string" || !v || v.includes("\0"))) throw new Error("invalid host Codex argv");
      nodes[node] = { kind: "command", inputs: { evidence: {} }, outputs: { result: { contract }, failed: {} },
        config: { command: [...argv], durable: true, stdin_field: "$inputs", timeout_ms: timeout,
          capture_limit: 96000, parse_stdout: "json", result_payload: "value", success_port: "result", failure_port: "failed" } };
      nodes[`${node}_failed`] = { kind: "terminal", outcome: "failure", inputs: { evidence: {} } };
      edges.push({ from: `${node}.failed`, to: `${node}_failed.evidence`, condition: "on_failure" });
      return;
    }
    nodes[node] = { kind: "agent", agent, session_scope: "dispatch", allowed_dag_tools: ["handoff"],
      allowed_builtin_tools: [], codex_sandbox: "read-only",
      inputs: { evidence: {} }, outputs: { result: { contract } } };
  };
  const route = (name: string, field: string, routes: Record<string, string>, fallback: string) => {
    nodes[name] = { kind: "condition", inputs: { state: {} },
      outputs: inputs(...new Set([...Object.values(routes), fallback])),
      config: { field, routes, default: fallback } };
  };
  // These joins aggregate evidence, not approvals. The trusted stage evaluates
  // votes and the frozen completion policy; a routing join can never approve.
  const collect = (name: string, mode: "all" | "any", ports: string[]) => {
    nodes[name] = { kind: "join", inputs: inputs(...ports), outputs: { ready: {} },
      config: { mode, passed_port: "ready", failed_port: "ready" } };
  };
  const feedback = (from: string) => edges.push({ kind: "feedback", from,
    to: "cycle.state", max_traversals: options.maxRounds });

  command("initialize", ["task"]);
  (nodes.initialize as { inputs: object }).inputs = { task: { contract: "TaskReference" } };
  nodes.cycle = { kind: "while", inputs: { state: {} }, outputs: { next: {}, done: {}, exhausted: {} },
    config: { field: "status", operator: "eq", value: "complete", continue_port: "next",
      done_port: "done", exhausted_port: "exhausted", max_iterations: options.maxRounds } };
  command("context", ["cycle"]);
  actor("plan", "planner", "Plan");
  command("freeze_plan", ["context", "plan"]);
  actor("fix", "fixer", "Patch");
  (nodes.fix as { outputs: Record<string, unknown> }).outputs.failed = {};
  command("capture", ["plan", "patch", "failure"]);
  command("test", ["candidate"]);
  route("test_route", "outcome", { passed: "review", code_failure: "judge", proposal_rejected: "judge", model_failure: "judge" }, "pause");
  for (const id of ["a", "b", "c"]) actor(`review_${id}`, `reviewer_${id}`, "Review");
  collect("reviews", "all", ["a", "b", "c"]);
  command("review_evidence", ["reports", "test"]);
  collect("candidate_evidence", "any", ["test", "reviews"]);
  actor("judge_candidate", "judger", "Judgment");
  command("record_candidate_judgment", ["judgment", "evidence"]);
  route("candidate_route", "action", { revise: "revise", publish: "publish" }, "pause");
  command("publish", ["decision"]);
  command("ci", ["publication"]);
  actor("judge_ci", "judger", "Judgment");
  command("complete", ["ci", "judgment"]);
  route("completion_route", "action", { complete: "complete", revise: "revise" }, "pause");
  // A join waits for all predecessors to settle. Do not join a terminal route
  // to the still-RUNNING cycle: it would wait for feedback that never arrives.
  for (const id of ["cycle_paused", "test_route_paused", "candidate_route_paused", "completion_route_paused"]) {
    nodes[id] = { kind: "terminal", outcome: "cancelled", inputs: { evidence: {} } };
  }
  for (const id of ["done", "cycle_done"]) {
    nodes[id] = { kind: "terminal", outcome: "success", inputs: { evidence: {} } };
  }
  edge("$run.input", "initialize.task");
  edge("initialize.ready", "cycle.state");
  edge("cycle.next", "context.cycle");
  edge("cycle.done", "cycle_done.evidence");
  edge("cycle.exhausted", "cycle_paused.evidence");
  edge("context.ready", "plan.evidence");
  edge("context.ready", "freeze_plan.context");
  edge("plan.result", "freeze_plan.plan");
  edge("freeze_plan.ready", "fix.evidence");
  edge("freeze_plan.ready", "capture.plan");
  edge("fix.result", "capture.patch");
  // Host model execution failures have durable command evidence, not Worker
  // chat diagnostics. Preserve their terminal failure route without replay.
  if (!options.hostCodexCommands?.fix) edges.push({ from: "fix.failed", to: "capture.failure", condition: "on_failure" });
  edge("capture.ready", "test.candidate");
  edge("test.ready", "test_route.state");
  for (const id of ["a", "b", "c"]) {
    edge("test_route.review", `review_${id}.evidence`);
    edge(`review_${id}.result`, `reviews.${id}`);
  }
  edge("reviews.ready", "review_evidence.reports");
  edge("test_route.review", "review_evidence.test");
  edge("test_route.judge", "candidate_evidence.test");
  edge("review_evidence.ready", "candidate_evidence.reviews");
  edge("candidate_evidence.ready", "judge_candidate.evidence");
  edge("candidate_evidence.ready", "record_candidate_judgment.evidence");
  edge("judge_candidate.result", "record_candidate_judgment.judgment");
  edge("record_candidate_judgment.ready", "candidate_route.state");
  feedback("candidate_route.revise");
  edge("candidate_route.publish", "publish.decision");
  edge("publish.ready", "ci.publication");
  edge("ci.ready", "judge_ci.evidence");
  edge("ci.ready", "complete.ci");
  edge("judge_ci.result", "complete.judgment");
  edge("complete.ready", "completion_route.state");
  edge("completion_route.complete", "done.evidence");
  feedback("completion_route.revise");
  for (const name of ["test_route", "candidate_route", "completion_route"]) edge(`${name}.pause`, `${name}_paused.evidence`);


  return {
    api_version: "homerail.ai/v1", kind: "Workflow",
    metadata: { id: options.workflowId, name: "E2E Fix" },
    spec: {
      description: "Bounded native repair/review/CI loop; trusted stages own evidence and side effects.",
      // Native handoffs include program/gateway nodes, not just model calls.
      // Freeze enough bounded admission for the full worst-case round path.
      policies: { max_parallelism: 3, max_dispatches: options.maxRounds * 7,
        max_corrections_per_node: 1,
        max_handoffs: options.maxRounds * 24 + 4, max_edge_traversals: options.maxRounds },
      contracts: { TaskReference: { type: "object", required: ["task_id"], properties: { task_id: text } }, Plan: plan, Patch: patch, Review: review, Judgment: judgment },
      agents: {
        planner: { system: "You are the Codex Planner. Propose a bounded strategy and allowed paths using the supplied issue, source and prior evidence. Apply the Judger retry_strategy to every revision. If the failure cannot be addressed within frozen scope or lacks a causal connection to a proposed change, set blocked_reason and retain the allowed scope without proposing unrelated cleanup. When previous.evidence.stagnation.action is replan, change the previous strategy or scope using the retained failure; cosmetic whitespace changes are rejected before Fixer dispatch. Return Plan via handoff; do not claim tests ran." },
        fixer: { system: "Apply the supplied frozen Codex plan by proposing minimal exact old/new edits. Use short uniquely matching snippets, never repeat an entire existing file when a local edit suffices. Multiple edits to one file are allowed only when each old snippet matches the supplied original source exactly once and their ranges do not overlap; do not target text introduced by another edit. Return Patch via handoff. Do not expand scope, execute publication or approve your own work." },
        ...Object.fromEntries(["a", "b", "c"].map(id => [`reviewer_${id}`, {
          system: "Independently review this candidate and its test evidence. Return Review via handoff. findings contains actionable unresolved defects only; put positive observations and review coverage in summary. An approve vote requires findings: []; use request_changes for defects and abstain for insufficient evidence. Do not modify files, invent execution evidence, or consult another reviewer vote.",
        }])),
        judger: { system: "You are the Codex Judger. Evaluate supplied authoritative evidence, distinguish code failure from infrastructure/unknown, and return accept/revise/pause with reasons. An accept proposal is still checked by trusted program policy. Do not change policy or publish directly." },
      },
      nodes, edges,
    },
  };
}

export function parseE2eFixWorkflow(options: E2eFixWorkflowOptions): ParsedDAG {
  return parseWorkflowSource(JSON.stringify(buildE2eFixWorkflow(options)));
}
