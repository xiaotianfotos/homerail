import type { AgentEvent } from "./types.js";

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const counters = () => ({ text: 0, reasoning: 0, tool_arguments: 0 });

/** Content-free, bounded transport observations, not token accounting. Keep
 * stream and assembled-message observations separate: they can overlap. */
export class DeepSeekHarnessOutputObservation {
  private readonly stream = counters();
  private readonly messages = counters();
  private streamEvents = 0;
  private messageEvents = 0;
  private snapshots = 0;
  private lastBytes = 0;
  private ended = false;

  observe(event: unknown): AgentEvent | null {
    if (this.ended || !record(event) || !record(event.data)) return null;
    const data = event.data;
    let messageObserved = false;
    if (event.type === "assistant/chunk" && record(data.chunk)) {
      const c = data.chunk;
      if (c.type === "text-delta" && typeof c.text === "string") {
        this.stream.text += Buffer.byteLength(c.text); this.streamEvents++;
      } else if (c.type === "reasoning-delta" && typeof c.text === "string") {
        this.stream.reasoning += Buffer.byteLength(c.text); this.streamEvents++;
      } else if (c.type === "tool-call-delta" && typeof c.argumentsDelta === "string") {
        this.stream.tool_arguments += Buffer.byteLength(c.argumentsDelta); this.streamEvents++;
      }
    } else if (event.type === "assistant/message" && record(data.message)
      && data.message.role === "assistant" && Array.isArray(data.message.content)) {
      this.messageEvents++;
      messageObserved = true;
      for (const block of data.message.content) {
        if (!record(block)) continue;
        if (block.type === "text" && typeof block.text === "string") this.messages.text += Buffer.byteLength(block.text);
        if (block.type === "reasoning" && typeof block.text === "string") this.messages.reasoning += Buffer.byteLength(block.text);
        if (block.type === "tool-call" && typeof block.arguments === "string") this.messages.tool_arguments += Buffer.byteLength(block.arguments);
      }
    }
    const bytes = Object.values(this.stream).reduce((a, b) => a + b, 0)
      + Object.values(this.messages).reduce((a, b) => a + b, 0);
    // At most 16 interim records plus one end record per adapter invocation.
    // A final record is emitted even when the stream is empty or throws.
    if (this.snapshots < 16 && (bytes - this.lastBytes >= 16_384 || messageObserved)) {
      this.lastBytes = bytes; this.snapshots++;
      return this.snapshot(false);
    }
    return null;
  }

  end(): AgentEvent | null {
    if (this.ended) return null;
    this.ended = true;
    return this.snapshot(true);
  }

  private snapshot(final: boolean): AgentEvent {
    return { type: "debug", source: "deepseek-harness", message: "output_observation", data: {
      version: 1, final, unit: "utf8_bytes", stream_bytes: { ...this.stream },
      message_bytes: { ...this.messages }, stream_events: this.streamEvents,
      message_events: this.messageEvents, interim_snapshots: this.snapshots,
      // No text, reasoning, tool names, arguments, identifiers, or provider
      // metadata enter this record. Zero means unobserved, not absent upstream.
      scope: "observed_root_session_events_not_tokens",
    } };
  }
}
