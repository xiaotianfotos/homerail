import { describe, expect, it } from "vitest";
import { buildReviewRecovery } from "../src/runtime/review-recovery.js";

const fence = { runId: "run", nodeId: "kimi_review", sessionId: "session", roundId: "round-0001", generation: 2 };
const message = (text: string, patch: Record<string, unknown> = {}, timestamp = 100) => ({
  role: "worker", type: "response", timestamp,
  content: { text, run_id: fence.runId, node_id: fence.nodeId, session_id: fence.sessionId,
    round_id: fence.roundId, generation: fence.generation, ...patch },
});

describe("bounded unverified review recovery", () => {
  it("preserves only the last final answer inside the exact dispatch fence", () => {
    const value = buildReviewRecovery({ fence, chats: [
      message("earlier answer"), message("valid final draft\nwith references"),
      message("wrong run", { run_id: "other" }), message("wrong node", { node_id: "other" }),
      message("old session", { session_id: "old" }), message("old round", { round_id: "round-0000" }),
      message("old generation", { generation: 1 }), message("unfenced", { session_id: undefined }),
      message("tool output", { type: "tool_result" }), message("hidden thought", { type: "thinking" }),
      { ...message("manager prompt"), role: "manager", type: "prompt" },
    ] });
    expect(value).toEqual({ schema: "review-recovery-v1", mode: "read_only_verify", trust: "unverified_model_draft",
      fence, max_builtin_tool_calls: 32,
      draft: { text: "valid final draft\nwith references", truncated: false, timestamp: 100 } });
    expect(value).not.toHaveProperty("coverage");
    expect(value).not.toHaveProperty("accepted_findings");
  });

  it("keeps missing evidence explicit and excludes unfenced/plain content", () => {
    const value = buildReviewRecovery({ fence, chats: [null, {}, { content: "not an attested answer" }, message("   ")] });
    expect(value.draft).toBeNull();
    expect(value.mode).toBe("read_only_verify");
    expect(value.fence).toEqual(fence);
  });

  it("bounds UTF-8 draft bytes without fabricating complete text or copying reasoning", () => {
    const value = buildReviewRecovery({ fence, chats: [message("审查🙂\n".repeat(3000))] });
    expect(value.draft?.truncated).toBe(true);
    expect(Buffer.byteLength(value.draft!.text, "utf8")).toBeLessThanOrEqual(8192);
    expect(value.draft!.text).not.toContain("\uFFFD");
    expect(value.draft!.text.length).toBeGreaterThan(1000);
    expect(Buffer.byteLength(JSON.stringify(value), "utf8")).toBeLessThan(10000);
  });
});
