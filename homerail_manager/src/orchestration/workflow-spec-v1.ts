import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { LineCounter, isNode, parseDocument, type Document } from "yaml";
import { Value } from "@sinclair/typebox/value";
import type {
  DAGAgentConfig,
  DAGGraphNode,
  DAGEdge,
  ParsedDAG,
} from "./graph.js";
import { parseDAGYaml } from "./yaml-loader.js";
import { assertGraphValid } from "./graph-validator.js";
import { validateJsonContractSchema } from "./json-contract.js";
import {
  WORKFLOW_API_VERSION,
  WORKFLOW_COMPILER_VERSION,
  WORKFLOW_KIND,
  WorkflowSpecV1Schema,
  type WorkflowSpecV1,
  type WorkflowSpecV1Edge,
  type WorkflowSpecV1Node,
} from "./workflow-spec-v1-schema.js";

export type WorkflowSourceVersion = typeof WORKFLOW_API_VERSION | "legacy/v0";
export type WorkflowSourceFormat = "yaml" | "json";
const FAILURE_PORT_NAMES = new Set(["failed", "failure", "rejected", "error"]);

export interface WorkflowDiagnostic {
  severity: "error" | "warning";
  code: string;
  path: string;
  message: string;
  line?: number;
  column?: number;
  hint?: string;
}

export interface CanonicalPort {
  name: string;
  contract?: string;
  description?: string;
}

export interface CanonicalNode {
  id: string;
  kind: "agent" | "command" | "approval" | "state" | "fanout" | "condition" | "join" | "foreach" | "while" | "terminal";
  description?: string;
  agent?: string;
  depends_on: string[];
  inputs: CanonicalPort[];
  outputs: CanonicalPort[];
  config?: Record<string, unknown>;
  outcome?: "success" | "failure" | "cancelled";
  reason?: string;
}

export interface CanonicalEdge {
  id: string;
  kind: "data" | "control" | "feedback";
  from: { node: string; port: string };
  to: { node: string; port: string };
  condition: "on_success" | "on_failure" | "always";
  retry: { max_retries: number };
  max_traversals?: number;
}

export interface CanonicalWorkflowIR {
  ir_version: "1";
  source_api_version: WorkflowSourceVersion;
  compiler_version: typeof WORKFLOW_COMPILER_VERSION;
  workflow_id: string;
  name: string;
  description?: string;
  labels: Record<string, string>;
  annotations: Record<string, string>;
  workspace: { mode: "isolated" | "shared" };
  contracts: Record<string, unknown>;
  triggers: Record<string, {
    type: "interval" | "event";
    every_ms?: number;
    event?: string;
    overlap: "skip" | "allow";
    max_concurrency: number;
    enabled: boolean;
  }>;
  agents: Record<string, {
    description?: string;
    system?: string;
    skills: string[];
  }>;
  pattern?: {
    id: string;
    version: string;
    source?: string;
    parameters: Record<string, unknown>;
  };
  policies: {
    max_nodes: number;
    max_edges: number;
    max_parallelism: number;
    max_dispatches: number;
    max_handoffs: number;
    max_corrections_per_node: number;
    max_edge_traversals: number;
    max_tool_calls_per_node: number;
  };
  nodes: CanonicalNode[];
  edges: CanonicalEdge[];
  entry_nodes: string[];
  terminal_nodes: string[];
  feedback_edges: string[];
  legacy_compat?: {
    meta: Record<string, unknown>;
    graph: Record<string, unknown>;
    loop_sources: string[];
  };
}

export interface WorkflowCompilationResult {
  valid: boolean;
  source_format: WorkflowSourceFormat;
  source_api_version?: WorkflowSourceVersion;
  diagnostics: WorkflowDiagnostic[];
  canonical?: CanonicalWorkflowIR;
  canonical_json?: string;
  canonical_hash?: string;
  summary?: {
    workflow_id: string;
    node_count: number;
    edge_count: number;
    entry_nodes: string[];
    terminal_nodes: string[];
  };
}

interface SourceContext {
  document: Document.Parsed;
  lineCounter: LineCounter;
}

function sourceFormat(source: string): WorkflowSourceFormat {
  return source.trimStart().startsWith("{") ? "json" : "yaml";
}

function pointerParts(path: string): Array<string | number> {
  if (!path || path === "/") return [];
  return path
    .split("/")
    .slice(1)
    .map((part) => part.replace(/~1/g, "/").replace(/~0/g, "~"))
    .map((part) => /^\d+$/.test(part) ? Number(part) : part);
}

function sourcePosition(context: SourceContext, path: string): { line?: number; column?: number } {
  let parts = pointerParts(path);
  while (parts.length >= 0) {
    const node = context.document.getIn(parts, true);
    if (isNode(node) && node.range) {
      const position = context.lineCounter.linePos(node.range[0]);
      return { line: position.line, column: position.col };
    }
    if (parts.length === 0) break;
    parts = parts.slice(0, -1);
  }
  return {};
}

function diagnostic(
  context: SourceContext,
  value: Omit<WorkflowDiagnostic, "line" | "column">,
): WorkflowDiagnostic {
  return { ...value, ...sourcePosition(context, value.path) };
}

function parseSource(source: string): {
  context?: SourceContext;
  value?: unknown;
  diagnostics: WorkflowDiagnostic[];
} {
  const lineCounter = new LineCounter();
  const document = parseDocument(source, {
    lineCounter,
    prettyErrors: false,
    strict: true,
    uniqueKeys: true,
  });
  const diagnostics: WorkflowDiagnostic[] = [];
  for (const error of document.errors) {
    const position = error.pos?.[0] !== undefined ? lineCounter.linePos(error.pos[0]) : undefined;
    diagnostics.push({
      severity: "error",
      code: "DAG_PARSE_INVALID_SOURCE",
      path: "/",
      message: error.message,
      ...(position ? { line: position.line, column: position.col } : {}),
    });
  }
  for (const warning of document.warnings) {
    const position = warning.pos?.[0] !== undefined ? lineCounter.linePos(warning.pos[0]) : undefined;
    diagnostics.push({
      severity: "error",
      code: "DAG_PARSE_UNSUPPORTED_YAML",
      path: "/",
      message: warning.message,
      ...(position ? { line: position.line, column: position.col } : {}),
    });
  }
  if (diagnostics.length > 0) return { diagnostics };
  try {
    return {
      context: { document, lineCounter },
      value: document.toJS({ maxAliasCount: 0 }),
      diagnostics,
    };
  } catch (error) {
    return {
      diagnostics: [{
        severity: "error",
        code: "DAG_PARSE_INVALID_SOURCE",
        path: "/",
        message: error instanceof Error ? error.message : String(error),
      }],
    };
  }
}

function schemaErrorCode(message: string): string {
  const normalized = message.toLowerCase();
  if (normalized.includes("unexpected property")) return "DAG_SCHEMA_UNKNOWN_FIELD";
  if (normalized.includes("required property")) return "DAG_SCHEMA_REQUIRED_FIELD";
  return "DAG_SCHEMA_INVALID_FIELD";
}

function schemaDiagnostics(context: SourceContext, value: unknown): WorkflowDiagnostic[] {
  return [...Value.Errors(WorkflowSpecV1Schema, value)].map((error) => diagnostic(context, {
    severity: "error",
    code: schemaErrorCode(error.message),
    path: error.path || "/",
    message: error.message,
  }));
}

function splitPortReference(reference: string): { node: string; port: string } {
  if (reference === "$run.input") return { node: "$run", port: "input" };
  const index = reference.lastIndexOf(".");
  return { node: reference.slice(0, index), port: reference.slice(index + 1) };
}

function portEntries(ports: Record<string, { contract?: string; description?: string }> | undefined): CanonicalPort[] {
  return Object.entries(ports ?? {})
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, port]) => ({
      name,
      ...(port.contract ? { contract: port.contract } : {}),
      ...(port.description ? { description: port.description } : {}),
    }));
}

function nodePorts(node: WorkflowSpecV1Node, direction: "inputs" | "outputs"): Record<string, { contract?: string }> {
  if (direction === "inputs") return node.inputs ?? {};
  if (node.kind === "terminal") return {};
  return node.outputs ?? {};
}

function isFeedbackEdge(edge: WorkflowSpecV1Edge): edge is Extract<WorkflowSpecV1Edge, { kind: "feedback" }> {
  return "kind" in edge && edge.kind === "feedback";
}

function semanticDiagnostics(context: SourceContext, workflow: WorkflowSpecV1): WorkflowDiagnostic[] {
  const diagnostics: WorkflowDiagnostic[] = [];
  const nodes = workflow.spec.nodes;
  const agents = workflow.spec.agents;
  const contracts = workflow.spec.contracts ?? {};

  const add = (path: string, code: string, message: string, hint?: string) => {
    diagnostics.push(diagnostic(context, {
      severity: "error",
      code,
      path,
      message,
      ...(hint ? { hint } : {}),
    }));
  };

  for (const [contractName, contract] of Object.entries(contracts)) {
    const validation = validateJsonContractSchema(contract);
    if (!validation.valid) {
      add(
        `/spec/contracts/${contractName}`,
        "DAG_SEMANTIC_INVALID_CONTRACT",
        `invalid JSON Schema contract '${contractName}': ${validation.details}`,
      );
    }
  }

  for (const [nodeId, node] of Object.entries(nodes)) {
    const nodePath = `/spec/nodes/${nodeId}`;
    if (node.kind === "agent" && !agents[node.agent]) {
      add(`${nodePath}/agent`, "DAG_SEMANTIC_UNKNOWN_AGENT", `unknown agent '${node.agent}'`);
    }
    if (node.kind === "agent") {
      const advisorIds = new Set<string>();
      for (let index = 0; index < (node.advisors ?? []).length; index++) {
        const advisor = node.advisors![index];
        if (!agents[advisor.agent]) {
          add(`${nodePath}/advisors/${index}/agent`, "DAG_SEMANTIC_UNKNOWN_AGENT", `unknown advisor agent '${advisor.agent}'`);
        }
        if (advisorIds.has(advisor.id)) {
          add(`${nodePath}/advisors/${index}/id`, "DAG_SEMANTIC_DUPLICATE_ADVISOR", `duplicate advisor id '${advisor.id}'`);
        }
        advisorIds.add(advisor.id);
      }
    }
    for (const dependency of node.depends_on ?? []) {
      if (!nodes[dependency]) {
        add(`${nodePath}/depends_on`, "DAG_SEMANTIC_UNKNOWN_NODE", `unknown dependency '${dependency}'`);
      } else if (dependency === nodeId) {
        add(`${nodePath}/depends_on`, "DAG_SEMANTIC_SELF_DEPENDENCY", "a node cannot depend on itself");
      }
    }
    for (const direction of ["inputs", "outputs"] as const) {
      for (const [portName, port] of Object.entries(nodePorts(node, direction))) {
        if (port.contract && !contracts[port.contract]) {
          add(
            `${nodePath}/${direction}/${portName}/contract`,
            "DAG_SEMANTIC_UNKNOWN_CONTRACT",
            `unknown contract '${port.contract}'`,
          );
        }
      }
    }
    if (node.kind === "condition") {
      const outputs = nodePorts(node, "outputs");
      for (const [value, port] of Object.entries(node.config.routes)) {
        if (!outputs[port]) {
          add(`${nodePath}/config/routes/${value}`, "DAG_SEMANTIC_UNKNOWN_PORT", `unknown output port '${port}'`);
        }
      }
      if (node.config.default && !outputs[node.config.default]) {
        add(`${nodePath}/config/default`, "DAG_SEMANTIC_UNKNOWN_PORT", `unknown output port '${node.config.default}'`);
      }
    }
    if (node.kind === "join") {
      if (node.config.mode === "n_of_m" && node.config.threshold === undefined) {
        add(`${nodePath}/config/threshold`, "DAG_SEMANTIC_REQUIRED_THRESHOLD", "n_of_m join requires threshold");
      }
      if (node.config.mode !== "n_of_m" && node.config.threshold !== undefined) {
        add(`${nodePath}/config/threshold`, "DAG_SEMANTIC_INVALID_THRESHOLD", "threshold is only valid for n_of_m join");
      }
    }
    if (node.kind === "command") {
      if (!node.config.command && !node.config.command_field) {
        add(`${nodePath}/config`, "DAG_SEMANTIC_REQUIRED_COMMAND", "command requires command or command_field");
      }
      if (node.config.command && node.config.command_field) {
        add(`${nodePath}/config`, "DAG_SEMANTIC_AMBIGUOUS_COMMAND", "command and command_field are mutually exclusive");
      }
      const outputs = nodePorts(node, "outputs");
      for (const key of ["success_port", "failure_port"] as const) {
        const port = node.config[key];
        if (!outputs[port]) add(`${nodePath}/config/${key}`, "DAG_SEMANTIC_UNKNOWN_PORT", `unknown output port '${port}'`);
      }
    }
    if (node.kind === "approval") {
      const outputs = nodePorts(node, "outputs");
      if (node.config.authorized_actors.includes(node.config.proposer_actor)) {
        add(
          `${nodePath}/config/authorized_actors`,
          "DAG_SEMANTIC_SELF_APPROVAL",
          `proposer actor '${node.config.proposer_actor}' cannot be an authorized approver`,
        );
      }
      for (const key of ["approved_port", "rejected_port"] as const) {
        const port = node.config[key];
        if (!outputs[port]) add(`${nodePath}/config/${key}`, "DAG_SEMANTIC_UNKNOWN_PORT", `unknown output port '${port}'`);
      }
    }
    if (node.kind === "state") {
      const outputs = nodePorts(node, "outputs");
      if (!outputs[node.config.success_port]) {
        add(`${nodePath}/config/success_port`, "DAG_SEMANTIC_UNKNOWN_PORT", `unknown output port '${node.config.success_port}'`);
      }
      if (node.config.conflict_port && !outputs[node.config.conflict_port]) {
        add(`${nodePath}/config/conflict_port`, "DAG_SEMANTIC_UNKNOWN_PORT", `unknown output port '${node.config.conflict_port}'`);
      }
      if (node.config.operation === "compare_and_set" && node.config.expected_version === undefined) {
        add(`${nodePath}/config/expected_version`, "DAG_SEMANTIC_REQUIRED_VERSION", "compare_and_set requires expected_version");
      }
      if (node.config.operation === "budget_admit" && node.config.budget_limit === undefined) {
        add(`${nodePath}/config/budget_limit`, "DAG_SEMANTIC_REQUIRED_BUDGET", "budget_admit requires budget_limit");
      }
      if (node.config.operation === "budget_admit" && !node.config.value_field) {
        add(`${nodePath}/config/value_field`, "DAG_SEMANTIC_REQUIRED_BUDGET_AMOUNT", "budget_admit requires value_field for the requested reservation amount");
      }
    }
    if (node.kind === "fanout") {
      const inputs = nodePorts(node, "inputs");
      const outputs = nodePorts(node, "outputs");
      if (!inputs[node.config.input]) {
        add(`${nodePath}/config/input`, "DAG_SEMANTIC_UNKNOWN_PORT", `unknown input port '${node.config.input}'`);
      }
      if (!agents[node.config.worker_agent]) {
        add(`${nodePath}/config/worker_agent`, "DAG_SEMANTIC_UNKNOWN_AGENT", `unknown worker agent '${node.config.worker_agent}'`);
      }
      if (node.config.result_contract && !contracts[node.config.result_contract]) {
        add(
          `${nodePath}/config/result_contract`,
          "DAG_SEMANTIC_UNKNOWN_CONTRACT",
          `unknown contract '${node.config.result_contract}'`,
        );
      }
      for (const key of ["result_port", "failed_port"] as const) {
        const port = node.config[key];
        if (!outputs[port]) add(`${nodePath}/config/${key}`, "DAG_SEMANTIC_UNKNOWN_PORT", `unknown output port '${port}'`);
      }
      if (node.config.completion === "n_of_m" && node.config.threshold === undefined) {
        add(`${nodePath}/config/threshold`, "DAG_SEMANTIC_REQUIRED_THRESHOLD", "n_of_m fanout requires threshold");
      }
      if (node.config.threshold !== undefined && node.config.threshold > node.config.max_items) {
        add(`${nodePath}/config/threshold`, "DAG_SEMANTIC_INVALID_THRESHOLD", "fanout threshold cannot exceed max_items");
      }
      if (node.config.max_parallelism > node.config.max_items) {
        add(`${nodePath}/config/max_parallelism`, "DAG_SEMANTIC_INVALID_PARALLELISM", "max_parallelism cannot exceed max_items");
      }
    }
    if (node.kind === "foreach") {
      const inputs = nodePorts(node, "inputs");
      const outputs = nodePorts(node, "outputs");
      if (!inputs[node.config.input]) {
        add(`${nodePath}/config/input`, "DAG_SEMANTIC_UNKNOWN_PORT", `unknown input port '${node.config.input}'`);
      }
      for (const key of ["item_port", "done_port"] as const) {
        const port = node.config[key];
        if (!outputs[port]) add(`${nodePath}/config/${key}`, "DAG_SEMANTIC_UNKNOWN_PORT", `unknown output port '${port}'`);
      }
      if (!inputs[node.config.result_port]) {
        add(`${nodePath}/config/result_port`, "DAG_SEMANTIC_UNKNOWN_PORT", `unknown input port '${node.config.result_port}'`);
      }
    }
    if (node.kind === "while") {
      const outputs = nodePorts(node, "outputs");
      for (const key of ["continue_port", "done_port", "exhausted_port"] as const) {
        const port = node.config[key];
        if (port && !outputs[port]) add(`${nodePath}/config/${key}`, "DAG_SEMANTIC_UNKNOWN_PORT", `unknown output port '${port}'`);
      }
    }
  }

  const normalAdjacency = new Map<string, Set<string>>();
  const reverseReachability = new Map<string, Set<string>>();
  const incomingNodeEdges = new Map<string, number>();
  const targetPorts = new Map<string, number>();
  for (const nodeId of Object.keys(nodes)) {
    normalAdjacency.set(nodeId, new Set());
    reverseReachability.set(nodeId, new Set());
    incomingNodeEdges.set(nodeId, 0);
  }

  workflow.spec.edges.forEach((edge, index) => {
    const path = `/spec/edges/${index}`;
    const source = splitPortReference(edge.from);
    const target = splitPortReference(edge.to);
    const sourceNode = source.node === "$run" ? undefined : nodes[source.node];
    const targetNode = target.node === "$run" ? undefined : nodes[target.node];
    if (source.node !== "$run" && !sourceNode) {
      add(`${path}/from`, "DAG_SEMANTIC_UNKNOWN_NODE", `unknown source node '${source.node}'`);
    }
    if (source.node === "$run" && edge.from !== "$run.input") {
      add(`${path}/from`, "DAG_SEMANTIC_INVALID_RUN_PORT", "the only reserved run source is '$run.input'");
    }
    if (target.node === "$run") {
      add(`${path}/to`, "DAG_SEMANTIC_INVALID_RUN_TARGET", "'$run.input' cannot be an edge target");
    } else if (!targetNode) {
      add(`${path}/to`, "DAG_SEMANTIC_UNKNOWN_NODE", `unknown target node '${target.node}'`);
    }
    const sourcePort = sourceNode ? nodePorts(sourceNode, "outputs")[source.port] : undefined;
    const targetPort = targetNode ? nodePorts(targetNode, "inputs")[target.port] : undefined;
    if (sourceNode && !sourcePort) {
      add(`${path}/from`, "DAG_SEMANTIC_UNKNOWN_PORT", `unknown output port '${edge.from}'`);
    }
    if (targetNode && !targetPort) {
      add(`${path}/to`, "DAG_SEMANTIC_UNKNOWN_PORT", `unknown input port '${edge.to}'`);
    }
    if (sourcePort?.contract && targetPort?.contract && sourcePort.contract !== targetPort.contract) {
      add(
        path,
        "DAG_SEMANTIC_CONTRACT_MISMATCH",
        `contract '${sourcePort.contract}' is not compatible with '${targetPort.contract}'`,
        "v1 edges must connect ports that reference the same named contract",
      );
    }
    if (edge.from === "$run.input" && targetPort?.contract === undefined) {
      add(`${path}/to`, "DAG_SEMANTIC_RUN_INPUT_CONTRACT_REQUIRED", "a $run.input target must declare a contract");
    }
    if (sourceNode && targetNode) {
      incomingNodeEdges.set(target.node, (incomingNodeEdges.get(target.node) ?? 0) + 1);
      if (!isFeedbackEdge(edge)) {
        normalAdjacency.get(source.node)?.add(target.node);
      }
      reverseReachability.get(target.node)?.add(source.node);
    }
    const targetKey = `${target.node}.${target.port}`;
    if (!isFeedbackEdge(edge)) {
      targetPorts.set(targetKey, (targetPorts.get(targetKey) ?? 0) + 1);
      if (targetNode?.kind !== "join" && (targetPorts.get(targetKey) ?? 0) > 1) {
        add(`${path}/to`, "DAG_SEMANTIC_IMPLICIT_FAN_IN", `multiple edges target '${targetKey}'; use an explicit join node`);
      }
    }
    if (isFeedbackEdge(edge) && targetNode && targetNode.kind !== "foreach" && targetNode.kind !== "while") {
      add(`${path}/to`, "DAG_SEMANTIC_INVALID_FEEDBACK_TARGET", "feedback edges may target only foreach or while nodes");
    }
  });

  for (const [nodeId, node] of Object.entries(nodes)) {
    if (node.kind === "terminal") continue;
    for (const port of Object.keys(nodePorts(node, "outputs"))) {
      const outgoing = workflow.spec.edges.filter((edge) => splitPortReference(edge.from).node === nodeId && splitPortReference(edge.from).port === port);
      if (outgoing.length === 0) {
        add(`/spec/nodes/${nodeId}/outputs/${port}`, "DAG_SEMANTIC_UNROUTED_OUTPUT", `output port '${nodeId}.${port}' has no edge`);
        continue;
      }
      if (outgoing.some((edge) => {
        const target = splitPortReference(edge.to);
        return nodes[target.node]?.kind === "terminal";
      }) && outgoing.length > 1) {
        add(
          `/spec/nodes/${nodeId}/outputs/${port}`,
          "DAG_SEMANTIC_AMBIGUOUS_TERMINAL",
          `output port '${nodeId}.${port}' cannot target a terminal and another destination`,
        );
      }
    }
  }

  for (const [nodeId, node] of Object.entries(nodes)) {
    for (const dependency of node.depends_on ?? []) {
      if (nodes[dependency]) {
        normalAdjacency.get(dependency)?.add(nodeId);
        reverseReachability.get(nodeId)?.add(dependency);
        incomingNodeEdges.set(nodeId, (incomingNodeEdges.get(nodeId) ?? 0) + 1);
      }
    }
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const findCycle = (nodeId: string): boolean => {
    if (visiting.has(nodeId)) return true;
    if (visited.has(nodeId)) return false;
    visiting.add(nodeId);
    for (const next of normalAdjacency.get(nodeId) ?? []) {
      if (findCycle(next)) return true;
    }
    visiting.delete(nodeId);
    visited.add(nodeId);
    return false;
  };
  for (const nodeId of Object.keys(nodes).sort()) {
    if (findCycle(nodeId)) {
      add("/spec/edges", "DAG_SEMANTIC_UNBOUNDED_CYCLE", "normal data and control edges must be acyclic; use a bounded feedback edge");
      break;
    }
  }

  const terminalNodes = Object.entries(nodes)
    .filter(([, node]) => node.kind === "terminal")
    .map(([id]) => id);
  if (terminalNodes.length === 0) {
    add("/spec/nodes", "DAG_SEMANTIC_TERMINAL_REQUIRED", "workflow must contain at least one terminal node");
  } else {
    const reachesTerminal = new Set(terminalNodes);
    const queue = [...terminalNodes];
    while (queue.length > 0) {
      const current = queue.shift()!;
      for (const predecessor of reverseReachability.get(current) ?? []) {
        if (!reachesTerminal.has(predecessor)) {
          reachesTerminal.add(predecessor);
          queue.push(predecessor);
        }
      }
    }
    for (const [nodeId, node] of Object.entries(nodes)) {
      if (node.kind !== "terminal" && !reachesTerminal.has(nodeId)) {
        add(`/spec/nodes/${nodeId}`, "DAG_SEMANTIC_NO_TERMINAL_PATH", `node '${nodeId}' has no path to a terminal node`);
      }
    }
  }

  const policies = workflow.spec.policies;
  if (policies?.max_nodes !== undefined && Object.keys(nodes).length > policies.max_nodes) {
    add("/spec/policies/max_nodes", "DAG_POLICY_NODE_LIMIT", "workflow node count exceeds max_nodes");
  }
  if (policies?.max_edges !== undefined && workflow.spec.edges.length > policies.max_edges) {
    add("/spec/policies/max_edges", "DAG_POLICY_EDGE_LIMIT", "workflow edge count exceeds max_edges");
  }

  return diagnostics;
}

function canonicalNode(id: string, node: WorkflowSpecV1Node): CanonicalNode {
  const base = {
    id,
    kind: node.kind,
    ...(node.description ? { description: node.description } : {}),
    depends_on: [...(node.depends_on ?? [])].sort(),
    inputs: portEntries(node.inputs),
    outputs: node.kind === "terminal" ? [] : portEntries(node.outputs),
  };
  if (node.kind === "agent") {
    const config = {
      ...(node.advisors ? { advisors: node.advisors } : {}),
      ...(node.workspace_access ? { workspace_access: node.workspace_access } : {}),
    };
    return {
      ...base,
      agent: node.agent,
      ...(Object.keys(config).length > 0 ? { config: deepSort(config) as Record<string, unknown> } : {}),
    };
  }
  if (node.kind === "terminal") {
    return {
      ...base,
      outcome: node.outcome,
      ...(node.reason ? { reason: node.reason } : {}),
    };
  }
  return { ...base, config: deepSort(node.config) as Record<string, unknown> };
}

function canonicalEdge(edge: WorkflowSpecV1Edge, index: number): CanonicalEdge {
  const feedback = isFeedbackEdge(edge);
  const sourcePort = splitPortReference(edge.from).port;
  return {
    id: `edge-${String(index + 1).padStart(4, "0")}`,
    kind: feedback ? "feedback" : "data",
    from: splitPortReference(edge.from),
    to: splitPortReference(edge.to),
    condition: feedback
      ? "on_success"
      : edge.condition ?? (FAILURE_PORT_NAMES.has(sourcePort.toLowerCase()) ? "on_failure" : "on_success"),
    retry: { max_retries: feedback ? 0 : edge.retry?.max_retries ?? 0 },
    ...(feedback ? { max_traversals: edge.max_traversals } : {}),
  };
}

function deepSort(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(deepSort);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, deepSort(entry)]),
  );
}

function canonicalJson(canonical: CanonicalWorkflowIR): string {
  return JSON.stringify(deepSort(canonical));
}

function hashCanonical(json: string): string {
  return createHash("sha256").update(json).digest("hex");
}

function compileV1(workflow: WorkflowSpecV1): CanonicalWorkflowIR {
  const nodes = Object.entries(workflow.spec.nodes)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([id, node]) => canonicalNode(id, node));
  const dataEdges = workflow.spec.edges.map(canonicalEdge);
  const controlEdges: CanonicalEdge[] = [];
  for (const node of nodes) {
    for (const dependency of node.depends_on) {
      controlEdges.push({
        id: "",
        kind: "control",
        from: { node: dependency, port: "done" },
        to: { node: node.id, port: "task" },
        condition: "on_success",
        retry: { max_retries: 0 },
      });
    }
  }
  const edges = [...dataEdges, ...controlEdges]
    .sort((left, right) => {
      const leftKey = `${left.from.node}.${left.from.port}>${left.to.node}.${left.to.port}:${left.kind}`;
      const rightKey = `${right.from.node}.${right.from.port}>${right.to.node}.${right.to.port}:${right.kind}`;
      return leftKey.localeCompare(rightKey);
    })
    .map((edge, index) => ({ ...edge, id: `edge-${String(index + 1).padStart(4, "0")}` }));
  const incoming = new Set(edges.filter((edge) => edge.from.node !== "$run" && edge.kind !== "feedback").map((edge) => edge.to.node));
  return {
    ir_version: "1",
    source_api_version: WORKFLOW_API_VERSION,
    compiler_version: WORKFLOW_COMPILER_VERSION,
    workflow_id: workflow.metadata.id,
    name: workflow.metadata.name,
    ...(workflow.spec.description ? { description: workflow.spec.description } : {}),
    labels: deepSort(workflow.metadata.labels ?? {}) as Record<string, string>,
    annotations: deepSort(workflow.metadata.annotations ?? {}) as Record<string, string>,
    workspace: { mode: workflow.spec.workspace?.mode ?? "isolated" },
    contracts: deepSort(workflow.spec.contracts ?? {}) as Record<string, unknown>,
    triggers: deepSort(Object.fromEntries(Object.entries(workflow.spec.triggers ?? {}).map(([id, trigger]) => [id, {
      ...trigger,
      enabled: trigger.enabled !== false,
    }]))) as CanonicalWorkflowIR["triggers"],
    agents: Object.fromEntries(Object.entries(workflow.spec.agents)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([id, agent]) => [id, {
        ...(agent.description ? { description: agent.description } : {}),
        ...(agent.system ? { system: agent.system } : {}),
        skills: [...(agent.skills ?? [])].sort(),
      }])),
    ...(workflow.spec.pattern ? {
      pattern: {
        id: workflow.spec.pattern.id,
        version: workflow.spec.pattern.version,
        ...(workflow.spec.pattern.source ? { source: workflow.spec.pattern.source } : {}),
        parameters: deepSort(workflow.spec.pattern.parameters ?? {}) as Record<string, unknown>,
      },
    } : {}),
    policies: {
      max_nodes: workflow.spec.policies?.max_nodes ?? 1000,
      max_edges: workflow.spec.policies?.max_edges ?? 10_000,
      max_parallelism: workflow.spec.policies?.max_parallelism ?? 32,
      max_dispatches: workflow.spec.policies?.max_dispatches ?? 30,
      max_handoffs: workflow.spec.policies?.max_handoffs ?? 50,
      max_corrections_per_node: workflow.spec.policies?.max_corrections_per_node ?? 2,
      max_edge_traversals: workflow.spec.policies?.max_edge_traversals ?? 3,
      max_tool_calls_per_node: workflow.spec.policies?.max_tool_calls_per_node ?? 0,
    },
    nodes,
    edges,
    entry_nodes: nodes.filter((node) => !incoming.has(node.id)).map((node) => node.id).sort(),
    terminal_nodes: nodes.filter((node) => node.kind === "terminal").map((node) => node.id).sort(),
    feedback_edges: edges.filter((edge) => edge.kind === "feedback").map((edge) => edge.id),
  };
}

function legacyKind(node: DAGGraphNode): CanonicalNode["kind"] {
  if (node.node_type === "condition_gateway") return "condition";
  if (node.node_type === "join_gateway") return "join";
  if (node.node_type === "loop_gateway") return "foreach";
  if (node.node_type === "while_gateway") return "while";
  return "agent";
}

function legacyTerminalId(edge: DAGEdge, index: number): string {
  const raw = `terminal-${edge.from_node}-${edge.from_port}-${index + 1}`
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return raw || `terminal-${index + 1}`;
}

function compileLegacy(parsed: ParsedDAG): CanonicalWorkflowIR {
  const inputPorts = new Map<string, Set<string>>();
  for (const edge of parsed.graph.edges) {
    if (edge.to_node && edge.label !== "after_dep") {
      if (!inputPorts.has(edge.to_node)) inputPorts.set(edge.to_node, new Set());
      inputPorts.get(edge.to_node)?.add(edge.to_port);
    }
  }
  const nodes: CanonicalNode[] = parsed.graph.nodes.map((node) => ({
    id: node.node_id,
    kind: legacyKind(node),
    ...(node.description ? { description: node.description } : {}),
    ...(legacyKind(node) === "agent" ? { agent: node.agent } : {}),
    depends_on: [...node.after].sort(),
    inputs: [...(inputPorts.get(node.node_id) ?? [])].sort().map((name) => ({ name })),
    outputs: Object.keys(node.outputs).sort().map((name) => ({ name })),
    ...(legacyKind(node) !== "agent" ? { config: deepSort(node.gateway_config ?? {}) as Record<string, unknown> } : {}),
  }));
  const sourceNodes = new Map(parsed.graph.nodes.map((node) => [node.node_id, node]));
  const edges: CanonicalEdge[] = [];
  parsed.graph.edges.forEach((edge, index) => {
    if (!edge.to_node) {
      const terminalId = legacyTerminalId(edge, index);
      nodes.push({
        id: terminalId,
        kind: "terminal",
        depends_on: [],
        inputs: [{ name: edge.to_port || edge.from_port }],
        outputs: [],
        outcome: edge.condition === "on_failure" ? "failure" : "success",
      });
      edges.push({
        id: "",
        kind: "data",
        from: { node: edge.from_node, port: edge.from_port },
        to: { node: terminalId, port: edge.to_port || edge.from_port },
        condition: edge.condition as CanonicalEdge["condition"],
        retry: { max_retries: edge.retry_policy?.max_retries ?? 0 },
      });
      return;
    }
    const feedback = parsed.loop_sources.includes(edge.to_node) &&
      sourceNodes.get(edge.from_node)?.after.includes(edge.to_node);
    edges.push({
      id: "",
      kind: edge.label === "after_dep" ? "control" : feedback ? "feedback" : "data",
      from: { node: edge.from_node, port: edge.from_port },
      to: { node: edge.to_node, port: edge.to_port },
      condition: edge.condition as CanonicalEdge["condition"],
      retry: { max_retries: edge.retry_policy?.max_retries ?? 0 },
      ...(feedback ? { max_traversals: edge.retry_policy?.max_retries ?? 3 } : {}),
    });
  });
  edges.sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  edges.forEach((edge, index) => { edge.id = `edge-${String(index + 1).padStart(4, "0")}`; });
  nodes.sort((left, right) => left.id.localeCompare(right.id));
  const incoming = new Set(edges.filter((edge) => edge.kind !== "feedback").map((edge) => edge.to.node));
  const metaAgents = parsed.meta.agents ?? {};
  return {
    ir_version: "1",
    source_api_version: "legacy/v0",
    compiler_version: WORKFLOW_COMPILER_VERSION,
    workflow_id: parsed.meta.workflow_id ?? parsed.meta.name,
    name: parsed.meta.name,
    ...(parsed.meta.description ? { description: parsed.meta.description } : {}),
    labels: {},
    annotations: {},
    workspace: { mode: "isolated" },
    contracts: {},
    triggers: {},
    agents: Object.fromEntries(Object.entries(metaAgents)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([id, agent]) => [id, {
        ...(agent.description ? { description: agent.description } : {}),
        ...(agent.system ? { system: agent.system } : {}),
        skills: [...(agent.skills ?? [])].sort(),
      }])),
    ...(parsed.meta.pattern ? {
      pattern: {
        id: parsed.meta.pattern.id,
        version: parsed.meta.pattern.version,
        ...(parsed.meta.pattern.source ? { source: parsed.meta.pattern.source } : {}),
        parameters: deepSort(parsed.meta.pattern.parameters ?? {}) as Record<string, unknown>,
      },
    } : {}),
    policies: {
      max_nodes: 1000,
      max_edges: 10_000,
      max_parallelism: 32,
      max_dispatches: 30,
      max_handoffs: 50,
      max_corrections_per_node: 2,
      max_edge_traversals: 3,
      max_tool_calls_per_node: 0,
    },
    nodes,
    edges,
    entry_nodes: nodes.filter((node) => !incoming.has(node.id)).map((node) => node.id).sort(),
    terminal_nodes: nodes.filter((node) => node.kind === "terminal").map((node) => node.id).sort(),
    feedback_edges: edges.filter((edge) => edge.kind === "feedback").map((edge) => edge.id),
    legacy_compat: deepSort({
      meta: parsed.meta,
      graph: parsed.graph,
      loop_sources: parsed.loop_sources,
    }) as CanonicalWorkflowIR["legacy_compat"],
  };
}

function resultForCanonical(
  source_format: WorkflowSourceFormat,
  diagnostics: WorkflowDiagnostic[],
  canonical: CanonicalWorkflowIR,
): WorkflowCompilationResult {
  const json = canonicalJson(canonical);
  return {
    valid: diagnostics.every((entry) => entry.severity !== "error"),
    source_format,
    source_api_version: canonical.source_api_version,
    diagnostics,
    canonical,
    canonical_json: json,
    canonical_hash: hashCanonical(json),
    summary: {
      workflow_id: canonical.workflow_id,
      node_count: canonical.nodes.length,
      edge_count: canonical.edges.length,
      entry_nodes: canonical.entry_nodes,
      terminal_nodes: canonical.terminal_nodes,
    },
  };
}

export function compileWorkflowSource(source: string): WorkflowCompilationResult {
  const format = sourceFormat(source);
  const parsedSource = parseSource(source);
  if (!parsedSource.context || parsedSource.value === undefined) {
    return { valid: false, source_format: format, diagnostics: parsedSource.diagnostics };
  }
  if (!parsedSource.value || typeof parsedSource.value !== "object" || Array.isArray(parsedSource.value)) {
    return {
      valid: false,
      source_format: format,
      diagnostics: [diagnostic(parsedSource.context, {
        severity: "error",
        code: "DAG_SCHEMA_INVALID_ROOT",
        path: "/",
        message: "workflow source root must be an object",
      })],
    };
  }
  const record = parsedSource.value as Record<string, unknown>;
  if (record.api_version === undefined) {
    try {
      const canonical = compileLegacy(parseDAGYaml(source));
      return resultForCanonical(format, [{
        severity: "warning",
        code: "DAG_LEGACY_UNVERSIONED_SOURCE",
        path: "/",
        message: "unversioned workflow accepted through the legacy/v0 adapter",
        hint: `new workflows should use api_version: ${WORKFLOW_API_VERSION}`,
      }], canonical);
    } catch (error) {
      return {
        valid: false,
        source_format: format,
        source_api_version: "legacy/v0",
        diagnostics: [{
          severity: "error",
          code: "DAG_LEGACY_INVALID_WORKFLOW",
          path: "/",
          message: error instanceof Error ? error.message : String(error),
        }],
      };
    }
  }
  if (record.api_version !== WORKFLOW_API_VERSION || record.kind !== WORKFLOW_KIND) {
    return {
      valid: false,
      source_format: format,
      diagnostics: [diagnostic(parsedSource.context, {
        severity: "error",
        code: "DAG_SCHEMA_UNSUPPORTED_VERSION",
        path: record.api_version !== WORKFLOW_API_VERSION ? "/api_version" : "/kind",
        message: `expected api_version '${WORKFLOW_API_VERSION}' and kind '${WORKFLOW_KIND}'`,
      })],
    };
  }
  const structural = schemaDiagnostics(parsedSource.context, parsedSource.value);
  if (structural.length > 0) {
    return {
      valid: false,
      source_format: format,
      source_api_version: WORKFLOW_API_VERSION,
      diagnostics: structural,
    };
  }
  const workflow = parsedSource.value as WorkflowSpecV1;
  const semantic = semanticDiagnostics(parsedSource.context, workflow);
  if (semantic.length > 0) {
    return {
      valid: false,
      source_format: format,
      source_api_version: WORKFLOW_API_VERSION,
      diagnostics: semantic,
    };
  }
  return resultForCanonical(format, [], compileV1(workflow));
}

export function parseWorkflowSource(source: string): ParsedDAG {
  const compilation = compileWorkflowSource(source);
  if (!compilation.valid || !compilation.canonical) {
    throw new Error(compilation.diagnostics.map((entry) => `${entry.code} ${entry.path}: ${entry.message}`).join("; "));
  }
  return compilation.source_api_version === "legacy/v0"
    ? parseDAGYaml(source)
    : projectCanonicalWorkflowToParsedDAG(compilation.canonical);
}

export function parseWorkflowSourceFile(filePath: string): ParsedDAG {
  return parseWorkflowSource(readFileSync(filePath, "utf8"));
}

export function workflowSchemaHash(): string {
  return createHash("sha256")
    .update(JSON.stringify(deepSort(WorkflowSpecV1Schema)))
    .digest("hex");
}

export function workflowSchemaResponse(): {
  api_version: typeof WORKFLOW_API_VERSION;
  kind: typeof WORKFLOW_KIND;
  compiler_version: typeof WORKFLOW_COMPILER_VERSION;
  schema_hash: string;
  schema: typeof WorkflowSpecV1Schema;
} {
  return {
    api_version: WORKFLOW_API_VERSION,
    kind: WORKFLOW_KIND,
    compiler_version: WORKFLOW_COMPILER_VERSION,
    schema_hash: workflowSchemaHash(),
    schema: WorkflowSpecV1Schema,
  };
}

function runtimeNodeType(kind: CanonicalNode["kind"]): string {
  if (kind === "command") return "command_gateway";
  if (kind === "approval") return "approval_gateway";
  if (kind === "state") return "state_gateway";
  if (kind === "fanout") return "fanout_gateway";
  if (kind === "condition") return "condition_gateway";
  if (kind === "join") return "join_gateway";
  if (kind === "foreach") return "loop_gateway";
  if (kind === "while") return "while_gateway";
  return "agent";
}

function runtimeGatewayConfig(node: CanonicalNode): Record<string, unknown> | undefined {
  if (!node.config) return undefined;
  if (node.kind === "condition") {
    const config = node.config;
    return {
      type: "condition",
      field: config.field,
      routes: config.routes,
      default_port: config.default,
    };
  }
  if (node.kind === "join") return { type: "join", ...node.config };
  if (node.kind === "foreach") return { type: "loop", ...node.config };
  if (node.kind === "while") return { type: "while", ...node.config };
  if (node.kind === "command" || node.kind === "approval" || node.kind === "state" || node.kind === "fanout") {
    return { type: node.kind, ...node.config };
  }
  return undefined;
}

function runtimeOutputRoutes(
  canonical: CanonicalWorkflowIR,
  node: CanonicalNode,
): Record<string, { to: string | string[]; condition: string; retry_policy?: { max_retries: number } }> {
  const terminals = new Map(
    canonical.nodes
      .filter((candidate) => candidate.kind === "terminal")
      .map((candidate) => [candidate.id, candidate]),
  );
  const routes: Record<string, { to: string | string[]; condition: string; retry_policy?: { max_retries: number } }> = {};
  for (const port of node.outputs) {
    const edges = canonical.edges.filter((edge) => edge.kind !== "control" && edge.from.node === node.id && edge.from.port === port.name);
    if (edges.length === 0) continue;
    const targets = edges.map((edge) => terminals.has(edge.to.node) ? "" : `${edge.to.node}.in:${edge.to.port}`);
    routes[port.name] = {
      to: targets.length === 1 ? targets[0] : targets,
      condition: edges[0].condition,
      ...(edges[0].retry.max_retries > 0 ? { retry_policy: { max_retries: edges[0].retry.max_retries } } : {}),
    };
  }
  return routes;
}

export function projectCanonicalWorkflowToParsedDAG(canonical: CanonicalWorkflowIR): ParsedDAG {
  const terminalById = new Map(
    canonical.nodes
      .filter((node) => node.kind === "terminal")
      .map((node) => [node.id, node]),
  );
  const executableNodes = canonical.nodes.filter((node) => node.kind !== "terminal");
  const runtimeEdges: DAGEdge[] = [];
  const dependencyMap = new Map(executableNodes.map((node) => [node.id, new Set(node.depends_on)]));
  const runInputTargets: Array<{ node: string; port: string; contract?: string }> = [];

  for (const edge of canonical.edges) {
    if (edge.kind === "control") {
      if (dependencyMap.has(edge.to.node)) dependencyMap.get(edge.to.node)?.add(edge.from.node);
      runtimeEdges.push({
        from_node: edge.from.node,
        from_port: edge.from.port,
        to_node: edge.to.node,
        to_port: edge.to.port,
        condition: edge.condition,
        label: "after_dep",
      });
      continue;
    }
    if (edge.from.node === "$run") {
      const targetNode = canonical.nodes.find((node) => node.id === edge.to.node);
      const contract = targetNode?.inputs.find((port) => port.name === edge.to.port)?.contract;
      runInputTargets.push({ node: edge.to.node, port: edge.to.port, ...(contract ? { contract } : {}) });
      continue;
    }
    const terminal = terminalById.get(edge.to.node);
    if (!terminal && edge.kind !== "feedback" && dependencyMap.has(edge.to.node)) {
      dependencyMap.get(edge.to.node)?.add(edge.from.node);
    }
    runtimeEdges.push({
      from_node: edge.from.node,
      from_port: edge.from.port,
      to_node: terminal ? "" : edge.to.node,
      to_port: terminal ? "" : edge.to.port,
      condition: edge.condition,
      ...(edge.kind === "feedback"
        ? { retry_policy: { max_retries: edge.max_traversals ?? 1 } }
        : edge.retry.max_retries > 0
          ? { retry_policy: { max_retries: edge.retry.max_retries } }
          : {}),
      ...(terminal?.outcome ? { terminal_outcome: terminal.outcome } : {}),
    });
  }

  // Data edges imply completion dependencies in v1. Materialize the current
  // runtime's control edges so mailbox delivery and readiness remain atomic.
  for (const [nodeId, dependencies] of dependencyMap) {
    for (const dependency of dependencies) {
      const exists = runtimeEdges.some((edge) =>
        edge.label === "after_dep" && edge.from_node === dependency && edge.to_node === nodeId
      );
      if (!exists) {
        runtimeEdges.push({
          from_node: dependency,
          from_port: "done",
          to_node: nodeId,
          to_port: "task",
          condition: "on_success",
          label: "after_dep",
        });
      }
    }
  }

  const graphNodes: DAGGraphNode[] = executableNodes.map((node) => {
    const inputContracts = Object.fromEntries(node.inputs.filter((port) => port.contract).map((port) => [port.name, port.contract!]));
    const outputContracts = Object.fromEntries(node.outputs.filter((port) => port.contract).map((port) => [port.name, port.contract!]));
    return {
      node_id: node.id,
      name: node.id,
      description: node.description ?? "",
      node_type: runtimeNodeType(node.kind),
      agent: node.kind === "agent" ? node.agent ?? "" : "__gateway__",
      after: [...(dependencyMap.get(node.id) ?? [])].sort(),
      outputs: runtimeOutputRoutes(canonical, node),
      gateway_config: runtimeGatewayConfig(node),
      extra: {
        workflow_spec_v1: {
          input_contracts: inputContracts,
          output_contracts: outputContracts,
        },
        ...(node.kind === "agent" && node.config ? { agent_runtime: node.config } : {}),
      },
    };
  });
  const agents = Object.fromEntries(Object.entries(canonical.agents).map(([id, agent]) => [id, {
    ...(agent.description ? { description: agent.description } : {}),
    ...(agent.system ? { system: agent.system } : {}),
    ...(agent.skills.length > 0 ? { skills: agent.skills } : {}),
  } satisfies DAGAgentConfig]));
  const graph = { nodes: graphNodes, edges: runtimeEdges };
  assertGraphValid(graph);
  return {
    meta: {
      name: canonical.name,
      workflow_id: canonical.workflow_id,
      description: canonical.description,
      workspace: canonical.workspace,
      limits: {
        max_nodes: canonical.policies.max_nodes,
        max_dispatches: canonical.policies.max_dispatches,
        max_handoffs: canonical.policies.max_handoffs,
        max_corrections_per_node: canonical.policies.max_corrections_per_node,
        max_edge_traversals: canonical.policies.max_edge_traversals,
        max_tool_calls_per_node: canonical.policies.max_tool_calls_per_node,
      },
      agents,
      pattern: canonical.pattern,
      contracts: canonical.contracts,
      triggers: canonical.triggers,
      run_input_targets: runInputTargets,
      source_api_version: canonical.source_api_version,
      compiler_version: canonical.compiler_version,
    },
    graph,
    loop_sources: canonical.nodes
      .filter((node) => node.kind === "foreach" || node.kind === "while")
      .filter((node) => canonical.edges.some((edge) => edge.kind === "feedback" && edge.to.node === node.id))
      .map((node) => node.id)
      .sort(),
  };
}

function authoringPorts(ports: CanonicalPort[]): Record<string, { contract?: string; description?: string }> | undefined {
  if (ports.length === 0) return undefined;
  return Object.fromEntries(ports.map((port) => [port.name, {
    ...(port.contract ? { contract: port.contract } : {}),
    ...(port.description ? { description: port.description } : {}),
  }]));
}

function configString(config: Record<string, unknown>, key: string, fallback: string): string {
  return typeof config[key] === "string" && config[key] ? String(config[key]) : fallback;
}

function authoringNode(node: CanonicalNode, canonical: CanonicalWorkflowIR): Record<string, unknown> {
  const incomingDataDependencies = new Set(
    canonical.edges
      .filter((edge) => edge.kind === "data" && edge.to.node === node.id && edge.from.node !== "$run")
      .map((edge) => edge.from.node),
  );
  const dependsOn = node.depends_on.filter((dependency) => !incomingDataDependencies.has(dependency));
  const base: Record<string, unknown> = {
    kind: node.kind,
    ...(node.description ? { description: node.description } : {}),
    ...(dependsOn.length > 0 ? { depends_on: dependsOn } : {}),
    ...(authoringPorts(node.inputs) ? { inputs: authoringPorts(node.inputs) } : {}),
    ...(node.kind !== "terminal" && authoringPorts(node.outputs) ? { outputs: authoringPorts(node.outputs) } : {}),
  };
  if (node.kind === "agent") {
    return {
      ...base,
      agent: node.agent,
      ...(Array.isArray(node.config?.advisors) ? { advisors: node.config.advisors } : {}),
      ...(node.config?.workspace_access ? { workspace_access: node.config.workspace_access } : {}),
    };
  }
  if (node.kind === "terminal") {
    return { ...base, outcome: node.outcome ?? "success", ...(node.reason ? { reason: node.reason } : {}) };
  }
  const config = node.config ?? {};
  if (node.kind === "condition") {
    return {
      ...base,
      config: {
        ...(config.field ? { field: config.field } : {}),
        routes: config.routes ?? config.cases ?? {},
        ...(config.default_port || config.default ? { default: config.default_port ?? config.default } : {}),
      },
    };
  }
  if (node.kind === "join") {
    return {
      ...base,
      config: {
        mode: config.mode === "any" || config.mode === "n_of_m" ? config.mode : "all",
        ...(config.field ? { field: config.field } : {}),
        ...(config.success_values ? { success_values: config.success_values } : {}),
        ...(config.threshold ? { threshold: config.threshold } : {}),
        ...(config.passed_port ? { passed_port: config.passed_port } : {}),
        ...(config.failed_port ? { failed_port: config.failed_port } : {}),
      },
    };
  }
  if (node.kind === "command" || node.kind === "approval" || node.kind === "state" || node.kind === "fanout") {
    return { ...base, config };
  }
  if (node.kind === "foreach") {
    const inputs = { ...(base.inputs as Record<string, unknown> | undefined ?? {}) };
    const outputs = { ...(base.outputs as Record<string, unknown> | undefined ?? {}) };
    const input = configString(config, "input", inputs.items ? "items" : Object.keys(inputs)[0] ?? "items");
    const resultPort = configString(config, "result_port", "result");
    const itemPort = configString(config, "item_port", "next_item");
    const donePort = configString(config, "done_port", "done");
    inputs[input] ??= {};
    inputs[resultPort] ??= {};
    outputs[itemPort] ??= {};
    outputs[donePort] ??= {};
    return {
      ...base,
      inputs,
      outputs,
      config: {
        input,
        ...(config.field ? { field: config.field } : {}),
        item_port: itemPort,
        result_port: resultPort,
        done_port: donePort,
        max_items: typeof config.max_items === "number" ? config.max_items : 10_000,
      },
    };
  }
  const outputs = { ...(base.outputs as Record<string, unknown> | undefined ?? {}) };
  const continuePort = configString(config, "continue_port", "continue");
  const donePort = configString(config, "done_port", "done");
  const exhaustedPort = configString(config, "exhausted_port", "exhausted");
  outputs[continuePort] ??= {};
  outputs[donePort] ??= {};
  outputs[exhaustedPort] ??= {};
  return {
    ...base,
    outputs,
    config: {
      ...(config.field ? { field: config.field } : {}),
      operator: configString(config, "operator", "eq"),
      ...(config.value !== undefined ? { value: config.value } : {}),
      continue_port: continuePort,
      done_port: donePort,
      exhausted_port: exhaustedPort,
      max_iterations: typeof config.max_iterations === "number" ? config.max_iterations : 3,
    },
  };
}

export function canonicalWorkflowToV1Document(canonical: CanonicalWorkflowIR): Record<string, unknown> {
  const edges = canonical.edges
    .filter((edge) => edge.kind !== "control")
    .map((edge) => {
      const defaultCondition = FAILURE_PORT_NAMES.has(edge.from.port.toLowerCase()) ? "on_failure" : "on_success";
      if (edge.kind === "feedback") {
        return {
          kind: "feedback",
          from: `${edge.from.node}.${edge.from.port}`,
          to: `${edge.to.node}.${edge.to.port}`,
          max_traversals: edge.max_traversals ?? (edge.retry.max_retries || 3),
        };
      }
      return {
        from: edge.from.node === "$run" ? "$run.input" : `${edge.from.node}.${edge.from.port}`,
        to: `${edge.to.node}.${edge.to.port}`,
        ...(edge.condition !== defaultCondition ? { condition: edge.condition } : {}),
        ...(edge.retry.max_retries > 0 ? { retry: { max_retries: edge.retry.max_retries } } : {}),
      };
    });
  return {
    api_version: WORKFLOW_API_VERSION,
    kind: WORKFLOW_KIND,
    metadata: {
      id: canonical.workflow_id,
      name: canonical.name,
      ...(Object.keys(canonical.labels).length > 0 ? { labels: canonical.labels } : {}),
      ...(Object.keys(canonical.annotations).length > 0 ? { annotations: canonical.annotations } : {}),
    },
    spec: {
      ...(canonical.description ? { description: canonical.description } : {}),
      workspace: canonical.workspace,
      ...(Object.keys(canonical.contracts).length > 0 ? { contracts: canonical.contracts } : {}),
      ...(Object.keys(canonical.triggers).length > 0 ? { triggers: canonical.triggers } : {}),
      agents: Object.fromEntries(Object.entries(canonical.agents).map(([id, agent]) => [id, {
        ...(agent.description ? { description: agent.description } : {}),
        ...(agent.system ? { system: agent.system } : {}),
        ...(agent.skills.length > 0 ? { skills: agent.skills } : {}),
      }])),
      nodes: Object.fromEntries(canonical.nodes.map((node) => [node.id, authoringNode(node, canonical)])),
      edges,
      ...(canonical.pattern ? { pattern: canonical.pattern } : {}),
      ...(_isDefaultPolicies(canonical.policies) ? {} : { policies: canonical.policies }),
    },
  };
}

function _isDefaultPolicies(policies: CanonicalWorkflowIR["policies"]): boolean {
  return policies.max_nodes === 1000 &&
    policies.max_edges === 10_000 &&
    policies.max_parallelism === 32 &&
    policies.max_dispatches === 30 &&
    policies.max_handoffs === 50 &&
    policies.max_corrections_per_node === 2 &&
    policies.max_edge_traversals === 3 &&
    policies.max_tool_calls_per_node === 0;
}
