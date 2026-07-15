import { createHash } from "node:crypto";

export const SHOWCASE_PROFILE_ID = "three-worker-live";
export const SHOWCASE_SCENARIO = "three-worker-live-acceptance";
export const SHOWCASE_STATE_SCHEMA_VERSION = 1;
export const EXPECTED_ACTOR_IDS = Object.freeze([
  "goal_scout",
  "session_coach",
  "systems_guide",
]);
export const DEFAULT_INTERVENTION_ACTOR_ID = "systems_guide";

const ACTOR_STATES = new Set([
  "pending",
  "ready",
  "running",
  "waiting",
  "completed",
  "failed",
  "cancelled",
]);
const LEASE_STATES = new Set(["leased", "dormant", "retired"]);
const REQUIRED_ACTIVITY_TYPES = ["started", "progress", "completed"];
const MILESTONE_TYPES = new Set(["finding", "blocked", "completed", "failed"]);
const FORBIDDEN_REPORT_KEY = /^(?:authorization|authorization_token|api_key|apikey|base_url|container_id|credential|credentials|cwd|docker_node_id|home|manager_admin_token|manager_host|manager_url|mutation_token|password|physical_id|private_machine_config|secret|source_path|state_token|target_id|target_type|token|worker_id|workspace|workspace_path)$/i;
const FORBIDDEN_REPORT_KEY_PART = /(?:^|_)(?:access_token|admin_token|api_key|approval_token|auth_token|credential|mutation_token|password|private_key|refresh_token|secret)(?:$|_)/i;
const FORBIDDEN_PUBLIC_IDENTITY_KEY = /^(?:container_id|docker_node_id|lease_generation|target_id|target_type|worker_id)$/i;

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!isObject(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .filter((key) => value[key] !== undefined)
      .map((key) => [key, canonicalize(value[key])]),
  );
}

export function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

export function digestValue(value) {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export function stableControlId(prefix, ...parts) {
  const normalizedPrefix = String(prefix ?? "control")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "control";
  const digest = createHash("sha256").update(parts.map(String).join("\0")).digest("hex");
  return `${normalizedPrefix}-${digest}`;
}

function redactString(value, secrets) {
  let result = value;
  for (const secret of secrets.filter(Boolean).sort((left, right) => right.length - left.length)) {
    result = result.split(secret).join("***REDACTED***");
  }
  result = result
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, "$1***REDACTED***")
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, "***REDACTED***")
    .replace(/\b(api[_ -]?key|password|secret|token)\s*[:=]\s*[^\s,;]+/gi, "$1=***REDACTED***")
    .replace(/\/(?:Users|Volumes|home)\/[^\s"']+/g, "<private-path>");
  return result.length <= 2_000 ? result : `${result.slice(0, 1_999)}...`;
}

export function sanitizeForReport(value, options = {}) {
  const secrets = Array.isArray(options.secrets)
    ? options.secrets.filter((entry) => typeof entry === "string" && entry.length > 0)
    : [];
  const visit = (entry) => {
    if (typeof entry === "string") return redactString(entry, secrets);
    if (Array.isArray(entry)) return entry.map(visit);
    if (!isObject(entry)) return entry;
    const result = {};
    for (const [key, nested] of Object.entries(entry)) {
      if (FORBIDDEN_REPORT_KEY.test(key) || FORBIDDEN_REPORT_KEY_PART.test(key)) continue;
      result[key] = visit(nested);
    }
    return result;
  };
  return visit(value);
}

function collectForbiddenPaths(value, keyPattern, prefix = "$") {
  const failures = [];
  if (Array.isArray(value)) {
    value.forEach((entry, index) => failures.push(...collectForbiddenPaths(entry, keyPattern, `${prefix}[${index}]`)));
    return failures;
  }
  if (!isObject(value)) return failures;
  for (const [key, nested] of Object.entries(value)) {
    const next = `${prefix}.${key}`;
    if (keyPattern.test(key)) failures.push(next);
    failures.push(...collectForbiddenPaths(nested, keyPattern, next));
  }
  return failures;
}

export function unsafeReportPaths(value) {
  return collectForbiddenPaths(value, new RegExp(
    `${FORBIDDEN_REPORT_KEY.source}|${FORBIDDEN_REPORT_KEY_PART.source}`,
    "i",
  ));
}

function diagnosticError(value) {
  return isObject(value) && typeof value.diagnostic_error === "string"
    ? value.diagnostic_error
    : undefined;
}

function compactDiagnosticEvents(snapshot) {
  const events = Array.isArray(snapshot?.events) ? snapshot.events : [];
  return events.slice(-100).map((event) => {
    const details = isObject(event?.details) ? event.details : {};
    return {
      event_type: event?.event_type ?? event?.type ?? "unknown",
      ...(typeof event?.node_id === "string" && event.node_id ? { node_id: event.node_id } : {}),
      ...(typeof details.port === "string" ? { port: details.port } : {}),
      ...(typeof details.gatewayType === "string" ? { gateway_type: details.gatewayType } : {}),
      ...(typeof details.status === "string" ? { status: details.status } : {}),
      ...(typeof details.reason === "string" ? { reason: details.reason.slice(0, 1_000) } : {}),
    };
  });
}

function compactDiagnosticCounters(counters) {
  if (!isObject(counters)) return {};
  return Object.fromEntries([
    "dispatches",
    "handoffs",
    "edge_traversals",
    "corrections",
    "advisor_calls",
    "dispatch_retries",
    "gateway_iterations",
  ].filter((key) => counters[key] !== undefined).map((key) => [key, counters[key]]));
}

export function unexpectedTerminalDiagnostic(input) {
  const status = isObject(input?.status) ? input.status : {};
  const rounds = Array.isArray(input?.rounds?.rounds) ? input.rounds.rounds : [];
  const handoffs = Array.isArray(input?.handoffs?.handoffs) ? input.handoffs.handoffs : [];
  const surfaces = isObject(input?.surfaces) ? input.surfaces : {};
  const surfaceStates = Array.isArray(surfaces.surface_states) ? surfaces.surface_states : [];
  const activities = Array.isArray(input?.activities) ? input.activities : [];
  const activityTypes = {};
  for (const activity of activities) {
    const event = isObject(activity?.event) ? activity.event : activity;
    const actorId = typeof event?.actor_id === "string" ? event.actor_id : "unknown";
    const type = typeof event?.type === "string" ? event.type : "unknown";
    activityTypes[actorId] ??= {};
    activityTypes[actorId][type] = (activityTypes[actorId][type] ?? 0) + 1;
  }
  const diagnostics = {
    status: status.status ?? "unknown",
    current_round: isObject(status.current_round)
      ? {
          round_id: status.current_round.round_id,
          ordinal: status.current_round.ordinal,
          status: status.current_round.status,
          await_node_id: status.current_round.await_node_id,
        }
      : null,
    node_states: isObject(status.node_states) ? { ...status.node_states } : {},
    counters: compactDiagnosticCounters(status.counters),
    rounds: rounds.map((round) => ({
      round_id: round?.round_id,
      ordinal: round?.ordinal,
      status: round?.status,
      await_node_id: round?.await_node_id,
    })),
    handoffs: handoffs.map((handoff) => ({
      round_id: handoff?.roundId ?? handoff?.round_id,
      from_node: handoff?.fromNode ?? handoff?.from_node,
      port: handoff?.port,
    })),
    actors: actorSnapshotEvidence(input?.actors),
    surfaces: surfaceStates.map((surface) => ({
      actor_id: surface?.actor_id,
      generation_state: surface?.generation_state,
      superseded_count: surface?.superseded_count,
    })),
    activity_counts: activityTypes,
    events: compactDiagnosticEvents(input?.events),
  };
  const requestErrors = Object.fromEntries(
    Object.entries(input ?? {})
      .map(([key, value]) => [key, diagnosticError(value)])
      .filter(([, value]) => value !== undefined),
  );
  return Object.keys(requestErrors).length > 0
    ? { ...diagnostics, request_errors: requestErrors }
    : diagnostics;
}

function exactIdFailures(actual, expected, label) {
  const failures = [];
  const normalized = actual.filter((entry) => typeof entry === "string").slice().sort();
  const wanted = expected.slice().sort();
  if (new Set(normalized).size !== normalized.length) failures.push(`${label} contains duplicate identities`);
  if (canonicalJson(normalized) !== canonicalJson(wanted)) {
    failures.push(`${label} must be exactly ${wanted.join(", ")}; observed ${normalized.join(", ") || "none"}`);
  }
  return failures;
}

export function actorSnapshotFailures(snapshot, expectedActorIds = EXPECTED_ACTOR_IDS, options = {}) {
  const failures = [];
  if (!isObject(snapshot)) return ["actor snapshot must be an object"];
  const actors = Array.isArray(snapshot.actors) ? snapshot.actors : [];
  if (snapshot.actor_count !== expectedActorIds.length) {
    failures.push(`actor_count must be ${expectedActorIds.length}; observed ${String(snapshot.actor_count)}`);
  }
  if (snapshot.actors_truncated !== false) failures.push("actor snapshot must not be truncated");
  if (actors.length !== expectedActorIds.length) {
    failures.push(`actor list must contain ${expectedActorIds.length} entries; observed ${actors.length}`);
  }
  failures.push(...exactIdFailures(actors.map((actor) => actor?.actor_id), expectedActorIds, "logical actors"));
  const leaked = collectForbiddenPaths(snapshot, FORBIDDEN_PUBLIC_IDENTITY_KEY);
  if (leaked.length > 0) failures.push(`public actor snapshot leaked physical identity at ${leaked.join(", ")}`);
  for (const actor of actors) {
    if (!isObject(actor) || typeof actor.actor_id !== "string") continue;
    if (!ACTOR_STATES.has(actor.actor_state)) failures.push(`${actor.actor_id} has invalid actor_state`);
    if (!/^[0-9a-f]{64}$/.test(String(actor.state_token ?? ""))) {
      failures.push(`${actor.actor_id} is missing its opaque actor state token`);
    }
    if (typeof actor.role !== "string" || actor.role.length === 0) failures.push(`${actor.actor_id} is missing its role`);
    if (options.requireLeases && !isObject(actor.lease)) failures.push(`${actor.actor_id} is missing public lease state`);
    if (actor.lease !== undefined) {
      if (!isObject(actor.lease) || !LEASE_STATES.has(actor.lease.state)) {
        failures.push(`${actor.actor_id} has invalid public lease state`);
      } else {
        if (typeof actor.lease.pinned !== "boolean") failures.push(`${actor.actor_id} lease is missing pinned state`);
        if (actor.lease.state === "leased" && !Number.isSafeInteger(actor.lease.idle_deadline)) {
          failures.push(`${actor.actor_id} leased state is missing idle_deadline`);
        }
        if (actor.lease.state === "dormant" && !Number.isSafeInteger(actor.lease.retained_until)) {
          failures.push(`${actor.actor_id} dormant state is missing retained_until`);
        }
      }
    }
  }
  return failures;
}

export function actorSnapshotEvidence(snapshot) {
  const actors = Array.isArray(snapshot?.actors) ? snapshot.actors : [];
  return actors
    .filter(isObject)
    .map((actor) => ({
      actor_id: actor.actor_id,
      role: actor.role,
      actor_state: actor.actor_state,
      activity_state: actor.activity_state,
      visibility_state: actor.visibility_state,
      round_targeted: actor.round_targeted,
      ...(isObject(actor.lease)
        ? {
          lease: {
            state: actor.lease.state,
            pinned: actor.lease.pinned,
            ...(Number.isSafeInteger(actor.lease.idle_deadline)
              ? { idle_deadline: actor.lease.idle_deadline }
              : {}),
            ...(Number.isSafeInteger(actor.lease.retained_until)
              ? { retained_until: actor.lease.retained_until }
              : {}),
          },
        }
        : {}),
      commands: isObject(actor.commands) ? { ...actor.commands } : {},
      ...(isObject(actor.latest_intervention)
        ? {
          latest_intervention: {
            intervention_id: actor.latest_intervention.intervention_id,
            operation: actor.latest_intervention.operation,
            status: actor.latest_intervention.status,
          },
        }
        : {}),
    }))
    .sort((left, right) => String(left.actor_id).localeCompare(String(right.actor_id)));
}

function surfaceStructure(projection, node) {
  const data = isObject(node?.content?.data) ? node.content.data : {};
  const state = isObject(data.state) ? data.state : {};
  const actor = isObject(data.actor) ? data.actor : {};
  const a2ui = isObject(node?.a2ui) ? node.a2ui : {};
  const components = Array.isArray(a2ui.components) ? a2ui.components : [];
  return {
    actor_id: projection.actor_id,
    node_id: projection.node_id,
    surface_id: projection.surface_id,
    generation: projection.generation,
    surface_revision: projection.surface_revision,
    last_activity_sequence: projection.last_activity_sequence,
    activity_state: projection.activity_state,
    visibility_state: projection.visibility_state,
    node: {
      id: node?.id,
      kind: node?.kind,
      kind_version: node?.kind_version,
      surface: node?.surface,
      importance: node?.importance,
      revision: node?.revision,
      presentation: isObject(node?.presentation) ? { ...node.presentation } : null,
      actor: {
        id: actor.id,
        role: actor.role,
        node_id: actor.node_id,
        generation: actor.generation,
      },
      state: {
        activity: state.activity,
        visibility: state.visibility,
        progress: state.progress,
        round_id: state.round_id,
        sequence: state.sequence,
        surface_revision: state.surface_revision,
        ...(Number.isSafeInteger(state.focused_until) ? { focused_until: state.focused_until } : {}),
      },
      a2ui: {
        version: a2ui.version,
        catalog_id: a2ui.catalogId,
        component_count: components.length,
        components: components.map((component) => ({ id: component?.id, component: component?.component })),
      },
    },
  };
}

export function analyzeSurfaceSnapshot(snapshot, expectedActorIds = EXPECTED_ACTOR_IDS) {
  const failures = [];
  if (!isObject(snapshot)) return { failures: ["live surface snapshot must be an object"], actors: [] };
  const projections = Array.isArray(snapshot.projections) ? snapshot.projections : [];
  const document = isObject(snapshot.document) ? snapshot.document : undefined;
  const nodes = Array.isArray(document?.nodes) ? document.nodes : [];
  const states = Array.isArray(snapshot.surface_states) ? snapshot.surface_states : [];
  if (projections.length !== expectedActorIds.length) {
    failures.push(`live projections must contain ${expectedActorIds.length} entries; observed ${projections.length}`);
  }
  if (!document) failures.push("live surface document is missing");
  if (nodes.length !== expectedActorIds.length) {
    failures.push(`live surface document must contain ${expectedActorIds.length} nodes; observed ${nodes.length}`);
  }
  failures.push(...exactIdFailures(projections.map((projection) => projection?.actor_id), expectedActorIds, "surface actors"));
  const surfaceIds = projections.map((projection) => projection?.surface_id).filter((id) => typeof id === "string");
  if (new Set(surfaceIds).size !== surfaceIds.length) failures.push("surface_id values must be independent and unique");
  const nodeIds = projections.map((projection) => projection?.node_id).filter((id) => typeof id === "string");
  if (new Set(nodeIds).size !== nodeIds.length) failures.push("logical node_id values must be unique");
  const nodeById = new Map(nodes.filter(isObject).map((node) => [node.id, node]));
  const stateByActor = new Map(states.filter(isObject).map((state) => [state.actor_id, state]));
  const actors = [];

  for (const projection of projections) {
    if (!isObject(projection) || typeof projection.actor_id !== "string") continue;
    const actorId = projection.actor_id;
    const node = nodeById.get(projection.surface_id);
    if (!node) {
      failures.push(`${actorId} projection has no semantic surface node`);
      continue;
    }
    if (projection.run_id !== snapshot.run_id) failures.push(`${actorId} projection run_id changed`);
    if (!Number.isSafeInteger(projection.generation) || projection.generation < 1) {
      failures.push(`${actorId} projection generation is invalid`);
    }
    if (!Number.isSafeInteger(projection.surface_revision) || projection.surface_revision < 1) {
      failures.push(`${actorId} surface revision is invalid`);
    }
    if (node.kind !== "com.homerail.core/generated_view" || node.kind_version !== 2) {
      failures.push(`${actorId} is not a native generated_view v2 surface`);
    }
    if (node.surface !== "execution") failures.push(`${actorId} surface must use execution semantics`);
    if (node.presentation?.density !== "summary" || node.presentation?.canvas_size !== "1x2") {
      failures.push(`${actorId} surface must declare summary 1x2 presentation semantics`);
    }
    const data = node.content?.data;
    if (data?.projector?.id !== "dag-live-surface-projector" || data?.projector?.version !== 1) {
      failures.push(`${actorId} surface has invalid projector provenance`);
    }
    if (
      data?.actor?.id !== actorId
      || data?.actor?.node_id !== projection.node_id
      || data?.actor?.generation !== projection.generation
    ) failures.push(`${actorId} surface actor identity does not match its projection`);
    if (node.provenance?.actor_id !== actorId || node.provenance?.run_id !== snapshot.run_id) {
      failures.push(`${actorId} surface provenance does not match its run`);
    }
    if (data?.state?.surface_revision !== projection.surface_revision) {
      failures.push(`${actorId} semantic node revision does not match its projection`);
    }
    if (!isObject(node.a2ui) || !Array.isArray(node.a2ui.components) || node.a2ui.components.length === 0) {
      failures.push(`${actorId} surface is missing native A2UI components`);
    }
    const surfaceState = stateByActor.get(actorId);
    if (states.length > 0 && (
      !surfaceState
      || surfaceState.surface_id !== projection.surface_id
      || surfaceState.generation_state !== "current"
    )) failures.push(`${actorId} current generation surface state is inconsistent`);

    const nodeCanonical = canonicalJson(node);
    actors.push({
      ...surfaceStructure(projection, node),
      node_canonical: nodeCanonical,
      node_digest: createHash("sha256").update(nodeCanonical).digest("hex"),
      node_bytes: Buffer.byteLength(nodeCanonical, "utf8"),
      ...(isObject(surfaceState)
        ? {
          generation_state: surfaceState.generation_state,
          superseded_count: surfaceState.superseded_count,
          ...(isObject(surfaceState.latest_intervention)
            ? {
              latest_intervention: {
                intervention_id: surfaceState.latest_intervention.intervention_id,
                operation: surfaceState.latest_intervention.operation,
                status: surfaceState.latest_intervention.status,
              },
            }
            : {}),
        }
        : {}),
    });
  }

  return {
    failures,
    actors: actors.sort((left, right) => left.actor_id.localeCompare(right.actor_id)),
  };
}

export function surfaceSnapshotEvidence(analysis) {
  return (analysis?.actors ?? []).map(({ node_canonical: _nodeCanonical, ...actor }) => actor);
}

function normalizedSemanticTerm(value) {
  return String(value ?? "").normalize("NFKC").trim().toLocaleLowerCase();
}

export function surfaceSemanticTermFailures(
  analysis,
  requiredTerms,
  expectedActorIds = EXPECTED_ACTOR_IDS,
) {
  const failures = [];
  const terms = Array.from(new Set((requiredTerms ?? []).map(normalizedSemanticTerm).filter(Boolean)));
  const actors = mapActors(analysis);
  for (const actorId of expectedActorIds) {
    const actor = actors.get(actorId);
    if (!actor) continue;
    const semanticNode = normalizedSemanticTerm(actor.node_canonical);
    for (const term of terms) {
      if (!semanticNode.includes(term)) failures.push(`${actorId} Surface lost required mission evidence`);
    }
  }
  return failures;
}

export function surfaceSemanticTermEvidence(analysis, requiredTerms) {
  const terms = Array.from(new Set((requiredTerms ?? []).map(normalizedSemanticTerm).filter(Boolean)));
  return {
    required_term_digests: terms.map((term) => digestValue(term)).sort(),
    actors: (analysis?.actors ?? []).map((actor) => {
      const semanticNode = normalizedSemanticTerm(actor.node_canonical);
      return {
        actor_id: actor.actor_id,
        matched_required_terms: terms.filter((term) => semanticNode.includes(term)).length,
        required_terms: terms.length,
      };
    }).sort((left, right) => left.actor_id.localeCompare(right.actor_id)),
  };
}

function mapActors(analysis) {
  return new Map((analysis?.actors ?? []).map((actor) => [actor.actor_id, actor]));
}

export function unchangedSurfaceFailures(before, after, actorIds, label = "surface recovery") {
  const failures = [];
  const left = mapActors(before);
  const right = mapActors(after);
  for (const actorId of actorIds) {
    const prior = left.get(actorId);
    const next = right.get(actorId);
    if (!prior || !next) {
      failures.push(`${label}: missing ${actorId}`);
      continue;
    }
    if (prior.surface_id !== next.surface_id || prior.node_id !== next.node_id) {
      failures.push(`${label}: ${actorId} surface identity changed`);
    }
    if (prior.generation !== next.generation) failures.push(`${label}: ${actorId} generation changed`);
    if (prior.surface_revision !== next.surface_revision) failures.push(`${label}: ${actorId} revision changed`);
    if (prior.node_canonical !== next.node_canonical) failures.push(`${label}: ${actorId} semantic node bytes changed`);
  }
  return failures;
}

export function branchIsolationFailures(before, after, selectedActorId, expectedActorIds = EXPECTED_ACTOR_IDS) {
  const failures = [];
  const prior = mapActors(before);
  const next = mapActors(after);
  const selectedBefore = prior.get(selectedActorId);
  const selectedAfter = next.get(selectedActorId);
  if (!selectedBefore || !selectedAfter) return [`intervention isolation is missing ${selectedActorId}`];
  if (selectedBefore.surface_id !== selectedAfter.surface_id || selectedBefore.node_id !== selectedAfter.node_id) {
    failures.push("selected actor did not retain its logical surface identity");
  }
  if (selectedAfter.generation !== selectedBefore.generation + 1) {
    failures.push(`selected actor generation must advance exactly once; observed ${selectedBefore.generation} -> ${selectedAfter.generation}`);
  }
  if (selectedAfter.surface_revision <= selectedBefore.surface_revision) {
    failures.push("selected actor surface revision did not advance");
  }
  if (selectedAfter.node_canonical === selectedBefore.node_canonical) {
    failures.push("selected actor semantic surface node did not change");
  }
  failures.push(...unchangedSurfaceFailures(
    before,
    after,
    expectedActorIds.filter((actorId) => actorId !== selectedActorId),
    "intervention isolation",
  ));
  return failures;
}

export function coldResumeSurfaceFailures(before, after, resumedActorId, expectedActorIds = EXPECTED_ACTOR_IDS) {
  const failures = [];
  const prior = mapActors(before);
  const next = mapActors(after);
  const resumedBefore = prior.get(resumedActorId);
  const resumedAfter = next.get(resumedActorId);
  if (!resumedBefore || !resumedAfter) return [`cold resume is missing ${resumedActorId}`];
  if (resumedBefore.surface_id !== resumedAfter.surface_id || resumedBefore.node_id !== resumedAfter.node_id) {
    failures.push("cold-resumed actor did not retain actor/surface identity");
  }
  if (resumedBefore.generation !== resumedAfter.generation) {
    failures.push("ordinary cold command resume unexpectedly changed logical actor generation");
  }
  if (resumedAfter.surface_revision <= resumedBefore.surface_revision) {
    failures.push("cold-resumed actor surface revision did not advance");
  }
  if (resumedAfter.node_canonical === resumedBefore.node_canonical) {
    failures.push("cold-resumed actor semantic surface did not change");
  }
  failures.push(...unchangedSurfaceFailures(
    before,
    after,
    expectedActorIds.filter((actorId) => actorId !== resumedActorId),
    "cold resume isolation",
  ));
  return failures;
}

function handoffNode(handoff) {
  return handoff?.fromNode ?? handoff?.from_node;
}

function handoffRound(handoff) {
  return handoff?.roundId ?? handoff?.round_id;
}

export function waitingRoundFailures(input) {
  const failures = [];
  const status = input?.status;
  const rounds = Array.isArray(input?.rounds?.rounds) ? input.rounds.rounds : [];
  const handoffs = Array.isArray(input?.handoffs?.handoffs) ? input.handoffs.handoffs : [];
  const expectedActorIds = input?.expected_actor_ids ?? EXPECTED_ACTOR_IDS;
  if (status?.status !== "waiting" || status?.terminal === true) failures.push("run is not at a non-terminal waiting boundary");
  const current = status?.current_round;
  if (!isObject(current) || current.status !== "waiting") failures.push("current round is not waiting");
  const persisted = rounds.find((round) => round?.round_id === current?.round_id);
  if (!persisted || persisted.status !== "waiting") failures.push("waiting round is not durable in the rounds API");
  if (Number.isSafeInteger(input?.expected_ordinal) && current?.ordinal !== input.expected_ordinal) {
    failures.push(`waiting round ordinal must be ${input.expected_ordinal}; observed ${String(current?.ordinal)}`);
  }
  failures.push(...exactIdFailures(
    Array.isArray(current?.target_actor_ids) ? current.target_actor_ids : [],
    expectedActorIds,
    "waiting round targets",
  ));
  if (isObject(status?.node_states)) {
    const failedNodes = Object.entries(status.node_states)
      .filter(([, state]) => state === "FAILED" || state === "CANCELLED")
      .map(([node]) => node);
    if (failedNodes.length > 0) failures.push(`waiting run contains failed nodes: ${failedNodes.join(", ")}`);
  }
  const fanIn = handoffs
    .filter((handoff) => handoffNode(handoff) === "collect_round" && handoffRound(handoff) === current?.round_id)
    .at(-1);
  const gate = fanIn?.content;
  if (!fanIn || fanIn.port !== "ready") failures.push("current round did not fan in through collect_round:ready");
  if (!isObject(gate)
    || gate.mode !== "all"
    || gate.total !== 3
    || gate.successes !== 3
    || gate.failures !== 0
    || gate.threshold !== 3
    || gate.passed !== true
    || !Array.isArray(gate.values)
    || gate.values.length !== 3) {
    failures.push("current round fan-in did not contain three successful actor reports");
  }
  return failures;
}

export function summarizeActivityEvents(entries) {
  const byActor = {};
  for (const entry of Array.isArray(entries) ? entries : []) {
    const event = entry?.event;
    if (!isObject(event) || typeof event.actor_id !== "string") continue;
    const actor = byActor[event.actor_id] ?? {
      total: 0,
      by_type: {},
      by_round: {},
      generations: [],
      first_journal_seq: entry.seq,
      last_journal_seq: entry.seq,
    };
    actor.total += 1;
    actor.by_type[event.type] = (actor.by_type[event.type] ?? 0) + 1;
    actor.by_round[event.round_id] = (actor.by_round[event.round_id] ?? 0) + 1;
    if (Number.isSafeInteger(event.generation) && !actor.generations.includes(event.generation)) {
      actor.generations.push(event.generation);
      actor.generations.sort((left, right) => left - right);
    }
    actor.first_journal_seq = Math.min(actor.first_journal_seq, entry.seq);
    actor.last_journal_seq = Math.max(actor.last_journal_seq, entry.seq);
    byActor[event.actor_id] = actor;
  }
  return {
    total: Object.values(byActor).reduce((sum, actor) => sum + actor.total, 0),
    by_actor: Object.fromEntries(Object.entries(byActor).sort(([left], [right]) => left.localeCompare(right))),
  };
}

export function activityRoundFailures(entries, expectedActorIds, roundId, generations = {}, options = {}) {
  const failures = [];
  const requiredActivityTypes = options.require_progress === false
    ? REQUIRED_ACTIVITY_TYPES.filter((type) => type !== "progress")
    : REQUIRED_ACTIVITY_TYPES;
  for (const actorId of expectedActorIds) {
    const events = (Array.isArray(entries) ? entries : [])
      .map((entry) => entry?.event)
      .filter((event) => isObject(event)
        && event.actor_id === actorId
        && event.round_id === roundId
        && (generations[actorId] === undefined || event.generation === generations[actorId]));
    const counts = Object.fromEntries(requiredActivityTypes.map((type) => [
      type,
      events.filter((event) => event.type === type).length,
    ]));
    for (const type of requiredActivityTypes) {
      if (counts[type] < 1) failures.push(`${actorId} has no ${type} activity in ${roundId}`);
    }
    const hasResultActivity = events.some((event) => event.type === "finding")
      || events.some((event) => event.type === "completed"
        && typeof event.payload?.summary === "string"
        && event.payload.summary.trim().length > 0);
    if (!hasResultActivity) {
      failures.push(`${actorId} has no finding or result-bearing completed activity in ${roundId}`);
    }
    const finalTerminal = events.filter((event) => event.type === "completed" || event.type === "failed").at(-1);
    if (finalTerminal?.type !== "completed") failures.push(`${actorId} did not finish with completed activity in ${roundId}`);
    if (!events.some((event) => MILESTONE_TYPES.has(event.type))) {
      failures.push(`${actorId} has no milestone activity in ${roundId}`);
    }
  }
  return failures;
}

export function milestoneFailures(milestonePages, expectedActorIds, roundId) {
  const failures = [];
  const milestones = milestonePages.flatMap((page) => page?.milestones ?? []);
  for (const actorId of expectedActorIds) {
    if (!milestones.some((milestone) => milestone.actor_id === actorId && milestone.round_id === roundId)) {
      failures.push(`${actorId} has no Manager milestone evidence in ${roundId}`);
    }
  }
  const commentary = milestonePages.flatMap((page) => page?.commentary ?? []);
  if (commentary.length === 0) failures.push(`Manager produced no milestone commentary for ${roundId}`);
  return failures;
}

function credentialValuesRedacted(config) {
  const values = [];
  const visit = (value, key = "") => {
    if (Array.isArray(value)) return value.forEach((entry) => visit(entry, key));
    if (!isObject(value)) {
      if (/(?:api[_-]?key|authorization|credential|password|secret|token)/i.test(key)) values.push(value);
      return;
    }
    for (const [nestedKey, nested] of Object.entries(value)) visit(nested, nestedKey);
  };
  visit(config);
  return values.every((value) => value === undefined || value === null || value === "" || value === "***REDACTED***");
}

export function analyzeModelDispatches(actorSurfaces, chatsByNode, expectedSettingId, expectedModel = "") {
  const failures = [];
  const actors = [];
  for (const surface of actorSurfaces) {
    const messages = Array.isArray(chatsByNode?.[surface.node_id]?.messages)
      ? chatsByNode[surface.node_id].messages
      : [];
    const dispatches = messages
      .filter((message) => message?.role === "manager" && message?.type === "prompt" && isObject(message?.content?.agentConfig))
      .map((message) => ({ config: message.content.agentConfig, activity: message.content.activity }));
    if (dispatches.length === 0) failures.push(`${surface.actor_id} has no persisted model dispatch`);
    const settingIds = new Set();
    const providers = new Set();
    const models = new Set();
    const agentTypes = new Set();
    const rounds = {};
    const generations = {};
    for (const dispatch of dispatches) {
      const config = dispatch.config;
      const settingId = config.llm_setting_id;
      const provider = config.llm?.provider;
      const model = config.llm?.model ?? config.model;
      const agentType = config.agent_type;
      if (typeof settingId === "string") settingIds.add(settingId);
      if (typeof provider === "string" && provider) providers.add(provider);
      if (typeof model === "string" && model) models.add(model);
      if (typeof agentType === "string" && agentType) agentTypes.add(agentType);
      if (settingId !== expectedSettingId) failures.push(`${surface.actor_id} dispatched through an unexpected LLM setting`);
      if (expectedModel && model !== expectedModel) failures.push(`${surface.actor_id} dispatched through unexpected model ${String(model)}`);
      if (!provider || !model || !agentType) failures.push(`${surface.actor_id} dispatch lacks resolved real-model routing evidence`);
      if (/^(?:deterministic|direct-llm|mock|test)$/i.test(String(agentType ?? ""))) {
        failures.push(`${surface.actor_id} used non-real agent_type ${String(agentType)}`);
      }
      if (!credentialValuesRedacted(config)) failures.push(`${surface.actor_id} persisted unredacted dispatch credentials`);
      if (dispatch.activity?.actorId !== surface.actor_id) failures.push(`${surface.actor_id} dispatch actor identity changed`);
      const roundId = dispatch.activity?.roundId;
      if (typeof roundId === "string") rounds[roundId] = (rounds[roundId] ?? 0) + 1;
      if (Number.isSafeInteger(dispatch.activity?.generation)) {
        const generation = String(dispatch.activity.generation);
        generations[generation] = (generations[generation] ?? 0) + 1;
      }
    }
    actors.push({
      actor_id: surface.actor_id,
      node_id: surface.node_id,
      dispatch_count: dispatches.length,
      setting_ids: [...settingIds].sort(),
      providers: [...providers].sort(),
      models: [...models].sort(),
      agent_types: [...agentTypes].sort(),
      rounds,
      generations,
      real_model: dispatches.length > 0
        && [...settingIds].every((settingId) => settingId === expectedSettingId)
        && [...agentTypes].every((agentType) => !/^(?:deterministic|direct-llm|mock|test)$/i.test(agentType)),
    });
  }
  return { failures, actors: actors.sort((left, right) => left.actor_id.localeCompare(right.actor_id)) };
}

export function activityConcurrencyEvidence(entries, expectedActorIds, roundId) {
  const failures = [];
  const starts = new Map();
  const terminals = new Map();
  for (const entry of Array.isArray(entries) ? entries : []) {
    const event = entry?.event;
    if (!isObject(event) || event.round_id !== roundId || !expectedActorIds.includes(event.actor_id)) continue;
    const at = Number.isFinite(Number(entry.received_at))
      ? Number(entry.received_at)
      : Number.isFinite(Number(event.timestamp))
        ? Number(event.timestamp)
        : undefined;
    if (at === undefined) continue;
    if (event.type === "started" && !starts.has(event.actor_id)) starts.set(event.actor_id, at);
    if ((event.type === "completed" || event.type === "failed") && !terminals.has(event.actor_id)) {
      terminals.set(event.actor_id, at);
    }
  }
  for (const actorId of expectedActorIds) {
    if (!starts.has(actorId)) failures.push(`${actorId} has no started timestamp in ${roundId}`);
    if (!terminals.has(actorId)) failures.push(`${actorId} has no terminal timestamp in ${roundId}`);
  }
  const latestStartAt = starts.size === expectedActorIds.length ? Math.max(...starts.values()) : null;
  const earliestTerminalAt = terminals.size === expectedActorIds.length ? Math.min(...terminals.values()) : null;
  const overlapMs = latestStartAt !== null && earliestTerminalAt !== null
    ? earliestTerminalAt - latestStartAt
    : null;
  if (overlapMs !== null && overlapMs < 0) {
    failures.push(`three-Actor execution did not overlap; first terminal preceded latest start by ${Math.abs(overlapMs)}ms`);
  }
  return {
    failures,
    evidence: {
      actor_count: expectedActorIds.length,
      round_id: roundId,
      all_started_before_first_terminal: overlapMs !== null && overlapMs >= 0,
      overlap_ms: overlapMs,
      started_actor_ids: [...starts.keys()].sort(),
      terminal_actor_ids: [...terminals.keys()].sort(),
    },
  };
}

function persistedEventPayload(event) {
  return isObject(event?.payload) ? event.payload : isObject(event?.details) ? event.details : {};
}

function persistedEventType(event) {
  return String(event?.type ?? event?.event_type ?? "").replace(/^dag:/, "");
}

export function physicalWorkerLifecycleEvidence(eventsResponse, options = {}) {
  const failures = [];
  const events = Array.isArray(eventsResponse?.raw_events)
    ? eventsResponse.raw_events
    : Array.isArray(eventsResponse?.events)
      ? eventsResponse.events
      : [];
  const expectedNodeIds = Array.isArray(options.expected_node_ids) ? options.expected_node_ids : [];
  const provisions = events.filter((event) => persistedEventType(event) === "provisioning_completed");
  const releases = events.filter((event) => (
    persistedEventType(event) === "actor_lease_released"
    && persistedEventPayload(event).reason === "idle_ttl_expired"
  ));
  const cleanups = events.filter((event) => persistedEventType(event) === "cleanup_completed");
  const provisionNodes = new Set(provisions.map((event) => persistedEventPayload(event).nodeId).filter(Boolean));
  const provisionCounts = new Map();
  for (const event of provisions) {
    const nodeId = persistedEventPayload(event).nodeId;
    if (typeof nodeId === "string" && nodeId) {
      provisionCounts.set(nodeId, (provisionCounts.get(nodeId) ?? 0) + 1);
    }
  }
  const workerIds = new Set(provisions.map((event) => persistedEventPayload(event).workerId).filter(Boolean));
  const containerIds = new Set(provisions.map((event) => persistedEventPayload(event).containerId).filter(Boolean));
  for (const nodeId of expectedNodeIds) {
    if (!provisionNodes.has(nodeId)) failures.push(`no physical Worker was provisioned for ${nodeId}`);
  }
  const minimumDistinct = Number.isInteger(options.minimum_distinct_workers)
    ? options.minimum_distinct_workers
    : expectedNodeIds.length;
  if (workerIds.size < minimumDistinct) {
    failures.push(`physical Worker count is ${workerIds.size}, expected at least ${minimumDistinct}`);
  }
  if (containerIds.size < minimumDistinct) {
    failures.push(`physical container count is ${containerIds.size}, expected at least ${minimumDistinct}`);
  }
  const requiredReleaseActor = options.require_idle_release_actor;
  if (requiredReleaseActor && !releases.some((event) => persistedEventPayload(event).actorId === requiredReleaseActor)) {
    failures.push(`${requiredReleaseActor} has no idle_ttl_expired lease release event`);
  }
  if (requiredReleaseActor) {
    const releasedNodes = new Set(releases
      .filter((event) => persistedEventPayload(event).actorId === requiredReleaseActor)
      .map((event) => persistedEventPayload(event).nodeId)
      .filter(Boolean));
    const cleanupForActor = cleanups.some((event) => {
      const payload = persistedEventPayload(event);
      return releasedNodes.has(payload.nodeId) || payload.nodeId === requiredReleaseActor;
    });
    if (!cleanupForActor) failures.push(`${requiredReleaseActor} has no completed physical cleanup event`);
  }
  const requiredReprovisionedNodeIds = Array.isArray(options.require_reprovisioned_node_ids)
    ? options.require_reprovisioned_node_ids
    : [];
  for (const nodeId of requiredReprovisionedNodeIds) {
    if ((provisionCounts.get(nodeId) ?? 0) < 2) {
      failures.push(`${nodeId} was not physically reprovisioned after release`);
    }
  }
  return {
    failures,
    evidence: {
      provisioned_node_ids: [...provisionNodes].sort(),
      distinct_worker_count: workerIds.size,
      distinct_container_count: containerIds.size,
      idle_release_actor_ids: [...new Set(releases
        .map((event) => persistedEventPayload(event).actorId)
        .filter(Boolean))].sort(),
      reprovisioned_node_ids: [...provisionCounts.entries()]
        .filter(([, count]) => count >= 2)
        .map(([nodeId]) => nodeId)
        .sort(),
      cleanup_count: cleanups.length,
      physical_ids_redacted: true,
    },
  };
}

export function coldResumeGroupFailures(before, after, actorIds = EXPECTED_ACTOR_IDS) {
  const failures = [];
  const prior = mapActors(before);
  const next = mapActors(after);
  for (const actorId of actorIds) {
    const left = prior.get(actorId);
    const right = next.get(actorId);
    if (!left || !right) {
      failures.push(`cold group resume is missing ${actorId}`);
      continue;
    }
    if (left.surface_id !== right.surface_id || left.node_id !== right.node_id) {
      failures.push(`${actorId} did not retain logical Actor and Surface identity`);
    }
    if (left.generation !== right.generation) failures.push(`${actorId} changed logical generation during ordinary resume`);
    if (right.surface_revision <= left.surface_revision) failures.push(`${actorId} Surface revision did not advance`);
    if (right.node_canonical === left.node_canonical) failures.push(`${actorId} semantic Surface did not change`);
  }
  return failures;
}

export function dispatchIsolationFailures(before, after, selectedActorId, minimumSelectedIncrease = 1) {
  const failures = [];
  const prior = new Map((before?.actors ?? []).map((actor) => [actor.actor_id, actor]));
  const next = new Map((after?.actors ?? []).map((actor) => [actor.actor_id, actor]));
  for (const [actorId, priorActor] of prior) {
    const nextActor = next.get(actorId);
    if (!nextActor) {
      failures.push(`dispatch isolation is missing ${actorId}`);
      continue;
    }
    const increase = nextActor.dispatch_count - priorActor.dispatch_count;
    if (actorId === selectedActorId && increase < minimumSelectedIncrease) {
      failures.push(`${actorId} model dispatch count increased by ${increase}, expected at least ${minimumSelectedIncrease}`);
    }
    if (actorId !== selectedActorId && increase !== 0) {
      failures.push(`${actorId} was redispatched despite branch-local selection`);
    }
  }
  return failures;
}

export function dispatchGroupFailures(
  before,
  after,
  actorIds = EXPECTED_ACTOR_IDS,
  minimumIncrease = 1,
  maximumIncrease = 4,
) {
  const failures = [];
  const prior = new Map((before?.actors ?? []).map((actor) => [actor.actor_id, actor]));
  const next = new Map((after?.actors ?? []).map((actor) => [actor.actor_id, actor]));
  for (const actorId of actorIds) {
    const priorActor = prior.get(actorId);
    const nextActor = next.get(actorId);
    if (!priorActor || !nextActor) {
      failures.push(`group dispatch evidence is missing ${actorId}`);
      continue;
    }
    const increase = nextActor.dispatch_count - priorActor.dispatch_count;
    if (increase < minimumIncrease || increase > maximumIncrease) {
      failures.push(
        `${actorId} model dispatch count increased by ${increase}, expected between ${minimumIncrease} and ${maximumIncrease}`,
      );
    }
  }
  return failures;
}

export function interventionEvidenceFailures(response, actorId) {
  const failures = [];
  if (!isObject(response)) return ["intervention response is missing"];
  if (response.actor_id !== actorId) failures.push("intervention targeted the wrong logical actor");
  if (response.operation !== "retry") failures.push("intervention did not use branch-local retry");
  if (response.status !== "applied") failures.push(`intervention status is ${String(response.status)}`);
  if (typeof response.intervention_id !== "string" || response.intervention_id.length === 0) {
    failures.push("intervention response is missing intervention_id");
  }
  const leaked = collectForbiddenPaths(response, FORBIDDEN_PUBLIC_IDENTITY_KEY);
  if (leaked.length > 0) failures.push(`intervention response leaked physical identity at ${leaked.join(", ")}`);
  return failures;
}

export function surfaceHistoryFailures(historyResponse, input) {
  const failures = [];
  const history = Array.isArray(historyResponse?.history) ? historyResponse.history : [];
  const match = history.find((entry) => (
    entry?.generation === input.from_generation
    && entry?.superseded_by_generation === input.to_generation
    && entry?.surface_id === input.surface_id
    && entry?.intervention_id === input.intervention_id
  ));
  if (!match) failures.push("superseded surface history does not prove the selected generation transition");
  return failures;
}

export function durableStateFailures(state) {
  const failures = [];
  if (!isObject(state)) return ["durable state must be an object"];
  if (state.schema_version !== SHOWCASE_STATE_SCHEMA_VERSION) failures.push("durable state schema_version is unsupported");
  if (state.scenario !== SHOWCASE_SCENARIO) failures.push("durable state scenario is invalid");
  if (state.stage !== "prepared" && state.stage !== "complete") failures.push("durable state stage is invalid");
  for (const key of ["run_id", "workflow_id", "profile_id", "setting_id"]) {
    if (typeof state.run?.[key] !== "string" || state.run[key].length === 0) failures.push(`durable state is missing run.${key}`);
  }
  if (typeof state.manager_session_id !== "string" || state.manager_session_id.length === 0) {
    failures.push("durable state is missing manager_session_id");
  }
  failures.push(...exactIdFailures(
    Array.isArray(state.actor_ids) ? state.actor_ids : [],
    EXPECTED_ACTOR_IDS,
    "durable state actor_ids",
  ));
  if (!EXPECTED_ACTOR_IDS.includes(state.cold_resume_actor_id)) failures.push("durable state cold_resume_actor_id is invalid");
  if (state.prepared_round?.status !== "waiting" || !Number.isSafeInteger(state.prepared_round?.ordinal)) {
    failures.push("durable state prepared_round is invalid");
  }
  const surfaces = Array.isArray(state.prepared_surfaces) ? state.prepared_surfaces : [];
  failures.push(...exactIdFailures(surfaces.map((surface) => surface?.actor_id), EXPECTED_ACTOR_IDS, "durable state surfaces"));
  for (const surface of surfaces) {
    if (!/^[0-9a-f]{64}$/.test(String(surface?.node_digest ?? ""))) {
      failures.push(`durable state surface ${String(surface?.actor_id)} has an invalid digest`);
    }
    if (typeof surface?.node_canonical === "string") failures.push("durable state must not persist raw semantic node bytes");
  }
  const unsafe = unsafeReportPaths(state);
  if (unsafe.length > 0) failures.push(`durable state contains unsafe fields: ${unsafe.join(", ")}`);
  return failures;
}

export function storedSurfaceRecoveryFailures(storedSurfaces, recoveredAnalysis) {
  const failures = [];
  const stored = new Map((storedSurfaces ?? []).map((surface) => [surface.actor_id, surface]));
  for (const actor of recoveredAnalysis?.actors ?? []) {
    const prior = stored.get(actor.actor_id);
    if (!prior) {
      failures.push(`recovery has an unexpected actor ${actor.actor_id}`);
      continue;
    }
    if (
      prior.node_id !== actor.node_id
      || prior.surface_id !== actor.surface_id
      || prior.generation !== actor.generation
      || prior.surface_revision !== actor.surface_revision
      || prior.node_digest !== actor.node_digest
      || prior.node_bytes !== actor.node_bytes
    ) failures.push(`recovered ${actor.actor_id} surface is not byte-identical to prepared state`);
  }
  if ((recoveredAnalysis?.actors ?? []).length !== stored.size) failures.push("recovered surface count changed");
  return failures;
}

export function coldResumeLifecycleFailures(input) {
  const failures = [];
  if (input.before_lease_state !== "dormant") failures.push("cold resume actor was not dormant before command");
  if (input.lease_reacquired !== true) failures.push("cold resume never observed public lease reacquisition");
  if (input.after_status !== "waiting") failures.push("cold-resumed run did not return to waiting");
  if (input.actor_id_before !== input.actor_id_after) failures.push("cold resume changed actor_id");
  if (input.surface_id_before !== input.surface_id_after) failures.push("cold resume changed surface_id");
  if (!Number.isSafeInteger(input.before_round_ordinal)
    || input.after_round_ordinal !== input.before_round_ordinal + 1) {
    failures.push("cold resume did not continue into the next round");
  }
  if (input.command_status !== "acknowledged") failures.push("cold resume command was not acknowledged");
  return failures;
}
