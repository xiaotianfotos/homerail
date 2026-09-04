import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { DeepSeekHarnessAdapter } from "../agent/deepseek-harness.js";
import type { AgentEvent, DagToolDefinition } from "../agent/types.js";

interface MockProvider {
  baseUrl: string;
  requests: Array<{ path: string; body: Record<string, unknown> }>;
  close(): Promise<void>;
}

const servers: Server[] = [];
const runtimeConfigured = Boolean(process.env.HOMERAIL_DSH_RUNTIME_BIN?.trim());

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  })));
});

function sse(response: ServerResponse, events: unknown[]): void {
  response.writeHead(200, { "content-type": "text/event-stream" });
  for (const event of events) response.write(`data: ${typeof event === "string" ? event : JSON.stringify(event)}\n\n`);
  response.end();
}

async function startMockProvider(): Promise<MockProvider> {
  const requests: MockProvider["requests"] = [];
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    let rawBody = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => { rawBody += chunk; });
    request.on("end", () => {
      const body = JSON.parse(rawBody) as Record<string, unknown>;
      requests.push({ path: request.url ?? "", body });
      if (requests.length === 1) {
        sse(response, [
          { choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }] },
          {
            choices: [{
              index: 0,
              delta: {
                tool_calls: [{
                  index: 0,
                  id: "handoff-call-1",
                  type: "function",
                  function: {
                    name: "mcp__homerail__handoff",
                    arguments: "{\"port\":\"done\",\"content\":\"runtime-smoke\"}",
                  },
                }],
              },
              finish_reason: null,
            }],
          },
          {
            choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
            usage: { prompt_tokens: 5, completion_tokens: 2 },
          },
          "[DONE]",
        ]);
        return;
      }
      sse(response, [
        { choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }] },
        { choices: [{ index: 0, delta: { content: "runtime complete" }, finish_reason: null }] },
        {
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          usage: { prompt_tokens: 7, completion_tokens: 3 },
        },
        "[DONE]",
      ]);
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1/chat/completions`,
    requests,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => {
        const index = servers.indexOf(server);
        if (index >= 0) servers.splice(index, 1);
        if (error) reject(error);
        else resolve();
      });
    }),
  };
}

describe.skipIf(!runtimeConfigured)("DeepSeek Harness packaged runtime", () => {
  it("runs the real JSON-RPC runtime through model SSE and MCP handoff", async () => {
    const provider = await startMockProvider();
    const calls: Array<{ args: Record<string, unknown>; toolCallId?: string }> = [];
    const handoff: DagToolDefinition = {
      name: "handoff",
      description: "Return the completed work to HomeRail",
      input_schema: {
        type: "object",
        properties: {
          port: { type: "string" },
          content: { type: "string" },
        },
        required: ["port", "content"],
      },
      handler: async (args, metadata) => {
        calls.push({ args, toolCallId: metadata?.tool_call_id });
        return { content: [{ type: "text", text: "accepted" }] };
      },
    };
    const events: AgentEvent[] = [];
    const adapter = new DeepSeekHarnessAdapter();

    for await (const event of adapter.run("Call handoff, then finish.", [handoff], {
      provider: "local-smoke",
      protocol: "openai_compatible",
      model: "mock-model",
      apiKey: "keyless-smoke",
      baseUrl: provider.baseUrl,
      workspace: process.cwd(),
      sessionId: "dsh-runtime-smoke",
    })) events.push(event);

    expect(events.some((event) => event.type === "error")).toBe(false);
    expect(events).toContainEqual({
      type: "tool_use",
      id: "handoff-call-1",
      name: "handoff",
      input: { port: "done", content: "runtime-smoke" },
    });
    expect(events).toContainEqual({
      type: "tool_result",
      tool_use_id: "handoff-call-1",
      content: "accepted",
      is_error: false,
    });
    expect(events).toContainEqual({ type: "text", text: "runtime complete" });
    expect(events.at(-1)).toMatchObject({
      type: "done",
      usage: { input_tokens: 12, output_tokens: 5 },
      finish_reason: "completed",
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.args).toEqual({ port: "done", content: "runtime-smoke" });
    expect(calls[0]?.toolCallId).toMatch(/^\d+$/);
    expect(provider.requests).toHaveLength(2);
    expect(provider.requests.map((entry) => entry.path)).toEqual([
      "/v1/chat/completions",
      "/v1/chat/completions",
    ]);
    const exposedToolNames = (provider.requests[0]?.body.tools as Array<{
      function?: { name?: string };
    }> | undefined)?.map((tool) => tool.function?.name);
    expect(exposedToolNames).toEqual(["mcp__homerail__handoff"]);
    expect(JSON.stringify(provider.requests[0]?.body)).toContain("mcp__homerail__handoff");
    expect(JSON.stringify(provider.requests[1]?.body)).toContain("accepted");

    await provider.close();
  }, 30_000);
});
