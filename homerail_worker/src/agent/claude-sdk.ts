/**
 * Claude Agent SDK adapter — wraps @anthropic-ai/claude-agent-sdk.
 *
 * Uses `query()` for one-shot agent execution. DAG tools are registered
 * via an in-process MCP server created with `createSdkMcpServer`.
 * @version 0.1.0
 */

import { AGENT_BUILTIN_TOOL_NAMES } from "homerail-protocol";
import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { AgentClient, AgentEvent, AgentRunContext, AgentUsage, DagToolDefinition } from "./types.js";
import {
  jsonSchemaObjectToZodRawShape,
  normalizeJsonObjectStringsBySchema,
} from "./json-schema-zod.js";
import { sanitizedAgentChildEnv } from "./child-env.js";

const HANDOFF_ONLY_THINKING_BUDGET = 2048;
const HANDOFF_STOP = Symbol("claude-sdk-handoff-stop");

interface SdkModule {
  query(params: {
    prompt: string | AsyncIterable<SDKUserMessage>;
    options?: Record<string, unknown>;
  }): AsyncIterable<SdkMessage>;
  createSdkMcpServer(opts: {
    name: string;
    version?: string;
    tools?: Array<Record<string, unknown>>;
  }): Record<string, unknown>;
  tool(
    name: string,
    description: string,
    inputSchema: Record<string, unknown>,
    handler: (args: Record<string, unknown>, extra: unknown) => Promise<{
      content: Array<{ type: "text"; text: string }>;
      isError?: boolean;
    }>,
  ): Record<string, unknown>;
}

interface SdkMessage {
  type: string;
  message?: {
    content?: Array<{
      type: string;
      text?: string;
      thinking?: string;
      id?: string;
      name?: string;
      input?: Record<string, unknown>;
      tool_use_id?: string;
      content?: unknown;
      is_error?: boolean;
    }>;
    stop_reason?: string;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_read_input_tokens?: number;
      cache_creation_input_tokens?: number;
    };
  };
  event?: {
    type: string;
    content_block?: {
      type: string;
      text?: string;
      thinking?: string;
      id?: string;
      name?: string;
      input?: Record<string, unknown>;
    };
  };
  subtype?: string;
  result?: string;
  error?: string;
  errors?: string[];
  duration_ms?: number;
  num_turns?: number;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
  permission_denials?: unknown[];
  is_error?: boolean;
}

interface SdkInputEntry {
  message: SDKUserMessage;
  resolveApplied?: () => void;
  rejectApplied?: (error: Error) => void;
}

function sdkUserMessage(content: string): SDKUserMessage {
  return {
    type: "user",
    message: { role: "user", content },
    parent_tool_use_id: null,
  };
}

export class ClaudeSdkUserMessageQueue implements AsyncIterable<SDKUserMessage> {
  private readonly entries: SdkInputEntry[] = [];
  private readonly waiters: Array<(result: IteratorResult<SDKUserMessage>) => void> = [];
  private closed = false;
  private closeError = new Error("Claude SDK input queue is closed");

  constructor(initialPrompt: string) {
    this.entries.push({ message: sdkUserMessage(initialPrompt) });
  }

  enqueue(content: string): Promise<void> {
    if (this.closed) return Promise.reject(this.closeError);
    return new Promise<void>((resolve, reject) => {
      const entry: SdkInputEntry = {
        message: sdkUserMessage(content),
        resolveApplied: resolve,
        rejectApplied: reject,
      };
      const waiter = this.waiters.shift();
      if (waiter) this.deliver(waiter, entry);
      else this.entries.push(entry);
    });
  }

  close(error?: Error): void {
    if (this.closed) return;
    this.closed = true;
    if (error) this.closeError = error;
    for (const entry of this.entries.splice(0)) entry.rejectApplied?.(this.closeError);
    for (const waiter of this.waiters.splice(0)) waiter({ value: undefined, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return {
      next: () => this.next(),
      return: async () => {
        this.close();
        return { value: undefined, done: true };
      },
    };
  }

  private next(): Promise<IteratorResult<SDKUserMessage>> {
    const entry = this.entries.shift();
    if (entry) {
      entry.resolveApplied?.();
      return Promise.resolve({ value: entry.message, done: false });
    }
    if (this.closed) return Promise.resolve({ value: undefined, done: true });
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  private deliver(
    waiter: (result: IteratorResult<SDKUserMessage>) => void,
    entry: SdkInputEntry,
  ): void {
    entry.resolveApplied?.();
    waiter({ value: entry.message, done: false });
  }
}

function sdkToolCallId(extra: unknown): string | undefined {
  if (!extra || typeof extra !== "object" || Array.isArray(extra)) return undefined;
  const record = extra as Record<string, unknown>;
  for (const value of [
    record.toolUseId,
    record.tool_use_id,
    record.requestId,
    record.request_id,
  ]) {
    if (typeof value === "string" && value.trim()) return value;
  }
  return undefined;
}

interface SdkTransportGuard {
  promise: Promise<Error>;
  cleanup: () => void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}

function sdkToolResultContent(block: { text?: string; content?: unknown }): string {
  if (typeof block.content === "string") return block.content;
  if (block.content !== undefined) return JSON.stringify(block.content);
  return block.text ?? "";
}

function isClaudeSdkTransportError(err: unknown): err is Error {
  if (!(err instanceof Error)) return false;
  const code = isRecord(err) && typeof err.code === "string" ? err.code : "";
  if (!["EPIPE", "ECONNRESET", "ERR_STREAM_DESTROYED"].includes(code)) return false;
  const stack = err.stack ?? "";
  return stack.includes("@anthropic-ai/claude-agent-sdk")
    || stack.includes("ProcessTransport.write")
    || stack.includes("Query.handleControlRequest");
}

function createSdkTransportGuard(abortController: AbortController | null): SdkTransportGuard {
  let captured = false;
  let settle: (err: Error) => void = () => {};
  const promise = new Promise<Error>((resolve) => {
    settle = resolve;
  });
  const cleanup = (): void => {
    process.off("uncaughtException", onUncaughtException);
  };
  const onUncaughtException = (err: Error): void => {
    if (!isClaudeSdkTransportError(err)) {
      cleanup();
      setImmediate(() => { throw err; });
      return;
    }
    if (captured) return;
    captured = true;
    abortController?.abort();
    settle(err);
  };
  process.on("uncaughtException", onUncaughtException);
  return { promise, cleanup };
}

export class ClaudeSdkAdapter implements AgentClient {
  private readonly model: string;
  private readonly thinkingBudget: number;
  private readonly maxTurns: number | null;
  private readonly maxTurnsSource: "unset" | "env";
  private readonly queryTimeoutMs: number;

  constructor() {
    this.model = process.env.CLAUDE_MODEL ?? "claude-sonnet-4-20250514";
    this.thinkingBudget = Number(process.env.CLAUDE_THINKING_BUDGET ?? 16000);
    const configuredMaxTurns = Number(process.env.CLAUDE_MAX_TURNS ?? 0);
    this.maxTurns = Number.isFinite(configuredMaxTurns) && configuredMaxTurns > 0
      ? Math.floor(configuredMaxTurns)
      : null;
    this.maxTurnsSource = this.maxTurns === null ? "unset" : "env";
    this.queryTimeoutMs = Number(process.env.CLAUDE_SDK_QUERY_TIMEOUT_MS ?? 0);
  }

  async *run(
    prompt: string,
    tools: DagToolDefinition[],
    context: AgentRunContext,
  ): AsyncIterable<AgentEvent> {
    if (context.protocol && context.protocol !== "anthropic_compatible") {
      yield {
        type: "error",
        message: `Claude SDK requires an Anthropic-compatible endpoint; received protocol ${context.protocol}. Configure an Anthropic base URL or use the Kimi Code harness for Kimi.`,
      };
      yield { type: "done" };
      return;
    }

    const inputQueue = new ClaudeSdkUserMessageQueue(prompt);
    let sdkAbortController: AbortController | null = null;
    let controllerStopped = false;
    const controllerBinding = context.turnController?.bindDriver({
      steer: (command) => inputQueue.enqueue(command.content),
      interrupt: (reason) => {
        controllerStopped = true;
        inputQueue.close(new Error(`Claude SDK turn interrupted: ${reason}`));
        sdkAbortController?.abort();
      },
      close: () => {
        controllerStopped = true;
        inputQueue.close();
        sdkAbortController?.abort();
      },
    });
    if (controllerBinding?.status === "rejected") {
      inputQueue.close(new Error(controllerBinding.reason ?? "Claude SDK turn controller binding failed"));
      yield {
        type: "error",
        message: `Claude SDK turn controller binding failed: ${controllerBinding.reason ?? "unknown error"}`,
      };
      yield { type: "done" };
      return;
    }

    const sdk = await this.loadSdk().catch((err) => {
      return { error: err instanceof Error ? err.message : String(err) };
    });

    if ("error" in sdk) {
      inputQueue.close(new Error(`Claude Agent SDK not available: ${sdk.error}`));
      yield {
        type: "error",
        message: `Claude Agent SDK not available: ${sdk.error}. Install @anthropic-ai/claude-agent-sdk.`,
      };
      yield { type: "done" };
      return;
    }

    let timeout: NodeJS.Timeout | null = null;
    let stderrTail = "";
    let externalAbortHandler: (() => void) | null = null;
    let handoffStopRequested = false;
    let resolveHandoffStop: (() => void) | null = null;
    const handoffStop = new Promise<typeof HANDOFF_STOP>((resolve) => {
      resolveHandoffStop = () => resolve(HANDOFF_STOP);
    });
    const appendStderr = (chunk: string): void => {
      stderrTail = `${stderrTail}${chunk}`.slice(-4000);
    };
    // Declared outside try so the final `done` yield (after finally) can
    // read them even when the query loop never ran (e.g. early SDK error).
    const accumulatedUsage: AgentUsage = {};
    let finalDurationMs: number | undefined;
    let finalNumTurns: number | undefined;
    try {
      const effectiveModel = context.model || this.model;
      const authEnv = this.buildClaudeEnv(context, effectiveModel);
      const requestedBuiltinTools = context.allowedBuiltinTools ?? AGENT_BUILTIN_TOOL_NAMES;
      const supportedBuiltinTools = new Set<string>(AGENT_BUILTIN_TOOL_NAMES);
      const builtinTools = context.handoffOnly
        ? []
        : requestedBuiltinTools.filter((tool) => supportedBuiltinTools.has(tool));
      const effectiveThinkingBudget = context.handoffOnly
        ? Math.min(this.thinkingBudget, HANDOFF_ONLY_THINKING_BUDGET)
        : this.thinkingBudget;
      const systemPromptMode = context.systemPromptMode ?? "append";
      const options: Record<string, unknown> = {
        model: effectiveModel,
        maxThinkingTokens: effectiveThinkingBudget,
        tools: builtinTools,
        allowedTools: builtinTools,
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        cwd: context.workspace ?? process.cwd(),
        stderr: (data: string) => appendStderr(data),
        env: authEnv.env,
        settingSources: [],
        strictMcpConfig: true,
      };
      if (this.maxTurns !== null) {
        options.maxTurns = this.maxTurns;
      }
      const abortController = new AbortController();
      sdkAbortController = abortController;
      options.abortController = abortController;
      if (controllerStopped) abortController.abort();
      if (context.abortSignal) {
        externalAbortHandler = () => {
          inputQueue.close(new Error("Claude SDK turn aborted"));
          abortController.abort();
        };
        if (context.abortSignal.aborted) {
          externalAbortHandler();
        } else {
          context.abortSignal.addEventListener("abort", externalAbortHandler, { once: true });
        }
      }

      if (context.systemPrompt) {
        options.systemPrompt = systemPromptMode === "replace"
          ? context.systemPrompt
          : {
              type: "preset",
              preset: "claude_code",
              append: context.systemPrompt,
            };
      }

      // Register DAG tools as an in-process MCP server
      if (tools.length > 0 && sdk.createSdkMcpServer && sdk.tool) {
        const sdkTools = tools.map((t) =>
          sdk.tool(t.name, t.description, jsonSchemaObjectToZodRawShape(t.input_schema), async (args, extra) => {
            const toolCallId = sdkToolCallId(extra);
            const normalizedArgs = normalizeJsonObjectStringsBySchema(args, t.input_schema);
            const res = await t.handler(
              normalizedArgs as Record<string, unknown>,
              toolCallId ? { tool_call_id: toolCallId } : undefined,
            );
            if (t.name === "handoff" && res.is_error !== true) {
              handoffStopRequested = true;
              inputQueue.close();
              // Return the MCP result before closing a provider stream that may
              // otherwise wait forever after a successful terminal handoff.
              setImmediate(() => resolveHandoffStop?.());
            }
            return {
              content: [{ type: "text" as const, text: res.content.map((c) => c.text).join("") }],
              isError: res.is_error,
            };
          }),
        );
        const mcpServer = sdk.createSdkMcpServer({ name: "dag-tools", version: "0.1.0", tools: sdkTools });
        options.mcpServers = { "dag-tools": mcpServer };
        yield {
          type: "debug",
          source: "claude-sdk",
          message: "mcp_server_registered",
          data: { server: "dag-tools", tool_names: tools.map((tool) => tool.name) },
        };
      } else {
        yield {
          type: "debug",
          source: "claude-sdk",
          message: "mcp_server_not_registered",
          data: { tool_count: tools.length },
        };
      }

      yield {
        type: "debug",
        source: "claude-sdk",
        message: "query_start",
        data: {
          model: effectiveModel,
          max_turns: this.maxTurns,
          max_turns_source: this.maxTurnsSource,
          thinking_budget: effectiveThinkingBudget,
          cwd: options.cwd,
          has_system_prompt: Boolean(context.systemPrompt),
          system_prompt_mode: systemPromptMode,
          tool_count: tools.length,
          auth_env: authEnv.authEnv,
          auth_source: authEnv.authSource,
          base_url_env: authEnv.baseUrlEnv,
          base_url_source: authEnv.baseUrlSource,
          timeout_ms: this.queryTimeoutMs > 0 ? this.queryTimeoutMs : null,
          external_abort_signal: Boolean(context.abortSignal),
          builtin_tools: builtinTools,
          handoff_only: context.handoffOnly === true,
        },
      };

      if (this.queryTimeoutMs > 0) {
        timeout = setTimeout(() => {
          inputQueue.close(new Error(`Claude SDK query timed out after ${this.queryTimeoutMs}ms`));
          abortController.abort();
        }, this.queryTimeoutMs);
      }

      const query = sdk.query({ prompt: inputQueue, options });
      const transportGuard = createSdkTransportGuard(abortController);
      let messageCount = 0;
      try {
        const iterator = query[Symbol.asyncIterator]();
        while (true) {
          const next = await Promise.race([
            iterator.next(),
            handoffStop,
            transportGuard.promise.then((err) => {
              throw err;
            }),
          ]);
          if (next === HANDOFF_STOP) {
            inputQueue.close();
            abortController.abort();
            yield {
              type: "debug",
              source: "claude-sdk",
              message: "query_stopped_after_handoff",
              data: {
                stderr_tail: stderrTail.trim().slice(-2000) || null,
              },
            };
            break;
          }
          if (next.done) {
            inputQueue.close();
            break;
          }
          const msg = next.value;
          if (msg.type === "result") inputQueue.close();
        messageCount += 1;
        const stderrChunk = stderrTail.trim();
        if (stderrChunk) {
          yield {
            type: "debug",
            source: "claude-sdk",
            message: "claude_code_stderr",
            data: { sequence: messageCount, tail: stderrChunk.slice(-2000) },
          };
          stderrTail = "";
        }
        // Extract usage from this message. Per-message usage on assistant
        // turns is additive (each turn's input/output); the result message
        // carries an aggregate we prefer when present.
        const msgUsage = msg.message?.usage ?? msg.usage;
        let usageChanged = false;
        if (msgUsage) {
          usageChanged = true;
          if (msg.type === "result") {
            // Result message carries the authoritative aggregate — replace.
            accumulatedUsage.input_tokens = msgUsage.input_tokens ?? accumulatedUsage.input_tokens;
            accumulatedUsage.output_tokens = msgUsage.output_tokens ?? accumulatedUsage.output_tokens;
            accumulatedUsage.cache_read_input_tokens = msgUsage.cache_read_input_tokens ?? accumulatedUsage.cache_read_input_tokens;
            accumulatedUsage.cache_creation_input_tokens = msgUsage.cache_creation_input_tokens ?? accumulatedUsage.cache_creation_input_tokens;
            finalDurationMs = msg.duration_ms;
            finalNumTurns = msg.num_turns;
          } else {
            // Per-turn delta — accumulate.
            accumulatedUsage.input_tokens = (accumulatedUsage.input_tokens ?? 0) + (msgUsage.input_tokens ?? 0);
            accumulatedUsage.output_tokens = (accumulatedUsage.output_tokens ?? 0) + (msgUsage.output_tokens ?? 0);
            accumulatedUsage.cache_read_input_tokens = (accumulatedUsage.cache_read_input_tokens ?? 0) + (msgUsage.cache_read_input_tokens ?? 0);
            accumulatedUsage.cache_creation_input_tokens = (accumulatedUsage.cache_creation_input_tokens ?? 0) + (msgUsage.cache_creation_input_tokens ?? 0);
          }
        }
        // Emit a usage event inline (carrying the running total) so the
        // prompt-runner has up-to-date totals even when the agent yields
        // early via handoff and the outer loop breaks before we reach the
        // post-loop aggregate emission below.
        if (usageChanged) {
          yield { type: "usage", usage: { ...accumulatedUsage } };
        }
        yield this.debugMessageEvent(msg, messageCount);
          const events = this.mapSdkMessage(msg);
          for (const event of events) yield event;
        }
      } finally {
        transportGuard.cleanup();
      }
      // Emit a usage event so the prompt-runner can forward totals even
      // when the run ends without a handoff (e.g. error path).
      const hasUsage = accumulatedUsage.input_tokens !== undefined
        || accumulatedUsage.output_tokens !== undefined
        || accumulatedUsage.cache_read_input_tokens !== undefined
        || accumulatedUsage.cache_creation_input_tokens !== undefined;
      if (hasUsage) {
        yield { type: "usage", usage: accumulatedUsage };
      }
      yield {
        type: "debug",
        source: "claude-sdk",
        message: "query_done",
        data: {
          message_count: messageCount,
          stderr_tail: stderrTail.trim().slice(-2000) || null,
          usage: hasUsage ? accumulatedUsage : null,
          duration_ms: finalDurationMs ?? null,
          num_turns: finalNumTurns ?? null,
        },
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      inputQueue.close(err instanceof Error ? err : new Error(msg));
      if (handoffStopRequested) {
        yield {
          type: "debug",
          source: "claude-sdk",
          message: "query_stopped_after_handoff",
          data: {
            stderr_tail: stderrTail.trim().slice(-2000) || null,
          },
        };
      } else {
        yield {
          type: "debug",
          source: "claude-sdk",
          message: "query_error",
          data: {
            error: msg,
            stderr_tail: stderrTail.trim().slice(-2000) || null,
            timeout_configured_ms: this.queryTimeoutMs > 0 ? this.queryTimeoutMs : null,
          },
        };
        if (isClaudeSdkTransportError(err)) {
          yield { type: "error", message: `Claude SDK transport error: ${msg}` };
        } else if (msg.includes("429") || msg.includes("rate")) {
          yield { type: "error", message: `Rate limited: ${msg}` };
        } else if (msg.includes("401") || msg.includes("403")) {
          yield { type: "error", message: `Auth failure: ${msg}` };
        } else {
          yield { type: "error", message: `Claude SDK error: ${msg}` };
        }
      }
    } finally {
      inputQueue.close();
      if (timeout) clearTimeout(timeout);
      if (context.abortSignal && externalAbortHandler) {
        context.abortSignal.removeEventListener("abort", externalAbortHandler);
      }
      sdkAbortController = null;
    }

    yield {
      type: "done",
      usage: (accumulatedUsage.input_tokens !== undefined
        || accumulatedUsage.output_tokens !== undefined
        || accumulatedUsage.cache_read_input_tokens !== undefined
        || accumulatedUsage.cache_creation_input_tokens !== undefined)
        ? accumulatedUsage
        : undefined,
      duration_ms: finalDurationMs,
      num_turns: finalNumTurns,
    };
  }

  private debugMessageEvent(msg: SdkMessage, sequence: number): AgentEvent {
    const blocks = msg.message?.content ?? [];
    // Diagnostic: surface the raw usage location so we can confirm where
    // the SDK exposes token usage on each message type.
    const rawMsgUsage = (msg as { message?: { usage?: unknown } }).message?.usage;
    const rawTopUsage = (msg as { usage?: unknown }).usage;
    return {
      type: "debug",
      source: "claude-sdk",
      message: "sdk_message",
      data: {
        sequence,
        type: msg.type,
        subtype: msg.subtype ?? null,
        event_type: msg.event?.type ?? null,
        stop_reason: msg.message?.stop_reason ?? null,
        content_block_types: blocks.map((block) => block.type),
        tool_names: blocks
          .filter((block) => block.type === "tool_use" && block.name)
          .map((block) => block.name as string),
        result_preview: typeof msg.result === "string" ? msg.result.slice(0, 500) : null,
        error: msg.error ?? null,
        errors: msg.errors ?? [],
        duration_ms: msg.duration_ms ?? null,
        num_turns: msg.num_turns ?? null,
        permission_denial_count: msg.permission_denials?.length ?? 0,
        is_error: msg.is_error ?? false,
        raw_message_usage: rawMsgUsage ?? null,
        raw_top_usage: rawTopUsage ?? null,
      },
    };
  }

  private buildClaudeEnv(context: AgentRunContext, effectiveModel: string): {
    env: Record<string, string | undefined>;
    authEnv: boolean;
    authSource: string;
    baseUrlEnv: boolean;
    baseUrlSource: string;
  } {
    const fromContext = context.apiKey.trim();
    const fromAnthropicEnv = process.env.ANTHROPIC_API_KEY ?? "";
    const fromLlmEnv = process.env.LLM_API_KEY ?? "";
    const apiKey = fromContext || fromAnthropicEnv || fromLlmEnv;
    const fromContextBaseUrl = context.baseUrl.trim();
    const fromAnthropicBaseUrl = process.env.ANTHROPIC_BASE_URL ?? "";
    const fromLlmBaseUrl = process.env.LLM_BASE_URL ?? "";
    const baseUrl = fromContextBaseUrl || fromAnthropicBaseUrl || fromLlmBaseUrl;
    const env = sanitizedAgentChildEnv();
    Object.assign(env, context.environmentVariables ?? {});
    if (apiKey) env.ANTHROPIC_API_KEY = apiKey;
    if (baseUrl) {
      env.ANTHROPIC_BASE_URL = baseUrl;
      env.LLM_BASE_URL = baseUrl;
    }
    // Pin Claude Code's internal/background model selection to the effective
    // model. HomeRail only targets gateway providers (e.g. qwen3.6) — Claude
    // Code's defaults (claude-haiku-*) are not valid model ids on those
    // gateways and would 404. ANTHROPIC_SMALL_FAST_MODEL is read by SDK
    // 0.1.77 and falls back to ANTHROPIC_DEFAULT_HAIKU_MODEL; set both so a
    // future SDK bump cannot reintroduce the haiku default. The telemetry /
    // nonessential-traffic flags suppress /api/event_logging/batch and similar
    // requests that don't exist on the gateway.
    env.ANTHROPIC_MODEL = effectiveModel;
    env.ANTHROPIC_DEFAULT_HAIKU_MODEL = effectiveModel;
    env.ANTHROPIC_SMALL_FAST_MODEL = effectiveModel;
    env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1";
    env.DISABLE_TELEMETRY = "1";
    env.DISABLE_ERROR_REPORTING = "1";
    return {
      env,
      authEnv: Boolean(apiKey),
      authSource: fromContext
        ? "context.apiKey"
        : fromAnthropicEnv
          ? "ANTHROPIC_API_KEY"
          : fromLlmEnv
            ? "LLM_API_KEY"
            : "missing",
      baseUrlEnv: Boolean(baseUrl),
      baseUrlSource: fromContextBaseUrl
        ? "context.baseUrl"
        : fromAnthropicBaseUrl
          ? "ANTHROPIC_BASE_URL"
          : fromLlmBaseUrl
            ? "LLM_BASE_URL"
            : "missing",
    };
  }

  private mapSdkMessage(msg: SdkMessage): AgentEvent[] {
    const events: AgentEvent[] = [];

    switch (msg.type) {
      case "assistant": {
        // Full assistant message with content blocks
        const blocks = msg.message?.content ?? [];
        for (const block of blocks) {
          if (block.type === "text" && block.text) {
            events.push({ type: "text", text: block.text });
          } else if (block.type === "thinking" && block.thinking) {
            events.push({ type: "thinking", text: block.thinking });
          } else if (block.type === "tool_use") {
            events.push({
              type: "tool_use",
              id: block.id ?? "",
              name: block.name ?? "",
              input: block.input ?? {},
            });
          } else if (block.type === "tool_result") {
            events.push({
              type: "tool_result",
              tool_use_id: block.tool_use_id ?? block.id ?? "",
              content: sdkToolResultContent(block),
              is_error: block.is_error,
            });
          }
        }
        break;
      }
      case "user": {
        for (const block of msg.message?.content ?? []) {
          if (block.type !== "tool_result") continue;
          events.push({
            type: "tool_result",
            tool_use_id: block.tool_use_id ?? block.id ?? "",
            content: sdkToolResultContent(block),
            is_error: block.is_error,
          });
        }
        break;
      }
      case "stream_event": {
        // Partial/streaming event
        const cb = msg.event?.content_block;
        if (cb) {
          if (cb.type === "text" && cb.text) {
            events.push({ type: "text", text: cb.text });
          } else if (cb.type === "thinking" && cb.thinking) {
            events.push({ type: "thinking", text: cb.thinking });
          }
        }
        if (msg.event?.type === "content_block_stop") {
          events.push({ type: "turn_complete" });
        }
        break;
      }
      case "result": {
        const resultError = msg.error || msg.errors?.join("; ") || "";
        const failedSubtype = msg.subtype && msg.subtype !== "success" ? msg.subtype : "";
        if (msg.is_error || resultError || failedSubtype) {
          const detail = resultError || failedSubtype || "unknown result error";
          events.push({ type: "error", message: `Claude SDK result failed: ${detail}` });
        }
        break;
      }
    }

    return events;
  }

  private async loadSdk(): Promise<SdkModule> {
    try {
      const mod = await import("@anthropic-ai/claude-agent-sdk");
      return mod as unknown as SdkModule;
    } catch {
      throw new Error(
        "@anthropic-ai/claude-agent-sdk is not installed. " +
        "Run: npm install @anthropic-ai/claude-agent-sdk",
      );
    }
  }

  async resume(sessionId: string): Promise<AgentRunContext | null> {
    throw new Error(
      `Claude SDK transcript resume is not implemented for session ${sessionId}; ` +
      "use DAG checkpoint resume so the resume instruction is injected into the next worker prompt.",
    );
  }
}
