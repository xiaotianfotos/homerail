import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const capability = "native-codex-subscription";
const terminal = new Set(["completed", "failed", "cancelled", "aborted"]);
let interrupted = false;

export function parseOptions(argv) {
  const options = { execute: false, timeoutMs: 180_000 };
  const flags = new Map([["--codex-home", "codexHome"], ["--codex-bin", "codexBin"], ["--model", "model"],
    ["--reasoning-effort", "effort"], ["--output-dir", "outputDir"], ["--timeout-ms", "timeoutMs"], ["--goal-file", "goalFile"]]);
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    if (flag === "--execute") { options.execute = true; continue; }
    if (flag === "--help") { options.help = true; continue; }
    const key = flags.get(flag);
    if (!key || !argv[index + 1] || argv[index + 1].startsWith("--")) throw new Error(`Unknown or incomplete option: ${flag}`);
    options[key] = argv[++index];
  }
  options.timeoutMs = Number(options.timeoutMs);
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 10_000 || options.timeoutMs > 600_000) {
    throw new Error("timeout-ms must be between 10000 and 600000");
  }
  if (options.goalFile !== undefined && !path.isAbsolute(options.goalFile)) throw new Error("goalFile must be an explicit absolute path");
  if (options.execute) {
    for (const key of ["codexHome", "codexBin", "outputDir"]) {
      if (!options[key] || !path.isAbsolute(options[key])) throw new Error(`${key} must be an explicit absolute path`);
    }
    for (const key of ["model", "effort"]) {
      if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(options[key] ?? "")) throw new Error(`${key} must be an exact explicit identifier`);
    }
  }
  return options;
}

export function buildWorkflow(model, effort, id) {
  return {
    api_version: "homerail.ai/v1", kind: "Workflow", metadata: { id, name: "Native Codex subscription isolation smoke" },
    spec: {
      contracts: { Mission: { type: "string", minLength: 1, maxLength: 20_000 } },
      agents: { inspector: {
        native_subscription: { provider: "codex", model, reasoning_effort: effort },
        system: "Follow the supplied task using only read-only operations. Use the HomeRail handoff tool on port result with an object containing stage and token. Never modify files or use external services. A follow-up command takes priority over the initial task.",
      } },
      nodes: {
        inspect: {
          kind: "agent", agent: "inspector", codex_sandbox: "read-only", builtin_tool_policy: "backend_native",
          workspace_access: { writable_paths: [] }, inputs: { mission: { contract: "Mission" }, command: {} }, outputs: { result: {} },
        },
        suspend: {
          kind: "await_command", inputs: { result: {} },
          config: { primitive_version: 1, target_actors: ["inspect"], command_port: "command" },
        },
      },
      edges: [{ from: "$run.input", to: "inspect.mission" }, { from: "inspect.result", to: "suspend.result" }],
    },
  };
}

/** Fixed one-shot topology. Goal text never supplies workflow/runtime fields. */
export function buildGoalWorkflow(model, effort, id) {
  const workflow = buildWorkflow(model, effort, id);
  workflow.metadata.name = "Native Codex subscription read-only goal";
  workflow.spec.agents.inspector.system = "Complete the supplied goal using only read-only operations. Return your actual result with the HomeRail handoff tool on port result. Do not modify files or contact external services. If the goal cannot be completed within these restrictions, report the limitation truthfully in the handoff.";
  delete workflow.spec.nodes.inspect.inputs.command;
  delete workflow.spec.nodes.suspend;
  workflow.spec.nodes.done = { kind: "terminal", outcome: "success", inputs: { result: {} } };
  workflow.spec.edges = [{ from: "$run.input", to: "inspect.mission" }, { from: "inspect.result", to: "done.result" }];
  return workflow;
}

/** Read exactly the explicitly provided task file, preserving its UTF-8 text. */
export function readGoalFile(file) {
  if (typeof file !== "string" || !path.isAbsolute(file)) throw new Error("goalFile must be an explicit absolute path");
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > 80_000) throw new Error("goalFile must be a regular UTF-8 file no larger than 80000 bytes");
    const bytes = fs.readFileSync(fd);
    if (bytes.length > 80_000) throw new Error("goalFile exceeds its byte limit");
    // ignoreBOM:true means include a BOM in the decoded text rather than strip it.
    const goal = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    if (!goal.trim() || goal.length > 20_000 || goal.includes("\0")) throw new Error("goalFile must contain 1-20000 characters of nonempty task text without NUL");
    return goal;
  } finally { fs.closeSync(fd); }
}

/** Caller must validate the Flash route contract first and keep runtime options
 * local. This does not call Flash or interpret goal text as routing authority. */
export async function executeNativeGoal(options) {
  const allowed = new Set(["goalFile", "codexHome", "codexBin", "model", "effort", "outputDir", "timeoutMs"]);
  if (!options || typeof options !== "object" || Array.isArray(options)
    || Object.keys(options).some(key => !allowed.has(key))) throw new Error("Native goal options contain unsupported runtime fields");
  const argv = ["--execute"];
  for (const [key, flag] of [["goalFile", "--goal-file"], ["codexHome", "--codex-home"], ["codexBin", "--codex-bin"],
    ["model", "--model"], ["effort", "--reasoning-effort"], ["outputDir", "--output-dir"]]) {
    if (typeof options[key] !== "string" || !options[key]) throw new Error(`${key} is required`);
    argv.push(flag, options[key]);
  }
  if (options.timeoutMs !== undefined) argv.push("--timeout-ms", String(options.timeoutMs));
  return executeSmoke(parseOptions(argv));
}

function privateWrite(file, data) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(data, null, 2) + "\n", { mode: 0o600, flag: "wx" });
    fs.renameSync(temporary, file);
  } finally { fs.rmSync(temporary, { force: true }); }
}

function digest(value) { return createHash("sha256").update(value).digest("hex"); }

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const port = server.address().port;
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}

function childEnv(home) {
  const env = {};
  for (const key of ["PATH", "HOME", "LANG", "LC_ALL", "TMPDIR", "TZ"]) if (process.env[key]) env[key] = process.env[key];
  env.HOMERAIL_HOME = home;
  return env;
}

function launch(entry, env) {
  if (interrupted) throw new Error("Smoke interrupted");
  assert(fs.statSync(entry).isFile(), "Build Manager, Node and Worker before executing this smoke");
  // Discard provider/config output; evidence is assembled from allowlisted fields.
  const child = spawn(process.execPath, [entry], { cwd: repoRoot, env, stdio: "ignore", shell: false });
  child.once("error", () => { child.smokeStartFailed = true; });
  return child;
}

async function stop(child) {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise(resolve => child.once("exit", resolve));
  child.kill("SIGTERM");
  let timer;
  await Promise.race([exited, new Promise(resolve => { timer = setTimeout(resolve, 15_000); })]);
  clearTimeout(timer);
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  await exited;
}

async function waitFor(label, action, timeoutMs, children = []) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (interrupted) throw new Error("Smoke interrupted");
    if (children.some(child => child.smokeStartFailed || child.exitCode !== null || child.signalCode !== null)) throw new Error(`${label}: isolated service exited`);
    const value = await action();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  throw new Error(`${label}: timed out`);
}

async function request(baseUrl, route, body) {
  if (interrupted && !route.endsWith("/cancel")) throw new Error("Smoke interrupted");
  const response = await fetch(baseUrl + route, {
    method: body === undefined ? "GET" : "POST",
    ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`${body === undefined ? "GET" : "POST"} ${route}: HTTP ${response.status}`);
  const result = await response.json();
  if (result.success === false) throw new Error(`${route}: operation rejected`);
  return result.data ?? result;
}

function filesBelow(root) {
  if (!fs.existsSync(root)) return [];
  const result = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const file = path.join(root, entry.name);
    if (entry.isDirectory()) result.push(...filesBelow(file));
    else if (entry.isFile()) result.push(file);
  }
  return result;
}

function nativeEvents(home, runId) {
  const auditRoot = path.join(home, "node", "runtime", "native_codex_subscription", "audit");
  const events = [];
  for (const file of filesBelow(auditRoot).filter(file => path.basename(file) === `${runId}.jsonl`)) {
    for (const line of fs.readFileSync(file, "utf8").split("\n").filter(Boolean)) {
      let event;
      try { event = JSON.parse(line); } catch { continue; } // A currently appending final line may be incomplete.
      if (event.event !== "agent_debug" || !["appserver_start", "thread_created", "thread_resumed", "turn_started", "turn_completed", "appserver_done"].includes(event.message)) continue;
      events.push({ event: event.message, ts: event.ts, thread_id: event.data?.thread_id, turn_id: event.data?.turn_id,
        persistent: event.data?.persistent, billing: event.data?.billing });
    }
  }
  return events.sort((left, right) => left.ts - right.ts);
}

function nativeSessions(home) {
  const stateDir = path.join(home, "node", "runtime", "native_codex_subscription", "sessions");
  return filesBelow(stateDir).filter(file => file.endsWith(".json")).map(file => {
    const record = JSON.parse(fs.readFileSync(file, "utf8"));
    return { file: path.basename(file), thread_id: record.threadId, binding: record.binding };
  });
}

function evidenceHandoffs(handoffs) {
  return handoffs.map(item => ({ node: item.fromNode ?? item.from_node, port: item.port ?? item.fromPort ?? item.from_port,
    content_digest: digest(JSON.stringify(item.content ?? null)), nonempty: item.content !== undefined && item.content !== null && item.content !== "" }));
}

export async function executeSmoke(options) {
  const oneShot = options.goalFile !== undefined;
  const goal = oneShot ? readGoalFile(options.goalFile) : undefined;
  interrupted = false;
  const onInterrupt = () => { interrupted = true; };
  process.once("SIGINT", onInterrupt);
  process.once("SIGTERM", onInterrupt);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "homerail-native-subscription-smoke-"));
  fs.mkdirSync(options.outputDir, { recursive: true, mode: 0o700 });
  const evidencePath = path.join(options.outputDir, `native-subscription-${oneShot ? "goal-" : ""}${Date.now()}-${randomUUID()}.json`);
  const evidence = { schema: oneShot ? "homerail.native-subscription-goal/v1" : "homerail.native-subscription-smoke/v1",
    mode: oneShot ? "one_shot" : "smoke", execution_mode: "native_codex_subscription",
    started_at: new Date().toISOString(), home, result_path: evidencePath,
    requested_model: options.model, requested_reasoning_effort: options.effort, passed: false, checks: {},
    ...(oneShot ? { goal_sha256: digest(Buffer.from(goal, "utf8")), handoffs: [] } : {}) };
  let manager, node;
  let stage = "initialize";
  let baseUrl;
  const activeRuns = new Set();
  const checkpoint = () => privateWrite(evidencePath, evidence);
  checkpoint();
  try {
    const port = await freePort();
    baseUrl = `http://127.0.0.1:${port}`;
    evidence.manager_url = baseUrl;
    const env = childEnv(home);
    const workerToken = randomUUID();
    stage = "start_manager";
    manager = launch(path.join(repoRoot, "homerail_manager", "dist", "index.js"), {
      ...env, HOMERAIL_MANAGER_HOST: "127.0.0.1", HOMERAIL_MANAGER_PORT: String(port), HOMERAIL_WORKER_TOKEN: workerToken,
    });
    await waitFor(stage, async () => { try { return (await fetch(baseUrl + "/health", { signal: AbortSignal.timeout(1000) })).ok; } catch { return false; } }, 30_000, [manager]);
    stage = "start_node";
    node = launch(path.join(repoRoot, "homerail_node", "dist", "cli.js"), {
      ...env, HOMERAIL_MANAGER_WS_URL: `ws://127.0.0.1:${port}`, HOMERAIL_PROJECT_ID: "p1",
      HOMERAIL_NODE_ID: "native-subscription-smoke-node", HOMERAIL_NODE_PROVIDER: "mock",
      HOMERAIL_CODEX_SUBSCRIPTION_ENABLED: "1", HOMERAIL_CODEX_SUBSCRIPTION_HOME: options.codexHome,
      HOMERAIL_CODEX_SUBSCRIPTION_BIN: options.codexBin,
      HOMERAIL_CODEX_SUBSCRIPTION_WORKER_ENTRY: path.join(repoRoot, "homerail_worker", "dist", "index.js"),
    });
    await waitFor(stage, async () => (await request(baseUrl, "/api/nodes")).nodes?.some(item => item.node_id === "native-subscription-smoke-node" && item.capabilities?.includes(capability)), 30_000, [manager, node]);
    evidence.checks.native_node_registered = true;
    const workflowId = `native-subscription-smoke-${Date.now()}`;
    stage = "sync_workflow";
    const workflow = oneShot ? buildGoalWorkflow(options.model, options.effort, workflowId) : buildWorkflow(options.model, options.effort, workflowId);
    await request(baseUrl, "/api/dag/workflows/sync", { yaml_text: JSON.stringify(workflow), source_path: "scripts/native-codex-subscription-smoke.mjs" });
    if (oneShot) {
      const runId = `native-goal-${randomUUID()}`;
      evidence.run_id = runId;
      activeRuns.add(runId);
      stage = "execute_native_goal";
      // No rewriting, router invocation, model profile or runtime field comes from the file.
      await request(baseUrl, "/api/runs/create-and-run", { workflow_id: workflowId, runId, prompt: goal });
      const snapshot = await waitFor("goal_terminal", async () => {
        const current = await request(baseUrl, `/api/runs/${runId}/status`);
        return terminal.has(current.status) ? current : false;
      }, options.timeoutMs, [manager, node]);
      activeRuns.delete(runId);
      evidence.terminal_status = snapshot.status;
      evidence.terminal = snapshot.terminal === true;
      evidence.handoffs = (await request(baseUrl, `/api/runs/${runId}/handoffs`)).handoffs;
      const nonempty = value => value !== null && value !== undefined && (
        typeof value === "string" ? value.trim().length > 0 : typeof value === "object" ? Object.keys(value).length > 0 : true);
      evidence.checks.nonempty_handoff = evidence.handoffs.some(item => item.fromNode === "inspect" && item.port === "result" && nonempty(item.content));
      const metadata = await request(baseUrl, `/api/runs/${runId}`);
      evidence.creation_request_digest = metadata.creationRequestDigest;
      checkpoint();
      assert.equal(snapshot.status, "completed", "Native goal must reach a completed terminal");
      assert.equal(snapshot.terminal, true, "Manager must attest that the goal run is terminal");
      assert(evidence.checks.nonempty_handoff, "Native goal must return a nonempty actual Worker handoff");
      const stateDir = path.join(home, "node", "runtime", "native_codex_subscription", "sessions");
      await waitFor("goal_native_session_released", async () => !filesBelow(stateDir).some(file => file.endsWith(".lock")), 20_000, [manager, node]);
      evidence.native_events = nativeEvents(home, runId);
      evidence.native_sessions = nativeSessions(home);
      evidence.passed = true;
      return evidence;
    }
    const runId = `native-smoke-${Date.now()}`;
    const workspace = path.join(home, "workspace", runId);
    fs.mkdirSync(workspace, { recursive: true, mode: 0o700 });
    const marker = `native-history-${randomUUID()}`;
    const fixture = path.join(workspace, "fixture.txt");
    fs.writeFileSync(fixture, marker + "\n", { mode: 0o400 });
    const fixtureDigest = digest(fs.readFileSync(fixture));
    const creation = { workflow_id: workflowId, runId, prompt: "Read fixture.txt in the current workspace. Remember its exact single-line token in this native session. Hand off result {stage:'read',token:<file token>}. Do not write any files." };
    activeRuns.add(runId);
    evidence.run_id = runId;
    stage = "first_native_turn";
    await request(baseUrl, "/api/runs/create-and-run", creation);
    const status = id => request(baseUrl, `/api/runs/${id}/status`);
    const waitWaiting = async (id, previousRound) => await waitFor("waiting_after_handoff", async () => {
      const snapshot = await status(id);
      if (terminal.has(snapshot.status)) throw new Error(`Run terminated before waiting: ${snapshot.status}`);
      return snapshot.status === "waiting" && (!previousRound || snapshot.current_round?.round_id !== previousRound) ? snapshot : false;
    }, options.timeoutMs, [manager, node]);
    const first = await waitWaiting(runId);
    const firstHandoffs = (await request(baseUrl, `/api/runs/${runId}/handoffs`)).handoffs;
    assert(firstHandoffs.some(item => JSON.stringify(item.content).includes(marker)), "First real handoff must contain the fixture token");
    evidence.checks.first_handoff = evidenceHandoffs(firstHandoffs);
    const actors = (await request(baseUrl, `/api/runs/${runId}/actors`)).actors;
    assert.equal(actors.length, 1, "Smoke workflow must expose exactly one logical actor");
    const actor = actors[0];
    assert(actor?.actor_id, "Manager must expose the real logical actor");
    checkpoint();
    stage = "resume_native_history";
    const stateDir = path.join(home, "node", "runtime", "native_codex_subscription", "sessions");
    await waitFor("first_native_session_released", async () => !filesBelow(stateDir).some(file => file.endsWith(".lock")), 20_000, [manager, node]);
    await request(baseUrl, `/api/runs/${runId}/commands`, { expected_round_id: first.current_round.round_id,
      commands: [{ actor_id: actor.actor_id, command_id: `resume-${randomUUID()}`, payload: "Recall the exact fixture token from your previous native conversation; do not read files again. Hand off result {stage:'resume',token:<remembered token>}." }] });
    const second = await waitWaiting(runId, first.current_round.round_id);
    await waitFor("resumed_native_session_released", async () => !filesBelow(stateDir).some(file => file.endsWith(".lock")), 20_000, [manager, node]);
    assert.notEqual(second.current_round.round_id, first.current_round.round_id, "Follow-up must create a distinct Manager round");
    const secondHandoffs = (await request(baseUrl, `/api/runs/${runId}/handoffs`)).handoffs;
    assert(secondHandoffs.length > firstHandoffs.length, "Resume must emit another real handoff");
    assert(secondHandoffs.slice(firstHandoffs.length).some(item => JSON.stringify(item.content).includes(marker)), "Resumed handoff must contain the original token");
    const resumedEvents = await waitFor("native_resume_evidence", async () => {
      const events = nativeEvents(home, runId);
      return events.some(item => item.event === "thread_resumed") ? events : false;
    }, 10_000, [manager, node]);
    const createdThread = resumedEvents.find(item => item.event === "thread_created")?.thread_id;
    assert(createdThread && resumedEvents.some(item => item.event === "thread_resumed" && item.thread_id === createdThread), "Native resume must retain the original thread ID");
    assert(resumedEvents.filter(item => item.event === "appserver_start").length >= 2, "Resume must survive separate native app-server launches");
    assert(nativeSessions(home).some(item => item.thread_id === createdThread), "Persisted session mapping must retain the native thread");
    evidence.checks.native_history_resume = { thread_id: createdThread, events: resumedEvents, sessions: nativeSessions(home) };
    stage = "complete_and_deduplicate";
    await request(baseUrl, `/api/runs/${runId}/complete`, { expected_round_id: second.current_round.round_id });
    const completed = await status(runId);
    assert.equal(completed.status, "completed");
    activeRuns.delete(runId);
    const metadata = await request(baseUrl, `/api/runs/${runId}`);
    assert.match(metadata.creationRequestDigest, /^[a-f0-9]{64}$/);
    await request(baseUrl, "/api/runs/create-and-run", creation);
    const duplicate = await request(baseUrl, `/api/runs/${runId}`);
    assert.equal(duplicate.creationRequestDigest, metadata.creationRequestDigest);
    assert.equal(duplicate.status, "completed");
    const repeatedHandoffs = (await request(baseUrl, `/api/runs/${runId}/handoffs`)).handoffs;
    assert.equal(repeatedHandoffs.length, secondHandoffs.length);
    evidence.checks.terminal_handoff = { status: completed.status, handoffs: evidenceHandoffs(repeatedHandoffs) };
    evidence.checks.run_id_deduplication = { creation_request_digest: metadata.creationRequestDigest, handoff_count_unchanged: true };
    assert.equal(digest(fs.readFileSync(fixture)), fixtureDigest, "Read-only fixture must be unchanged");
    evidence.checks.fixture_unchanged = true;
    checkpoint();
    stage = "cancel_active_native_turn";
    const cancelId = `native-cancel-${Date.now()}`;
    evidence.cancel_run_id = cancelId;
    activeRuns.add(cancelId);
    await request(baseUrl, "/api/runs/create-and-run", { workflow_id: workflowId, runId: cancelId,
      prompt: "This is a cancellation smoke. Use a read-only shell command to sleep for 60 seconds, then hand off result {stage:'cancel_probe',token:'done'}. Do not write any files." });
    await waitFor("cancel_turn_started", async () => {
      const snapshot = await status(cancelId);
      if (terminal.has(snapshot.status) || snapshot.status === "waiting") throw new Error("Cancellation probe finished before cancellation");
      return nativeEvents(home, cancelId).some(item => item.event === "turn_started");
    }, options.timeoutMs, [manager, node]);
    await request(baseUrl, `/api/runs/${cancelId}/cancel`, {});
    const cancelled = await waitFor("cancelled_terminal", async () => { const snapshot = await status(cancelId); return snapshot.status === "cancelled" ? snapshot : false; }, 20_000, [manager, node]);
    activeRuns.delete(cancelId);
    await waitFor("native_session_leases_released", async () => !filesBelow(stateDir).some(file => file.endsWith(".lock")), 20_000, [manager, node]);
    evidence.checks.cancel = { status: cancelled.status, events: nativeEvents(home, cancelId), session_leases_released: true };
    evidence.passed = true;
  } catch (error) {
    evidence.failure = { stage, message: error instanceof Error ? error.message : "smoke failed" };
    process.exitCode = 1;
  } finally {
    if (baseUrl) for (const runId of activeRuns) { try { await request(baseUrl, `/api/runs/${runId}/cancel`, {}); } catch {} }
    await stop(node);
    await stop(manager);
    process.removeListener("SIGINT", onInterrupt);
    process.removeListener("SIGTERM", onInterrupt);
    evidence.finished_at = new Date().toISOString();
    checkpoint();
    console.log(JSON.stringify({ passed: evidence.passed, evidence: evidencePath, retained_isolated_home: home }));
  }
  return evidence;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const options = parseOptions(process.argv.slice(2));
  if (options.help || !options.execute) {
    console.log("No services started. To execute: node scripts/native-codex-subscription-smoke.mjs --execute --codex-home /absolute/.codex --codex-bin /absolute/codex --model EXACT --reasoning-effort EXACT --output-dir /absolute/evidence [--timeout-ms 180000] [--goal-file /absolute/validated-goal.txt]\nWithout --goal-file: full smoke. With --goal-file: one actual read-only goal; the caller must first validate its restricted route contract.");
  } else await executeSmoke(options);
}
