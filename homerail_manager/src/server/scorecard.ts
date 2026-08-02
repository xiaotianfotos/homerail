import type { PersistedRunSnapshot } from "../persistence/types.js";
import type {
  ScorecardHandoffBlockersConfig,
  ScorecardHandoffHeaderConfig,
  ScorecardPolicyConfig,
  ScorecardQualityGateConfig,
  ScorecardSourceIssueConfig,
} from "../orchestration/graph.js";
import { isTerminalDagRunStatus } from "./run-status.js";

export interface ScoreCheck {
  name: string;
  passed: boolean;
  severity: string;
  gate: string;
  source_type: string;
  detail: string;
}

export interface ToolActivity {
  worker_response_total: number;
  response_with_content_total: number;
  response_with_content_by_node: Record<string, number>;
  tool_call_total: number;
  tool_calls_by_node: Record<string, number>;
  tool_names_by_node: Record<string, string[]>;
}

export interface ScorecardResult {
  run_id: string;
  enforcement: ScorecardEnforcement;
  passed: boolean;
  verdict: string;
  gate_verdict: string;
  score: number;
  total: number;
  hard_error_count: number;
  soft_warning_count: number;
  blind_spot_count: number;
  checks: ScoreCheck[];
  intervention_total: number;
  intervention_delivered_total: number;
  intervention_delivery_failed_total: number;
  intervention_by_node: Record<string, number>;
  intervention_by_mode: Record<string, number>;
  intervention_by_direction: Record<string, number>;
  quality_gate_categories: Record<string, boolean>;
  quality_gate_details: Record<string, string>;
  quality_gate_applicable: boolean;
  is_selfdev: boolean;
  scorecard_profile?: string;
  tool_activity: ToolActivity;
  source_issue: number | null;
  source_issue_label?: string;
  source_issue_consistent: boolean;
}

function gateForSeverity(severity: string): string {
  if (severity === "error") return "hard";
  if (severity === "blind_spot") return "blind_spot";
  return "soft";
}

function check(
  name: string,
  passed: boolean,
  severity: string,
  source_type: string,
  detail: string,
): ScoreCheck {
  return {
    name,
    passed,
    severity,
    gate: gateForSeverity(severity),
    source_type,
    detail,
  };
}

interface NormalizedHandoffBlockersPolicy {
  statuses: string[];
  fields: string[];
  successStatuses: string[];
  successForbiddenTerms: string[];
}

interface NormalizedHandoffHeaderPolicy {
  nodes: string[];
  sourceIssueLabel: string;
  artifactLabel: string;
}

interface NormalizedSourceIssuePolicy {
  nodes: string[];
  label: string;
  includeIssueUrls: boolean;
}

interface NormalizedQualityGatePolicy {
  nodes: string[];
  requiredCategories: string[];
}

type ScorecardEnforcement = "off" | "advisory" | "strict";

interface NormalizedScorecardPolicy {
  profile?: string;
  enforcement: ScorecardEnforcement;
  handoffBlockers?: NormalizedHandoffBlockersPolicy;
  handoffHeader?: NormalizedHandoffHeaderPolicy;
  sourceIssue?: NormalizedSourceIssuePolicy;
  qualityGate?: NormalizedQualityGatePolicy;
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function sectionEnabled<T extends { enabled?: boolean }>(section: T | undefined): section is T {
  return section !== undefined && section.enabled !== false;
}

function normalizeEnforcement(policy: ScorecardPolicyConfig | undefined): ScorecardEnforcement {
  const raw = policy?.enforcement ?? policy?.mode;
  if (raw === "off" || raw === "advisory" || raw === "strict") return raw;
  return "advisory";
}

function normalizeHandoffBlockersPolicy(
  policy: ScorecardHandoffBlockersConfig | undefined,
): NormalizedHandoffBlockersPolicy | undefined {
  if (!sectionEnabled(policy)) return undefined;
  const normalized = {
    statuses: stringList(policy.statuses),
    fields: stringList(policy.fields),
    successStatuses: stringList(policy.success_statuses),
    successForbiddenTerms: stringList(policy.success_forbidden_terms),
  };
  if (
    normalized.statuses.length === 0 &&
    normalized.fields.length === 0 &&
    normalized.successStatuses.length === 0 &&
    normalized.successForbiddenTerms.length === 0
  ) {
    return undefined;
  }
  return normalized;
}

function normalizeHandoffHeaderPolicy(
  policy: ScorecardHandoffHeaderConfig | undefined,
): NormalizedHandoffHeaderPolicy | undefined {
  if (!sectionEnabled(policy)) return undefined;
  const nodes = stringList(policy.nodes);
  if (nodes.length === 0) return undefined;
  return {
    nodes,
    sourceIssueLabel: policy.source_issue_label?.trim() || "Source Issue",
    artifactLabel: policy.artifact_label?.trim() || "Artifact",
  };
}

function normalizeSourceIssuePolicy(
  policy: ScorecardSourceIssueConfig | undefined,
): NormalizedSourceIssuePolicy | undefined {
  if (!sectionEnabled(policy)) return undefined;
  const nodes = stringList(policy.nodes);
  if (nodes.length === 0) return undefined;
  return {
    nodes,
    label: policy.label?.trim() || "Source Issue",
    includeIssueUrls: policy.include_issue_urls !== false,
  };
}

function normalizeQualityGatePolicy(
  policy: ScorecardQualityGateConfig | undefined,
): NormalizedQualityGatePolicy | undefined {
  if (!sectionEnabled(policy)) return undefined;
  const nodes = stringList(policy.nodes);
  const requiredCategories = stringList(policy.required_categories);
  if (nodes.length === 0 || requiredCategories.length === 0) return undefined;
  return { nodes, requiredCategories };
}

function normalizeScorecardPolicy(
  policy: ScorecardPolicyConfig | undefined,
): NormalizedScorecardPolicy {
  return {
    profile: policy?.profile,
    enforcement: normalizeEnforcement(policy),
    handoffBlockers: normalizeHandoffBlockersPolicy(policy?.handoff_blockers),
    handoffHeader: normalizeHandoffHeaderPolicy(policy?.handoff_header),
    sourceIssue: normalizeSourceIssuePolicy(policy?.source_issue),
    qualityGate: normalizeQualityGatePolicy(policy?.quality_gate),
  };
}

function checkRunTerminal(snapshot: PersistedRunSnapshot): ScoreCheck {
  const terminal = isTerminalDagRunStatus(snapshot.metadata.status);
  return check(
    "run_terminal",
    terminal,
    "error",
    "event",
    terminal
      ? `run status: ${snapshot.metadata.status}`
      : `run still active: ${snapshot.metadata.status}`,
  );
}

function checkAllNodesCompleted(snapshot: PersistedRunSnapshot): ScoreCheck {
  const states = Object.values(snapshot.metadata.nodeStates);
  const total = states.length;
  const completed = states.filter((s) =>
    ["COMPLETED", "FAILED", "CANCELLED", "SKIPPED"].includes(s) ||
    (snapshot.metadata.status === "completed" && s === "RUNNING"),
  ).length;
  const all = total > 0 && completed === total;
  return check(
    "all_nodes_completed",
    all,
    "error",
    "event",
    `${completed}/${total}, ${total} nodes total`,
  );
}

function checkNoFailedNodes(snapshot: PersistedRunSnapshot): ScoreCheck {
  const states = Object.values(snapshot.metadata.nodeStates);
  const failed = states.filter((s) => s === "FAILED").length;
  return check(
    "no_failed_nodes",
    failed === 0,
    "error",
    "event",
    failed === 0 ? "no failed nodes" : `failed: ${failed}`,
  );
}

function checkHandoffsNonempty(snapshot: PersistedRunSnapshot): ScoreCheck {
  return check(
    "handoffs_nonempty",
    snapshot.handoffs.length > 0,
    "error",
    "handoff",
    snapshot.handoffs.length === 0
      ? "no handoff events found"
      : `${snapshot.handoffs.length} handoff record(s)`,
  );
}

function autoHandoffReason(value: unknown): string | undefined {
  if (isRecord(value) && value.auto_handoff === true) {
    return typeof value.reason === "string" && value.reason.trim()
      ? value.reason.trim()
      : "auto_handoff=true";
  }
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return undefined;
  try {
    return autoHandoffReason(JSON.parse(trimmed));
  } catch {
    return undefined;
  }
}

function checkNoAutoHandoffs(snapshot: PersistedRunSnapshot): ScoreCheck {
  const findings: string[] = [];
  for (const handoff of snapshot.handoffs) {
    const reason = autoHandoffReason(handoff.content);
    if (!reason) continue;
    findings.push(`${handoff.fromNode}:${handoff.port} ${summarizeValue(reason)}`);
  }

  return check(
    "auto_handoffs_absent",
    findings.length === 0,
    "error",
    "handoff",
    findings.length === 0
      ? "no auto handoff fallback records found"
      : findings.join("; "),
  );
}

function summarizeValue(value: unknown): string {
  if (typeof value === "string") return value.trim().slice(0, 240);
  try {
    return JSON.stringify(value).slice(0, 240);
  } catch {
    return String(value).slice(0, 240);
  }
}

function containsToken(value: string, tokens: string[]): boolean {
  const lower = value.toLowerCase();
  return tokens.some((token) => lower.includes(token.toLowerCase()));
}

function equalsToken(value: string, tokens: string[]): boolean {
  const lower = value.trim().toLowerCase();
  return tokens.some((token) => lower === token.toLowerCase());
}

function collectReportedBlockers(
  value: unknown,
  policy: NormalizedHandoffBlockersPolicy,
  findings: string[] = [],
  path = "",
): string[] {
  if (typeof value === "string") {
    if (containsToken(value, policy.statuses)) {
      findings.push(`${path || "text"}=${summarizeValue(value)}`);
    }
    return findings;
  }

  if (!isRecord(value)) return findings;

  const status = typeof value.status === "string" ? value.status.trim() : "";
  if (equalsToken(status, policy.statuses)) {
    findings.push(`${path ? `${path}.` : ""}status=${status}`);
  }

  for (const field of policy.fields) {
    if (Object.prototype.hasOwnProperty.call(value, field)) {
      findings.push(`${path ? `${path}.` : ""}${field}=${summarizeValue(value[field])}`);
    }
  }

  for (const [key, nested] of Object.entries(value)) {
    if (key === "status") continue;
    if (nested && (typeof nested === "object" || typeof nested === "string")) {
      collectReportedBlockers(nested, policy, findings, path ? `${path}.${key}` : key);
    }
  }

  return findings;
}

function checkHandoffReportedBlockers(
  snapshot: PersistedRunSnapshot,
  policy: NormalizedHandoffBlockersPolicy,
): ScoreCheck {
  const findings: string[] = [];
  for (const handoff of snapshot.handoffs) {
    const blockerFindings = collectReportedBlockers(handoff.content, policy);
    if (blockerFindings.length === 0) continue;
    findings.push(`${handoff.fromNode}:${handoff.port} ${blockerFindings.join(", ")}`);
  }

  return check(
    "handoff_reported_blockers",
    findings.length === 0,
    "error",
    "handoff",
    findings.length === 0
      ? "no blocker status reported in handoffs"
      : findings.join("; "),
  );
}

function checkHandoffSuccessContradictions(
  snapshot: PersistedRunSnapshot,
  policy: NormalizedHandoffBlockersPolicy,
): ScoreCheck {
  const findings: string[] = [];
  const failurePattern = /\b(?:FAILED|FAIL|exit\s+(?:code\s+)?[1-9]\d*|non[- ]?zero)\b/i;
  for (const handoff of snapshot.handoffs) {
    const text = extractTextContent(handoff.content) || summarizeValue(handoff.content);
    if (!containsToken(text, policy.successStatuses)) continue;
    const forbiddenTerms = policy.successForbiddenTerms.filter((term) => containsToken(text, [term]));
    const hasFailureEvidence = failurePattern.test(text);
    if (!hasFailureEvidence && forbiddenTerms.length === 0) continue;
    const reasons = [
      hasFailureEvidence ? "failure evidence" : "",
      ...forbiddenTerms.map((term) => `forbidden success term "${term}"`),
    ].filter(Boolean);
    findings.push(`${handoff.fromNode}:${handoff.port} claims success but includes ${reasons.join(", ")}`);
  }

  return check(
    "handoff_success_contradictions",
    findings.length === 0,
    "error",
    "handoff",
    findings.length === 0
      ? "no success/failure contradictions found in handoffs"
      : findings.join("; "),
  );
}

function checkChatsPresent(snapshot: PersistedRunSnapshot): ScoreCheck {
  const chatNodeCount = Object.keys(snapshot.chats).length;
  return check(
    "chats_present",
    chatNodeCount > 0,
    "info",
    "chat",
    chatNodeCount > 0
      ? `${chatNodeCount} node(s) with chat entries`
      : "no chat entries found",
  );
}

function checkEventsPresent(snapshot: PersistedRunSnapshot): ScoreCheck {
  return check(
    "events_present",
    snapshot.events.length > 0,
    "info",
    "event",
    snapshot.events.length > 0
      ? `${snapshot.events.length} event(s)`
      : "no events found",
  );
}

function checkNodeCountMatches(snapshot: PersistedRunSnapshot): ScoreCheck {
  const graphNodeCount = snapshot.metadata.graph?.nodes.length ?? 0;
  const metaNodeCount =
    snapshot.metadata.nodeCount ??
    Object.keys(snapshot.metadata.nodeStates).length;
  const matches =
    graphNodeCount === 0 || graphNodeCount === metaNodeCount;
  return check(
    "node_count_matches",
    matches,
    "info",
    "metadata",
    matches
      ? `nodeCount ${metaNodeCount} matches graph.nodes.length ${graphNodeCount}`
      : `nodeCount ${metaNodeCount} != graph.nodes.length ${graphNodeCount}`,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asToolName(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const name = value.trim();
  return name === "" ? undefined : name;
}

function looksLikeToolUse(record: Record<string, unknown>): boolean {
  const type = typeof record.type === "string" ? record.type.toLowerCase() : "";
  if (["tool_call", "tool_use", "tool_result"].includes(type)) return true;
  return (
    Object.prototype.hasOwnProperty.call(record, "input") ||
    Object.prototype.hasOwnProperty.call(record, "args") ||
    Object.prototype.hasOwnProperty.call(record, "arguments")
  );
}

function collectToolNames(
  value: unknown,
  names: string[] = [],
  inToolList = false,
): string[] {
  if (Array.isArray(value)) {
    for (const item of value) collectToolNames(item, names, inToolList);
    return names;
  }

  if (!isRecord(value)) return names;

  const directToolName =
    asToolName(value.tool_name) ??
    asToolName(value.toolName) ??
    asToolName(value.tool);
  if (directToolName) names.push(directToolName);

  const name = asToolName(value.name);
  if (name && (inToolList || looksLikeToolUse(value))) names.push(name);

  const fn = value.function;
  if (isRecord(fn)) {
    const functionName = asToolName(fn.name);
    if (functionName) names.push(functionName);
  }

  for (const key of ["tool_calls", "toolCalls", "tools", "calls"]) {
    collectToolNames(value[key], names, true);
  }
  collectToolNames(value.content, names, false);

  return names;
}

function computeToolActivity(snapshot: PersistedRunSnapshot): ToolActivity {
  let worker_response_total = 0;
  let response_with_content_total = 0;
  let tool_call_total = 0;
  const response_with_content_by_node: Record<string, number> = {};
  const tool_calls_by_node: Record<string, number> = {};
  const toolNames = new Map<string, Set<string>>();

  for (const [nodeId, entries] of Object.entries(snapshot.chats)) {
    for (const entry of entries) {
      if (entry.role === "worker" && entry.type === "response") {
        worker_response_total++;
        const hasContent =
          entry.content !== undefined &&
            entry.content !== null &&
            (typeof entry.content !== "string" || entry.content.trim() !== "");
        if (hasContent) {
          response_with_content_total++;
          response_with_content_by_node[nodeId] =
            (response_with_content_by_node[nodeId] || 0) + 1;
        }

        const names = collectToolNames(entry.content);
        if (names.length > 0) {
          tool_call_total += names.length;
          tool_calls_by_node[nodeId] =
            (tool_calls_by_node[nodeId] || 0) + names.length;
          const nodeNames = toolNames.get(nodeId) ?? new Set<string>();
          for (const name of names) nodeNames.add(name);
          toolNames.set(nodeId, nodeNames);
        }
      }
    }
  }

  const tool_names_by_node: Record<string, string[]> = {};
  for (const [nodeId, names] of toolNames.entries()) {
    tool_names_by_node[nodeId] = [...names].sort();
  }

  return {
    worker_response_total,
    response_with_content_total,
    response_with_content_by_node,
    tool_call_total,
    tool_calls_by_node,
    tool_names_by_node,
  };
}

function checkToolActivityEvidence(
  activity: ToolActivity,
): ScoreCheck {
  const passed = activity.tool_call_total > 0;
  const nodeList = Object.keys(activity.tool_calls_by_node).join(",");
  const names = Object.values(activity.tool_names_by_node).flat().join(",");
  const detail = passed
    ? `${activity.tool_call_total} tool call(s) extracted from ${activity.worker_response_total} worker response(s) (nodes: ${nodeList}; tools: ${names})`
    : `no tool call names found in ${activity.worker_response_total} worker response(s)`;
  return check("tool_activity_evidence", passed, "info", "chat", detail);
}

function extractTextContent(value: unknown): string {
  if (typeof value === "string") return value;
  if (!isRecord(value)) return "";
  for (const key of ["text", "content", "result", "output"]) {
    if (typeof value[key] === "string") return value[key];
    if (isRecord(value[key])) {
      const nested = extractTextContent(value[key]);
      if (nested) return nested;
    }
  }
  return "";
}

interface QualityGateParseResult {
  categories: Record<string, boolean>;
  details: Record<string, string>;
  applicable: boolean;
}

const QG_PASS_PATTERN = /pass|success|ok|exit\s*0|exit\s*code\s*0/i;
const QG_NA_PATTERN = /n\/a(?:\s*\([^)]+\)|\s*[-:]\s*\S.+)?/i;
const QG_FAIL_PATTERN = /fail|error|nonzero|exit\s*[1-9]/i;

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function labelRegex(value: string): string {
  return value.trim().split(/\s+/).map(escapeRegex).join("\\s+");
}

function normalizeCategoryKey(value: string): string {
  return value.toLowerCase().replace(/[-\s_]+/g, "");
}

function categoryRegexPart(value: string): string {
  return value.trim().split(/[-\s_]+/).map(escapeRegex).join("[-\\s_]+");
}

function hasPolicyNodes(snapshot: PersistedRunSnapshot, nodes: string[]): boolean {
  const graphNodeIds = new Set(
    (snapshot.metadata.graph?.nodes ?? []).map((n) => n.node_id),
  );
  for (const nodeId of Object.keys(snapshot.metadata.nodeStates)) {
    graphNodeIds.add(nodeId);
  }
  return nodes.some((nodeId) => graphNodeIds.has(nodeId));
}

function firstTwoHeaderLines(text: string): [string | null, string | null] {
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);
  if (lines.length < 2) return [null, null];
  return [lines[0], lines[1]];
}

function sourceIssueHeaderPattern(policy: NormalizedHandoffHeaderPolicy): RegExp {
  return new RegExp(`^\\s*${labelRegex(policy.sourceIssueLabel)}\\s*:\\s*#(\\d+)\\s*$`, "i");
}

function artifactHeaderPattern(policy: NormalizedHandoffHeaderPolicy): RegExp {
  return new RegExp(`^\\s*${labelRegex(policy.artifactLabel)}\\s*:\\s*(?:\\S.*)?$`, "i");
}

function checkHandoffHeaderContract(
  snapshot: PersistedRunSnapshot,
  policy: NormalizedHandoffHeaderPolicy,
  inferred: number | null,
): ScoreCheck {
  const relevant = snapshot.handoffs.filter((h) =>
    policy.nodes.includes(h.fromNode),
  );

  if (relevant.length === 0) {
    if (!hasPolicyNodes(snapshot, policy.nodes)) {
      return check(
        "handoff_header_contract",
        true,
        "error",
        "handoff",
        "not applicable: graph has no declared header-contract nodes",
      );
    }

    return check(
      "handoff_header_contract",
      false,
      "error",
      "handoff",
      "no handoff events found",
    );
  }

  const failures: string[] = [];
  const sourceHeader = sourceIssueHeaderPattern(policy);
  const artifactHeader = artifactHeaderPattern(policy);
  for (const h of relevant) {
    const label = `${h.fromNode}:${h.port}`;
    const text = extractTextContent(h.content);
    if (text.trim() === "") {
      failures.push(`handoff ${label} has empty content`);
      continue;
    }
    const [line1, line2] = firstTwoHeaderLines(text);
    if (line1 === null || line2 === null) {
      failures.push(`handoff ${label} is missing header lines`);
      continue;
    }
    const sourceMatch = sourceHeader.exec(line1);
    if (!sourceMatch) {
      failures.push(
        `handoff ${label} first line is "${line1.trim()}", expected "${policy.sourceIssueLabel}: #<n>"`,
      );
      continue;
    }
    if (!artifactHeader.test(line2)) {
      failures.push(
        `handoff ${label} second line is "${line2.trim()}", expected "${policy.artifactLabel}: ..."`,
      );
      continue;
    }
    if (inferred !== null) {
      const lineIssue = parseInt(sourceMatch[1], 10);
      if (lineIssue !== inferred) {
        failures.push(
          `handoff ${label} first line has #${lineIssue} but expected #${inferred}`,
        );
      }
    }
  }

  if (failures.length > 0) {
    return check(
      "handoff_header_contract",
      false,
      "error",
      "handoff",
      failures.join("; "),
    );
  }

  return check(
    "handoff_header_contract",
    true,
    "error",
    "handoff",
    `${relevant.length}/${relevant.length} handoffs conform to header contract`,
  );
}

function sourceIssuePatterns(policy: NormalizedSourceIssuePolicy): RegExp[] {
  const patterns = [
    new RegExp(`\\b${labelRegex(policy.label)}\\s*:\\s*#?(\\d+)\\b`, "i"),
  ];
  if (policy.includeIssueUrls) {
    patterns.push(/\/issues\/(\d+)\b/i);
  }
  return patterns;
}

function extractSourceIssueRefs(
  text: string,
  policy: NormalizedSourceIssuePolicy,
): Set<number> {
  const refs = new Set<number>();
  for (const pattern of sourceIssuePatterns(policy)) {
    for (const match of text.matchAll(new RegExp(pattern.source, "gi"))) {
      const num = parseInt(match[1], 10);
      if (!isNaN(num)) refs.add(num);
    }
  }
  return refs;
}

function inferSourceIssue(
  snapshot: PersistedRunSnapshot,
  policy: NormalizedSourceIssuePolicy,
): number | null {
  for (const nodeId of policy.nodes) {
    const refs = new Set<number>();
    for (const h of snapshot.handoffs) {
      if (h.fromNode !== nodeId) continue;
      const text = extractTextContent(h.content);
      for (const r of extractSourceIssueRefs(text, policy)) refs.add(r);
    }
    if (refs.size === 1) return [...refs][0];
  }
  for (const nodeId of policy.nodes) {
    const entries = snapshot.chats[nodeId] ?? [];
    const refs = new Set<number>();
    for (const entry of entries) {
      if (entry.role !== "worker" || entry.type !== "response") continue;
      const text = extractTextContent(entry.content);
      for (const r of extractSourceIssueRefs(text, policy)) refs.add(r);
    }
    if (refs.size === 1) return [...refs][0];
  }
  return null;
}

function checkSourceIssueConsistency(
  snapshot: PersistedRunSnapshot,
  policy: NormalizedSourceIssuePolicy,
  inferred: number | null,
): ScoreCheck {
  if (inferred === null) {
    return check(
      "source_issue_consistent",
      true,
      "info",
      "handoff",
      "no source issue evidence found",
    );
  }

  const mismatches: string[] = [];
  const missing: string[] = [];

  for (const nodeId of policy.nodes) {
    const nodeHandoffs = snapshot.handoffs.filter((h) => h.fromNode === nodeId);
    if (nodeHandoffs.length === 0) continue;
    for (const h of nodeHandoffs) {
      const text = extractTextContent(h.content);
      const refs = extractSourceIssueRefs(text, policy);
      if (refs.size === 0) {
        missing.push(nodeId);
      } else if (!refs.has(inferred)) {
        mismatches.push(`${nodeId} has #${[...refs][0]}`);
      }
    }
  }

  for (const nodeId of policy.nodes) {
    const entries = snapshot.chats[nodeId] ?? [];
    for (const entry of entries) {
      if (entry.role !== "worker" || entry.type !== "response") continue;
      const refs = extractSourceIssueRefs(extractTextContent(entry.content), policy);
      if (refs.size > 0 && !refs.has(inferred)) {
        mismatches.push(`${nodeId} chat has #${[...refs][0]}`);
      }
    }
  }

  // Mismatches (different issue numbers) are always errors.
  // Missing refs are warnings — downstream nodes may not include
  // source issue references in their handoff content.
  if (mismatches.length > 0) {
    const parts = [`mismatches: ${mismatches.join(", ")}`];
    if (missing.length > 0) parts.push(`missing: ${missing.join(", ")}`);
    parts.push(`expected #${inferred}`);
    return check("source_issue_consistent", false, "error", "handoff", parts.join("; "));
  }

  if (missing.length > 0) {
    return check(
      "source_issue_consistent",
      true,
      "warning",
      "handoff",
      `missing refs: ${missing.join(", ")}; expected #${inferred}`,
    );
  }

  return check(
    "source_issue_consistent",
    true,
    "info",
    "handoff",
    `all handoffs match ${policy.label} #${inferred}`,
  );
}

function parseQualityGateCategories(
  snapshot: PersistedRunSnapshot,
  policy: NormalizedQualityGatePolicy | undefined,
): QualityGateParseResult {
  if (!policy) {
    return { categories: {}, details: {}, applicable: false };
  }

  let rawText = "";

  for (const h of snapshot.handoffs) {
    if (!policy.nodes.includes(h.fromNode)) continue;
    const text = extractTextContent(h.content);
    if (text && /quality\s*gate/i.test(text)) {
      rawText = text;
      break;
    }
  }

  if (!rawText) {
    for (const nodeId of policy.nodes) {
      const entries = snapshot.chats[nodeId] ?? [];
      for (const entry of entries) {
        if (entry.role !== "worker" || entry.type !== "response") continue;
        const text = extractTextContent(entry.content);
        if (text && /quality\s*gate/i.test(text)) {
          rawText = text;
          break;
        }
      }
      if (rawText) break;
    }
  }

  if (!rawText) {
    return { categories: {}, details: {}, applicable: false };
  }

  const categories: Record<string, boolean> = {};
  const details: Record<string, string> = {};
  const lines = rawText.split("\n");
  const requiredByKey = new Map<string, string>();
  for (const category of policy.requiredCategories) {
    requiredByKey.set(normalizeCategoryKey(category), category);
  }
  const categoryPattern = new RegExp(
    `^\\s*(?:[-*]\\s*)?(${policy.requiredCategories.map(categoryRegexPart).join("|")})\\s*:\\s*(.+)$`,
    "i",
  );

  for (const line of lines) {
    const m = categoryPattern.exec(line);
    if (!m) continue;
    const catName = requiredByKey.get(normalizeCategoryKey(m[1])) ?? m[1];
    const catValue = m[2].trim();
    details[catName] = catValue;
    if (QG_NA_PATTERN.test(catValue)) {
      categories[catName] = true;
    } else if (QG_PASS_PATTERN.test(catValue)) {
      categories[catName] = true;
    } else if (QG_FAIL_PATTERN.test(catValue)) {
      categories[catName] = false;
    } else {
      categories[catName] = false;
    }
  }

  const applicable = policy.requiredCategories.every((r) => r in categories);

  return { categories, details, applicable };
}

function checkTesterQualityGate(
  parsed: QualityGateParseResult,
  snapshot: PersistedRunSnapshot,
  policy: NormalizedQualityGatePolicy,
): ScoreCheck {
  if (!hasPolicyNodes(snapshot, policy.nodes)) {
    return check(
      "tester_quality_gate",
      true,
      "info",
      "handoff",
      "not applicable: graph has no declared quality-gate nodes",
    );
  }

  if (!parsed.applicable) {
    return check(
      "tester_quality_gate",
      false,
      "error",
      "handoff",
      `quality gate evidence missing or incomplete (need ${policy.requiredCategories.join(", ")})`,
    );
  }

  const allCategoriesPass = Object.values(parsed.categories).every(Boolean);
  const statuses = Object.entries(parsed.categories)
    .map(([k, v]) => `${k}=${v ? "PASS" : "FAIL"}`)
    .join(", ");
  return check(
    "tester_quality_gate",
    allCategoriesPass,
    "error",
    "handoff",
    `quality gate categories parsed: ${statuses}`,
  );
}

function computeInterventions(snapshot: PersistedRunSnapshot) {
  const injectedEvents = snapshot.events.filter((e) => e.type === "dag:instruction_injected");
  const deliveredEvents = snapshot.events.filter((e) => e.type === "dag:instruction_delivered");
  const failedEvents = snapshot.events.filter((e) => e.type === "dag:instruction_delivery_failed");
  const intervention_total = injectedEvents.length;
  const intervention_delivered_total = deliveredEvents.length;
  const intervention_delivery_failed_total = failedEvents.length;
  const intervention_by_node: Record<string, number> = {};
  const intervention_by_mode: Record<string, number> = {};
  const intervention_by_direction: Record<string, number> = {};

  for (const ev of injectedEvents) {
    const p = ev.payload as unknown as Record<string, unknown>;
    const nodeId = typeof p.nodeId === "string" ? p.nodeId : "unknown";
    const mode = typeof p.mode === "string" ? p.mode : "unknown";
    const direction = typeof p.direction === "string" ? p.direction : "inbound";
    intervention_by_node[nodeId] = (intervention_by_node[nodeId] || 0) + 1;
    intervention_by_mode[mode] = (intervention_by_mode[mode] || 0) + 1;
    intervention_by_direction[direction] = (intervention_by_direction[direction] || 0) + 1;
  }

  return {
    intervention_total,
    intervention_delivered_total,
    intervention_delivery_failed_total,
    intervention_by_node,
    intervention_by_mode,
    intervention_by_direction,
  };
}

function applyPolicyEnforcement(
  checks: ScoreCheck[],
  enforcement: ScorecardEnforcement,
): ScoreCheck[] {
  if (enforcement !== "advisory") return checks;
  return checks.map((item) => {
    if (item.passed || item.severity !== "error") return item;
    return {
      ...item,
      severity: "warning",
      gate: gateForSeverity("warning"),
      detail: `advisory policy finding: ${item.detail}`,
    };
  });
}

export function computeScorecard(
  snapshot: PersistedRunSnapshot,
): ScorecardResult {
  const policy = normalizeScorecardPolicy(snapshot.metadata.scorecard);
  const toolActivity = computeToolActivity(snapshot);
  const policyEnabled = policy.enforcement !== "off";
  const qgParsed = policyEnabled
    ? parseQualityGateCategories(snapshot, policy.qualityGate)
    : { categories: {}, details: {}, applicable: false };
  const inferredSourceIssue = policyEnabled && policy.sourceIssue
    ? inferSourceIssue(snapshot, policy.sourceIssue)
    : null;
  const sourceIssueCheck = policyEnabled && policy.sourceIssue
    ? checkSourceIssueConsistency(snapshot, policy.sourceIssue, inferredSourceIssue)
    : undefined;
  const baseChecks: ScoreCheck[] = [
    checkRunTerminal(snapshot),
    checkAllNodesCompleted(snapshot),
    checkNoFailedNodes(snapshot),
    checkHandoffsNonempty(snapshot),
    checkNoAutoHandoffs(snapshot),
    checkChatsPresent(snapshot),
    checkEventsPresent(snapshot),
    checkNodeCountMatches(snapshot),
    checkToolActivityEvidence(toolActivity),
  ];
  const rawPolicyChecks: ScoreCheck[] = [];
  if (policy.enforcement !== "off") {
    if (policy.handoffBlockers) {
      rawPolicyChecks.push(checkHandoffReportedBlockers(snapshot, policy.handoffBlockers));
      if (policy.handoffBlockers.successStatuses.length > 0) {
        rawPolicyChecks.push(checkHandoffSuccessContradictions(snapshot, policy.handoffBlockers));
      }
    }
    if (policy.handoffHeader) {
      rawPolicyChecks.push(checkHandoffHeaderContract(snapshot, policy.handoffHeader, inferredSourceIssue));
    }
    if (policy.qualityGate) {
      rawPolicyChecks.push(checkTesterQualityGate(qgParsed, snapshot, policy.qualityGate));
    }
    if (sourceIssueCheck) {
      rawPolicyChecks.push(sourceIssueCheck);
    }
  }
  const checks = [
    ...baseChecks,
    ...applyPolicyEnforcement(rawPolicyChecks, policy.enforcement),
  ];

  const total = checks.length;
  const score = checks.filter((c) => c.passed).length;
  const hardErrorCount = checks.filter(
    (c) => !c.passed && c.severity === "error",
  ).length;
  const softWarningCount = checks.filter(
    (c) => !c.passed && c.severity === "warning",
  ).length;
  const blindSpotCount = checks.filter(
    (c) => !c.passed && c.severity === "blind_spot",
  ).length;
  const passed = hardErrorCount === 0;
  const gateVerdict = passed ? "pass" : "fail";

  let verdict: string;
  if (hardErrorCount > 0) {
    verdict = "fail";
  } else if (blindSpotCount > 0) {
    verdict = "scorecard_blind_spot";
  } else if (softWarningCount > 0) {
    verdict = "pass_with_warnings";
  } else {
    verdict = "pass";
  }

  const interventions = computeInterventions(snapshot);
  const isSelfdev = policy.profile === "selfdev" || qgParsed.applicable;

  return {
    run_id: snapshot.metadata.runId,
    enforcement: policy.enforcement,
    passed,
    verdict,
    gate_verdict: gateVerdict,
    score,
    total,
    hard_error_count: hardErrorCount,
    soft_warning_count: softWarningCount,
    blind_spot_count: blindSpotCount,
    checks,
    ...interventions,
    quality_gate_categories: qgParsed.categories,
    quality_gate_details: qgParsed.details,
    quality_gate_applicable: qgParsed.applicable,
    is_selfdev: isSelfdev,
    scorecard_profile: policy.profile,
    tool_activity: toolActivity,
    source_issue: inferredSourceIssue,
    source_issue_label: policy.sourceIssue?.label,
    source_issue_consistent: sourceIssueCheck?.passed ?? true,
  };
}

export function renderScorecardJson(result: ScorecardResult): string {
  return JSON.stringify({
    run_id: result.run_id,
    is_selfdev: result.is_selfdev,
    scorecard_profile: result.scorecard_profile,
    enforcement: result.enforcement,
    passed: result.passed,
    verdict: result.verdict,
    gate_verdict: result.gate_verdict,
    score: result.score,
    total: result.total,
    hard_error_count: result.hard_error_count,
    soft_warning_count: result.soft_warning_count,
    blind_spot_count: result.blind_spot_count,
    checks: result.checks.map((c) => ({
      name: c.name,
      passed: c.passed,
      severity: c.severity,
      gate: c.gate,
      source_type: c.source_type,
      detail: c.detail,
    })),
    intervention: {
      total: result.intervention_total,
      delivered: result.intervention_delivered_total,
      delivery_failed: result.intervention_delivery_failed_total,
      by_node: result.intervention_by_node,
      by_mode: result.intervention_by_mode,
      by_direction: result.intervention_by_direction,
    },
    quality_gate: {
      applicable: result.quality_gate_applicable,
      categories: result.quality_gate_categories,
      details: result.quality_gate_details,
      aggregate: (() => {
        const qgCheck = result.checks.find((c) => c.name === "tester_quality_gate");
        const qgPassed = qgCheck?.passed ?? false;
        const allCatsPass = result.quality_gate_applicable && Object.values(result.quality_gate_categories).every(Boolean);
        return {
          name: "artifact.tester_quality_gate",
          passed: qgPassed,
          status: result.quality_gate_applicable ? (allCatsPass ? "pass" : "fail") : "n/a",
        };
      })(),
    },
    tool_activity: result.tool_activity,
    source_issue: {
      inferred: result.source_issue,
      label: result.source_issue_label,
      consistent: result.source_issue_consistent,
    },
    handoff_header_contract: {
      name: "artifact.handoff_header_contract",
      passed: result.checks.find((c) => c.name === "handoff_header_contract")?.passed ?? true,
      severity: "error",
    },
  });
}
