import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import {
  _projectGeminiToolSchemaForTest,
  GeminiLiveVoiceRuntime,
  type GeminiLiveVoiceRuntimeEvent,
} from "../src/server/gemini-live-voice-runtime.js";

class FakeGeminiSocket extends EventEmitter {
  readyState = WebSocket.CONNECTING;
  sent: Array<Record<string, unknown>> = [];

  open(): void {
    this.readyState = WebSocket.OPEN;
    this.emit("open");
  }

  send(raw: string): void {
    const message = JSON.parse(raw) as Record<string, unknown>;
    this.sent.push(message);
    if (message.setup) queueMicrotask(() => this.message({ setupComplete: {} }));
  }

  message(message: Record<string, unknown>): void {
    this.emit("message", Buffer.from(JSON.stringify(message)), false);
  }

  close(code = 1000, reason = ""): void {
    this.readyState = WebSocket.CLOSED;
    this.emit("close", code, Buffer.from(reason));
  }

  terminate(): void {
    this.close(1006);
  }
}

describe("GeminiLiveVoiceRuntime", () => {
  it("projects JSON Schema into Gemini's supported function subset", () => {
    const projected = _projectGeminiToolSchemaForTest({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      additionalProperties: false,
      definitions: {
        item: {
          type: "object",
          properties: { id: { type: "string", const: "fixed" } },
          required: ["id"],
          additionalProperties: false,
        },
      },
      properties: {
        item: { $ref: "#/definitions/item" },
      },
      required: ["item"],
    });

    expect(projected).toEqual({
      type: "object",
      properties: {
        item: {
          type: "object",
          properties: { id: { type: "string", enum: ["fixed"] } },
          required: ["id"],
        },
      },
      required: ["item"],
    });
    expect(JSON.stringify(projected)).not.toMatch(/additionalProperties|\$schema|definitions|\$ref/);
  });

  it("configures native audio, streams PCM, and completes HomeRail tool calls", async () => {
    const socket = new FakeGeminiSocket();
    const events: GeminiLiveVoiceRuntimeEvent[] = [];
    const audio: Buffer[] = [];
    const handler = vi.fn(async (args: Record<string, unknown>) => ({
      content: [{ type: "text" as const, text: `echo:${String(args.text)}` }],
    }));
    const runtime = new GeminiLiveVoiceRuntime({
      sessionId: "gemini-live-test",
      apiKey: "test-google-key",
      model: "gemini-3.1-flash-live-preview",
      voice: "Aoede",
      systemPrompt: "You are the HomeRail Manager.",
      initialItems: [{ role: "user", text: "previous request" }],
      tools: [{
        name: "echo",
        description: "Echo text",
        input_schema: {
          type: "object",
          properties: { text: { type: "string" } },
          required: ["text"],
          additionalProperties: false,
        },
        handler,
      }],
      webSocketFactory: (url) => {
        expect(url).toContain("key=test-google-key");
        queueMicrotask(() => socket.open());
        return socket as unknown as WebSocket;
      },
      onEvent: event => events.push(event),
      onAudio: pcm => audio.push(pcm),
    });

    await runtime.start();
    expect(socket.sent[0]).toMatchObject({
      setup: {
        model: "models/gemini-3.1-flash-live-preview",
        generationConfig: {
          responseModalities: ["AUDIO"],
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: "Aoede" } },
          },
        },
        tools: [{ functionDeclarations: [expect.objectContaining({ name: "echo" })] }],
      },
    });
    expect(events).toContainEqual(expect.objectContaining({ type: "session.started" }));

    runtime.appendAudio(Buffer.from([1, 2, 3, 4]));
    runtime.endAudio();
    await runtime.appendText("hello by text");
    expect(socket.sent).toContainEqual({
      realtimeInput: {
        audio: {
          mimeType: "audio/pcm;rate=16000",
          data: Buffer.from([1, 2, 3, 4]).toString("base64"),
        },
      },
    });
    expect(socket.sent).toContainEqual({ realtimeInput: { audioStreamEnd: true } });
    expect(socket.sent).toContainEqual({ realtimeInput: { text: "hello by text" } });

    socket.message({
      toolCall: {
        functionCalls: [{ id: "call-1", name: "echo", args: { text: "HomeRail" } }],
      },
    });
    await vi.waitFor(() => expect(handler).toHaveBeenCalledWith(
      { text: "HomeRail" },
      { tool_call_id: "call-1" },
    ));
    await vi.waitFor(() => expect(socket.sent).toContainEqual({
      toolResponse: {
        functionResponses: [{
          id: "call-1",
          name: "echo",
          response: { output: "echo:HomeRail" },
        }],
      },
    }));

    const pcm = Buffer.from([0, 1, 2, 3]);
    socket.message({
      serverContent: {
        inputTranscription: { text: "你好" },
        outputTranscription: { text: "你好，我来处理" },
        modelTurn: {
          parts: [{
            inlineData: {
              mimeType: "audio/pcm;rate=24000",
              data: pcm.toString("base64"),
            },
          }],
        },
        turnComplete: true,
      },
    });
    await vi.waitFor(() => expect(audio).toEqual([pcm]));
    expect(events).toContainEqual({ type: "transcript.done", role: "user", text: "你好" });
    expect(events).toContainEqual({
      type: "transcript.done",
      role: "assistant",
      text: "你好，我来处理",
    });
    expect(events).toContainEqual({
      type: "manager.turn.completed",
      status: "completed",
    });

    await runtime.stop();
  });

  it("does not send a result for a tool call cancelled while its handler is running", async () => {
    const socket = new FakeGeminiSocket();
    let finish: ((value: { content: Array<{ type: "text"; text: string }> }) => void) | undefined;
    const runtime = new GeminiLiveVoiceRuntime({
      sessionId: "gemini-live-cancel",
      apiKey: "test-google-key",
      model: "gemini-live-model",
      voice: "Aoede",
      systemPrompt: "test",
      tools: [{
        name: "slow",
        description: "Slow tool",
        input_schema: { type: "object", properties: {} },
        handler: () => new Promise(resolve => { finish = resolve }),
      }],
      webSocketFactory: () => {
        queueMicrotask(() => socket.open());
        return socket as unknown as WebSocket;
      },
      onEvent: () => undefined,
      onAudio: () => undefined,
    });
    await runtime.start();

    socket.message({
      toolCall: { functionCalls: [{ id: "cancel-me", name: "slow", args: {} }] },
    });
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    socket.message({ toolCallCancellation: { ids: ["cancel-me"] } });
    finish?.({ content: [{ type: "text", text: "too late" }] });
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(socket.sent.some(message => Boolean(message.toolResponse))).toBe(false);
    await runtime.stop();
  });
});
