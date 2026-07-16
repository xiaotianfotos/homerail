import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentEvent, AgentRunContext } from "../agent/types.js";
import { AgentTurnController, type AgentTurnSteerReceipt } from "../agent/turn-controller.js";

const context: AgentRunContext = {
  model: "claude-sonnet-4-20250514",
  apiKey: "test-key",
  baseUrl: "https://api.anthropic.com",
};

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
});

describe("Claude SDK live steering contract", () => {
  it("streams the raw prompt first and later user messages FIFO", async () => {
    const { ClaudeSdkUserMessageQueue } = await import("../agent/claude-sdk.js");
    const queue = new ClaudeSdkUserMessageQueue("original prompt");
    const iterator = queue[Symbol.asyncIterator]();

    await expect(iterator.next()).resolves.toEqual({
      done: false,
      value: {
        type: "user",
        message: { role: "user", content: "original prompt" },
        parent_tool_use_id: null,
      },
    });

    const secondApplied = queue.enqueue("second");
    const thirdApplied = queue.enqueue("third");
    await expect(iterator.next()).resolves.toMatchObject({
      done: false,
      value: { message: { content: "second" } },
    });
    await expect(secondApplied).resolves.toBeUndefined();
    await expect(iterator.next()).resolves.toMatchObject({
      done: false,
      value: { message: { content: "third" } },
    });
    await expect(thirdApplied).resolves.toBeUndefined();

    const waiting = iterator.next();
    queue.close();
    await expect(waiting).resolves.toEqual({ done: true, value: undefined });
    await expect(queue.enqueue("late")).rejects.toThrow("closed");
  });

  it("maps queue consumption to applied and result cleanup to turn completion", async () => {
    const ready = deferred();
    const received: unknown[] = [];
    vi.doMock("@anthropic-ai/claude-agent-sdk", () => ({
      async *query(params: { prompt: AsyncIterable<unknown> }) {
        const iterator = params.prompt[Symbol.asyncIterator]();
        received.push((await iterator.next()).value);
        ready.resolve();
        received.push((await iterator.next()).value);
        yield { type: "result", subtype: "success", is_error: false };
      },
      createSdkMcpServer: () => ({}),
      tool: () => ({}),
    }));

    const { ClaudeSdkAdapter } = await import("../agent/claude-sdk.js");
    const controller = new AgentTurnController({ capabilities: { liveSteer: true } });
    const events: AgentEvent[] = [];
    const running = (async () => {
      for await (const event of new ClaudeSdkAdapter().run("original", [], {
        ...context,
        turnController: controller,
      })) events.push(event);
    })();

    await ready.promise;
    const submission = controller.steer({ commandId: "steer-1", content: "new direction" });
    expect(submission.status).toBe("accepted");
    const steering = submission as AgentTurnSteerReceipt;
    await expect(steering.accepted).resolves.toEqual({ status: "accepted" });
    await expect(steering.applied).resolves.toEqual({ status: "applied" });
    await running;
    await controller.close({ outcome: "completed" });
    await expect(steering.completed).resolves.toEqual({ status: "completed" });

    expect(received).toEqual([
      {
        type: "user",
        message: { role: "user", content: "original" },
        parent_tool_use_id: null,
      },
      {
        type: "user",
        message: { role: "user", content: "new direction" },
        parent_tool_use_id: null,
      },
    ]);
    expect(events.at(-1)?.type).toBe("done");
  });

  it("interrupt closes pending steering without a hanging provider input promise", async () => {
    const ready = deferred();
    vi.doMock("@anthropic-ai/claude-agent-sdk", () => ({
      async *query(params: { prompt: AsyncIterable<unknown>; options?: Record<string, unknown> }) {
        const iterator = params.prompt[Symbol.asyncIterator]();
        await iterator.next();
        ready.resolve();
        const abortController = params.options?.abortController as AbortController;
        await new Promise<void>((resolve) => {
          if (abortController.signal.aborted) resolve();
          else abortController.signal.addEventListener("abort", () => resolve(), { once: true });
        });
      },
      createSdkMcpServer: () => ({}),
      tool: () => ({}),
    }));

    const { ClaudeSdkAdapter } = await import("../agent/claude-sdk.js");
    const controller = new AgentTurnController({ capabilities: { liveSteer: true } });
    const running = (async () => {
      for await (const _event of new ClaudeSdkAdapter().run("original", [], {
        ...context,
        turnController: controller,
      })) {
        // Drain the adapter until its interrupt cleanup completes.
      }
    })();

    await ready.promise;
    const submission = controller.steer({ commandId: "pending", content: "never consumed" });
    if (submission.status !== "accepted") throw new Error("expected steering receipt");
    await expect(submission.accepted).resolves.toEqual({ status: "accepted" });
    await expect(controller.interrupt("handoff won")).resolves.toEqual({ status: "interrupted" });
    await expect(submission.applied).resolves.toMatchObject({ status: "failed" });
    await running;
    await controller.close({ outcome: "completed" });
  });
});
