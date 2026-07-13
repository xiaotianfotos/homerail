import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workflow = `
api_version: homerail.ai/v1
kind: Workflow
metadata:
  id: run-artifact-live-smoke
  name: Run Artifact Live Smoke
spec:
  workspace: { mode: shared }
  artifacts:
    - name: evidence.tar.gz
      source: { type: workspace, path: evidence, produced_by: approve }
      archive: { format: tar.gz, deterministic: true }
      required: true
      publish: always
      limits:
        max_files: 100
        max_uncompressed_bytes: 1048576
        max_compressed_bytes: 1048576
        timeout_ms: 30000
  agents: {}
  nodes:
    approve:
      kind: approval
      outputs: { approved: {}, rejected: {} }
      config:
        approval_id: package-evidence
        proposer_actor: smoke:producer
        authorized_actors: [smoke:operator]
        approved_port: approved
        rejected_port: rejected
    complete: { kind: terminal, outcome: success, inputs: { result: {} } }
    rejected: { kind: terminal, outcome: failure, inputs: { result: {} } }
  edges:
    - { from: approve.approved, to: complete.result }
    - { from: approve.rejected, to: rejected.result, condition: on_failure }
`;

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("failed to allocate a local port"));
        return;
      }
      const port = address.port;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

function startProcess(command, args, env) {
  const child = spawn(command, args, {
    cwd: repoRoot,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const output = [];
  const capture = (chunk) => {
    output.push(chunk.toString());
    if (output.length > 200) output.shift();
  };
  child.stdout.on("data", capture);
  child.stderr.on("data", capture);
  return { child, output };
}

async function stopProcess(processInfo) {
  if (!processInfo || processInfo.child.exitCode !== null) return;
  processInfo.child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => processInfo.child.once("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, 2_000)),
  ]);
  if (processInfo.child.exitCode === null) processInfo.child.kill("SIGKILL");
}

async function requestJson(baseUrl, pathname, init = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, init);
  const text = await response.text();
  let body;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { message: text };
  }
  if (!response.ok) throw new Error(`${init.method ?? "GET"} ${pathname} failed (${response.status}): ${body.message ?? text}`);
  return body;
}

async function waitFor(description, operation, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() <= deadline) {
    try {
      const value = await operation();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`${description} timed out${lastError ? `: ${lastError.message}` : ""}`);
}

function parseTar(compressed) {
  const tar = gunzipSync(compressed);
  const entries = new Map();
  let offset = 0;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const field = (start, length) => header.subarray(start, start + length).toString("utf8").replace(/\0.*$/, "");
    const prefix = field(345, 155);
    const leaf = field(0, 100);
    const name = prefix ? `${prefix}/${leaf}` : leaf;
    const size = Number.parseInt(field(124, 12).trim() || "0", 8);
    const start = offset + 512;
    entries.set(name, Buffer.from(tar.subarray(start, start + size)));
    offset = start + Math.ceil(size / 512) * 512;
  }
  return entries;
}

async function runCli(args, env) {
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(repoRoot, "homerail_cli", "dist", "cli.js"), ...args], {
      cwd: repoRoot,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`CLI exited ${code}: ${stderr || stdout}`));
    });
  });
}

const home = fs.mkdtempSync(path.join(os.tmpdir(), "homerail-artifact-live-"));
let manager;
let node;
try {
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const managerEnv = {
    HOMERAIL_HOME: home,
    HOMERAIL_MANAGER_HOST: "127.0.0.1",
    HOMERAIL_MANAGER_PORT: String(port),
  };
  manager = startProcess(process.execPath, [path.join(repoRoot, "homerail_manager", "dist", "index.js")], managerEnv);
  await waitFor("Manager health", async () => {
    const response = await fetch(`${baseUrl}/health`);
    return response.ok;
  });

  node = startProcess(process.execPath, [path.join(repoRoot, "homerail_node", "dist", "cli.js")], {
    HOMERAIL_HOME: home,
    HOMERAIL_MANAGER_WS_URL: `ws://127.0.0.1:${port}`,
    HOMERAIL_PROJECT_ID: "p1",
    HOMERAIL_NODE_ID: "artifact-smoke-node",
    HOMERAIL_NODE_PROVIDER: "mock",
  });
  await waitFor("Node registration", async () => {
    const body = await requestJson(baseUrl, "/api/nodes");
    return body.data?.nodes?.some((candidate) =>
      candidate.node_id === "artifact-smoke-node" &&
      Array.isArray(candidate.capabilities) &&
      candidate.capabilities.includes("workspace-artifacts")
    );
  });

  await requestJson(baseUrl, "/api/dag/workflows/sync", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ yaml_text: workflow, source_path: "scripts/run-artifact-live-smoke.mjs" }),
  });

  const runId = `artifact-live-${Date.now()}`;
  const evidence = path.join(home, "workspace", runId, "evidence");
  fs.mkdirSync(path.join(evidence, "nested"), { recursive: true });
  fs.writeFileSync(path.join(evidence, "result.json"), "{\"status\":\"verified\"}\n");
  fs.writeFileSync(path.join(evidence, "nested", "notes.md"), "# Evidence\n\nNode-owned directory archive.\n");

  await requestJson(baseUrl, "/api/runs/create-and-run", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ workflow_id: "run-artifact-live-smoke", runId, prompt: "package evidence" }),
  });
  const approval = await waitFor("approval request", async () => {
    const body = await requestJson(baseUrl, "/api/dag/approvals");
    return body.data?.approvals?.find((candidate) => candidate.run_id === runId);
  });
  await requestJson(baseUrl, `/api/runs/${encodeURIComponent(runId)}/node/approve/approval`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      decision: "approved",
      actor: "smoke:operator",
      proposal_hash: approval.proposal_hash,
    }),
  });

  const artifact = await waitFor("artifact upload", async () => {
    const body = await requestJson(baseUrl, `/api/runs/${encodeURIComponent(runId)}/artifacts`);
    const candidate = body.data?.artifacts?.find((entry) => entry.name === "evidence.tar.gz");
    if (candidate?.status === "failed") throw new Error(candidate.error?.message ?? "artifact failed");
    return candidate?.status === "ready" ? candidate : undefined;
  }, 40_000);

  const cliEnv = { HOMERAIL_HOME: home };
  const listed = await runCli(["--base-url", baseUrl, "dag", "artifacts", runId], cliEnv);
  const download = path.join(home, "downloaded-evidence.tar.gz");
  const fetched = await runCli([
    "--base-url", baseUrl,
    "dag", "artifact", runId, "evidence.tar.gz",
    "--output", download,
  ], cliEnv);
  const downloaded = fs.readFileSync(download);
  const sha256 = createHash("sha256").update(downloaded).digest("hex");
  if (sha256 !== artifact.sha256) throw new Error("downloaded archive SHA-256 does not match Manager metadata");
  const entries = parseTar(downloaded);
  if (entries.get("evidence/result.json")?.toString() !== "{\"status\":\"verified\"}\n") {
    throw new Error("downloaded archive is missing evidence/result.json");
  }
  if (!entries.has("evidence/nested/notes.md")) throw new Error("downloaded archive is missing nested Markdown evidence");

  console.log(JSON.stringify({
    run_id: runId,
    node_id: "artifact-smoke-node",
    artifact: {
      name: artifact.name,
      status: artifact.status,
      size_bytes: artifact.size_bytes,
      uncompressed_bytes: artifact.uncompressed_bytes,
      file_count: artifact.file_count,
      sha256: artifact.sha256,
    },
    archive_entries: [...entries.keys()],
    cli_list: listed.stdout.trim(),
    cli_download: fetched.stdout.trim(),
  }, null, 2));
} catch (error) {
  const managerLog = manager?.output.join("") ?? "";
  const nodeLog = node?.output.join("") ?? "";
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  if (managerLog) console.error(`\nManager log:\n${managerLog.slice(-8_000)}`);
  if (nodeLog) console.error(`\nNode log:\n${nodeLog.slice(-8_000)}`);
  process.exitCode = 1;
} finally {
  await stopProcess(node);
  await stopProcess(manager);
  if (process.env.HOMERAIL_KEEP_ARTIFACT_SMOKE_HOME === "1") {
    console.error(`kept smoke HOMERAIL_HOME at ${home}`);
  } else {
    fs.rmSync(home, { recursive: true, force: true });
  }
}
