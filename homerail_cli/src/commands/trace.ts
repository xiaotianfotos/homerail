/**
 * trace command — Show execution trace for a run (API-first, local fallback)
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { HomeRailClient, BaseResponse } from "../client.js";
import { getHomerailHome } from "../local-config.js";

interface ToolCall {
  name: string;
  args: string;
  notes?: string;
}

interface Handoff {
  port: string;
  content: string;
}

interface Session {
  node_id: string | null;
  timestamp: string;
  node_from: string | null;
  port_from: string | null;
  is_entry: boolean;
  tool_calls: ToolCall[];
  handoff: Handoff | null;
  lines: number;
  file: string;
}

type ToolAuditRecord = Record<string, unknown>;

// -- Helpers -----------------------------------------------------------------

function summarizeArgs(toolName: string, rawArgs: unknown): string {
  let d: Record<string, unknown>;
  if (rawArgs && typeof rawArgs === "object" && !Array.isArray(rawArgs)) {
    d = rawArgs as Record<string, unknown>;
  } else if (typeof rawArgs === "string") {
    try {
      const parsed = JSON.parse(rawArgs);
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        d = parsed as Record<string, unknown>;
      } else {
        return rawArgs.slice(0, 120);
      }
    } catch {
      return rawArgs.slice(0, 120);
    }
  } else {
    return "";
  }

  const lower = toolName.toLowerCase();
  switch (lower) {
    case "read": {
      const path = typeof d.path === "string" ? d.path : "";
      const offset = typeof d.offset === "number" ? d.offset : undefined;
      return offset !== undefined ? `${path}:${offset}` : path;
    }
    case "bash": {
      const cmd = typeof d.command === "string" ? d.command : "";
      return cmd.slice(0, 100);
    }
    case "write":
    case "edit": {
      const p = typeof d.path === "string"
        ? d.path
        : typeof d.file_path === "string"
          ? d.file_path
          : "";
      return p;
    }
    case "handoff":
      return "";
    default: {
      const keys = Object.keys(d);
      if (keys.length > 0) {
        const k = keys[0];
        const v = typeof d[k] === "string" ? d[k] : "?";
        return `${k}=${v}`;
      }
      return "";
    }
  }
}

function extractHandoffPort(rawArgs: unknown): string {
  if (rawArgs && typeof rawArgs === "object" && !Array.isArray(rawArgs)) {
    const d = rawArgs as Record<string, unknown>;
    if (typeof d.port === "string") return d.port;
  }
  if (typeof rawArgs === "string") {
    const match = rawArgs.match(/['"]port['"]:\s*['"](\w+)['"]/);
    if (match) return match[1];
  }
  return "?";
}

function extractHandoffContent(rawArgs: unknown): string {
  let d: Record<string, unknown>;
  if (rawArgs && typeof rawArgs === "object" && !Array.isArray(rawArgs)) {
    d = rawArgs as Record<string, unknown>;
  } else if (typeof rawArgs === "string") {
    try {
      const parsed = JSON.parse(rawArgs);
      if (typeof parsed === "object" && parsed !== null) {
        d = parsed as Record<string, unknown>;
      } else {
        return rawArgs.slice(0, 120);
      }
    } catch {
      return rawArgs.slice(0, 120);
    }
  } else {
    return "";
  }
  const c = typeof d.content === "string" ? d.content : "";
  const firstLine = c.split("\n")[0] ?? c;
  return firstLine.slice(0, 120);
}

function sessionFromApiMessages(nodeId: string, messages: unknown[]): Session {
  const toolCalls: ToolCall[] = [];
  let handoff: Handoff | null = null;

  for (const msgRaw of messages) {
    const msg = msgRaw as Record<string, unknown>;
    const name = typeof msg.tool_name === "string" ? msg.tool_name : null;
    if (!name) continue;

    const rawArgs = msg.tool_input ?? msg.arguments ?? msg.input ?? msg.content ?? null;
    const notes = msg.is_error === true && typeof msg.content === "string"
      ? msg.content.slice(0, 120)
      : undefined;
    const args = summarizeArgs(name, rawArgs);
    toolCalls.push({ name, args, notes });

    if (name.toLowerCase().includes("handoff")) {
      handoff = {
        port: extractHandoffPort(rawArgs),
        content: extractHandoffContent(rawArgs),
      };
    }
  }

  return {
    node_id: nodeId,
    timestamp: "",
    node_from: null,
    port_from: null,
    is_entry: false,
    tool_calls: toolCalls,
    handoff,
    lines: messages.length,
    file: `api:${nodeId}`,
  };
}

function sessionsFromLocalToolAudit(runId: string, nodeFilter?: string): Session[] {
  const events = readLocalToolAuditEvents(runId);
  const grouped = new Map<string, ToolAuditRecord[]>();
  for (const event of events) {
    const nodeId = typeof event.node_id === "string" && event.node_id ? event.node_id : "unknown";
    if (nodeFilter && nodeId !== nodeFilter) continue;
    const existing = grouped.get(nodeId) ?? [];
    existing.push(event);
    grouped.set(nodeId, existing);
  }

  return [...grouped.entries()].map(([nodeId, nodeEvents]) => {
    const toolCalls: ToolCall[] = [];
    let handoff: Handoff | null = null;

    for (const event of nodeEvents) {
      const eventType = typeof event.event === "string" ? event.event : "";
      if (eventType !== "tool_use") continue;

      const name = typeof event.tool_name === "string"
        ? event.tool_name
        : typeof event.name === "string"
          ? event.name
          : "tool";
      const rawArgs = event.input ?? event.tool_input ?? event.arguments ?? null;
      const args = summarizeArgs(name, rawArgs);
      toolCalls.push({ name, args });

      if (name.toLowerCase().includes("handoff")) {
        handoff = {
          port: extractHandoffPort(rawArgs),
          content: extractHandoffContent(rawArgs),
        };
      }
    }

    const first = nodeEvents[0];
    const timestamp = typeof first?.ts === "number"
      ? new Date(first.ts).toISOString()
      : typeof first?.timestamp === "number"
        ? new Date(first.timestamp).toISOString()
        : "";

    return {
      node_id: nodeId,
      timestamp,
      node_from: null,
      port_from: null,
      is_entry: false,
      tool_calls: toolCalls,
      handoff,
      lines: nodeEvents.length,
      file: `local-audit:${nodeId}`,
    };
  });
}

function readLocalToolAuditEvents(runId: string): ToolAuditRecord[] {
  const safeRunId = safeAuditRunId(runId);
  const auditDir = path.join(getHomerailHome(), "audit");
  const runScoped = readJsonl(path.join(auditDir, "tool-events", `${safeRunId}.jsonl`)).filter(
    (event) => event.run_id === undefined || event.run_id === safeRunId,
  );
  const legacy = readJsonl(path.join(auditDir, "tool-events.jsonl")).filter(
    (event) => event.run_id === safeRunId,
  );
  return [...runScoped, ...legacy].sort((a, b) => eventTimestamp(a) - eventTimestamp(b));
}

function safeAuditRunId(runId: string): string {
  if (!runId || runId === "." || runId === ".." || runId.includes("/") || runId.includes("\\")) {
    throw new Error("runId must be a non-empty file-safe identifier");
  }
  if (!/^[A-Za-z0-9._-]+$/.test(runId)) {
    throw new Error("runId contains unsupported characters");
  }
  return runId;
}

function readJsonl(filePath: string): ToolAuditRecord[] {
  if (!fs.existsSync(filePath)) return [];
  const records: ToolAuditRecord[] = [];
  for (const line of fs.readFileSync(filePath, "utf-8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        records.push(parsed as ToolAuditRecord);
      }
    } catch {
      // Legacy local audit files are best-effort debug artifacts.
    }
  }
  return records;
}

function eventTimestamp(event: ToolAuditRecord): number {
  const ts = event.ts ?? event.timestamp;
  return typeof ts === "number" && Number.isFinite(ts) ? ts : 0;
}

function localClaudeSdkTracePath(runId: string, nodeId: string): string {
  const safeRunId = safeAuditRunId(runId);
  const safeNodeId = safeAuditRunId(nodeId);
  return path.join(
    getHomerailHome(),
    "workspace",
    safeRunId,
    ".homerail-runtime",
    "audit",
    "claude-sdk-traces",
    safeRunId,
    `${safeNodeId}.jsonl`,
  );
}

function printRawClaudeSdkTrace(runId: string, nodeId: string, json: boolean): number {
  const filePath = localClaudeSdkTracePath(runId, nodeId);
  if (!fs.existsSync(filePath)) {
    console.error(`Error: no local Claude SDK raw trace for ${runId}/${nodeId}`);
    console.error(`  Expected: ${filePath}`);
    return 1;
  }
  const raw = fs.readFileSync(filePath, "utf8");
  if (json) {
    console.log(JSON.stringify(readJsonl(filePath), null, 2));
  } else {
    // Preserve the exact durable JSONL records. Default `trace` output remains
    // the compact Manager-backed summary; raw output is explicit and local.
    console.log(raw.replace(/\n$/, ""));
  }
  return 0;
}

function nodeIdsFromStatus(data: Record<string, unknown>): string[] {
  const execution = data.execution as Record<string, unknown> | undefined;
  const nodes = execution?.nodes;
  if (nodes && typeof nodes === "object" && !Array.isArray(nodes)) {
    return Object.keys(nodes as Record<string, unknown>).sort();
  }
  const graph = data.graph as Record<string, unknown> | undefined;
  const graphNodes = graph?.nodes;
  if (Array.isArray(graphNodes)) {
    return graphNodes
      .map((n: unknown) => {
        const node = n as Record<string, unknown>;
        return typeof node.node_id === "string"
          ? node.node_id
          : typeof node.id === "string"
            ? node.id
            : null;
      })
      .filter((s: string | null): s is string => s !== null);
  }
  return [];
}

// -- Rendering ---------------------------------------------------------------

function renderTrace(sessions: Session[]): string {
  const lines: string[] = [
    `Trace: (${sessions.length} sessions)`,
    "=".repeat(72),
  ];

  for (let i = 0; i < sessions.length; i++) {
    const s = sessions[i];
    let label: string;
    if (s.is_entry) {
      label = "entry (triage)";
    } else if (s.node_id) {
      label = `node ${s.node_id}`;
    } else if (s.node_from) {
      label = `<- ${s.node_from}.${s.port_from ?? "?"}`;
    } else {
      label = `session-${i}`;
    }
    const ts = s.timestamp.slice(0, 19).replace("T", " ");

    lines.push("");
    lines.push(`[${i + 1}/${sessions.length}] ${label}  (${ts})`);
    lines.push("-".repeat(72));

    if (s.tool_calls.length === 0) {
      lines.push("  (no tool calls)");
    } else {
      for (const tc of s.tool_calls) {
        if (tc.name === "handoff") {
          lines.push(`>>> ${tc.name}`);
          if (s.handoff) {
            lines.push(`    handoff(port=${s.handoff.port})`);
            if (s.handoff.content) {
              lines.push(`    ${s.handoff.content}`);
            }
          }
        } else {
          let line = `  ${tc.name}`;
          if (tc.args) line += `  ${tc.args}`;
          lines.push(line);
        }
      }
    }

    if (s.handoff) {
      lines.push(`  => handoff port=${s.handoff.port}`);
    }
  }

  return lines.join("\n");
}

function printTraceSessions(sessions: Session[], json: boolean): void {
  if (json) {
    console.log(JSON.stringify(sessions, null, 2));
  } else {
    console.log(renderTrace(sessions));
  }
}

// -- Command -----------------------------------------------------------------

export async function cmdTrace(
  client: HomeRailClient,
  runId: string,
  nodeFilter: string | undefined,
  json: boolean,
  raw = false,
): Promise<number> {
  if (raw) {
    if (!nodeFilter) {
      console.error("Error: --raw requires --node <id>");
      return 1;
    }
    return printRawClaudeSdkTrace(runId, nodeFilter, json);
  }
  let nodeIds: string[];

  if (nodeFilter) {
    nodeIds = [nodeFilter];
  } else {
    let dagResp: BaseResponse;
    try {
      dagResp = await client.getDagStatus(runId);
    } catch (err: unknown) {
      const localSessions = sessionsFromLocalToolAudit(runId, nodeFilter);
      if (localSessions.length > 0) {
        printTraceSessions(localSessions, json);
        return 0;
      }
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`Error: no trace evidence for run '${runId}'`);
      console.error(`  Manager API: ${msg}`);
      console.error("  Hint: pass --base-url for a running Manager.");
      return 1;
    }

    if (!dagResp.success || !dagResp.data) {
      const localSessions = sessionsFromLocalToolAudit(runId, nodeFilter);
      if (localSessions.length > 0) {
        printTraceSessions(localSessions, json);
        return 0;
      }
      console.error(`Error: no trace evidence for run '${runId}'`);
      console.error(`  Manager API: ${dagResp.message}`);
      return 1;
    }

    nodeIds = nodeIdsFromStatus(dagResp.data as Record<string, unknown>);
    if (nodeIds.length === 0) {
      const localSessions = sessionsFromLocalToolAudit(runId, nodeFilter);
      if (localSessions.length > 0) {
        printTraceSessions(localSessions, json);
        return 0;
      }
      console.error(`Error: Manager API returned no DAG nodes for run '${runId}'`);
      return 1;
    }
  }

  const sessions: Session[] = [];
  const errors: string[] = [];

  for (const nodeId of nodeIds) {
    try {
      const resp = await client.getNodeChat(runId, nodeId);
      if (!resp.success) {
        errors.push(`${nodeId}: ${resp.message}`);
        continue;
      }
      const data = (resp.data ?? {}) as Record<string, unknown>;
      const messages = Array.isArray(data.messages) ? data.messages : [];
      sessions.push(sessionFromApiMessages(nodeId, messages));
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`${nodeId}: ${msg}`);
    }
  }

  if (sessions.length === 0) {
    const localSessions = sessionsFromLocalToolAudit(runId, nodeFilter);
    if (localSessions.length > 0) {
      printTraceSessions(localSessions, json);
      return 0;
    }
    console.error(`Error: no trace evidence for run '${runId}'`);
    for (const e of errors) {
      console.error(`  ${e}`);
    }
    return 1;
  }

  printTraceSessions(sessions, json);

  return 0;
}
