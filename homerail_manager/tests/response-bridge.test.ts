import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  handoffActiveRun: vi.fn(),
  getActiveRun: vi.fn(),
  getDagActorByNode: vi.fn(),
  getDagActorCommand: vi.fn(),
}));

vi.mock("../src/runtime/active-runs.js", () => ({
  handoffActiveRun: mocks.handoffActiveRun,
  getActiveRun: mocks.getActiveRun,
}));

vi.mock("../src/persistence/dag-actors.js", () => ({
  getDagActorByNode: mocks.getDagActorByNode,
  getDagActorCommand: mocks.getDagActorCommand,
}));

import { applyResponseHandoff } from "../src/orchestration/response-bridge.js";

describe("response bridge transport fence", () => {
  beforeEach(() => {
    mocks.handoffActiveRun.mockReset();
    mocks.handoffActiveRun.mockReturnValue({});
    mocks.getActiveRun.mockReset();
    mocks.getActiveRun.mockReturnValue({
      status: "active",
      currentRound: { round_id: "round-0002", ordinal: 2 },
      dagRun: { handoffedNodes: new Set<string>() },
    });
    mocks.getDagActorByNode.mockReset();
    mocks.getDagActorByNode.mockReturnValue({
      run_id: "run-2",
      node_id: "actor-node",
      actor_id: "actor-1",
      generation: 3,
    });
    mocks.getDagActorCommand.mockReset();
    mocks.getDagActorCommand.mockReturnValue({
      command_id: "command-2",
      run_id: "run-2",
      actor_id: "actor-1",
      round_id: "round-0002",
      target_generation: 3,
      status: "delivered",
    });
  });

  it("passes authoritative round metadata to handoffActiveRun", () => {
    const payload = {
      runId: "run-2",
      nodeId: "actor-node",
      port: "done",
      content: { ok: true },
      round_id: "round-0002",
      actor_id: "actor-1",
      generation: 3,
      command_id: "command-2",
    };

    expect(applyResponseHandoff(payload)).toEqual({
      status: "handoff_applied",
      runId: "run-2",
      nodeId: "actor-node",
      port: "done",
    });
    expect(mocks.handoffActiveRun).toHaveBeenCalledWith(
      "run-2",
      "actor-node",
      "done",
      { ok: true },
      {
        transport: true,
        roundId: "round-0002",
        actorId: "actor-1",
        generation: 3,
        commandId: "command-2",
      },
    );
  });

  it("keeps legacy first-round payloads transport-marked but unfenced", () => {
    mocks.getActiveRun.mockReturnValue({
      status: "active",
      currentRound: { round_id: "round-0001", ordinal: 1 },
      dagRun: { handoffedNodes: new Set<string>() },
    });
    mocks.getDagActorByNode.mockReturnValue({
      run_id: "run-1",
      node_id: "legacy-node",
      actor_id: "legacy-node",
      generation: 1,
    });

    applyResponseHandoff({
      runId: "run-1",
      nodeId: "legacy-node",
      port: "done",
      content: "legacy",
    });

    expect(mocks.handoffActiveRun).toHaveBeenCalledWith(
      "run-1",
      "legacy-node",
      "done",
      "legacy",
      { transport: true },
    );
  });

  it("rejects malformed transport metadata before applying a handoff", () => {
    expect(applyResponseHandoff({
      runId: "run-2",
      nodeId: "actor-node",
      port: "done",
      content: null,
      round_id: "round-0002",
      generation: 1.5,
    })).toEqual({
      status: "malformed_payload",
      reason: "generation must be a positive safe integer",
    });
    expect(mocks.handoffActiveRun).not.toHaveBeenCalled();
  });

  it("ignores a legacy unfenced response once the run reaches round two", () => {
    expect(applyResponseHandoff({
      runId: "run-2",
      nodeId: "actor-node",
      port: "done",
      content: "late round one",
    })).toMatchObject({
      status: "handoff_ignored",
      disposition: "stale",
      runId: "run-2",
      nodeId: "actor-node",
      reason: expect.stringContaining("DAG_TRANSPORT_ROUND_FENCE_MISSING"),
    });
    expect(mocks.handoffActiveRun).not.toHaveBeenCalled();
  });

  it("ignores old rounds and old actor generations before handoff mutation", () => {
    expect(applyResponseHandoff({
      runId: "run-2",
      nodeId: "actor-node",
      port: "done",
      content: "late round",
      round_id: "round-0001",
      actor_id: "actor-1",
      generation: 3,
      command_id: "command-2",
    })).toMatchObject({ status: "handoff_ignored", disposition: "stale" });

    expect(applyResponseHandoff({
      runId: "run-2",
      nodeId: "actor-node",
      port: "done",
      content: "late generation",
      round_id: "round-0002",
      actor_id: "actor-1",
      generation: 2,
      command_id: "command-2",
    })).toMatchObject({
      status: "handoff_ignored",
      disposition: "stale",
      reason: expect.stringContaining("DAG_TRANSPORT_GENERATION_STALE"),
    });
    expect(mocks.handoffActiveRun).not.toHaveBeenCalled();
  });

  it("deduplicates acknowledged commands and completed handoffs", () => {
    mocks.getDagActorCommand.mockReturnValue({
      command_id: "command-2",
      run_id: "run-2",
      actor_id: "actor-1",
      round_id: "round-0002",
      target_generation: 3,
      status: "acknowledged",
    });
    expect(applyResponseHandoff({
      runId: "run-2",
      nodeId: "actor-node",
      port: "done",
      content: "duplicate",
      round_id: "round-0002",
      actor_id: "actor-1",
      generation: 3,
      command_id: "command-2",
    })).toMatchObject({
      status: "handoff_ignored",
      disposition: "duplicate",
      reason: expect.stringContaining("DAG_TRANSPORT_COMMAND_DUPLICATE"),
    });

    mocks.getActiveRun.mockReturnValue({
      status: "active",
      currentRound: { round_id: "round-0001", ordinal: 1 },
      dagRun: { handoffedNodes: new Set(["actor-node"]) },
    });
    expect(applyResponseHandoff({
      runId: "run-2",
      nodeId: "actor-node",
      port: "done",
      content: "legacy duplicate",
    })).toMatchObject({
      status: "handoff_ignored",
      disposition: "duplicate",
      reason: expect.stringContaining("DAG_TRANSPORT_HANDOFF_DUPLICATE"),
    });
    expect(mocks.handoffActiveRun).not.toHaveBeenCalled();
  });

  it("keeps current fenced contract failures eligible for correction", () => {
    mocks.handoffActiveRun.mockImplementation(() => {
      throw new Error("DAG_HANDOFF_CONTRACT_VIOLATION actor-node.done");
    });

    expect(applyResponseHandoff({
      runId: "run-2",
      nodeId: "actor-node",
      port: "done",
      content: { invalid: true },
      round_id: "round-0002",
      actor_id: "actor-1",
      generation: 3,
      command_id: "command-2",
    })).toEqual({
      status: "handoff_failed",
      runId: "run-2",
      nodeId: "actor-node",
      reason: "DAG_HANDOFF_CONTRACT_VIOLATION actor-node.done",
    });
    expect(mocks.handoffActiveRun).toHaveBeenCalledTimes(1);
  });
});
