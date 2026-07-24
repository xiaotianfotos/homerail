import { type ChildProcess, spawn } from "node:child_process";
import { createInterface, type Interface as ReadlineInterface } from "node:readline";
import {
  codexBinaryNotFoundMessage,
  resolveCodexBinary,
} from "./codex-binary.js";
import { managerAgentChildEnv } from "./host-codex-manager-agent.js";

interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

interface PendingRequest {
  resolve: (result: Record<string, unknown>) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface CodexAppServerMessage {
  jsonrpc?: string;
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: JsonRpcError;
}

export interface CodexAppServerClientOptions {
  codexBin?: string;
  args?: string[];
  cwd: string;
  env?: Record<string, string | undefined>;
  requestTimeoutMs?: number;
}

export class CodexAppServerClient {
  private child: ChildProcess | null = null;
  private readline: ReadlineInterface | null = null;
  private requestId = 0;
  private pending = new Map<number, PendingRequest>();
  private listeners = new Set<(message: CodexAppServerMessage) => void>();
  private closing = false;
  private readonly requestTimeoutMs: number;
  private readonly options: CodexAppServerClientOptions;

  constructor(options: CodexAppServerClientOptions) {
    this.options = options;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
  }

  onMessage(listener: (message: CodexAppServerMessage) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async start(): Promise<void> {
    if (this.child) return;
    const requested = this.options.codexBin
      ?? process.env.HOMERAIL_CODEX_BIN
      ?? process.env.CODEX_BIN_PATH
      ?? "codex";
    const resolved = resolveCodexBinary(requested);
    if (!resolved) throw new Error(codexBinaryNotFoundMessage(requested));

    this.closing = false;
    this.child = spawn(
      resolved.command,
      this.options.args ?? ["app-server"],
      {
        cwd: this.options.cwd,
        env: {
          ...managerAgentChildEnv(),
          ...this.options.env,
        },
        stdio: ["pipe", "pipe", "pipe"],
        shell: resolved.needsShell,
        windowsHide: true,
      },
    );
    this.child.once("error", (error) => {
      if (!this.closing) this.fail(`Codex app-server process error: ${error.message}`);
    });
    this.child.once("exit", (code) => {
      if (!this.closing) this.fail(`Codex app-server exited with code ${code ?? "unknown"}`);
    });
    if (!this.child.stdout || !this.child.stdin) {
      this.close();
      throw new Error("Codex app-server did not expose stdio");
    }
    // Drain diagnostics without forwarding them to application logs. Besides
    // preventing pipe backpressure, this keeps auth and upstream error details
    // out of the browser-facing Live Voice event stream.
    this.child.stderr?.on("data", () => undefined);
    this.readline = createInterface({ input: this.child.stdout });
    this.readline.on("line", (line) => this.handleLine(line));
  }

  async initialize(): Promise<Record<string, unknown>> {
    const result = await this.request("initialize", {
      clientInfo: {
        name: "homerail-manager",
        title: "HomeRail Manager",
        version: "0.1.0",
      },
      capabilities: {
        experimentalApi: true,
        optOutNotificationMethods: ["thread/realtime/outputAudio/delta"],
      },
    });
    this.notify("initialized", {});
    return result;
  }

  request(
    method: string,
    params: Record<string, unknown>,
    timeoutMs = this.requestTimeoutMs,
  ): Promise<Record<string, unknown>> {
    if (!this.child?.stdin) return Promise.reject(new Error("Codex app-server is not running"));
    const id = ++this.requestId;
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex app-server request timed out: ${method}`));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
    });
  }

  notify(method: string, params: Record<string, unknown>): void {
    if (!this.child?.stdin) return;
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
  }

  respond(id: number | string, result: Record<string, unknown>): void {
    if (!this.child?.stdin) return;
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
  }

  respondError(id: number | string, code: number, message: string): void {
    if (!this.child?.stdin) return;
    this.child.stdin.write(`${JSON.stringify({
      jsonrpc: "2.0",
      id,
      error: { code, message },
    })}\n`);
  }

  close(): void {
    if (this.closing) return;
    this.closing = true;
    try {
      this.readline?.close();
    } catch {
      // Best effort.
    }
    this.readline = null;
    try {
      this.child?.stdin?.end();
      this.child?.kill("SIGTERM");
    } catch {
      // Best effort.
    }
    this.child = null;
    this.rejectPending("Codex app-server closed");
  }

  private handleLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    let message: CodexAppServerMessage;
    try {
      message = JSON.parse(trimmed) as CodexAppServerMessage;
    } catch {
      return;
    }
    if (message.method) {
      this.emit(message);
      return;
    }
    if (typeof message.id !== "number") return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(message.id);
    if (message.error) {
      pending.reject(new Error(
        `Codex app-server JSON-RPC error ${message.error.code}: ${message.error.message}`,
      ));
    } else {
      pending.resolve(message.result ?? {});
    }
  }

  private fail(message: string): void {
    this.rejectPending(message);
    this.emit({
      jsonrpc: "2.0",
      method: "homerail/appserver/error",
      params: { message },
    });
  }

  private rejectPending(message: string): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error(message));
    }
    this.pending.clear();
  }

  private emit(message: CodexAppServerMessage): void {
    for (const listener of this.listeners) listener(message);
  }
}
