/**
 * Tool event writer — appends JSONL to HOMERAIL_HOME/audit/tool-events/{run-id}.jsonl.
 * @version 0.1.0
 */

import { createWriteStream, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Writable } from "node:stream";
import { homerailPath } from "../platform/paths.js";
import { redactTelemetry } from "homerail-protocol";

export type ToolEventRecord = Record<string, unknown>;

export interface ToolEventWriter {
  write(event: ToolEventRecord): void;
  flush(): Promise<void>;
  close(): Promise<void>;
}

export function assertSafeRunId(runId: string): string {
  if (!runId || runId === "." || runId === ".." || runId.includes("/") || runId.includes("\\")) {
    throw new Error("runId must be a non-empty file-safe identifier");
  }
  if (!/^[A-Za-z0-9._-]+$/.test(runId)) {
    throw new Error("runId contains unsupported characters");
  }
  return runId;
}

export const assertSafeToolEventRunId = assertSafeRunId;

function auditRoot(baseDir?: string): string {
  return baseDir ?? homerailPath("audit");
}

export function toolEventsPath(runId: string, baseDir?: string): string {
  return join(auditRoot(baseDir), "tool-events", `${assertSafeToolEventRunId(runId)}.jsonl`);
}

export function legacyToolEventsPath(baseDir?: string): string {
  return join(auditRoot(baseDir), "tool-events.jsonl");
}

export function createToolEventWriter(runId: string, baseDir?: string): ToolEventWriter {
  const safeRunId = assertSafeToolEventRunId(runId);
  const dir = join(auditRoot(baseDir), "tool-events");
  mkdirSync(dir, { recursive: true });
  const filePath = toolEventsPath(safeRunId, baseDir);
  const stream: Writable = createWriteStream(filePath, { flags: "a" });

  return {
    write(event: ToolEventRecord) {
      const line = JSON.stringify(redactTelemetry({ ...event, run_id: safeRunId, ts: Date.now() })) + "\n";
      stream.write(line);
    },
    flush() {
      return new Promise<void>((resolve, reject) => {
        stream.write("", (err) => (err ? reject(err) : resolve()));
      });
    },
    close() {
      return new Promise<void>((resolve, reject) => {
        stream.end(() => resolve());
        stream.on("error", reject);
      });
    },
  };
}

export function readToolEvents(runId: string, baseDir?: string): ToolEventRecord[] {
  const safeRunId = assertSafeToolEventRunId(runId);
  const runScoped = readJsonl(toolEventsPath(safeRunId, baseDir)).filter(
    (event) => event.run_id === undefined || event.run_id === safeRunId,
  );
  const legacy = readJsonl(legacyToolEventsPath(baseDir)).filter(
    (event) => event.run_id === safeRunId,
  );
  return [...runScoped, ...legacy].sort(compareToolEvents);
}

export function hasToolEventsForRun(runId: string, baseDir?: string): boolean {
  const safeRunId = assertSafeToolEventRunId(runId);
  if (existsSync(toolEventsPath(safeRunId, baseDir))) return true;
  return readJsonl(legacyToolEventsPath(baseDir)).some((event) => event.run_id === safeRunId);
}

function readJsonl(filePath: string): ToolEventRecord[] {
  if (!existsSync(filePath)) return [];
  const raw = readFileSync(filePath, "utf-8");
  const records: ToolEventRecord[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        records.push(parsed as ToolEventRecord);
      }
    } catch {
      // Legacy local audit files are best-effort debug artifacts.
    }
  }
  return records;
}

function compareToolEvents(a: ToolEventRecord, b: ToolEventRecord): number {
  return eventTimestamp(a) - eventTimestamp(b);
}

function eventTimestamp(event: ToolEventRecord): number {
  const ts = event.ts ?? event.timestamp;
  return typeof ts === "number" && Number.isFinite(ts) ? ts : 0;
}
