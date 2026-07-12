/**
 * Session store — persists per-node agent session metadata and transcript
 * to HOMERAIL_HOME/manager/session-store/<session_id>/.
 * @version 0.1.0
 */

import { appendFileSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { AgentRunContext } from "../agent/types.js";
import { homerailPath } from "../platform/paths.js";
import { redactTelemetry } from "homerail-protocol";

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_call_id?: string;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
}

export interface SessionState {
  sessionId: string;
  runId: string;
  nodeId: string;
  messages: ChatMessage[];
  toolCallState: {
    inFlight: boolean;
    pendingToolCallId?: string;
  };
  agentConfig: PersistedAgentConfig;
  timestamp: number;
}

export interface PersistedAgentConfig {
  provider?: string;
  model: string;
  workspace?: string;
}

export interface TranscriptEntry {
  uuid?: string;
  type: string;
  runId: string;
  nodeId: string;
  sessionId: string;
  timestamp: number;
  content?: unknown;
  metadata?: Record<string, unknown>;
}

function sessionDir(baseDir?: string): string {
  return baseDir ?? homerailPath("manager", "session-store");
}

function safeSegment(value: string, label: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`${label} must be non-empty`);
  if (trimmed === "." || trimmed === ".." || trimmed.includes("/") || trimmed.includes("\\")) {
    throw new Error(`${label} contains an unsafe path segment`);
  }
  return trimmed;
}

function sessionRoot(sessionId: string, baseDir?: string): string {
  return join(sessionDir(baseDir), safeSegment(sessionId, "sessionId"));
}

function sessionPath(sessionId: string, baseDir?: string): string {
  return join(sessionRoot(sessionId, baseDir), "session.json");
}

function transcriptPath(sessionId: string, baseDir?: string): string {
  return join(sessionRoot(sessionId, baseDir), "transcript.jsonl");
}

export function redactAgentContext(context: AgentRunContext): PersistedAgentConfig {
  return {
    provider: context.provider,
    model: context.model,
    workspace: context.workspace,
  };
}

export function saveSession(state: SessionState, baseDir?: string): void {
  const dir = sessionRoot(state.sessionId, baseDir);
  mkdirSync(dir, { recursive: true });
  writeFileSync(sessionPath(state.sessionId, baseDir), JSON.stringify(state, null, 2), "utf-8");
}

export function loadSession(sessionId: string, baseDir?: string): SessionState | null {
  const path = sessionPath(sessionId, baseDir);
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, "utf-8");
    const data = JSON.parse(raw) as SessionState;
    if (!data.sessionId || !data.runId || !Array.isArray(data.messages)) return null;
    return data;
  } catch {
    return null;
  }
}

export function appendTranscriptEntry(entry: TranscriptEntry, baseDir?: string): void {
  const dir = sessionRoot(entry.sessionId, baseDir);
  mkdirSync(dir, { recursive: true });
  const normalized = redactTelemetry({ ...entry, uuid: entry.uuid ?? randomUUID() });
  appendFileSync(transcriptPath(entry.sessionId, baseDir), `${JSON.stringify(normalized)}\n`, "utf-8");
}

export function loadTranscript(sessionId: string, baseDir?: string): TranscriptEntry[] {
  const path = transcriptPath(sessionId, baseDir);
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf-8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as TranscriptEntry);
}
