import { createHash } from "node:crypto";
import { redactTelemetry, type DagActivityEventV1, type DagActivityType } from "homerail-protocol";
import {
  controlDagLiveSurface,
  getDagLiveSurfaceControl,
  getDagLiveSurfaceProjection,
  listDagLiveSurfaceProjections,
} from "../generative-ui/dag-live-surface-projector.js";
import { getDagActorLease } from "../persistence/dag-actor-leases.js";
import {
  listDagActivityEvents,
  listLatestDagActivityRoundResults,
  type DagActivityJournalEntry,
} from "../persistence/dag-activity-journal.js";
import { listDagActorCommands, listDagActors } from "../persistence/dag-actors.js";
import {
  listDagActorInterventions,
  type DagActorInterventionOperation,
  type DagActorInterventionStatus,
} from "../persistence/dag-actor-interventions.js";
import { getDagState, updateDagState } from "../persistence/dag-runtime-primitives.js";
import { getCurrentDagRunRound, listDagRunRounds, type DagRunRoundRecord } from "../persistence/dag-run-rounds.js";
import { loadRunMetadata } from "../persistence/store.js";
import { getDagActorControlState, type DagActorControlStateName } from "./dag-actor-control-state.js";

const SUPERVISOR_CURSOR_NAMESPACE = "manager_supervisor_cursor_v2";
const SUPERVISOR_CURSOR_SCHEMA_VERSION = 2;
const MAX_SUPERVISOR_ACTORS = 64;
const MAX_MILESTONES = 12;
const MAX_PENDING_TOOLS_PER_ACTOR = 8;
const MAX_TOOL_NAME_LENGTH = 96;
const MAX_MILESTONE_SUMMARY_LENGTH = 240;
const MAX_COMMENTARY_LENGTH = 320;
const MILESTONE_TYPES = new Set<DagActivityType>(["finding", "blocked", "completed", "failed"]);
const TERMINAL_ACTIVITY_TYPES = new Set<DagActivityType>(["blocked", "completed", "failed"]);

export interface DagSupervisorActorSummary {
  actor_id: string;
  role: string;
  actor_state: DagActorControlStateName;
  state_token: string;
  activity_state: string;
  visibility_state: string;
  round_targeted: boolean;
  lease?: {
    state: "leased" | "dormant" | "retired";
    pinned: boolean;
    idle_deadline?: number;
    retained_until?: number;
  };
  commands: Record<string, number>;
  latest_intervention?: DagSupervisorInterventionSummary;
}

export interface DagSupervisorInterventionSummary {
  intervention_id: string;
  operation: DagActorInterventionOperation;
  status: DagActorInterventionStatus;
  summary: string;
  created_at: number;
  completed_at?: number;
}

export interface DagSupervisorInterventionMilestone extends DagSupervisorInterventionSummary {
  milestone_id: string;
  actor_id: string;
  role: string;
  timestamp: number;
}

export interface DagSupervisorMilestone {
  milestone_id: string;
  journal_seq: number;
  event_id: string;
  round_id: string;
  actor_id: string;
  role: string;
  type: "finding" | "blocked" | "completed" | "failed";
  summary: string;
  tools_used: string[];
  timestamp: number;
}

export interface DagSupervisorRoundResult {
  actor_id: string;
  role: string;
  outcome: "finding" | "blocked" | "completed" | "failed";
  summary: string;
  event_id: string;
  journal_seq: number;
}

export interface DagSupervisorRound {
  round_id: string;
  ordinal: number;
  status: DagRunRoundRecord["status"];
  target_actor_count: number;
  target_actor_ids: string[];
  targets_truncated: boolean;
  opened_at: number;
  closed_at?: number;
  expires_at?: number;
}

export interface DagSupervisorRoundSummary {
  round_id: string;
  ordinal: number;
  status: DagRunRoundRecord["status"];
  target_actor_count: number;
  target_actor_ids: string[];
  targets_truncated: boolean;
  accepted_result_count: number;
  accepted_results: DagSupervisorRoundResult[];
  results_truncated: boolean;
  complete: boolean;
}

export interface DagSupervisionSnapshot {
  run_id: string;
  workflow_id?: string;
  run_status: string;
  actor_count: number;
  actors_truncated: boolean;
  actors: DagSupervisorActorSummary[];
  current_round?: DagSupervisorRound;
  round_summary?: DagSupervisorRoundSummary;
  milestone_digest: {
    consumer_digest: string;
    after_seq: number;
    next_after_seq: number;
    has_more: boolean;
    suppressed_progress_events: number;
    milestones: DagSupervisorMilestone[];
    intervention_milestones: DagSupervisorInterventionMilestone[];
    commentary: string[];
  };
}

interface SupervisorCursorV2 {
  schema_version: 2;
  run_id: string;
  consumer_digest: string;
  next_after_seq: number;
  pending_tools: Record<string, string[]>;
  seen_intervention_ids: string[];
}

function assertIdentifier(value: string, label: string, maxLength = 256): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new Error(`${label} must be between 1 and ${maxLength} printable characters`);
  }
  return normalized;
}

function assertMaxMilestones(value: number | undefined): number {
  const normalized = value ?? 8;
  if (!Number.isSafeInteger(normalized) || normalized < 1 || normalized > MAX_MILESTONES) {
    throw new Error(`max_milestones must be between 1 and ${MAX_MILESTONES}`);
  }
  return normalized;
}

function shortText(value: unknown, maxLength = MAX_MILESTONE_SUMMARY_LENGTH): string | undefined {
  if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") return undefined;
  const redacted = redactTelemetry({ value }) as { value?: unknown };
  const normalized = String(redacted.value ?? "").replace(/\s+/g, " ").trim();
  if (!normalized) return undefined;
  return normalized.length <= maxLength ? normalized : `${normalized.slice(0, maxLength - 1)}…`;
}

function eventSummary(event: DagActivityEventV1): string {
  const payload = redactTelemetry(event.payload) as Record<string, unknown>;
  const keys = ["summary", "message", "finding", "result", "reason", "title", "status", "stage", "current_stage"];
  for (const key of keys) {
    const direct = shortText(payload[key]);
    if (direct) return direct;
    const nested = payload[key];
    if (nested && typeof nested === "object" && !Array.isArray(nested)) {
      for (const nestedKey of keys) {
        const candidate = shortText((nested as Record<string, unknown>)[nestedKey]);
        if (candidate) return candidate;
      }
    }
  }
  const fallback: Record<string, string> = {
    finding: "报告了一项关键发现",
    blocked: "报告了一个阻塞条件",
    completed: "完成了当前轮任务",
    failed: "当前轮任务失败",
  };
  return fallback[event.type] ?? "状态已更新";
}

function normalizeToolName(value: unknown): string | undefined {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return normalizeToolName((value as Record<string, unknown>).name);
  }
  const name = shortText(value, MAX_TOOL_NAME_LENGTH);
  if (!name || !/^[A-Za-z0-9_.:/-]+$/.test(name)) return undefined;
  return name;
}

function eventToolNames(event: DagActivityEventV1): string[] {
  if (event.type !== "tool_used") return [];
  const payload = redactTelemetry(event.payload) as Record<string, unknown>;
  const candidates: unknown[] = [payload.tool, payload.tool_name, payload.name];
  if (Array.isArray(payload.tools)) candidates.push(...payload.tools);
  return Array.from(new Set(candidates.map(normalizeToolName).filter((value): value is string => Boolean(value))))
    .sort()
    .slice(0, MAX_PENDING_TOOLS_PER_ACTOR);
}

function cursorKey(runId: string, consumerId: string): { key: string; digest: string } {
  const digest = createHash("sha256").update(`${runId}\0${consumerId}`).digest("hex");
  return { key: `${runId}:${digest.slice(0, 32)}`, digest };
}

function decodeCursor(value: unknown, runId: string, consumerDigest: string): SupervisorCursorV2 {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {
      schema_version: SUPERVISOR_CURSOR_SCHEMA_VERSION,
      run_id: runId,
      consumer_digest: consumerDigest,
      next_after_seq: 0,
      pending_tools: {},
      seen_intervention_ids: [],
    };
  }
  const candidate = value as Partial<SupervisorCursorV2>;
  if (
    candidate.schema_version !== SUPERVISOR_CURSOR_SCHEMA_VERSION
    || candidate.run_id !== runId
    || candidate.consumer_digest !== consumerDigest
    || !Number.isSafeInteger(candidate.next_after_seq)
    || Number(candidate.next_after_seq) < 0
  ) {
    throw new Error("Manager Supervisor cursor identity is invalid");
  }
  const pendingTools: Record<string, string[]> = {};
  if (candidate.pending_tools && typeof candidate.pending_tools === "object" && !Array.isArray(candidate.pending_tools)) {
    for (const [actorId, tools] of Object.entries(candidate.pending_tools).slice(0, MAX_SUPERVISOR_ACTORS)) {
      if (!Array.isArray(tools)) continue;
      pendingTools[actorId] = Array.from(new Set(tools.map(normalizeToolName).filter((tool): tool is string => Boolean(tool))))
        .sort()
        .slice(0, MAX_PENDING_TOOLS_PER_ACTOR);
    }
  }
  return {
    schema_version: SUPERVISOR_CURSOR_SCHEMA_VERSION,
    run_id: runId,
    consumer_digest: consumerDigest,
    next_after_seq: Number(candidate.next_after_seq),
    pending_tools: pendingTools,
    seen_intervention_ids: Array.isArray(candidate.seen_intervention_ids)
      ? Array.from(new Set(candidate.seen_intervention_ids
          .filter((id): id is string => typeof id === "string" && id.length > 0 && id.length <= 256)))
          .slice(-500)
      : [],
  };
}

function milestoneFromEntry(
  entry: DagActivityJournalEntry,
  role: string,
  toolsUsed: string[],
): DagSupervisorMilestone {
  const event = entry.event;
  const type = event.type as DagSupervisorMilestone["type"];
  return {
    milestone_id: createHash("sha256")
      .update(`${entry.seq}\0${event.event_id}\0${event.actor_id}\0${event.generation}`)
      .digest("hex"),
    journal_seq: entry.seq,
    event_id: event.event_id,
    round_id: event.round_id,
    actor_id: event.actor_id,
    role,
    type,
    summary: eventSummary(event),
    tools_used: toolsUsed,
    timestamp: event.timestamp,
  };
}

function commentaryFor(milestones: DagSupervisorMilestone[]): string[] {
  if (milestones.length === 0) return [];
  const labels: Record<DagSupervisorMilestone["type"], string> = {
    finding: "发现",
    blocked: "受阻",
    completed: "完成",
    failed: "失败",
  };
  const segments = milestones.slice(0, 3).map((milestone) => (
    `${milestone.role || milestone.actor_id}${labels[milestone.type]}：${shortText(milestone.summary, 88)}`
  ));
  const overflow = milestones.length > 3 ? `；另有 ${milestones.length - 3} 项里程碑` : "";
  const commentary = `${segments.join("；")}${overflow}`;
  return [commentary.length <= MAX_COMMENTARY_LENGTH
    ? commentary
    : `${commentary.slice(0, MAX_COMMENTARY_LENGTH - 1)}…`];
}

function interventionSummary(operation: DagActorInterventionOperation, status: DagActorInterventionStatus): string {
  if (status === "failed") return "干预未能应用，原有证据仍保留";
  switch (operation) {
    case "retry": return "已从持久检查点开始新的重试";
    case "reassign": return "已换用其他可用执行资源继续任务";
    case "checkpoint_fork": return "已从指定检查点开启新的执行分支";
    case "interrupt": return "当前尝试已中断，证据已保留";
    case "cancel": return "当前 Actor 分支已取消，证据已保留";
  }
}

function interventionCommentary(milestones: DagSupervisorInterventionMilestone[]): string[] {
  if (milestones.length === 0) return [];
  const text = milestones.slice(0, 3)
    .map((milestone) => `${milestone.role || milestone.actor_id}：${milestone.summary}`)
    .join("；");
  const overflow = milestones.length > 3 ? `；另有 ${milestones.length - 3} 项干预` : "";
  const commentary = `${text}${overflow}`;
  return [commentary.length <= MAX_COMMENTARY_LENGTH
    ? commentary
    : `${commentary.slice(0, MAX_COMMENTARY_LENGTH - 1)}…`];
}

function buildActorSummaries(runId: string, round?: DagRunRoundRecord): {
  actor_count: number;
  actors_truncated: boolean;
  actors: DagSupervisorActorSummary[];
} {
  const allActors = listDagActors(runId);
  const projections = new Map(listDagLiveSurfaceProjections(runId).map((projection) => [projection.actor_id, projection]));
  const actors = allActors.slice(0, MAX_SUPERVISOR_ACTORS).map((actor): DagSupervisorActorSummary => {
    const controlState = getDagActorControlState(runId, actor.actor_id);
    const projection = projections.get(actor.actor_id);
    const lease = getDagActorLease({ run_id: runId, actor_id: actor.actor_id });
    const commandCounts: Record<string, number> = {};
    for (const command of listDagActorCommands({ run_id: runId, actor_id: actor.actor_id, limit: 500 })) {
      commandCounts[command.status] = (commandCounts[command.status] ?? 0) + 1;
    }
    const latestIntervention = listDagActorInterventions({
      run_id: runId,
      actor_id: actor.actor_id,
      limit: 1,
    })[0];
    return {
      actor_id: actor.actor_id,
      role: actor.role,
      actor_state: controlState.actor_state,
      state_token: controlState.state_token,
      activity_state: projection?.activity_state ?? "pending",
      visibility_state: projection?.visibility_state ?? "unprojected",
      round_targeted: round?.target_actor_ids.includes(actor.actor_id) ?? false,
      ...(lease
        ? {
          lease: {
            state: lease.state,
            pinned: lease.pinned,
            ...(lease.idle_deadline === undefined ? {} : { idle_deadline: lease.idle_deadline }),
            ...(lease.retained_until === undefined ? {} : { retained_until: lease.retained_until }),
          },
        }
        : {}),
      commands: commandCounts,
      ...(latestIntervention
        ? {
          latest_intervention: {
            intervention_id: latestIntervention.intervention_id,
            operation: latestIntervention.operation,
            status: latestIntervention.status,
            summary: interventionSummary(latestIntervention.operation, latestIntervention.status),
            created_at: latestIntervention.created_at,
            ...(latestIntervention.completed_at === undefined
              ? {}
              : { completed_at: latestIntervention.completed_at }),
          },
        }
        : {}),
    };
  });
  return {
    actor_count: allActors.length,
    actors_truncated: allActors.length > actors.length,
    actors,
  };
}

function latestRound(runId: string): DagRunRoundRecord | undefined {
  return getCurrentDagRunRound(runId) ?? listDagRunRounds(runId).at(-1);
}

function publicRound(round: DagRunRoundRecord): DagSupervisorRound {
  const targetActorIds = round.target_actor_ids.slice(0, MAX_SUPERVISOR_ACTORS);
  return {
    round_id: round.round_id,
    ordinal: round.ordinal,
    status: round.status,
    target_actor_count: round.target_actor_ids.length,
    target_actor_ids: targetActorIds,
    targets_truncated: targetActorIds.length < round.target_actor_ids.length,
    opened_at: round.opened_at,
    ...(round.closed_at === undefined ? {} : { closed_at: round.closed_at }),
    ...(round.expires_at === undefined ? {} : { expires_at: round.expires_at }),
  };
}

function buildRoundSummary(runId: string, round: DagRunRoundRecord | undefined): DagSupervisorRoundSummary | undefined {
  if (!round) return undefined;
  const actorsById = new Map(listDagActors(runId).map((actor) => [actor.actor_id, actor]));
  const accepted = new Map<string, DagSupervisorRoundResult>();
  const page = listLatestDagActivityRoundResults({
    run_id: runId,
    round_id: round.round_id,
  });
  for (const entry of page.events) {
    const event = entry.event;
    const actor = actorsById.get(event.actor_id);
    if (!actor) continue;
    accepted.set(event.actor_id, {
      actor_id: event.actor_id,
      role: actor.role,
      outcome: event.type as DagSupervisorRoundResult["outcome"],
      summary: eventSummary(event),
      event_id: event.event_id,
      journal_seq: entry.seq,
    });
  }
  const allAcceptedResults = round.target_actor_ids
    .map((actorId) => accepted.get(actorId))
    .filter((result): result is DagSupervisorRoundResult => Boolean(result));
  const acceptedResults = allAcceptedResults.slice(0, MAX_SUPERVISOR_ACTORS);
  const currentRound = publicRound(round);
  return {
    round_id: round.round_id,
    ordinal: round.ordinal,
    status: round.status,
    target_actor_count: currentRound.target_actor_count,
    target_actor_ids: currentRound.target_actor_ids,
    targets_truncated: currentRound.targets_truncated,
    accepted_result_count: allAcceptedResults.length,
    accepted_results: acceptedResults,
    results_truncated: acceptedResults.length < allAcceptedResults.length || page.truncated,
    complete: round.target_actor_ids.length > 0
      && round.target_actor_ids.every((actorId) => {
        const result = accepted.get(actorId);
        return Boolean(result && TERMINAL_ACTIVITY_TYPES.has(result.outcome));
      }),
  };
}

function consumeMilestones(input: {
  run_id: string;
  consumer_id: string;
  max_milestones?: number;
}): DagSupervisionSnapshot["milestone_digest"] {
  const runId = input.run_id;
  const consumer = assertIdentifier(input.consumer_id, "consumer_id", 512);
  const maxMilestones = assertMaxMilestones(input.max_milestones);
  const identity = cursorKey(runId, consumer);
  const stateKey = identity.key;
  const state = getDagState(SUPERVISOR_CURSOR_NAMESPACE, stateKey);
  const cursor = decodeCursor(state?.value, runId, identity.digest);
  const actorsById = new Map(listDagActors(runId).map((actor) => [actor.actor_id, actor]));
  const page = listDagActivityEvents({ run_id: runId, after_seq: cursor.next_after_seq, limit: 500 });
  const pendingTools = structuredClone(cursor.pending_tools);
  const milestones: DagSupervisorMilestone[] = [];
  const seenInterventionIds = new Set(cursor.seen_intervention_ids);
  const interventionMilestones: DagSupervisorInterventionMilestone[] = [];
  let nextAfterSeq = cursor.next_after_seq;
  let suppressedProgressEvents = 0;
  let stoppedEarly = false;

  for (const entry of page.events) {
    nextAfterSeq = entry.seq;
    const event = entry.event;
    const actor = actorsById.get(event.actor_id);
    if (!actor || event.generation !== actor.generation) continue;
    if (event.type === "tool_used") {
      const tools = new Set([...(pendingTools[event.actor_id] ?? []), ...eventToolNames(event)]);
      pendingTools[event.actor_id] = [...tools].sort().slice(0, MAX_PENDING_TOOLS_PER_ACTOR);
      continue;
    }
    if (event.type === "progress" || event.type === "started") {
      if (event.type === "progress") suppressedProgressEvents += 1;
      continue;
    }
    if (!MILESTONE_TYPES.has(event.type)) continue;
    const tools = pendingTools[event.actor_id] ?? [];
    milestones.push(milestoneFromEntry(entry, actor.role, tools));
    delete pendingTools[event.actor_id];
    if (milestones.length >= maxMilestones) {
      stoppedEarly = entry.seq < page.next_after_seq || page.has_more;
      break;
    }
  }

  const pendingInterventions = listDagActorInterventions({ run_id: runId, limit: 500 })
    .reverse()
    .filter((intervention) => (
      (intervention.status === "applied" || intervention.status === "failed")
      && !seenInterventionIds.has(intervention.intervention_id)
    ));
  const remainingMilestoneBudget = Math.max(0, maxMilestones - milestones.length);
  for (const intervention of pendingInterventions.slice(0, remainingMilestoneBudget)) {
    const actor = actorsById.get(intervention.actor_id);
    if (!actor) continue;
    const summary = interventionSummary(intervention.operation, intervention.status);
    interventionMilestones.push({
      milestone_id: createHash("sha256")
        .update(`intervention\0${intervention.intervention_id}`)
        .digest("hex"),
      intervention_id: intervention.intervention_id,
      actor_id: intervention.actor_id,
      role: actor.role,
      operation: intervention.operation,
      status: intervention.status,
      summary,
      created_at: intervention.created_at,
      ...(intervention.completed_at === undefined ? {} : { completed_at: intervention.completed_at }),
      timestamp: intervention.completed_at ?? intervention.started_at ?? intervention.created_at,
    });
    seenInterventionIds.add(intervention.intervention_id);
    delete pendingTools[intervention.actor_id];
  }
  const interventionsHaveMore = pendingInterventions.length > interventionMilestones.length;
  const nextSeenInterventionIds = Array.from(seenInterventionIds).slice(-500);

  if (
    nextAfterSeq !== cursor.next_after_seq
    || JSON.stringify(pendingTools) !== JSON.stringify(cursor.pending_tools)
    || JSON.stringify(nextSeenInterventionIds) !== JSON.stringify(cursor.seen_intervention_ids)
  ) {
    const updated = updateDagState({
      namespace: SUPERVISOR_CURSOR_NAMESPACE,
      key: stateKey,
      expectedVersion: state?.version ?? 0,
      runId,
      value: {
        schema_version: SUPERVISOR_CURSOR_SCHEMA_VERSION,
        run_id: runId,
        consumer_digest: identity.digest,
        next_after_seq: nextAfterSeq,
        pending_tools: pendingTools,
        seen_intervention_ids: nextSeenInterventionIds,
      } satisfies SupervisorCursorV2,
    });
    if (!updated.updated) throw new Error("Manager Supervisor cursor changed concurrently; retry status query");
  }

  return {
    consumer_digest: identity.digest,
    after_seq: cursor.next_after_seq,
    next_after_seq: nextAfterSeq,
    has_more: stoppedEarly || (nextAfterSeq >= page.next_after_seq && page.has_more) || interventionsHaveMore,
    suppressed_progress_events: suppressedProgressEvents,
    milestones,
    intervention_milestones: interventionMilestones,
    commentary: [...commentaryFor(milestones), ...interventionCommentary(interventionMilestones)],
  };
}

/**
 * Read a bounded, redacted supervision view. Every milestone originated in the
 * accepted Activity Journal; callers cannot submit progress or Worker state.
 */
export function getDagSupervisionSnapshot(input: {
  run_id: string;
  consumer_id: string;
  max_milestones?: number;
}): DagSupervisionSnapshot {
  const runId = assertIdentifier(input.run_id, "run_id");
  const metadata = loadRunMetadata(runId);
  if (!metadata) throw new Error(`Run not found: ${runId}`);
  const round = latestRound(runId);
  const actorSnapshot = buildActorSummaries(runId, round);
  return {
    run_id: runId,
    ...(metadata.workflowId ? { workflow_id: metadata.workflowId } : {}),
    run_status: metadata.status,
    ...actorSnapshot,
    ...(round ? { current_round: publicRound(round) } : {}),
    ...(round ? { round_summary: buildRoundSummary(runId, round) } : {}),
    milestone_digest: consumeMilestones(input),
  };
}

export function listDagSupervisorActors(runId: string): {
  run_id: string;
  actor_count: number;
  actors_truncated: boolean;
  actors: DagSupervisorActorSummary[];
} {
  const normalizedRunId = assertIdentifier(runId, "run_id");
  if (!loadRunMetadata(normalizedRunId)) throw new Error(`Run not found: ${normalizedRunId}`);
  return { run_id: normalizedRunId, ...buildActorSummaries(normalizedRunId, latestRound(normalizedRunId)) };
}

/** Focus is resolved through stable actor identity and the current Projector CAS revision. */
export function focusDagSupervisorActor(input: {
  run_id: string;
  actor_id: string;
  idempotency_key: string;
  duration_ms?: number;
  now?: number;
}): {
  run_id: string;
  actor_id: string;
  visibility_state: "focused";
  focused_until: number;
  control_id: string;
  deduplicated: boolean;
} {
  const runId = assertIdentifier(input.run_id, "run_id");
  const actorId = assertIdentifier(input.actor_id, "actor_id");
  const idempotencyKey = assertIdentifier(input.idempotency_key, "idempotency_key");
  const durationMs = input.duration_ms ?? 12_000;
  if (!Number.isSafeInteger(durationMs) || durationMs < 1_000 || durationMs > 300_000) {
    throw new Error("duration_ms must be between 1000 and 300000");
  }
  const controlId = `manager-focus-${createHash("sha256")
    .update(`${runId}\0${actorId}\0${idempotencyKey}`)
    .digest("hex")}`;
  const previous = getDagLiveSurfaceControl(controlId);
  if (previous) {
    const focusedUntil = previous.focused_until;
    if (
      previous.run_id !== runId
      || previous.actor_id !== actorId
      || previous.operation !== "focused"
      || focusedUntil === undefined
      || focusedUntil - previous.created_at !== durationMs
    ) {
      throw new Error(`Manager focus idempotency key ${idempotencyKey} was reused with different input`);
    }
    const projection = getDagLiveSurfaceProjection(runId, actorId);
    if (!projection) throw new Error(`DAG actor has no projected surface: ${runId}/${actorId}`);
    return {
      run_id: runId,
      actor_id: actorId,
      visibility_state: "focused",
      focused_until: focusedUntil,
      control_id: previous.control_id,
      deduplicated: true,
    };
  }
  const now = input.now ?? Date.now();
  if (!Number.isSafeInteger(now) || now < 0) throw new Error("now must be a non-negative epoch millisecond integer");
  const projection = getDagLiveSurfaceProjection(runId, actorId);
  if (!projection) throw new Error(`DAG actor has no projected surface: ${runId}/${actorId}`);
  const focusedUntil = now + durationMs;
  const result = controlDagLiveSurface({
    control_id: controlId,
    run_id: runId,
    actor_id: actorId,
    operation: "focused",
    expected_surface_revision: projection.surface_revision,
    focused_until: focusedUntil,
    created_at: now,
  });
  return {
    run_id: runId,
    actor_id: actorId,
    visibility_state: "focused",
    focused_until: focusedUntil,
    control_id: result.control_id,
    deduplicated: result.deduplicated,
  };
}
