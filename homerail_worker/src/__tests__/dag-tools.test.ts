/**
 * Tests for DAG tools: handoff, send_message, receive_message, get_graph_context.
 */

import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";
import {
  createDagToolsState,
  createDagTools,
  deliverInbox,
} from "../dag-tools/index.js";
import type { DagNodeConfig } from "homerail-protocol";

function makeConfig(overrides: Partial<DagNodeConfig> = {}): DagNodeConfig {
  return {
    node_id: "coder",
    agent_type: "claude-sdk",
    model: "test",
    outgoing_edges: [
      { from_port: "done", to_node: "tester", to_port: "in" },
    ],
    incoming_edges: [
      { from_node: "triage", from_port: "done", to_port: "in" },
    ],
    graph_nodes: ["triage", "coder", "tester"],
    ...overrides,
  };
}

describe("DAG tools", () => {
  let wsSend: Mock<(data: string) => void>;
  let state: ReturnType<typeof createDagToolsState>;

  beforeEach(() => {
    wsSend = vi.fn();
    state = createDagToolsState(makeConfig(), "run-1", wsSend);
  });

  describe("get_graph_context", () => {
    it("returns correct graph context", async () => {
      const tools = createDagTools(state);
      const ctxTool = tools.find((t) => t.name === "get_graph_context")!;
      const result = await ctxTool.handler({});

      expect(result.content).toHaveLength(1);
      const ctx = JSON.parse((result.content as any)[0].text);
      expect(ctx.node_id).toBe("coder");
      expect(ctx.available_ports).toEqual(["done"]);
      expect(ctx.graph_nodes).toEqual(["triage", "coder", "tester"]);
      expect(ctx.predecessors).toEqual([
        { node: "triage", from_port: "done", to_port: "in" },
      ]);
      expect(ctx.successors).toEqual([
        { node: "tester", from_port: "done", to_port: "in" },
      ]);
    });
  });

  describe("handoff", () => {
    it("stages an authoritative handoff on a valid port", async () => {
      const tools = createDagTools(state);
      const handoffTool = tools.find((t) => t.name === "handoff")!;

      const result = await handoffTool.handler({
        port: "done",
        content: "test content",
        summary: "done",
      });

      expect(result.is_error).toBeFalsy();
      expect(wsSend).not.toHaveBeenCalled();
      expect(state.handoffData).toMatchObject({
        type: "node_handoff",
        runId: "run-1",
        nodeId: "coder",
        port: "done",
        from_node: "coder",
        from_port: "done",
        session_id: "run-1",
        content: "test content",
      });
      expect(state.yielded).toBe(true);
    });

    it("uses the DAG node session id on handoff when provided", async () => {
      state = createDagToolsState(makeConfig({ session_id: "node-session-2" }), "run-1", wsSend);
      const tools = createDagTools(state);
      const handoffTool = tools.find((t) => t.name === "handoff")!;

      await handoffTool.handler({
        port: "done",
        content: "test content",
      });

      expect(state.handoffData).toMatchObject({ session_id: "node-session-2" });
    });

    it("normalizes a complete JSON object string before contract validation", async () => {
      const tools = createDagTools(state);
      const handoffTool = tools.find((t) => t.name === "handoff")!;

      await handoffTool.handler({
        port: "done",
        content: '{"work_items":[{"id":"one"}]}',
      });

      expect(state.handoffData).toMatchObject({ content: { work_items: [{ id: "one" }] } });
    });

    it("preserves ordinary and malformed JSON-like text", async () => {
      const tools = createDagTools(state);
      const handoffTool = tools.find((t) => t.name === "handoff")!;

      await handoffTool.handler({ port: "done", content: "{not-json}" });

      expect(state.handoffData).toMatchObject({ content: "{not-json}" });
    });

    it("rejects invalid port", async () => {
      const tools = createDagTools(state);
      const handoffTool = tools.find((t) => t.name === "handoff")!;

      const result = await handoffTool.handler({
        port: "invalid",
        content: "x",
      });

      expect(result.is_error).toBe(true);
      expect(wsSend).not.toHaveBeenCalled();
    });

    it("rejects duplicate handoff", async () => {
      const tools = createDagTools(state);
      const handoffTool = tools.find((t) => t.name === "handoff")!;

      await handoffTool.handler({ port: "done", content: "first" });
      const result = await handoffTool.handler({ port: "done", content: "second" });

      expect(result.is_error).toBe(true);
    });
  });

  describe("manager_command", () => {
    it("rejects legacy manager command requests", async () => {
      const tools = createDagTools(state);
      const managerTool = tools.find((t) => t.name === "manager_command")!;

      const result = await managerTool.handler({
        command: "append_node",
        command_id: "cmd-1",
        append: { node_id: "observer", after: ["coder"] },
      });

      expect(result.is_error).toBe(true);
      expect(wsSend).not.toHaveBeenCalled();
      expect(result.content[0]?.text).toContain("unsupported");
    });
  });

  describe("send_message", () => {
    it("sends to valid node", async () => {
      const tools = createDagTools(state);
      const sendTool = tools.find((t) => t.name === "send_message")!;

      const result = await sendTool.handler({
        to_node: "tester",
        content: "hello",
      });

      expect(result.is_error).toBeFalsy();
      const sent = JSON.parse(wsSend.mock.calls[0][0]);
      expect(sent.data.type).toBe("node_send_message");
      expect(sent.data.run_id).toBe("run-1");
      expect(sent.data.from_node).toBe("coder");
      expect(sent.data.to_node).toBe("tester");
      expect(sent.session_id).toBe("run-1");
      expect(sent.data.session_id).toBe("run-1");
    });

    it("uses the DAG node session id on send_message when provided", async () => {
      state = createDagToolsState(makeConfig({ session_id: "node-session-send" }), "run-1", wsSend);
      const tools = createDagTools(state);
      const sendTool = tools.find((t) => t.name === "send_message")!;

      await sendTool.handler({
        to_node: "tester",
        content: "hello",
      });

      const sent = JSON.parse(wsSend.mock.calls[0][0]);
      expect(sent.session_id).toBe("node-session-send");
      expect(sent.data.session_id).toBe("node-session-send");
    });

    it("rejects invalid node", async () => {
      const tools = createDagTools(state);
      const sendTool = tools.find((t) => t.name === "send_message")!;

      const result = await sendTool.handler({
        to_node: "nonexistent",
        content: "x",
      });

      expect(result.is_error).toBe(true);
    });
  });

  describe("receive_message", () => {
    it("returns immediately if inbox has message", async () => {
      const tools = createDagTools(state);
      const recvTool = tools.find((t) => t.name === "receive_message")!;

      deliverInbox(state, "test message");
      const result = await recvTool.handler({});

      expect(result.is_error).toBeFalsy();
      const text = (result.content as any)[0].text;
      expect(JSON.parse(text).content).toBe("test message");
    });

    it("wakes on deliverInbox", async () => {
      const tools = createDagTools(state);
      const recvTool = tools.find((t) => t.name === "receive_message")!;

      // Start receive (will block)
      const promise = recvTool.handler({ timeout: 5 });
      const sent = JSON.parse(wsSend.mock.calls[0][0]);
      expect(sent.type).toBe("response");
      expect(sent.session_id).toBe("run-1");
      expect(sent.data.session_id).toBe("run-1");

      // Deliver after a tick
      setTimeout(() => deliverInbox(state, "delayed msg"), 10);

      const result = await promise;
      const text = (result.content as any)[0].text;
      expect(JSON.parse(text).content).toBe("delayed msg");
    });

    it("preserves routed node messages from manager", async () => {
      const tools = createDagTools(state);
      const recvTool = tools.find((t) => t.name === "receive_message")!;

      deliverInbox(state, {
        type: "node_message",
        runId: "run-1",
        fromNode: "triage",
        toNode: "coder",
        content: { question: "ready?" },
        timestamp: 123,
      });

      const result = await recvTool.handler({});
      const text = (result.content as any)[0].text;
      expect(JSON.parse(text)).toMatchObject({
        type: "node_message",
        runId: "run-1",
        fromNode: "triage",
        toNode: "coder",
        content: { question: "ready?" },
      });
    });

    it("times out when no message", async () => {
      const tools = createDagTools(state);
      const recvTool = tools.find((t) => t.name === "receive_message")!;

      const result = await recvTool.handler({ timeout: 1 });
      const text = (result.content as any)[0].text;
      expect(text).toContain("超时");
    });
  });
});
