import { describe, expect, it, vi } from "vitest";
import {
  AgentTurnController,
  agentTurnControllerOptionsForBackend,
  type AgentTurnSteerReceipt,
  type AgentTurnSteerResult,
} from "../agent/turn-controller.js";

function deferred(): { promise: Promise<void>; resolve: () => void; reject: (error: Error) => void } {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function receipt(result: AgentTurnSteerResult): AgentTurnSteerReceipt {
  if (result.status !== "accepted") throw new Error(`expected accepted receipt, got ${result.status}`);
  return result;
}

describe("AgentTurnController", () => {
  it("drains early commands FIFO with serialized provider sends", async () => {
    const controller = new AgentTurnController({ capabilities: { liveSteer: true } });
    const firstSend = deferred();
    const secondSend = deferred();
    const starts: string[] = [];
    const first = receipt(controller.steer({ commandId: "one", sequence: 1, content: "first" }));
    const second = receipt(controller.steer({ commandId: "two", sequence: 2, content: "second" }));

    expect(controller.bindDriver({
      steer: (command) => {
        starts.push(command.commandId);
        return command.commandId === "one" ? firstSend.promise : secondSend.promise;
      },
    })).toEqual({ status: "bound" });

    await expect(first.accepted).resolves.toEqual({ status: "accepted" });
    expect(starts).toEqual(["one"]);
    firstSend.resolve();
    await expect(first.applied).resolves.toEqual({ status: "applied" });
    await expect(second.accepted).resolves.toEqual({ status: "accepted" });
    expect(starts).toEqual(["one", "two"]);
    secondSend.resolve();
    await expect(second.applied).resolves.toEqual({ status: "applied" });

    await controller.close({ outcome: "completed" });
    await expect(first.completed).resolves.toEqual({ status: "completed" });
    await expect(second.completed).resolves.toEqual({ status: "completed" });
  });

  it("deduplicates command_id and rejects conflicting reuse", async () => {
    const steer = vi.fn(() => undefined);
    const controller = new AgentTurnController({ capabilities: { liveSteer: true } });
    controller.bindDriver({ steer });
    const first = receipt(controller.steer({
      commandId: "same",
      idempotencyKey: "key",
      sequence: 1,
      content: "keep this",
    }));
    const duplicate = receipt(controller.steer({
      commandId: "same",
      idempotencyKey: "key",
      sequence: 1,
      content: "keep this",
    }));
    const conflict = controller.steer({
      commandId: "same",
      idempotencyKey: "key",
      sequence: 1,
      content: "different",
    });

    expect(duplicate.duplicate).toBe(true);
    expect(duplicate.accepted).toBe(first.accepted);
    expect(conflict).toMatchObject({ status: "rejected", duplicate: true });
    await expect(first.applied).resolves.toEqual({ status: "applied" });
    expect(steer).toHaveBeenCalledTimes(1);
    await controller.close({ outcome: "completed" });
  });

  it("enforces the bounded queue before a driver is available", async () => {
    const controller = new AgentTurnController({
      capabilities: { liveSteer: true },
      maxQueueSize: 2,
    });
    const first = receipt(controller.steer({ commandId: "one", content: "one" }));
    const second = receipt(controller.steer({ commandId: "two", content: "two" }));

    expect(controller.pendingCount).toBe(2);
    expect(controller.steer({ commandId: "three", content: "three" })).toMatchObject({
      status: "rejected",
      reason: expect.stringContaining("queue limit 2"),
    });

    await controller.close({ outcome: "failed", reason: "test cleanup" });
    await expect(first.accepted).resolves.toMatchObject({ status: "failed" });
    await expect(second.accepted).resolves.toMatchObject({ status: "failed" });
  });

  it("reports unsupported transports without binding or false acceptance", () => {
    const options = agentTurnControllerOptionsForBackend("kimi-code", {});
    const controller = new AgentTurnController(options);

    expect(options.capabilities.liveSteer).toBe(false);
    expect(controller.steer({ commandId: "one", content: "do more" })).toMatchObject({
      status: "unsupported",
      reason: expect.stringContaining("Kimi CLI, ACP"),
    });
    expect(agentTurnControllerOptionsForBackend("kimi-code", {
      HOMERAIL_KIMI_AGENT_TRANSPORT: "sdk",
    }).capabilities.liveSteer).toBe(true);
    expect(agentTurnControllerOptionsForBackend("kimi-code", {
      HOMERAIL_KIMI_AGENT_TRANSPORT: "invalid",
      KIMI_AGENT_SDK_EXECUTABLE: "kimi-sdk",
    }).capabilities.liveSteer).toBe(true);
    expect(agentTurnControllerOptionsForBackend("kimi-code", {
      HOMERAIL_KIMI_AGENT_TRANSPORT: "acp",
      KIMI_AGENT_SDK_EXECUTABLE: "kimi-sdk",
    }).capabilities.liveSteer).toBe(false);
    expect(agentTurnControllerOptionsForBackend("deterministic", {}).capabilities.liveSteer).toBe(false);
  });

  it("reports synchronous and asynchronous driver failures deterministically", async () => {
    const synchronous = new AgentTurnController({ capabilities: { liveSteer: true } });
    synchronous.bindDriver({ steer: () => { throw new Error("sync failure"); } });
    const syncReceipt = receipt(synchronous.steer({ commandId: "sync", content: "sync" }));
    await expect(syncReceipt.accepted).resolves.toMatchObject({
      status: "failed",
      reason: expect.stringContaining("sync failure"),
    });
    await expect(syncReceipt.applied).resolves.toMatchObject({ status: "failed" });

    const asynchronous = new AgentTurnController({ capabilities: { liveSteer: true } });
    asynchronous.bindDriver({ steer: async () => { throw new Error("async failure"); } });
    const asyncReceipt = receipt(asynchronous.steer({ commandId: "async", content: "async" }));
    await expect(asyncReceipt.accepted).resolves.toEqual({ status: "accepted" });
    await expect(asyncReceipt.applied).resolves.toMatchObject({
      status: "failed",
      reason: expect.stringContaining("async failure"),
    });
  });

  it("lets interrupt win deterministically over a simultaneous successful close", async () => {
    const interrupt = vi.fn(async () => {});
    const close = vi.fn(async () => {});
    const controller = new AgentTurnController({ capabilities: { liveSteer: true } });
    controller.bindDriver({ steer: () => undefined, interrupt, close });
    const command = receipt(controller.steer({ commandId: "one", content: "one" }));
    await expect(command.applied).resolves.toEqual({ status: "applied" });

    const interrupted = controller.interrupt("manager stop");
    const closed = controller.close({ outcome: "completed" });

    await expect(interrupted).resolves.toEqual({ status: "interrupted" });
    await expect(command.completed).resolves.toMatchObject({
      status: "failed",
      reason: expect.stringContaining("interrupted"),
    });
    await expect(closed).resolves.toEqual({ status: "closed" });
    expect(interrupt).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("lets a successful close win when it starts before interrupt", async () => {
    const controller = new AgentTurnController({ capabilities: { liveSteer: true } });
    controller.bindDriver({ steer: () => undefined });
    const command = receipt(controller.steer({ commandId: "one", content: "one" }));
    await expect(command.applied).resolves.toEqual({ status: "applied" });

    const closed = controller.close({ outcome: "completed" });
    const interrupted = controller.interrupt("too late");

    await expect(command.completed).resolves.toEqual({ status: "completed" });
    await expect(interrupted).resolves.toMatchObject({ status: "rejected" });
    await expect(closed).resolves.toEqual({ status: "closed" });
  });

  it("closes a driver bound after the controller became terminal", async () => {
    const controller = new AgentTurnController({ capabilities: { liveSteer: true } });
    await controller.close({ outcome: "failed", reason: "done" });
    const close = vi.fn(async () => {});

    expect(controller.bindDriver({ steer: () => undefined, close })).toMatchObject({ status: "rejected" });
    await vi.waitFor(() => expect(close).toHaveBeenCalledTimes(1));
  });
});
