import { describe, expect, it, vi } from "vitest";
import type { AgentEvent, AgentRunContext } from "../agent/types.js";
import { KimiCodeAdapter } from "../agent/kimi-code.js";
import { AgentTurnController } from "../agent/turn-controller.js";

const context: AgentRunContext = {
  model: "kimi-k2.7-code",
  provider: "kimi",
  apiKey: "test-key",
  baseUrl: "https://api.kimi.com/coding/v1",
};

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

describe("Kimi Agent SDK live steering contract", () => {
  it("queues early commands and serializes them through the current Turn.steer()", async () => {
    const firstSend = deferred();
    const finishTurn = deferred();
    const steerCalls: string[] = [];
    const steer = vi.fn((content: string) => {
      steerCalls.push(content);
      return content === "first direction" ? firstSend.promise : Promise.resolve();
    });
    const close = vi.fn(async () => {});
    const createSdkSession = vi.fn(() => ({
      sessionId: "sdk-session-steer",
      workDir: process.cwd(),
      state: "idle",
      slashCommands: [],
      model: context.model,
      thinking: false,
      yoloMode: true,
      executable: "fake-kimi-sdk",
      env: {},
      externalTools: [],
      planMode: false,
      setPlanMode: async () => false,
      prompt: () => ({
        result: Promise.resolve({ status: "finished", steps: 1 }),
        interrupt: async () => {},
        approve: async () => {},
        respondQuestion: async () => {},
        steer,
        async *[Symbol.asyncIterator]() {
          await finishTurn.promise;
          yield { type: "TurnEnd", payload: {} };
          return { status: "finished", steps: 1 };
        },
      }),
      close,
      [Symbol.asyncDispose]: close,
    }));
    const controller = new AgentTurnController({ capabilities: { liveSteer: true } });
    const first = controller.steer({ commandId: "one", sequence: 1, content: "first direction" });
    const second = controller.steer({ commandId: "two", sequence: 2, content: "second direction" });
    if (first.status !== "accepted" || second.status !== "accepted") throw new Error("expected receipts");
    const adapter = new KimiCodeAdapter({
      transport: "sdk",
      sdkExecutable: "fake-kimi-sdk",
      createSdkSession: createSdkSession as never,
    });
    const events: AgentEvent[] = [];
    const running = (async () => {
      for await (const event of adapter.run("original", [], { ...context, turnController: controller })) {
        events.push(event);
      }
    })();

    await expect(first.accepted).resolves.toEqual({ status: "accepted" });
    expect(steerCalls).toEqual(["first direction"]);
    firstSend.resolve();
    await expect(first.applied).resolves.toEqual({ status: "applied" });
    await expect(second.applied).resolves.toEqual({ status: "applied" });
    expect(steerCalls).toEqual(["first direction", "second direction"]);
    finishTurn.resolve();
    await running;
    await controller.close({ outcome: "completed" });

    await expect(first.completed).resolves.toEqual({ status: "completed" });
    await expect(second.completed).resolves.toEqual({ status: "completed" });
    expect(steer).toHaveBeenCalledTimes(2);
    expect(close).toHaveBeenCalledTimes(1);
    expect(events.at(-1)).toEqual({ type: "done" });
  });

  it("preserves Turn.interrupt() and closes the SDK session", async () => {
    const stopped = deferred();
    const interrupt = vi.fn(async () => stopped.resolve());
    const close = vi.fn(async () => {});
    const createSdkSession = vi.fn(() => ({
      sessionId: "sdk-session-interrupt",
      workDir: process.cwd(),
      state: "idle",
      slashCommands: [],
      model: context.model,
      thinking: false,
      yoloMode: true,
      executable: "fake-kimi-sdk",
      env: {},
      externalTools: [],
      planMode: false,
      setPlanMode: async () => false,
      prompt: () => ({
        result: Promise.resolve({ status: "cancelled", steps: 0 }),
        interrupt,
        approve: async () => {},
        respondQuestion: async () => {},
        steer: async () => {},
        async *[Symbol.asyncIterator]() {
          await stopped.promise;
          return { status: "cancelled", steps: 0 };
        },
      }),
      close,
      [Symbol.asyncDispose]: close,
    }));
    const controller = new AgentTurnController({ capabilities: { liveSteer: true } });
    const adapter = new KimiCodeAdapter({
      transport: "sdk",
      sdkExecutable: "fake-kimi-sdk",
      createSdkSession: createSdkSession as never,
    });
    const events: AgentEvent[] = [];
    const running = (async () => {
      for await (const event of adapter.run("original", [], { ...context, turnController: controller })) {
        events.push(event);
      }
    })();

    await vi.waitFor(() => expect(events).toContainEqual(expect.objectContaining({
      type: "debug",
      message: "kimi_agent_sdk_session_started",
    })));
    await expect(controller.interrupt("manager stop")).resolves.toEqual({ status: "interrupted" });
    await running;
    await controller.close({ outcome: "failed", reason: "interrupted" });

    expect(interrupt).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
    expect(events).toContainEqual(expect.objectContaining({ message: "sdk_run_cancelled" }));
  });
});
