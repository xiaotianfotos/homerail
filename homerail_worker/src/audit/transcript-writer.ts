/**
 * Transcript writer — appends JSONL to HOMERAIL_HOME/audit/transcripts/{run-id}.jsonl.
 * @version 0.1.0
 */

import { createWriteStream, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Writable } from "node:stream";
import { homerailPath } from "../platform/paths.js";
import { writeTranscriptChecksum } from "./checksum.js";
import { assertSafeRunId } from "./tool-event-writer.js";
import { redactTelemetry } from "homerail-protocol";

export interface TranscriptWriter {
  write(entry: Record<string, unknown>): void;
  flush(): Promise<void>;
  close(): Promise<void>;
}

export function createTranscriptWriter(
  runId: string,
  baseDir?: string,
): TranscriptWriter {
  const safeRunId = assertSafeRunId(runId);
  const dir = baseDir ?? homerailPath("audit", "transcripts");
  mkdirSync(dir, { recursive: true });
  const filePath = join(dir, `${safeRunId}.jsonl`);
  const stream: Writable = createWriteStream(filePath, { flags: "a" });

  return {
    write(entry: Record<string, unknown>) {
      const line = JSON.stringify(redactTelemetry({ ...entry, ts: Date.now() })) + "\n";
      stream.write(line);
    },
    flush() {
      return new Promise<void>((resolve, reject) => {
        stream.write("", (err) => (err ? reject(err) : resolve()));
      });
    },
    close() {
      return new Promise<void>((resolve, reject) => {
        stream.end(() => {
          writeTranscriptChecksum(filePath);
          resolve();
        });
        stream.on("error", reject);
      });
    },
  };
}
