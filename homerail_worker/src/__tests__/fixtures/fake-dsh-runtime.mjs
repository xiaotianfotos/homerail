import { appendFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const lines = createInterface({ input: process.stdin });
let sequence = 0;
let activeSession = "";
let activeMessage = "";
let activePrompt = [];

function write(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function response(id, result) {
  write({ jsonrpc: "2.0", id, result });
}

async function exerciseMcpBridge() {
  const script = process.env.HOMERAIL_DSH_MCP_SCRIPT;
  const bridgeUrl = process.env.HOMERAIL_MCP_BRIDGE_URL;
  const bridgeToken = process.env.HOMERAIL_MCP_BRIDGE_TOKEN;
  if (!script || !bridgeUrl || !bridgeToken) throw new Error("DSH MCP bridge environment is incomplete");

  const child = spawn(process.execPath, [script], {
    env: {
      HOMERAIL_MCP_BRIDGE_URL: bridgeUrl,
      HOMERAIL_MCP_BRIDGE_TOKEN: bridgeToken,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const childLines = createInterface({ input: child.stdout });
  const pending = new Map();
  let requestId = 0;
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
  childLines.on("line", (line) => {
    const message = JSON.parse(line);
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    clearTimeout(waiter.timeout);
    if (message.error) waiter.reject(new Error(message.error.message));
    else waiter.resolve(message.result);
  });
  child.on("error", (error) => {
    for (const waiter of pending.values()) {
      clearTimeout(waiter.timeout);
      waiter.reject(error);
    }
    pending.clear();
  });
  const request = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++requestId;
    const timeout = setTimeout(() => {
      if (!pending.delete(id)) return;
      reject(new Error(`DSH MCP request timed out: ${method}; stderr=${stderr}`));
    }, 5_000);
    pending.set(id, { resolve, reject, timeout });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });

  try {
    const initialized = await request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
    });
    child.stdin.write(`${JSON.stringify({
      jsonrpc: "2.0",
      method: "notifications/initialized",
      params: {},
    })}\n`);
    const listed = await request("tools/list");
    const called = await request("tools/call", {
      name: "handoff",
      arguments: { port: "done", content: { ok: true } },
    });
    const unknown = await request("tools/call", { name: "missing", arguments: {} });
    const composite = await request("tools/call", {
      name: "mcp__homerail__handoff",
      arguments: { port: "done" },
    });
    const unauthorizedResponse = await fetch(`${bridgeUrl}/tool`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "handoff", args: {} }),
    });
    return {
      initialized,
      listed,
      called,
      unknown,
      composite,
      unauthorized: {
        status: unauthorizedResponse.status,
        body: await unauthorizedResponse.json(),
      },
    };
  } finally {
    childLines.close();
    child.kill("SIGTERM");
  }
}

function event(sessionId, type, data) {
  write({
    jsonrpc: "2.0",
    method: "session.event",
    params: { sessionId, event: { type, seq: sequence++, time: Date.now(), data } },
  });
}

function status(sessionId, value) {
  write({ jsonrpc: "2.0", method: "session.status", params: { sessionId, status: value } });
}

function finish(reason = "completed") {
  const sessionId = activeSession;
  event(sessionId, "assistant/chunk", {
    turn: 1,
    step: 1,
    chunk: { type: "reasoning-delta", index: 0, text: "checking" },
  });
  event(sessionId, "tool/call", {
    turn: 1,
    step: 1,
    callId: "call-1",
    name: "mcp__homerail__handoff",
    arguments: JSON.stringify({ port: "done", content: "ok" }),
  });
  event(sessionId, "tool/result", {
    turn: 1,
    step: 1,
    message: {
      id: "tool-result-1",
      role: "user",
      content: [{
        type: "tool-result",
        toolCallId: "call-1",
        content: [{ type: "text", text: "accepted" }],
        isError: false,
      }],
      source: { kind: "tool", callId: "call-1" },
    },
  });
  event(sessionId, "assistant/chunk", {
    turn: 1,
    step: 1,
    chunk: { type: "text-delta", index: 1, text: "finished" },
  });
  event(sessionId, "assistant/message", {
    turn: 1,
    step: 1,
    message: {
      id: "assistant-1",
      role: "assistant",
      content: [{ type: "text", text: "finished" }],
      source: { kind: "model", provider: "deepseek-official", model: "test-model" },
    },
    usage: { inputTokens: 7, outputTokens: 3, cacheReadTokens: 2 },
  });
  event(sessionId, "turn/end", { turn: 1, reason });
  status(sessionId, "idle");
}

function startPrompt(params) {
  activeSession = String(params.sessionId);
  activeMessage = `message-${Date.now()}`;
  activePrompt = Array.isArray(params.contentBlocks) ? params.contentBlocks : [];
  return activeMessage;
}

lines.on("line", async (line) => {
  if (!line.trim()) return;
  const request = JSON.parse(line);
  if (request.method === "initialize") {
    if (process.env.DSH_FAKE_RECORD_FILE) {
      const providerProfiles = JSON.parse(process.env.HOMERAIL_DSH_PROVIDERS_JSON ?? "{}");
      const providerProfile = providerProfiles[request.params.provider];
      appendFileSync(process.env.DSH_FAKE_RECORD_FILE, `${JSON.stringify({
        params: request.params,
        cordisConfig: process.env.DSH_CORDIS_CONFIG,
        baseUrl: providerProfile?.baseURL,
        reasoningEffort: providerProfile?.reasoning,
        reasoningEfforts: providerProfile?.models?.[0]?.reasoningEfforts,
        apiKeyPresent: Boolean(process.env.HOMERAIL_DSH_API_KEY),
        managerToken: process.env.HOMERAIL_WORKER_TOKEN,
      })}\n`);
    }
    response(request.id, { serverInfo: { name: "deepseek-harness-sdk-runtime", version: "fake" } });
    return;
  }
  if (request.method === "session/prompt") {
    const messageId = startPrompt(request.params);
    if (process.env.DSH_FAKE_EXERCISE_MCP) {
      try {
        const mcp = await exerciseMcpBridge();
        if (process.env.DSH_FAKE_RECORD_FILE) {
          appendFileSync(process.env.DSH_FAKE_RECORD_FILE, `${JSON.stringify({ mcp })}\n`);
        }
      } catch (error) {
        write({
          jsonrpc: "2.0",
          id: request.id,
          error: { code: -32000, message: error instanceof Error ? error.message : String(error) },
        });
        return;
      }
    }
    response(request.id, { messageId });
    event(activeSession, "agent/inbox/spliced", {
      target: "next-turn",
      start: 0,
      inserted: [{ id: messageId, role: "user", content: activePrompt, source: { kind: "user" } }],
    });
    status(activeSession, "running");
    if (process.env.DSH_FAKE_READY_FILE) appendFileSync(process.env.DSH_FAKE_READY_FILE, "ready\n");
    if (!process.env.DSH_FAKE_WAIT_FOR) {
      finish(process.env.DSH_FAKE_TURN_ERROR
        ? {
            kind: "error",
            error: {
              code: "UPSTREAM_REJECTED",
              message: process.env.DSH_FAKE_TURN_ERROR,
              status: 502,
            },
          }
        : "completed");
    }
    return;
  }
  if (request.method === "session/steer") {
    response(request.id, { messageId: "steer-1" });
    if (process.env.DSH_FAKE_WAIT_FOR === "steer") finish();
    return;
  }
  if (request.method === "session/cancel") {
    if (process.env.DSH_FAKE_CANCEL_ERROR) {
      write({
        jsonrpc: "2.0",
        id: request.id,
        error: { code: -32000, message: process.env.DSH_FAKE_CANCEL_ERROR },
      });
      if (process.env.DSH_FAKE_WAIT_FOR === "cancel") setTimeout(() => finish("cancelled"), 20);
      return;
    }
    response(request.id, { accepted: true });
    if (process.env.DSH_FAKE_WAIT_FOR === "cancel") finish("cancelled");
    return;
  }
  if (request.method === "shutdown") {
    response(request.id, {});
    setImmediate(() => process.exit(0));
    return;
  }
  write({ jsonrpc: "2.0", id: request.id, error: { code: -32601, message: "unknown method" } });
});
