import { describe, expect, it } from "vitest";
import { DeepSeekHarnessOutputObservation } from "../agent/deepseek-harness-output.js";

describe("bounded DSH output observation", () => {
  it("bounds the emitted records while keeping final totals after many chunks", () => {
    const observation = new DeepSeekHarnessOutputObservation();
    const emitted = [];
    for (let i = 0; i < 100; i++) {
      const result = observation.observe({ type: "assistant/chunk", data: {
        chunk: { type: "tool-call-delta", argumentsDelta: "秘".repeat(6000) },
      } });
      if (result) emitted.push(result);
    }
    emitted.push(observation.end()!);
    expect(emitted).toHaveLength(17);
    expect(emitted.at(-1)).toMatchObject({ data: { final: true, stream_bytes: { tool_arguments: 1_800_000 }, stream_events: 100 } });
    expect(JSON.stringify(emitted)).not.toContain("秘");
    expect(Buffer.byteLength(JSON.stringify(emitted))).toBeLessThan(16_384);
    expect(observation.end()).toBeNull();
  });

  it("separates streamed text from assembled copies and never reports bytes as token usage", () => {
    const observation = new DeepSeekHarnessOutputObservation();
    observation.observe({ type: "assistant/chunk", data: { chunk: { type: "text-delta", text: "你好" } } });
    observation.observe({ type: "assistant/message", data: { message: { role: "assistant", content: [{ type: "text", text: "你好" }] } } });
    expect(observation.end()).toMatchObject({ data: { stream_bytes: { text: 6 }, message_bytes: { text: 6 }, unit: "utf8_bytes" } });
  });

  it("keeps missing or invalid output unobserved, with no raw provider fields", () => {
    const observation = new DeepSeekHarnessOutputObservation();
    for (const event of [null, {}, { type: "assistant/chunk", data: { chunk: { type: "tool-call-delta", argumentsDelta: {} } } },
      { type: "assistant/message", data: { message: { role: "user", content: [{ type: "text", text: "secret" }] } } }]) {
      expect(observation.observe(event)).toBeNull();
    }
    expect(observation.end()).toMatchObject({ data: { stream_events: 0, message_events: 0,
      stream_bytes: { text: 0, reasoning: 0, tool_arguments: 0 } } });
  });
});
