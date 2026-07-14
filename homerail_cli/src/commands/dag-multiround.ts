import type { Command } from "commander";
import type { HomeRailClient } from "../client.js";
import { getClient } from "../index.js";

interface GlobalOpts {
  baseUrl?: string;
  json?: boolean;
  requestTimeout?: number;
}

interface DagRoundRecord {
  run_id: string;
  round_id: string;
  ordinal: number;
  status: string;
  target_actor_ids: string[];
  await_node_id?: string;
  opened_at: number;
  closed_at?: number;
  expires_at?: number;
}

interface DagCommandRecord {
  command_id: string;
  run_id: string;
  actor_id: string;
  round_id: string;
  target_generation: number;
  status: string;
  idempotency_key: string;
  payload: unknown;
  created_at?: number;
  updated_at?: number;
}

interface DataResponse<T> {
  data?: T;
}

export interface SendCommandOptions {
  expectedRound: string;
  actor: string[];
  payload: string[];
  commandId?: string;
  idempotencyKey?: string;
}

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

export function parseCommandPayload(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

export function buildSendCommandBody(options: SendCommandOptions): {
  expected_round_id: string;
  commands: Array<{
    actor_id: string;
    payload: unknown;
    command_id?: string;
    idempotency_key?: string;
  }>;
} {
  const expectedRound = options.expectedRound?.trim();
  if (!expectedRound) throw new Error("--expected-round is required");
  if (options.actor.length === 0) throw new Error("At least one --actor is required");
  if (options.payload.length === 0) throw new Error("At least one --payload is required");
  if (options.actor.length !== options.payload.length) {
    throw new Error(
      `Mismatched command arguments: received ${options.actor.length} --actor value(s) and ${options.payload.length} --payload value(s)`,
    );
  }
  if (options.actor.length > 1 && (options.commandId || options.idempotencyKey)) {
    throw new Error("--command-id and --idempotency-key are only valid for a single command");
  }

  const commands = options.actor.map((rawActor, index) => {
    const actorId = rawActor.trim();
    if (!actorId) throw new Error(`--actor value ${index + 1} must not be empty`);
    return {
      actor_id: actorId,
      payload: parseCommandPayload(options.payload[index]!),
      ...(options.commandId?.trim() ? { command_id: options.commandId.trim() } : {}),
      ...(options.idempotencyKey?.trim()
        ? { idempotency_key: options.idempotencyKey.trim() }
        : {}),
    };
  });

  return { expected_round_id: expectedRound, commands };
}

export async function cmdDagRounds(
  client: HomeRailClient,
  runId: string,
  json: boolean,
): Promise<number> {
  try {
    const response = await client.get<DataResponse<{ rounds?: DagRoundRecord[] }>>(
      `/api/runs/${encodeURIComponent(runId)}/rounds`,
    );
    const rounds = response.data?.rounds;
    if (!Array.isArray(rounds)) throw new Error("Manager returned no round list");
    if (json) {
      console.log(JSON.stringify(rounds));
      return 0;
    }
    if (rounds.length === 0) {
      console.log(`Run ${runId} has no recorded rounds.`);
      return 0;
    }
    console.log(`${"ROUND".padEnd(18)} ${"#".padEnd(4)} ${"STATUS".padEnd(12)} ${"ACTORS".padEnd(24)} AWAIT NODE`);
    for (const round of rounds) {
      console.log(
        `${round.round_id.padEnd(18)} ${String(round.ordinal).padEnd(4)} ${round.status.padEnd(12)} ${round.target_actor_ids.join(",").padEnd(24)} ${round.await_node_id ?? "-"}`,
      );
    }
    return 0;
  } catch (error) {
    console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

export async function cmdDagCommands(
  client: HomeRailClient,
  runId: string,
  roundId: string | undefined,
  json: boolean,
): Promise<number> {
  try {
    const query = new URLSearchParams();
    if (roundId?.trim()) query.set("round_id", roundId.trim());
    const suffix = query.size > 0 ? `?${query.toString()}` : "";
    const response = await client.get<DataResponse<{ commands?: DagCommandRecord[] }>>(
      `/api/runs/${encodeURIComponent(runId)}/commands${suffix}`,
    );
    const commands = response.data?.commands;
    if (!Array.isArray(commands)) throw new Error("Manager returned no command list");
    if (json) {
      console.log(JSON.stringify(commands));
      return 0;
    }
    if (commands.length === 0) {
      console.log(`Run ${runId} has no recorded commands${roundId ? ` for ${roundId}` : ""}.`);
      return 0;
    }
    console.log(`${"COMMAND".padEnd(24)} ${"ROUND".padEnd(18)} ${"ACTOR".padEnd(20)} ${"STATUS".padEnd(14)} PAYLOAD`);
    for (const command of commands) {
      console.log(
        `${command.command_id.padEnd(24)} ${command.round_id.padEnd(18)} ${command.actor_id.padEnd(20)} ${command.status.padEnd(14)} ${previewPayload(command.payload)}`,
      );
    }
    return 0;
  } catch (error) {
    console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

export async function cmdDagSendCommand(
  client: HomeRailClient,
  runId: string,
  options: SendCommandOptions,
  json: boolean,
): Promise<number> {
  try {
    const body = buildSendCommandBody(options);
    const response = await client.post<DataResponse<Record<string, unknown>>>(
      `/api/runs/${encodeURIComponent(runId)}/commands`,
      body,
    );
    if (!response.data) throw new Error("Manager returned no command result");
    if (json) {
      console.log(JSON.stringify(response.data));
    } else {
      const roundId = String(response.data.round_id ?? "unknown");
      const actors = Array.isArray(response.data.actor_ids)
        ? response.data.actor_ids.join(", ")
        : body.commands.map((command) => command.actor_id).join(", ");
      const deduplicated = response.data.deduplicated === true ? " (deduplicated)" : "";
      console.log(`Run ${runId} resumed as ${roundId} for ${actors}${deduplicated}.`);
    }
    return 0;
  } catch (error) {
    console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

export async function cmdDagComplete(
  client: HomeRailClient,
  runId: string,
  expectedRound: string,
  json: boolean,
): Promise<number> {
  try {
    const roundId = expectedRound?.trim();
    if (!roundId) throw new Error("--expected-round is required");
    const response = await client.post<DataResponse<Record<string, unknown>>>(
      `/api/runs/${encodeURIComponent(runId)}/complete`,
      { expected_round_id: roundId },
    );
    if (!response.data) throw new Error("Manager returned no completion result");
    if (json) console.log(JSON.stringify(response.data));
    else console.log(`Run ${runId} completed at ${roundId}.`);
    return 0;
  } catch (error) {
    console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

export function registerDagMultiroundCommands(
  dag: Command,
  program: Command,
): void {
  dag
    .command("rounds <runId>")
    .description("List durable rounds for a multi-round DAG run")
    .action(async (runId: string) => {
      const globalOpts = program.opts<GlobalOpts>();
      process.exitCode = await cmdDagRounds(getClient(globalOpts), runId, !!globalOpts.json);
    });

  dag
    .command("commands <runId>")
    .description("List durable actor commands for a multi-round DAG run")
    .option("--round <id>", "Only commands from this round")
    .action(async (runId: string, options: { round?: string }) => {
      const globalOpts = program.opts<GlobalOpts>();
      process.exitCode = await cmdDagCommands(
        getClient(globalOpts),
        runId,
        options.round,
        !!globalOpts.json,
      );
    });

  dag
    .command("send-command <runId>")
    .description("Resume a waiting DAG run with one or more actor commands")
    .requiredOption("--expected-round <id>", "Current waiting round ID")
    .requiredOption("--actor <id>", "Target logical actor; repeat with --payload", collect, [])
    .requiredOption("--payload <json-or-string>", "Command payload; repeat with --actor", collect, [])
    .option("--command-id <id>", "Explicit ID for a single command")
    .option("--idempotency-key <key>", "Idempotency key for a single command")
    .action(async (runId: string, options: SendCommandOptions) => {
      const globalOpts = program.opts<GlobalOpts>();
      process.exitCode = await cmdDagSendCommand(
        getClient(globalOpts),
        runId,
        options,
        !!globalOpts.json,
      );
    });

  dag
    .command("complete <runId>")
    .description("Explicitly complete a DAG run at a waiting command boundary")
    .requiredOption("--expected-round <id>", "Current waiting round ID")
    .action(async (runId: string, options: { expectedRound: string }) => {
      const globalOpts = program.opts<GlobalOpts>();
      process.exitCode = await cmdDagComplete(
        getClient(globalOpts),
        runId,
        options.expectedRound,
        !!globalOpts.json,
      );
    });
}

function previewPayload(payload: unknown): string {
  const value = typeof payload === "string" ? payload : JSON.stringify(payload);
  if (value === undefined) return "undefined";
  return value.length > 80 ? `${value.slice(0, 77)}...` : value;
}
