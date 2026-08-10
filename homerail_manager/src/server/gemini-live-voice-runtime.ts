import { WebSocket, type RawData } from "ws";
import type { ToolDefinition } from "./host-codex-manager-agent.js";
import {
  GEMINI_LIVE_INPUT_SAMPLE_RATE,
  GEMINI_LIVE_OUTPUT_SAMPLE_RATE,
} from "../domain/live-voice.js";
import type { CodexLiveVoiceRuntimeEvent } from "./codex-live-voice-runtime.js";

const DEFAULT_GEMINI_LIVE_URL =
  "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent";
const SETUP_TIMEOUT_MS = 30_000;
const MAX_UPSTREAM_MESSAGE_BYTES = 8 * 1024 * 1024;

export type GeminiLiveVoiceRuntimeEvent = CodexLiveVoiceRuntimeEvent
  | { type: "audio.interrupted" };

export interface GeminiLiveVoiceRuntimeOptions {
  sessionId: string;
  apiKey: string;
  model: string;
  voice: string;
  systemPrompt: string;
  tools: ToolDefinition[];
  initialItems?: Array<{ role: "user" | "assistant"; text: string }>;
  upstreamUrl?: string;
  onEvent: (event: GeminiLiveVoiceRuntimeEvent) => void;
  onAudio: (pcm: Buffer) => void;
  onToolStateChanged?: () => void | Promise<void>;
  isToolSchemaCurrent?: () => boolean | Promise<boolean>;
  webSocketFactory?: (url: string) => WebSocket;
}

interface GeminiFunctionCall {
  id?: string;
  name?: string;
  args?: Record<string, unknown>;
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function rawDataByteLength(raw: RawData): number {
  if (Array.isArray(raw)) return raw.reduce((total, chunk) => total + chunk.byteLength, 0);
  return raw.byteLength;
}

function safeErrorMessage(value: unknown): string {
  const record = objectValue(value);
  const message = typeof record?.message === "string" ? record.message.trim() : "";
  return message || "Gemini Live encountered an upstream error";
}

function recentConversation(
  items: GeminiLiveVoiceRuntimeOptions["initialItems"],
): string {
  const rows = (items ?? [])
    .slice(-24)
    .map((item) => `${item.role === "assistant" ? "Assistant" : "User"}: ${item.text.trim()}`)
    .filter((row) => !row.endsWith(": "));
  return rows.length
    ? `Recent HomeRail conversation (trusted context only; do not repeat it):\n${rows.join("\n")}`
    : "";
}

function localSchemaRef(ref: string, root: Record<string, unknown>): unknown {
  if (!ref.startsWith("#/")) return undefined;
  let current: unknown = root;
  for (const rawPart of ref.slice(2).split("/")) {
    const part = rawPart.replace(/~1/g, "/").replace(/~0/g, "~");
    current = objectValue(current)?.[part];
    if (current === undefined) return undefined;
  }
  return current;
}

const GEMINI_SCHEMA_SCALAR_KEYS = [
  "type",
  "format",
  "title",
  "description",
  "nullable",
  "default",
  "example",
  "minimum",
  "maximum",
  "minLength",
  "maxLength",
  "pattern",
  "minItems",
  "maxItems",
  "minProperties",
  "maxProperties",
] as const;

/** Project full JSON Schema into the subset accepted by Gemini declarations. */
function geminiFunctionSchema(
  value: unknown,
  root: Record<string, unknown>,
  seenRefs = new Set<string>(),
): Record<string, unknown> {
  const source = objectValue(value) ?? {};
  const ref = typeof source.$ref === "string" ? source.$ref : "";
  if (ref && !seenRefs.has(ref)) {
    const target = localSchemaRef(ref, root);
    if (target) {
      const nextSeen = new Set(seenRefs);
      nextSeen.add(ref);
      return geminiFunctionSchema({
        ...(objectValue(target) ?? {}),
        ...Object.fromEntries(Object.entries(source).filter(([key]) => key !== "$ref")),
      }, root, nextSeen);
    }
  }

  const result: Record<string, unknown> = {};
  for (const key of GEMINI_SCHEMA_SCALAR_KEYS) {
    if (source[key] !== undefined) result[key] = source[key];
  }
  if (Array.isArray(source.enum)) result.enum = source.enum;
  else if (source.const !== undefined) result.enum = [source.const];

  const properties = objectValue(source.properties);
  if (properties) {
    result.properties = Object.fromEntries(
      Object.entries(properties).map(([key, schema]) => [
        key,
        geminiFunctionSchema(schema, root, seenRefs),
      ]),
    );
  }
  if (Array.isArray(source.required)) {
    result.required = source.required.filter((item): item is string => typeof item === "string");
  }
  if (!result.type && (result.properties || result.required)) result.type = "object";
  if (source.items !== undefined) {
    result.items = geminiFunctionSchema(source.items, root, seenRefs);
  }
  if (Array.isArray(source.anyOf)) {
    const alternatives = source.anyOf
      .map((branch) => arrayValue(objectValue(branch)?.required)
        .filter((item): item is string => typeof item === "string"))
      .filter((required) => required.length > 0);
    if (alternatives.length === source.anyOf.length) {
      const guidance = `Provide at least one of: ${alternatives.map((items) => items.join(" + ")).join(", ")}.`;
      result.description = [String(result.description ?? "").trim(), guidance]
        .filter(Boolean)
        .join(" ");
    }
  }

  // Gemini has no allOf/conditional keywords. Merge structural allOf branches
  // so their field guidance survives while HomeRail keeps authoritative input
  // validation inside the actual tool handler.
  for (const branch of arrayValue(source.allOf)) {
    const projected = geminiFunctionSchema(branch, root, seenRefs);
    const projectedProperties = objectValue(projected.properties);
    if (projectedProperties) {
      result.properties = {
        ...objectValue(result.properties),
        ...projectedProperties,
      };
    }
    if (Array.isArray(projected.required)) {
      result.required = [...new Set([
        ...arrayValue(result.required).filter((item): item is string => typeof item === "string"),
        ...projected.required.filter((item): item is string => typeof item === "string"),
      ])];
    }
    if (!result.type && projected.type) result.type = projected.type;
  }
  return result;
}

function projectToolSchema(value: Record<string, unknown>): Record<string, unknown> {
  return geminiFunctionSchema(value, value);
}

function setupMessage(options: GeminiLiveVoiceRuntimeOptions): Record<string, unknown> {
  const history = recentConversation(options.initialItems);
  const systemText = [options.systemPrompt.trim(), history].filter(Boolean).join("\n\n");
  return {
    setup: {
      model: options.model.startsWith("models/") ? options.model : `models/${options.model}`,
      generationConfig: {
        responseModalities: ["AUDIO"],
        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: { voiceName: options.voice },
          },
        },
      },
      systemInstruction: {
        parts: [{ text: systemText }],
      },
      tools: options.tools.length
        ? [{
            functionDeclarations: options.tools.map((tool) => ({
              name: tool.name,
              description: tool.description,
              parameters: projectToolSchema(tool.input_schema),
            })),
          }]
        : [],
      inputAudioTranscription: {},
      outputAudioTranscription: {},
    },
  };
}

export class GeminiLiveVoiceRuntime {
  private readonly options: GeminiLiveVoiceRuntimeOptions;
  private socket: WebSocket | null = null;
  private closed = false;
  private setupComplete = false;
  private turnActive = false;
  private userTranscript = "";
  private assistantTranscript = "";
  private readonly cancelledToolCallIds = new Set<string>();
  private setupWaiter:
    | {
        resolve: () => void;
        reject: (error: Error) => void;
        timer: ReturnType<typeof setTimeout>;
      }
    | undefined;

  constructor(options: GeminiLiveVoiceRuntimeOptions) {
    this.options = options;
  }

  async start(): Promise<void> {
    if (this.socket) throw new Error("Gemini Live session is already started");
    if (!this.options.apiKey.trim()) throw new Error("Google AI Studio API key is missing");
    if (!this.options.model.trim()) throw new Error("Gemini Live model is missing");
    this.closed = false;

    const separator = (this.options.upstreamUrl ?? DEFAULT_GEMINI_LIVE_URL).includes("?") ? "&" : "?";
    const url = `${this.options.upstreamUrl ?? DEFAULT_GEMINI_LIVE_URL}${separator}key=${encodeURIComponent(this.options.apiKey)}`;
    const socket = (this.options.webSocketFactory ?? ((value) => new WebSocket(value)))(url);
    this.socket = socket;

    const setupPromise = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.setupWaiter = undefined;
        reject(new Error("Timed out waiting for Gemini Live setup"));
      }, SETUP_TIMEOUT_MS);
      timer.unref?.();
      this.setupWaiter = { resolve, reject, timer };
    });

    socket.on("open", () => {
      this.sendJson(setupMessage(this.options));
    });
    socket.on("message", (raw) => {
      // Gemini may deliver its JSON envelope in either a text or binary
      // WebSocket frame. Audio remains base64 inside that JSON envelope.
      if (rawDataByteLength(raw) > MAX_UPSTREAM_MESSAGE_BYTES) {
        this.fail(new Error("Gemini Live returned an invalid message"));
        return;
      }
      void this.handleMessage(raw.toString()).catch((error) => this.fail(error));
    });
    socket.on("error", () => {
      this.fail(new Error("Gemini Live WebSocket connection failed"));
    });
    socket.on("close", (code, reason) => {
      if (this.closed) return;
      const detail = reason.toString().trim();
      this.fail(new Error(
        detail
          ? `Gemini Live connection closed (${code}): ${detail}`
          : `Gemini Live connection closed (${code})`,
      ));
    });

    try {
      await setupPromise;
    } catch (error) {
      await this.stop();
      throw error;
    }
  }

  appendAudio(pcm: Buffer): void {
    if (!pcm.length) return;
    if (!this.setupComplete) throw new Error("Gemini Live is not ready for audio");
    this.sendJson({
      realtimeInput: {
        audio: {
          mimeType: `audio/pcm;rate=${GEMINI_LIVE_INPUT_SAMPLE_RATE}`,
          data: pcm.toString("base64"),
        },
      },
    });
  }

  endAudio(): void {
    if (!this.setupComplete) return;
    this.sendJson({ realtimeInput: { audioStreamEnd: true } });
  }

  async appendText(text: string): Promise<void> {
    const value = text.trim();
    if (!value) return;
    if (!this.setupComplete) throw new Error("Gemini Live is not connected");
    this.startTurn();
    this.sendJson({ realtimeInput: { text: value } });
  }

  async stop(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.setupComplete = false;
    if (this.setupWaiter) {
      clearTimeout(this.setupWaiter.timer);
      this.setupWaiter.reject(new Error("Gemini Live stopped before setup completed"));
      this.setupWaiter = undefined;
    }
    const socket = this.socket;
    this.socket = null;
    if (socket && socket.readyState === WebSocket.OPEN) socket.close(1000, "HomeRail session stopped");
    else socket?.terminate();
  }

  private sendJson(message: Record<string, unknown>): void {
    if (this.socket?.readyState !== WebSocket.OPEN) {
      throw new Error("Gemini Live WebSocket is not connected");
    }
    this.socket.send(JSON.stringify(message));
  }

  private startTurn(): void {
    if (this.turnActive) return;
    this.turnActive = true;
    this.options.onEvent({ type: "manager.turn.started" });
  }

  private finishTranscripts(): void {
    const user = this.userTranscript.trim();
    const assistant = this.assistantTranscript.trim();
    if (user) this.options.onEvent({ type: "transcript.done", role: "user", text: user });
    if (assistant) {
      this.options.onEvent({ type: "transcript.done", role: "assistant", text: assistant });
    }
    this.userTranscript = "";
    this.assistantTranscript = "";
  }

  private async handleMessage(raw: string): Promise<void> {
    let message: Record<string, unknown>;
    try {
      message = objectValue(JSON.parse(raw)) ?? {};
    } catch {
      throw new Error("Gemini Live returned malformed JSON");
    }

    if (message.setupComplete !== undefined) {
      this.setupComplete = true;
      if (this.setupWaiter) {
        clearTimeout(this.setupWaiter.timer);
        this.setupWaiter.resolve();
        this.setupWaiter = undefined;
      }
      this.options.onEvent({
        type: "session.started",
        thread_id: this.options.sessionId,
        realtime_session_id: this.options.sessionId,
        version: "gemini-live-v1beta",
      });
    }

    const serverContent = objectValue(message.serverContent);
    if (serverContent) {
      const inputText = String(objectValue(serverContent.inputTranscription)?.text ?? "");
      if (inputText) {
        this.startTurn();
        this.userTranscript += inputText;
        this.options.onEvent({ type: "transcript.delta", role: "user", delta: inputText });
      }
      const outputText = String(objectValue(serverContent.outputTranscription)?.text ?? "");
      if (outputText) {
        this.startTurn();
        this.assistantTranscript += outputText;
        this.options.onEvent({ type: "transcript.delta", role: "assistant", delta: outputText });
      }
      const modelTurn = objectValue(serverContent.modelTurn);
      for (const partValue of arrayValue(modelTurn?.parts)) {
        const part = objectValue(partValue);
        const inlineData = objectValue(part?.inlineData);
        const data = typeof inlineData?.data === "string" ? inlineData.data : "";
        const mimeType = String(inlineData?.mimeType ?? "");
        if (data && mimeType.startsWith("audio/pcm")) {
          this.startTurn();
          this.options.onAudio(Buffer.from(data, "base64"));
        }
      }
      if (serverContent.interrupted === true) {
        this.options.onEvent({ type: "audio.interrupted" });
        this.finishTranscripts();
        if (this.turnActive) {
          this.options.onEvent({ type: "manager.turn.completed", status: "interrupted" });
          this.turnActive = false;
        }
      } else if (serverContent.turnComplete === true) {
        this.finishTranscripts();
        if (this.turnActive) {
          this.options.onEvent({ type: "manager.turn.completed", status: "completed" });
          this.turnActive = false;
        }
      }
    }

    const cancellation = objectValue(message.toolCallCancellation);
    for (const id of arrayValue(cancellation?.ids)) {
      if (typeof id === "string" && id) this.cancelledToolCallIds.add(id);
    }

    const toolCall = objectValue(message.toolCall);
    const calls = arrayValue(toolCall?.functionCalls)
      .map((value) => objectValue(value) as GeminiFunctionCall | undefined)
      .filter((value): value is GeminiFunctionCall => Boolean(value));
    if (calls.length) await this.handleToolCalls(calls);

    if (message.goAway !== undefined) {
      this.options.onEvent({ type: "session.closed", reason: "gemini_go_away" });
    }
    if (message.error !== undefined) throw new Error(safeErrorMessage(message.error));
  }

  private async handleToolCalls(calls: GeminiFunctionCall[]): Promise<void> {
    this.startTurn();
    if (this.options.isToolSchemaCurrent && !(await this.options.isToolSchemaCurrent())) {
      throw new Error("HomeRail Manager tools or permissions changed. Reconnect Live Voice to continue.");
    }

    const functionResponses = await Promise.all(calls.map(async (call) => {
      const id = call.id ?? "";
      const name = call.name ?? "";
      const tool = this.options.tools.find((candidate) => candidate.name === name);
      if (!tool) {
        return { id, name, response: { error: `Unknown HomeRail tool: ${name}` } };
      }
      this.options.onEvent({ type: "manager.tool", name, status: "started" });
      try {
        const result = await tool.handler(call.args ?? {}, { tool_call_id: id });
        if (this.cancelledToolCallIds.has(id)) {
          this.options.onEvent({ type: "manager.tool", name, status: "failed" });
          return null;
        }
        const text = result.content.map((item) => item.text ?? "").join("\n");
        const success = result.is_error !== true;
        await this.options.onToolStateChanged?.();
        this.options.onEvent({
          type: "manager.tool",
          name,
          status: success ? "completed" : "failed",
        });
        return success
          ? { id, name, response: { output: text } }
          : { id, name, response: { error: text } };
      } catch (error) {
        this.options.onEvent({ type: "manager.tool", name, status: "failed" });
        return {
          id,
          name,
          response: { error: error instanceof Error ? error.message : String(error) },
        };
      }
    }));

    const activeResponses = functionResponses.filter((value) => value !== null);
    if (activeResponses.length) {
      this.sendJson({ toolResponse: { functionResponses: activeResponses } });
    }
    for (const call of calls) {
      if (call.id) this.cancelledToolCallIds.delete(call.id);
    }
  }

  private fail(error: unknown): void {
    if (this.closed) return;
    const message = error instanceof Error ? error.message : String(error);
    if (this.setupWaiter) {
      clearTimeout(this.setupWaiter.timer);
      this.setupWaiter.reject(new Error(message));
      this.setupWaiter = undefined;
    }
    this.options.onEvent({
      type: "session.error",
      message: message || "Gemini Live failed",
      recoverable: false,
    });
    void this.stop().catch(() => undefined);
  }
}

export const GEMINI_LIVE_AUDIO_FORMAT = {
  input_sample_rate: GEMINI_LIVE_INPUT_SAMPLE_RATE,
  output_sample_rate: GEMINI_LIVE_OUTPUT_SAMPLE_RATE,
  encoding: "pcm_s16le" as const,
};

export const _projectGeminiToolSchemaForTest = projectToolSchema;
