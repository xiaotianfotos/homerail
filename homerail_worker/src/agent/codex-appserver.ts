/**
 * Codex App-Server adapter — spawns `codex app-server` as a child process
 * communicating over stdio (JSON-RPC 2.0).
 *
 * Mirrors the Codex AppServer client contract used by HomeRail workers.
 * @version 0.1.0
 */

import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import { createServer, request as httpRequest, type Server } from "node:http";
import { request as httpsRequest } from "node:https";
import type { AddressInfo } from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { createInterface, type Interface as ReadlineInterface } from "node:readline";
import {
  CODEX_RESPONSES_PROTOCOL,
  HOMERAIL_CODEX_MODEL_PROVIDER_ID,
  buildCodexProviderModelCatalogFromBundled,
  codexResponsesAppServerArgs,
  codexResponsesProviderEnvironment,
  normalizeCodexResponsesBaseUrl,
  resolveCodexResponsesProviderProfile,
} from "homerail-protocol";
import type { AgentClient, AgentEvent, AgentRunContext, DagToolDefinition } from "./types.js";
import { sanitizedAgentChildEnv } from "./child-env.js";
import { WORKER_RUNTIME_VERSION } from "../runtime-version.js";

const CLIENT_NAME = "homerail_codex_appserver";
const CLIENT_TITLE = "HomeRail Codex AppServer Adapter";
const DEFAULT_CODEX_BIN = "codex";
const RESPONSE_TIMEOUT_MS = 60_000;
const NOTIFICATION_HEARTBEAT_INTERVAL_MS = 30_000;
const BUNDLED_CODEX_CATALOG_CACHE = new Map<string, string>();
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

interface NotificationWaiter {
  resolve: (notification: Record<string, unknown>) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

class NotificationWaitTimeoutError extends Error {}

type CodexAssistantMessagePhase = "commentary" | "final_answer";

interface CodexAssistantMessageState {
  phase?: CodexAssistantMessagePhase;
  deltas: string[];
}

interface CodexProviderRelay {
  apiKey: string;
  baseUrl: string;
  server: Server;
}

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

function relayHeaders(
  headers: Readonly<Record<string, string | string[] | undefined>>,
): Record<string, string | string[]> {
  const safe: Record<string, string | string[]> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined || HOP_BY_HOP_HEADERS.has(name.toLowerCase())) continue;
    safe[name] = value;
  }
  return safe;
}

async function startCodexProviderRelay(baseUrl: string, providerApiKey: string): Promise<CodexProviderRelay> {
  const upstream = new URL(normalizeCodexResponsesBaseUrl(baseUrl));
  if (!providerApiKey.trim() || !["http:", "https:"].includes(upstream.protocol)) {
    throw new Error("Codex provider relay configuration is invalid");
  }
  if (upstream.username || upstream.password || upstream.search || upstream.hash) {
    throw new Error("Codex provider relay base URL must not contain credentials, query, or fragment");
  }
  const basePath = upstream.pathname.replace(/\/+$/, "");
  const responsesPath = `${basePath}/responses`.replace(/^\/{2,}/, "/");
  const relayApiKey = `homerail-dispatch-${randomBytes(32).toString("hex")}`;
  const server = createServer((request, response) => {
    const reject = (status: number, message: string) => {
      response.writeHead(status, { "content-type": "text/plain; charset=utf-8" });
      response.end(message);
    };
    const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
    if (request.method !== "POST" || requestUrl.pathname !== responsesPath) {
      reject(404, "Not found");
      return;
    }
    if (request.headers.authorization !== `Bearer ${relayApiKey}`) {
      reject(403, "Forbidden");
      return;
    }
    const target = new URL(`${requestUrl.pathname}${requestUrl.search}`, upstream.origin);
    const headers = relayHeaders(request.headers);
    headers.host = target.host;
    headers.authorization = `Bearer ${providerApiKey}`;
    const send = target.protocol === "https:" ? httpsRequest : httpRequest;
    const upstreamRequest = send(target, { method: "POST", headers }, (upstreamResponse) => {
      response.writeHead(upstreamResponse.statusCode ?? 502, relayHeaders(upstreamResponse.headers));
      upstreamResponse.pipe(response);
    });
    upstreamRequest.on("error", () => {
      if (!response.headersSent) reject(502, "Provider relay failed");
      else response.destroy();
    });
    request.on("aborted", () => upstreamRequest.destroy());
    request.pipe(upstreamRequest);
  });
  server.on("clientError", (_error, socket) => socket.destroy());
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(0, "127.0.0.1");
  });
  const address = server.address() as AddressInfo | null;
  if (!address) {
    server.close();
    throw new Error("Codex provider relay did not bind a local address");
  }
  return {
    apiKey: relayApiKey,
    baseUrl: `http://127.0.0.1:${address.port}${basePath}`,
    server,
  };
}

export const _startCodexProviderRelayForTest = startCodexProviderRelay;

function isInsideWorkspace(workspace: string, candidate: string): boolean {
  const relative = path.relative(workspace, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/**
 * Codex's Linux sandbox protects `<cwd>/.git` before running shell tools. A
 * DAG workspace can be a container for one or more declared project roots,
 * so using the container root as cwd fails when that root is mounted read-only
 * and the actual checkout lives below it. Prefer a declared Git worktree while
 * keeping the broader workspace as the policy/audit boundary.
 */
function resolveCodexWorkingDirectory(context: AgentRunContext): string {
  const workspace = path.resolve(context.workspace ?? process.cwd());
  if (fs.existsSync(path.join(workspace, ".git"))) return workspace;

  const access = context.workspaceAccess;
  const declaredRoots = [
    ...(access?.writable_paths ?? []),
    ...(access?.readonly_paths ?? []),
  ];
  for (const declaredRoot of declaredRoots) {
    const candidate = path.resolve(workspace, declaredRoot);
    if (!isInsideWorkspace(workspace, candidate)) continue;
    if (fs.existsSync(path.join(candidate, ".git"))) return candidate;
  }
  return workspace;
}

function resolveCodexSandboxMode(
  context: AgentRunContext,
): "read-only" | "workspace-write" | "danger-full-access" {
  const writable = !context.workspaceAccess || context.workspaceAccess.writable_paths.length > 0;
  if (context.codexSandbox === "danger-full-access" && !writable) {
    throw new Error("danger-full-access Codex sandbox requires a writable DAG workspace");
  }
  return context.codexSandbox ?? (writable ? "workspace-write" : "read-only");
}

function projectedSkillName(value: string, fallback: string): string {
  const normalized = value
    .normalize("NFKC")
    .replace(/[^A-Za-z0-9_.-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return normalized || fallback;
}

function projectedSkillInstructions(content: string): string {
  const normalized = content.replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n")) return normalized.trim();
  const end = normalized.indexOf("\n---\n", 4);
  return end < 0 ? normalized.trim() : normalized.slice(end + 5).trim();
}

function prepareCodexSkillProjection(context: AgentRunContext, tempDir: string): { roots: string[]; skillCount: number } {
  const projection = context.skillProjection;
  if (!projection) return { roots: [], skillCount: 0 };
  const skillsRoot = path.join(tempDir, "projected-skills");
  fs.mkdirSync(skillsRoot, { recursive: true });
  const names = new Set<string>();

  for (const directory of projection.directories ?? []) {
    const root = path.resolve(directory);
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      const source = path.join(root, entry.name);
      try {
        if (!fs.statSync(path.join(source, "SKILL.md")).isFile()) continue;
      } catch {
        continue;
      }
      const name = projectedSkillName(entry.name, `skill-${names.size + 1}`);
      if (names.has(name)) continue;
      const destination = path.join(skillsRoot, name);
      try {
        fs.symlinkSync(source, destination, process.platform === "win32" ? "junction" : "dir");
      } catch {
        fs.cpSync(source, destination, { recursive: true, force: false, errorOnExist: true });
      }
      names.add(name);
    }
  }

  for (const definition of projection.definitions ?? []) {
    const baseName = projectedSkillName(definition.name || definition.id, `skill-${names.size + 1}`);
    let name = baseName;
    let suffix = 2;
    while (names.has(name)) name = `${baseName.slice(0, 61)}-${suffix++}`;
    const skillDir = path.join(skillsRoot, name);
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, "SKILL.md"), [
      "---",
      `name: ${JSON.stringify(name)}`,
      `description: ${JSON.stringify((definition.description || `HomeRail Skill ${definition.id}`).slice(0, 1024))}`,
      "---",
      "",
      projectedSkillInstructions(definition.content),
      "",
    ].join("\n"), { encoding: "utf8", mode: 0o600 });
    names.add(name);
  }
  return { roots: [skillsRoot], skillCount: names.size };
}

export const _prepareCodexSkillProjectionForTest = prepareCodexSkillProjection;

function guardedSpawnCommand(
  bin: string,
  args: string[],
  env: Readonly<Record<string, string | undefined>>,
  configuredGuard = process.env.HOMERAIL_CODEX_PROC_GUARD,
  platform = process.platform,
): { bin: string; args: string[]; env: Record<string, string | undefined> } {
  const spawnEnv = { ...env };
  if (!env.HOMERAIL_CODEX_API_KEY || platform !== "linux") return { bin, args, env: spawnEnv };
  const guard = configuredGuard?.trim();
  if (!guard) throw new Error("Codex provider secret guard is required on Linux");
  const resolved = findExistingBinary(guard, platform);
  if (!resolved) throw new Error(`Configured Codex secret guard not found: ${guard}`);
  spawnEnv.LD_PRELOAD = resolved;
  return { bin, args, env: spawnEnv };
}

export const _guardedCodexSpawnCommandForTest = guardedSpawnCommand;

/** Spawn a process with stdin/stdout/stderr piped. */
function spawnProcess(bin: string, args: string[], env: Record<string, string | undefined>): ChildProcess {
  const command = guardedSpawnCommand(bin, args, env);
  return spawn(command.bin, command.args, {
    stdio: ["pipe", "pipe", "pipe"],
    env: command.env,
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

function findExistingBinary(command: string, platform = process.platform): string | null {
  for (const candidate of executableCandidates(command, platform)) {
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
  private notifyWaiters: NotificationWaiter[] = [];
  private notificationFailure: Error | null = null;
  private codexBin: string;
  private notificationHeartbeatIntervalMs: number;
  private providerRelay: CodexProviderRelay | null = null;
  private tempDir: string | null = null;
  private agentMessages = new Map<string, CodexAssistantMessageState>();

  constructor(
    codexBin?: string,
    notificationHeartbeatIntervalMs = NOTIFICATION_HEARTBEAT_INTERVAL_MS,
  ) {
    this.codexBin = codexBin ?? process.env.CODEX_BIN_PATH ?? DEFAULT_CODEX_BIN;
    if (!Number.isSafeInteger(notificationHeartbeatIntervalMs) || notificationHeartbeatIntervalMs < 1) {
      throw new Error("notificationHeartbeatIntervalMs must be a positive safe integer");
    }
    this.notificationHeartbeatIntervalMs = notificationHeartbeatIntervalMs;
  }

  async *run(
    prompt: string,
    tools: DagToolDefinition[],
    context: AgentRunContext,
  ): AsyncIterable<AgentEvent> {
    const maxIterations = context.maxIterations ?? 10;
    const workingDirectory = resolveCodexWorkingDirectory(context);
    const sandboxMode = resolveCodexSandboxMode(context);

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
    let modelCatalogPath: string | undefined;
    try {
      this.tempDir = this.createTempDir();
      this.providerRelay = context.protocol === CODEX_RESPONSES_PROTOCOL && context.apiKey
        ? await startCodexProviderRelay(context.baseUrl ?? "", context.apiKey)
        : null;
      modelCatalogPath = context.protocol === CODEX_RESPONSES_PROTOCOL
        ? this.materializeProviderModelCatalog(context)
        : undefined;
      const env = this.buildEnv(context, this.providerRelay?.apiKey);
      const args = context.protocol === CODEX_RESPONSES_PROTOCOL
        ? codexResponsesAppServerArgs({
            providerName: context.provider,
            baseUrl: this.providerRelay?.baseUrl ?? context.baseUrl,
            apiKey: this.providerRelay?.apiKey ?? context.apiKey,
            modelCatalogPath,
          })
        : ["app-server"];
      this.process = spawnProcess(this.codexBin, args, env);
      this.notifications = [];
      this.notificationFailure = null;
      this.setupReadline();
    } catch (err) {
      this.shutdown();
      yield { type: "error", message: `Failed to start codex app-server: ${err}` };
      yield { type: "done" };
      return;
    }

    let activeThreadId: string | undefined;
    let activeTurnId: string | undefined;
    const abortHandler = context.abortSignal
      ? () => {
          if (!activeThreadId || !activeTurnId) return;
          void this.sendRequest("turn/interrupt", {
            threadId: activeThreadId,
            turnId: activeTurnId,
          }).catch(() => {});
        }
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
      this.rejectNotificationWaiters(`Process error: ${err.message}`);
    });

    this.process.on("exit", (code) => {
      this.rejectAllPending(`Process exited with code ${code}`);
      this.rejectNotificationWaiters(`Process exited with code ${code}`);
    });

    try {
      // Debug: start
      yield this.debugEvent("appserver_start", {
        codex_bin: this.codexBin,
        model: context.model,
        workspace: context.workspace ?? process.cwd(),
        cwd: workingDirectory,
        sandbox_mode: sandboxMode,
        tool_count: tools.length,
        reasoning_effort: context.reasoningEffort ?? null,
        service_tier: context.serviceTier ?? null,
        provider_model_catalog: Boolean(modelCatalogPath),
      });

      // Initialize
      const initResult = await this.sendRequest("initialize", {
        clientInfo: {
          name: CLIENT_NAME,
          title: CLIENT_TITLE,
          version: WORKER_RUNTIME_VERSION,
        },
        capabilities: {
          experimentalApi: true,
          optOutNotificationMethods: null,
        },
      });
      yield this.debugEvent("appserver_initialized", this.redactSecrets(initResult));

      const cwd = workingDirectory;
      const skillProjection = prepareCodexSkillProjection(context, this.tempDir!);
      if (skillProjection.roots.length > 0) {
        await this.sendRequest("skills/extraRoots/set", { extraRoots: skillProjection.roots });
        const skillList = await this.sendRequest("skills/list", { cwds: [cwd], forceReload: true });
        const entries = Array.isArray(skillList.data) ? skillList.data as Array<Record<string, unknown>> : [];
        const discoveredSkillCount = entries.reduce((total, entry) => (
          total + (Array.isArray(entry.skills) ? entry.skills.length : 0)
        ), 0);
        yield this.debugEvent("native_skills_ready", {
          projected_skill_count: skillProjection.skillCount,
          discovered_skill_count: discoveredSkillCount,
        });
      }

      const dynamicTools = this.buildDynamicToolSpecs(tools);
      const threadResult = await this.sendRequest("thread/start", {
        // Preserve Codex's native harness instructions and supplement them
        // with the HomeRail DAG contract.
        baseInstructions: null,
        developerInstructions: context.systemPrompt ?? null,
        cwd,
        model: context.model,
        modelProvider: context.protocol === CODEX_RESPONSES_PROTOCOL
          ? HOMERAIL_CODEX_MODEL_PROVIDER_ID
          : context.provider || null,
        approvalPolicy: "never",
        sandbox: sandboxMode,
        ephemeral: true,
        dynamicTools,
        serviceTier: context.serviceTier ?? null,
        ...(context.reasoningEffort
          ? { config: { model_reasoning_effort: context.reasoningEffort } }
          : {}),
      });
      const threadId =
        (threadResult.thread_id as string | undefined) ??
        ((threadResult.thread as Record<string, unknown> | undefined)?.id as string | undefined);
      if (!threadId) {
        throw new Error("thread/start response did not include a thread id");
      }
      activeThreadId = threadId;
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
          cwd: workingDirectory,
          model: context.model,
          ...(context.reasoningEffort ? { effort: context.reasoningEffort } : {}),
          serviceTier: context.serviceTier ?? null,
        });
        const turnId =
          (turnResult.turn_id as string | undefined) ??
          ((turnResult.turn as Record<string, unknown> | undefined)?.id as string | undefined) ??
          "";
        activeTurnId = turnId || undefined;
        yield this.debugEvent("turn_started", { turn_id: turnId, iteration });

        // Drain turn notifications
        turnComplete = false;
        while (!turnComplete) {
          let notification: Record<string, unknown>;
          try {
            notification = await this.waitForNotification(this.notificationHeartbeatIntervalMs);
          } catch (err) {
            if (err instanceof NotificationWaitTimeoutError) {
              if (context.abortSignal?.aborted) {
                turnComplete = true;
                break;
              }
              // A silent model may still be reasoning or waiting on its
              // provider. Emit a content-free heartbeat so the worker keeps
              // its Manager lease without exposing chain-of-thought. Turn
              // lifetime remains controlled by cancellation/process exit.
              yield { type: "thinking", text: "" };
              continue;
            }
            yield {
              type: "error",
              message: err instanceof Error
                ? `Codex app-server notification stream failed: ${err.message}`
                : "Codex app-server notification stream failed",
            };
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
        activeTurnId = undefined;
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
        const notification = parsed as unknown as Record<string, unknown>;
        const waiter = this.notifyWaiters.shift();
        if (waiter) {
          clearTimeout(waiter.timer);
          waiter.resolve(notification);
        } else {
          this.notifications.push(notification);
        }
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
    if (this.notificationFailure) {
      return Promise.reject(this.notificationFailure);
    }
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = this.notifyWaiters.indexOf(waiter);
        if (idx >= 0) this.notifyWaiters.splice(idx, 1);
        reject(new NotificationWaitTimeoutError("Notification wait timed out"));
      }, timeoutMs);
      const waiter: NotificationWaiter = { resolve, reject, timer };
      this.notifyWaiters.push(waiter);
    });
  }

  private rejectNotificationWaiters(reason: string): void {
    const error = new Error(reason);
    this.notificationFailure = error;
    const waiters = this.notifyWaiters.splice(0);
    for (const waiter of waiters) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
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
    this.providerRelay?.server.close();
    this.providerRelay?.server.closeAllConnections();
    this.providerRelay = null;
    this.rejectAllPending("Adapter shutting down");
    this.rejectNotificationWaiters("Adapter shutting down");
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
        const itemId = typeof payload.itemId === "string" ? payload.itemId : "";
        if (delta) {
          const state = this.agentMessages.get(itemId) ?? { deltas: [] };
          state.deltas.push(delta);
          this.agentMessages.set(itemId, state);
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
        if (itemType === "agentMessage") {
          const itemId = typeof root.id === "string" ? root.id : "";
          const phase = root.phase === "commentary" || root.phase === "final_answer"
            ? root.phase
            : undefined;
          const state = this.agentMessages.get(itemId) ?? { deltas: [] };
          state.phase = phase;
          this.agentMessages.set(itemId, state);
        } else if (itemType === "commandExecution") {
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
        if (itemType === "agentMessage") {
          const itemId = typeof root.id === "string" ? root.id : "";
          const state = this.agentMessages.get(itemId) ?? { deltas: [] };
          const phase = root.phase === "commentary" || root.phase === "final_answer"
            ? root.phase
            : state.phase;
          const completedText = typeof root.text === "string" ? root.text : "";
          const text = completedText || state.deltas.join("");
          this.agentMessages.delete(itemId);
          if (text) events.push(phase === "commentary"
            ? { type: "commentary", text }
            : { type: "text", text });
        } else if (itemType === "commandExecution") {
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
        for (const [itemId, state] of this.agentMessages) {
          const text = state.deltas.join("");
          if (text) events.push(state.phase === "commentary"
            ? { type: "commentary", text }
            : { type: "text", text });
          this.agentMessages.delete(itemId);
        }
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

  private buildEnv(context: AgentRunContext, providerApiKey = context.apiKey): Record<string, string | undefined> {
    const env = sanitizedAgentChildEnv();
    Object.assign(env, context.environmentVariables ?? {});

    if (context.protocol === CODEX_RESPONSES_PROTOCOL) {
      Object.assign(env, codexResponsesProviderEnvironment({
        providerName: context.provider,
        baseUrl: context.baseUrl,
        apiKey: providerApiKey,
      }));
    }

    if (this.tempDir) {
      const codexHome = path.join(this.tempDir, ".codex");
      env.CODEX_HOME = codexHome;
      env.HOME = this.tempDir;
    }

    return env;
  }

  private materializeProviderModelCatalog(context: AgentRunContext): string | undefined {
    if (!this.tempDir) throw new Error("Codex temporary home is not initialized");
    if (!resolveCodexResponsesProviderProfile(context.provider)) return undefined;
    const env = sanitizedAgentChildEnv();
    env.HOME = this.tempDir;
    env.CODEX_HOME = path.join(this.tempDir, ".codex");
    let bundledCatalog = BUNDLED_CODEX_CATALOG_CACHE.get(this.codexBin);
    if (!bundledCatalog) {
      const result = spawnSync(this.codexBin, ["debug", "models", "--bundled"], {
        encoding: "utf8",
        env,
        shell: windowsCommandNeedsShell(this.codexBin),
        timeout: 15_000,
        maxBuffer: 1_000_000,
        windowsHide: true,
      });
      if (result.status !== 0 || !result.stdout?.trim()) {
        throw new Error(
          `Unable to load bundled Codex model metadata: ${result.stderr?.trim() || result.error?.message || `exit ${result.status}`}`,
        );
      }
      bundledCatalog = result.stdout;
      BUNDLED_CODEX_CATALOG_CACHE.set(this.codexBin, bundledCatalog);
    }
    const catalog = buildCodexProviderModelCatalogFromBundled(
      context.provider,
      context.model,
      bundledCatalog,
    );
    if (!catalog) return undefined;
    const catalogPath = path.join(this.tempDir, ".codex", "provider-models.json");
    fs.writeFileSync(catalogPath, JSON.stringify(catalog), { encoding: "utf8", mode: 0o600 });
    return catalogPath;
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
export const _resolveCodexWorkingDirectoryForTest = resolveCodexWorkingDirectory;
export const _resolveCodexSandboxModeForTest = resolveCodexSandboxMode;
