import { describe, expect, it } from "vitest";
import {
  DAG_ACTOR_LIVE_COMMAND_PROTOCOL_VERSION,
  managerAgentToolSpec,
  normalizeManagerAgentDagActorCommandInput,
  validateDagActorLiveCommandMessage,
  validateDagActorLiveCommandStatusMessage,
} from "../src/index.js";

const token = "a".repeat(64);

function identity() {
  return {
    schema_version: DAG_ACTOR_LIVE_COMMAND_PROTOCOL_VERSION,
    command_id: "dag-live-command-1",
    sequence: 1,
    run_id: "run-1",
    node_id: "node-1",
    session_id: "session-1",
    round_id: "round-0001",
    actor_id: "actor-1",
    generation: 1,
    lease_generation: 2,
    expected_state_token: token,
  };
}

describe("DAG Actor live-command protocol", () => {
  it("accepts a fully fenced command and bounded status", () => {
    expect(validateDagActorLiveCommandMessage({
      type: "dag_actor_command",
      data: {
        ...identity(),
        idempotency_key: "manager-turn-1",
        payload: { instruction: "change focus" },
      },
    })).toEqual({ valid: true, errors: [] });
    expect(validateDagActorLiveCommandStatusMessage({
      type: "dag_actor_command_status",
      data: { ...identity(), status: "accepted", reason: "queued by adapter" },
    })).toEqual({ valid: true, errors: [] });
  });

  it("requires an exact 64-character lowercase hex state token", () => {
    for (const expected_state_token of ["a".repeat(63), "A".repeat(64), `${"a".repeat(63)}g`]) {
      expect(validateDagActorLiveCommandMessage({
        type: "dag_actor_command",
        data: {
          ...identity(),
          expected_state_token,
          idempotency_key: "key-1",
          payload: {},
        },
      }).valid).toBe(false);
    }
  });

  it("rejects unbounded or arbitrary status result data", () => {
    expect(validateDagActorLiveCommandStatusMessage({
      type: "dag_actor_command_status",
      data: { ...identity(), status: "completed", result: { credential: "secret" } },
    }).valid).toBe(false);
    expect(validateDagActorLiveCommandStatusMessage({
      type: "dag_actor_command_status",
      data: { ...identity(), status: "failed", reason: "x".repeat(4097) },
    }).valid).toBe(false);
  });

  it("normalizes active and waiting tool inputs without domain routing rules", () => {
    expect(normalizeManagerAgentDagActorCommandInput({
      run_id: "run-1",
      commands: [{
        actor_id: "actor-1",
        idempotency_key: "turn-1",
        expected_state_token: token,
        payload: { operation: "generic" },
      }],
    })).toEqual({
      run_id: "run-1",
      commands: [{
        actor_id: "actor-1",
        idempotency_key: "turn-1",
        expected_state_token: token,
        payload: { operation: "generic" },
      }],
    });
    expect(normalizeManagerAgentDagActorCommandInput({
      run_id: "run-1",
      expected_round_id: "round-0001",
      commands: [{
        actor_id: "actor-1",
        idempotency_key: "turn-2",
        expected_state_token: "stale-token-from-previous-active-round",
        payload: { operation: "generic" },
      }],
    })).toEqual({
      run_id: "run-1",
      expected_round_id: "round-0001",
      commands: [{
        actor_id: "actor-1",
        idempotency_key: "turn-2",
        payload: { operation: "generic" },
      }],
    });
    expect(normalizeManagerAgentDagActorCommandInput({
      run_id: "run-1",
      expected_round_id: "round-0001",
      actor_id: "actor-1",
      idempotency_key: "turn-3",
      expected_state_token: "stale-token-from-previous-active-round",
      payload: { operation: "generic" },
    })).toEqual({
      run_id: "run-1",
      expected_round_id: "round-0001",
      commands: [{
        actor_id: "actor-1",
        idempotency_key: "turn-3",
        payload: { operation: "generic" },
      }],
    });
    const spec = managerAgentToolSpec("send_dag_actor_command");
    expect(spec.input_schema.required).toEqual(["run_id", "commands"]);
    expect(JSON.stringify(spec)).not.toMatch(/showcase|researcher|writer|visual/i);
  });
});
