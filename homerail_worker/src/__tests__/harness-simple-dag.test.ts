/**
 * Simple DAG proofs for release worker harnesses.
 *
 * These tests use protocol-level fixture binaries rather than real model
 * credentials. They prove the worker adapter boundary can receive a tool call
 * from the harness protocol and execute HomeRail's DAG handoff tool.
 */

import { mkdtempSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DagNodeConfig } from "homerail-protocol";
import { runPrompt, type PromptJob } from "../prompt-runner.js";
import { CodexAppServerAdapter } from "../agent/codex-appserver.js";
import { KimiCodeAdapter } from "../agent/kimi-code.js";
import { registerAgentBackend } from "../agent/factory.js";

function makeConfig(agentType: string): DagNodeConfig {
  return {
    node_id: "coder",
    agent_type: agentType,
    model: "fixture-model",
    outgoing_edges: [
      { from_port: "done", to_node: "tester", to_port: "in" },
    ],
    incoming_edges: [],
    graph_nodes: ["coder", "tester"],
  };
}

function makeJob(agentType: string): PromptJob {
  return {
    task: "Call handoff with port done and content ok.",
    sender: "fixture",
    runId: `run-${agentType}`,
    dagConfig: makeConfig(agentType),
    llmProvider: "fixture",
    llmApiKey: "fixture-key",
    llmBaseUrl: "http://127.0.0.1:1/v1",
  };
}

function parseMessages(sent: string[]): Array<Record<string, unknown>> {
  return sent.map((line) => JSON.parse(line) as Record<string, unknown>);
}

function expectHandoff(sent: string[], runId: string): void {
  const parsed = parseMessages(sent);
  const response = parsed.find((msg) => {
    const data = msg.data as Record<string, unknown> | undefined;
    return msg.type === "response" && data?.type === "node_handoff";
  });
  expect(response, JSON.stringify(parsed, null, 2)).toBeDefined();
  expect(response?.session_id).toBe(runId);
  expect(response?.data).toMatchObject({
    type: "node_handoff",
    runId,
    nodeId: "coder",
    from_node: "coder",
    from_port: "done",
    port: "done",
  });
  expect(parsed.map((msg) => msg.type)).toContain("SESSION_END");
  expect(parsed.map((msg) => msg.type)).not.toContain("node_error");
}

function writeExecutable(dir: string, name: string, source: string): string {
  const file = join(dir, name);
  writeFileSync(file, source, "utf8");
  chmodSync(file, 0o755);
  return file;
}

function writeCodexFixture(dir: string): string {
  if (process.platform !== "win32") {
    return writeExecutable(dir, "codex", codexFixtureSource());
  }

  const script = writeExecutable(dir, "codex-fixture.js", codexFixtureSource());
  const shim = join(dir, "codex.cmd");
  writeFileSync(shim, `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`, "utf8");
  return join(dir, "codex");
}

function kimiFixtureSource(): string {
  return `#!/usr/bin/env node
const { spawn } = require("node:child_process");
const readline = require("node:readline");
if (process.argv.includes("--version")) {
  console.log("kimi-code fixture 0.0.0");
  process.exit(0);
}
if (!process.argv.includes("acp")) {
  console.error("expected acp");
  process.exit(2);
}
process.stdin.resume();
const rl = readline.createInterface({ input: process.stdin });
const keepAlive = setInterval(() => {}, 1000);
let mcpServer = null;
function send(msg) { process.stdout.write(JSON.stringify(msg) + "\\n"); }

async function callMcp(server) {
  if (!server) throw new Error("MCP server was not registered");
  const env = { ...process.env };
  for (const entry of server.env || []) env[entry.name] = entry.value;
  const child = spawn(server.command, server.args, { env, stdio: ["pipe", "pipe", "pipe"] });
  const childRl = readline.createInterface({ input: child.stdout });
  const pending = new Map();
  let requestId = 0;
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf-8"); });
  childRl.on("line", (line) => {
    const msg = JSON.parse(line);
    const waiter = pending.get(msg.id);
    if (!waiter) return;
    pending.delete(msg.id);
    if (msg.error) waiter.reject(new Error(msg.error.message));
    else waiter.resolve(msg.result);
  });
  child.on("error", (err) => {
    for (const waiter of pending.values()) waiter.reject(err);
    pending.clear();
  });
  function request(method, params) {
    const id = ++requestId;
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\\n");
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (pending.delete(id)) reject(new Error("MCP request timed out: " + method + " stderr=" + stderr));
      }, 5000);
    });
  }
  await request("initialize", { protocolVersion: "2024-11-05", capabilities: {} });
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }) + "\\n");
  await request("tools/list", {});
  await request("tools/call", {
    name: "handoff",
    arguments: { port: "done", content: { ok: true }, summary: "ok" },
  });
  child.kill("SIGTERM");
}

rl.on("line", async (line) => {
  const req = JSON.parse(line);
  if (req.method === "initialize") {
    send({ jsonrpc: "2.0", id: req.id, result: { protocolVersion: 1, agentCapabilities: {} } });
  } else if (req.method === "session/new") {
    mcpServer = req.params.mcpServers[0];
    send({ jsonrpc: "2.0", id: req.id, result: { sessionId: "kimi-session-1" } });
  } else if (req.method === "session/prompt") {
    try {
      await callMcp(mcpServer);
      send({ jsonrpc: "2.0", id: req.id, result: { stopReason: "end_turn" } });
      clearInterval(keepAlive);
    } catch (err) {
      send({ jsonrpc: "2.0", id: req.id, error: { code: -32000, message: err.message } });
      clearInterval(keepAlive);
    }
  }
});
`;
}

function codexFixtureSource(): string {
  return `#!/usr/bin/env node
const readline = require("node:readline");
if (process.argv.includes("--version")) {
  console.log("codex fixture 0.0.0");
  process.exit(0);
}
if (!process.argv.includes("app-server")) {
  console.error("expected app-server");
  process.exit(2);
}
process.stdin.resume();
const rl = readline.createInterface({ input: process.stdin });
const keepAlive = setInterval(() => {}, 1000);
const forceExit = setTimeout(() => process.exit(0), 30000);
forceExit.unref();
let dynamicToolsSeen = false;
function send(msg) { process.stdout.write(JSON.stringify(msg) + "\\n"); }
function shutdown() {
  clearInterval(keepAlive);
  clearTimeout(forceExit);
  process.exit(0);
}
process.stdin.on("end", shutdown);
rl.on("close", shutdown);
rl.on("line", (line) => {
  const req = JSON.parse(line);
  if (req.method === "initialize") {
    send({ jsonrpc: "2.0", id: req.id, result: { userAgent: "fixture", codexHome: "/tmp/codex", platformFamily: "unix", platformOs: "linux" } });
  } else if (req.method === "thread/start") {
    const specs = req.params.dynamicTools || [];
    dynamicToolsSeen = specs.some((tool) => tool.name === "handoff");
    send({ jsonrpc: "2.0", id: req.id, result: { thread: { id: "thread-1" } } });
  } else if (req.method === "turn/start") {
    if (!dynamicToolsSeen) {
      send({ jsonrpc: "2.0", id: req.id, error: { code: -32602, message: "handoff tool not registered" } });
      return;
    }
    send({ jsonrpc: "2.0", id: req.id, result: { turn: { id: "turn-1", items: [], itemsView: "all", status: "running", error: null, startedAt: 0, completedAt: null, durationMs: null } } });
    setTimeout(() => {
      send({
        jsonrpc: "2.0",
        id: 900,
        method: "item/tool/call",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          callId: "codex-tool-1",
          namespace: null,
          tool: "handoff",
          arguments: { port: "done", content: { ok: true }, summary: "ok" },
        },
      });
    }, 5);
  } else if (req.id === 900) {
    send({ jsonrpc: "2.0", method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-1", items: [], itemsView: "all", status: "completed", error: null, startedAt: 0, completedAt: 1, durationMs: 1 } } });
  } else if (req.method === "thread/unsubscribe") {
    send({ jsonrpc: "2.0", id: req.id, result: {} });
    shutdown();
  }
});
`;
}

describe.sequential("release harness simple DAG handoff", () => {
  let tempDir: string | null = null;

  afterEach(() => {
    vi.unstubAllEnvs();
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
      tempDir = null;
    }
  });

  it("runs a simple DAG handoff through kimi_code ACP", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "homerail-kimi-fixture-"));
    const kimiBin = writeExecutable(tempDir, "kimi", kimiFixtureSource());
    vi.stubEnv("HOMERAIL_HOME", tempDir);
    registerAgentBackend("fixture-kimi-code", () => new KimiCodeAdapter(kimiBin));

    const sent: string[] = [];
    await runPrompt(makeJob("kimi_code"), {
      agentBackend: "fixture-kimi-code",
      wsSend: (data) => sent.push(data),
    });

    expectHandoff(sent, "run-kimi_code");
  });

  it("runs a simple DAG handoff through codex_appserver", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "homerail-codex-fixture-"));
    const codexBin = writeCodexFixture(tempDir);
    vi.stubEnv("HOMERAIL_HOME", tempDir);
    registerAgentBackend("fixture-codex-appserver", () => new CodexAppServerAdapter(codexBin));

    const sent: string[] = [];
    await runPrompt(makeJob("codex_appserver"), {
      agentBackend: "fixture-codex-appserver",
      wsSend: (data) => sent.push(data),
    });

    expectHandoff(sent, "run-codex_appserver");
  });
});
