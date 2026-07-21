/**
 * Audit writers — factory that creates transcript, tool-event, checksum,
 * and error-log writers.
 * @version 0.2.0
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import type { TranscriptWriter } from "./transcript-writer.js";
import type { ToolEventWriter } from "./tool-event-writer.js";
import { createTranscriptWriter } from "./transcript-writer.js";
import {
  assertSafeToolEventRunId,
  createToolEventWriter,
  hasToolEventsForRun,
} from "./tool-event-writer.js";
import { checksumTranscript, verifyTranscriptChecksum } from "./checksum.js";
import { homerailPath } from "../platform/paths.js";

export {
  computeLineChecksum,
  checksumTranscript,
  readTranscriptChecksum,
  transcriptChecksumPath,
  verifyTranscript,
  verifyTranscriptChecksum,
  writeTranscriptChecksum,
} from "./checksum.js";
export { logError } from "./error-log.js";
export type { ErrorRecord } from "./error-log.js";

export interface AuditWriters {
  transcript: TranscriptWriter;
  toolEvents: ToolEventWriter;
}

export function createAuditWriters(
  runId: string,
  baseDir?: string,
): AuditWriters {
  assertSafeToolEventRunId(runId);
  return {
    transcript: createTranscriptWriter(runId, baseDir),
    toolEvents: createToolEventWriter(runId, baseDir),
  };
}

export type { TranscriptWriter } from "./transcript-writer.js";
export {
  claudeSdkTracePath,
  createClaudeSdkTraceWriter,
  readClaudeSdkTrace,
} from "./claude-sdk-trace-writer.js";
export type {
  ClaudeSdkTraceWriter,
  ClaudeSdkTraceWriterOptions,
} from "./claude-sdk-trace-writer.js";
export {
  hasToolEventsForRun,
  legacyToolEventsPath,
  readToolEvents,
  toolEventsPath,
} from "./tool-event-writer.js";
export type { ToolEventRecord, ToolEventWriter } from "./tool-event-writer.js";

/** Check whether a run's audit records are complete. */
export interface AuditCompletenessResult {
  complete: boolean;
  missing: string[];
}

export function checkAuditCompleteness(
  runId: string,
  baseDir?: string,
): AuditCompletenessResult {
  const missing: string[] = [];
  const auditDir = baseDir ?? homerailPath("audit");

  // Transcript file check — matches createTranscriptWriter path layout
  const txPath = baseDir
    ? join(baseDir, `${runId}.jsonl`)
    : join(auditDir, "transcripts", `${runId}.jsonl`);
  if (!existsSync(txPath)) {
    missing.push("transcript file missing");
  } else {
    const hash = checksumTranscript(txPath);
    if (!hash) missing.push("transcript checksum failed");
    const sidecarValid = verifyTranscriptChecksum(txPath);
    if (sidecarValid === null) missing.push("transcript checksum sidecar missing");
    else if (!sidecarValid) missing.push("transcript checksum mismatch");
  }

  // Tool events check
  if (!hasToolEventsForRun(runId, baseDir)) {
    missing.push("tool-events file missing");
  }

  return { complete: missing.length === 0, missing };
}
