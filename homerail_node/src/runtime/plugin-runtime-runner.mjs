#!/usr/bin/env node

/**
 * HomeRail Plugin Runtime image ABI.
 *
 * The outer process speaks Runtime RPC on stdin/stdout. Plugin entrypoints see
 * a smaller two-phase ABI and never receive Manager secrets, capability
 * tokens, upload URLs, or host paths.
 * @version 0.1.0
 */

import { spawn } from "node:child_process";

const MAX_INPUT_BYTES = 24 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 32 * 1024 * 1024;

function exactObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function readStdin() {
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.byteLength;
    if (size > MAX_INPUT_BYTES) throw new Error("Runtime RPC input is too large");
    chunks.push(Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

function parseInvocationArgs(argv) {
  const entrypointIndex = argv.indexOf("--entrypoint");
  if (entrypointIndex < 0 || !argv[entrypointIndex + 1]?.startsWith("/")) {
    throw new Error("--entrypoint requires an absolute container path");
  }
  const separator = argv.indexOf("--", entrypointIndex + 2);
  return {
    entrypoint: argv[entrypointIndex + 1],
    args: separator < 0 ? [] : argv.slice(separator + 1),
  };
}

async function invokeEntrypoint(config, payload) {
  const javascript = /\.(?:c?js|mjs)$/.test(config.entrypoint);
  const command = javascript ? process.execPath : config.entrypoint;
  const args = javascript ? [config.entrypoint, ...config.args] : [...config.args];
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    const killForSize = () => child.kill("SIGKILL");
    child.stdout.on("data", (chunk) => {
      stdoutBytes += chunk.byteLength;
      if (stdoutBytes > MAX_OUTPUT_BYTES) killForSize();
      else stdout.push(Buffer.from(chunk));
    });
    child.stderr.on("data", (chunk) => {
      stderrBytes += chunk.byteLength;
      if (stderrBytes <= 64 * 1024) stderr.push(Buffer.from(chunk));
    });
    child.on("error", reject);
    child.on("close", (code, signal) => {
      if (stdoutBytes > MAX_OUTPUT_BYTES) return reject(new Error("Plugin entrypoint output is too large"));
      if (code !== 0) {
        return reject(new Error(`Plugin entrypoint failed (${code ?? signal}): ${Buffer.concat(stderr).toString("utf8")}`));
      }
      try {
        resolve(JSON.parse(Buffer.concat(stdout).toString("utf8")));
      } catch {
        reject(new Error("Plugin entrypoint output is not JSON"));
      }
    });
    child.stdin.end(JSON.stringify(payload));
  });
}

function correlation(request) {
  const invocation = request.params?.authorization?.invocation;
  if (!exactObject(invocation)) throw new Error("Runtime RPC authorization is missing");
  return {
    invocation,
    request_id: invocation.request_id,
    request_digest: invocation.request_digest,
    binding: invocation.binding,
  };
}

function entrypointInput(request, phase) {
  const { invocation, request_id, request_digest } = correlation(request);
  const uploads = phase === "execute" && Array.isArray(request.params.artifact_uploads)
    ? request.params.artifact_uploads.map(({ token: _token, upload_url: _url, capability_id: _capability, ...declaration }) => declaration)
    : [];
  return {
    entrypoint_api_version: 1,
    phase,
    method: invocation.tool?.handler?.method,
    request_id,
    request_digest,
    arguments: invocation.arguments,
    effective_grants: invocation.policy?.effective_grants,
    artifact_declarations: uploads,
  };
}

function baseResult(request, method) {
  const { request_id, request_digest, binding } = correlation(request);
  return {
    runtime_rpc_version: 1,
    message_type: "result",
    method,
    rpc_id: request.rpc_id,
    completed_at: new Date().toISOString(),
    request_id,
    request_digest,
    binding,
    logs: [],
    artifacts: [],
  };
}

function validateEntrypointResponse(value, phase) {
  if (!exactObject(value) || value.entrypoint_api_version !== 1 || value.phase !== phase) {
    throw new Error(`Plugin entrypoint returned an invalid ${phase} envelope`);
  }
  return value;
}

async function handleRpc(request, config) {
  if (!exactObject(request) || request.runtime_rpc_version !== 1 || request.message_type !== "request") {
    throw new Error("Runtime RPC envelope is invalid");
  }
  if (request.method === "prepare") {
    const plugin = validateEntrypointResponse(
      await invokeEntrypoint(config, entrypointInput(request, "prepare")),
      "prepare",
    );
    if (!Array.isArray(plugin.artifact_declarations)) throw new Error("Plugin prepare result lacks artifact declarations");
    return {
      runner_rpc_version: 1,
      response: {
        ...baseResult(request, "prepare"),
        artifact_declarations: plugin.artifact_declarations,
        logs: Array.isArray(plugin.logs) ? plugin.logs : [],
      },
      broker_writes: [],
    };
  }
  if (request.method === "execute") {
    const plugin = validateEntrypointResponse(
      await invokeEntrypoint(config, entrypointInput(request, "execute")),
      "execute",
    );
    if (!exactObject(plugin.output) || !Array.isArray(plugin.artifacts) || !Array.isArray(plugin.broker_writes)) {
      throw new Error("Plugin execute result is missing output/artifacts/broker writes");
    }
    return {
      runner_rpc_version: 1,
      response: {
        ...baseResult(request, "execute"),
        output: plugin.output,
        artifacts: plugin.artifacts,
        logs: Array.isArray(plugin.logs) ? plugin.logs : [],
      },
      broker_writes: plugin.broker_writes,
    };
  }
  if (request.method === "health") {
    return {
      runtime_rpc_version: 1,
      message_type: "result",
      method: "health",
      rpc_id: request.rpc_id,
      completed_at: new Date().toISOString(),
      binding: request.params.binding,
      status: "ready",
      runtime_api: 1,
      started_at: new Date(Number(process.env.HOMERAIL_RUNTIME_STARTED_AT_MS ?? Date.now())).toISOString(),
      active_requests: 0,
      logs: [],
      artifacts: [],
    };
  }
  if (request.method === "cancel") {
    return {
      runtime_rpc_version: 1,
      message_type: "result",
      method: "cancel",
      rpc_id: request.rpc_id,
      completed_at: new Date().toISOString(),
      request_id: request.params.request_id,
      request_digest: request.params.request_digest,
      status: "not_found",
      logs: [],
      artifacts: [],
    };
  }
  throw new Error(`Unsupported Runtime RPC method: ${String(request.method)}`);
}

async function serve() {
  await new Promise((resolve) => {
    const keepalive = setInterval(() => {}, 60_000);
    const finish = () => {
      clearInterval(keepalive);
      resolve();
    };
    process.once("SIGTERM", finish);
    process.once("SIGINT", finish);
  });
}

async function main() {
  const mode = process.argv[2];
  if (mode === "--serve") return serve();
  if (mode !== "--rpc-once") throw new Error("expected --serve or --rpc-once");
  const config = parseInvocationArgs(process.argv.slice(3));
  const response = await handleRpc(await readStdin(), config);
  process.stdout.write(`${JSON.stringify(response)}\n`);
}

main().catch((cause) => {
  process.stderr.write(`${cause instanceof Error ? cause.stack : String(cause)}\n`);
  process.exitCode = 1;
});
