/**
 * Codex App-Server adapter — spawns `codex app-server` as a child process
 * communicating over stdio (JSON-RPC 2.0).
 *
 * Mirrors the Codex AppServer client contract used by HomeRail workers.
 * @version 0.1.0
 */

import { type ChildProcess, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createInterface, type Interface as ReadlineInterface } from "node:readline";
import type { AgentClient, AgentEvent, AgentRunContext, DagToolDefinition } from "./types.js";
import { sanitizedAgentChildEnv } from "./child-env.js";

const CLIENT_NAME = "homerail_codex_appserver";
const CLIENT_TITLE = "HomeRail Codex AppServer Adapter";
const DEFAULT_CODEX_BIN = "codex";
const RESPONSE_TIMEOUT_MS = 60_000;
const SECRET_KEYS = [
  "apiKey", "api_key", "OPENAI_API_KEY",
  "Authorization", "auth_token", "secret",
];

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params: Record<string, unknown>;
}

interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number;
  result?: Record<string, unknown>;
  error?: { code: number; message: string; data?: unknown };
}

interface PendingRequest {
  resolve: (result: Record<string, unknown>) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** Spawn a process with stdin/stdout/stderr piped. */
function spawnProcess(bin: string, args: string[], env: Record<string, string | undefined>): ChildProcess {
  return spawn(bin, args, {
    stdio: ["pipe", "pipe", "pipe"],
    env,
    shell: windowsCommandNeedsShell(bin),
    windowsHide: true,
  });
}

function windowsCommandNeedsShell(command: string, platform = process.platform): boolean {
  return platform === "win32" && /\.(cmd|bat)$/i.test(command);
}

function isPathLike(command: string): boolean {
  return path.isAbsolute(command) || command.includes("/") || command.includes("\\");
}

function executableCandidates(command: string, platform = process.platform): string[] {
  if (platform !== "win32" || /\.(exe|cmd|bat)$/i.test(command)) return [command];
  const parsed = path.win32.parse(command);
  return [".exe", ".cmd", ".bat"]
    .map((extension) => path.win32.join(parsed.dir, `${parsed.base}${extension}`))
    .concat(command);
}

function findExistingBinary(command: string): string | null {
  for (const candidate of executableCandidates(command)) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

export class CodexAppServerAdapter implements AgentClient {
  private process: ChildProcess | null = null;
  private rl: ReadlineInterface | null = null;
  private requestId = 0;
  private pending = new Map<number, PendingRequest>();
  private notifications: Array<Record<string, unknown>> = [];
  private notifyWaiters: Array<() => void> = [];
  private codexBin: string;
  private tempDir: string | null = null;

  constructor(codexBin?: string) {
    this.codexBin = codexBin ?? process.env.CODEX_BIN_PATH ?? DEFAULT_CODEX_BIN;
  }

  async *run(
    prompt: string,
    tools: DagToolDefinition[],
    context: AgentRunContext,
  ): AsyncIterable<AgentEvent> {
    const maxIterations = context.maxIterations ?? 10;

    // Build tool map for handler lookup
    const toolMap = new Map<string, DagToolDefinition>();
    for (const t of tools) toolMap.set(t.name, t);

    // Validate codex binary
    try {
      await this.validateBinary();
    } catch (err) {
      yield { type: "error", message: err instanceof Error ? err.message : String(err) };
      yield { type: "done" };
      return;
    }

    // Spawn app-server
    try {
      this.tempDir = this.createTempDir();
      const env = this.buildEnv(context);
      this.process = spawnProcess(this.codexBin, ["app-server"], env);
      this.setupReadline();
    } catch (err) {
      yield { type: "error", message: `Failed to start codex app-server: ${err}` };
      yield { type: "done" };
      return;
    }

    const abortHandler = context.abortSignal
      ? () => this.sendNotification("cancel", {})
      : null;
    if (abortHandler && context.abortSignal) {
      context.abortSignal.addEventListener("abort", abortHandler, { once: true });
    }

    let stderr = "";
    if (this.process.stderr) {
      this.process.stderr.on("data", (chunk: Buffer) => {
        stderr = `${stderr}${chunk.toString()}`.slice(-4000);
      });
    }

    this.process.on("error", (err) => {
      this.rejectAllPending(`Process error: ${err.message}`);
    });

    this.process.on("exit", (code) => {
      this.rejectAllPending(`Process exited with code ${code}`);
    });

    try {
      // Debug: start
      yield this.debugEvent("appserver_start", {
        codex_bin: this.codexBin,
        model: context.model,
        workspace: context.workspace ?? process.cwd(),
        tool_count: tools.length,
      });

      // Initialize
      const initResult = await this.sendRequest("initialize", {
        clientInfo: {
          name: CLIENT_NAME,
          title: CLIENT_TITLE,
          version: "0.1.0",
        },
        capabilities: {
          experimentalApi: true,
          optOutNotificationMethods: null,
        },
      });
      yield this.debugEvent("appserver_initialized", this.redactSecrets(initResult));

      const dynamicTools = this.buildDynamicToolSpecs(tools);
      const threadResult = await this.sendRequest("thread/start", {
        baseInstructions: context.systemPrompt ?? null,
        developerInstructions: null,
        cwd: context.workspace ?? process.cwd(),
        model: context.model,
        modelProvider: context.provider || null,
        approvalPolicy: "never",
        sandbox: "danger-full-access",
        ephemeral: true,
        dynamicTools,
      });
      const threadId =
        (threadResult.thread_id as string | undefined) ??
        ((threadResult.thread as Record<string, unknown> | undefined)?.id as string | undefined);
      if (!threadId) {
        throw new Error("thread/start response did not include a thread id");
      }
      yield this.debugEvent("thread_created", { thread_id: threadId });

      // Execute turns with iteration guard
      let iteration = 0;
      let turnComplete = false;

      while (iteration < maxIterations && !turnComplete && !context.abortSignal?.aborted) {
        iteration++;

        // Start turn
        const turnResult = await this.sendRequest("turn/start", {
          threadId,
          input: iteration === 1 ? [{ type: "text", text: prompt, text_elements: [] }] : [],
          cwd: context.workspace ?? process.cwd(),
          model: context.model,
        });
        const turnId =
          (turnResult.turn_id as string | undefined) ??
          ((turnResult.turn as Record<string, unknown> | undefined)?.id as string | undefined) ??
          "";
        yield this.debugEvent("turn_started", { turn_id: turnId, iteration });

        // Drain turn notifications
        turnComplete = false;
        while (!turnComplete) {
          let notification: Record<string, unknown>;
          try {
            notification = await this.waitForNotification(120_000);
          } catch {
            yield { type: "error", message: "Timeout waiting for codex app-server notification" };
            return;
          }

          const method = notification.method as string;
          const requestId = notification.id as number | undefined;
          const payload = notification.params as Record<string, unknown> | undefined;
          const events = this.mapNotification(method, payload);

          for (const event of events) {
            yield event;

            // Handle MCP tool calls by executing DAG tool handlers
            if (event.type === "tool_use" && toolMap.has(event.name)) {
              const def = toolMap.get(event.name)!;
              let content: string;
              let isError = false;
              try {
                const result = await def.handler(event.input, { tool_call_id: event.id });
                const blocks = result.content as Array<{ type: string; text?: string }> | undefined;
                content = blocks?.map((b) => b.text ?? "").join("") ?? JSON.stringify(result);
                isError = result.is_error === true;
              } catch (toolErr) {
                content = `Tool ${event.name} threw: ${toolErr}`;
                isError = true;
              }

              yield {
                type: "tool_result",
                tool_use_id: event.id,
                content,
                is_error: isError,
              };

              if (requestId !== undefined && method === "item/tool/call") {
                this.sendResponse(requestId, {
                  contentItems: [{ type: "inputText", text: content }],
                  success: !isError,
                });
              } else {
                this.sendNotification("tool_result", {
                  turn_id: turnId,
                  tool_use_id: event.id,
                  content: [{ type: "text", text: content }],
                  is_error: isError,
                });
              }
            }
          }

          if (method === "turn/completed") {
            turnComplete = true;
          }
          if (method === "error") {
            return;
          }
        }

        yield this.debugEvent("turn_completed", { turn_id: turnId, iteration });
      }

      if (iteration >= maxIterations) {
        yield { type: "error", message: `Exceeded max iterations (${maxIterations})` };
      }

      // Close thread
      try {
        await this.sendRequest("thread/unsubscribe", { threadId });
      } catch {
        // Best-effort cleanup
      }
    } catch (err) {
      yield {
        type: "error",
        message: `Codex app-server error: ${err instanceof Error ? err.message : String(err)}`,
      };
    } finally {
      if (abortHandler && context.abortSignal) {
        context.abortSignal.removeEventListener("abort", abortHandler);
      }
      yield this.debugEvent("appserver_done", { stderr_tail: stderr.slice(-2000) || null });
      this.shutdown();
    }

    yield { type: "done" };
  }

  async resume(sessionId: string): Promise<AgentRunContext | null> {
    throw new Error(
      `Codex app-server transcript resume is not implemented for session ${sessionId}; ` +
      "use DAG checkpoint resume so the resume instruction is injected into the next worker prompt.",
    );
  }

  // --- JSON-RPC transport ---

  private async sendRequest(
    method: string,
    params: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    if (!this.process?.stdin) {
      throw new Error("App-server process not running");
    }

    const id = ++this.requestId;
    const request: JsonRpcRequest = { jsonrpc: "2.0", id, method, params };
    const line = JSON.stringify(request);
    this.process.stdin.write(`${line}\n`);

    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`JSON-RPC request ${method} (id=${id}) timed out`));
      }, RESPONSE_TIMEOUT_MS);

      this.pending.set(id, { resolve, reject, timer });
    });
  }

  private sendNotification(method: string, params: Record<string, unknown>): void {
    if (!this.process?.stdin) return;
    const notification: JsonRpcNotification = { jsonrpc: "2.0", method, params };
    this.process.stdin.write(`${JSON.stringify(notification)}\n`);
  }

  private sendResponse(id: number, result: Record<string, unknown>): void {
    if (!this.process?.stdin) return;
    this.process.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
  }

  private setupReadline(): void {
    if (!this.process?.stdout) return;
    this.rl = createInterface({ input: this.process.stdout });
    this.rl.on("line", (line: string) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let parsed: JsonRpcResponse | JsonRpcNotification;
      try {
        parsed = JSON.parse(trimmed) as JsonRpcResponse | JsonRpcNotification;
      } catch {
        return;
      }
      if ("method" in parsed) {
        this.notifications.push(parsed as unknown as Record<string, unknown>);
        const waiters = this.notifyWaiters.splice(0);
        for (const w of waiters) w();
      } else if ("id" in parsed && typeof parsed.id === "number") {
        // It's a response
        const pending = this.pending.get(parsed.id);
        if (pending) {
          clearTimeout(pending.timer);
          this.pending.delete(parsed.id);
          if (parsed.error) {
            pending.reject(
              new Error(`JSON-RPC error ${parsed.error.code}: ${parsed.error.message}`),
            );
          } else {
            pending.resolve(parsed.result ?? {});
          }
        }
      }
    });
  }

  private waitForNotification(timeoutMs: number): Promise<Record<string, unknown>> {
    if (this.notifications.length > 0) {
      return Promise.resolve(this.notifications.shift()!);
    }
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = this.notifyWaiters.indexOf(waiter);
        if (idx >= 0) this.notifyWaiters.splice(idx, 1);
        reject(new Error("Notification wait timed out"));
      }, timeoutMs);

      const waiter = () => {
        clearTimeout(timer);
        if (this.notifications.length > 0) {
          resolve(this.notifications.shift()!);
        }
      };
      this.notifyWaiters.push(waiter);
    });
  }

  private rejectAllPending(reason: string): void {
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error(reason));
    }
    this.pending.clear();
  }

  private shutdown(): void {
    try {
      this.rl?.close();
    } catch {
      // ignore
    }
    this.rl = null;
    try {
      this.process?.stdin?.end();
      this.process?.kill("SIGTERM");
    } catch {
      // ignore
    }
    this.process = null;
    this.rejectAllPending("Adapter shutting down");
    this.cleanupTempDir();
  }

  // --- Event mapping (mirrors Python _translate_notification) ---

  private mapNotification(
    method: string,
    payload: Record<string, unknown> | undefined,
  ): AgentEvent[] {
    const events: AgentEvent[] = [];
    if (!payload) return events;

    switch (method) {
      case "item/agentMessage/delta": {
        const delta = payload.delta as string | undefined;
        if (delta) {
          events.push({ type: "text", text: delta });
        }
        break;
      }

      case "item/reasoning/textDelta":
      case "item/reasoning/summaryTextDelta": {
        const delta = (payload.delta as string) ?? (payload.text as string) ?? "";
        if (delta) {
          events.push({ type: "thinking", text: delta });
        }
        break;
      }

      case "item/started": {
        const item = (payload.item as Record<string, unknown>) ?? payload;
        const root = (item.root as Record<string, unknown>) ?? item;
        const itemType = root.type as string;
        if (itemType === "commandExecution") {
          events.push({
            type: "tool_use",
            id: (root.id as string) ?? "",
            name: "bash",
            input: { command: (root.command as string) ?? "" },
          });
        } else if (itemType === "mcpToolCall") {
          events.push({
            type: "tool_use",
            id: (root.id as string) ?? "",
            name: (root.tool as string) ?? "",
            input: (root.arguments as Record<string, unknown>) ?? {},
          });
        }
        break;
      }

      case "item/completed": {
        const item = (payload.item as Record<string, unknown>) ?? payload;
        const root = (item.root as Record<string, unknown>) ?? item;
        const itemType = root.type as string;
        if (itemType === "commandExecution") {
          const exitCode = (root.exitCode ?? root.exit_code) as number | null | undefined;
          events.push({
            type: "tool_result",
            tool_use_id: (root.id as string) ?? "",
            content: ((root.aggregatedOutput ?? root.aggregated_output) as string | null | undefined) ?? "",
            is_error: exitCode != null && exitCode !== 0,
          });
        } else if (itemType === "mcpToolCall") {
          const error = root.error as Record<string, unknown> | null | undefined;
          const result = root.result as Record<string, unknown> | null | undefined;
          let content = "";
          if (error) {
            content = (error.message as string) ?? String(error);
          } else if (result) {
            const contentBlocks = result.content as Array<{ text?: string }> | undefined;
            content = contentBlocks?.map((b) => b.text ?? "").join("\n") ?? "";
          }
          events.push({
            type: "tool_result",
            tool_use_id: (root.id as string) ?? "",
            content,
            is_error: Boolean(error),
          });
        }
        break;
      }

      case "item/tool/call": {
        events.push({
          type: "tool_use",
          id: (payload.callId as string) ?? "",
          name: (payload.tool as string) ?? "",
          input: (payload.arguments as Record<string, unknown>) ?? {},
        });
        break;
      }

      case "error": {
        events.push({
          type: "error",
          message: (payload.message as string) ?? "codex app-server error",
        });
        break;
      }

      case "turn/completed": {
        events.push({ type: "turn_complete" });
        break;
      }
    }

    return events;
  }

  // --- Helpers ---

  private debugEvent(message: string, data?: Record<string, unknown>): AgentEvent {
    return {
      type: "debug",
      source: "codex-appserver",
      message,
      data: this.redactSecrets(data ?? {}),
    };
  }

  private redactSecrets(obj: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      if (SECRET_KEYS.some((sk) => k.toLowerCase().includes(sk.toLowerCase()))) {
        out[k] = "[REDACTED]";
      } else if (typeof v === "string") {
        out[k] = this.redactString(v);
      } else {
        out[k] = v;
      }
    }
    return out;
  }

  private redactString(s: string): string {
    // Redact bearer tokens and long hex strings
    return s
      .replace(/Bearer\s+[A-Za-z0-9\-._~+/]+=*/gi, "Bearer [REDACTED]")
      .replace(/sk-[A-Za-z0-9]{20,}/g, "[REDACTED]");
  }

  private buildEnv(context: AgentRunContext): Record<string, string | undefined> {
    const env = sanitizedAgentChildEnv();

    const apiKey = context.apiKey || process.env.OPENAI_API_KEY || process.env.LLM_API_KEY || "";
    if (apiKey) {
      env.OPENAI_API_KEY = apiKey;
    }

    if (context.baseUrl) {
      env.OPENAI_BASE_URL = context.baseUrl;
    }

    if (this.tempDir) {
      const codexHome = path.join(this.tempDir, ".codex");
      env.CODEX_HOME = codexHome;
      env.HOME = this.tempDir;
    }

    return env;
  }

  private createTempDir(): string {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex_appserver_"));
    const codexHome = path.join(tmpDir, ".codex");
    fs.mkdirSync(codexHome, { recursive: true });
    return tmpDir;
  }

  private cleanupTempDir(): void {
    if (!this.tempDir) return;
    try {
      fs.rmSync(this.tempDir, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup
    }
    this.tempDir = null;
  }

  private async validateBinary(): Promise<void> {
    if (isPathLike(this.codexBin)) {
      const found = findExistingBinary(this.codexBin);
      if (!found) {
        throw new Error(`Codex binary not found at: ${this.codexBin}`);
      }
      this.codexBin = found;
      return;
    }

    // Check default codex path
    const localBinary = findExistingBinary(this.codexBin);
    if (localBinary) {
      this.codexBin = localBinary;
      return;
    }

    // Check common alternative locations
    const alternatives = [
      path.join(os.homedir(), ".codex", "bin", "codex"),
      "/usr/local/bin/codex",
      "/usr/bin/codex",
    ];
    for (const alt of alternatives) {
      const found = findExistingBinary(alt);
      if (found) {
        this.codexBin = found;
        return;
      }
    }

    const fromPath = findExecutableOnPath(DEFAULT_CODEX_BIN);
    if (fromPath) {
      this.codexBin = fromPath;
      return;
    }

    throw new Error(
      "Codex binary not found. Install codex or set CODEX_BIN_PATH environment variable.",
    );
  }

  private buildDynamicToolSpecs(tools: DagToolDefinition[]): Array<Record<string, unknown>> {
    return tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.input_schema,
    }));
  }
}

function findExecutableOnPath(command: string): string | null {
  const pathEnv = process.env.PATH ?? "";
  for (const dir of pathEnv.split(path.delimiter)) {
    if (!dir) continue;
    for (const name of executableCandidates(command)) {
      const candidate = path.join(dir, name);
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return null;
}

export const _codexWindowsCommandNeedsShellForTest = windowsCommandNeedsShell;
