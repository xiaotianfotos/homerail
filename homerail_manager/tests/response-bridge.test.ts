import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  handoffActiveRun: vi.fn(),
  getActiveRun: vi.fn(),
  getDagActorByNode: vi.fn(),
  getDagActorCommand: vi.fn(),
  getDagActorLiveCommand: vi.fn(),
  acquireDagActorLease: vi.fn(),
  assessDagActorLease: vi.fn(),
  recordAttemptDiagnostic: vi.fn(),
  isReviewEvidenceNode: vi.fn(),
}));

vi.mock("../src/runtime/active-runs.js", () => ({
  handoffActiveRun: mocks.handoffActiveRun,
  getActiveRun: mocks.getActiveRun,
  isReviewEvidenceNode: mocks.isReviewEvidenceNode,
}));

vi.mock("../src/persistence/dag-actors.js", () => ({
  getDagActorByNode: mocks.getDagActorByNode,
  getDagActorCommand: mocks.getDagActorCommand,
}));

vi.mock("../src/persistence/dag-actor-live-commands.js", () => ({
  getDagActorLiveCommand: mocks.getDagActorLiveCommand,
}));

vi.mock("../src/persistence/dag-actor-leases.js", () => ({
  acquireDagActorLease: mocks.acquireDagActorLease,
  assessDagActorLease: mocks.assessDagActorLease,
}));

vi.mock("../src/persistence/dag-review-evidence.js", () => ({
  recordAttemptDiagnostic: mocks.recordAttemptDiagnostic,
}));

import { applyResponseHandoff } from "../src/orchestration/response-bridge.js";

const source = { targetType: "worker", targetId: "worker-1" } as const;

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
    mocks.getDagActorLiveCommand.mockReset();
    mocks.getDagActorLiveCommand.mockReturnValue(undefined);
    mocks.assessDagActorLease.mockReset();
    mocks.assessDagActorLease.mockReturnValue({ current: true, lease: {} });
    mocks.acquireDagActorLease.mockReset();
    mocks.recordAttemptDiagnostic.mockReset();
    mocks.isReviewEvidenceNode.mockReset();
    mocks.isReviewEvidenceNode.mockReturnValue(false);
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
      lease_generation: 7,
      command_id: "command-2",
    };

    expect(applyResponseHandoff(payload, source)).toEqual({
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
        leaseGeneration: 7,
        commandId: "command-2",
      },
    );
  });

  it("accepts a v2 first-round payload without a command id", () => {
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
      content: "first round",
      round_id: "round-0001",
      actor_id: "legacy-node",
      generation: 1,
      lease_generation: 1,
    }, source);

    expect(mocks.handoffActiveRun).toHaveBeenCalledWith(
      "run-1",
      "legacy-node",
      "done",
      "first round",
      {
        transport: true,
        roundId: "round-0001",
        actorId: "legacy-node",
        generation: 1,
        leaseGeneration: 1,
      },
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
      lease_generation: 1,
    }, source)).toEqual({
      status: "malformed_payload",
      reason: "generation must be a positive safe integer",
    });
    expect(mocks.handoffActiveRun).not.toHaveBeenCalled();
  });

  it("rejects a missing v2 lease generation before applying a handoff", () => {
    expect(applyResponseHandoff({
      runId: "run-2",
      nodeId: "actor-node",
      port: "done",
      content: "missing lease",
      round_id: "round-0002",
      actor_id: "actor-1",
      generation: 3,
      command_id: "command-2",
    }, source)).toMatchObject({
      status: "malformed_payload",
      reason: "lease_generation must be a positive safe integer",
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
      lease_generation: 7,
      command_id: "command-2",
    }, source)).toMatchObject({ status: "handoff_ignored", disposition: "stale" });

    expect(applyResponseHandoff({
      runId: "run-2",
      nodeId: "actor-node",
      port: "done",
      content: "late generation",
      round_id: "round-0002",
      actor_id: "actor-1",
      generation: 2,
      lease_generation: 7,
      command_id: "command-2",
    }, source)).toMatchObject({
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
      lease_generation: 7,
      command_id: "command-2",
    }, source)).toMatchObject({
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
      content: "first round duplicate",
      round_id: "round-0001",
      actor_id: "actor-1",
      generation: 3,
      lease_generation: 7,
    }, source)).toMatchObject({
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
      lease_generation: 7,
      command_id: "command-2",
    }, source)).toEqual({
      status: "handoff_failed",
      runId: "run-2",
      nodeId: "actor-node",
      reason: "DAG_HANDOFF_CONTRACT_VIOLATION actor-node.done",
      rejectedHandoff: { port: "done", content: { invalid: true } },
    });
    expect(mocks.handoffActiveRun).toHaveBeenCalledTimes(1);
  });

  it("passes bounded transport diagnostics and content evidence to the applied handoff", () => {
    const payload = {
      runId: "run-2",
      nodeId: "actor-node",
      port: "done",
      content: {
        reviewer: "qwen",
        status: "complete",
        evidence: {
          schema: "review-evidence-v1",
          reviewer: "qwen",
          findings: [{
            category: "security",
            severity: "high",
            title: "Unchecked response",
            file: "src/app.ts",
            line: 12,
            evidence: "fetch('/api') is not awaited",
            recommendation: "Await and validate",
            confidence: "high",
          }],
        },
      },
      round_id: "round-0002",
      actor_id: "actor-1",
      generation: 3,
      lease_generation: 7,
      command_id: "command-2",
      attempt_diagnostics: {
        finish_reason: "end_turn",
        output_tokens: 321,
        output_token_limit: 4096,
        tool_argument_parse_state: "valid",
        contract_stage: "tool_arguments",
        failure_category: "accepted",
      },
    };

    expect(applyResponseHandoff(payload, source)).toMatchObject({ status: "handoff_applied" });
    expect(mocks.handoffActiveRun).toHaveBeenCalledWith(
      "run-2",
      "actor-node",
      "done",
      payload.content,
      {
        transport: true,
        roundId: "round-0002",
        actorId: "actor-1",
        generation: 3,
        leaseGeneration: 7,
        commandId: "command-2",
      },
      expect.objectContaining({
        transportDiagnostic: expect.objectContaining({ finish_reason: "end_turn" }),
        submission: expect.objectContaining({
          schema: "review-evidence-v1",
          reviewer: "qwen",
          findings: [expect.objectContaining({ title: "Unchecked response" })],
        }),
      }),
    );
  });

  it("persists a classified contract diagnostic for review evidence nodes on handoff failure", () => {
    mocks.isReviewEvidenceNode.mockReturnValue(true);
    mocks.getActiveRun.mockReturnValue({
      status: "active",
      currentRound: { round_id: "round-0002", ordinal: 2 },
      dagRun: { handoffedNodes: new Set<string>() },
      nodeSessions: new Map([["actor-node", { sessionId: "session-9", attempt: 1 }]]),
      counters: { corrections: {} },
    });
    mocks.handoffActiveRun.mockImplementation(() => {
      throw new Error("DAG_HANDOFF_CONTRACT_VIOLATION actor-node.done");
    });

    const result = applyResponseHandoff({
      runId: "run-2",
      nodeId: "actor-node",
      port: "done",
      content: { incomplete: true },
      round_id: "round-0002",
      actor_id: "actor-1",
      generation: 3,
      lease_generation: 7,
      command_id: "command-2",
      attempt_diagnostics: {
        finish_reason: "end_turn",
        output_tokens: 123,
        tool_argument_parse_state: "valid",
        contract_stage: "tool_arguments",
        failure_category: "accepted",
      },
    }, source);

    expect(result).toMatchObject({
      status: "handoff_failed",
      reason: "DAG_HANDOFF_CONTRACT_VIOLATION actor-node.done",
    });
    expect(mocks.recordAttemptDiagnostic).toHaveBeenCalledWith(expect.objectContaining({
      identity: expect.objectContaining({
        runId: "run-2",
        reviewer: "actor-1",
        nodeId: "actor-node",
        sessionId: "session-9",
        roundId: "round-0002",
        generation: 3,
        attempt: 1,
      }),
      diagnostic: expect.objectContaining({
        finish_reason: "end_turn",
        output_tokens: 123,
        failure_category: "contract_validation_failed",
        contract_stage: "contract_validation",
      }),
    }));
  });

  it("never persists diagnostics or touches handoff state for stale evidence payloads", () => {
    mocks.isReviewEvidenceNode.mockReturnValue(true);
    mocks.getActiveRun.mockReturnValue({
      status: "active",
      currentRound: { round_id: "round-0002", ordinal: 2 },
      dagRun: { handoffedNodes: new Set<string>() },
      nodeSessions: new Map([["actor-node", { sessionId: "session-9", attempt: 1 }]]),
      counters: { corrections: {} },
    });

    expect(applyResponseHandoff({
      runId: "run-2",
      nodeId: "actor-node",
      port: "done",
      content: {
        reviewer: "qwen",
        status: "complete",
        evidence: {
          schema: "review-evidence-v1",
          reviewer: "qwen",
          findings: [{
            category: "security",
            severity: "high",
            title: "Stale finding",
            file: "src/app.ts",
            line: 12,
            evidence: "must never overwrite the current projection",
            recommendation: "ignore stale transport payloads",
            confidence: "high",
          }],
        },
      },
      round_id: "round-0001",
      actor_id: "actor-1",
      generation: 3,
      lease_generation: 7,
      command_id: "command-2",
      attempt_diagnostics: {
        finish_reason: "max_tokens",
        output_tokens: 900,
      },
    }, source)).toMatchObject({ status: "handoff_ignored", disposition: "stale" });
    expect(mocks.recordAttemptDiagnostic).not.toHaveBeenCalled();
    expect(mocks.handoffActiveRun).not.toHaveBeenCalled();
  });

  it("rejects a lease that belongs to a different physical source", () => {
    mocks.assessDagActorLease.mockReturnValue({ current: false, reason: "target_mismatch" });

    expect(applyResponseHandoff({
      runId: "run-2",
      nodeId: "actor-node",
      port: "done",
      content: "forged source",
      round_id: "round-0002",
      actor_id: "actor-1",
      generation: 3,
      lease_generation: 7,
      command_id: "command-2",
    }, source)).toMatchObject({
      status: "handoff_ignored",
      disposition: "invalid",
      reason: expect.stringContaining("DAG_TRANSPORT_LEASE_TARGET_MISMATCH"),
    });
    expect(mocks.handoffActiveRun).not.toHaveBeenCalled();
  });

  it("renews an exact expired lease before accepting an active-run result", () => {
    mocks.assessDagActorLease
      .mockReturnValueOnce({
        current: false,
        reason: "expired",
        lease: {
          state: "leased",
          lease_generation: 7,
          target_type: "worker",
          target_id: "worker-1",
          version: 11,
        },
      })
      .mockReturnValueOnce({ current: true, lease: { version: 12 } });

    expect(applyResponseHandoff({
      runId: "run-2",
      nodeId: "actor-node",
      port: "done",
      content: "completed after a scheduler pause",
      round_id: "round-0002",
      actor_id: "actor-1",
      generation: 3,
      lease_generation: 7,
      command_id: "command-2",
    }, source)).toMatchObject({ status: "handoff_applied" });
    expect(mocks.acquireDagActorLease).toHaveBeenCalledWith({
      run_id: "run-2",
      actor_id: "actor-1",
      target_type: "worker",
      target_id: "worker-1",
      expected_version: 11,
    });
  });

  it("does not revive an expired lease for a waiting run", () => {
    mocks.getActiveRun.mockReturnValue({
      status: "waiting",
      currentRound: { round_id: "round-0002", ordinal: 2 },
      dagRun: { handoffedNodes: new Set<string>() },
    });
    mocks.assessDagActorLease.mockReturnValue({
      current: false,
      reason: "expired",
      lease: { version: 11 },
    });

    expect(applyResponseHandoff({
      runId: "run-2",
      nodeId: "actor-node",
      port: "done",
      content: "late waiting result",
      round_id: "round-0002",
      actor_id: "actor-1",
      generation: 3,
      lease_generation: 7,
      command_id: "command-2",
    }, source)).toMatchObject({
      status: "handoff_ignored",
      disposition: "stale",
      reason: expect.stringContaining("DAG_TRANSPORT_LEASE_EXPIRED"),
    });
    expect(mocks.acquireDagActorLease).not.toHaveBeenCalled();
  });
});
