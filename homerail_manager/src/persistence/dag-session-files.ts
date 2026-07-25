import { randomUUID } from "node:crypto";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { getSessionStoreRoot } from "../config/env.js";
import { redactTelemetry } from "homerail-protocol";

const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;

export interface SessionTranscriptEntry {
  uuid?: string;
  type: string;
  runId?: string;
  nodeId?: string;
  sessionId?: string;
  timestamp?: number;
  content?: unknown;
  metadata?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface CheckpointForkRequest {
  runId: string;
  nodeId: string;
  parentSessionId: string;
  newSessionId: string;
  entryUuid?: string;
  last?: number;
}

export interface CheckpointForkResult {
  entryUuid: string;
  keptEntries: number;
  totalEntries: number;
}

function sessionDir(baseDir?: string): string {
  return baseDir ?? getSessionStoreRoot();
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

function enforcePrivateMode(path: string, mode: number): void {
  if (process.platform === "win32") return;
  try {
    chmodSync(path, mode);
  } catch {
    // Best effort on filesystems that do not support POSIX modes.
  }
}

function ensurePrivateSessionRoot(sessionId: string, baseDir?: string): string {
  const dir = sessionRoot(sessionId, baseDir);
  mkdirSync(dir, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  enforcePrivateMode(dir, PRIVATE_DIRECTORY_MODE);
  return dir;
}

function writePrivateFile(path: string, content: string): void {
  writeFileSync(path, content, {
    encoding: "utf-8",
    mode: PRIVATE_FILE_MODE,
  });
  enforcePrivateMode(path, PRIVATE_FILE_MODE);
}

function transcriptPath(sessionId: string, baseDir?: string): string {
  return join(sessionRoot(sessionId, baseDir), "transcript.jsonl");
}

function sessionPath(sessionId: string, baseDir?: string): string {
  return join(sessionRoot(sessionId, baseDir), "session.json");
}

function readJsonLines(path: string): SessionTranscriptEntry[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf-8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as SessionTranscriptEntry);
}

function loadSessionSnapshot(sessionId: string, baseDir?: string): Record<string, unknown> | undefined {
  const path = sessionPath(sessionId, baseDir);
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function resolveCheckpointIndex(
  transcript: SessionTranscriptEntry[],
  entryUuid: string | undefined,
  last: number | undefined,
): { index: number; entryUuid: string } {
  if (entryUuid) {
    const index = transcript.findIndex((entry) => entry.uuid === entryUuid);
    if (index < 0) throw new Error(`checkpoint entry uuid not found in transcript: ${entryUuid}`);
    return { index, entryUuid };
  }

  const offset = last === undefined ? 1 : Math.floor(last);
  if (!Number.isFinite(offset) || offset <= 0 || offset > transcript.length) {
    throw new Error(`last must be between 1 and ${transcript.length}`);
  }
  const index = transcript.length - offset;
  const resolved = transcript[index]?.uuid;
  if (typeof resolved === "string" && resolved.trim()) return { index, entryUuid: resolved };
  return { index, entryUuid: `line:${index + 1}` };
}

function remapTranscriptUuids(entries: SessionTranscriptEntry[]): SessionTranscriptEntry[] {
  const oldToNew = new Map<string, string>();
  return entries.map((entry) => {
    const next: SessionTranscriptEntry = { ...entry };
    if (typeof entry.uuid === "string" && entry.uuid.trim()) {
      const replacement = randomUUID();
      oldToNew.set(entry.uuid, replacement);
      next.uuid = replacement;
    }
    const parentUuid = typeof entry.parentUuid === "string" ? entry.parentUuid : undefined;
    if (parentUuid && oldToNew.has(parentUuid)) {
      next.parentUuid = oldToNew.get(parentUuid);
    }
    return next;
  });
}

export function loadSessionTranscript(sessionId: string, baseDir?: string): SessionTranscriptEntry[] {
  return readJsonLines(transcriptPath(sessionId, baseDir));
}

export function appendSessionTranscriptEntry(
  entry: SessionTranscriptEntry,
  baseDir?: string,
): SessionTranscriptEntry {
  const sessionId = typeof entry.sessionId === "string" && entry.sessionId.trim()
    ? entry.sessionId.trim()
    : "";
  if (!sessionId) throw new Error("sessionId must be non-empty");
  ensurePrivateSessionRoot(sessionId, baseDir);
  const normalized: SessionTranscriptEntry = {
    ...entry,
    content: redactTelemetry(entry.content),
    ...(entry.metadata ? { metadata: redactTelemetry(entry.metadata) as Record<string, unknown> } : {}),
    uuid: entry.uuid ?? randomUUID(),
    timestamp: typeof entry.timestamp === "number" ? entry.timestamp : Date.now(),
  };
  const path = transcriptPath(sessionId, baseDir);
  appendFileSync(path, `${JSON.stringify(normalized)}\n`, {
    encoding: "utf-8",
    mode: PRIVATE_FILE_MODE,
  });
  enforcePrivateMode(path, PRIVATE_FILE_MODE);
  const snapshotPath = sessionPath(sessionId, baseDir);
  if (!existsSync(snapshotPath)) {
    writePrivateFile(
      snapshotPath,
      JSON.stringify({
        sessionId,
        runId: entry.runId,
        nodeId: entry.nodeId,
        messages: [],
        toolCallState: { inFlight: false },
        timestamp: normalized.timestamp,
      }, null, 2),
    );
  } else {
    enforcePrivateMode(snapshotPath, PRIVATE_FILE_MODE);
  }
  return normalized;
}

export function checkpointForkSession(
  request: CheckpointForkRequest,
  baseDir?: string,
): CheckpointForkResult {
  const parentTranscript = loadSessionTranscript(request.parentSessionId, baseDir);
  if (parentTranscript.length === 0) {
    throw new Error(`No transcript found for parent session ${request.parentSessionId}`);
  }
  if (request.newSessionId === request.parentSessionId) {
    throw new Error("checkpoint resume requires a new forked session id; refusing to reuse the parent session");
  }
  if (existsSync(transcriptPath(request.newSessionId, baseDir))) {
    throw new Error(`forked session already exists: ${request.newSessionId}`);
  }

  const checkpoint = resolveCheckpointIndex(parentTranscript, request.entryUuid, request.last);
  const copiedEntries = remapTranscriptUuids(parentTranscript.slice(0, checkpoint.index + 1));
  const forkedEntries = copiedEntries.map((entry) => ({
    ...entry,
    runId: request.runId,
    nodeId: request.nodeId,
    sessionId: request.newSessionId,
    metadata: {
      ...(typeof entry.metadata === "object" && entry.metadata !== null ? entry.metadata : {}),
      rewoundFromSessionId: request.parentSessionId,
      rewoundFromEntryUuid: checkpoint.entryUuid,
    },
  }));

  ensurePrivateSessionRoot(request.newSessionId, baseDir);
  writePrivateFile(
    transcriptPath(request.newSessionId, baseDir),
    forkedEntries.map((entry) => JSON.stringify(entry)).join("\n") + "\n",
  );

  const parentSnapshot = loadSessionSnapshot(request.parentSessionId, baseDir);
  const nextSnapshot = {
    ...(parentSnapshot ?? {}),
    sessionId: request.newSessionId,
    runId: request.runId,
    nodeId: request.nodeId,
    parentSessionId: request.parentSessionId,
    forkedFromEntryUuid: checkpoint.entryUuid,
    timestamp: Date.now(),
  };
  writePrivateFile(
    sessionPath(request.newSessionId, baseDir),
    JSON.stringify(nextSnapshot, null, 2),
  );

  return {
    entryUuid: checkpoint.entryUuid,
    keptEntries: forkedEntries.length,
    totalEntries: parentTranscript.length,
  };
}

export function appendSessionTranscriptForTest(
  sessionId: string,
  entries: Array<Partial<SessionTranscriptEntry>>,
  baseDir?: string,
): void {
  ensurePrivateSessionRoot(sessionId, baseDir);
  const normalized = entries.map((entry) => ({
    uuid: entry.uuid ?? randomUUID(),
    type: entry.type ?? "test",
    sessionId,
    timestamp: typeof entry.timestamp === "number" ? entry.timestamp : Date.now(),
    ...entry,
  }));
  writePrivateFile(
    transcriptPath(sessionId, baseDir),
    normalized.map((entry) => JSON.stringify(entry)).join("\n") + "\n",
  );
  writePrivateFile(
    sessionPath(sessionId, baseDir),
    JSON.stringify({ sessionId, messages: [], toolCallState: { inFlight: false }, timestamp: Date.now() }, null, 2),
  );
}
