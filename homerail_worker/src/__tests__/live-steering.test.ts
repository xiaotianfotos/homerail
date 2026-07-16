import { describe, expect, it, vi } from "vitest";
import {
  DAG_ACTOR_LIVE_COMMAND_PROTOCOL_VERSION,
  validateDagActorLiveCommandStatusMessage,
  type DagActorLiveCommandMessage,
  type DagActorLiveCommandStatusMessage,
} from "homerail-protocol";
import { AgentTurnController } from "../agent/turn-controller.js";
import {
  activePromptTransportIdentity,
  routeDagActorCommand,
  type ActivePromptLiveSteering,
} from "../live-steering.js";

const STATE_TOKEN = "a".repeat(64);

function command(overrides: Partial<DagActorLiveCommandMessage["data"]> = {}): DagActorLiveCommandMessage {
  return {
    type: "dag_actor_command",
    data: {
      schema_version: DAG_ACTOR_LIVE_COMMAND_PROTOCOL_VERSION,
      command_id: "live-command-1",
      idempotency_key: "request-1",
      sequence: 1,
      run_id: "run-1",
      node_id: "node-1",
      session_id: "session-1",
      round_id: "round-1",
      actor_id: "actor-1",
      generation: 2,
      lease_generation: 3,
      expected_state_token: STATE_TOKEN,
      payload: { instruction: "Use the new constraint" },
      ...overrides,
    },
  };
}

function active(controller: AgentTurnController): ActivePromptLiveSteering {
  return {
    identity: activePromptTransportIdentity({
      runId: "run-1",
      nodeId: "node-1",
      sessionId: "session-1",
      roundId: "round-1",
      actorId: "actor-1",
      generation: 2,
      leaseGeneration: 3,
      commandId: "dispatch-command-9",
    }),
    controller,
  };
}

function parsedStatuses(sent: string[]): DagActorLiveCommandStatusMessage[] {
  return sent.map((value) => JSON.parse(value) as DagActorLiveCommandStatusMessage);
}

describe("dag_actor_command Worker routing", () => {
  it("binds the complete active transport identity including dispatch command", () => {
    expect(activePromptTransportIdentity({
      runId: "run",
      nodeId: "node",
      sessionId: "session",
      roundId: "round",
      actorId: "actor",
      generation: 4,
      leaseGeneration: 5,
      commandId: "dispatch",
    })).toEqual({
      runId: "run",
      nodeId: "node",
      sessionId: "session",
      roundId: "round",
      actorId: "actor",
      generation: 4,
      leaseGeneration: 5,
      commandId: "dispatch",
    });
  });

  it("reports accepted, applied, then completed only after provider and turn boundaries", async () => {
    const sent: string[] = [];
    const steer = vi.fn(async () => {});
    const controller = new AgentTurnController({ capabilities: { liveSteer: true } });
    controller.bindDriver({ steer });

    const routing = routeDagActorCommand(command(), active(controller), (value) => sent.push(value));
    await vi.waitFor(() => expect(parsedStatuses(sent).map((entry) => entry.data.status)).toEqual([
      "accepted",
      "applied",
    ]));
    expect(steer).toHaveBeenCalledWith(expect.objectContaining({
      commandId: "live-command-1",
      content: "Use the new constraint",
    }));

    await controller.close({ outcome: "completed" });
    await expect(routing).resolves.toEqual({ handled: true });
    const statuses = parsedStatuses(sent);
    expect(statuses.map((entry) => entry.data.status)).toEqual(["accepted", "applied", "completed"]);
    for (const status of statuses) {
      expect(validateDagActorLiveCommandStatusMessage(status)).toEqual({ valid: true, errors: [] });
      expect(status.data).toMatchObject({
        command_id: "live-command-1",
        run_id: "run-1",
        node_id: "node-1",
        session_id: "session-1",
        round_id: "round-1",
        actor_id: "actor-1",
        generation: 2,
        lease_generation: 3,
        expected_state_token: STATE_TOKEN,
      });
    }
  });

  it.each([
    ["run_id", "stale-run"],
    ["node_id", "stale-node"],
    ["session_id", "stale-session"],
    ["round_id", "stale-round"],
    ["actor_id", "stale-actor"],
    ["generation", 99],
    ["lease_generation", 99],
  ] as const)("rejects a stale %s fence before controller submission", async (field, value) => {
    const sent: string[] = [];
    const controller = new AgentTurnController({ capabilities: { liveSteer: true } });
    const result = await routeDagActorCommand(command({ [field]: value }), active(controller), (data) => sent.push(data));

    expect(result).toMatchObject({ handled: true, reason: expect.stringContaining(`stale ${field}`) });
    expect(parsedStatuses(sent).map((entry) => entry.data.status)).toEqual(["rejected"]);
    expect(controller.pendingCount).toBe(0);
    await controller.close({ outcome: "failed", reason: "test cleanup" });
  });

  it("reports unsupported for Kimi CLI/ACP without claiming delivery", async () => {
    const sent: string[] = [];
    const controller = new AgentTurnController({
      capabilities: { liveSteer: false },
      unsupportedReason: "Kimi CLI and ACP are unsupported",
    });

    await expect(routeDagActorCommand(command(), active(controller), (data) => sent.push(data))).resolves.toMatchObject({
      handled: true,
      reason: expect.stringContaining("unsupported"),
    });
    expect(parsedStatuses(sent)).toEqual([
      expect.objectContaining({
        type: "dag_actor_command_status",
        data: expect.objectContaining({ status: "unsupported" }),
      }),
    ]);
  });

  it("reports accepted then failed when the provider rejects a send", async () => {
    const sent: string[] = [];
    const controller = new AgentTurnController({ capabilities: { liveSteer: true } });
    controller.bindDriver({ steer: async () => { throw new Error("provider rejected steering"); } });

    await routeDagActorCommand(command(), active(controller), (data) => sent.push(data));

    expect(parsedStatuses(sent).map((entry) => entry.data.status)).toEqual(["accepted", "failed"]);
    expect(parsedStatuses(sent)[1].data.reason).toContain("provider rejected steering");
  });

  it("rejects commands when no active prompt is bound", async () => {
    const sent: string[] = [];
    await expect(routeDagActorCommand(command(), null, (data) => sent.push(data))).resolves.toMatchObject({
      handled: true,
      reason: expect.stringContaining("no active prompt"),
    });
    expect(parsedStatuses(sent).map((entry) => entry.data.status)).toEqual(["rejected"]);
  });
});
