/**
 * DeepSeek Harness adapter — drives a forked DSH JSON-RPC runtime in a child
 * process and exposes HomeRail DAG tools through a turn-local MCP bridge.
 */

import { randomUUID } from "node:crypto";
import {
  chmodSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DeepSeekHarness,
  type HarnessNotification,
} from "@deepseek-ai/dsh-sdk-client";
import { sanitizedAgentChildEnv } from "./child-env.js";
import type {
  AgentClient,
  AgentEvent,
  AgentRunContext,
  AgentUsage,
  DagToolDefinition,
} from "./types.js";
import type { AgentTurnDriverBindingResult } from "./turn-controller.js";
import { createDeepSeekHarnessReadTools } from "./deepseek-harness-read-tools.js";
import { WORKER_RUNTIME_VERSION } from "../runtime-version.js";

const DEFAULT_DSH_RUNTIME_COMMAND = "dsh-jsonrpc-agent-pkg";
const DEFAULT_DSH_MAX_TOKENS = 32_768;
const DEFAULT_DSH_CONTEXT_WINDOW = 200_000;
const DSH_FORK_COMMIT = "dc04fa3dbdcedc512322fff199b5cfef9169ea21";
const MCP_TOOL_PREFIX = "mcp__homerail__";
const DEFAULT_SYSTEM_PROMPT = "You are a HomeRail DAG worker. Complete the assigned task and call the provided handoff tool exactly once.";

interface DeepSeekHarnessAdapterOptions {
  runtimeCommand?: string;
  runtimeArgs?: string[];
  cordisConfigPath?: string;
  maxTokens?: number;
}

interface ToolBridge {
  scriptPath: string;
  url: string;
  token: string;
  close(): Promise<void>;
}

interface QueueWaiter<T> {
  resolve(value: IteratorResult<T>): void;
  reject(error: unknown): void;
}

class AsyncQueue<T> implements AsyncIterable<T> {
  private readonly items: T[] = [];
  private readonly waiters: QueueWaiter<T>[] = [];
  private ended = false;
  private failure: unknown;

  push(item: T): void {
    if (this.ended) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter.resolve({ done: false, value: item });
    else this.items.push(item);
  }

  end(): void {
    if (this.ended) return;
    this.ended = true;
    for (const waiter of this.waiters.splice(0)) waiter.resolve({ done: true, value: undefined });
  }

  fail(error: unknown): void {
    if (this.ended) return;
    this.failure = error;
    this.ended = true;
    for (const waiter of this.waiters.splice(0)) waiter.reject(error);
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        const item = this.items.shift();
        if (item !== undefined) return Promise.resolve({ done: false, value: item });
        if (this.failure !== undefined) return Promise.reject(this.failure);
        if (this.ended) return Promise.resolve({ done: true, value: undefined });
        return new Promise<IteratorResult<T>>((resolveNext, rejectNext) => {
          this.waiters.push({ resolve: resolveNext, reject: rejectNext });
        });
      },
    };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function parseRuntimeArgs(value: string | undefined): string[] {
  if (!value?.trim()) return [];
  const parsed: unknown = JSON.parse(value);
  if (!Array.isArray(parsed) || !parsed.every((entry) => typeof entry === "string")) {
    throw new Error("HOMERAIL_DSH_RUNTIME_ARGS must be a JSON array of strings");
  }
  return parsed;
}

function parseMaxTokens(value: number | string | undefined): number {
  if (value === undefined || value === "") return DEFAULT_DSH_MAX_TOKENS;
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error("HOMERAIL_DSH_MAX_TOKENS must be a positive integer");
  }
  return parsed;
}

function dshReasoningEffort(
  value: string | undefined,
  effortMap: Record<string, string | null> | false | undefined,
): string | undefined {
  const effort = value?.trim() || undefined;
  if (!effort) return undefined;
  if (effortMap === undefined || effortMap === false
    || !Object.prototype.hasOwnProperty.call(effortMap, effort)) {
    throw new Error(`DeepSeek Harness model does not declare reasoning effort '${effort}'`);
  }
  return effort;
}

function dshProviderProfile(
  context: AgentRunContext,
  maxTokens: number,
): { provider: string; reasoningEffort?: string; providersJson: string } {
  const provider = context.provider?.trim();
  if (!provider) throw new Error("DeepSeek Harness requires the selected model provider");
  if (context.protocol !== "openai_compatible") {
    throw new Error(`DeepSeek Harness pi-ai route requires openai_compatible, got ${context.protocol ?? "unknown"}`);
  }
  const reasoningEffort = dshReasoningEffort(context.reasoningEffort, context.reasoningEffortMap);
  const model = {
    id: context.model,
    contextWindow: DEFAULT_DSH_CONTEXT_WINDOW,
    maxTokens,
    ...(context.reasoningEffortMap === undefined
      ? {}
      : { reasoningEfforts: context.reasoningEffortMap }),
  };
  return {
    provider,
    reasoningEffort,
    providersJson: JSON.stringify({
      [provider]: {
        displayName: provider,
        apiKeyEnv: "HOMERAIL_DSH_API_KEY",
        api: "openai-completions",
        baseURL: normalizeBaseUrl(context.baseUrl),
        streamIdleTimeoutMs: 172_800_000,
        models: [model],
        ...(reasoningEffort ? { reasoning: reasoningEffort } : {}),
      },
    }),
  };
}

function defaultCordisConfigPath(): string {
  return fileURLToPath(new URL("../../dsh/homerail.cordis.yml", import.meta.url));
}

function normalizeBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/, "").replace(/\/chat\/completions$/i, "");
}

function redactSecret(value: string, secret: string): string {
  return secret ? value.split(secret).join("***") : value;
}

function projectedSystemPrompt(context: AgentRunContext): string {
  const skills = context.skillProjection?.definitions?.map((skill) => [
    `HomeRail Skill: ${skill.name ?? skill.id}`,
    skill.description?.trim() ?? "",
    skill.content.trim(),
  ].filter(Boolean).join("\n")) ?? [];
  return [context.systemPrompt?.trim() || DEFAULT_SYSTEM_PROMPT, ...skills]
    .filter(Boolean)
    .join("\n\n");
}

function safeToolName(name: string): string {
  return name.startsWith(MCP_TOOL_PREFIX) ? name.slice(MCP_TOOL_PREFIX.length) : name;
}

function parseToolArguments(value: unknown): Record<string, unknown> {
  if (typeof value !== "string") return {};
  try {
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function contentText(value: unknown): string {
  if (!Array.isArray(value)) return "";
  return value.map((block) => {
    if (!isRecord(block)) return "";
    if ((block.type === "text" || block.type === "reasoning") && typeof block.text === "string") {
      return block.text;
    }
    return `[${String(block.type ?? "content")}]`;
  }).filter(Boolean).join("\n");
}

function addUsage(total: AgentUsage, value: unknown): AgentUsage {
  if (!isRecord(value)) return { ...total };
  return {
    input_tokens: (total.input_tokens ?? 0) + numberOrZero(value.inputTokens),
    output_tokens: (total.output_tokens ?? 0) + numberOrZero(value.outputTokens),
    cache_read_input_tokens: (total.cache_read_input_tokens ?? 0) + numberOrZero(value.cacheReadTokens),
    cache_creation_input_tokens: (total.cache_creation_input_tokens ?? 0) + numberOrZero(value.cacheWriteTokens),
  };
}

function numberOrZero(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function finishReason(value: unknown): string | null {
  return isRecord(value) && typeof value.kind === "string" ? value.kind : null;
}

function turnEndError(value: unknown): AgentEvent | null {
  if (!isRecord(value) || value.kind !== "error") return null;
  const failure = isRecord(value.error) ? value.error : undefined;
  const code = typeof failure?.code === "string" ? failure.code : "UNKNOWN";
  const message = typeof failure?.message === "string" ? failure.message : "Unknown DSH turn failure";
  const status = typeof failure?.status === "number" ? ` (HTTP ${failure.status})` : "";
  return {
    type: "error",
    message: `DeepSeek Harness turn failed [${code}]${status}: ${message}`,
  };
}

function notificationEvents(
  notification: HarnessNotification,
  aggregateUsage: AgentUsage,
): { events: AgentEvent[]; usage: AgentUsage; finish: string | null } {
  if (notification.method !== "session.event") {
    return { events: [], usage: aggregateUsage, finish: null };
  }
  const event = notification.params.event;
  if (!isRecord(event) || typeof event.type !== "string" || !isRecord(event.data)) {
    return { events: [], usage: aggregateUsage, finish: null };
  }
  switch (event.type) {
    case "assistant/chunk": {
      const chunk = event.data.chunk;
      if (!isRecord(chunk)) return { events: [], usage: aggregateUsage, finish: null };
      if (chunk.type === "text-delta" && typeof chunk.text === "string") {
        return { events: [{ type: "text", text: chunk.text }], usage: aggregateUsage, finish: null };
      }
      if (chunk.type === "reasoning-delta" && typeof chunk.text === "string") {
        return { events: [{ type: "thinking", text: chunk.text }], usage: aggregateUsage, finish: null };
      }
      return {
        events: [],
        usage: aggregateUsage,
        finish: chunk.type === "finish" ? finishReason(chunk.reason) : null,
      };
    }
    case "assistant/message": {
      const usage = addUsage(aggregateUsage, event.data.usage);
      return {
        events: event.data.usage === undefined ? [] : [{ type: "usage", usage }],
        usage,
        finish: null,
      };
    }
    case "tool/call": {
      const callId = typeof event.data.callId === "string" ? event.data.callId : randomUUID();
      const name = typeof event.data.name === "string" ? safeToolName(event.data.name) : "unknown";
      return {
        events: [{ type: "tool_use", id: callId, name, input: parseToolArguments(event.data.arguments) }],
        usage: aggregateUsage,
        finish: null,
      };
    }
    case "tool/result": {
      const message = event.data.message;
      const source = isRecord(message) ? message.source : undefined;
      const blocks = isRecord(message) ? message.content : undefined;
      const resultBlock = Array.isArray(blocks) && isRecord(blocks[0]) ? blocks[0] : undefined;
      const callId = isRecord(source) && typeof source.callId === "string"
        ? source.callId
        : typeof resultBlock?.toolCallId === "string" ? resultBlock.toolCallId : randomUUID();
      return {
        events: [{
          type: "tool_result",
          tool_use_id: callId,
          content: contentText(resultBlock?.content),
          is_error: resultBlock?.isError === true || event.data.error !== undefined,
        }],
        usage: aggregateUsage,
        finish: null,
      };
    }
    case "turn/end": {
      const error = turnEndError(event.data.reason);
      return {
        events: [...(error ? [error] : []), { type: "turn_complete" }],
        usage: aggregateUsage,
        finish: typeof event.data.reason === "string"
          ? event.data.reason
          : finishReason(event.data.reason),
      };
    }
    default:
      return { events: [], usage: aggregateUsage, finish: null };
  }
}

function validateReceipt(value: unknown, field: "messageId" | "accepted"): void {
  if (!isRecord(value)) throw new Error(`DSH ${field} receipt was not an object`);
  if (field === "messageId" && typeof value.messageId !== "string") {
    throw new Error("DSH session/steer returned no messageId");
  }
  if (field === "accepted" && typeof value.accepted !== "boolean") {
    throw new Error("DSH session/cancel returned no accepted flag");
  }
}

function isPromptReceipt(
  notification: HarnessNotification,
  sessionId: string,
  messageId: string,
): boolean {
  if (notification.method !== "session.event" || notification.params.sessionId !== sessionId) return false;
  const event = notification.params.event;
  if (!isRecord(event) || event.type !== "agent/inbox/spliced" || !isRecord(event.data)) return false;
  return Array.isArray(event.data.inserted) && event.data.inserted.some((message) => (
    isRecord(message) && message.id === messageId
  ));
}

function isIdleStatus(notification: HarnessNotification, sessionId: string): boolean {
  return notification.method === "session.status" &&
    notification.params.sessionId === sessionId &&
    notification.params.status === "idle";
}

export class DeepSeekHarnessAdapter implements AgentClient {
  private readonly runtimeCommand: string;
  private readonly runtimeArgs: string[];
  private readonly cordisConfigPath: string;
  private readonly maxTokens: number;

  constructor(options: DeepSeekHarnessAdapterOptions = {}) {
    this.runtimeCommand = options.runtimeCommand
      ?? process.env.HOMERAIL_DSH_RUNTIME_COMMAND?.trim()
      ?? DEFAULT_DSH_RUNTIME_COMMAND;
    this.runtimeArgs = options.runtimeArgs
      ?? parseRuntimeArgs(process.env.HOMERAIL_DSH_RUNTIME_ARGS);
    this.cordisConfigPath = resolve(
      options.cordisConfigPath
        ?? process.env.HOMERAIL_DSH_CORDIS_CONFIG?.trim()
        ?? defaultCordisConfigPath(),
    );
    this.maxTokens = parseMaxTokens(
      options.maxTokens ?? process.env.HOMERAIL_DSH_MAX_TOKENS?.trim(),
    );
  }

  async *run(
    prompt: string,
    tools: DagToolDefinition[],
    context: AgentRunContext,
  ): AsyncIterable<AgentEvent> {
    const startedAt = Date.now();
    const runtimeRoot = mkdtempSync(join(tmpdir(), "homerail-dsh-"));
    const sessionId = context.sessionId?.trim() || `homerail-${randomUUID()}`;
    let bridge: ToolBridge | null = null;
    let harness: DeepSeekHarness | null = null;
    let abortHandler: (() => void) | null = null;
    let controllerBinding: AgentTurnDriverBindingResult | null = null;
    let aggregateUsage: AgentUsage = {};
    let latestFinishReason: string | null = null;
    const queue = new AsyncQueue<AgentEvent>();

    try {
      const providerProfile = dshProviderProfile(context, this.maxTokens);
      const maxBuiltinToolCalls = context.maxBuiltinToolCalls;
      const builtinTools = context.handoffOnly || !context.allowedBuiltinTools?.length
        ? []
        : createDeepSeekHarnessReadTools({
            workspace: context.workspace ?? process.cwd(),
            workspaceAccess: context.workspaceAccess!,
            allowedTools: context.allowedBuiltinTools,
            maxCalls: maxBuiltinToolCalls,
          });
      const names = new Set<string>();
      const bridgeTools = [...builtinTools, ...tools].filter((tool) => {
        if (names.has(tool.name)) {
          throw new Error(`DeepSeek Harness tool name collision: ${tool.name}`);
        }
        names.add(tool.name);
        return true;
      });
      bridge = await createToolBridge(bridgeTools, runtimeRoot);
      const childEnv = {
        ...sanitizedAgentChildEnv({
          ...process.env,
          ...context.environmentVariables,
        }),
        DSH_CORDIS_CONFIG: this.cordisConfigPath,
        DSH_CWD: context.workspace ?? process.cwd(),
        DSH_SESSION_ROOT: join(runtimeRoot, "sessions"),
        DSH_SYSTEM_PROMPT: projectedSystemPrompt(context),
        HOMERAIL_DSH_API_KEY: context.apiKey,
        HOMERAIL_DSH_PROVIDERS_JSON: providerProfile.providersJson,
        HOMERAIL_DSH_MCP_SCRIPT: bridge.scriptPath,
        HOMERAIL_MCP_BRIDGE_URL: bridge.url,
        HOMERAIL_MCP_BRIDGE_TOKEN: bridge.token,
      };
      harness = new DeepSeekHarness({
        launch: {
          command: this.runtimeCommand,
          args: this.runtimeArgs,
          cwd: context.workspace ?? process.cwd(),
          env: childEnv,
        },
        cwd: context.workspace,
        provider: providerProfile.provider,
        model: context.model,
        maxTokens: this.maxTokens,
      });

      yield {
        type: "debug",
        source: "deepseek-harness",
        message: "runtime_prepared",
        data: {
          fork_commit: DSH_FORK_COMMIT,
          runtime_command: this.runtimeCommand,
          runtime_args_count: this.runtimeArgs.length,
          session_id: sessionId,
          tool_count: bridgeTools.length,
          builtin_tools: builtinTools.map((tool) => tool.name),
          max_builtin_tool_calls: builtinTools.length > 0 ? maxBuiltinToolCalls ?? null : null,
          max_tokens: this.maxTokens,
          reasoning_effort: providerProfile.reasoningEffort ?? null,
          reasoning_efforts: context.reasoningEffortMap !== undefined && context.reasoningEffortMap !== false
            ? Object.keys(context.reasoningEffortMap)
            : [],
          workspace: context.workspace ?? process.cwd(),
          process_isolation: true,
          resume_supported: false,
        },
      };

      await harness.start();
      const bindController = (): void => {
        if (!context.turnController || controllerBinding) return;
        controllerBinding = context.turnController.bindDriver({
          steer: async (command) => {
            const receipt = await harness!.client.request("session/steer", {
              sessionId,
              contentBlocks: [{ type: "text", text: command.content }],
            });
            validateReceipt(receipt, "messageId");
          },
          interrupt: async () => {
            const receipt = await harness!.client.request("session/cancel", { sessionId });
            validateReceipt(receipt, "accepted");
            if ((receipt as { accepted: boolean }).accepted !== true) await harness!.close();
          },
          close: () => harness!.close(),
        });
      };

      abortHandler = (): void => {
        const closeAfterAbort = async (): Promise<void> => {
          await harness!.close().catch(() => undefined);
        };
        void harness!.client.request("session/cancel", { sessionId }).then(async (receipt) => {
          if (!isRecord(receipt) || receipt.accepted !== true) await closeAfterAbort();
        }, closeAfterAbort);
      };
      if (context.abortSignal?.aborted) abortHandler();
      else context.abortSignal?.addEventListener("abort", abortHandler, { once: true });

      const runTask = (async (): Promise<void> => {
        const subscription = harness!.client.subscribeSessionTree(sessionId);
        try {
          const messageId = await harness!.client.prompt(sessionId, [{ type: "text", text: prompt }]);
          bindController();
          let receivedPrompt = false;
          while (true) {
            const notification = await subscription.next();
            if (!receivedPrompt) {
              if (!isPromptReceipt(notification, sessionId, messageId)) continue;
              receivedPrompt = true;
            }
            const mapped = notificationEvents(notification, aggregateUsage);
            aggregateUsage = mapped.usage;
            if (mapped.finish !== null) latestFinishReason = mapped.finish;
            for (const event of mapped.events) queue.push(event);
            if (isIdleStatus(notification, sessionId)) break;
          }
        } finally {
          subscription.close();
        }
      })().then(() => queue.end(), (error: unknown) => queue.fail(error));

      for await (const event of queue) yield event;
      await runTask;
      yield {
        type: "done",
        usage: aggregateUsage,
        duration_ms: Date.now() - startedAt,
        finish_reason: latestFinishReason,
      };
    } catch (error) {
      const message = redactSecret(error instanceof Error ? error.message : String(error), context.apiKey);
      yield { type: "error", message: `DeepSeek Harness failed: ${message}` };
      yield { type: "done", usage: aggregateUsage, duration_ms: Date.now() - startedAt };
    } finally {
      if (context.abortSignal && abortHandler) {
        context.abortSignal.removeEventListener("abort", abortHandler);
      }
      await harness?.close().catch(() => undefined);
      await bridge?.close().catch(() => undefined);
      rmSync(runtimeRoot, { recursive: true, force: true });
    }
  }
}

async function createToolBridge(tools: DagToolDefinition[], root: string): Promise<ToolBridge> {
  const token = randomUUID();
  const toolMap = new Map(tools.map((tool) => [tool.name, tool]));
  const server = createServer((request, response) => {
    void handleToolRequest(request, response, token, toolMap);
  });
  const address = await listenOnLoopback(server);
  const scriptPath = join(root, "homerail-tools-mcp-server.mjs");
  writeFileSync(scriptPath, buildMcpProxyScript(tools), { encoding: "utf8", mode: 0o700 });
  try {
    chmodSync(scriptPath, 0o700);
  } catch {
    // Windows and restrictive filesystems may not expose POSIX modes.
  }
  return {
    scriptPath,
    url: `http://127.0.0.1:${address.port}`,
    token,
    close: () => closeHttpServer(server),
  };
}

async function handleToolRequest(
  request: IncomingMessage,
  response: ServerResponse,
  token: string,
  tools: Map<string, DagToolDefinition>,
): Promise<void> {
  if (request.method !== "POST" || request.url !== "/tool") {
    writeJson(response, 404, { error: "not_found" });
    return;
  }
  if (request.headers.authorization !== `Bearer ${token}`) {
    writeJson(response, 403, { error: "forbidden" });
    return;
  }
  try {
    const body = await readJson(request);
    const name = typeof body.name === "string" ? body.name : "";
    const tool = tools.get(name);
    if (!tool) {
      writeJson(response, 404, { content: `Unknown tool: ${name}`, is_error: true });
      return;
    }
    const args = isRecord(body.args) ? body.args : {};
    const result = await tool.handler(
      args,
      typeof body.tool_call_id === "string" ? { tool_call_id: body.tool_call_id } : undefined,
    );
    writeJson(response, 200, {
      content: result.content.map((block) => block.text).join(""),
      is_error: result.is_error === true,
    });
  } catch (error) {
    writeJson(response, 500, {
      content: error instanceof Error ? error.message : String(error),
      is_error: true,
    });
  }
}

function buildMcpProxyScript(tools: DagToolDefinition[]): string {
  const descriptors = tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.input_schema,
  }));
  return `#!/usr/bin/env node
import { createInterface } from "node:readline";

const TOOLS = ${JSON.stringify(descriptors)};
const BRIDGE_URL = process.env.HOMERAIL_MCP_BRIDGE_URL;
const BRIDGE_TOKEN = process.env.HOMERAIL_MCP_BRIDGE_TOKEN;
const lines = createInterface({ input: process.stdin });
const write = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
const result = (id, value) => write({ jsonrpc: "2.0", id, result: value });
const failure = (id, code, message) => write({ jsonrpc: "2.0", id, error: { code, message } });

lines.on("line", async (line) => {
  if (!line.trim()) return;
  let request;
  try { request = JSON.parse(line); }
  catch { failure(null, -32700, "Parse error"); return; }
  const id = request.id;
  try {
    if (request.method === "initialize") {
      result(id, {
        protocolVersion: request.params?.protocolVersion || "2024-11-05",
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "homerail-tools", version: ${JSON.stringify(WORKER_RUNTIME_VERSION)} }
      });
    } else if (request.method === "notifications/initialized") {
      return;
    } else if (request.method === "ping") {
      result(id, {});
    } else if (request.method === "tools/list") {
      result(id, { tools: TOOLS });
    } else if (request.method === "tools/call") {
      const toolResponse = await fetch(BRIDGE_URL + "/tool", {
        method: "POST",
        headers: { authorization: "Bearer " + BRIDGE_TOKEN, "content-type": "application/json" },
        body: JSON.stringify({
          name: String(request.params?.name || ""),
          args: request.params?.arguments ?? {},
          tool_call_id: String(id)
        })
      });
      const body = await toolResponse.json().catch(() => ({}));
      result(id, {
        content: [{ type: "text", text: String(body.content ?? body.error ?? "") }],
        isError: !toolResponse.ok || body.is_error === true
      });
    } else {
      failure(id, -32601, "Method not found: " + request.method);
    }
  } catch (error) {
    failure(id, -32000, error instanceof Error ? error.message : String(error));
  }
});
`;
}

function listenOnLoopback(server: Server): Promise<AddressInfo> {
  return new Promise((resolveAddress, rejectAddress) => {
    const onError = (error: Error): void => rejectAddress(error);
    server.once("error", onError);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", onError);
      const address = server.address();
      if (!address || typeof address === "string") rejectAddress(new Error("DSH MCP bridge did not bind"));
      else resolveAddress(address);
    });
  });
}

function closeHttpServer(server: Server): Promise<void> {
  return new Promise((resolveClose) => server.close(() => resolveClose()));
}

function readJson(request: IncomingMessage, maxBytes = 1_000_000): Promise<Record<string, unknown>> {
  return new Promise((resolveBody, rejectBody) => {
    const chunks: Buffer[] = [];
    let bodyBytes = 0;
    request.on("data", (chunk: Buffer) => {
      bodyBytes += chunk.length;
      if (bodyBytes > maxBytes) {
        request.destroy(new Error("request body too large"));
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      try {
        const body = Buffer.concat(chunks, bodyBytes).toString("utf8");
        const parsed: unknown = JSON.parse(body || "{}");
        if (!isRecord(parsed)) throw new Error("request body must be an object");
        resolveBody(parsed);
      } catch (error) {
        rejectBody(error);
      }
    });
    request.on("error", rejectBody);
  });
}

export const _readDeepSeekHarnessToolJsonForTest = readJson;

function writeJson(response: ServerResponse, status: number, body: Record<string, unknown>): void {
  response.statusCode = status;
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify(body));
}

export const _deepSeekHarnessForkCommitForTest = DSH_FORK_COMMIT;
