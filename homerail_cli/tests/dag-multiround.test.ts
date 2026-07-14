import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HomeRailClient } from "../src/client.js";
import { cmdDagQuick } from "../src/commands/dag-quick.js";
import {
  buildSendCommandBody,
} from "../src/commands/dag-multiround.js";
import {
  cmdDagSuperviseContinuous,
  cmdDagSuperviseTick,
} from "../src/commands/dag-supervise.js";
import { cmdDagWatch } from "../src/commands/dag-watch.js";
import { createProgram } from "../src/index.js";

function jsonResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => body,
  } as unknown as Response;
}

describe("multi-round DAG observation", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    process.exitCode = undefined;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = undefined;
  });

  it("reports waiting as a command boundary and exits watch/supervise without polling", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const pathname = new URL(String(input)).pathname;
      if (pathname === "/api/runs/run-waiting/status") {
        return jsonResponse({
          success: true,
          message: "ok",
          data: {
            status: "waiting",
            current_phase: "waiting",
            currentRound: { round_id: "round-0002", status: "waiting" },
          },
        });
      }
      if (pathname === "/api/dag-status/run-waiting") {
        return jsonResponse({
          success: true,
          message: "ok",
          data: {
            status: "waiting",
            execution: { nodes: {}, ready_nodes: [], failed_nodes: [] },
          },
        });
      }
      if (pathname === "/api/dag-status/run-waiting/events/history") {
        return jsonResponse({ success: true, message: "ok", data: { events: [] } });
      }
      throw new Error(`Unexpected request: ${pathname}`);
    });
    const client = new HomeRailClient({ baseUrl: "http://manager.test" });
    const output = vi.spyOn(console, "log").mockImplementation(() => undefined);

    expect(await cmdDagQuick(client, "run-waiting", 5, true)).toBe(0);
    const quick = JSON.parse(String(output.mock.calls.at(-1)?.[0])) as Record<string, unknown>;
    expect(quick).toMatchObject({
      run_status: "waiting",
      waiting_for_command: true,
      current_round_id: "round-0002",
      stalled_hint: "waiting_for_command",
    });

    output.mockClear();
    fetchSpy.mockClear();
    expect(await cmdDagWatch(client, "run-waiting", 5, 60, 60, true)).toBe(0);
    expect(output).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(output.mock.calls[0]?.[0]))).toMatchObject({
      run_status: "waiting",
      waiting_for_command: true,
      current_round_id: "round-0002",
    });
    expect(fetchSpy).toHaveBeenCalledTimes(3);

    output.mockClear();
    fetchSpy.mockClear();
    expect(await cmdDagSuperviseContinuous(
      client,
      "run-waiting",
      60,
      60,
      5,
      3,
      300,
      60,
      true,
    )).toBe(0);
    expect(output).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(output.mock.calls[0]?.[0]))).toMatchObject({
      terminal: false,
      waiting_for_command: true,
      severity: "waiting",
      snapshot: {
        run_status: "waiting",
        waiting_for_command: true,
        current_round_id: "round-0002",
      },
    });

    output.mockClear();
    const tickExit = await cmdDagSuperviseTick(
      client,
      "run-waiting",
      "events:0",
      5,
      3,
      300,
      true,
    );
    expect(tickExit).toBe(0);
    expect(JSON.parse(String(output.mock.calls[0]?.[0]))).toMatchObject({
      terminal: false,
      waiting_for_command: true,
    });
  });
});

describe("multi-round DAG commands", () => {
  let tempHome: string;
  let previousHome: string | undefined;
  let previousMutationToken: string | undefined;

  beforeEach(() => {
    vi.restoreAllMocks();
    process.exitCode = undefined;
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "homerail-cli-multiround-"));
    previousHome = process.env.HOMERAIL_HOME;
    previousMutationToken = process.env.HOMERAIL_DAG_MUTATION_TOKEN;
    process.env.HOMERAIL_HOME = tempHome;
    process.env.HOMERAIL_DAG_MUTATION_TOKEN = "test-mutation-token";
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = undefined;
    if (previousHome === undefined) delete process.env.HOMERAIL_HOME;
    else process.env.HOMERAIL_HOME = previousHome;
    if (previousMutationToken === undefined) delete process.env.HOMERAIL_DAG_MUTATION_TOKEN;
    else process.env.HOMERAIL_DAG_MUTATION_TOKEN = previousMutationToken;
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  it("lists rounds and commands with an optional round filter", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse({
        success: true,
        message: "ok",
        data: {
          rounds: [{
            run_id: "run/one",
            round_id: "round-0001",
            ordinal: 1,
            status: "waiting",
            target_actor_ids: ["researcher"],
            await_node_id: "await",
            opened_at: 1,
          }],
          total: 1,
        },
      }))
      .mockResolvedValueOnce(jsonResponse({
        success: true,
        message: "ok",
        data: {
          commands: [{
            command_id: "command-1",
            run_id: "run/one",
            actor_id: "researcher",
            round_id: "round/0002",
            target_generation: 1,
            status: "acknowledged",
            idempotency_key: "idem-1",
            payload: { task: "continue" },
          }],
          total: 1,
        },
      }));
    const output = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await createProgram().parseAsync([
      "node", "hr", "--base-url", "http://manager.test", "--json",
      "dag", "rounds", "run/one",
    ]);
    expect(JSON.parse(String(output.mock.calls.at(-1)?.[0]))).toHaveLength(1);
    expect(fetchSpy).toHaveBeenNthCalledWith(
      1,
      "http://manager.test/api/runs/run%2Fone/rounds",
      expect.objectContaining({ method: "GET" }),
    );

    await createProgram().parseAsync([
      "node", "hr", "--base-url", "http://manager.test", "--json",
      "dag", "commands", "run/one", "--round", "round/0002",
    ]);
    expect(JSON.parse(String(output.mock.calls.at(-1)?.[0]))[0]).toMatchObject({
      command_id: "command-1",
      round_id: "round/0002",
    });
    expect(fetchSpy).toHaveBeenNthCalledWith(
      2,
      "http://manager.test/api/runs/run%2Fone/commands?round_id=round%2F0002",
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("sends one command with parsed JSON identity fields and mutation auth", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({
      success: true,
      message: "resumed",
      data: {
        resumed: true,
        previous_round_id: "round-0001",
        round_id: "round-0002",
        actor_ids: ["researcher"],
        command_ids: ["command-2"],
      },
    }));
    const output = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await createProgram().parseAsync([
      "node", "hr", "--base-url", "http://manager.test", "--json",
      "dag", "send-command", "run-1",
      "--expected-round", "round-0001",
      "--actor", "researcher",
      "--payload", "{\"task\":\"continue\",\"limit\":3}",
      "--command-id", "command-2",
      "--idempotency-key", "retry-2",
    ]);

    expect(JSON.parse(String(output.mock.calls[0]?.[0]))).toMatchObject({
      round_id: "round-0002",
      command_ids: ["command-2"],
    });
    expect(fetchSpy).toHaveBeenCalledWith(
      "http://manager.test/api/runs/run-1/commands",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "X-Homerail-Dag-Token": "test-mutation-token",
          "Content-Type": "application/json",
        }),
        body: JSON.stringify({
          expected_round_id: "round-0001",
          commands: [{
            actor_id: "researcher",
            payload: { task: "continue", limit: 3 },
            command_id: "command-2",
            idempotency_key: "retry-2",
          }],
        }),
      }),
    );
  });

  it("pairs repeated actors and payloads while preserving plain strings", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({
      success: true,
      message: "resumed",
      data: { resumed: true, round_id: "round-0002", actor_ids: ["a", "b"] },
    }));
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    await createProgram().parseAsync([
      "node", "hr", "--base-url", "http://manager.test",
      "dag", "send-command", "run-2",
      "--expected-round", "round-0001",
      "--actor", "a", "--payload", "refresh headlines",
      "--actor", "b", "--payload", "{\"limit\":4}",
    ]);

    const request = fetchSpy.mock.calls[0]?.[1];
    expect(JSON.parse(String(request?.body))).toEqual({
      expected_round_id: "round-0001",
      commands: [
        { actor_id: "a", payload: "refresh headlines" },
        { actor_id: "b", payload: { limit: 4 } },
      ],
    });
  });

  it("rejects malformed actor/payload pairs before making a request", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await createProgram().parseAsync([
      "node", "hr", "--base-url", "http://manager.test",
      "dag", "send-command", "run-3",
      "--expected-round", "round-0001",
      "--actor", "a", "--actor", "b", "--payload", "only one",
    ]);

    expect(process.exitCode).toBe(1);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(String(errors.mock.calls[0]?.[0])).toContain(
      "received 2 --actor value(s) and 1 --payload value(s)",
    );
    expect(() => buildSendCommandBody({
      expectedRound: "round-0001",
      actor: ["a", "b"],
      payload: ["one", "two"],
      commandId: "not-valid-for-batch",
    })).toThrow("only valid for a single command");
  });

  it("completes only the expected waiting round", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({
      success: true,
      message: "completed",
      data: { completed: true },
    }));
    const output = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await createProgram().parseAsync([
      "node", "hr", "--base-url", "http://manager.test", "--json",
      "dag", "complete", "run/complete", "--expected-round", "round-0004",
    ]);

    expect(JSON.parse(String(output.mock.calls[0]?.[0]))).toEqual({ completed: true });
    expect(fetchSpy).toHaveBeenCalledWith(
      "http://manager.test/api/runs/run%2Fcomplete/complete",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ "X-Homerail-Dag-Token": "test-mutation-token" }),
        body: JSON.stringify({ expected_round_id: "round-0004" }),
      }),
    );
  });
});
