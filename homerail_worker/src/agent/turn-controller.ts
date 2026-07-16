import { isDeepStrictEqual } from "node:util";

export interface AgentTurnCapabilities {
  liveSteer: boolean;
}

export interface AgentTurnCommand {
  commandId: string;
  content: string;
  idempotencyKey?: string;
  sequence?: number;
}

export interface AgentTurnDriver {
  steer?: (command: AgentTurnCommand) => void | Promise<void>;
  interrupt?: (reason: string) => void | Promise<void>;
  close?: () => void | Promise<void>;
}

export type AgentTurnCommandFailure = {
  status: "failed";
  reason: string;
};

export type AgentTurnCommandAccepted =
  | { status: "accepted" }
  | AgentTurnCommandFailure;

export type AgentTurnCommandApplied =
  | { status: "applied" }
  | AgentTurnCommandFailure;

export type AgentTurnCommandCompleted =
  | { status: "completed" }
  | AgentTurnCommandFailure;

export interface AgentTurnSteerReceipt {
  status: "accepted";
  commandId: string;
  duplicate: boolean;
  accepted: Promise<AgentTurnCommandAccepted>;
  applied: Promise<AgentTurnCommandApplied>;
  completed: Promise<AgentTurnCommandCompleted>;
}

export interface AgentTurnSteerUnsupported {
  status: "unsupported";
  commandId: string;
  duplicate: boolean;
  reason: string;
}

export interface AgentTurnSteerRejected {
  status: "rejected";
  commandId: string;
  duplicate: boolean;
  reason: string;
}

export type AgentTurnSteerResult =
  | AgentTurnSteerReceipt
  | AgentTurnSteerUnsupported
  | AgentTurnSteerRejected;

export interface AgentTurnDriverBindingResult {
  status: "bound" | "rejected";
  reason?: string;
}

export type AgentTurnInterruptResult =
  | { status: "interrupted" }
  | { status: "rejected" | "failed"; reason: string };

export interface AgentTurnCloseOptions {
  outcome?: "completed" | "failed";
  reason?: string;
}

export interface AgentTurnCloseResult {
  status: "closed";
  driverError?: string;
}

export interface AgentTurnControllerOptions {
  capabilities: AgentTurnCapabilities;
  maxQueueSize?: number;
  unsupportedReason?: string;
  interruptFallback?: (reason: string) => void | Promise<void>;
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

interface CommandRecord {
  command: AgentTurnCommand;
  phase: "queued" | "sending" | "applied" | "terminal";
  adapterAccepted: boolean;
  accepted: Deferred<AgentTurnCommandAccepted>;
  applied: Deferred<AgentTurnCommandApplied>;
  completed: Deferred<AgentTurnCommandCompleted>;
  receipt: AgentTurnSteerReceipt;
}

interface TerminalRecord {
  command: AgentTurnCommand;
  result: AgentTurnSteerUnsupported | AgentTurnSteerRejected;
}

type ControllerState = "open" | "interrupting" | "interrupted" | "closing" | "closed";

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function normalizeCommand(command: AgentTurnCommand): AgentTurnCommand | null {
  const commandId = command.commandId.trim();
  const idempotencyKey = command.idempotencyKey?.trim();
  if (!commandId || commandId.length > 256) return null;
  if (idempotencyKey !== undefined && (!idempotencyKey || idempotencyKey.length > 256)) return null;
  if (typeof command.content !== "string" || !command.content.trim()) return null;
  if (
    command.sequence !== undefined
    && (!Number.isSafeInteger(command.sequence) || command.sequence < 1)
  ) {
    return null;
  }
  return {
    commandId,
    content: command.content,
    ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
    ...(command.sequence === undefined ? {} : { sequence: command.sequence }),
  };
}

export function agentTurnControllerOptionsForBackend(
  backend: string,
  env: NodeJS.ProcessEnv = process.env,
): Pick<AgentTurnControllerOptions, "capabilities" | "unsupportedReason"> {
  const normalized = backend.trim().toLowerCase();
  if (normalized === "claude-sdk") {
    return { capabilities: { liveSteer: true } };
  }
  if (normalized === "kimi_code" || normalized === "kimi-code" || normalized === "kimi") {
    const configuredTransport = env.HOMERAIL_KIMI_AGENT_TRANSPORT?.trim().toLowerCase();
    const explicitlySdk = configuredTransport === "sdk"
      || configuredTransport === "agent-sdk"
      || configuredTransport === "kimi-agent-sdk";
    const explicitlyCli = configuredTransport === "cli"
      || configuredTransport === "acp"
      || configuredTransport === "kimi-code";
    const sdkTransport = explicitlySdk
      || (!explicitlyCli && Boolean(env.KIMI_AGENT_SDK_EXECUTABLE?.trim()));
    return sdkTransport
      ? { capabilities: { liveSteer: true } }
      : {
          capabilities: { liveSteer: false },
          unsupportedReason: "Kimi CLI, ACP, and prompt transports do not support live steering; use Kimi Agent SDK transport",
        };
  }
  return {
    capabilities: { liveSteer: false },
    unsupportedReason: `agent backend '${backend || "unknown"}' does not support live steering`,
  };
}

export class AgentTurnController {
  readonly capabilities: Readonly<AgentTurnCapabilities>;

  private readonly maxQueueSize: number;
  private readonly unsupportedReason: string;
  private readonly interruptFallback?: (reason: string) => void | Promise<void>;
  private readonly queue: CommandRecord[] = [];
  private readonly records = new Map<string, CommandRecord>();
  private readonly terminalRecords = new Map<string, TerminalRecord>();
  private driver: AgentTurnDriver | null = null;
  private inFlight: CommandRecord | null = null;
  private draining = false;
  private state: ControllerState = "open";
  private highestSequence = 0;
  private interruptPromise: Promise<AgentTurnInterruptResult> | null = null;
  private closePromise: Promise<AgentTurnCloseResult> | null = null;

  constructor(options: AgentTurnControllerOptions) {
    const maxQueueSize = options.maxQueueSize ?? 32;
    if (!Number.isSafeInteger(maxQueueSize) || maxQueueSize < 1) {
      throw new Error("AgentTurnController maxQueueSize must be a positive safe integer");
    }
    this.capabilities = Object.freeze({ ...options.capabilities });
    this.maxQueueSize = maxQueueSize;
    this.unsupportedReason = options.unsupportedReason ?? "active agent backend does not support live steering";
    this.interruptFallback = options.interruptFallback;
  }

  get lifecycleState(): ControllerState {
    return this.state;
  }

  get pendingCount(): number {
    const sending = this.inFlight?.phase === "sending" ? 1 : 0;
    return this.queue.length + sending;
  }

  bindDriver(driver: AgentTurnDriver): AgentTurnDriverBindingResult {
    if (this.driver) {
      return { status: "rejected", reason: "agent turn driver is already bound" };
    }
    if (this.capabilities.liveSteer && typeof driver.steer !== "function") {
      return { status: "rejected", reason: "live-steer driver must implement steer()" };
    }
    if (this.state !== "open") {
      this.closeLateDriver(driver);
      return { status: "rejected", reason: `agent turn controller is ${this.state}` };
    }
    this.driver = driver;
    this.scheduleDrain();
    return { status: "bound" };
  }

  steer(command: AgentTurnCommand): AgentTurnSteerResult {
    const normalized = normalizeCommand(command);
    if (!normalized) {
      return {
        status: "rejected",
        commandId: command.commandId?.trim?.() ?? "",
        duplicate: false,
        reason: "commandId, content, or sequence is invalid",
      };
    }

    const existing = this.records.get(normalized.commandId);
    if (existing) {
      if (!isDeepStrictEqual(existing.command, normalized)) {
        return {
          status: "rejected",
          commandId: normalized.commandId,
          duplicate: true,
          reason: `command_id ${normalized.commandId} already identifies different steering content`,
        };
      }
      return { ...existing.receipt, duplicate: true };
    }
    const terminal = this.terminalRecords.get(normalized.commandId);
    if (terminal) {
      if (!isDeepStrictEqual(terminal.command, normalized)) {
        return {
          status: "rejected",
          commandId: normalized.commandId,
          duplicate: true,
          reason: `command_id ${normalized.commandId} already identifies different steering content`,
        };
      }
      return { ...terminal.result, duplicate: true };
    }

    if (!this.capabilities.liveSteer) {
      return this.rememberTerminal(normalized, {
        status: "unsupported",
        commandId: normalized.commandId,
        duplicate: false,
        reason: this.unsupportedReason,
      });
    }
    if (this.state !== "open") {
      return this.rememberTerminal(normalized, {
        status: "rejected",
        commandId: normalized.commandId,
        duplicate: false,
        reason: `agent turn controller is ${this.state}`,
      });
    }
    if (normalized.sequence !== undefined && normalized.sequence <= this.highestSequence) {
      return this.rememberTerminal(normalized, {
        status: "rejected",
        commandId: normalized.commandId,
        duplicate: false,
        reason: `live-steer sequence ${normalized.sequence} is not greater than ${this.highestSequence}`,
      });
    }
    if (this.pendingCount >= this.maxQueueSize) {
      return this.rememberTerminal(normalized, {
        status: "rejected",
        commandId: normalized.commandId,
        duplicate: false,
        reason: `live-steer queue limit ${this.maxQueueSize} reached`,
      });
    }

    const accepted = deferred<AgentTurnCommandAccepted>();
    const applied = deferred<AgentTurnCommandApplied>();
    const completed = deferred<AgentTurnCommandCompleted>();
    const receipt: AgentTurnSteerReceipt = {
      status: "accepted",
      commandId: normalized.commandId,
      duplicate: false,
      accepted: accepted.promise,
      applied: applied.promise,
      completed: completed.promise,
    };
    const record: CommandRecord = {
      command: normalized,
      phase: "queued",
      adapterAccepted: false,
      accepted,
      applied,
      completed,
      receipt,
    };
    this.records.set(normalized.commandId, record);
    if (normalized.sequence !== undefined) this.highestSequence = normalized.sequence;
    this.queue.push(record);
    this.scheduleDrain();
    return receipt;
  }

  interrupt(reason: string): Promise<AgentTurnInterruptResult> {
    if (this.interruptPromise) return this.interruptPromise;
    if (this.state !== "open") {
      return Promise.resolve({
        status: "rejected",
        reason: `agent turn controller is ${this.state}`,
      });
    }

    const normalizedReason = reason.trim() || "agent turn interrupted";
    this.state = "interrupting";
    this.failUnfinished(`turn interrupted: ${normalizedReason}`);
    this.interruptPromise = (async () => {
      try {
        if (this.driver?.interrupt) {
          await this.driver.interrupt(normalizedReason);
        } else if (this.interruptFallback) {
          await this.interruptFallback(normalizedReason);
        } else {
          throw new Error("active agent turn has no interrupt driver");
        }
        return { status: "interrupted" as const };
      } catch (error) {
        return { status: "failed" as const, reason: errorMessage(error) };
      } finally {
        if (this.state === "interrupting") this.state = "interrupted";
      }
    })();
    return this.interruptPromise;
  }

  close(options: AgentTurnCloseOptions = {}): Promise<AgentTurnCloseResult> {
    if (this.closePromise) return this.closePromise;
    const outcome = options.outcome ?? "failed";
    const reason = options.reason?.trim()
      || (outcome === "completed" ? "agent turn completed" : "agent turn closed before successful completion");
    const interrupted = this.state === "interrupting" || this.state === "interrupted";
    this.state = "closing";

    for (const record of this.records.values()) {
      if (record.phase === "terminal") continue;
      if (outcome === "completed" && !interrupted && record.phase === "applied") {
        record.phase = "terminal";
        record.completed.resolve({ status: "completed" });
      } else {
        this.failRecord(record, reason);
      }
    }
    this.queue.length = 0;

    this.closePromise = (async () => {
      let driverError: string | undefined;
      try {
        if (this.interruptPromise) await this.interruptPromise;
        await this.driver?.close?.();
      } catch (error) {
        driverError = errorMessage(error);
      } finally {
        this.state = "closed";
      }
      return {
        status: "closed" as const,
        ...(driverError ? { driverError } : {}),
      };
    })();
    return this.closePromise;
  }

  private rememberTerminal<T extends AgentTurnSteerUnsupported | AgentTurnSteerRejected>(
    command: AgentTurnCommand,
    result: T,
  ): T {
    this.terminalRecords.set(command.commandId, { command, result });
    return result;
  }

  private scheduleDrain(): void {
    if (this.draining || !this.driver || this.state !== "open") return;
    this.draining = true;
    void this.drain().finally(() => {
      this.draining = false;
      if (this.queue.length > 0 && this.driver && this.state === "open") {
        this.scheduleDrain();
      }
    });
  }

  private async drain(): Promise<void> {
    while (this.driver && this.state === "open") {
      const record = this.queue.shift();
      if (!record) return;
      if (record.phase !== "queued") continue;
      this.inFlight = record;
      record.phase = "sending";
      try {
        if (!this.driver.steer) {
          throw new Error("active agent turn driver does not implement steer()");
        }
        const send = this.driver.steer(record.command);
        record.adapterAccepted = true;
        record.accepted.resolve({ status: "accepted" });
        await send;
        if (record.phase === "sending" && this.state === "open") {
          record.phase = "applied";
          record.applied.resolve({ status: "applied" });
        } else {
          this.failRecord(record, `agent turn became ${this.state} before command was applied`);
        }
      } catch (error) {
        this.failRecord(record, `live-steer driver failed: ${errorMessage(error)}`);
      } finally {
        if (this.inFlight === record) this.inFlight = null;
      }
    }
  }

  private failUnfinished(reason: string): void {
    for (const record of this.records.values()) {
      if (record.phase !== "terminal") this.failRecord(record, reason);
    }
    this.queue.length = 0;
  }

  private failRecord(record: CommandRecord, reason: string): void {
    if (record.phase === "terminal") return;
    if (!record.adapterAccepted) {
      record.accepted.resolve({ status: "failed", reason });
    }
    if (record.phase === "queued" || record.phase === "sending") {
      record.applied.resolve({ status: "failed", reason });
    }
    record.completed.resolve({ status: "failed", reason });
    record.phase = "terminal";
  }

  private closeLateDriver(driver: AgentTurnDriver): void {
    try {
      void Promise.resolve(driver.close?.()).catch(() => {});
    } catch {
      // A late driver cannot revive a terminal controller.
    }
  }
}
