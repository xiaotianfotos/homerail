/**
 * Kimi Code adapter — wraps the MoonshotAI kimi CLI binary.
 *
 * Uses `kimi acp` JSON-RPC over stdio for session control. DAG tool
 * calls surfaced through ACP updates are executed against the worker's
 * in-process HomeRail DAG tool handlers.
 * @version 0.1.0
 */

import type {
  AgentClient,
  AgentEvent,
  AgentRunContext,
  AgentSkillDefinition,
  DagToolDefinition,
} from "./types.js";
import { spawn, type ChildProcess, type SpawnOptions } from "child_process";
import { createHash, randomUUID } from "crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "http";
import { createRequire } from "module";
import type { AddressInfo } from "net";
import { tmpdir } from "os";
import { dirname, extname, isAbsolute, join, resolve } from "path";
import { createInterface, type Interface as ReadlineInterface } from "readline";
import { sanitizedAgentChildEnv } from "./child-env.js";
import {
  createSession as createKimiSdkSession,
  ProtocolClient as KimiSdkProtocolClient,
  type ExternalTool as KimiSdkExternalTool,
  type Session as KimiSdkSession,
  type SessionOptions as KimiSdkSessionOptions,
  type StreamEvent as KimiSdkStreamEvent,
} from "@moonshot-ai/kimi-agent-sdk";
import {
  HOMERAIL_PROMPT_HANDOFF_PROTOCOL,
  HOMERAIL_PROMPT_TOOL_CALL_PROTOCOL,
  formatHomeRailPromptHandoff,
  formatHomeRailPromptToolCall,
  parseHomeRailPromptHandoff,
  parseHomeRailPromptToolCalls,
  stripHomeRailPromptMarkers,
} from "homerail-protocol";

/** Redact known secret values from a string. */
export function redactSecrets(str: string, secret: string): string {
  if (!secret) return str;
  return str.split(secret).join("***");
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function safeKimiSkillName(id: string): string {
  const base = id
    .normalize("NFKC")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^[^A-Za-z0-9]+/, "")
    .replace(/-+$/g, "")
    .slice(0, 80) || "homerail-skill";
  const digest = createHash("sha256").update(id).digest("hex").slice(0, 8);
  return `${base}-${digest}`;
}

function skillBody(content: string): string {
  const normalized = content.replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n")) return normalized.trim();
  const end = normalized.indexOf("\n---\n", 4);
  return end < 0 ? normalized.trim() : normalized.slice(end + 5).trim();
}

function writeProjectedSkill(root: string, definition: AgentSkillDefinition): void {
  const name = safeKimiSkillName(definition.id);
  const description = (definition.description || definition.name || `HomeRail Skill ${definition.id}`)
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 240);
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), [
    "---",
    `name: ${JSON.stringify(name)}`,
    `description: ${JSON.stringify(description || `HomeRail Skill ${definition.id}`)}`,
    "type: prompt",
    `whenToUse: ${JSON.stringify(description || `When this HomeRail task requires ${definition.id}`)}`,
    "disableModelInvocation: false",
    "---",
    "",
    `HomeRail Skill id: ${definition.id}`,
    "",
    skillBody(definition.content),
    "",
  ].join("\n"), { encoding: "utf-8", mode: 0o600 });
}

function prepareKimiRuntimeFiles(context: AgentRunContext, kimiHome: string): string[] {
  const instructions = context.systemPrompt?.trim();
  if (instructions) {
    writeFileSync(join(kimiHome, "AGENTS.md"), `${instructions}\n`, {
      encoding: "utf-8",
      mode: 0o600,
    });
  }

  const projection = context.skillProjection;
  if (!projection) return [];
  const directories: string[] = [];
  for (const directory of projection.directories ?? []) {
    const resolved = resolve(directory);
    try {
      if (statSync(resolved).isDirectory() && !directories.includes(resolved)) directories.push(resolved);
    } catch {
      // Explicit projections ignore unavailable roots and remain fail-closed.
    }
  }
  if ((projection.definitions?.length ?? 0) > 0) {
    const root = join(kimiHome, "homerail-skills");
    mkdirSync(root, { recursive: true });
    for (const definition of projection.definitions ?? []) writeProjectedSkill(root, definition);
    directories.push(root);
  }
  if (directories.length === 0) {
    const root = join(kimiHome, "homerail-skills-empty");
    mkdirSync(root, { recursive: true });
    directories.push(root);
  }
  return directories;
}

function mergedKimiSdkSkillsDir(directories: readonly string[], kimiHome: string): string | undefined {
  if (directories.length <= 1) return directories[0];
  const merged = join(kimiHome, "homerail-skills-merged");
  mkdirSync(merged, { recursive: true });
  for (const directory of directories) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const source = join(directory, entry.name);
      const destination = join(merged, entry.name);
      if (existsSync(destination)) continue;
      const stat = statSync(source);
      if (stat.isDirectory()) {
        symlinkSync(source, destination, process.platform === "win32" ? "junction" : "dir");
      } else if (stat.isFile() && entry.name.toLowerCase().endsWith(".md")) {
        copyFileSync(source, destination);
      }
    }
  }
  return merged;
}

function kimiSkillArgs(directories: readonly string[]): string[] {
  return directories.flatMap((directory) => ["--skills-dir", directory]);
}

export const _prepareKimiRuntimeFilesForTest = prepareKimiRuntimeFiles;

function waitForChildClose(child: ChildProcess): Promise<number | null> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(child.exitCode);
  return new Promise((resolve) => {
    child.once("close", (code) => resolve(code));
  });
}

interface KimiProcessCommand {
  command: string;
  argsPrefix: string[];
  displayName: string;
}

type KimiAgentTransport = "cli" | "sdk";
type KimiSdkSessionFactory = (options: KimiSdkSessionOptions) => KimiSdkSession;

interface KimiCodeAdapterOptions {
  kimiBin?: string;
  transport?: KimiAgentTransport;
  sdkExecutable?: string;
  createSdkSession?: KimiSdkSessionFactory;
}

const requireFromHere = createRequire(import.meta.url);

function nodeKimiCommand(kimiMain: string): KimiProcessCommand {
  return {
    command: process.execPath,
    argsPrefix: [kimiMain],
    displayName: `${process.execPath} ${kimiMain}`,
  };
}

function directKimiCommand(command: string): KimiProcessCommand {
  return {
    command,
    argsPrefix: [],
    displayName: command,
  };
}

function hideWindowsConsole(options: SpawnOptions): SpawnOptions {
  return {
    ...options,
    windowsHide: true,
  };
}

function resolveBundledKimiMain(): string | null {
  try {
    const packageJson = requireFromHere.resolve("@moonshot-ai/kimi-code/package.json");
    const main = join(dirname(packageJson), "dist", "main.mjs");
    return existsSync(main) ? main : null;
  } catch {
    return null;
  }
}

function pathHasDirectorySegment(value: string): boolean {
  return value.includes("/") || value.includes("\\") || isAbsolute(value);
}

function absoluteCandidatePath(value: string): string {
  return isAbsolute(value) ? value : resolve(process.cwd(), value);
}

function resolveKimiMainFromNpmShim(kimiBin: string): string | null {
  if (process.platform !== "win32") return null;
  const ext = extname(kimiBin).toLowerCase();
  if (ext !== ".cmd" && ext !== ".bat" && ext !== ".ps1") return null;

  const shim = absoluteCandidatePath(kimiBin);
  const shimDir = dirname(shim);
  const candidates = [
    join(shimDir, "..", "@moonshot-ai", "kimi-code", "dist", "main.mjs"),
    join(shimDir, "node_modules", "@moonshot-ai", "kimi-code", "dist", "main.mjs"),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

function isNodeScriptForWindows(kimiBin: string): boolean {
  if (process.platform !== "win32") return false;
  if (!pathHasDirectorySegment(kimiBin)) return false;
  const candidate = absoluteCandidatePath(kimiBin);
  if (!existsSync(candidate)) return false;

  const ext = extname(candidate).toLowerCase();
  if (ext === ".js" || ext === ".mjs" || ext === ".cjs") return true;
  if (ext) return false;

  try {
    const header = readFileSync(candidate, { encoding: "utf-8" }).slice(0, 160);
    return /^#!.*\bnode\b/i.test(header);
  } catch {
    return false;
  }
}

function resolveKimiCommand(kimiBin?: string): KimiProcessCommand {
  const requested = kimiBin?.trim();

  if (requested) {
    const npmShimMain = resolveKimiMainFromNpmShim(requested);
    if (npmShimMain) return nodeKimiCommand(npmShimMain);

    if (isNodeScriptForWindows(requested)) {
      return nodeKimiCommand(absoluteCandidatePath(requested));
    }

    if (process.platform === "win32" && !pathHasDirectorySegment(requested) && requested === "kimi") {
      const bundledMain = resolveBundledKimiMain();
      if (bundledMain) return nodeKimiCommand(bundledMain);
    }

    return directKimiCommand(requested);
  }

  const bundledMain = resolveBundledKimiMain();
  if (bundledMain) return nodeKimiCommand(bundledMain);
  return directKimiCommand("kimi");
}

function normalizeKimiAgentTransport(value: string | undefined): KimiAgentTransport | null {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return null;
  if (normalized === "sdk" || normalized === "agent-sdk" || normalized === "kimi-agent-sdk") return "sdk";
  if (normalized === "cli" || normalized === "acp" || normalized === "kimi-code") return "cli";
  return null;
}

function resolveKimiAgentTransport(options?: KimiCodeAdapterOptions): KimiAgentTransport {
  const explicit = normalizeKimiAgentTransport(options?.transport ?? process.env.HOMERAIL_KIMI_AGENT_TRANSPORT);
  if (explicit) return explicit;
  if (options?.sdkExecutable || process.env.KIMI_AGENT_SDK_EXECUTABLE) return "sdk";
  return "cli";
}

function requiresAlwaysThinking(model: string): boolean {
  const normalized = model.trim().toLowerCase();
  return normalized === "kimi-k2.7-code" || normalized.startsWith("kimi-for-coding");
}

/** Parsed line from kimi CLI stream-json output. */
interface StreamJsonLine {
  type?: string;
  role?: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: string;
  is_error?: boolean;
  error?: string;
  exit_code?: number;
  stderr?: string;
  [key: string]: unknown;
}

/** ACP JSON-RPC notification shape. */
interface AcpNotification {
  jsonrpc: "2.0";
  method: string;
  params?: Record<string, unknown>;
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

interface KimiMcpToolDescriptor {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

interface KimiMcpServerConfig {
  name: string;
  command: string;
  args: string[];
  env: Array<{ name: string; value: string }>;
}

interface KimiToolMcpBridge {
  servers: KimiMcpServerConfig[];
  close: () => Promise<void>;
}

export class KimiCodeAdapter implements AgentClient {
  private readonly defaultModel: string;
  private readonly defaultProviderType: string;
  private readonly kimiCommand: KimiProcessCommand;
  private readonly transport: KimiAgentTransport;
  private readonly sdkExecutable: string;
  private readonly createSdkSession: KimiSdkSessionFactory;

  constructor(kimiBinOrOptions?: string | KimiCodeAdapterOptions) {
    const options: KimiCodeAdapterOptions = typeof kimiBinOrOptions === "string"
      ? { kimiBin: kimiBinOrOptions }
      : kimiBinOrOptions ?? {};
    this.defaultModel = process.env.KIMI_MODEL_NAME ?? "kimi-code";
    this.defaultProviderType = process.env.KIMI_MODEL_PROVIDER_TYPE ?? "kimi";
    this.transport = resolveKimiAgentTransport(options);
    this.sdkExecutable = options.sdkExecutable ?? process.env.KIMI_AGENT_SDK_EXECUTABLE ?? process.env.KIMI_BIN_PATH ?? "kimi";
    this.createSdkSession = options.createSdkSession ?? createKimiSdkSession;
    this.kimiCommand = resolveKimiCommand(options.kimiBin ?? process.env.KIMI_BIN_PATH);
  }

  private spawnKimi(args: string[], options: SpawnOptions): ChildProcess {
    return spawn(
      this.kimiCommand.command,
      [...this.kimiCommand.argsPrefix, ...args],
      hideWindowsConsole(options),
    );
  }

  async *run(
    prompt: string,
    tools: DagToolDefinition[],
    context: AgentRunContext,
  ): AsyncIterable<AgentEvent> {
    const secret = context.apiKey || process.env.KIMI_MODEL_API_KEY || "";

    // Readiness check
    const readiness = await this.checkReadiness();
    if (!readiness.ready) {
      yield {
        type: "debug",
        source: "kimi-code",
        message: "readiness_check_failed",
        data: { error: readiness.error },
      };
      yield { type: "error", message: readiness.error! };
      yield { type: "done" };
      return;
    }

    yield {
      type: "debug",
      source: "kimi-code",
      message: "readiness_check_passed",
      data: { version: readiness.version },
    };

    // Build isolated environment
    const kimiHome = mkdtempSync(join(tmpdir(), "kimi-code-"));
    const env = this.buildKimiEnv(context, kimiHome);
    const configPath = this.writeKimiConfig(context, kimiHome);
    const skillDirectories = prepareKimiRuntimeFiles(context, kimiHome);

    yield {
      type: "debug",
      source: "kimi-code",
      message: "env_prepared",
      data: {
        kimi_home_set: true,
        model: context.model || this.defaultModel,
        provider: context.provider || process.env.KIMI_MODEL_PROVIDER_ID || "kimi",
        config_written: Boolean(configPath),
        has_api_key: Boolean(context.apiKey || process.env.KIMI_MODEL_API_KEY),
        has_base_url: Boolean(context.baseUrl || process.env.KIMI_MODEL_BASE_URL),
        tool_count: tools.length,
        tool_names: tools.map((t) => t.name),
        workspace: context.workspace ?? process.cwd(),
        transport: this.transport,
        has_agent_instructions: Boolean(context.systemPrompt?.trim()),
        skill_directory_count: skillDirectories.length,
        projected_skill_count: context.skillProjection?.definitions?.length ?? 0,
      },
    };

    let cancelled = false;

    try {
      const effectiveModel = context.model || this.defaultModel;
      const cwd = context.workspace ?? process.cwd();

      if (this.transport === "sdk") {
        for await (const event of this.runSdkMode(
          prompt,
          tools,
          context,
          env,
          effectiveModel,
          kimiHome,
          skillDirectories,
          secret,
        )) {
          yield event;
        }
        yield { type: "done" };
        return;
      }

      if (this.shouldUsePromptToolBridge(tools)) {
        yield {
          type: "debug",
          source: "kimi-code",
          message: "prompt_mode_tool_bridge_selected",
          data: {
            degraded: true,
            transport: "prompt-marker",
            canonical_protocol: HOMERAIL_PROMPT_TOOL_CALL_PROTOCOL,
            reason: "manager_agent_tools",
            tool_count: tools.length,
            tool_names: tools.map((tool) => tool.name),
          },
        };
        for await (const event of this.runPromptMode(
          prompt,
          tools,
          context,
          env,
          effectiveModel,
          skillDirectories,
          secret,
        )) {
          yield event;
        }
        return;
      }

      const childProcess = this.spawnKimi([
        "--model",
        effectiveModel,
        ...kimiSkillArgs(skillDirectories),
        "acp",
      ], {
        cwd,
        env: env as Record<string, string | undefined>,
        stdio: ["pipe", "pipe", "pipe"],
      });

      // Wire abortSignal
      let abortHandler: (() => void) | null = null;
      if (context.abortSignal) {
        abortHandler = (): void => {
          cancelled = true;
          childProcess.kill("SIGTERM");
        };
        if (context.abortSignal.aborted) {
          cancelled = true;
          childProcess.kill("SIGTERM");
        } else {
          context.abortSignal.addEventListener("abort", abortHandler, { once: true });
        }
      }

      const rpc = createJsonRpcClient(childProcess);
      const toolMap = new Map<string, DagToolDefinition>(tools.map((tool) => [tool.name, tool]));
      let mcpBridge: KimiToolMcpBridge | null = null;

      try {
        mcpBridge = tools.length > 0
          ? await this.createToolMcpBridge(tools, toolMap, kimiHome)
          : null;

        if (mcpBridge) {
          yield {
            type: "debug",
            source: "kimi-code",
            message: "mcp_bridge_registered",
            data: { server: "homerail-tools", tool_names: tools.map((tool) => tool.name) },
          };
        }

        await rpc.sendRequest("initialize", {
          protocolVersion: 1,
          clientCapabilities: {
            fs: { readTextFile: false, writeTextFile: false },
          },
        });

        const sessionResult = await rpc.sendRequest("session/new", {
          cwd,
          mcpServers: mcpBridge?.servers ?? [],
        });
        const sessionId = sessionResult.sessionId as string | undefined;
        if (!sessionId) {
          yield { type: "error", message: "kimi acp session/new did not return sessionId" };
          return;
        }

        yield {
          type: "debug",
          source: "kimi-code",
          message: "acp_session_created",
          data: {
            session_id: sessionId,
            model: effectiveModel,
            mcp_server_count: mcpBridge?.servers.length ?? 0,
            mcp_tool_count: tools.length,
          },
        };

        const promptRequest = rpc.sendRequest("session/prompt", {
          sessionId,
          prompt: [{ type: "text", text: this.buildAgentPrompt(prompt) }],
        });

        let promptSettled = false;
        const promptSettledSignal = promptRequest
          .then(() => ({ kind: "prompt" as const }))
          .catch((err: unknown) => {
            throw err instanceof Error ? err : new Error(String(err));
          })
          .finally(() => {
            promptSettled = true;
          });

        while (!promptSettled && !context.abortSignal?.aborted) {
          const next = await Promise.race([
            rpc.waitForNotification(120_000).then((notification) => ({
              kind: "notification" as const,
              notification,
            })),
            promptSettledSignal,
          ]);
          if (next.kind === "prompt") break;

          const notification = next.notification;
          const events = this.parseAcpEvent(notification, secret);
          for (const event of events) {
            yield event;
            if (event.type === "tool_use" && !mcpBridge) {
              const result = await this.executeTool(toolMap, event.name, event.input, event.id);
              yield {
                type: "tool_result",
                tool_use_id: event.id,
                content: result.content,
                is_error: result.is_error,
              };
            }
          }
        }

        if (context.abortSignal?.aborted) {
          promptRequest.catch(() => {
            // The JSON-RPC request may reject after close() tears down stdio.
          });
          yield {
            type: "debug",
            source: "kimi-code",
            message: "acp_prompt_aborted",
            data: {},
          };
          return;
        }

        await promptRequest;

        const exitCode = rpc.getExitCodeNow();
        const stderrOutput = rpc.getStderr();

        if (cancelled) {
          yield {
            type: "debug",
            source: "kimi-code",
            message: "run_cancelled",
            data: {},
          };
        } else if (typeof exitCode === "number" && exitCode !== 0) {
          const redactedStderr = redactSecrets(stderrOutput.trim().slice(-2000), secret);
          yield {
            type: "error",
            message: `kimi exited with code ${exitCode}: ${redactedStderr || "no stderr"}`,
          };
        }
      } catch (err) {
        if (this.shouldFallbackToPromptMode(err, context)) {
          if (this.isManagerAgentToolCatalog(tools)) {
            yield {
              type: "debug",
              source: "kimi-code",
              message: "acp_auth_required_fallback_to_agent_sdk",
              data: {
                model: effectiveModel,
                has_api_key: true,
                tool_count: tools.length,
              },
            };
            try {
              for await (const event of this.runSdkMode(
                prompt,
                tools,
                context,
                env,
                effectiveModel,
                kimiHome,
                skillDirectories,
                secret,
              )) {
                yield event;
              }
              return;
            } catch (sdkError) {
              yield {
                type: "debug",
                source: "kimi-code",
                message: "manager_agent_sdk_fallback_failed",
                data: {
                  error: redactSecrets(
                    sdkError instanceof Error ? sdkError.message : String(sdkError),
                    secret,
                  ),
                },
              };
            }
          }
          yield {
            type: "debug",
            source: "kimi-code",
            message: "acp_auth_required_fallback_to_prompt_mode",
            data: {
              model: effectiveModel,
              has_api_key: true,
              tool_count: tools.length,
            },
          };
          for await (const event of this.runPromptMode(
            prompt,
            tools,
            context,
            env,
            effectiveModel,
            skillDirectories,
            secret,
            true,
          )) {
            yield event;
          }
          return;
        }
        throw err;
      } finally {
        if (mcpBridge) {
          await mcpBridge.close().catch(() => {
            // Best-effort cleanup; temp KIMI_CODE_HOME is removed below.
          });
        }
        if (context.abortSignal && abortHandler) {
          context.abortSignal.removeEventListener("abort", abortHandler);
        }
        rpc.close();
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      yield {
        type: "error",
        message: `kimi-code adapter error: ${redactSecrets(msg, secret)}`,
      };
    } finally {
      // Clean up temp directory
      try {
        rmSync(kimiHome, { recursive: true, force: true });
      } catch {
        // Best-effort cleanup
      }
    }

    yield { type: "done" };
  }

  /**
   * Parse a single stream-json line into AgentEvent(s).
   * Public for testability.
   */
  parseStreamJsonLine(line: string, secret: string = ""): AgentEvent[] {
    const events: AgentEvent[] = [];

    let parsed: StreamJsonLine;
    try {
      parsed = JSON.parse(line) as StreamJsonLine;
    } catch {
      // If it's not valid JSON, treat as plain text
      events.push({ type: "text", text: redactSecrets(line, secret) });
      return events;
    }

    const doRedact = (s: string): string => redactSecrets(s, secret);

    if (
      parsed.type === undefined &&
      parsed.role === "assistant" &&
      typeof parsed.content === "string"
    ) {
      events.push({ type: "text", text: doRedact(parsed.content) });
      return events;
    }

    switch (parsed.type) {
      case "text": {
        if (parsed.text) {
          events.push({ type: "text", text: doRedact(parsed.text) });
        }
        break;
      }
      case "thinking": {
        if (parsed.thinking) {
          events.push({ type: "thinking", text: doRedact(parsed.thinking) });
        }
        break;
      }
      case "tool_use": {
        events.push({
          type: "tool_use",
          id: parsed.id ?? randomUUID(),
          name: parsed.name ?? "",
          input: parsed.input ?? {},
        });
        break;
      }
      case "tool_result": {
        events.push({
          type: "tool_result",
          tool_use_id: parsed.tool_use_id ?? "",
          content: doRedact(parsed.content ?? ""),
          is_error: parsed.is_error,
        });
        break;
      }
      case "error": {
        events.push({
          type: "error",
          message: doRedact(parsed.error ?? "unknown error from kimi"),
        });
        break;
      }
      case "turn_complete": {
        events.push({ type: "turn_complete" });
        break;
      }
      case "done": {
        // Handled externally via process exit
        break;
      }
      default: {
        // Unknown event type — emit as debug
        events.push({
          type: "debug",
          source: "kimi-code",
          message: "unknown_stream_event",
          data: { raw: doRedact(JSON.stringify(parsed)) },
        });
      }
    }

    return events;
  }

  /**
   * Parse an ACP JSON-RPC notification into an AgentEvent.
   * Public for testability.
   */
  parseAcpEvent(msg: unknown, secret: string = ""): AgentEvent[] {
    const events: AgentEvent[] = [];

    if (
      typeof msg !== "object" ||
      msg === null ||
      !("jsonrpc" in msg) ||
      !("method" in msg)
    ) {
      return events;
    }

    const rpc = msg as AcpNotification;
    const doRedact = (s: string): string => redactSecrets(s, secret);

    if (rpc.method === "session/update" && rpc.params) {
      const params = rpc.params;
      if (typeof params === "object" && params !== null) {
        const update = params.update as Record<string, unknown> | undefined;
        if (update) {
          const kind = update.sessionUpdate as string | undefined;
          if (kind === "agent_message_chunk") {
            const content = update.content as Record<string, unknown> | undefined;
            const text = content?.type === "text" ? content.text as string | undefined : undefined;
            if (text) events.push({ type: "text", text: doRedact(text) });
          } else if (kind === "agent_thought_chunk") {
            const content = update.content as Record<string, unknown> | undefined;
            const text = content?.type === "text" ? content.text as string | undefined : undefined;
            if (text) events.push({ type: "thinking", text: doRedact(text) });
          } else if (kind === "tool_call") {
            const id = (update.toolCallId as string | undefined) ?? randomUUID();
            const input = normalizeAcpToolInput(update);
            events.push({
              type: "tool_use",
              id,
              name: String(update.title ?? update.name ?? ""),
              input,
            });
          } else if (kind === "tool_call_update") {
            const status = update.status as string | undefined;
            if (status === "completed" || status === "failed") {
              events.push({
                type: "tool_result",
                tool_use_id: (update.toolCallId as string | undefined) ?? "",
                content: stringifyAcpContent(update.content),
                is_error: status === "failed",
              });
            }
          }
          return events;
        }

        const contentType = params.content_type as string | undefined;
        const content = params.content as string | undefined;

        if (contentType === "text" && content) {
          events.push({ type: "text", text: doRedact(content) });
        } else if (contentType === "thinking" && content) {
          events.push({ type: "thinking", text: doRedact(content) });
        } else if (contentType === "tool_use") {
          events.push({
            type: "tool_use",
            id: (params.id as string) ?? randomUUID(),
            name: (params.name as string) ?? "",
            input: (params.input as Record<string, unknown>) ?? {},
          });
        } else if (contentType === "tool_result") {
          events.push({
            type: "tool_result",
            tool_use_id: (params.tool_use_id as string) ?? "",
            content: doRedact((params.content as string) ?? ""),
            is_error: params.is_error as boolean | undefined,
          });
        } else if (contentType === "error") {
          events.push({
            type: "error",
            message: doRedact((params.error as string) ?? "ACP session error"),
          });
        } else if (contentType === "turn_complete") {
          events.push({ type: "turn_complete" });
        }
      }
    } else if (rpc.method === "session/error") {
      const errorMsg = typeof rpc.params?.error === "string"
        ? doRedact(rpc.params.error)
        : "ACP session error";
      events.push({ type: "error", message: errorMsg });
    }

    return events;
  }

  /**
   * Build isolated env for kimi process.
   * Must NOT expose KIMI_MODEL_API_KEY in any debug output.
   */
  buildKimiEnv(context: AgentRunContext, kimiHome: string): Record<string, string | undefined> {
    const env = sanitizedAgentChildEnv();

    // Isolated KIMI_CODE_HOME
    env.KIMI_CODE_HOME = kimiHome;
    env.KIMI_SHARE_DIR = kimiHome;

    // Disable telemetry
    env.KIMI_DISABLE_TELEMETRY = "1";

    // Model configuration from context (preferred) or env fallback
    const apiKey = context.apiKey || process.env.KIMI_MODEL_API_KEY || "";
    const model = context.model || this.defaultModel;
    const baseUrl = context.baseUrl || process.env.KIMI_MODEL_BASE_URL || "";
    const providerType = process.env.KIMI_MODEL_PROVIDER_TYPE || this.defaultProviderType;

    if (apiKey) env.KIMI_MODEL_API_KEY = apiKey;
    if (model) env.KIMI_MODEL_NAME = model;
    if (baseUrl) env.KIMI_MODEL_BASE_URL = baseUrl;
    if (providerType) env.KIMI_MODEL_PROVIDER_TYPE = providerType;

    return env;
  }

  buildKimiConfig(context: AgentRunContext): string {
    const apiKey = context.apiKey || process.env.KIMI_MODEL_API_KEY || "";
    const model = context.model || this.defaultModel;
    const baseUrl = context.baseUrl || process.env.KIMI_MODEL_BASE_URL || "";
    const providerId = context.provider || process.env.KIMI_MODEL_PROVIDER_ID || "kimi";
    const providerType = process.env.KIMI_MODEL_PROVIDER_TYPE || this.defaultProviderType;
    const maxContextSize = Number.parseInt(process.env.KIMI_MODEL_MAX_CONTEXT_SIZE ?? "128000", 10);
    const safeMaxContextSize = Number.isFinite(maxContextSize) && maxContextSize > 0
      ? maxContextSize
      : 128000;
    const alwaysThinking = requiresAlwaysThinking(model);

    return [
      `default_model = ${tomlString(model)}`,
      ...(alwaysThinking ? ["default_thinking = true"] : []),
      `default_provider = ${tomlString(providerId)}`,
      "",
      `[providers.${tomlString(providerId)}]`,
      `type = ${tomlString(providerType)}`,
      ...(apiKey ? [`api_key = ${tomlString(apiKey)}`] : []),
      ...(baseUrl ? [`base_url = ${tomlString(baseUrl)}`] : []),
      `default_model = ${tomlString(model)}`,
      "",
      `[models.${tomlString(model)}]`,
      `provider = ${tomlString(providerId)}`,
      `model = ${tomlString(model)}`,
      `max_context_size = ${safeMaxContextSize}`,
      ...(alwaysThinking
        ? ['capabilities = [ "thinking", "always_thinking", "image_in", "video_in", "tool_use" ]']
        : []),
      "",
    ].join("\n");
  }

  writeKimiConfig(context: AgentRunContext, kimiHome: string): string {
    const configPath = join(kimiHome, "config.toml");
    writeFileSync(configPath, this.buildKimiConfig(context), { encoding: "utf-8", mode: 0o600 });
    try {
      chmodSync(configPath, 0o600);
    } catch {
      // Best effort; the temporary KIMI_CODE_HOME is still removed after the run.
    }
    return configPath;
  }

  private async *runSdkMode(
    prompt: string,
    tools: DagToolDefinition[],
    context: AgentRunContext,
    env: Record<string, string | undefined>,
    effectiveModel: string,
    kimiHome: string,
    skillDirectories: readonly string[],
    secret: string,
  ): AsyncIterable<AgentEvent> {
    const cwd = context.workspace ?? process.cwd();
    const executedTools: Array<{
      id: string;
      key: string;
      name: string;
      input: Record<string, unknown>;
      content: string;
      is_error?: boolean;
    }> = [];
    const emittedToolKeys = new Set<string>();
    const session = this.createSdkSession({
      workDir: cwd,
      model: effectiveModel,
      executable: this.sdkExecutable,
      env: env as Record<string, string>,
      shareDir: kimiHome,
      skillsDir: mergedKimiSdkSkillsDir(skillDirectories, kimiHome),
      yoloMode: true,
      externalTools: this.toSdkExternalTools(tools, executedTools),
      clientInfo: { name: "homerail-worker", version: "0.1.0" },
    });
    const turn = session.prompt(this.buildAgentPrompt(prompt));
    let cancelled = false;
    let turnFinished = false;
    let interruptRequested = false;
    const interruptTurn = async (): Promise<void> => {
      if (interruptRequested || turnFinished) return;
      interruptRequested = true;
      cancelled = true;
      await turn.interrupt();
    };
    const controllerBinding = context.turnController?.bindDriver({
      steer: (command) => turn.steer(command.content),
      interrupt: interruptTurn,
      close: interruptTurn,
    });
    const abortHandler = (): void => {
      interruptTurn().catch(() => {
        // The SDK process may already be shutting down.
      });
    };

    if (context.abortSignal) {
      if (context.abortSignal.aborted) abortHandler();
      else context.abortSignal.addEventListener("abort", abortHandler, { once: true });
    }

    try {
      if (controllerBinding?.status === "rejected") {
        await interruptTurn().catch(() => {
          // The SDK process may already be shutting down.
        });
        yield {
          type: "error",
          message: `Kimi Agent SDK turn controller binding failed: ${controllerBinding.reason ?? "unknown error"}`,
        };
        return;
      }

      yield {
        type: "debug",
        source: "kimi-code",
        message: "kimi_agent_sdk_session_started",
        data: {
          executable: this.sdkExecutable,
          session_id: session.sessionId,
          model: effectiveModel,
          tool_count: tools.length,
          tool_names: tools.map((tool) => tool.name),
        },
      };

      for await (const sdkEvent of turn) {
        for (const event of this.parseSdkEvent(sdkEvent, secret)) {
          if (event.type === "tool_use") {
            emittedToolKeys.add(toolEventKey(event.name, event.input));
          }
          yield event;
        }
      }

      const result = await turn.result;
      for (const executed of executedTools) {
        if (emittedToolKeys.has(executed.key)) continue;
        yield { type: "tool_use", id: executed.id, name: executed.name, input: executed.input };
        yield {
          type: "tool_result",
          tool_use_id: executed.id,
          content: redactSecrets(executed.content, secret),
          is_error: executed.is_error,
        };
      }
      if (cancelled || result.status === "cancelled") {
        yield { type: "debug", source: "kimi-code", message: "sdk_run_cancelled", data: {} };
      } else if (result.status !== "finished") {
        yield {
          type: "error",
          message: `kimi agent sdk turn ended with status ${result.status}`,
        };
      }
    } finally {
      turnFinished = true;
      if (context.abortSignal) {
        context.abortSignal.removeEventListener("abort", abortHandler);
      }
      await session.close().catch(() => {
        // Best-effort SDK cleanup; temp KIMI_SHARE_DIR is removed by the caller.
      });
    }
  }

  private toSdkExternalTools(
    tools: DagToolDefinition[],
    executedTools: Array<{
      id: string;
      key: string;
      name: string;
      input: Record<string, unknown>;
      content: string;
      is_error?: boolean;
    }>,
  ): KimiSdkExternalTool[] {
    return tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: normalizeJsonSchema(tool.input_schema),
      handler: async (params: Record<string, unknown>) => {
        const key = toolEventKey(tool.name, params);
        const id = executedTools.find((entry) => entry.key === key)?.id
          ?? `kimi_${createHash("sha256").update(key).digest("hex")}`;
        try {
          const result = await tool.handler(params, { tool_call_id: id });
          const content = result.content.map((block) => block.text).join("");
          executedTools.push({
            id,
            key,
            name: tool.name,
            input: params,
            content,
            is_error: result.is_error,
          });
          return { output: content, message: content };
        } catch (err) {
          const content = `Tool ${tool.name} threw: ${err instanceof Error ? err.message : String(err)}`;
          executedTools.push({
            id,
            key: toolEventKey(tool.name, params),
            name: tool.name,
            input: params,
            content,
            is_error: true,
          });
          return { output: content, message: content };
        }
      },
    }));
  }

  private parseSdkEvent(event: KimiSdkStreamEvent, secret: string = ""): AgentEvent[] {
    const typed = event as { type: string; payload?: unknown; code?: string; message?: string };
    if (typed.type === "error") {
      return [{ type: "error", message: redactSecrets(typed.message ?? typed.code ?? "kimi agent sdk stream error", secret) }];
    }
    const payload = typed.payload as Record<string, unknown> | undefined;
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return [];

    switch (typed.type) {
      case "ContentPart": {
        if (payload.type === "text" && typeof payload.text === "string") {
          return [{ type: "text", text: redactSecrets(payload.text, secret) }];
        }
        if (payload.type === "think" && typeof payload.think === "string") {
          return [{ type: "thinking", text: redactSecrets(payload.think, secret) }];
        }
        return [];
      }
      case "ToolCall": {
        const fn = payload.function as Record<string, unknown> | undefined;
        const name = typeof fn?.name === "string" ? fn.name : "";
        if (!name) return [];
        const input = parseSdkToolArguments(typeof fn?.arguments === "string" ? fn.arguments : undefined);
        return [{
          type: "tool_use",
          id: typeof payload.id === "string" ? payload.id : randomUUID(),
          name,
          input,
        }];
      }
      case "ToolResult": {
        const returnValue = payload.return_value as Record<string, unknown> | undefined;
        return [{
          type: "tool_result",
          tool_use_id: typeof payload.tool_call_id === "string" ? payload.tool_call_id : randomUUID(),
          content: redactSecrets(sdkToolOutputToString(returnValue?.output), secret),
          is_error: returnValue?.is_error === true ? true : undefined,
        }];
      }
      case "TurnEnd":
        return [{ type: "turn_complete" }];
      case "StepBegin":
      case "StatusUpdate":
      case "ToolCallPart":
      case "ApprovalResponse":
      case "SteerInput":
      case "StepInterrupted":
      case "CompactionBegin":
      case "CompactionEnd":
      case "HookTriggered":
      case "HookResolved":
        return [{
          type: "debug",
          source: "kimi-code",
          message: "sdk_stream_event",
          data: { sdk_event_type: typed.type },
        }];
      default:
        return [{
          type: "debug",
          source: "kimi-code",
          message: "unknown_sdk_stream_event",
          data: { sdk_event_type: typed.type },
        }];
    }
  }

  private shouldFallbackToPromptMode(err: unknown, context: AgentRunContext): boolean {
    const message = err instanceof Error ? err.message : String(err);
    const hasApiKey = Boolean(context.apiKey || process.env.KIMI_MODEL_API_KEY);
    return hasApiKey && /Authentication required/i.test(message);
  }

  private async *runPromptMode(
    prompt: string,
    tools: DagToolDefinition[],
    context: AgentRunContext,
    env: Record<string, string | undefined>,
    effectiveModel: string,
    skillDirectories: readonly string[],
    secret: string,
    forceToolBridge = false,
  ): AsyncIterable<AgentEvent> {
    const cwd = context.workspace ?? process.cwd();
    const toolMap = new Map<string, DagToolDefinition>(tools.map((tool) => [tool.name, tool]));
    const promptText = this.buildPromptModePrompt(prompt, tools, forceToolBridge);
    const child = this.spawnKimi([
      "--model",
      effectiveModel,
      ...kimiSkillArgs(skillDirectories),
      "--prompt",
      promptText,
      "--output-format",
      "stream-json",
    ], {
      cwd,
      env: env as Record<string, string | undefined>,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stderr = "";
    let accumulatedText = "";
    let cancelled = false;
    let handoffEmitted = false;
    let toolMarkerEmitted = false;
    let promptModeCreatedRun = false;

    const abortHandler = (): void => {
      cancelled = true;
      child.kill("SIGTERM");
    };
    if (context.abortSignal) {
      if (context.abortSignal.aborted) abortHandler();
      else context.abortSignal.addEventListener("abort", abortHandler, { once: true });
    }

    child.stderr?.on("data", (data: Buffer) => {
      stderr += data.toString("utf-8");
      if (stderr.length > 12000) stderr = stderr.slice(-12000);
    });

    try {
      const rl = createInterface({ input: child.stdout! });
      for await (const line of rl) {
        const events = this.parseStreamJsonLine(line, secret);
        for (const event of events) {
          if (event.type === "text") {
            accumulatedText += event.text;
            continue;
          }
          if (event.type === "tool_use") {
            yield event;
            const result = await this.executeTool(toolMap, event.name, event.input, event.id);
            yield {
              type: "tool_result",
              tool_use_id: event.id,
              content: result.content,
              is_error: result.is_error,
            };
            continue;
          }
          yield event;
        }
      }

      const exitCode = await waitForChildClose(child);
      if (cancelled) {
        yield { type: "debug", source: "kimi-code", message: "prompt_mode_cancelled", data: {} };
        return;
      }
      if (exitCode !== 0) {
        const redactedStderr = redactSecrets(stderr.trim().slice(-2000), secret);
        yield {
          type: "error",
          message: `kimi prompt mode exited with code ${exitCode}: ${redactedStderr || "no stderr"}`,
        };
        return;
      }

      const toolMarkers = parseHomeRailPromptToolCalls(accumulatedText);
      for (const marker of toolMarkers) {
        if (!toolMap.has(marker.name)) {
          yield {
            type: "debug",
            source: "kimi-code",
            message: "prompt_mode_unknown_tool_marker",
            data: { name: marker.name },
          };
          continue;
        }
        if (marker.name === "finish" && promptModeCreatedRun) {
          yield {
            type: "debug",
            source: "kimi-code",
            message: "prompt_mode_finish_ignored_after_create_and_run",
            data: { reason: "tool_result_contains_authoritative_run_id" },
          };
          continue;
        }
        const toolId = randomUUID();
        yield { type: "tool_use", id: toolId, name: marker.name, input: marker.input };
        const result = await this.executeTool(toolMap, marker.name, marker.input, toolId);
        toolMarkerEmitted = true;
        if (marker.name === "create_and_run" && result.is_error !== true) {
          promptModeCreatedRun = true;
        }
        yield {
          type: "tool_result",
          tool_use_id: toolId,
          content: result.content,
          is_error: result.is_error,
        };
      }

      const handoff = parseHomeRailPromptHandoff(accumulatedText);
      if (handoff && toolMap.has("handoff")) {
        const toolId = randomUUID();
        const input = {
          port: handoff.port,
          content: handoff.content,
          ...(handoff.summary ? { summary: handoff.summary } : {}),
        };
        yield { type: "tool_use", id: toolId, name: "handoff", input };
        const result = await this.executeTool(toolMap, "handoff", input, toolId);
        handoffEmitted = true;
        yield {
          type: "tool_result",
          tool_use_id: toolId,
          content: result.content,
          is_error: result.is_error,
        };
      }
      if (toolMap.has("handoff") && !handoffEmitted) {
        yield {
          type: "debug",
          source: "kimi-code",
          message: "prompt_mode_handoff_marker_missing",
          data: { expected_marker: `<${HOMERAIL_PROMPT_HANDOFF_PROTOCOL}>{...}</${HOMERAIL_PROMPT_HANDOFF_PROTOCOL}>` },
        };
      }
      if (this.shouldUsePromptToolBridge(tools, forceToolBridge) && !toolMarkerEmitted) {
        yield {
          type: "debug",
          source: "kimi-code",
          message: "prompt_mode_tool_marker_missing",
          data: { expected_marker: `<${HOMERAIL_PROMPT_TOOL_CALL_PROTOCOL}>{...}</${HOMERAIL_PROMPT_TOOL_CALL_PROTOCOL}>` },
        };
      }
      const visibleText = visiblePromptModeText(accumulatedText, toolMarkers.length > 0 || Boolean(handoff));
      if (visibleText) {
        yield { type: "text", text: redactSecrets(visibleText, secret) };
      }
    } finally {
      if (context.abortSignal) {
        context.abortSignal.removeEventListener("abort", abortHandler);
      }
      child.stdout?.destroy();
      child.stderr?.destroy();
      if (child.exitCode === null && !child.killed) {
        child.kill("SIGTERM");
      }
    }
  }

  private shouldUsePromptToolBridge(tools: DagToolDefinition[], force = false): boolean {
    const names = new Set(tools.map((tool) => tool.name));
    return (force || process.env.HOMERAIL_KIMI_PROMPT_TOOL_BRIDGE === "1") && names.has("create_and_run") && names.has("finish");
  }

  private isManagerAgentToolCatalog(tools: DagToolDefinition[]): boolean {
    const names = new Set(tools.map((tool) => tool.name));
    return names.has("create_and_run") && names.has("finish");
  }

  private buildAgentPrompt(prompt: string): string {
    return prompt;
  }

  private buildPromptModePrompt(
    prompt: string,
    tools: DagToolDefinition[],
    forceToolBridge = false,
  ): string {
    const toolMap = new Map<string, DagToolDefinition>(tools.map((tool) => [tool.name, tool]));
    const blocks = [this.buildAgentPrompt(prompt)];
    if (this.shouldUsePromptToolBridge(tools, forceToolBridge)) {
      blocks.push(
        "",
        "HomeRail tool execution protocol:",
        "Emit the structured HomeRail Tool call marker before any user-facing prose.",
        "When the user asks to inspect, start, supervise, or change real HomeRail state, output exactly one marker per required tool call.",
        "When the user asks for visible canvas UI, call the available generated-view Tool described by the system or Skill; do not substitute a local file.",
        "Do not claim a DAG/run was created unless you output a create_and_run marker. Do not invent run IDs.",
        "If execution fails, keep the final summary in the user's task language: name only the visible action that did not complete and offer to retry.",
        "Do not describe this protocol or any internal execution mechanism to the user.",
        "After all Tool call markers, always add one concise user-facing summary in the user's language.",
        "Every entry under Available tools is callable through this marker protocol. Attempt the matching entry instead of speculating about availability.",
        "Marker format:",
        formatHomeRailPromptToolCall({
          name: "create_and_run",
          input: {
            yamlPath: "assets/orchestrations/public-two-node.yaml.template",
            profile: "offline-deterministic",
            prompt: "short task prompt",
          },
        }),
        ...(toolMap.has("upsert_generated_view")
          ? [
              "Minimal canvas Tool example (replace the id, title, summary, and data with the user's result):",
              formatHomeRailPromptToolCall({
                name: "upsert_generated_view",
                input: {
                  id: "result-card",
                  title: "Result",
                  summary: "Short result summary",
                  surface: "result",
                  importance: "primary",
                  density: "glance",
                  canvas_size: "1x1",
                  persistence: "session",
                  content: { data: { text: "Result" } },
                  a2ui: {
                    version: "v1.0",
                    catalogId: "https://homerail.dev/a2ui/catalogs/core/v1",
                    components: [{ id: "root", component: "Text", text: { path: "/data/text" } }],
                  },
                },
              }),
            ]
          : []),
        "Available tools:",
        ...tools.map((tool) => `- ${tool.name}: ${tool.description}; input_schema=${JSON.stringify(tool.input_schema)}`),
      );
    }
    if (toolMap.has("handoff")) {
      blocks.push(
        "",
        "HomeRail prompt-mode handoff fallback:",
        "When the work is complete, output exactly one final handoff marker on its own line.",
        "Format:",
        formatHomeRailPromptHandoff({
          port: "done",
          content: { summary: "your result" },
          summary: "short summary",
        }),
        "Use the output port requested by the DAG instructions if it is not done.",
      );
    }
    return blocks.join("\n");
  }

  /**
   * Check that the kimi binary is available and return its version.
   */
  async checkReadiness(): Promise<{ ready: boolean; version?: string; error?: string }> {
    if (this.transport === "sdk") {
      return this.checkSdkReadiness();
    }
    return this.checkCliReadiness();
  }

  private async checkSdkReadiness(): Promise<{ ready: boolean; version?: string; error?: string }> {
    if (this.createSdkSession !== createKimiSdkSession) {
      return { ready: true, version: "injected-sdk-session" };
    }

    const kimiHome = mkdtempSync(join(tmpdir(), "kimi-sdk-readiness-"));
    const context: AgentRunContext = {
      model: process.env.KIMI_MODEL_NAME ?? this.defaultModel,
      apiKey: process.env.KIMI_MODEL_API_KEY ?? "",
      baseUrl: process.env.KIMI_MODEL_BASE_URL ?? "",
      provider: process.env.KIMI_MODEL_PROVIDER_ID ?? "kimi",
    };
    const env = this.buildKimiEnv(context, kimiHome);
    this.writeKimiConfig(context, kimiHome);
    const client = new KimiSdkProtocolClient();
    const timeoutMs = Number.parseInt(process.env.KIMI_AGENT_SDK_READINESS_TIMEOUT_MS ?? "5000", 10);
    let timeout: ReturnType<typeof setTimeout> | null = null;

    try {
      const start = client.start({
        workDir: process.cwd(),
        model: context.model,
        executablePath: this.sdkExecutable,
        environmentVariables: env as Record<string, string>,
        externalTools: [],
        clientInfo: { name: "homerail-worker", version: "0.1.0" },
      });
      const result = await Promise.race([
        start,
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => {
            reject(new Error(`Kimi Agent SDK initialize timed out after ${timeoutMs}ms`));
          }, timeoutMs);
        }),
      ]);
      return {
        ready: true,
        version: `${result.server.name}/${result.server.version}`,
      };
    } catch (err) {
      return {
        ready: false,
        error:
          "Kimi Agent SDK executable is not available or does not support --work-dir --wire. " +
          "Configure KIMI_AGENT_SDK_EXECUTABLE to a Kimi Agent SDK-compatible kimi CLI/binary. " +
          `Executable: ${this.sdkExecutable}. Error: ${err instanceof Error ? err.message : String(err)}`,
      };
    } finally {
      if (timeout) clearTimeout(timeout);
      await client.stop().catch(() => {
        // Best effort after failed initialize.
      });
      try {
        rmSync(kimiHome, { recursive: true, force: true });
      } catch {
        // Best-effort cleanup.
      }
    }
  }

  private async checkCliReadiness(): Promise<{ ready: boolean; version?: string; error?: string }> {
    return new Promise((resolve) => {
      let child: ChildProcess;
      try {
        child = this.spawnKimi(["--version"], {
          stdio: ["pipe", "pipe", "pipe"],
          env: sanitizedAgentChildEnv(),
        });
      } catch (err) {
        resolve({
          ready: false,
          error:
            "kimi binary not found. " +
            "Install: npm install -g @moonshot-ai/kimi-code (requires Node >= 22.19.0). " +
            `Command: ${this.kimiCommand.displayName}. Error: ${err instanceof Error ? err.message : String(err)}`,
        });
        return;
      }

      let stdout = "";
      let stderr = "";
      let settled = false;

      const finish = (result: { ready: boolean; version?: string; error?: string }): void => {
        if (settled) return;
        settled = true;
        resolve(result);
      };

      child.stdout!.on("data", (data: Buffer) => {
        stdout += data.toString("utf-8");
      });

      child.stderr!.on("data", (data: Buffer) => {
        stderr += data.toString("utf-8");
      });

      child.on("close", (code) => {
        if (code === 0) {
          finish({ ready: true, version: stdout.trim() || "unknown" });
        } else {
          finish({
            ready: false,
            error:
              "kimi binary not found or not working. " +
              "Install: npm install -g @moonshot-ai/kimi-code (requires Node >= 22.19.0). " +
              `Command: ${this.kimiCommand.displayName}. Exit code: ${code}, stderr: ${stderr.trim() || "none"}`,
          });
        }
      });

      child.on("error", (err) => {
        finish({
          ready: false,
          error:
            "kimi binary not found. " +
            "Install: npm install -g @moonshot-ai/kimi-code (requires Node >= 22.19.0). " +
            `Command: ${this.kimiCommand.displayName}. Error: ${err.message}`,
        });
      });
    });
  }

  async resume(sessionId: string): Promise<AgentRunContext | null> {
    throw new Error(
      `Kimi Code transcript resume is not implemented for session ${sessionId}; ` +
      "use DAG checkpoint resume so the resume instruction is injected into the next worker prompt.",
    );
  }

  private async executeTool(
    toolMap: Map<string, DagToolDefinition>,
    name: string,
    input: Record<string, unknown>,
    toolCallId?: string,
  ): Promise<{ content: string; is_error?: boolean }> {
    const def = toolMap.get(name);
    if (!def) {
      return { content: `Unknown tool: ${name}`, is_error: true };
    }
    try {
      const result = await def.handler(input, toolCallId ? { tool_call_id: toolCallId } : undefined);
      return {
        content: result.content.map((block) => block.text).join(""),
        is_error: result.is_error === true,
      };
    } catch (err) {
      return { content: `Tool ${name} threw: ${err}`, is_error: true };
    }
  }

  private async createToolMcpBridge(
    tools: DagToolDefinition[],
    toolMap: Map<string, DagToolDefinition>,
    kimiHome: string,
  ): Promise<KimiToolMcpBridge> {
    const token = randomUUID();
    const server = createServer(async (req, res) => {
      await this.handleMcpBridgeRequest(req, res, token, toolMap);
    });
    const address = await listenOnLoopback(server);
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const scriptPath = join(kimiHome, "homerail-tools-mcp-server.mjs");
    writeFileSync(
      scriptPath,
      buildMcpProxyScript(toMcpToolDescriptors(tools)),
      { encoding: "utf-8", mode: 0o700 },
    );
    try {
      chmodSync(scriptPath, 0o700);
    } catch {
      // Best effort; the temp home is not shared and is removed after the run.
    }

    return {
      servers: [{
        name: "homerail-tools",
        command: process.execPath,
        args: [scriptPath],
        env: [
          { name: "HOMERAIL_MCP_BRIDGE_URL", value: baseUrl },
          { name: "HOMERAIL_MCP_BRIDGE_TOKEN", value: token },
        ],
      }],
      close: () => closeHttpServer(server),
    };
  }

  private async handleMcpBridgeRequest(
    req: IncomingMessage,
    res: ServerResponse,
    token: string,
    toolMap: Map<string, DagToolDefinition>,
  ): Promise<void> {
    if (req.method !== "POST" || req.url !== "/tool") {
      writeJsonResponse(res, 404, { error: "not_found" });
      return;
    }

    if (req.headers.authorization !== `Bearer ${token}`) {
      writeJsonResponse(res, 403, { error: "forbidden" });
      return;
    }

    try {
      const body = await readJsonRequest(req);
      const name = typeof body.name === "string" ? body.name : "";
      const args = body.args && typeof body.args === "object" && !Array.isArray(body.args)
        ? body.args as Record<string, unknown>
        : {};
      const result = await this.executeTool(
        toolMap,
        name,
        args,
        typeof body.tool_call_id === "string" ? body.tool_call_id : undefined,
      );
      writeJsonResponse(res, 200, result);
    } catch (err) {
      writeJsonResponse(res, 500, {
        content: err instanceof Error ? err.message : String(err),
        is_error: true,
      });
    }
  }
}

function visiblePromptModeText(text: string, hasMarker: boolean): string {
  if (!hasMarker) return stripHomeRailPromptMarkers(text);
  const closingTags = [
    `</${HOMERAIL_PROMPT_TOOL_CALL_PROTOCOL}>`,
    `</${HOMERAIL_PROMPT_HANDOFF_PROTOCOL}>`,
  ];
  let boundary = 0;
  for (const tag of closingTags) {
    const index = text.lastIndexOf(tag);
    if (index >= 0) boundary = Math.max(boundary, index + tag.length);
  }
  return stripHomeRailPromptMarkers(text.slice(boundary));
}

function toMcpToolDescriptors(tools: DagToolDefinition[]): KimiMcpToolDescriptor[] {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: normalizeJsonSchema(tool.input_schema),
  }));
}

function normalizeJsonSchema(schema: Record<string, unknown>): Record<string, unknown> {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    return { type: "object", properties: {} };
  }
  return schema;
}

function listenOnLoopback(server: Server): Promise<AddressInfo> {
  return new Promise((resolve, reject) => {
    const onError = (err: Error): void => {
      server.off("listening", onListening);
      reject(err);
    };
    const onListening = (): void => {
      server.off("error", onError);
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("MCP bridge did not bind to a TCP port"));
        return;
      }
      resolve(address);
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(0, "127.0.0.1");
  });
}

function closeHttpServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
  });
}

function readJsonRequest(req: IncomingMessage, maxBytes = 1_000_000): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let body = "";
    let settled = false;
    const fail = (err: Error): void => {
      if (settled) return;
      settled = true;
      reject(err);
    };
    req.on("data", (chunk: Buffer) => {
      body += chunk.toString("utf-8");
      if (body.length > maxBytes) {
        fail(new Error("request body too large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      if (settled) return;
      settled = true;
      try {
        const parsed = JSON.parse(body || "{}");
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          reject(new Error("request body must be a JSON object"));
          return;
        }
        resolve(parsed as Record<string, unknown>);
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
    req.on("error", (err) => fail(err));
  });
}

function writeJsonResponse(res: ServerResponse, status: number, body: Record<string, unknown>): void {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(body));
}

export const _kimiSpawnOptionsForTest = hideWindowsConsole;

function parseSdkToolArguments(args: string | undefined): Record<string, unknown> {
  if (!args) return {};
  try {
    const parsed = JSON.parse(args);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function sdkToolOutputToString(output: unknown): string {
  if (typeof output === "string") return output;
  if (!Array.isArray(output)) return output === undefined ? "" : JSON.stringify(output);
  return output.map((part) => {
    if (typeof part === "string") return part;
    if (part && typeof part === "object" && !Array.isArray(part)) {
      const record = part as Record<string, unknown>;
      if (record.type === "text" && typeof record.text === "string") return record.text;
      if (record.type === "think" && typeof record.think === "string") return record.think;
      return `[${String(record.type ?? "content")}]`;
    }
    return "";
  }).filter(Boolean).join("\n");
}

function toolEventKey(name: string, input: Record<string, unknown>): string {
  return `${name}:${stableStringify(input)}`;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(",")}}`;
}

function buildMcpProxyScript(tools: KimiMcpToolDescriptor[]): string {
  return `#!/usr/bin/env node
import { createInterface } from "node:readline";

const TOOLS = ${JSON.stringify(tools)};
const BRIDGE_URL = process.env.HOMERAIL_MCP_BRIDGE_URL;
const BRIDGE_TOKEN = process.env.HOMERAIL_MCP_BRIDGE_TOKEN;
const rl = createInterface({ input: process.stdin });

function write(message) {
  process.stdout.write(JSON.stringify(message) + "\\n");
}

function result(id, value) {
  write({ jsonrpc: "2.0", id, result: value });
}

function error(id, code, message) {
  write({ jsonrpc: "2.0", id, error: { code, message } });
}

async function callTool(name, args, toolCallId) {
  if (!BRIDGE_URL || !BRIDGE_TOKEN) {
    return { content: "HomeRail MCP bridge is not configured", is_error: true };
  }
  const response = await fetch(BRIDGE_URL + "/tool", {
    method: "POST",
    headers: {
      "authorization": "Bearer " + BRIDGE_TOKEN,
      "content-type": "application/json"
    },
    body: JSON.stringify({
      name,
      args: args && typeof args === "object" ? args : {},
      tool_call_id: String(toolCallId)
    })
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok) {
    return {
      content: typeof json.error === "string" ? json.error : "HomeRail MCP bridge request failed",
      is_error: true
    };
  }
  return json;
}

rl.on("line", async (line) => {
  if (!line.trim()) return;
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    error(null, -32700, "Parse error");
    return;
  }
  const id = request.id;
  try {
    switch (request.method) {
      case "initialize":
        result(id, {
          protocolVersion: request.params?.protocolVersion || "2024-11-05",
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "homerail-tools", version: "0.1.0" }
        });
        break;
      case "notifications/initialized":
        break;
      case "ping":
        result(id, {});
        break;
      case "tools/list":
        result(id, { tools: TOOLS });
        break;
      case "tools/call": {
        const name = String(request.params?.name || "");
        const args = request.params?.arguments ?? request.params?.args ?? {};
        const toolResult = await callTool(name, args, id);
        result(id, {
          content: [{ type: "text", text: String(toolResult.content ?? "") }],
          isError: toolResult.is_error === true || toolResult.isError === true
        });
        break;
      }
      default:
        error(id, -32601, "Method not found: " + request.method);
    }
  } catch (err) {
    error(id, -32000, err instanceof Error ? err.message : String(err));
  }
});
`;
}

/**
 * Create an async iterable that yields complete lines from a child process stdout.
 * Also collects stderr and exit code for later retrieval.
 */
function createLineIterator(childProcess: ChildProcess): {
  [Symbol.asyncIterator](): AsyncIterableIterator<string>;
  getStderr(): string;
  getExitCode(): Promise<number | null>;
} {
  let stderrOutput = "";
  let exitCode: number | null | undefined;
  let exitResolve: ((code: number | null) => void) | null = null;
  const exitPromise = new Promise<number | null>((resolve) => {
    exitResolve = resolve;
  });

  // Collect stderr
  childProcess.stderr!.on("data", (data: Buffer) => {
    stderrOutput = `${stderrOutput}${data.toString("utf-8")}`.slice(-4000);
  });

  childProcess.on("close", (code) => {
    exitCode = code;
    exitResolve?.(code);
  });

  childProcess.on("error", () => {
    exitResolve?.(-1);
  });

  return {
    [Symbol.asyncIterator]() {
      let lineBuffer = "";
      let lineResolve: ((line: string | null) => void) | null = null;
      const lineQueue: (string | null)[] = [];
      let done = false;

      const enqueue = (item: string | null): void => {
        if (lineResolve) {
          const resolve = lineResolve;
          lineResolve = null;
          resolve(item);
        } else {
          lineQueue.push(item);
        }
      };

      childProcess.stdout!.on("data", (data: Buffer) => {
        lineBuffer += data.toString("utf-8");
        const lines = lineBuffer.split("\n");
        lineBuffer = lines.pop() || "";
        for (const line of lines) {
          enqueue(line);
        }
      });

      childProcess.stdout!.on("end", () => {
        if (lineBuffer) {
          enqueue(lineBuffer);
          lineBuffer = "";
        }
        done = true;
        enqueue(null);
      });

      childProcess.on("error", () => {
        done = true;
        enqueue(null);
      });

      return {
        async next(): Promise<IteratorResult<string>> {
          if (lineQueue.length > 0) {
            const value = lineQueue.shift()!;
            if (value === null) return { done: true, value: undefined as unknown as string };
            return { done: false, value };
          }
          if (done) return { done: true, value: undefined as unknown as string };

          return new Promise<IteratorResult<string>>((resolve) => {
            lineResolve = (item: string | null) => {
              if (item === null) {
                resolve({ done: true, value: undefined as unknown as string });
              } else {
                resolve({ done: false, value: item });
              }
            };
          });
        },
        [Symbol.asyncIterator]() {
          return this;
        },
      };
    },
    getStderr(): string {
      return stderrOutput;
    },
    getExitCode(): Promise<number | null> {
      return exitPromise;
    },
  };
}

function createJsonRpcClient(childProcess: ChildProcess): {
  sendRequest(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>>;
  waitForNotification(timeoutMs: number): Promise<Record<string, unknown>>;
  getStderr(): string;
  getExitCodeNow(): number | null | undefined;
  close(): void;
} {
  let requestId = 0;
  let stderrOutput = "";
  let exitCode: number | null | undefined;
  const pending = new Map<number, PendingRequest>();
  const notifications: Array<Record<string, unknown>> = [];
  const waiters: Array<() => void> = [];
  const rl: ReadlineInterface = createInterface({ input: childProcess.stdout! });

  childProcess.stderr!.on("data", (data: Buffer) => {
    stderrOutput = `${stderrOutput}${data.toString("utf-8")}`.slice(-4000);
  });

  childProcess.on("close", (code) => {
    exitCode = code;
    for (const [id, pendingRequest] of pending) {
      clearTimeout(pendingRequest.timer);
      pendingRequest.reject(new Error(`kimi acp exited before JSON-RPC response id=${id}`));
    }
    pending.clear();
    const ready = waiters.splice(0);
    for (const waiter of ready) waiter();
  });

  childProcess.on("error", (err) => {
    for (const [id, pendingRequest] of pending) {
      clearTimeout(pendingRequest.timer);
      pendingRequest.reject(new Error(`kimi acp process error before JSON-RPC response id=${id}: ${err.message}`));
    }
    pending.clear();
  });

  rl.on("line", (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let parsed: JsonRpcResponse | AcpNotification;
    try {
      parsed = JSON.parse(trimmed) as JsonRpcResponse | AcpNotification;
    } catch {
      notifications.push({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: trimmed },
          },
        },
      });
      const ready = waiters.splice(0);
      for (const waiter of ready) waiter();
      return;
    }

    if ("method" in parsed) {
      notifications.push(parsed as unknown as Record<string, unknown>);
      const ready = waiters.splice(0);
      for (const waiter of ready) waiter();
      return;
    }

    const pendingRequest = pending.get(parsed.id);
    if (!pendingRequest) return;
    clearTimeout(pendingRequest.timer);
    pending.delete(parsed.id);
    if (parsed.error) {
      pendingRequest.reject(new Error(`JSON-RPC error ${parsed.error.code}: ${parsed.error.message}`));
    } else {
      pendingRequest.resolve(parsed.result ?? {});
    }
  });

  return {
    sendRequest(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
      if (!childProcess.stdin) {
        return Promise.reject(new Error("kimi acp process stdin is unavailable"));
      }
      const id = ++requestId;
      childProcess.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`JSON-RPC request ${method} (id=${id}) timed out`));
        }, 60_000);
        pending.set(id, { resolve, reject, timer });
      });
    },
    waitForNotification(timeoutMs: number): Promise<Record<string, unknown>> {
      if (notifications.length > 0) return Promise.resolve(notifications.shift()!);
      if (exitCode !== undefined) {
        return Promise.reject(new Error(`kimi acp exited with code ${exitCode}`));
      }
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          const idx = waiters.indexOf(waiter);
          if (idx >= 0) waiters.splice(idx, 1);
          reject(new Error("Notification wait timed out"));
        }, timeoutMs);
        const waiter = () => {
          clearTimeout(timer);
          if (notifications.length > 0) {
            resolve(notifications.shift()!);
          } else {
            reject(new Error(`kimi acp exited with code ${exitCode}`));
          }
        };
        waiters.push(waiter);
      });
    },
    getStderr(): string {
      return stderrOutput;
    },
    getExitCodeNow(): number | null | undefined {
      return exitCode;
    },
    close(): void {
      try {
        rl.close();
      } catch {
        // ignore
      }
      try {
        childProcess.stdin?.destroy();
        childProcess.stdout?.destroy();
        childProcess.stderr?.destroy();
      } catch {
        // ignore
      }
      if (childProcess.exitCode === null && !childProcess.killed) {
        childProcess.kill("SIGTERM");
        setTimeout(() => {
          if (childProcess.exitCode === null && !childProcess.killed) {
            childProcess.kill("SIGKILL");
          }
        }, 2_000).unref?.();
      }
    },
  };
}

function normalizeAcpToolInput(update: Record<string, unknown>): Record<string, unknown> {
  const raw = update.rawInput;
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    return raw as Record<string, unknown>;
  }
  const fromContent = stringifyAcpContent(update.content);
  if (!fromContent) return {};
  try {
    const parsed = JSON.parse(fromContent);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function stringifyAcpContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((entry) => {
    if (!entry || typeof entry !== "object") return "";
    const maybeContent = (entry as Record<string, unknown>).content;
    if (typeof maybeContent === "string") return maybeContent;
    if (maybeContent && typeof maybeContent === "object") {
      const text = (maybeContent as Record<string, unknown>).text;
      if (typeof text === "string") return text;
    }
    return "";
  }).join("");
}
