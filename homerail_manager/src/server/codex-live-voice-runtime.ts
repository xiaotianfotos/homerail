import { createHash, randomUUID } from "node:crypto";
import {
  _buildCodexThreadResumeParamsForTest,
  _buildCodexThreadStartParamsForTest,
  buildCodexLiveAppServerArgs,
  type ToolDefinition,
} from "./host-codex-manager-agent.js";
import {
  CodexAppServerClient,
  type CodexAppServerMessage,
} from "./codex-appserver-client.js";
import { acquireCodexThreadLease } from "./codex-thread-lease.js";

export type CodexLiveVoiceRuntimeEvent =
  | { type: "session.started"; thread_id: string; realtime_session_id?: string; version: string }
  | { type: "session.sdp"; sdp: string }
  | { type: "transcript.delta"; role: string; delta: string }
  | { type: "transcript.done"; role: string; text: string }
  | { type: "handoff" }
  | { type: "manager.turn.started"; turn_id?: string }
  | { type: "manager.progress"; text: string }
  | { type: "manager.turn.completed"; status?: string }
  | { type: "manager.tool"; name: string; status: "started" | "completed" | "failed" }
  | { type: "session.error"; message: string }
  | { type: "session.closed"; reason?: string };

export interface CodexLiveVoiceInitialItem {
  role: "user" | "assistant" | "developer";
  text: string;
}

export interface CodexLiveVoiceRuntimeOptions {
  sessionId: string;
  cwd: string;
  model: string;
  voice?: string;
  provider?: string;
  serviceTier?: string | null;
  reasoningEffort?: string;
  systemPrompt: string;
  tools: ToolDefinition[];
  skillRoots?: string[];
  initialItems?: CodexLiveVoiceInitialItem[];
  env?: Record<string, string | undefined>;
  codexBin?: string;
  onEvent: (event: CodexLiveVoiceRuntimeEvent) => void;
  onToolStateChanged?: () => void | Promise<void>;
  isToolSchemaCurrent?: () => boolean | Promise<boolean>;
  clientFactory?: (options: {
    cwd: string;
    env?: Record<string, string | undefined>;
    codexBin?: string;
  }) => CodexAppServerClient;
}

function resultThreadId(result: Record<string, unknown>): string | undefined {
  if (typeof result.threadId === "string") return result.threadId;
  if (typeof result.thread_id === "string") return result.thread_id;
  const thread = result.thread;
  return thread && typeof thread === "object" && !Array.isArray(thread)
    && typeof (thread as Record<string, unknown>).id === "string"
    ? String((thread as Record<string, unknown>).id)
    : undefined;
}

function itemRoot(params: Record<string, unknown> | undefined): Record<string, unknown> {
  const item = params?.item;
  if (!item || typeof item !== "object" || Array.isArray(item)) return {};
  const record = item as Record<string, unknown>;
  const root = record.root;
  return root && typeof root === "object" && !Array.isArray(root)
    ? root as Record<string, unknown>
    : record;
}

function turnRecord(params: Record<string, unknown> | undefined): Record<string, unknown> {
  const turn = params?.turn;
  return turn && typeof turn === "object" && !Array.isArray(turn)
    ? turn as Record<string, unknown>
    : {};
}

function messageText(params: Record<string, unknown> | undefined): string {
  if (typeof params?.message === "string") return params.message;
  const error = params?.error;
  if (error && typeof error === "object" && !Array.isArray(error)) {
    const value = (error as Record<string, unknown>).message;
    if (typeof value === "string") return value;
  }
  return "Codex Live Voice encountered an error";
}

function liveThreadName(sessionId: string, tools: ToolDefinition[]): string {
  const digest = createHash("sha256")
    .update(JSON.stringify(tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.input_schema,
    }))))
    .digest("hex")
    .slice(0, 16);
  const sessionDigest = createHash("sha256").update(sessionId).digest("hex").slice(0, 16);
  return `homerail-live-${sessionDigest}-${digest}`;
}

export class CodexLiveVoiceRuntime {
  private readonly options: CodexLiveVoiceRuntimeOptions;
  private client: CodexAppServerClient | null = null;
  private threadId: string | null = null;
  private lease: ReturnType<typeof acquireCodexThreadLease> = null;
  private closed = false;
  private answerSdp:
    | {
        resolve: (sdp: string) => void;
        reject: (error: Error) => void;
        timer: ReturnType<typeof setTimeout>;
      }
    | undefined;
  private agentMessageDeltas = new Map<string, string[]>();

  constructor(options: CodexLiveVoiceRuntimeOptions) {
    this.options = options;
  }

  async start(offerSdp: string): Promise<string> {
    if (this.client) throw new Error("Codex Live Voice session is already started");
    if (!offerSdp.trim()) throw new Error("Live Voice requires a WebRTC SDP offer");
    this.lease = acquireCodexThreadLease(
      this.options.sessionId,
      `live:${randomUUID()}`,
    );
    if (!this.lease) {
      throw new Error("This Manager session already has an active Codex turn or Live Voice connection");
    }

    try {
      const factory = this.options.clientFactory ?? ((input) => new CodexAppServerClient({
        cwd: input.cwd,
        env: input.env,
        codexBin: input.codexBin,
        args: buildCodexLiveAppServerArgs(),
      }));
      this.client = factory({
        cwd: this.options.cwd,
        env: this.options.env,
        codexBin: this.options.codexBin,
      });
      this.client.onMessage((message) => {
        void this.handleMessage(message);
      });
      await this.client.start();
      await this.client.initialize();
      await this.prepareSkills();
      const resumed = await this.findAndResumeThread();
      if (!this.threadId) await this.startThread();
      const threadId = this.threadId!;

      const sdpPromise = new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => {
          this.answerSdp = undefined;
          reject(new Error("Timed out waiting for Codex Live Voice SDP answer"));
        }, 45_000);
        timer.unref?.();
        this.answerSdp = { resolve, reject, timer };
      });
      await this.client.request("thread/realtime/start", {
        threadId,
        version: "v3",
        outputModality: "audio",
        transport: { type: "webrtc", sdp: offerSdp },
        includeStartupContext: true,
        flushTranscriptTailOnSessionEnd: false,
        clientManagedHandoffs: false,
        codexResponseHandoffMode: "bemTags",
        ...(this.options.voice ? { voice: this.options.voice } : {}),
        ...(!resumed && this.options.initialItems?.length
          ? { initialItems: this.options.initialItems.slice(-128) }
          : {}),
      }, 60_000);
      return await sdpPromise;
    } catch (error) {
      await this.stop();
      throw error;
    }
  }

  async appendText(text: string): Promise<void> {
    const value = text.trim();
    if (!value) return;
    if (!this.client || !this.threadId) throw new Error("Codex Live Voice is not connected");
    await this.client.request("thread/realtime/appendText", {
      threadId: this.threadId,
      role: "user",
      text: value,
    });
  }

  async stop(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const client = this.client;
    const threadId = this.threadId;
    this.client = null;
    this.threadId = null;
    if (this.answerSdp) {
      clearTimeout(this.answerSdp.timer);
      this.answerSdp.reject(new Error("Codex Live Voice stopped before SDP negotiation completed"));
      this.answerSdp = undefined;
    }
    if (client && threadId) {
      try {
        await client.request("thread/realtime/stop", { threadId }, 5_000);
      } catch {
        // Best-effort realtime cleanup.
      }
      try {
        await client.request("thread/unsubscribe", { threadId }, 5_000);
      } catch {
        // Best-effort subscription cleanup.
      }
    }
    client?.close();
    this.lease?.release();
    this.lease = null;
  }

  private async prepareSkills(): Promise<void> {
    if (!this.client) return;
    const roots = [...new Set((this.options.skillRoots ?? []).filter(Boolean))];
    if (!roots.length) return;
    await this.client.request("skills/extraRoots/set", { extraRoots: roots });
    await this.client.request("skills/list", {
      cwds: [this.options.cwd],
      forceReload: true,
    });
  }

  private async findAndResumeThread(): Promise<boolean> {
    if (!this.client) return false;
    const name = liveThreadName(this.options.sessionId, this.options.tools);
    try {
      const listed = await this.client.request("thread/list", {
        limit: 20,
        sourceKinds: ["appServer"],
        cwd: this.options.cwd,
        searchTerm: name,
        useStateDbOnly: true,
      });
      const entries = Array.isArray(listed.data)
        ? listed.data as Array<Record<string, unknown>>
        : [];
      const match = entries.find((entry) => entry.name === name && typeof entry.id === "string");
      if (!match) return false;
      const sandbox = process.env.HOMERAIL_CODEX_MANAGER_SANDBOX || "danger-full-access";
      const resumed = await this.client.request(
        "thread/resume",
        _buildCodexThreadResumeParamsForTest({
          threadId: String(match.id),
          systemPrompt: this.options.systemPrompt,
          cwd: this.options.cwd,
          model: this.options.model,
          provider: this.options.provider,
          serviceTier: this.options.serviceTier,
          sandbox,
          reasoningEffort: this.options.reasoningEffort,
        }),
      );
      this.threadId = resultThreadId(resumed) ?? String(match.id);
      return true;
    } catch {
      return false;
    }
  }

  private async startThread(): Promise<void> {
    if (!this.client) throw new Error("Codex app-server is not running");
    const sandbox = process.env.HOMERAIL_CODEX_MANAGER_SANDBOX || "danger-full-access";
    const dynamicTools = this.options.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.input_schema,
    }));
    const started = await this.client.request(
      "thread/start",
      _buildCodexThreadStartParamsForTest({
        systemPrompt: this.options.systemPrompt,
        cwd: this.options.cwd,
        model: this.options.model,
        provider: this.options.provider,
        serviceTier: this.options.serviceTier,
        sandbox,
        dynamicTools,
        reasoningEffort: this.options.reasoningEffort,
        ephemeral: false,
      }),
    );
    this.threadId = resultThreadId(started) ?? null;
    if (!this.threadId) throw new Error("Codex app-server did not return a thread id");
    try {
      await this.client.request("thread/name/set", {
        threadId: this.threadId,
        name: liveThreadName(this.options.sessionId, this.options.tools),
      });
    } catch {
      // In-memory session remains usable if naming is unavailable.
    }
  }

  private async handleMessage(message: CodexAppServerMessage): Promise<void> {
    const method = message.method;
    const params = message.params;
    if (!method) return;
    if (message.id !== undefined) {
      if (method === "item/tool/call") {
        await this.handleToolCall(message.id, params ?? {});
      } else {
        this.client?.respondError(message.id, -32601, `Unsupported app-server request: ${method}`);
      }
      return;
    }

    switch (method) {
      case "thread/realtime/started":
        this.options.onEvent({
          type: "session.started",
          thread_id: String(params?.threadId ?? this.threadId ?? ""),
          realtime_session_id: typeof params?.realtimeSessionId === "string"
            ? params.realtimeSessionId
            : undefined,
          version: String(params?.version ?? "v3"),
        });
        break;
      case "thread/realtime/sdp": {
        const sdp = typeof params?.sdp === "string" ? params.sdp : "";
        if (!sdp) break;
        if (this.answerSdp) {
          clearTimeout(this.answerSdp.timer);
          this.answerSdp.resolve(sdp);
          this.answerSdp = undefined;
        }
        this.options.onEvent({ type: "session.sdp", sdp });
        break;
      }
      case "thread/realtime/transcript/delta":
        this.options.onEvent({
          type: "transcript.delta",
          role: String(params?.role ?? ""),
          delta: String(params?.delta ?? ""),
        });
        break;
      case "thread/realtime/transcript/done":
        this.options.onEvent({
          type: "transcript.done",
          role: String(params?.role ?? ""),
          text: String(params?.text ?? ""),
        });
        break;
      case "thread/realtime/itemAdded": {
        const item = params?.item;
        const type = item && typeof item === "object" && !Array.isArray(item)
          ? String((item as Record<string, unknown>).type ?? "")
          : "";
        if (type.includes("handoff") || type.includes("delegation")) {
          if (
            this.options.isToolSchemaCurrent
            && !(await this.options.isToolSchemaCurrent())
          ) {
            this.options.onEvent({
              type: "session.error",
              message: "HomeRail Manager tools or permissions changed. Reconnect Live Voice to continue.",
            });
            await this.stop();
            break;
          }
          this.options.onEvent({ type: "handoff" });
        }
        break;
      }
      case "turn/started": {
        const turn = turnRecord(params);
        this.options.onEvent({
          type: "manager.turn.started",
          turn_id: typeof turn.id === "string" ? turn.id : undefined,
        });
        break;
      }
      case "item/agentMessage/delta": {
        const itemId = String(params?.itemId ?? "");
        const delta = String(params?.delta ?? "");
        if (itemId && delta) {
          const parts = this.agentMessageDeltas.get(itemId) ?? [];
          parts.push(delta);
          this.agentMessageDeltas.set(itemId, parts);
        }
        break;
      }
      case "item/completed": {
        const root = itemRoot(params);
        if (root.type === "agentMessage") {
          const itemId = String(root.id ?? "");
          const text = typeof root.text === "string"
            ? root.text
            : (this.agentMessageDeltas.get(itemId) ?? []).join("");
          this.agentMessageDeltas.delete(itemId);
          if (root.phase === "commentary" && text.trim()) {
            this.options.onEvent({ type: "manager.progress", text: text.trim() });
          }
        }
        break;
      }
      case "turn/completed": {
        const turn = turnRecord(params);
        this.options.onEvent({
          type: "manager.turn.completed",
          status: typeof turn.status === "string" ? turn.status : undefined,
        });
        break;
      }
      case "thread/realtime/error":
      case "error":
      case "homerail/appserver/error": {
        const errorMessage = messageText(params);
        if (this.answerSdp) {
          clearTimeout(this.answerSdp.timer);
          this.answerSdp.reject(new Error(errorMessage));
          this.answerSdp = undefined;
        }
        this.options.onEvent({ type: "session.error", message: errorMessage });
        break;
      }
      case "thread/realtime/closed": {
        const reason = typeof params?.reason === "string" ? params.reason : undefined;
        if (this.answerSdp) {
          clearTimeout(this.answerSdp.timer);
          this.answerSdp.reject(new Error(
            reason
              ? `Codex Live Voice closed before SDP negotiation completed: ${reason}`
              : "Codex Live Voice closed before SDP negotiation completed",
          ));
          this.answerSdp = undefined;
        }
        this.options.onEvent({
          type: "session.closed",
          reason,
        });
        break;
      }
    }
  }

  private async handleToolCall(
    requestId: number | string,
    params: Record<string, unknown>,
  ): Promise<void> {
    const name = String(params.tool ?? "");
    const callId = String(params.callId ?? "");
    const args = params.arguments && typeof params.arguments === "object"
      && !Array.isArray(params.arguments)
      ? params.arguments as Record<string, unknown>
      : {};
    const tool = this.options.tools.find((candidate) => candidate.name === name);
    if (!tool) {
      this.client?.respond(requestId, {
        contentItems: [{ type: "inputText", text: `Unknown HomeRail tool: ${name}` }],
        success: false,
      });
      return;
    }
    this.options.onEvent({ type: "manager.tool", name, status: "started" });
    try {
      const result = await tool.handler(args, { tool_call_id: callId });
      const text = result.content.map((item) => item.text ?? "").join("\n");
      const success = result.is_error !== true;
      this.client?.respond(requestId, {
        contentItems: [{ type: "inputText", text }],
        success,
      });
      await this.options.onToolStateChanged?.();
      this.options.onEvent({
        type: "manager.tool",
        name,
        status: success ? "completed" : "failed",
      });
    } catch (error) {
      this.client?.respond(requestId, {
        contentItems: [{
          type: "inputText",
          text: error instanceof Error ? error.message : String(error),
        }],
        success: false,
      });
      this.options.onEvent({ type: "manager.tool", name, status: "failed" });
    }
  }
}
