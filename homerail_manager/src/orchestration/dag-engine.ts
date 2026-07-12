import type { DAGEdge, DAGGraphData, ParsedDAG } from "./graph.js";

export type NodeState =
  | "PENDING"
  | "READY"
  | "RUNNING"
  | "WAITING_FOR_APPROVAL"
  | "COMPLETED"
  | "FAILED"
  | "CANCELLED"
  | "SKIPPED";

export interface DAGRun {
  runId: string;
  graph: DAGGraphData;
  loopSources: Set<string>;
  nodeStates: Map<string, NodeState>;
  handoffedNodes: Set<string>;
  afterSatisfied: Map<string, Set<string>>;
  inputSatisfied: Map<string, Set<string>>;
  mailboxes: Map<string, Map<string, unknown[]>>;
}

export const FAILURE_PORTS = new Set(["failed", "failure", "rejected", "error"]);

export interface DAGTransitionResult {
  affectedNodes: string[];
  routedNodes: string[];
  terminalFailure?: boolean;
  terminalOutcome?: "success" | "failure" | "cancelled";
}

export function isFailurePort(port: string): boolean {
  return FAILURE_PORTS.has(port.toLowerCase());
}

export function edgeMatchesHandoff(edge: DAGEdge, port: string): boolean {
  if (edge.from_port !== port) return false;
  if (edge.condition === "always") return true;
  return isFailurePort(port)
    ? edge.condition === "on_failure"
    : edge.condition !== "on_failure";
}

function _incomingAfterDeps(edges: DAGEdge[], nodeId: string): DAGEdge[] {
  return edges.filter(
    (e) => e.to_node === nodeId && e.label === "after_dep",
  );
}

function _incomingExplicitEdges(edges: DAGEdge[], nodeId: string): DAGEdge[] {
  return edges.filter(
    (e) => e.to_node === nodeId && e.label !== "after_dep",
  );
}

function _incomingExplicitEdgesFrom(
  edges: DAGEdge[],
  nodeId: string,
  fromNode: string,
): DAGEdge[] {
  return _incomingExplicitEdges(edges, nodeId).filter(
    (e) => e.from_node === fromNode,
  );
}

function _initialState(graph: DAGGraphData, nodeId: string): NodeState {
  const deps = _incomingAfterDeps(graph.edges, nodeId);
  return deps.length === 0 ? "READY" : "PENDING";
}

export function createDAGRun(parsedDAG: ParsedDAG, runId: string): DAGRun {
  const nodeStates = new Map<string, NodeState>();
  const afterSatisfied = new Map<string, Set<string>>();
  const inputSatisfied = new Map<string, Set<string>>();
  const mailboxes = new Map<string, Map<string, unknown[]>>();

  for (const node of parsedDAG.graph.nodes) {
    nodeStates.set(node.node_id, _initialState(parsedDAG.graph, node.node_id));
    afterSatisfied.set(node.node_id, new Set<string>());
    inputSatisfied.set(node.node_id, new Set<string>());
    mailboxes.set(node.node_id, new Map<string, unknown[]>());
  }

  return {
    runId,
    graph: parsedDAG.graph,
    loopSources: new Set(parsedDAG.loop_sources),
    nodeStates,
    handoffedNodes: new Set<string>(),
    afterSatisfied,
    inputSatisfied,
    mailboxes,
  };
}

function _ensureMailbox(run: DAGRun, nodeId: string, port: string): unknown[] {
  const nodeBox = run.mailboxes.get(nodeId);
  if (!nodeBox) {
    throw new Error(`Unknown node: ${nodeId}`);
  }
  if (!nodeBox.has(port)) {
    nodeBox.set(port, []);
  }
  return nodeBox.get(port)!;
}

function _tryPromote(run: DAGRun, nodeId: string): void {
  if (run.nodeStates.get(nodeId) !== "PENDING") return;
  const deps = _incomingAfterDeps(run.graph.edges, nodeId);
  const satisfiedDeps = run.afterSatisfied.get(nodeId);
  const satisfied = deps.every((e) => satisfiedDeps?.has(e.from_node));
  if (!satisfied) return;

  const routedInputs = run.inputSatisfied.get(nodeId);
  for (const dep of deps) {
    const explicitFromDep = _incomingExplicitEdgesFrom(
      run.graph.edges,
      nodeId,
      dep.from_node,
    );
    if (explicitFromDep.length > 0 && !routedInputs?.has(dep.from_node)) {
      return;
    }
  }

  run.nodeStates.set(nodeId, "READY");
}

function _skipUntakenSatisfiedBranches(run: DAGRun, nodeId: string): void {
  if (run.nodeStates.get(nodeId) !== "PENDING") return;
  const deps = _incomingAfterDeps(run.graph.edges, nodeId);
  const satisfiedDeps = run.afterSatisfied.get(nodeId);
  const allDepsSatisfied = deps.every((e) => satisfiedDeps?.has(e.from_node));
  if (!allDepsSatisfied) return;

  const routedInputs = run.inputSatisfied.get(nodeId);
  const awaitsFutureLoopPort = deps.some((dep) => {
    if (!run.loopSources.has(dep.from_node) || run.nodeStates.get(dep.from_node) !== "RUNNING") return false;
    const explicitFromDep = _incomingExplicitEdgesFrom(run.graph.edges, nodeId, dep.from_node);
    return explicitFromDep.length > 0 && !routedInputs?.has(dep.from_node);
  });
  if (awaitsFutureLoopPort) return;
  const hasUntakenRequiredInput = deps.some((dep) => {
    const explicitFromDep = _incomingExplicitEdgesFrom(
      run.graph.edges,
      nodeId,
      dep.from_node,
    );
    return explicitFromDep.length > 0 && !routedInputs?.has(dep.from_node);
  });
  if (hasUntakenRequiredInput) {
    run.nodeStates.set(nodeId, "SKIPPED");
    _skipDependentNodes(run, nodeId, true);
  }
}

function _satisfyAfterDeps(run: DAGRun, fromNode: string): Set<string> {
  const affected = new Set<string>();
  for (const edge of run.graph.edges) {
    if (edge.label !== "after_dep" || edge.from_node !== fromNode) continue;
    run.afterSatisfied.get(edge.to_node)?.add(fromNode);
    affected.add(edge.to_node);
  }
  return affected;
}

function _predecessors(run: DAGRun, nodeId: string): string[] {
  return Array.from(new Set(
    run.graph.edges
      .filter((edge) => edge.to_node === nodeId)
      .map((edge) => edge.from_node),
  ));
}

function _hasAlternativePath(run: DAGRun, nodeId: string, excludePred: string): boolean {
  for (const predId of _predecessors(run, nodeId)) {
    if (predId === excludePred) continue;
    const status = run.nodeStates.get(predId);
    if (
      status === "COMPLETED" ||
      status === "RUNNING" ||
      status === "PENDING" ||
      status === "READY"
    ) {
      return true;
    }
  }
  return false;
}

function _skipDependentNodes(run: DAGRun, unavailableNodeId: string, sourceWasSkipped = false): void {
  for (const edge of run.graph.edges) {
    if (edge.from_node !== unavailableNodeId) continue;
    if (!sourceWasSkipped && edge.condition !== "on_success") continue;
    if (!edge.to_node) continue;
    const state = run.nodeStates.get(edge.to_node);
    if (state !== "PENDING" && state !== "READY") continue;
    // An explicit on_failure/always route from the failed node is allowed to
    // wake the same target; a plain after dependency is not.
    if (!sourceWasSkipped) {
      const hasFailureRoute = run.graph.edges.some((candidate) =>
        candidate.from_node === unavailableNodeId &&
        candidate.to_node === edge.to_node &&
        candidate.label !== "after_dep" &&
        (candidate.condition === "on_failure" || candidate.condition === "always")
      );
      if (hasFailureRoute || run.inputSatisfied.get(edge.to_node)?.has(unavailableNodeId)) continue;
    }
    if (_hasAlternativePath(run, edge.to_node, unavailableNodeId)) continue;
    run.nodeStates.set(edge.to_node, "SKIPPED");
    _skipDependentNodes(run, edge.to_node, true);
  }
}

export function resetSkippedSuccessDescendants(run: DAGRun, retriedNodeId: string): void {
  const pending = run.graph.edges
    .filter((edge) => edge.from_node === retriedNodeId && edge.condition === "on_success")
    .map((edge) => edge.to_node)
    .filter(Boolean);
  const visited = new Set<string>();
  while (pending.length > 0) {
    const nodeId = pending.pop()!;
    if (visited.has(nodeId)) continue;
    visited.add(nodeId);
    if (run.nodeStates.get(nodeId) !== "SKIPPED") continue;
    run.nodeStates.set(nodeId, "PENDING");
    run.handoffedNodes.delete(nodeId);
    run.inputSatisfied.set(nodeId, new Set<string>());
    run.mailboxes.set(nodeId, new Map<string, unknown[]>());
    for (const edge of run.graph.edges) {
      if (edge.from_node === nodeId && edge.to_node) pending.push(edge.to_node);
    }
  }
}

export function reconcileFailedDependencies(run: DAGRun): string[] {
  const before = new Map(run.nodeStates);
  for (const [nodeId, state] of before) {
    if (state === "FAILED") _skipDependentNodes(run, nodeId);
  }
  return Array.from(run.nodeStates.entries())
    .filter(([nodeId, state]) => state === "SKIPPED" && before.get(nodeId) !== "SKIPPED")
    .map(([nodeId]) => nodeId)
    .sort();
}

function _wakeLoopSource(run: DAGRun, nodeId: string): void {
  if (!run.loopSources.has(nodeId)) return;
  if (run.nodeStates.get(nodeId) !== "RUNNING") return;
  const mailbox = run.mailboxes.get(nodeId);
  if (!mailbox) return;
  const hasData = Array.from(mailbox.values()).some((v) => v.length > 0);
  if (hasData) {
    for (const [port, values] of mailbox.entries()) {
      if (values.length > 1) {
        mailbox.set(port, [values[values.length - 1]]);
      }
    }
    run.nodeStates.set(nodeId, "READY");
  }
}

function _isLoopGateway(run: DAGRun, nodeId: string): boolean {
  const nodeType = run.graph.nodes.find((node) => node.node_id === nodeId)?.node_type;
  return nodeType === "loop_gateway" || nodeType === "while_gateway";
}

function _resetLoopBodyDescendants(run: DAGRun, loopNodeId: string, entryNodeId: string): void {
  const pending = run.graph.edges
    .filter((edge) => edge.from_node === entryNodeId && edge.label !== "after_dep" && edge.to_node !== loopNodeId)
    .map((edge) => edge.to_node)
    .filter(Boolean);
  const visited = new Set<string>();
  while (pending.length > 0) {
    const nodeId = pending.pop()!;
    if (nodeId === loopNodeId || visited.has(nodeId)) continue;
    visited.add(nodeId);
    run.nodeStates.set(nodeId, "PENDING");
    run.handoffedNodes.delete(nodeId);
    const previousAfter = run.afterSatisfied.get(nodeId) ?? new Set<string>();
    run.afterSatisfied.set(nodeId, new Set(previousAfter.has(loopNodeId) ? [loopNodeId] : []));
    const directLoopEdges = run.graph.edges.filter((edge) =>
      edge.from_node === loopNodeId && edge.to_node === nodeId && edge.label !== "after_dep"
    );
    const previousMailbox = run.mailboxes.get(nodeId);
    const preservedMailbox = new Map<string, unknown[]>();
    for (const edge of directLoopEdges) {
      const values = previousMailbox?.get(edge.to_port) ?? [];
      if (values.length > 0) preservedMailbox.set(edge.to_port, [values[values.length - 1]]);
    }
    run.inputSatisfied.set(nodeId, new Set(preservedMailbox.size > 0 ? [loopNodeId] : []));
    run.mailboxes.set(nodeId, preservedMailbox);
    for (const edge of run.graph.edges) {
      if (edge.from_node === nodeId && edge.label !== "after_dep" && edge.to_node && edge.to_node !== loopNodeId) {
        pending.push(edge.to_node);
      }
    }
  }
}

function _wakeLoopGatewayReceiver(run: DAGRun, fromNode: string, nodeId: string): void {
  if (!_isLoopGateway(run, fromNode)) return;
  const state = run.nodeStates.get(nodeId);
  if (state !== "READY" && state !== "COMPLETED" && state !== "SKIPPED" && state !== "FAILED") return;
  const mailbox = run.mailboxes.get(nodeId);
  if (!mailbox) return;
  const hasData = Array.from(mailbox.values()).some((v) => v.length > 0);
  if (hasData) {
    if (state !== "READY") _resetLoopBodyDescendants(run, fromNode, nodeId);
    for (const [port, values] of mailbox.entries()) {
      if (values.length > 1) {
        mailbox.set(port, [values[values.length - 1]]);
      }
    }
    if (state !== "READY") {
      run.nodeStates.set(nodeId, "READY");
    }
  }
}

export function handoff(
  run: DAGRun,
  fromNode: string,
  port: string,
  content: unknown,
): DAGTransitionResult {
  if (!run.nodeStates.has(fromNode)) {
    throw new Error(`Unknown node: ${fromNode}`);
  }

  const matchingDownstream = run.graph.edges.filter(
    (edge) =>
      edge.from_node === fromNode &&
      edge.label !== "after_dep" &&
      edge.to_node !== "" &&
      edgeMatchesHandoff(edge, port),
  );
  const matchingTerminal = run.graph.edges.find(
    (edge) => edge.from_node === fromNode && edge.to_node === "" && edgeMatchesHandoff(edge, port),
  );
  const terminalOutcome = matchingTerminal?.terminal_outcome;
  const terminalFailure = terminalOutcome === "failure" ||
    (terminalOutcome === undefined && isFailurePort(port) && matchingDownstream.length === 0);
  const terminalCancelled = terminalOutcome === "cancelled";
  run.handoffedNodes.add(fromNode);
  run.nodeStates.set(
    fromNode,
    terminalFailure
      ? "FAILED"
      : terminalCancelled
        ? "CANCELLED"
      : run.loopSources.has(fromNode)
        ? "RUNNING"
        : "COMPLETED",
  );

  const affected = terminalFailure ? new Set<string>() : _satisfyAfterDeps(run, fromNode);
  const mailboxReceivers = new Set<string>();
  for (const edge of matchingDownstream) {
    _ensureMailbox(run, edge.to_node, edge.to_port).push(content);
    run.inputSatisfied.get(edge.to_node)?.add(fromNode);
    affected.add(edge.to_node);
    mailboxReceivers.add(edge.to_node);
  }

  for (const nodeId of affected) {
    _tryPromote(run, nodeId);
    _skipUntakenSatisfiedBranches(run, nodeId);
  }
  for (const nodeId of mailboxReceivers) {
    _wakeLoopSource(run, nodeId);
    _wakeLoopGatewayReceiver(run, fromNode, nodeId);
  }
  if (terminalFailure) {
    _skipDependentNodes(run, fromNode);
  }
  return {
    affectedNodes: Array.from(affected).sort(),
    routedNodes: Array.from(mailboxReceivers).sort(),
    terminalFailure,
    terminalOutcome,
  };
}

export function failNode(
  run: DAGRun,
  nodeId: string,
  errorData: unknown = "",
): DAGTransitionResult {
  if (!run.nodeStates.has(nodeId)) {
    throw new Error(`Unknown node: ${nodeId}`);
  }
  run.nodeStates.set(nodeId, "FAILED");
  const affected = _satisfyAfterDeps(run, nodeId);
  const mailboxReceivers = new Set<string>();
  for (const edge of run.graph.edges) {
    if (edge.from_node !== nodeId) continue;
    if (edge.label === "after_dep" || edge.to_node === "") continue;
    if (edge.condition !== "on_failure" && edge.condition !== "always") continue;
    _ensureMailbox(run, edge.to_node, edge.to_port).push(errorData);
    run.inputSatisfied.get(edge.to_node)?.add(nodeId);
    affected.add(edge.to_node);
    mailboxReceivers.add(edge.to_node);
  }
  for (const affectedNode of affected) {
    _tryPromote(run, affectedNode);
    _skipUntakenSatisfiedBranches(run, affectedNode);
  }
  for (const receiver of mailboxReceivers) {
    _wakeLoopSource(run, receiver);
  }
  _skipDependentNodes(run, nodeId);
  return {
    affectedNodes: Array.from(affected).sort(),
    routedNodes: Array.from(mailboxReceivers).sort(),
  };
}

export function isRunTerminal(run: DAGRun): boolean {
  for (const [id, state] of run.nodeStates) {
    if (state === "READY") return false;
    if (state === "FAILED") continue;
    if (state === "SKIPPED" || state === "CANCELLED") continue;
    if (run.loopSources.has(id) && state === "RUNNING") continue;
    if (state === "RUNNING" || state === "PENDING") return false;
    if (state !== "COMPLETED") return false;
  }
  return true;
}

export function getReadyNodes(run: DAGRun): string[] {
  const ready: string[] = [];
  for (const [id, state] of run.nodeStates) {
    if (state === "READY") ready.push(id);
  }
  return ready.sort();
}

export function getNodeState(run: DAGRun, nodeId: string): NodeState {
  const state = run.nodeStates.get(nodeId);
  if (state === undefined) {
    throw new Error(`Unknown node: ${nodeId}`);
  }
  return state;
}

export function startNode(run: DAGRun, nodeId: string): void {
  const state = getNodeState(run, nodeId);
  if (state !== "READY") {
    throw new Error(
      `Cannot start node ${nodeId}: expected READY, got ${state}`,
    );
  }
  run.nodeStates.set(nodeId, "RUNNING");
}
