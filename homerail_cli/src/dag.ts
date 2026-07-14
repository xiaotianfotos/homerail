/**
 * Core DAG operations logic — TypeScript port of homerail_cli/src/dag.rs
 */

import type { HomeRailClient, BaseResponse } from "./client.js";

// -- Types -------------------------------------------------------------------

export interface DagSnapshot {
  run_id: string;
  run_status: string;
  waiting_for_command: boolean;
  current_round_id: string | null;
  current_phase: string | null;
  dag_status: string | null;
  node_counts: Record<string, number>;
  nodes: Record<string, unknown>;
  running_nodes: string[];
  ready_nodes: string[];
  failed_nodes: string[];
  event_count: number;
  latest_events: unknown[];
  stalled_hint: string;
  workflow_id: string | null;
  template: string | null;
}

export interface SuperviseTickResult {
  new_cursor: string;
  terminal: boolean;
  waiting_for_command: boolean;
  changed: boolean;
  severity: string;
  summary: string;
  exit_code: number;
  report: unknown;
}

// -- Helpers -----------------------------------------------------------------

function safeGetData(resp: BaseResponse): Record<string, unknown> {
  if (resp.success && resp.data != null) {
    return resp.data as Record<string, unknown>;
  }
  return { _error: resp.message };
}

function extractNodes(
  dagData: Record<string, unknown>,
): Record<string, unknown> {
  const exec = dagData.execution as Record<string, unknown> | undefined;
  const nodes = exec?.nodes as Record<string, unknown> | undefined;
  return nodes ?? {};
}

function extractEvents(eventsData: Record<string, unknown>): unknown[] {
  const arr = eventsData.events;
  return Array.isArray(arr) ? arr : [];
}

function extractCurrentRoundId(...sources: Record<string, unknown>[]): string | null {
  for (const source of sources) {
    for (const key of ["current_round_id", "currentRoundId"] as const) {
      if (typeof source[key] === "string" && source[key].trim()) {
        return source[key].trim();
      }
    }
    for (const key of ["current_round", "currentRound"] as const) {
      const round = source[key];
      if (!round || typeof round !== "object" || Array.isArray(round)) continue;
      const record = round as Record<string, unknown>;
      const value = record.round_id ?? record.roundId;
      if (typeof value === "string" && value.trim()) return value.trim();
    }
  }
  return null;
}

export function countNodeStatuses(
  nodes: Record<string, unknown>,
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const node of Object.values(nodes)) {
    const n = node as Record<string, unknown> | null;
    const status =
      typeof n?.status === "string" ? n.status : "unknown";
    counts[status] = (counts[status] ?? 0) + 1;
  }
  return counts;
}

export function classifyNodes(
  nodes: Record<string, unknown>,
): [string[], string[], string[]] {
  const running: string[] = [];
  const ready: string[] = [];
  const failed: string[] = [];
  for (const [id, node] of Object.entries(nodes)) {
    const n = node as Record<string, unknown> | null;
    const status = typeof n?.status === "string" ? n.status : "";
    if (status === "running") running.push(id);
    else if (status === "ready") ready.push(id);
    else if (status === "failed") failed.push(id);
  }
  running.sort();
  ready.sort();
  failed.sort();
  return [running, ready, failed];
}

export function computeStalledHint(
  runStatus: string,
  _dagStatus: string | null | undefined,
  running: string[],
  ready: string[],
  failed: string[],
  _events: unknown[],
  runHasError: boolean,
  dagHasError: boolean,
): string {
  if (runHasError) return `run_status_api_error: ${runStatus}`;
  if (dagHasError) return "dag_status_api_error";
  if (runStatus === "waiting") return "waiting_for_command";
  if (["completed", "failed", "cancelled"].includes(runStatus)) {
    return "terminal";
  }
  if (running.length > 0) {
    if (ready.length === 0 && runStatus === "running") {
      return `run_running_but_no_ready: ${running.join(", ")}`;
    }
    return `running_nodes: ${running.join(", ")}`;
  }
  if (ready.length > 0 && runStatus === "running") {
    return `ready_not_dispatched: ${ready.join(", ")}`;
  }
  if (ready.length > 0) {
    return `ready_nodes: ${ready.join(", ")}`;
  }
  if (failed.length > 0) {
    return `failed_nodes: ${failed.join(", ")}`;
  }
  if (_events.length === 0) return "no_events";
  return "unknown";
}

function isSelfdevName(value: string): boolean {
  const normalized = value
    .trim()
    .replace(/\.ya?ml$/, "")
    .replace(/\\/g, "/")
    .toLowerCase();
  const name = normalized.split("/").pop() ?? normalized;
  return (
    name === "selfdev" ||
    name.startsWith("selfdev-") ||
    name.startsWith("selfdev_")
  );
}

export function isSelfdev(snapshot: DagSnapshot): boolean {
  if (snapshot.workflow_id) {
    return isSelfdevName(snapshot.workflow_id);
  }
  if (snapshot.template) {
    return isSelfdevName(snapshot.template);
  }
  // Legacy fallback: node-name heuristic for runs without metadata
  return "triage" in snapshot.nodes;
}

export function truncateChars(value: string, limit: number): string {
  if ([...value].length <= limit) return value;
  return [...value].slice(0, limit).join("") + "...";
}

// -- Snapshot ----------------------------------------------------------------

export async function buildDagSnapshot(
  client: HomeRailClient,
  runId: string,
  eventLimit: number,
): Promise<DagSnapshot> {
  const [runResp, dagResp, eventsResp] = await Promise.all([
    client.get(`/api/runs/${runId}/status`),
    client.getDagStatus(runId),
    client.getDagEvents(runId),
  ]);

  const runData = safeGetData(runResp);
  const dagData = safeGetData(dagResp);
  const eventsData = safeGetData(eventsResp);

  const nodes = extractNodes(dagData);
  const allEvents = extractEvents(eventsData);
  const latestEvents = [...allEvents].reverse().slice(0, eventLimit);
  const eventCount = allEvents.length;
  const nodeCounts = countNodeStatuses(nodes);
  let [runningNodes, readyNodes, failedNodes] = classifyNodes(nodes);

  // Override ready/failed with execution-level arrays from API
  const exec = dagData.execution as Record<string, unknown> | undefined;
  const apiReady = exec?.ready_nodes;
  if (Array.isArray(apiReady)) {
    readyNodes = apiReady.filter((v): v is string => typeof v === "string");
  }
  const apiFailed = exec?.failed_nodes;
  if (Array.isArray(apiFailed)) {
    failedNodes = apiFailed.filter((v): v is string => typeof v === "string");
  }

  const runStatus =
    typeof runData.status === "string" ? runData.status : "?";
  const waitingForCommand = runStatus === "waiting";
  const currentRoundId = extractCurrentRoundId(runData, dagData, exec ?? {});
  const currentPhase =
    typeof runData.current_phase === "string" ? runData.current_phase : null;
  const dagStatus =
    typeof dagData.status === "string" ? dagData.status : null;
  const workflowId =
    typeof runData.workflow_id === "string" ? runData.workflow_id : null;
  const template =
    typeof runData.template === "string" ? runData.template : null;

  const runHasError = "_error" in runData;
  const dagHasError = "_error" in dagData;

  const stalledHint = computeStalledHint(
    runStatus,
    dagStatus,
    runningNodes,
    readyNodes,
    failedNodes,
    allEvents,
    runHasError,
    dagHasError,
  );

  return {
    run_id: runId,
    run_status: runStatus,
    waiting_for_command: waitingForCommand,
    current_round_id: currentRoundId,
    current_phase: currentPhase,
    dag_status: dagStatus,
    node_counts: nodeCounts,
    nodes,
    running_nodes: runningNodes,
    ready_nodes: readyNodes,
    failed_nodes: failedNodes,
    event_count: eventCount,
    latest_events: latestEvents,
    stalled_hint: stalledHint,
    workflow_id: workflowId,
    template,
  };
}

/** Fetch ALL events for a run (not truncated). */
export async function fetchAllEvents(
  client: HomeRailClient,
  runId: string,
): Promise<unknown[]> {
  const resp = await client.getDagEvents(runId);
  if (resp.success && resp.data) {
    return extractEvents(resp.data as Record<string, unknown>);
  }
  return [];
}

// -- Interventions -----------------------------------------------------------

export function extractInterventions(events: unknown[]): unknown[] {
  const interventions: unknown[] = [];
  for (const raw of events) {
    const ev = raw as Record<string, unknown>;
    let evType =
      typeof ev.event_type === "string" ? ev.event_type : "";
    if (!evType && typeof ev.type === "string") evType = ev.type;
    if (evType !== "dag:instruction_injected") continue;

    const details =
      (ev.details as Record<string, unknown> | undefined) ??
      (ev.data as Record<string, unknown> | undefined) ??
      (ev.payload as Record<string, unknown> | undefined);

    const nodeId = (details && typeof details.node_id === "string")
      ? details.node_id
      : typeof ev.node_id === "string"
        ? ev.node_id
        : "";

    const mode = details
      ? typeof details.mode === "string"
        ? details.mode
        : "unknown"
      : "unknown";

    const preview = details
      ? typeof details.instruction_preview === "string"
        ? details.instruction_preview
        : typeof details.instruction === "string"
          ? details.instruction
          : ""
      : "";

    const entry = `inject:${mode}`;
    const direction = classifyInterventionDirection(mode, preview);
    interventions.push({
      node_id: nodeId,
      mode,
      entry,
      direction,
      instruction_preview: preview,
    });
  }
  return interventions;
}

export function classifyInterventionDirection(
  mode: string,
  preview: string,
): string {
  const text = `${mode} ${preview}`.toLowerCase();
  const containsAny = (needles: string[]): boolean =>
    needles.some((n) => text.includes(n));

  if (
    containsAny([
      "test",
      "pytest",
      "cargo test",
      "npm run",
      "verify",
      "validation",
      "\u9a8c\u8bc1",
      "\u6d4b\u8bd5",
    ])
  )
    return "enforce_validation";
  if (
    containsAny([
      "handoff",
      "port",
      "contract",
      "\u4ea4\u63a5",
      "\u7aef\u53e3",
      "\u5951\u7ea6",
    ])
  )
    return "handoff_correction";
  if (
    containsAny([
      "scope",
      "narrow",
      "only",
      "\u6536\u7a84",
      "\u53ea\u6539",
      "\u4e0d\u8981\u6269\u5c55",
    ])
  )
    return "scope_narrowing";
  if (
    containsAny([
      "over-explore",
      "stop exploring",
      "stop",
      "\u505c\u6b62",
      "\u8dd1\u504f",
    ])
  )
    return "stop_over_exploration";
  if (
    containsAny([
      "env",
      "dependency",
      "install",
      "docker",
      "service",
      "\u73af\u5883",
      "\u4f9d\u8d56",
    ])
  )
    return "environment_unblock";
  if (
    containsAny([
      "review",
      "diff",
      "quality",
      "\u5ba1\u67e5",
      "\u8d28\u91cf",
    ])
  )
    return "quality_review";
  if (
    containsAny([
      "commit",
      "merge",
      "close",
      "manual",
      "\u5408\u5e76",
      "\u5173\u95ed",
      "\u6536\u5c3e",
    ])
  )
    return "manual_completion";
  return "unknown";
}

// -- Handoffs ---------------------------------------------------------------

export function extractHandoffs(
  events: unknown[],
  contentLimit: number,
): unknown[] {
  const handoffs: unknown[] = [];
  for (const raw of events) {
    const ev = raw as Record<string, unknown>;
    let evType =
      typeof ev.event_type === "string" ? (ev.event_type as string) : "";
    if (!evType && typeof ev.type === "string") evType = ev.type as string;

    const details =
      (ev.details as Record<string, unknown> | undefined) ??
      (ev.data as Record<string, unknown> | undefined) ??
      (ev.payload as Record<string, unknown> | undefined);

    const matched =
      evType === "dag:handoff" ||
      evType === "handoff" ||
      evType.endsWith(":handoff") ||
      evType === "hook:handoff_contract";
    if (!matched) continue;

    let rawContent = details
      ? typeof details.content === "string"
        ? details.content
        : ""
      : "";
    if (!rawContent && details && typeof details.content_preview === "string") {
      rawContent = details.content_preview;
    }
    if (!rawContent && typeof ev.content === "string") {
      rawContent = ev.content;
    }
    const truncated =
      contentLimit > 0 ? truncateChars(rawContent, contentLimit) : rawContent;

    let nodeId = details
      ? typeof details.from_node === "string"
        ? details.from_node
        : typeof details.fromNode === "string"
          ? details.fromNode
        : ""
      : "";
    if (!nodeId && typeof ev.node_id === "string") nodeId = ev.node_id;
    if (!nodeId && typeof ev.node === "string") nodeId = ev.node;

    const kind =
      evType === "hook:handoff_contract" ? "hook" : "handoff";

    handoffs.push({
      kind,
      type: evType,
      node: nodeId,
      port: details && typeof details.port === "string" ? details.port : "",
      content: truncated,
    });
  }
  return handoffs;
}

// -- Event matching ----------------------------------------------------------

export function eventMatches(
  ev: unknown,
  eventType?: string,
  node?: string,
  port?: string,
): boolean {
  const e = ev as Record<string, unknown>;
  const evType =
    typeof e.event_type === "string"
      ? e.event_type
      : typeof e.type === "string"
        ? e.type
        : "";
  if (eventType && evType !== eventType) return false;

  const details =
    (e.details as Record<string, unknown> | undefined) ??
    (e.data as Record<string, unknown> | undefined) ??
    (e.payload as Record<string, unknown> | undefined);

  if (node) {
    const evNode = typeof e.node_id === "string" ? (e.node_id as string) : "";
    const fromNode = details
      ? typeof details.from_node === "string"
        ? (details.from_node as string)
        : typeof details.fromNode === "string"
          ? (details.fromNode as string)
        : ""
      : "";
    if (evNode !== node && fromNode !== node) return false;
  }

  if (port) {
    const fromPort = details
      ? typeof details.from_port === "string"
        ? (details.from_port as string)
        : ""
      : "";
    const detailPort = details
      ? typeof details.port === "string"
        ? (details.port as string)
        : ""
      : "";
    if (fromPort !== port && detailPort !== port) return false;
  }

  return true;
}

// -- Rendering ---------------------------------------------------------------

function eventLabel(ev: unknown): string {
  const e = ev as Record<string, unknown>;
  const ty =
    typeof e.event_type === "string"
      ? e.event_type
      : typeof e.type === "string"
        ? e.type
        : "?";
  const node = typeof e.node_id === "string" ? e.node_id : "-";
  const ts = typeof e.timestamp === "string" ? e.timestamp : "";
  return `${ts} ${ty} ${node}`.trim();
}

export function renderSnapshot(snapshot: DagSnapshot): string {
  const lines: string[] = [
    `DAG Quick: ${snapshot.run_id}`,
    `  Run: ${snapshot.run_status}  Phase: ${snapshot.current_phase ?? "-"}  DAG: ${snapshot.dag_status ?? "-"}`,
  ];

  if (snapshot.current_round_id) {
    lines.push(`  Round: ${snapshot.current_round_id}`);
  }
  if (snapshot.waiting_for_command) {
    lines.push("  Boundary: waiting for command");
  }

  const counts = Object.entries(snapshot.node_counts)
    .map(([k, v]) => `${k}: ${v}`)
    .join(", ");
  lines.push(`  Nodes: ${counts || "-"}`);

  lines.push(
    `  Running: ${snapshot.running_nodes.join(", ") || "-"}`,
  );
  if (snapshot.ready_nodes.length > 0) {
    lines.push(`  Ready: ${snapshot.ready_nodes.join(", ")}`);
  }
  if (snapshot.failed_nodes.length > 0) {
    lines.push(`  Failed: ${snapshot.failed_nodes.join(", ")}`);
  }

  lines.push(`  Events: ${snapshot.event_count}`);
  if (snapshot.latest_events.length > 0) {
    const last = snapshot.latest_events[snapshot.latest_events.length - 1];
    lines.push(`  Latest: ${eventLabel(last!)}`);
  }
  lines.push(`  Hint: ${snapshot.stalled_hint}`);

  return lines.join("\n");
}

export function renderSnapshotJson(snapshot: DagSnapshot): string {
  return JSON.stringify({
    run_id: snapshot.run_id,
    run_status: snapshot.run_status,
    waiting_for_command: snapshot.waiting_for_command,
    current_round_id: snapshot.current_round_id,
    current_phase: snapshot.current_phase,
    dag_status: snapshot.dag_status,
    node_counts: snapshot.node_counts,
    running_nodes: snapshot.running_nodes,
    ready_nodes: snapshot.ready_nodes,
    failed_nodes: snapshot.failed_nodes,
    event_count: snapshot.event_count,
    latest_events: snapshot.latest_events,
    stalled_hint: snapshot.stalled_hint,
    workflow_id: snapshot.workflow_id,
    template: snapshot.template,
  });
}

export function renderChats(
  runId: string,
  summaries: Record<string, unknown>,
): string {
  const lines: string[] = [`DAG Chats: ${runId}`];
  const entries = Object.entries(summaries);
  if (entries.length === 0) {
    lines.push("  No node chats found.");
    return lines.join("\n");
  }
  for (const [nodeId, summaryRaw] of entries) {
    const s = summaryRaw as Record<string, unknown>;
    if (typeof s.error === "string") {
      lines.push(`\n${nodeId}: error=${s.error}`);
      continue;
    }
    const msgCount = typeof s.message_count === "number" ? s.message_count : 0;
    const toolCount = typeof s.tool_count === "number" ? s.tool_count : 0;
    const handoffCount =
      typeof s.handoff_count === "number" ? s.handoff_count : 0;
    const errorCount =
      typeof s.tool_error_count === "number" ? s.tool_error_count : 0;
    lines.push(
      `\n${nodeId}: messages=${msgCount} tools=${toolCount} handoffs=${handoffCount} errors=${errorCount}`,
    );
    const recentTools = Array.isArray(s.recent_tools) ? s.recent_tools : [];
    if (recentTools.length > 0) {
      lines.push("  Recent tools:");
      for (const t of recentTools) {
        const tr = t as Record<string, unknown>;
        const name = typeof tr.name === "string" ? tr.name : "?";
        const command = typeof tr.command === "string" ? tr.command : "";
        const inputSummary = typeof tr.input_summary === "string" ? tr.input_summary : "";
        const resultPreview = typeof tr.result_preview === "string" ? tr.result_preview : "";
        const resultError =
          typeof tr.result_error === "boolean"
            ? ` result_error=${tr.result_error ? "yes" : "no"}`
            : "";
        if (command) {
          lines.push(`    - ${name}: ${truncateChars(command, 220)}${resultError}`);
        } else if (inputSummary) {
          lines.push(`    - ${name}: ${inputSummary}${resultError}`);
        } else {
          lines.push(`    - ${name}${resultError}`);
        }
        if (resultPreview) {
          lines.push(`      result: ${truncateChars(resultPreview, 220)}`);
        }
      }
    }
    if (typeof s.last_text === "string" && s.last_text.length > 0) {
      lines.push(`  Last text: ${truncateChars(s.last_text, 220)}`);
    }
  }
  return lines.join("\n");
}

export function renderHandoffs(runId: string, handoffs: unknown[]): string {
  const lines: string[] = [`DAG Handoffs: ${runId}`];
  if (handoffs.length === 0) {
    lines.push("  No handoff events found.");
    return lines.join("\n");
  }
  handoffs.forEach((h, i) => {
    const hr = h as Record<string, unknown>;
    const ty = typeof hr.type === "string" ? hr.type : "?";
    const node = typeof hr.node === "string" ? hr.node : "?";
    const port = typeof hr.port === "string" && hr.port ? `:${hr.port}` : "";
    const content = typeof hr.content === "string" ? hr.content : "";
    lines.push(`  [${i}] ${ty} from ${node}${port}: ${content}`);
  });
  return lines.join("\n");
}

// -- DAG Chats builder -------------------------------------------------------

export async function buildDagChats(
  client: HomeRailClient,
  runId: string,
  nodeIds?: string[],
  toolsLimit: number = 5,
  includeToolDetails = false,
): Promise<Record<string, unknown>> {
  const snap = await buildDagSnapshot(client, runId, 1);
  const ids =
    nodeIds && nodeIds.length > 0
      ? nodeIds
      : Object.keys(snap.nodes);

  const limit = Math.max(toolsLimit, 0);
  const summaries: Record<string, unknown> = {};

  for (const nodeId of ids) {
    const resp = await client.getNodeChat(runId, nodeId);
    if (!resp.success) {
      summaries[nodeId] = { error: resp.message };
      continue;
    }
    const data = (resp.data ?? {}) as Record<string, unknown>;
    const messages = Array.isArray(data.messages) ? data.messages : [];

    let toolCount = 0;
    let handoffCount = 0;
    let toolErrorCount = 0;
    let lastText = "";
    const allTools: Array<Record<string, unknown>> = [];
    const toolsById = new Map<string, Record<string, unknown>>();

    for (const msgRaw of messages) {
      const msg = msgRaw as Record<string, unknown>;
      const content = msg.content;
      const trimmed = extractMessageText(content).trim();
      if (trimmed.length > 0) lastText = trimmed;

      const contentRecord =
        typeof content === "object" && content !== null && !Array.isArray(content)
          ? (content as Record<string, unknown>)
          : undefined;

      if (msg.is_error === true || contentRecord?.is_error === true) toolErrorCount++;

      const contentType = typeof contentRecord?.type === "string" ? contentRecord.type : "";
      const eventType =
        typeof contentRecord?.event === "string" ? contentRecord.event : contentType;
      const toolName =
        typeof msg.tool_name === "string"
          ? msg.tool_name
          : typeof contentRecord?.tool_name === "string"
            ? contentRecord.tool_name
            : null;
      if (toolName && (eventType === "tool_use" || eventType === "")) {
        toolCount++;
        const tool: Record<string, unknown> = { name: toolName };
        const toolId =
          typeof contentRecord?.tool_id === "string"
            ? contentRecord.tool_id
            : typeof contentRecord?.id === "string"
              ? contentRecord.id
              : "";
        if (toolId) {
          tool.id = toolId;
          toolsById.set(toolId, tool);
        }
        if (includeToolDetails) {
          const input = contentRecord?.tool_input ?? contentRecord?.input;
          const command = extractToolCommand(input);
          if (command) tool.command = command;
          const inputSummary = summarizeToolInput(input);
          if (inputSummary) tool.input_summary = inputSummary;
          if (input !== undefined) tool.input = input;
        }
        allTools.push(tool);
      }

      if (eventType === "tool_result" && includeToolDetails && contentRecord) {
        const toolUseId =
          typeof contentRecord?.tool_use_id === "string"
            ? contentRecord.tool_use_id
            : "";
        const tool = toolUseId ? toolsById.get(toolUseId) : undefined;
        if (tool) {
          if (typeof contentRecord?.is_error === "boolean") {
            tool.result_error = contentRecord.is_error;
          }
          const preview = extractResultPreview(contentRecord);
          if (preview) tool.result_preview = preview;
        }
      }

      if (contentType === "node_handoff") {
        handoffCount++;
      } else if (
        !contentType &&
        typeof toolName === "string" &&
        toolName.includes("handoff")
      ) {
        handoffCount++;
      }
    }

    lastText = [...lastText].slice(0, 500).join("");
    const recentTools = limit > 0 ? allTools.slice(-limit) : [];

    summaries[nodeId] = {
      message_count: messages.length,
      tool_count: toolCount,
      tool_error_count: toolErrorCount,
      handoff_count: handoffCount,
      recent_tools: recentTools,
      last_text: lastText,
    };
  }
  return summaries;
}

function extractToolCommand(input: unknown): string {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return "";
  }
  const command = (input as Record<string, unknown>).command;
  return typeof command === "string" ? command : "";
}

function summarizeToolInput(input: unknown): string {
  if (input === undefined) return "";
  if (typeof input === "string") return truncateChars(input, 260);
  if (typeof input !== "object" || input === null) return String(input);
  if (Array.isArray(input)) return truncateChars(JSON.stringify(input), 260);
  const record = input as Record<string, unknown>;
  const parts: string[] = [];
  for (const [key, value] of Object.entries(record)) {
    if (key === "command" && typeof value === "string") continue;
    if (typeof value === "string") parts.push(`${key}=${truncateChars(value, 80)}`);
    else if (typeof value === "number" || typeof value === "boolean") parts.push(`${key}=${String(value)}`);
    else if (value !== undefined && value !== null) parts.push(`${key}=${truncateChars(JSON.stringify(value), 80)}`);
    if (parts.length >= 4) break;
  }
  return truncateChars(parts.join(" "), 260);
}

function extractResultPreview(content: Record<string, unknown>): string {
  for (const key of ["result_preview", "result", "output", "content"]) {
    const value = content[key];
    if (typeof value === "string") return truncateChars(value, 260);
  }
  return "";
}

function extractMessageText(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return "";
  }
  const record = value as Record<string, unknown>;
  for (const key of ["text", "content", "result", "output", "summary"]) {
    if (typeof record[key] === "string") return record[key];
  }
  return "";
}

// -- Supervise tick ----------------------------------------------------------

export async function superviseTickData(
  client: HomeRailClient,
  runId: string,
  cursor: string,
  events: number,
  tools: number,
  contentLimit: number,
): Promise<SuperviseTickResult> {
  const snap = await buildDagSnapshot(client, runId, Math.max(events, 1));
  const chats = await buildDagChats(client, runId, undefined, tools);
  const allEvents = await fetchAllEvents(client, runId);
  const handoffs = extractHandoffs(allEvents, contentLimit);

  const terminal = ["completed", "failed", "cancelled"].includes(
    snap.run_status,
  );
  const waitingForCommand = snap.waiting_for_command;

  const newCursor = `events:${snap.event_count}`;
  const changed = cursor === "" || cursor !== newCursor;

  const summary = terminal
    ? `run ${snap.run_status}; failed=${JSON.stringify(snap.failed_nodes)}`
    : waitingForCommand
      ? `run waiting for command${snap.current_round_id ? ` at ${snap.current_round_id}` : ""}`
    : changed
      ? `${snap.event_count} new event(s); running=${JSON.stringify(snap.running_nodes)}`
      : `no change; running=${JSON.stringify(snap.running_nodes)}`;

  const severity = terminal
    ? snap.run_status === "failed"
      ? "fail"
      : "done"
    : waitingForCommand
      ? "waiting"
    : changed
      ? "update"
      : "heartbeat";

  const report = {
    run_id: runId,
    cursor: newCursor,
    changed,
    terminal,
    waiting_for_command: waitingForCommand,
    summary,
    snapshot: {
      run_status: snap.run_status,
      waiting_for_command: waitingForCommand,
      current_round_id: snap.current_round_id,
      current_phase: snap.current_phase,
      dag_status: snap.dag_status,
      node_counts: snap.node_counts,
      running_nodes: snap.running_nodes,
      ready_nodes: snap.ready_nodes,
      failed_nodes: snap.failed_nodes,
      event_count: snap.event_count,
      stalled_hint: snap.stalled_hint,
    },
    chat_summaries: chats,
    handoffs,
    severity,
  };

  const exitCode = snap.run_status === "failed" ? 1 : 0;

  return {
    new_cursor: newCursor,
    terminal,
    waiting_for_command: waitingForCommand,
    changed,
    severity,
    summary,
    exit_code: exitCode,
    report,
  };
}

export function renderSuperviseTick(
  runId: string,
  result: SuperviseTickResult,
): string {
  const report = result.report as Record<string, unknown>;
  const snap = report.snapshot as Record<string, unknown>;
  const running = Array.isArray(snap.running_nodes)
    ? (snap.running_nodes as string[]).join(", ") || "-"
    : "-";

  return [
    `Supervise Tick: ${runId}`,
    `  Severity: ${result.severity}  Changed: ${result.changed}`,
    `  Summary: ${result.summary}`,
    `  Run: ${snap.run_status ?? "?"}  DAG: ${snap.dag_status ?? "-"}  Events: ${snap.event_count ?? 0}`,
    `  Running: ${running}`,
    `  Cursor: ${result.new_cursor}`,
  ].join("\n");
}

// -- Poll interval helper ----------------------------------------------------

export function normalizedPollIntervalSecs(interval: number): number {
  return Math.max(interval, 0.5);
}
