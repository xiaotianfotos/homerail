/**
 * Tests for audit writers (transcript + tool-event + checksum + error-log).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createAuditWriters,
  computeLineChecksum,
  checksumTranscript,
  verifyTranscript,
  transcriptChecksumPath,
  writeTranscriptChecksum,
  logError,
  checkAuditCompleteness,
  claudeSdkTracePath,
  createClaudeSdkTraceWriter,
  readClaudeSdkTrace,
  readToolEvents,
} from "../audit/index.js";

describe("audit writers", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "homerail-audit-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  describe("transcript writer", () => {
    it("creates JSONL file and appends entries", async () => {
      const { transcript } = createAuditWriters("run-test", dir);

      transcript.write({ event: "start", data: "hello" });
      transcript.write({ event: "end", data: "bye" });
      await transcript.close();

      const filePath = join(dir, "run-test.jsonl");
      const content = readFileSync(filePath, "utf-8");
      const lines = content.trim().split("\n");

      expect(lines).toHaveLength(2);
      expect(existsSync(transcriptChecksumPath(filePath))).toBe(true);
      const first = JSON.parse(lines[0]);
      expect(first.event).toBe("start");
      expect(first.ts).toBeDefined();
      const second = JSON.parse(lines[1]);
      expect(second.event).toBe("end");
    });
  });

  describe("tool event writer", () => {
    it("creates JSONL file and appends events", async () => {
      const { toolEvents } = createAuditWriters("run-test", dir);

      toolEvents.write({ event: "tool_use", name: "handoff", node_id: "node-a" });
      await toolEvents.close();

      const filePath = join(dir, "tool-events", "run-test.jsonl");
      const content = readFileSync(filePath, "utf-8");
      const lines = content.trim().split("\n");

      expect(lines).toHaveLength(1);
      const entry = JSON.parse(lines[0]);
      expect(entry.event).toBe("tool_use");
      expect(entry.name).toBe("handoff");
      expect(entry.run_id).toBe("run-test");
      expect(entry.node_id).toBe("node-a");
      expect(entry.ts).toBeDefined();
    });

    it("stores tool events for separate runs in separate files", async () => {
      const runA = createAuditWriters("run-a", dir).toolEvents;
      runA.write({ event: "tool_use", name: "echo-a", node_id: "node-a" });
      await runA.close();

      const runB = createAuditWriters("run-b", dir).toolEvents;
      runB.write({ event: "tool_use", name: "echo-b", node_id: "node-b" });
      await runB.close();

      const eventsA = readToolEvents("run-a", dir);
      const eventsB = readToolEvents("run-b", dir);

      expect(eventsA).toHaveLength(1);
      expect(eventsA[0].name).toBe("echo-a");
      expect(eventsA[0].run_id).toBe("run-a");
      expect(eventsB).toHaveLength(1);
      expect(eventsB[0].name).toBe("echo-b");
      expect(eventsB[0].run_id).toBe("run-b");
      expect(existsSync(join(dir, "tool-events", "run-a.jsonl"))).toBe(true);
      expect(existsSync(join(dir, "tool-events", "run-b.jsonl"))).toBe(true);
    });

    it("reads legacy global tool-events JSONL by run_id", () => {
      writeFileSync(
        join(dir, "tool-events.jsonl"),
        [
          JSON.stringify({ event: "tool_use", name: "legacy-a", run_id: "run-legacy", ts: 1 }),
          JSON.stringify({ event: "tool_use", name: "other", run_id: "run-other", ts: 2 }),
          "{malformed",
          "",
        ].join("\n"),
      );

      const events = readToolEvents("run-legacy", dir);

      expect(events).toHaveLength(1);
      expect(events[0].name).toBe("legacy-a");
      expect(events[0].run_id).toBe("run-legacy");
    });

    it("rejects unsafe run IDs before creating audit files", () => {
      expect(() => createAuditWriters("../run", dir)).toThrow(/file-safe identifier/);
      expect(existsSync(join(dir, "..", "run.jsonl"))).toBe(false);
    });
  });

  describe("Claude SDK trace writer", () => {
    it("stores complete redacted SDK records outside the Manager transcript", async () => {
      const writer = createClaudeSdkTraceWriter("run-trace", "node-a", {
        baseDir: dir,
        redact: (value) => JSON.parse(JSON.stringify(value).split("secret-value").join("***")),
      });

      await writer.write({
        record_type: "query_start",
        prompt: "use secret-value",
      });
      await writer.write({
        record_type: "sdk_message",
        sequence: 1,
        message: { type: "system", subtype: "thinking_tokens" },
      });
      await writer.close();

      expect(writer.filePath).toBe(claudeSdkTracePath("run-trace", "node-a", dir));
      const records = readClaudeSdkTrace("run-trace", "node-a", dir);
      expect(records).toHaveLength(2);
      expect(records[0]).toMatchObject({
        schema_version: "homerail.claude-sdk-trace/v1",
        run_id: "run-trace",
        node_id: "node-a",
        record_type: "query_start",
        prompt: "use ***",
      });
      expect(records[1]).toMatchObject({
        record_type: "sdk_message",
        sequence: 1,
        message: { type: "system", subtype: "thinking_tokens" },
      });
    });

    it("rejects unsafe run and node identifiers", () => {
      expect(() => createClaudeSdkTraceWriter("../run", "node-a", { baseDir: dir }))
        .toThrow(/file-safe identifier/);
      expect(() => createClaudeSdkTraceWriter("run-a", "../node", { baseDir: dir }))
        .toThrow(/file-safe identifier/);
    });
  });

  describe("checksums", () => {
    it("computes deterministic line checksum", () => {
      const a = computeLineChecksum("hello");
      const b = computeLineChecksum("hello");
      expect(a).toBe(b);
      expect(a).toHaveLength(64); // SHA-256 hex
    });

    it("checksums a transcript file", () => {
      const txDir = join(dir, "transcripts");
      mkdirSync(txDir, { recursive: true });
      writeFileSync(join(txDir, "run-test.jsonl"), "line1\nline2\n");

      const hash = checksumTranscript(join(txDir, "run-test.jsonl"));
      expect(hash).not.toBeNull();
      expect(hash).toHaveLength(64);
    });

    it("verifyTranscript returns true for matching hash", () => {
      const txDir = join(dir, "transcripts");
      mkdirSync(txDir, { recursive: true });
      const path = join(txDir, "run-v.jsonl");
      writeFileSync(path, "data");

      const hash = checksumTranscript(path)!;
      expect(verifyTranscript(path, hash)).toBe(true);
      expect(verifyTranscript(path, "bad")).toBe(false);
    });

    it("checksumTranscript returns null for missing file", () => {
      expect(checksumTranscript("/nonexistent/path.jsonl")).toBeNull();
    });
  });

  describe("error log", () => {
    it("appends structured error records", () => {
      logError(
        {
          timestamp: "2026-01-01T00:00:00Z",
          errorType: "api_error",
          agentBackend: "claude-sdk",
          message: "timeout",
          retryCount: 2,
          finalStatus: "fatal",
        },
        dir,
      );

      const path = join(dir, "errors.jsonl");
      expect(existsSync(path)).toBe(true);
      const content = readFileSync(path, "utf-8");
      const record = JSON.parse(content.trim());
      expect(record.errorType).toBe("api_error");
      expect(record.retryCount).toBe(2);
    });
  });

  describe("checkAuditCompleteness", () => {
    it("reports missing transcript and tool-events for empty audit dir", () => {
      const result = checkAuditCompleteness("run-x", dir);
      expect(result.complete).toBe(false);
      expect(result.missing).toContain("transcript file missing");
      expect(result.missing).toContain("tool-events file missing");
    });

    it("reports complete when both files exist", async () => {
      // Create transcript
      const { transcript } = createAuditWriters("run-x", dir);
      transcript.write({ event: "start" });
      await transcript.close();

      // Create tool events
      const { toolEvents } = createAuditWriters("run-x", dir);
      toolEvents.write({ event: "tool_use", name: "echo" });
      await toolEvents.close();

      const result = checkAuditCompleteness("run-x", dir);
      expect(result.complete).toBe(true);
      expect(result.missing).toHaveLength(0);
    });

    it("does not treat another run's legacy global tool event as complete", async () => {
      writeFileSync(join(dir, "run-x.jsonl"), JSON.stringify({ event: "start" }) + "\n");
      writeFileSync(
        join(dir, "tool-events.jsonl"),
        JSON.stringify({ event: "tool_use", name: "echo", run_id: "run-other" }) + "\n",
      );

      const result = checkAuditCompleteness("run-x", dir);

      expect(result.complete).toBe(false);
      expect(result.missing).toContain("tool-events file missing");
    });

    it("accepts a matching legacy global tool event for compatibility", async () => {
      const transcriptPath = join(dir, "run-legacy.jsonl");
      writeFileSync(transcriptPath, JSON.stringify({ event: "start" }) + "\n");
      writeTranscriptChecksum(transcriptPath);
      writeFileSync(
        join(dir, "tool-events.jsonl"),
        JSON.stringify({ event: "tool_use", name: "echo", run_id: "run-legacy" }) + "\n",
      );

      const result = checkAuditCompleteness("run-legacy", dir);

      expect(result.complete).toBe(true);
      expect(result.missing).toHaveLength(0);
    });

    it("reports transcript checksum mismatch after tampering", async () => {
      const { transcript, toolEvents } = createAuditWriters("run-tampered", dir);
      transcript.write({ event: "start" });
      toolEvents.write({ event: "tool_use", name: "echo" });
      await transcript.close();
      await toolEvents.close();

      writeFileSync(join(dir, "run-tampered.jsonl"), JSON.stringify({ event: "changed" }) + "\n");

      const result = checkAuditCompleteness("run-tampered", dir);
      expect(result.complete).toBe(false);
      expect(result.missing).toContain("transcript checksum mismatch");
    });
  });

  describe("HOMERAIL_HOME defaults", () => {
    it("stores audit records under HOMERAIL_HOME when baseDir is omitted", async () => {
      const previous = process.env.HOMERAIL_HOME;
      process.env.HOMERAIL_HOME = dir;
      try {
        const { transcript, toolEvents } = createAuditWriters("run-home");
        transcript.write({ event: "start" });
        toolEvents.write({ event: "tool_use", name: "handoff" });
        await transcript.close();
        await toolEvents.close();

        logError({
          timestamp: "2026-01-01T00:00:00Z",
          errorType: "api_error",
          agentBackend: "claude-sdk",
          message: "timeout",
          retryCount: 1,
          finalStatus: "recovered",
        });

        expect(existsSync(join(dir, "audit", "transcripts", "run-home.jsonl"))).toBe(true);
        expect(existsSync(join(dir, "audit", "transcripts", "run-home.jsonl.sha256"))).toBe(true);
        expect(existsSync(join(dir, "audit", "tool-events", "run-home.jsonl"))).toBe(true);
        expect(existsSync(join(dir, "audit", "tool-events.jsonl"))).toBe(false);
        expect(existsSync(join(dir, "audit", "errors.jsonl"))).toBe(true);
        expect(checkAuditCompleteness("run-home").complete).toBe(true);
      } finally {
        if (previous === undefined) {
          delete process.env.HOMERAIL_HOME;
        } else {
          process.env.HOMERAIL_HOME = previous;
        }
      }
    });
  });
});
