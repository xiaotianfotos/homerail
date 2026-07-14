import {
  HomerailPluginModality,
  isHomerailPluginId,
  type HomerailPluginTurnContextV1,
} from "homerail-protocol";
import {
  getPluginRegistryState,
  type PluginRegistryState,
} from "../persistence/plugins.js";
import {
  assemblePluginTurnContext,
  assertCurrentPluginTurnContextSubset,
  selectPluginTurnContext,
} from "./context-assembler.js";
import {
  compilePluginCapabilityIndex,
  type CompilePluginCapabilityIndexOptions,
  type PluginCapabilityIndex,
  type PluginCapabilityIndexEntry,
} from "./capability-index.js";
import { pluginJsonDigest } from "./descriptor.js";
import { ensureBuiltinPluginsSynced } from "./registry.js";

const MAX_UTTERANCE_CHARS = 4_000;
const MAX_INPUT_FIELDS = 64;
const MAX_TOP_K = 8;
const MAX_PROMPT_BYTES = 64 * 1024;
const DEFAULT_TOP_K = 3;
const DEFAULT_PROMPT_BYTES = 16 * 1024;
const MAX_RETURNED_CANDIDATES = 64;
const MIN_IMPLICIT_SCORE = 600;
const LOCAL_ID = /^[a-z][a-z0-9]*(?:[-_][a-z0-9]+)*$/;

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export type PluginCapabilityRouteStatus = "ready" | "needs_input" | "needs_grant";
export type PluginCapabilitySelectionState =
  | "selected"
  | "not_selected"
  | "blocked"
  | "budget_excluded"
  | "clarification_required";

export interface PluginCapabilityRouteRequest {
  utterance: string;
  modality?: HomerailPluginModality;
  inputs?: Record<string, unknown>;
  explicit_plugin_id?: string;
  explicit_capability_id?: string;
  top_k?: number;
  prompt_byte_budget?: number;
}

export interface NormalizedPluginCapabilityRouteRequest {
  utterance: string;
  modality: HomerailPluginModality;
  inputs: Record<string, unknown>;
  explicit_plugin_id?: string;
  explicit_capability_id?: string;
  top_k: number;
  prompt_byte_budget: number;
}

export interface PluginCapabilityCandidate {
  rank: number;
  qualified_id: string;
  plugin_id: string;
  plugin_version: string;
  score: number;
  matched_terms: string[];
  status: PluginCapabilityRouteStatus;
  missing_inputs: string[];
  missing_grants: string[];
  denied_permissions: string[];
  side_effecting: boolean;
  selection: PluginCapabilitySelectionState;
}

export interface PluginCapabilityLoadedSkill {
  plugin_id: string;
  plugin_version: string;
  local_id: string;
  qualified_id: string;
  capability_ids: string[];
  digest: string;
  content: string;
}

export interface PluginCapabilitySelectedProof {
  capability_id: string;
  plugin_id: string;
  plugin_version: string;
  manifest_digest: string;
  package_digest: string;
  skill_digest: string;
  operation_schema_digests: string[];
  prompt_byte_contribution: number;
}

export interface PluginCapabilityPromptContext {
  skills: PluginCapabilityLoadedSkill[];
  tools: HomerailPluginTurnContextV1["tools"];
}

export interface PluginCapabilityRouteResult {
  route_version: 1;
  index_digest: string;
  registry_revision: number;
  registry_fingerprint: string;
  permission_revision: number;
  request_digest: string;
  candidates: PluginCapabilityCandidate[];
  selected: PluginCapabilitySelectedProof[];
  selected_context: HomerailPluginTurnContextV1;
  prompt_context: PluginCapabilityPromptContext;
  prompt_bytes: number;
  prompt_byte_budget: number;
  prompt_digest: string;
  truncated_by_top_k: boolean;
  truncated_by_budget: boolean;
  signals: {
    ambiguous: boolean;
    ambiguity_capability_ids: string[];
    side_effect_conflict: boolean;
    explicit_target_unavailable: boolean;
    clarification_required: boolean;
  };
  replay: {
    ordered_candidate_ids: string[];
    selected_capability_ids: string[];
    summary: string;
    result_digest: string;
  };
}

export interface RoutePluginCapabilitiesOptions extends CompilePluginCapabilityIndexOptions {
  index?: PluginCapabilityIndex;
  /**
   * Optional pre-assembled compatibility boundary. Only capabilities present
   * in this context are eligible for routing, while the compact index remains
   * the source of searchable metadata and permission state.
   */
  source_context?: HomerailPluginTurnContextV1;
}

interface ScoredCandidate {
  entry: PluginCapabilityIndexEntry;
  score: number;
  matched_terms: string[];
  status: PluginCapabilityRouteStatus;
  missing_inputs: string[];
  missing_grants: string[];
  denied_permissions: string[];
}

function normalizeSearchText(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase("en-US")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function tokens(value: string): Set<string> {
  const result = new Set<string>();
  const normalized = normalizeSearchText(value);
  for (const token of normalized.split(" ")) {
    if (!token) continue;
    if (/\p{Script=Han}/u.test(token)) {
      const chars = [...token];
      if (chars.length === 1) result.add(chars[0]);
      for (let index = 0; index + 1 < chars.length; index += 1) {
        result.add(`${chars[index]}${chars[index + 1]}`);
      }
    } else if (token.length >= 2) {
      result.add(token);
    }
  }
  return result;
}

function overlap(left: ReadonlySet<string>, right: ReadonlySet<string>): string[] {
  return [...left].filter((value) => right.has(value)).sort();
}

function meaningfulInput(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

function validCapabilityReference(value: string): boolean {
  if (LOCAL_ID.test(value)) return true;
  const separator = value.indexOf(":");
  return separator > 0
    && separator === value.lastIndexOf(":")
    && isHomerailPluginId(value.slice(0, separator))
    && LOCAL_ID.test(value.slice(separator + 1));
}

function normalizedRequest(value: unknown): NormalizedPluginCapabilityRouteRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Capability route request must be an object");
  }
  const input = value as Record<string, unknown>;
  const allowed = new Set([
    "utterance", "modality", "inputs", "explicit_plugin_id",
    "explicit_capability_id", "top_k", "prompt_byte_budget",
  ]);
  if (Object.keys(input).some((key) => !allowed.has(key))) {
    throw new Error("Capability route request contains unknown fields");
  }
  if (typeof input.utterance !== "string" || input.utterance.length > MAX_UTTERANCE_CHARS) {
    throw new Error(`Capability route utterance must be a string of at most ${MAX_UTTERANCE_CHARS} characters`);
  }
  const modality = input.modality ?? HomerailPluginModality.TEXT;
  if (!Object.values(HomerailPluginModality).includes(modality as HomerailPluginModality)) {
    throw new Error("Capability route modality is invalid");
  }
  const rawInputs = input.inputs ?? {};
  if (!rawInputs || typeof rawInputs !== "object" || Array.isArray(rawInputs)) {
    throw new Error("Capability route inputs must be an object");
  }
  const inputKeys = Object.keys(rawInputs);
  if (inputKeys.length > MAX_INPUT_FIELDS || inputKeys.some((key) => !LOCAL_ID.test(key))) {
    throw new Error(`Capability route inputs must contain at most ${MAX_INPUT_FIELDS} local-id fields`);
  }
  if (input.explicit_plugin_id !== undefined && (
    typeof input.explicit_plugin_id !== "string" || !isHomerailPluginId(input.explicit_plugin_id)
  )) throw new Error("Capability route explicit_plugin_id is invalid");
  if (input.explicit_capability_id !== undefined && (
    typeof input.explicit_capability_id !== "string"
    || !validCapabilityReference(input.explicit_capability_id)
  )) throw new Error("Capability route explicit_capability_id is invalid");
  const topK = input.top_k ?? DEFAULT_TOP_K;
  if (!Number.isSafeInteger(topK) || Number(topK) < 1 || Number(topK) > MAX_TOP_K) {
    throw new Error(`Capability route top_k must be between 1 and ${MAX_TOP_K}`);
  }
  const promptBudget = input.prompt_byte_budget ?? DEFAULT_PROMPT_BYTES;
  if (!Number.isSafeInteger(promptBudget) || Number(promptBudget) < 1 || Number(promptBudget) > MAX_PROMPT_BYTES) {
    throw new Error(`Capability route prompt_byte_budget must be between 1 and ${MAX_PROMPT_BYTES}`);
  }
  if (!input.utterance.trim() && input.explicit_plugin_id === undefined && input.explicit_capability_id === undefined) {
    throw new Error("Capability route requires an utterance or explicit target");
  }
  const normalized: NormalizedPluginCapabilityRouteRequest = {
    utterance: input.utterance,
    modality: modality as HomerailPluginModality,
    inputs: structuredClone(rawInputs as Record<string, unknown>),
    top_k: Number(topK),
    prompt_byte_budget: Number(promptBudget),
    ...(typeof input.explicit_plugin_id === "string" ? { explicit_plugin_id: input.explicit_plugin_id } : {}),
    ...(typeof input.explicit_capability_id === "string"
      ? { explicit_capability_id: input.explicit_capability_id }
      : {}),
  };
  // Direct callers receive the same bounded/cycle-safe behavior as HTTP callers.
  pluginJsonDigest(normalized, 32 * 1024);
  return normalized;
}

function explicitCapabilityMatches(entry: PluginCapabilityIndexEntry, explicit: string | undefined): boolean {
  return explicit === undefined || explicit === entry.qualified_id || explicit === entry.local_id;
}

function scoreEntry(
  entry: PluginCapabilityIndexEntry,
  request: NormalizedPluginCapabilityRouteRequest,
): { score: number; matched_terms: string[] } {
  const query = normalizeSearchText(request.utterance);
  const queryTokens = tokens(query);
  const matched = new Set<string>();
  let score = 0;
  if (request.explicit_plugin_id === entry.plugin_id) {
    score += 10_000;
    matched.add(`plugin:${entry.plugin_id}`);
  }
  if (request.explicit_capability_id !== undefined && explicitCapabilityMatches(entry, request.explicit_capability_id)) {
    score += 100_000;
    matched.add(`capability:${entry.qualified_id}`);
  }
  for (const intent of entry.intent_examples) {
    const phrase = normalizeSearchText(intent);
    if (phrase && query.includes(phrase)) {
      score += 5_000;
      matched.add(`intent:${phrase}`);
    }
    const shared = overlap(queryTokens, tokens(intent));
    score += shared.length * 240;
    shared.forEach((term) => matched.add(`intent-token:${term}`));
  }
  for (const tag of entry.tags) {
    const phrase = normalizeSearchText(tag);
    if (phrase && (query === phrase || query.split(" ").includes(phrase))) {
      score += 900;
      matched.add(`tag:${phrase}`);
    }
    const shared = overlap(queryTokens, tokens(tag));
    score += shared.length * 700;
    shared.forEach((term) => matched.add(`tag-token:${term}`));
  }
  const summaryTerms = overlap(queryTokens, tokens(entry.summary));
  score += summaryTerms.length * 120;
  summaryTerms.forEach((term) => matched.add(`summary:${term}`));
  const identityTerms = overlap(queryTokens, tokens(`${entry.plugin_id} ${entry.local_id}`));
  score += identityTerms.length * 100;
  identityTerms.forEach((term) => matched.add(`identity:${term}`));
  return { score, matched_terms: [...matched].sort().slice(0, 32) };
}

function candidateStatus(
  entry: PluginCapabilityIndexEntry,
  inputs: Record<string, unknown>,
): Pick<ScoredCandidate, "status" | "missing_inputs" | "missing_grants" | "denied_permissions"> {
  const missingInputs = entry.required_inputs.filter((name) => !meaningfulInput(inputs[name]));
  const missingGrants = entry.permissions
    .filter((permission) => permission.status !== "granted")
    .map((permission) => permission.permission);
  const deniedPermissions = entry.permissions
    .filter((permission) => permission.status === "denied")
    .map((permission) => permission.permission);
  return {
    status: missingInputs.length ? "needs_input" : missingGrants.length ? "needs_grant" : "ready",
    missing_inputs: missingInputs,
    missing_grants: missingGrants,
    denied_permissions: deniedPermissions,
  };
}

function loadedSkills(
  context: HomerailPluginTurnContextV1,
  registry: PluginRegistryState,
): PluginCapabilityLoadedSkill[] {
  return context.skills.map((skill) => {
    const plugin = registry.plugins.find((candidate) => (
      candidate.plugin_id === skill.plugin_id && candidate.plugin_version === skill.plugin_version
    ));
    const archived = plugin?.descriptor.skills.find((candidate) => (
      candidate.id === skill.local_id && candidate.digest === skill.digest
    ));
    if (!archived) throw new Error(`Selected Skill snapshot is unavailable: ${skill.qualified_id}`);
    return {
      plugin_id: skill.plugin_id,
      plugin_version: skill.plugin_version,
      local_id: skill.local_id,
      qualified_id: skill.qualified_id,
      capability_ids: [...skill.capability_ids],
      digest: skill.digest,
      content: archived.content,
    };
  });
}

function promptSnapshot(
  context: HomerailPluginTurnContextV1,
  registry: PluginRegistryState,
): PluginCapabilityPromptContext {
  return {
    skills: loadedSkills(context, registry),
    tools: structuredClone(context.tools),
  };
}

function promptBytes(prompt: PluginCapabilityPromptContext): number {
  // The host owns fixed field labels and array delimiters. Charge every byte
  // injected by selected Skill/Tool assets, including separators between them.
  return Buffer.byteLength(JSON.stringify(prompt.skills), "utf8") - 2
    + Buffer.byteLength(JSON.stringify(prompt.tools), "utf8") - 2;
}

function operationSchemaDigests(entry: PluginCapabilityIndexEntry): string[] {
  return [...new Set(entry.operations.flatMap((operation) => [
    operation.input_schema_digest,
    operation.output_schema_digest,
  ].filter((digest): digest is string => Boolean(digest))))].sort();
}

export function routePluginCapabilities(
  requestValue: unknown,
  state?: PluginRegistryState,
  options: RoutePluginCapabilitiesOptions = {},
): PluginCapabilityRouteResult {
  const request = normalizedRequest(requestValue);
  if (!state) ensureBuiltinPluginsSynced();
  const registry = state ?? getPluginRegistryState();
  const index = options.index ?? compilePluginCapabilityIndex(registry, options);
  if (
    index.registry_revision !== registry.revision
    || index.registry_fingerprint !== registry.fingerprint
  ) throw new Error("Capability index does not match the registry snapshot");

  const suppliedContext = options.source_context ?? assemblePluginTurnContext(registry, { modality: request.modality });
  const fullContext = assertCurrentPluginTurnContextSubset(
    suppliedContext,
    registry,
    { modality: request.modality },
  );
  const sourceCapabilityIds = new Set(
    fullContext.skills.flatMap((skill) => skill.capability_ids),
  );
  const modalityEntries = index.entries.filter((entry) => (
    entry.modalities.includes(request.modality) && sourceCapabilityIds.has(entry.qualified_id)
  ));
  const explicitPluginEntries = request.explicit_plugin_id
    ? modalityEntries.filter((entry) => entry.plugin_id === request.explicit_plugin_id)
    : modalityEntries;
  const explicitlyFiltered = request.explicit_capability_id
    ? explicitPluginEntries.filter((entry) => explicitCapabilityMatches(entry, request.explicit_capability_id))
    : explicitPluginEntries;
  if (
    request.explicit_plugin_id
    && request.explicit_capability_id?.includes(":")
    && !request.explicit_capability_id.startsWith(`${request.explicit_plugin_id}:`)
  ) throw new Error("Explicit plugin and capability targets conflict");

  const scored: ScoredCandidate[] = explicitlyFiltered
    .map((entry): ScoredCandidate => {
      const scoredEntry = scoreEntry(entry, request);
      return { entry, ...scoredEntry, ...candidateStatus(entry, request.inputs) };
    })
    .filter((candidate) => (
      request.explicit_plugin_id !== undefined
      || request.explicit_capability_id !== undefined
      || candidate.score >= MIN_IMPLICIT_SCORE
    ))
    .sort((left, right) => (
      right.score - left.score || compareText(left.entry.qualified_id, right.entry.qualified_id)
    ))
    .slice(0, MAX_RETURNED_CANDIDATES);

  const topScore = scored[0]?.score ?? 0;
  const ambiguityMargin = Math.max(100, Math.floor(topScore * 0.05));
  const ambiguityEntries = scored.filter((candidate) => topScore - candidate.score <= ambiguityMargin);
  const uniqueExplicitCapability = request.explicit_capability_id !== undefined && ambiguityEntries.length === 1;
  const ambiguous = !uniqueExplicitCapability && ambiguityEntries.length > 1;
  const sideEffectConflict = ambiguous && ambiguityEntries.some((candidate) => candidate.entry.side_effecting);
  const clarificationRequired = sideEffectConflict;

  const selectedIds: string[] = [];
  const proofs: PluginCapabilitySelectedProof[] = [];
  const selectionById = new Map<string, PluginCapabilitySelectionState>();
  let currentContext = selectPluginTurnContext(fullContext, [], index.permission_revision);
  let currentPrompt = promptSnapshot(currentContext, registry);
  let currentBytes = promptBytes(currentPrompt);
  let truncatedByBudget = false;

  for (const candidate of scored) {
    if (candidate.status !== "ready") {
      selectionById.set(candidate.entry.qualified_id, "blocked");
      continue;
    }
    if (clarificationRequired && ambiguityEntries.includes(candidate)) {
      selectionById.set(candidate.entry.qualified_id, "clarification_required");
      continue;
    }
    if (selectedIds.length >= request.top_k) {
      selectionById.set(candidate.entry.qualified_id, "not_selected");
      continue;
    }
    const prospectiveIds = [...selectedIds, candidate.entry.qualified_id];
    const prospectiveContext = selectPluginTurnContext(fullContext, prospectiveIds, index.permission_revision);
    const prospectivePrompt = promptSnapshot(prospectiveContext, registry);
    const prospectiveBytes = promptBytes(prospectivePrompt);
    if (prospectiveBytes > request.prompt_byte_budget) {
      truncatedByBudget = true;
      selectionById.set(candidate.entry.qualified_id, "budget_excluded");
      continue;
    }
    const contribution = prospectiveBytes - currentBytes;
    selectedIds.push(candidate.entry.qualified_id);
    currentContext = prospectiveContext;
    currentPrompt = prospectivePrompt;
    currentBytes = prospectiveBytes;
    selectionById.set(candidate.entry.qualified_id, "selected");
    proofs.push({
      capability_id: candidate.entry.qualified_id,
      plugin_id: candidate.entry.plugin_id,
      plugin_version: candidate.entry.plugin_version,
      manifest_digest: candidate.entry.manifest_digest,
      package_digest: candidate.entry.package_digest,
      skill_digest: candidate.entry.skill.digest,
      operation_schema_digests: operationSchemaDigests(candidate.entry),
      prompt_byte_contribution: contribution,
    });
  }

  const candidates = scored.map((candidate, indexValue): PluginCapabilityCandidate => ({
    rank: indexValue + 1,
    qualified_id: candidate.entry.qualified_id,
    plugin_id: candidate.entry.plugin_id,
    plugin_version: candidate.entry.plugin_version,
    score: candidate.score,
    matched_terms: candidate.matched_terms,
    status: candidate.status,
    missing_inputs: candidate.missing_inputs,
    missing_grants: candidate.missing_grants,
    denied_permissions: candidate.denied_permissions,
    side_effecting: candidate.entry.side_effecting,
    selection: selectionById.get(candidate.entry.qualified_id) ?? "not_selected",
  }));
  const requestDigest = pluginJsonDigest(request, 32 * 1024);
  const promptDigest = pluginJsonDigest(currentPrompt, MAX_PROMPT_BYTES * 2);
  const signals = {
    ambiguous,
    ambiguity_capability_ids: ambiguityEntries.map((candidate) => candidate.entry.qualified_id),
    side_effect_conflict: sideEffectConflict,
    explicit_target_unavailable: Boolean(
      (request.explicit_plugin_id || request.explicit_capability_id) && explicitlyFiltered.length === 0
    ),
    clarification_required: clarificationRequired,
  };
  const orderedCandidateIds = candidates.map((candidate) => candidate.qualified_id);
  const summary = [
    `candidates=${orderedCandidateIds.join(",") || "none"}`,
    `selected=${selectedIds.join(",") || "none"}`,
    `ambiguous=${String(ambiguous)}`,
    `side_effect_conflict=${String(sideEffectConflict)}`,
    `prompt_bytes=${currentBytes}/${request.prompt_byte_budget}`,
  ].join(";");
  const unsigned = {
    route_version: 1 as const,
    index_digest: index.index_digest,
    registry_revision: index.registry_revision,
    registry_fingerprint: index.registry_fingerprint,
    permission_revision: index.permission_revision,
    request_digest: requestDigest,
    candidates,
    selected: proofs,
    selected_context: currentContext,
    prompt_context: currentPrompt,
    prompt_bytes: currentBytes,
    prompt_byte_budget: request.prompt_byte_budget,
    prompt_digest: promptDigest,
    truncated_by_top_k: selectedIds.length >= request.top_k
      && candidates.some((candidate) => candidate.status === "ready" && candidate.selection === "not_selected"),
    truncated_by_budget: truncatedByBudget,
    signals,
  };
  const replayInput = {
    ordered_candidate_ids: orderedCandidateIds,
    selected_capability_ids: selectedIds,
    summary,
  };
  const resultDigest = pluginJsonDigest({ ...unsigned, replay: replayInput }, 1024 * 1024);
  return {
    ...unsigned,
    replay: {
      ...replayInput,
      result_digest: resultDigest,
    },
  };
}
