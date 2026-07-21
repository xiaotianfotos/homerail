/**
 * Claude SDK raw trace writer.
 *
 * Persists the complete, redacted SDK stream outside the Manager control
 * plane so high-frequency provider diagnostics cannot starve scheduling,
 * status, or cancellation requests.
 */

import { once } from "node:events";
import { createWriteStream, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Writable } from "node:stream";
import { homerailPath } from "../platform/paths.js";
import type { AgentRawTraceSink } from "../agent/types.js";
import { redactTelemetry } from "homerail-protocol";
import { assertSafeRunId } from "./tool-event-writer.js";

export interface ClaudeSdkTraceWriter extends AgentRawTraceSink {
  readonly filePath: string;
  close(): Promise<void>;
}

export interface ClaudeSdkTraceWriterOptions {
  baseDir?: string;
  redact?: (value: unknown) => unknown;
}

function traceRoot(baseDir?: string): string {
  return baseDir ?? homerailPath("audit");
}

function safeNodeId(nodeId: string): string {
  return assertSafeRunId(nodeId);
}

export function claudeSdkTracePath(runId: string, nodeId: string, baseDir?: string): string {
  return join(
    traceRoot(baseDir),
    "claude-sdk-traces",
    assertSafeRunId(runId),
    `${safeNodeId(nodeId)}.jsonl`,
  );
}

export function createClaudeSdkTraceWriter(
  runId: string,
  nodeId: string,
  options: ClaudeSdkTraceWriterOptions = {},
): ClaudeSdkTraceWriter {
  const safeRunId = assertSafeRunId(runId);
  const safeNode = safeNodeId(nodeId);
  const filePath = claudeSdkTracePath(safeRunId, safeNode, options.baseDir);
  mkdirSync(join(traceRoot(options.baseDir), "claude-sdk-traces", safeRunId), { recursive: true });
  const stream: Writable = createWriteStream(filePath, { flags: "a", mode: 0o600 });
  let streamError: Error | null = null;
  let closed = false;
  stream.on("error", (error) => {
    streamError = error;
  });

  return {
    filePath,
    async write(record: Record<string, unknown>): Promise<void> {
      if (closed) throw new Error("Claude SDK trace writer is closed");
      if (streamError) throw streamError;
      const redacted = options.redact
        ? options.redact(record)
        : redactTelemetry(record);
      const line = `${JSON.stringify({
        schema_version: "homerail.claude-sdk-trace/v1",
        run_id: safeRunId,
        node_id: safeNode,
        ts: Date.now(),
        ...(redacted as Record<string, unknown>),
      })}\n`;
      if (!stream.write(line)) await once(stream, "drain");
      if (streamError) throw streamError;
    },
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      await new Promise<void>((resolve, reject) => {
        stream.end(resolve);
        stream.once("error", reject);
      });
    },
  };
}

export function readClaudeSdkTrace(
  runId: string,
  nodeId: string,
  baseDir?: string,
): Array<Record<string, unknown>> {
  const raw = readFileSync(claudeSdkTracePath(runId, nodeId, baseDir), "utf8");
  return raw
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}
