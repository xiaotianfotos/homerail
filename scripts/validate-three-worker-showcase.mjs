#!/usr/bin/env node

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { observeRunProgress } from "./live-run-progress.mjs";
import {
  DEFAULT_INTERVENTION_ACTOR_ID,
  EXPECTED_ACTOR_IDS,
  SHOWCASE_PROFILE_ID,
  SHOWCASE_SCENARIO,
  SHOWCASE_STATE_SCHEMA_VERSION,
  activityConcurrencyEvidence,
  activityRoundFailures,
  actorSnapshotEvidence,
  actorSnapshotFailures,
  analyzeModelDispatches,
  analyzeSurfaceSnapshot,
  branchIsolationFailures,
  canonicalJson,
  coldResumeLifecycleFailures,
  coldResumeGroupFailures,
  digestValue,
  dispatchGroupFailures,
  dispatchIsolationFailures,
  durableStateFailures,
  interventionEvidenceFailures,
  milestoneFailures,
  physicalWorkerLifecycleEvidence,
  sanitizeForReport,
  stableControlId,
  storedSurfaceRecoveryFailures,
  summarizeActivityEvents,
  surfaceHistoryFailures,
  surfaceSemanticTermEvidence,
  surfaceSemanticTermFailures,
  surfaceSnapshotEvidence,
  unchangedSurfaceFailures,
  unexpectedTerminalDiagnostic,
  unsafeReportPaths,
  waitingRoundFailures,
} from "./three-worker-showcase-contracts.mjs";

const DEFAULT_HOME = process.env.HOMERAIL_HOME || path.join(os.homedir(), ".homerail");
const DEFAULT_VALIDATION_DIR = path.join(DEFAULT_HOME, "validation");
const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled"]);

class ManagerRequestError extends Error {
  constructor(message, status) {
    super(message);
    this.name = "ManagerRequestError";
    this.status = status;
  }
}

function usage() {
  return [
    "Usage: node scripts/validate-three-worker-showcase.mjs [options]",
    "",
    "Options:",
    "  --phase=all|prepare|resume       Default: all",
    "  --setting-id ID                  Required for all/prepare; env HOMERAIL_PATTERN_SETTING_ID",
    "  --expected-model ID               Optional exact real-model assertion",
    "  --base-url URL                   Default: HOMERAIL_MANAGER_URL or http://127.0.0.1:19191",
    "  --state-file PATH                Durable phase state JSON (alias: --state)",
    "  --output PATH                    Sanitized acceptance report JSON",
    "  --restart-evidence PATH          Sanitized Manager-only restart assertion JSON",
    "  --asset PATH                     External Workflow asset; env HOMERAIL_SHOWCASE_ASSET",
    "  --prompt-file PATH               UTF-8 mission; env HOMERAIL_SHOWCASE_PROMPT",
    "  --required-surface-terms CSV     Terms every Actor Surface must retain",
    `  --profile-id ID                  Default: ${SHOWCASE_PROFILE_ID}`,
    `  --intervention-actor ID          Default: ${DEFAULT_INTERVENTION_ACTOR_ID}`,
    "  --stall-timeout-ms N             No-progress timeout; 0 disables stall detection",
    "  --poll-interval-ms N             Default: 2000",
    "  --help",
    "",
    "Mutation authentication is read only from HOMERAIL_DAG_MUTATION_TOKEN and",
    "HOMERAIL_MANAGER_ADMIN_TOKEN. Tokens are never accepted as CLI arguments.",
  ].join("\n");
}

function parseArgs(argv) {
  const aliases = new Map([["state", "state-file"]]);
  const allowed = new Set([
    "phase",
    "setting-id",
    "expected-model",
    "base-url",
    "state-file",
    "output",
    "restart-evidence",
    "asset",
    "prompt-file",
    "required-surface-terms",
    "profile-id",
    "intervention-actor",
    "stall-timeout-ms",
    "poll-interval-ms",
  ]);
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help") return { help: true };
    if (!argument.startsWith("--")) throw new Error(`Unexpected positional argument: ${argument}`);
    const separator = argument.indexOf("=");
    const rawName = argument.slice(2, separator >= 0 ? separator : undefined);
    const name = aliases.get(rawName) ?? rawName;
    if (!allowed.has(name)) throw new Error(`Unknown option: --${rawName}`);
    const value = separator >= 0 ? argument.slice(separator + 1) : argv[++index];
    if (value === undefined || value === "" || (separator < 0 && value.startsWith("--"))) {
      throw new Error(`Missing value for --${rawName}`);
    }
    if (options[name] !== undefined) throw new Error(`Duplicate option: --${rawName}`);
    options[name] = value;
  }
  return options;
}

function parseIntegerOption(value, label, fallback, minimum, maximum = Number.MAX_SAFE_INTEGER) {
  const raw = value ?? fallback;
  if (!/^\d+$/.test(String(raw))) throw new Error(`${label} must be a non-negative integer`);
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${label} must be between ${minimum} and ${maximum}`);
  }
  return parsed;
}

const cli = parseArgs(process.argv.slice(2));
if (cli.help) {
  console.log(usage());
  process.exit(0);
}

const phase = cli.phase ?? "all";
if (!new Set(["all", "prepare", "resume"]).has(phase)) {
  throw new Error("--phase must be all, prepare, or resume");
}
const baseUrl = (cli["base-url"] ?? process.env.HOMERAIL_MANAGER_URL ?? "http://127.0.0.1:19191")
  .replace(/\/+$/, "");
const requestedSettingId = cli["setting-id"] ?? process.env.HOMERAIL_PATTERN_SETTING_ID ?? "";
const expectedModel = cli["expected-model"] ?? process.env.HOMERAIL_PATTERN_EXPECTED_MODEL ?? "";
const profileId = cli["profile-id"] ?? SHOWCASE_PROFILE_ID;
const interventionActorId = cli["intervention-actor"] ?? DEFAULT_INTERVENTION_ACTOR_ID;
const assetPath = (cli.asset || process.env.HOMERAIL_SHOWCASE_ASSET)
  ? path.resolve(cli.asset ?? process.env.HOMERAIL_SHOWCASE_ASSET)
  : "";
const promptFilePath = cli["prompt-file"]
  ? path.resolve(cli["prompt-file"])
  : "";
const showcasePrompt = promptFilePath
  ? fs.readFileSync(promptFilePath, "utf8").trim()
  : (process.env.HOMERAIL_SHOWCASE_PROMPT ?? "").trim();
const requiredSurfaceTerms = Array.from(new Set(
  String(cli["required-surface-terms"] ?? process.env.HOMERAIL_SHOWCASE_REQUIRED_TERMS ?? "")
    .split(",")
    .map((term) => term.normalize("NFKC").trim())
    .filter(Boolean),
));
const statePath = path.resolve(
  cli["state-file"]
    ?? process.env.HOMERAIL_THREE_WORKER_STATE_FILE
    ?? path.join(DEFAULT_VALIDATION_DIR, "three-worker-showcase-state.json"),
);
const outputPath = path.resolve(
  cli.output
    ?? process.env.HOMERAIL_THREE_WORKER_REPORT_FILE
    ?? path.join(DEFAULT_VALIDATION_DIR, "three-worker-showcase-report.json"),
);
const restartEvidencePath = cli["restart-evidence"]
  ? path.resolve(cli["restart-evidence"])
  : process.env.HOMERAIL_SHOWCASE_RESTART_EVIDENCE
    ? path.resolve(process.env.HOMERAIL_SHOWCASE_RESTART_EVIDENCE)
    : "";
const stallTimeoutMs = parseIntegerOption(
  cli["stall-timeout-ms"],
  "--stall-timeout-ms",
  process.env.HOMERAIL_THREE_WORKER_STALL_TIMEOUT_MS ?? "1200000",
  0,
);
const pollIntervalMs = parseIntegerOption(
  cli["poll-interval-ms"],
  "--poll-interval-ms",
  process.env.HOMERAIL_THREE_WORKER_POLL_INTERVAL_MS ?? "2000",
  250,
  30000,
);
const mutationToken = process.env.HOMERAIL_DAG_MUTATION_TOKEN ?? "";
const managerAdminToken = process.env.HOMERAIL_MANAGER_ADMIN_TOKEN ?? "";
const redactionSecrets = [mutationToken, managerAdminToken, baseUrl, assetPath, promptFilePath, showcasePrompt];

if (requiredSurfaceTerms.length === 0) {
  throw new Error("Missing --required-surface-terms or HOMERAIL_SHOWCASE_REQUIRED_TERMS.");
}
if (requiredSurfaceTerms.length > 8 || requiredSurfaceTerms.some((term) => term.length > 128)) {
  throw new Error("Required Surface terms must contain 1-8 entries of at most 128 characters.");
}

if ((phase === "all" || phase === "prepare") && !requestedSettingId) {
  throw new Error("Missing --setting-id or HOMERAIL_PATTERN_SETTING_ID.");
}
if (phase === "all" || phase === "prepare") {
  if (!assetPath || !fs.statSync(assetPath, { throwIfNoEntry: false })?.isFile()) {
    throw new Error("Missing external --asset or HOMERAIL_SHOWCASE_ASSET Workflow file.");
  }
  if (!showcasePrompt) {
    throw new Error("Missing --prompt-file or HOMERAIL_SHOWCASE_PROMPT mission.");
  }
  if (showcasePrompt.length > 24_000) throw new Error("Showcase mission exceeds 24000 characters.");
}
if (!EXPECTED_ACTOR_IDS.includes(interventionActorId)) {
  throw new Error(`--intervention-actor must be one of: ${EXPECTED_ACTOR_IDS.join(", ")}`);
}
if (!profileId.trim() || profileId.length > 128) throw new Error("--profile-id must be between 1 and 128 characters");

async function request(pathname, init = {}) {
  const method = (init.method ?? "GET").toUpperCase();
  const headers = new Headers(init.headers ?? {});
  if (init.body !== undefined && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  if (method !== "GET") {
    if (mutationToken) headers.set("X-Homerail-Dag-Token", mutationToken);
    if (managerAdminToken) headers.set("Authorization", `Bearer ${managerAdminToken}`);
  }
  let response;
  try {
    response = await fetch(`${baseUrl}${pathname}`, { ...init, method, headers });
  } catch (error) {
    throw new ManagerRequestError(
      `${method} ${pathname}: ${error instanceof Error ? error.message : String(error)}`,
      0,
    );
  }
  const text = await response.text();
  let body = {};
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    throw new ManagerRequestError(`${method} ${pathname}: Manager returned non-JSON HTTP ${response.status}`, response.status);
  }
  if (!response.ok || body.success === false) {
    throw new ManagerRequestError(
      `${method} ${pathname}: ${body.error ?? body.message ?? `HTTP ${response.status}`}`,
      response.status,
    );
  }
  return body.data;
}

function requiredToolCall(turn, toolName) {
  const calls = (Array.isArray(turn?.tool_calls) ? turn.tool_calls : [])
    .filter((call) => call?.name === toolName);
  if (calls.length !== 1) {
    const objective = turn?.objective && typeof turn.objective === "object" && !Array.isArray(turn.objective)
      ? turn.objective
      : {};
    const agentConfig = turn?.manager_agent_config
      && typeof turn.manager_agent_config === "object"
      && !Array.isArray(turn.manager_agent_config)
      ? turn.manager_agent_config
      : {};
    const diagnostic = {
      runtime_placement: typeof turn?.runtime_placement === "string" ? turn.runtime_placement : null,
      agent_type: typeof agentConfig.agent_type === "string" ? agentConfig.agent_type : null,
      objective_required: objective.required === true,
      objective_satisfied: objective.satisfied === true,
      required_tool_calls: Array.isArray(objective.required_tool_calls)
        ? objective.required_tool_calls.filter((item) => typeof item === "string")
        : [],
      observed_tool_calls: Array.isArray(turn?.tool_calls)
        ? turn.tool_calls.map((call) => call?.name).filter((name) => typeof name === "string")
        : [],
    };
    throw new Error(
      `Manager must call ${toolName} exactly once; observed ${calls.length}; diagnostic=${canonicalJson(diagnostic)}`,
    );
  }
  if (!calls[0]?.input || typeof calls[0].input !== "object" || Array.isArray(calls[0].input)) {
    throw new Error(`Manager ${toolName} call is missing a structured input`);
  }
  return calls[0];
}

function managerTurnEvidence(turn, requiredToolName) {
  const required = requiredToolCall(turn, requiredToolName);
  return {
    session_id: turn.session_id,
    manager_model_name: turn.manager_model_name,
    runtime_placement: turn.runtime_placement,
    text: typeof turn.text === "string" ? turn.text.trim() : "",
    required_tool: requiredToolName,
    tool_calls: [{
      name: required.name,
      input: sanitizeForReport(required.input, { secrets: redactionSecrets }),
    }],
    agent_error_count: Array.isArray(turn.agent_errors) ? turn.agent_errors.length : 0,
  };
}

async function managerChat(input) {
  const turn = await request("/api/manager/chat", {
    method: "POST",
    body: JSON.stringify({
      message: input.message,
      manager_setting_id: input.setting_id,
      ...(input.session_id ? { session_id: input.session_id } : {}),
      required_tool_calls: [input.required_tool],
    }),
  });
  if (typeof turn?.session_id !== "string" || !turn.session_id) {
    throw new Error("Manager chat did not return a durable session_id");
  }
  if (input.session_id && turn.session_id !== input.session_id) {
    throw new Error("Manager chat forked instead of continuing the supervised session");
  }
  if (expectedModel && turn.manager_model_name !== expectedModel) {
    throw new Error(
      `Manager chat used model ${String(turn.manager_model_name)}, expected ${expectedModel}`,
    );
  }
  if (Array.isArray(turn.agent_errors) && turn.agent_errors.length > 0) {
    throw new Error(`Manager chat reported ${turn.agent_errors.length} agent error(s)`);
  }
  const call = requiredToolCall(turn, input.required_tool);
  return {
    raw: turn,
    call,
    evidence: managerTurnEvidence(turn, input.required_tool),
  };
}

function exactCommandPayload(actorId, phaseLabel) {
  const roleTask = {
    goal_scout: "Refresh the shared objective, priorities, and measurable success condition.",
    session_coach: "Refresh the actionable session plan, pacing, and fallback advice.",
    systems_guide: "Refresh the resource constraints, system risks, and mitigations.",
  }[actorId];
  return {
    task: `${roleTask} This is ${phaseLabel}.`,
    acceptance: "Return a complete replacement report through the existing report contract.",
  };
}

function batchCommandInput(runId, expectedRoundId, phaseLabel) {
  return {
    run_id: runId,
    expected_round_id: expectedRoundId,
    commands: EXPECTED_ACTOR_IDS.map((actorId) => ({
      actor_id: actorId,
      payload: exactCommandPayload(actorId, phaseLabel),
    })),
  };
}

function assertManagerBatchCall(call, expectedInput) {
  const input = call.input;
  if (input.run_id !== expectedInput.run_id || input.expected_round_id !== expectedInput.expected_round_id) {
    throw new Error("Manager batch command changed run_id or expected_round_id");
  }
  const commands = Array.isArray(input.commands) ? input.commands : [];
  const byActor = new Map(commands.map((command) => [command?.actor_id, command]));
  if (byActor.size !== EXPECTED_ACTOR_IDS.length) {
    throw new Error("Manager batch command did not contain exactly three unique Actors");
  }
  for (const expected of expectedInput.commands) {
    const actual = byActor.get(expected.actor_id);
    if (!actual || canonicalJson(actual.payload) !== canonicalJson(expected.payload)) {
      throw new Error(`Manager batch command changed the payload for ${expected.actor_id}`);
    }
  }
}

async function startShowcaseThroughManager(settingId, workflowId) {
  const expectedInput = {
    workflow_id: workflowId,
    profile: profileId,
    prompt: showcasePrompt,
  };
  const turn = await managerChat({
    setting_id: settingId,
    required_tool: "start_supervised_dag",
    message: `Call start_supervised_dag exactly once with this JSON input: ${canonicalJson(expectedInput)}; start only that explicitly selected external workflow in supervised mode, do not instantiate or substitute another workflow, and reply briefly after it starts.`,
  });
  const input = turn.call.input;
  const selectedWorkflowId = input.workflow_id ?? input.workflowId;
  if (
    selectedWorkflowId !== expectedInput.workflow_id
    || input.profile !== expectedInput.profile
    || input.prompt !== expectedInput.prompt
  ) throw new Error("Manager changed the explicitly selected Showcase workflow, profile, or prompt");
  const runId = turn.raw.run_id;
  if (typeof runId !== "string" || !runId) throw new Error("Manager did not return the supervised run_id");
  return { run_id: runId, session_id: turn.raw.session_id, evidence: turn.evidence };
}

async function focusActorThroughManager(settingId, sessionId, runId, actorId) {
  const expectedInput = {
    run_id: runId,
    actor_id: actorId,
    idempotency_key: stableControlId("manager-focus", runId, actorId),
    duration_ms: 60_000,
  };
  const turn = await managerChat({
    setting_id: settingId,
    session_id: sessionId,
    required_tool: "focus_dag_actor",
    message: `Call focus_dag_actor exactly once with this JSON input: ${canonicalJson(expectedInput)}; use the existing supervised session and reply briefly after the focus is committed.`,
  });
  if (canonicalJson(turn.call.input) !== canonicalJson(expectedInput)) {
    throw new Error("Manager focus call changed the requested stable Actor input");
  }
  const surfaces = await request(`/api/runs/${encodeURIComponent(runId)}/live-surfaces`);
  const analysis = analyzeSurfaceSnapshot(surfaces);
  assertFailures("Manager focus Surface contract", analysis.failures);
  const focused = analysis.actors.find((actor) => actor.actor_id === actorId);
  if (focused?.visibility_state !== "focused" || !Number.isSafeInteger(focused?.node?.state?.focused_until)) {
    throw new Error("Manager focus did not produce a bounded focused Surface state");
  }
  return {
    evidence: turn.evidence,
    focus: {
      actor_id: actorId,
      visibility_state: focused.visibility_state,
      focused_until: focused.node.state.focused_until,
      surface_id: focused.surface_id,
    },
  };
}

async function continueAllActorsThroughManager(settingId, sessionId, runId, expectedRoundId, phaseLabel) {
  const expectedInput = batchCommandInput(runId, expectedRoundId, phaseLabel);
  const turn = await managerChat({
    setting_id: settingId,
    session_id: sessionId,
    required_tool: "send_dag_actor_command",
    message: `Call send_dag_actor_command exactly once with this JSON input: ${canonicalJson(expectedInput)}; continue all three existing logical Actors atomically and do not start another workflow.`,
  });
  assertManagerBatchCall(turn.call, expectedInput);
  return turn.evidence;
}

async function synthesizeThroughManager(settingId, sessionId, runId, phaseLabel) {
  const expectedInput = { run_id: runId, max_milestones: 12 };
  const turn = await managerChat({
    setting_id: settingId,
    session_id: sessionId,
    required_tool: "get_dag_supervision",
    message: `Call get_dag_supervision exactly once with this JSON input: ${canonicalJson(expectedInput)}; then give a concise ${phaseLabel} synthesis that names the three Actor perspectives and the combined recommendation.`,
  });
  if (canonicalJson(turn.call.input) !== canonicalJson(expectedInput)) {
    throw new Error("Manager supervision call changed the requested run or milestone limit");
  }
  if (typeof turn.raw.text !== "string" || turn.raw.text.trim().length < 20) {
    throw new Error("Manager final synthesis is missing or too short");
  }
  return turn.evidence;
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function assertFailures(label, failures) {
  if (failures.length > 0) throw new Error(`${label}: ${failures.join("; ")}`);
}

function assertNotStalled(label, stalledForMs) {
  if (stallTimeoutMs > 0 && stalledForMs >= stallTimeoutMs) {
    throw new Error(`${label} made no observable progress for ${stalledForMs}ms`);
  }
}

async function diagnosticRequest(pathname) {
  try {
    return await request(pathname);
  } catch (error) {
    return {
      diagnostic_error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function captureUnexpectedTerminal(runId, status) {
  const runPath = `/api/runs/${encodeURIComponent(runId)}`;
  const [rounds, handoffs, actors, surfaces, activities, events] = await Promise.all([
    diagnosticRequest(`${runPath}/rounds`),
    diagnosticRequest(`${runPath}/handoffs`),
    diagnosticRequest(`${runPath}/actors`),
    diagnosticRequest(`${runPath}/live-surfaces`),
    diagnosticRequest(`${runPath}/activities?after_seq=0&limit=500`),
    diagnosticRequest(`${runPath}/events`),
  ]);
  return unexpectedTerminalDiagnostic({
    status,
    rounds,
    handoffs,
    actors,
    surfaces,
    activities: Array.isArray(activities?.events) ? activities.events : activities,
    events,
  });
}

async function waitForWaiting(runId, label, report) {
  let progress;
  let nextLogAt = 0;
  while (true) {
    const status = await request(`/api/runs/${encodeURIComponent(runId)}/status`);
    const observedAt = Date.now();
    progress = observeRunProgress(progress, status, observedAt);
    if (status.status === "waiting") return status;
    if (TERMINAL_STATUSES.has(status.status)) {
      report.terminal_diagnostics.push({
        label,
        evidence: await captureUnexpectedTerminal(runId, status),
      });
      throw new Error(`${label} reached unexpected terminal status ${status.status}`);
    }
    const stalledForMs = observedAt - progress.last_progress_at;
    assertNotStalled(label, stalledForMs);
    if (observedAt >= nextLogAt) {
      console.log(`${label}: ${status.status}; no progress for ${Math.floor(stalledForMs / 1000)}s`);
      nextLogAt = observedAt + 10000;
    }
    await sleep(pollIntervalMs);
  }
}

async function fetchAllActivities(runId) {
  const entries = [];
  let afterSeq = 0;
  while (true) {
    const page = await request(
      `/api/runs/${encodeURIComponent(runId)}/activities?after_seq=${afterSeq}&limit=500`,
    );
    const events = Array.isArray(page.events) ? page.events : [];
    entries.push(...events);
    if (!page.has_more) return entries;
    if (!Number.isSafeInteger(page.next_after_seq) || page.next_after_seq <= afterSeq || events.length === 0) {
      throw new Error("Activity replay cursor did not advance");
    }
    afterSeq = page.next_after_seq;
  }
}

async function fetchRunEvents(runId) {
  return request(`/api/runs/${encodeURIComponent(runId)}/events`);
}

async function waitForPhysicalLifecycle(runId, options, label) {
  let fingerprint = "";
  let lastProgressAt = Date.now();
  let nextLogAt = 0;
  while (true) {
    const events = await fetchRunEvents(runId);
    const analyzed = physicalWorkerLifecycleEvidence(events, options);
    if (analyzed.failures.length === 0) return analyzed.evidence;
    const nextFingerprint = digestValue({
      total: events?.total,
      evidence: analyzed.evidence,
      failures: analyzed.failures,
    });
    if (nextFingerprint !== fingerprint) {
      fingerprint = nextFingerprint;
      lastProgressAt = Date.now();
    }
    assertNotStalled(label, Date.now() - lastProgressAt);
    if (Date.now() >= nextLogAt) {
      console.log(`${label}: ${analyzed.failures.join("; ")}`);
      nextLogAt = Date.now() + 10_000;
    }
    await sleep(pollIntervalMs);
  }
}

async function roundCommandEvidence(runId, roundId, actorIds) {
  const response = await request(
    `/api/runs/${encodeURIComponent(runId)}/commands?round_id=${encodeURIComponent(roundId)}&limit=500`,
  );
  const commands = Array.isArray(response?.commands) ? response.commands : [];
  const selected = commands.filter((command) => actorIds.includes(command?.actor_id));
  const byActor = new Map();
  for (const command of selected) {
    const list = byActor.get(command.actor_id) ?? [];
    list.push(command);
    byActor.set(command.actor_id, list);
  }
  for (const actorId of actorIds) {
    const actorCommands = byActor.get(actorId) ?? [];
    if (actorCommands.length !== 1) {
      throw new Error(`${roundId} must contain exactly one command for ${actorId}`);
    }
    if (actorCommands[0].status !== "acknowledged") {
      throw new Error(`${roundId} command for ${actorId} is ${String(actorCommands[0].status)}`);
    }
  }
  return {
    round_id: roundId,
    actor_ids: [...actorIds].sort(),
    acknowledged_count: actorIds.length,
  };
}

function aggregateSupervisionDigest(pages) {
  const digests = pages.map((page) => page.milestone_digest);
  return {
    consumer_digest: digests[0]?.consumer_digest,
    page_count: digests.length,
    after_seq: digests[0]?.after_seq ?? 0,
    next_after_seq: digests.at(-1)?.next_after_seq ?? 0,
    suppressed_progress_events: digests.reduce(
      (sum, digest) => sum + Number(digest?.suppressed_progress_events ?? 0),
      0,
    ),
    milestones: digests.flatMap((digest) => digest?.milestones ?? []),
    intervention_milestones: digests.flatMap((digest) => digest?.intervention_milestones ?? []),
    commentary: digests.flatMap((digest) => digest?.commentary ?? []),
  };
}

async function fetchSupervisionDigest(runId, consumerLabel) {
  const consumerId = stableControlId("three-worker-validator", runId, consumerLabel);
  const pages = [];
  let previousFingerprint = "";
  while (true) {
    const page = await request(
      `/api/runs/${encodeURIComponent(runId)}/supervision`,
      {
        method: "POST",
        body: JSON.stringify({ consumer_id: consumerId, max_milestones: 12 }),
      },
    );
    pages.push(page);
    const digest = page.milestone_digest;
    if (!digest?.has_more) return { pages: pages.map((entry) => entry.milestone_digest), digest: aggregateSupervisionDigest(pages) };
    const fingerprint = digestValue({
      next_after_seq: digest.next_after_seq,
      milestones: (digest.milestones ?? []).map((item) => item.milestone_id),
      interventions: (digest.intervention_milestones ?? []).map((item) => item.milestone_id),
    });
    if (fingerprint === previousFingerprint) throw new Error("Supervision digest cursor did not advance");
    previousFingerprint = fingerprint;
  }
}

async function fetchModelEvidence(runId, surfaceAnalysis, settingId) {
  const chats = Object.fromEntries(await Promise.all(surfaceAnalysis.actors.map(async (surface) => [
    surface.node_id,
    await request(
      `/api/dag-status/${encodeURIComponent(runId)}/node/${encodeURIComponent(surface.node_id)}/chat`,
    ),
  ])));
  return analyzeModelDispatches(surfaceAnalysis.actors, chats, settingId, expectedModel);
}

function compactRound(round) {
  if (!round || typeof round !== "object") return null;
  return {
    round_id: round.round_id,
    ordinal: round.ordinal,
    status: round.status,
    target_actor_ids: Array.isArray(round.target_actor_ids) ? [...round.target_actor_ids] : [],
    started_at: round.started_at,
    ...(round.completed_at === undefined ? {} : { completed_at: round.completed_at }),
  };
}

function compactRounds(roundData) {
  return (roundData?.rounds ?? []).map(compactRound);
}

function phaseActorEvidence(actorSnapshot, surfaceAnalysis) {
  const surfaces = new Map(surfaceAnalysis.actors.map((surface) => [surface.actor_id, surface]));
  return actorSnapshotEvidence(actorSnapshot).map((actor) => {
    const surface = surfaces.get(actor.actor_id);
    return {
      ...actor,
      lease_state: actor.lease?.state ?? null,
      generation: surface?.generation ?? null,
      node_id: surface?.node_id ?? null,
      surface_id: surface?.surface_id ?? null,
      surface_revision: surface?.surface_revision ?? null,
      surface_digest: surface?.node_digest ?? null,
    };
  });
}

function liveSurfaceForReport(rawSnapshot) {
  const sanitized = sanitizeForReport(rawSnapshot, { secrets: redactionSecrets });
  const unsafe = unsafeReportPaths(sanitized);
  assertFailures("sanitized live Surface safety", unsafe.map((entry) => `unsafe field ${entry}`));
  assertFailures("sanitized live Surface contract", analyzeSurfaceSnapshot(sanitized).failures);
  return sanitized;
}

async function captureWaitingEvidence(input) {
  const runPath = `/api/runs/${encodeURIComponent(input.run_id)}`;
  const [status, rounds, handoffs, actors, surfaces, activities, supervision] = await Promise.all([
    request(`${runPath}/status`),
    request(`${runPath}/rounds`),
    request(`${runPath}/handoffs`),
    request(`${runPath}/actors`),
    request(`${runPath}/live-surfaces`),
    fetchAllActivities(input.run_id),
    fetchSupervisionDigest(input.run_id, input.consumer_label),
  ]);
  const surfaceAnalysis = analyzeSurfaceSnapshot(surfaces);
  const actorFailures = actorSnapshotFailures(actors, EXPECTED_ACTOR_IDS, { requireLeases: true });
  const roundFailures = waitingRoundFailures({
    status,
    rounds,
    handoffs,
    expected_actor_ids: input.target_actor_ids,
    expected_ordinal: input.expected_ordinal,
  });
  const currentRoundId = status.current_round?.round_id;
  const activityFailures = activityRoundFailures(
    activities,
    input.activity_actor_ids,
    currentRoundId,
    input.generations ?? Object.fromEntries(
      surfaceAnalysis.actors
        .filter((surface) => input.activity_actor_ids.includes(surface.actor_id))
        .map((surface) => [surface.actor_id, surface.generation]),
    ),
    { require_progress: input.require_progress !== false },
  );
  const supervisorFailures = milestoneFailures(
    supervision.pages,
    input.activity_actor_ids,
    currentRoundId,
  );
  assertFailures(`${input.consumer_label} actor contract`, actorFailures);
  assertFailures(`${input.consumer_label} Surface contract`, surfaceAnalysis.failures);
  assertFailures(
    `${input.consumer_label} semantic grounding`,
    surfaceSemanticTermFailures(surfaceAnalysis, requiredSurfaceTerms),
  );
  assertFailures(`${input.consumer_label} waiting/fan-in contract`, roundFailures);
  assertFailures(`${input.consumer_label} activity contract`, activityFailures);
  assertFailures(`${input.consumer_label} supervision contract`, supervisorFailures);
  const model = await fetchModelEvidence(input.run_id, surfaceAnalysis, input.setting_id);
  assertFailures(`${input.consumer_label} model dispatch contract`, model.failures);

  return {
    raw: { status, rounds, actors, surfaces, activities },
    surface_analysis: surfaceAnalysis,
    model,
    report: {
      status: status.status,
      current_round: compactRound(status.current_round),
      actors: phaseActorEvidence(actors, surfaceAnalysis),
      event_counts: summarizeActivityEvents(activities),
      supervision_digest: sanitizeForReport(supervision.digest, { secrets: redactionSecrets }),
      surface_digests: surfaceSnapshotEvidence(surfaceAnalysis),
      semantic_grounding: surfaceSemanticTermEvidence(surfaceAnalysis, requiredSurfaceTerms),
      surface_snapshot: liveSurfaceForReport(surfaces),
      model_dispatch_evidence: model.actors,
    },
  };
}

async function waitForDormantActor(runId, actorId) {
  let fingerprint = "";
  let lastProgressAt = Date.now();
  let nextLogAt = 0;
  while (true) {
    const [status, actors] = await Promise.all([
      request(`/api/runs/${encodeURIComponent(runId)}/status`),
      request(`/api/runs/${encodeURIComponent(runId)}/actors`),
    ]);
    assertFailures("lease release actor contract", actorSnapshotFailures(actors, EXPECTED_ACTOR_IDS, { requireLeases: true }));
    if (status.status !== "waiting") throw new Error(`lease release requires waiting status, observed ${status.status}`);
    const actor = actors.actors.find((entry) => entry.actor_id === actorId);
    if (actor?.lease?.state === "dormant") return actors;
    if (actor?.lease?.state === "retired") throw new Error(`${actorId} lease retired instead of becoming dormant`);
    const observedAt = Date.now();
    const nextFingerprint = digestValue({
      status: status.status,
      round: status.current_round,
      actors: actorSnapshotEvidence(actors),
    });
    if (nextFingerprint !== fingerprint) {
      fingerprint = nextFingerprint;
      lastProgressAt = observedAt;
    }
    const idleDeadline = Number.isSafeInteger(actor?.lease?.idle_deadline) ? actor.lease.idle_deadline : 0;
    const stalledForMs = observedAt - Math.max(lastProgressAt, idleDeadline);
    assertNotStalled(`lease release for ${actorId}`, stalledForMs);
    if (observedAt >= nextLogAt) {
      console.log(`lease release: ${actorId} is ${actor?.lease?.state ?? "missing"}`);
      nextLogAt = observedAt + 10000;
    }
    await sleep(pollIntervalMs);
  }
}

function profileYaml(workflowId, settingId) {
  return [
    `profile_id: ${JSON.stringify(profileId)}`,
    `workflow_id: ${JSON.stringify(workflowId)}`,
    "description: Provider-neutral real-model profile for issue 45 live acceptance.",
    "default:",
    `  llm_setting_id: ${JSON.stringify(settingId)}`,
    "",
  ].join("\n");
}

async function syncShowcase(settingId) {
  const yamlText = fs.readFileSync(assetPath, "utf8");
  const workflowResult = await request("/api/dag/workflows/sync", {
    method: "POST",
    body: JSON.stringify({
      yaml_text: yamlText,
      source_path: `external-skill:${path.basename(assetPath)}`,
    }),
  });
  const workflow = workflowResult.workflow;
  const workflowId = typeof workflow?.workflow_id === "string" ? workflow.workflow_id.trim() : "";
  if (!workflowId) throw new Error("Manager did not return the external Workflow identity");
  const profileResult = await request("/api/dag/profiles/sync", {
    method: "POST",
    body: JSON.stringify({
      yaml_text: profileYaml(workflowId, settingId),
      workflow_id: workflowId,
      source_path: "validation:three-worker-showcase",
    }),
  });
  if (profileResult.profile?.profile_id !== profileId) throw new Error("Manager synced the wrong runtime profile");
  if (profileResult.profile?.default?.llm_setting_id !== settingId) {
    throw new Error("Manager runtime profile did not retain the requested LLM setting identity");
  }
  return {
    workflow_id: workflow.workflow_id,
    workflow_revision: workflow.head_revision,
    canonical_hash: workflow.canonical_hash,
    profile_id: profileId,
    setting_id: settingId,
  };
}

async function sendActorCommand(runId, expectedRoundId, actorId, purpose) {
  const commandId = stableControlId("command", runId, expectedRoundId, actorId, purpose);
  const idempotencyKey = stableControlId("command-key", runId, expectedRoundId, actorId, purpose);
  const result = await request(`/api/runs/${encodeURIComponent(runId)}/commands`, {
    method: "POST",
    body: JSON.stringify({
      expected_round_id: expectedRoundId,
      commands: [{
        actor_id: actorId,
        command_id: commandId,
        idempotency_key: idempotencyKey,
        payload: purpose === "intervention-window"
          ? {
            task: "Revise only your actor report with five concrete tradeoffs and a concise fallback for each.",
            acceptance: "Return a complete replacement report through the existing report contract.",
          }
          : {
            task: "Continue your existing responsibility with one new recommendation and one fallback.",
            acceptance: "Return a complete replacement report through the existing report contract.",
          },
      }],
    }),
  });
  if (
    result.previous_round_id !== expectedRoundId
    || !Array.isArray(result.actor_ids)
    || result.actor_ids.length !== 1
    || result.actor_ids[0] !== actorId
    || !Array.isArray(result.command_ids)
    || result.command_ids[0] !== commandId
  ) throw new Error("Actor command response did not preserve the requested round and actor identity");
  return { result, command_id: commandId, idempotency_key: idempotencyKey };
}

async function applyRetryIntervention(runId, actorId, expectedRoundId) {
  const idempotencyKey = stableControlId("retry-key", runId, expectedRoundId, actorId);
  let progressFingerprint = "";
  let lastProgressAt = Date.now();
  while (true) {
    const surfaces = await request(`/api/runs/${encodeURIComponent(runId)}/live-surfaces`);
    const surfaceAnalysis = analyzeSurfaceSnapshot(surfaces);
    assertFailures("pre-intervention Surface contract", surfaceAnalysis.failures);
    const actors = await request(`/api/runs/${encodeURIComponent(runId)}/actors`);
    assertFailures("pre-intervention actor contract", actorSnapshotFailures(actors, EXPECTED_ACTOR_IDS, { requireLeases: true }));
    const actor = actors.actors.find((entry) => entry.actor_id === actorId);
    if (!actor) throw new Error(`Missing intervention actor ${actorId}`);
    const nextFingerprint = digestValue({
      actor_state: actor.actor_state,
      lease: actor.lease,
      surface: surfaceAnalysis.actors.find((entry) => entry.actor_id === actorId),
    });
    if (nextFingerprint !== progressFingerprint) {
      progressFingerprint = nextFingerprint;
      lastProgressAt = Date.now();
    }
    try {
      const intervention = await request(
        `/api/runs/${encodeURIComponent(runId)}/actors/${encodeURIComponent(actorId)}/interventions`,
        {
          method: "POST",
          body: JSON.stringify({
            operation: "retry",
            instruction: "Retry this actor branch from its durable checkpoint and replace only its own report.",
            expected_state_token: actor.state_token,
            idempotency_key: idempotencyKey,
          }),
        },
      );
      return { intervention, surfaces, surface_analysis: surfaceAnalysis, actors };
    } catch (error) {
      const retryableConflict = error instanceof ManagerRequestError
        && error.status === 409
        && /state changed|state_token|state token/i.test(error.message);
      if (!retryableConflict) throw error;
      assertNotStalled("actor state-token CAS for intervention", Date.now() - lastProgressAt);
      await sleep(Math.min(pollIntervalMs, 250));
    }
  }
}

function branchIsolationEvidence(before, after, actorId, intervention, dispatchBefore, dispatchAfter) {
  const beforeMap = new Map(before.actors.map((actor) => [actor.actor_id, actor]));
  const afterMap = new Map(after.actors.map((actor) => [actor.actor_id, actor]));
  const dispatchLeft = new Map(dispatchBefore.actors.map((actor) => [actor.actor_id, actor]));
  const dispatchRight = new Map(dispatchAfter.actors.map((actor) => [actor.actor_id, actor]));
  const selectedBefore = beforeMap.get(actorId);
  const selectedAfter = afterMap.get(actorId);
  return {
    actor_id: actorId,
    operation: intervention.operation,
    intervention_id: intervention.intervention_id,
    status: intervention.status,
    actor_state_token_used: true,
    selected: {
      surface_id: selectedAfter?.surface_id,
      generation_before: selectedBefore?.generation,
      generation_after: selectedAfter?.generation,
      surface_revision_before: selectedBefore?.surface_revision,
      surface_revision_after: selectedAfter?.surface_revision,
      digest_before: selectedBefore?.node_digest,
      digest_after: selectedAfter?.node_digest,
      semantic_node_changed: selectedBefore?.node_canonical !== selectedAfter?.node_canonical,
      dispatch_count_before: dispatchLeft.get(actorId)?.dispatch_count,
      dispatch_count_after: dispatchRight.get(actorId)?.dispatch_count,
    },
    unaffected: EXPECTED_ACTOR_IDS.filter((entry) => entry !== actorId).map((unaffectedId) => ({
      actor_id: unaffectedId,
      surface_id: afterMap.get(unaffectedId)?.surface_id,
      generation: afterMap.get(unaffectedId)?.generation,
      surface_revision: afterMap.get(unaffectedId)?.surface_revision,
      digest: afterMap.get(unaffectedId)?.node_digest,
      semantic_node_byte_equivalent:
        beforeMap.get(unaffectedId)?.node_canonical === afterMap.get(unaffectedId)?.node_canonical,
      dispatch_count_before: dispatchLeft.get(unaffectedId)?.dispatch_count,
      dispatch_count_after: dispatchRight.get(unaffectedId)?.dispatch_count,
    })),
    passed: true,
  };
}

async function preparePhase(report, settingId, invocationPhase) {
  const synced = await syncShowcase(settingId);
  report.run = { ...synced };
  const started = await startShowcaseThroughManager(settingId, synced.workflow_id);
  const runId = started.run_id;
  report.run.run_id = runId;
  report.manager_control = {
    session_id: started.session_id,
    one_sentence_start: started.evidence,
  };
  console.log(`showcase: started run ${runId}`);

  await waitForWaiting(runId, "initial three-actor round", report);
  const initial = await captureWaitingEvidence({
    run_id: runId,
    setting_id: settingId,
    expected_ordinal: 1,
    target_actor_ids: EXPECTED_ACTOR_IDS,
    activity_actor_ids: EXPECTED_ACTOR_IDS,
    require_progress: false,
    consumer_label: "initial-waiting",
  });
  report.phase_evidence.prepare = { initial_waiting: initial.report };
  const concurrency = activityConcurrencyEvidence(
    initial.raw.activities,
    EXPECTED_ACTOR_IDS,
    initial.raw.status.current_round.round_id,
  );
  assertFailures("initial physical concurrency", concurrency.failures);
  const initialPhysical = physicalWorkerLifecycleEvidence(await fetchRunEvents(runId), {
    expected_node_ids: EXPECTED_ACTOR_IDS,
    minimum_distinct_workers: EXPECTED_ACTOR_IDS.length,
  });
  assertFailures("initial physical Worker allocation", initialPhysical.failures);
  report.concurrency_evidence = concurrency.evidence;
  report.physical_worker_evidence = { initial: initialPhysical.evidence };

  const focused = await focusActorThroughManager(
    settingId,
    started.session_id,
    runId,
    interventionActorId,
  );
  report.manager_control.focus = focused;

  const activation = await sendActorCommand(
    runId,
    initial.raw.status.current_round.round_id,
    interventionActorId,
    "intervention-window",
  );
  if (activation.result.ordinal !== 2) throw new Error("Intervention activation did not open round 2");
  const pre = await applyRetryIntervention(runId, interventionActorId, activation.result.round_id);
  assertFailures(
    "intervention response contract",
    interventionEvidenceFailures(pre.intervention, interventionActorId),
  );
  report.phase_evidence.prepare.pre_intervention = {
    current_round: { round_id: activation.result.round_id, ordinal: activation.result.ordinal, status: "active" },
    actors: phaseActorEvidence(pre.actors, pre.surface_analysis),
    surface_digests: surfaceSnapshotEvidence(pre.surface_analysis),
    surface_snapshot: liveSurfaceForReport(pre.surfaces),
  };

  await waitForWaiting(runId, "post-intervention round", report);
  const post = await captureWaitingEvidence({
    run_id: runId,
    setting_id: settingId,
    expected_ordinal: 2,
    target_actor_ids: [interventionActorId],
    activity_actor_ids: [interventionActorId],
    require_progress: false,
    consumer_label: "post-intervention-waiting",
  });
  const branchFailures = branchIsolationFailures(
    pre.surface_analysis,
    post.surface_analysis,
    interventionActorId,
  );
  branchFailures.push(...dispatchIsolationFailures(initial.model, post.model, interventionActorId, 2));
  const selectedBefore = pre.surface_analysis.actors.find((actor) => actor.actor_id === interventionActorId);
  const selectedAfter = post.surface_analysis.actors.find((actor) => actor.actor_id === interventionActorId);
  const selectedState = selectedAfter;
  if (
    selectedState?.latest_intervention?.intervention_id !== pre.intervention.intervention_id
    || selectedState?.latest_intervention?.status !== "applied"
    || Number(selectedState?.superseded_count ?? 0) < 1
  ) branchFailures.push("current selected Surface does not expose applied/superseded intervention state");
  const history = await request(
    `/api/runs/${encodeURIComponent(runId)}/actors/${encodeURIComponent(interventionActorId)}/surface-history?limit=100`,
  );
  branchFailures.push(...surfaceHistoryFailures(history, {
    from_generation: selectedBefore?.generation,
    to_generation: selectedAfter?.generation,
    surface_id: selectedAfter?.surface_id,
    intervention_id: pre.intervention.intervention_id,
  }));
  assertFailures("branch-local intervention isolation", branchFailures);
  report.intervention_isolation = branchIsolationEvidence(
    pre.surface_analysis,
    post.surface_analysis,
    interventionActorId,
    pre.intervention,
    initial.model,
    post.model,
  );
  report.phase_evidence.prepare.post_intervention_waiting = post.report;

  report.manager_control.continue_before_restart = await continueAllActorsThroughManager(
    settingId,
    started.session_id,
    runId,
    post.raw.status.current_round.round_id,
    "the pre-restart coordinated refresh",
  );
  await waitForWaiting(runId, "Manager batch continuation round", report);
  const coordinated = await captureWaitingEvidence({
    run_id: runId,
    setting_id: settingId,
    expected_ordinal: 3,
    target_actor_ids: EXPECTED_ACTOR_IDS,
    activity_actor_ids: EXPECTED_ACTOR_IDS,
    require_progress: false,
    consumer_label: "manager-batch-waiting",
  });
  const coordinatedFailures = coldResumeGroupFailures(
    post.surface_analysis,
    coordinated.surface_analysis,
    EXPECTED_ACTOR_IDS,
  );
  const coordinatedCommands = await roundCommandEvidence(
    runId,
    coordinated.raw.status.current_round.round_id,
    EXPECTED_ACTOR_IDS,
  );
  coordinatedFailures.push(...dispatchGroupFailures(post.model, coordinated.model, EXPECTED_ACTOR_IDS, 1, 4));
  assertFailures("Manager batch continuation", coordinatedFailures);
  report.phase_evidence.prepare.manager_batch_waiting = coordinated.report;
  report.manager_control.continue_before_restart = {
    ...report.manager_control.continue_before_restart,
    command_result: coordinatedCommands,
  };
  report.manager_control.synthesis_before_restart = await synthesizeThroughManager(
    settingId,
    started.session_id,
    runId,
    "pre-restart",
  );

  const dormantActors = await waitForDormantActor(runId, interventionActorId);
  const releasedSurfaces = await request(`/api/runs/${encodeURIComponent(runId)}/live-surfaces`);
  const releasedAnalysis = analyzeSurfaceSnapshot(releasedSurfaces);
  assertFailures("released Surface contract", releasedAnalysis.failures);
  assertFailures(
    "hot TTL release Surface stability",
    unchangedSurfaceFailures(coordinated.surface_analysis, releasedAnalysis, EXPECTED_ACTOR_IDS, "hot TTL release"),
  );
  const releasedPhysical = await waitForPhysicalLifecycle(runId, {
    expected_node_ids: EXPECTED_ACTOR_IDS,
    minimum_distinct_workers: EXPECTED_ACTOR_IDS.length,
    require_idle_release_actor: interventionActorId,
  }, "physical Worker release");
  report.physical_worker_evidence.after_idle_release = releasedPhysical;
  const dormantActor = dormantActors.actors.find((actor) => actor.actor_id === interventionActorId);
  if (dormantActor?.lease?.state !== "dormant") throw new Error("Selected cold-resume actor is not dormant");
  const releasedReport = {
    status: "waiting",
    current_round: compactRound(coordinated.raw.status.current_round),
    actors: phaseActorEvidence(dormantActors, releasedAnalysis),
    supervision_digest: coordinated.report.supervision_digest,
    surface_digests: surfaceSnapshotEvidence(releasedAnalysis),
    surface_snapshot: liveSurfaceForReport(releasedSurfaces),
  };
  report.phase_evidence.prepare.hot_ttl_release = releasedReport;
  report.lease_release_cold_resume = {
    actor_id: interventionActorId,
    release: {
      lease_state: "dormant",
      generation: selectedAfter.generation,
      actor_id: interventionActorId,
      surface_id: selectedAfter.surface_id,
      round_id: coordinated.raw.status.current_round.round_id,
      surface_unchanged_during_release: true,
      physical_cleanup_observed: true,
    },
  };
  report.actors = releasedReport.actors;
  report.rounds = compactRounds(coordinated.raw.rounds);
  report.event_counts = coordinated.report.event_counts;
  report.model_dispatch_evidence = {
    initial_waiting: initial.model.actors,
    post_intervention_waiting: post.model.actors,
    manager_batch_waiting: coordinated.model.actors,
  };
  report.surface_snapshot = releasedReport.surface_snapshot;
  report.surface_digests = releasedReport.surface_digests;

  const state = {
    schema_version: SHOWCASE_STATE_SCHEMA_VERSION,
    scenario: SHOWCASE_SCENARIO,
    stage: "prepared",
    prepared_at: new Date().toISOString(),
    prepared_by_phase: invocationPhase,
    run: report.run,
    actor_ids: [...EXPECTED_ACTOR_IDS],
    intervention_actor_id: interventionActorId,
    cold_resume_actor_id: interventionActorId,
    prepared_round: compactRound(coordinated.raw.status.current_round),
    prepared_surfaces: surfaceSnapshotEvidence(releasedAnalysis),
    prepared_surface_snapshot: releasedReport.surface_snapshot,
    manager_session_id: started.session_id,
    preparation: {
      phase_evidence: report.phase_evidence.prepare,
      intervention_isolation: report.intervention_isolation,
      lease_release_cold_resume: report.lease_release_cold_resume,
      manager_control: report.manager_control,
      concurrency_evidence: report.concurrency_evidence,
      physical_worker_evidence: report.physical_worker_evidence,
      actors: report.actors,
      rounds: report.rounds,
      event_counts: report.event_counts,
      model_dispatch_evidence: report.model_dispatch_evidence,
      surface_digests: report.surface_digests,
    },
  };
  assertFailures("durable prepare state", durableStateFailures(state));
  writeSanitizedJson(statePath, state);
  return state;
}

async function waitForColdResumeWaiting(runId, actorIds) {
  let progress;
  const leaseReacquired = new Set();
  let nextLogAt = 0;
  while (true) {
    const [status, actors] = await Promise.all([
      request(`/api/runs/${encodeURIComponent(runId)}/status`),
      request(`/api/runs/${encodeURIComponent(runId)}/actors`),
    ]);
    assertFailures("cold resume actor contract", actorSnapshotFailures(actors, EXPECTED_ACTOR_IDS, { requireLeases: true }));
    for (const actor of actors.actors) {
      if (actorIds.includes(actor.actor_id) && actor?.lease?.state === "leased") {
        leaseReacquired.add(actor.actor_id);
      }
    }
    const observedAt = Date.now();
    progress = observeRunProgress(progress, status, observedAt);
    if (status.status === "waiting") {
      return { status, actors, lease_reacquired_actor_ids: [...leaseReacquired].sort() };
    }
    if (TERMINAL_STATUSES.has(status.status)) throw new Error(`cold resume reached unexpected terminal status ${status.status}`);
    const stalledForMs = observedAt - progress.last_progress_at;
    assertNotStalled("cold actor resume", stalledForMs);
    if (observedAt >= nextLogAt) {
      console.log(`cold resume: ${status.status}; reacquired=${leaseReacquired.size}/${actorIds.length}`);
      nextLogAt = observedAt + 10000;
    }
    await sleep(pollIntervalMs);
  }
}

function loadDurableState() {
  let state;
  try {
    state = JSON.parse(fs.readFileSync(statePath, "utf8"));
  } catch (error) {
    throw new Error(`Unable to read durable state file: ${error instanceof Error ? error.message : String(error)}`);
  }
  assertFailures("durable resume state", durableStateFailures(state));
  if (state.stage !== "prepared") throw new Error(`Durable state stage must be prepared, observed ${state.stage}`);
  return state;
}

function loadRestartEvidence(invocationPhase) {
  if (invocationPhase !== "resume") {
    return {
      manager_restart_verified: false,
      continuous_process_validation: true,
    };
  }
  if (!restartEvidencePath) throw new Error("--restart-evidence is required for the resume phase");
  let evidence;
  try {
    evidence = JSON.parse(fs.readFileSync(restartEvidencePath, "utf8"));
  } catch (error) {
    throw new Error(`Unable to read Manager restart evidence: ${error instanceof Error ? error.message : String(error)}`);
  }
  const requiredTrue = [
    "manager_pid_changed",
    "manager_healthy",
    "node_pid_preserved",
    "ui_processes_preserved_or_absent",
  ];
  const failed = requiredTrue.filter((key) => evidence?.[key] !== true);
  if (failed.length > 0) throw new Error(`Manager-only restart evidence failed: ${failed.join(", ")}`);
  assertFailures(
    "Manager restart evidence safety",
    unsafeReportPaths(evidence).map((entry) => `unsafe field ${entry}`),
  );
  return { ...evidence, manager_restart_verified: true };
}

async function resumePhase(report, state, invocationPhase) {
  const settingId = state.run.setting_id;
  if (requestedSettingId && requestedSettingId !== settingId) {
    throw new Error("--setting-id does not match the durable prepare state");
  }
  if (profileId !== state.run.profile_id) throw new Error("--profile-id does not match the durable prepare state");
  if (interventionActorId !== state.intervention_actor_id) {
    throw new Error("--intervention-actor does not match the durable prepare state");
  }
  const runId = state.run.run_id;
  report.run = state.run;
  report.phase_evidence.prepare = state.preparation.phase_evidence;
  report.intervention_isolation = state.preparation.intervention_isolation;
  report.lease_release_cold_resume = state.preparation.lease_release_cold_resume;
  report.model_dispatch_evidence = state.preparation.model_dispatch_evidence;
  report.manager_control = state.preparation.manager_control;
  report.concurrency_evidence = state.preparation.concurrency_evidence;
  report.physical_worker_evidence = state.preparation.physical_worker_evidence;
  report.restart_recovery = {
    manager_only_restart: loadRestartEvidence(invocationPhase),
  };

  const recovered = await captureWaitingEvidence({
    run_id: runId,
    setting_id: settingId,
    expected_ordinal: state.prepared_round.ordinal,
    target_actor_ids: EXPECTED_ACTOR_IDS,
    activity_actor_ids: EXPECTED_ACTOR_IDS,
    require_progress: false,
    consumer_label: `recovered-waiting-${invocationPhase}`,
  });
  assertFailures(
    "Manager recovery Surface equality",
    storedSurfaceRecoveryFailures(state.prepared_surfaces, recovered.surface_analysis),
  );
  const coldActorId = state.cold_resume_actor_id;
  const recoveredActor = recovered.raw.actors.actors.find((actor) => actor.actor_id === coldActorId);
  if (recoveredActor?.lease?.state !== "dormant") {
    throw new Error(`Recovered cold-resume actor lease is ${recoveredActor?.lease?.state ?? "missing"}, expected dormant`);
  }
  const recoveredSurface = recovered.surface_analysis.actors.find((actor) => actor.actor_id === coldActorId);
  report.phase_evidence.resume = {
    recovered_waiting: {
      ...recovered.report,
      byte_identical_to_prepare: true,
      phase_boundary: invocationPhase === "resume" ? "separate-prepare-resume" : "continuous-all",
    },
  };

  report.manager_control.continue_after_restart = await continueAllActorsThroughManager(
    settingId,
    state.manager_session_id,
    runId,
    state.prepared_round.round_id,
    "the post-restart cold continuation",
  );
  const observed = await waitForColdResumeWaiting(runId, EXPECTED_ACTOR_IDS);
  const final = await captureWaitingEvidence({
    run_id: runId,
    setting_id: settingId,
    expected_ordinal: state.prepared_round.ordinal + 1,
    target_actor_ids: EXPECTED_ACTOR_IDS,
    activity_actor_ids: EXPECTED_ACTOR_IDS,
    require_progress: false,
    consumer_label: "cold-resume-waiting",
  });
  const coldFailures = coldResumeGroupFailures(
    recovered.surface_analysis,
    final.surface_analysis,
    EXPECTED_ACTOR_IDS,
  );
  const commandEvidence = await roundCommandEvidence(
    runId,
    final.raw.status.current_round.round_id,
    EXPECTED_ACTOR_IDS,
  );
  coldFailures.push(...dispatchGroupFailures(recovered.model, final.model, EXPECTED_ACTOR_IDS, 1, 4));
  const physicalAfterResume = await waitForPhysicalLifecycle(runId, {
    expected_node_ids: EXPECTED_ACTOR_IDS,
    minimum_distinct_workers: EXPECTED_ACTOR_IDS.length,
    require_idle_release_actor: coldActorId,
    require_reprovisioned_node_ids: [coldActorId],
  }, "physical Worker cold resume");
  report.physical_worker_evidence.after_cold_resume = physicalAfterResume;
  const finalActor = final.raw.actors.actors.find((actor) => actor.actor_id === coldActorId);
  const finalSurface = final.surface_analysis.actors.find((actor) => actor.actor_id === coldActorId);
  const physicalReacquired = physicalAfterResume.reprovisioned_node_ids.includes(coldActorId);
  coldFailures.push(...coldResumeLifecycleFailures({
    before_lease_state: recoveredActor.lease.state,
    lease_reacquired: observed.lease_reacquired_actor_ids.includes(coldActorId) || physicalReacquired,
    after_status: final.raw.status.status,
    actor_id_before: recoveredActor.actor_id,
    actor_id_after: finalActor?.actor_id,
    surface_id_before: recoveredSurface?.surface_id,
    surface_id_after: finalSurface?.surface_id,
    before_round_ordinal: state.prepared_round.ordinal,
    after_round_ordinal: final.raw.status.current_round.ordinal,
    command_status: commandEvidence.acknowledged_count === EXPECTED_ACTOR_IDS.length
      ? "acknowledged"
      : "failed",
  }));
  assertFailures("cold logical Actor group resume", coldFailures);

  report.manager_control.continue_after_restart = {
    ...report.manager_control.continue_after_restart,
    command_result: commandEvidence,
  };
  report.manager_control.synthesis_after_restart = await synthesizeThroughManager(
    settingId,
    state.manager_session_id,
    runId,
    "post-restart final",
  );
  report.restart_recovery = {
    ...report.restart_recovery,
    surface_byte_identical: true,
    same_manager_session: report.manager_control.synthesis_after_restart.session_id === state.manager_session_id,
    same_logical_actor_group: true,
  };
  if (!report.restart_recovery.same_manager_session) {
    throw new Error("Manager session identity changed across Manager restart");
  }

  report.phase_evidence.resume.cold_resume_waiting = final.report;
  report.lease_release_cold_resume = {
    ...report.lease_release_cold_resume,
    resume: {
      actor_id: coldActorId,
      surface_id: finalSurface.surface_id,
      generation_before: recoveredSurface.generation,
      generation_after: finalSurface.generation,
      lease_state_before: "dormant",
      lease_reacquired: true,
      physically_reprovisioned: physicalReacquired,
      command_status: "acknowledged",
      resumed_actor_ids: [...EXPECTED_ACTOR_IDS],
      round_before: state.prepared_round.round_id,
      round_after: final.raw.status.current_round.round_id,
      waiting_again: true,
      same_actor_id: true,
      same_surface_id: true,
    },
    passed: true,
  };
  report.actors = final.report.actors;
  report.rounds = compactRounds(final.raw.rounds);
  report.event_counts = final.report.event_counts;
  report.model_dispatch_evidence = {
    ...report.model_dispatch_evidence,
    recovered_waiting: recovered.model.actors,
    cold_resume_waiting: final.model.actors,
  };
  report.surface_snapshot = final.report.surface_snapshot;
  report.surface_digests = final.report.surface_digests;
  report.semantic_grounding = final.report.semantic_grounding;

  const completedState = {
    ...state,
    stage: "complete",
    completed_at: new Date().toISOString(),
    completion: {
      phase_evidence: report.phase_evidence.resume,
      lease_release_cold_resume: report.lease_release_cold_resume,
      manager_control: report.manager_control,
      restart_recovery: report.restart_recovery,
      physical_worker_evidence: report.physical_worker_evidence,
      actors: report.actors,
      rounds: report.rounds,
      event_counts: report.event_counts,
      model_dispatch_evidence: report.model_dispatch_evidence,
      surface_digests: report.surface_digests,
      surface_snapshot: report.surface_snapshot,
      semantic_grounding: report.semantic_grounding,
    },
  };
  assertFailures("durable completed state", durableStateFailures(completedState));
  writeSanitizedJson(statePath, completedState);
}

function writeSanitizedJson(filename, value) {
  const sanitized = sanitizeForReport(value, { secrets: redactionSecrets });
  const unsafe = unsafeReportPaths(sanitized);
  if (unsafe.length > 0) throw new Error(`Refusing to persist unsafe report fields: ${unsafe.join(", ")}`);
  const directory = path.dirname(filename);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = `${filename}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(sanitized, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    fs.renameSync(temporary, filename);
    fs.chmodSync(filename, 0o600);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
  return sanitized;
}

const report = {
  schema_version: 1,
  scenario: SHOWCASE_SCENARIO,
  phase,
  generated_at: new Date().toISOString(),
  acceptance_complete: false,
  run: null,
  actor_ids: [...EXPECTED_ACTOR_IDS],
  model: expectedModel || null,
  actors: [],
  rounds: [],
  event_counts: { total: 0, by_actor: {} },
  phase_evidence: { prepare: null, resume: null },
  manager_control: null,
  concurrency_evidence: null,
  physical_worker_evidence: null,
  restart_recovery: null,
  intervention_isolation: null,
  lease_release_cold_resume: null,
  model_dispatch_evidence: {},
  surface_digests: [],
  surface_snapshot: null,
  semantic_grounding: null,
  terminal_diagnostics: [],
  failures: [],
  passed: false,
};

try {
  let state;
  if (phase === "all" || phase === "prepare") {
    state = await preparePhase(report, requestedSettingId, phase);
    report.passed = true;
    if (phase === "prepare") {
      report.acceptance_complete = false;
    }
  } else {
    state = loadDurableState();
  }
  if (phase === "all" || phase === "resume") {
    await resumePhase(report, state, phase);
    report.acceptance_complete = phase === "resume"
      && report.restart_recovery?.manager_only_restart?.manager_restart_verified === true;
    report.passed = true;
  }
} catch (error) {
  report.failures.push(error instanceof Error ? error.message : String(error));
  report.passed = false;
  report.acceptance_complete = false;
  process.exitCode = 1;
}

report.generated_at = new Date().toISOString();
const persistedReport = writeSanitizedJson(outputPath, report);
console.log(
  `${SHOWCASE_SCENARIO}: ${persistedReport.passed ? "PASS" : "FAIL"}; phase=${phase}; `
  + `acceptance_complete=${persistedReport.acceptance_complete}`,
);
if (!persistedReport.passed) {
  for (const failure of persistedReport.failures) console.error(`failure: ${failure}`);
}
