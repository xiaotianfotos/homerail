import {
  ensureManagerAgentContainer,
  forwardChatToManagerAgentContainer,
  type ManagerAgentContainerOptions,
  type ManagerAgentRuntimeConfig,
} from "./manager-agent-container.js";
import {
  ensureHostShellManagerAgent,
  forwardChatToHostShellManagerAgent,
} from "./host-shell-manager-agent.js";
import {
  HostCodexManagerAgentExecutionError,
  loadVoiceSystemContract,
  runHostCodexManagerAgentTurn,
  runHostCodexManagerAgentTurnStream,
  type VoiceUiRules,
} from "./host-codex-manager-agent.js";
import {
  listManagerSkills,
  readManagerSkill,
  readManagerSkillViewTemplates,
  type ManagerSkillSummary,
} from "./manager-skills.js";
import {
  routePluginCapabilities,
  type PluginCapabilityRouteResult,
} from "../plugins/capability-router.js";
import {
  assemblePluginTurnContext,
  assertCurrentPluginTurnContextSubset,
  selectPluginTurnContext,
} from "../plugins/context-assembler.js";
import { getPluginToolTurnAuthority } from "../plugins/action-bus.js";
import {
  managerAgentRuntimePlacementForHarness,
  normalizeManagerAgentHarness,
  type GenerativeUiCanvasContextV1,
  type ManagerAgentRuntimePlacement,
  type HomerailPluginTurnContextV1,
  type ManagerAgentSkillViewTemplateV1,
} from "homerail-protocol";
import type { GenerativeUiMode } from "../generative-ui/mode.js";
import { getActivePlugin, isTrustedRegistryPluginAgentAsset } from "../persistence/plugins.js";
import {
  acknowledgePluginAgentToolContinuationLease,
  leasePluginAgentToolContinuations,
  releasePluginAgentToolContinuationLease,
  type PluginAgentToolContinuationRecord,
} from "../persistence/plugin-tool-continuations.js";

export type ManagerAgentResponseMode = "chat" | "voice";

const CORE_GENERATIVE_UI_CAPABILITY_ID = "com.homerail.core:voice-generative-ui";

export interface ManagerAgentPluginRoutingInput {
  inputs?: Record<string, unknown>;
  explicit_plugin_id?: string;
  explicit_capability_id?: string;
  top_k?: number;
  prompt_byte_budget?: number;
  /** Limit routing to an already assembled compatibility/mode boundary. */
  source_context?: HomerailPluginTurnContextV1;
}

export interface RunManagerAgentTurnInput {
  message: string;
  project_id?: string | null;
  session_id?: string;
  voice_session_id?: string;
  continue_chat?: boolean;
  response_mode?: ManagerAgentResponseMode;
  /** Trusted session rollout snapshot resolved by Manager, never by a Worker. */
  generative_ui_mode?: GenerativeUiMode;
  /** Bounded authoritative canvas state assembled by Manager for this turn. */
  canvas_context?: GenerativeUiCanvasContextV1;
  history?: Array<{ role?: string; content?: string; timestamp?: string }>;
  required_tool_calls?: string[];
  agent_config: ManagerAgentRuntimeConfig;
  voice_ui_rules?: VoiceUiRules;
  manager_skills?: ManagerSkillSummary[];
  /** Exact legacy/preselected context. When present it is forwarded unchanged. */
  plugin_context?: HomerailPluginTurnContextV1;
  /** Router hints used only by Manager; they are never forwarded to a runtime. */
  plugin_routing?: ManagerAgentPluginRoutingInput;
}

export interface RunManagerAgentTurnResult {
  result: Record<string, unknown>;
  worker_id: string | null;
  container_name: string | null;
  runtime_placement: ManagerAgentRuntimePlacement;
  /** Exact selected context delivered to the host/container for this turn. */
  plugin_context: HomerailPluginTurnContextV1;
}

export interface ResolvedManagerAgentTurnAssets {
  plugin_context: HomerailPluginTurnContextV1;
  manager_skills: ResolvedManagerSkill[];
  route: PluginCapabilityRouteResult | null;
}

export interface ResolvedManagerSkill extends ManagerSkillSummary {
  content?: string;
  view_templates?: ManagerAgentSkillViewTemplateV1[];
}

export type RunManagerAgentTurnStreamEvent =
  | { type: "commentary"; text: string }
  | { type: "result"; result: RunManagerAgentTurnResult };

export class ManagerAgentRuntimeError extends Error {
  readonly code:
    | "manager_container_options_missing"
    | "manager_container_error"
    | "manager_chat_error";
  readonly runtime_placement: ManagerAgentRuntimePlacement;
  readonly data: Record<string, unknown>;

  constructor(
    code: ManagerAgentRuntimeError["code"],
    message: string,
    runtimePlacement: ManagerAgentRuntimePlacement,
    data: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "ManagerAgentRuntimeError";
    this.code = code;
    this.runtime_placement = runtimePlacement;
    this.data = data;
  }
}

export function managerAgentRuntimePlacement(config: ManagerAgentRuntimeConfig): ManagerAgentRuntimePlacement {
  if (config.runtime_placement) return config.runtime_placement;
  const harness = normalizeManagerAgentHarness(config.agent_type);
  return harness ? managerAgentRuntimePlacementForHarness(harness) : "container";
}

function scopedManagerSkills(
  provided: ManagerSkillSummary[] | undefined,
  pluginContext: HomerailPluginTurnContextV1,
): ResolvedManagerSkill[] {
  const resolved = listManagerSkills(pluginContext);
  if (!provided) return resolved;
  const local = provided.filter((skill) => skill.source !== "plugin");
  const selectedPlugins = resolved.filter((skill) => skill.source === "plugin");
  const byId = new Map(local.map((skill) => [skill.id, skill]));
  for (const skill of selectedPlugins) byId.set(skill.id, skill);
  return [...byId.values()].sort((left, right) => left.id.localeCompare(right.id));
}

const MAX_INLINE_PLUGIN_SKILL_CHARS = 30_000;
const MAX_INLINE_LOCAL_SKILL_CHARS = 30_000;
const MAX_INLINE_LOCAL_SKILL_TOTAL_CHARS = 60_000;
const MAX_INLINE_LOCAL_SKILLS = 2;
const MIN_LOCAL_SKILL_MATCH_SCORE = 12;

const SKILL_MATCH_STOP_WORDS = new Set([
  "about",
  "agent",
  "answer",
  "data",
  "from",
  "home",
  "homerail",
  "information",
  "query",
  "skill",
  "the",
  "this",
  "tool",
  "use",
  "user",
  "with",
]);

function compactSkillMatchText(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/[\p{P}\p{S}\s_]+/gu, "");
}

function quotedSkillExamples(description: string): string[] {
  const examples: string[] = [];
  for (const pattern of [
    /“([^”]{2,80})”/gu,
    /‘([^’]{2,80})’/gu,
    /"([^"]{2,80})"/gu,
    /'([^']{2,80})'/gu,
  ]) {
    for (const match of description.matchAll(pattern)) examples.push(match[1]);
  }
  return examples;
}

function latinSkillMatchTokens(value: string): Set<string> {
  return new Set(
    (value.normalize("NFKC").toLocaleLowerCase().match(/[a-z0-9][a-z0-9-]{2,}/g) ?? [])
      .filter((token) => !SKILL_MATCH_STOP_WORDS.has(token)),
  );
}

function hanSkillMatchText(value: string): string {
  return (value.normalize("NFKC").match(/\p{Script=Han}+/gu) ?? []).join("");
}

function longestSharedSubstringLength(left: string, right: string): number {
  if (!left || !right) return 0;
  const shorter = left.length <= right.length ? left : right;
  const longer = left.length <= right.length ? right : left;
  let previous = new Uint16Array(shorter.length + 1);
  let longest = 0;
  for (let longIndex = 1; longIndex <= longer.length; longIndex += 1) {
    const current = new Uint16Array(shorter.length + 1);
    for (let shortIndex = 1; shortIndex <= shorter.length; shortIndex += 1) {
      if (longer[longIndex - 1] !== shorter[shortIndex - 1]) continue;
      current[shortIndex] = previous[shortIndex - 1] + 1;
      if (current[shortIndex] > longest) longest = current[shortIndex];
    }
    previous = current;
  }
  return longest;
}

function localSkillMatchScore(skill: ResolvedManagerSkill, utterance: string): number {
  const compactUtterance = compactSkillMatchText(utterance);
  if (!compactUtterance) return 0;

  let score = 0;
  for (const identity of [skill.id, skill.name]) {
    const compactIdentity = compactSkillMatchText(identity);
    if (compactIdentity.length >= 3 && compactUtterance.includes(compactIdentity)) score += 100;
  }

  for (const example of quotedSkillExamples(skill.description)) {
    const compactExample = compactSkillMatchText(example);
    if (compactExample.length >= 3 && compactUtterance.includes(compactExample)) score += 100;
  }

  const utteranceTokens = latinSkillMatchTokens(utterance);
  const descriptionTokens = latinSkillMatchTokens(`${skill.name} ${skill.description}`);
  for (const token of utteranceTokens) {
    if (!descriptionTokens.has(token)) continue;
    score += token.length >= 7 ? 12 : token.length >= 5 ? 8 : 4;
  }

  const sharedHanLength = longestSharedSubstringLength(
    hanSkillMatchText(utterance),
    hanSkillMatchText(skill.description),
  );
  if (sharedHanLength >= 6) score += 20;
  else if (sharedHanLength === 5) score += 16;
  else if (sharedHanLength === 4) score += 12;
  return score;
}

function inlineSelectedPluginSkills(
  skills: ResolvedManagerSkill[],
  pluginContext: HomerailPluginTurnContextV1,
): ResolvedManagerSkill[] {
  const selected = new Map(pluginContext.skills.map((skill) => [skill.qualified_id, skill]));
  return skills.map((skill) => {
    if (skill.source !== "plugin") return skill;
    const descriptor = selected.get(skill.id);
    if (!descriptor) return skill;
    const detail = readManagerSkill(skill.id, {
      plugin_version: descriptor.plugin_version,
      digest: descriptor.digest,
    });
    if (!detail?.content || detail.content.length > MAX_INLINE_PLUGIN_SKILL_CHARS) return skill;
    return { ...skill, content: detail.content };
  });
}

function inlineMatchingLocalSkills(
  skills: ResolvedManagerSkill[],
  utterance: string,
): ResolvedManagerSkill[] {
  const candidates = skills
    .filter((skill) => skill.source !== "plugin" && !skill.content?.trim())
    .map((skill) => ({ skill, score: localSkillMatchScore(skill, utterance) }))
    .filter((candidate) => candidate.score >= MIN_LOCAL_SKILL_MATCH_SCORE)
    .sort((left, right) => right.score - left.score || left.skill.id.localeCompare(right.skill.id));

  const selected = new Map<string, string>();
  let totalChars = 0;
  for (const candidate of candidates) {
    if (selected.size >= MAX_INLINE_LOCAL_SKILLS) break;
    const detail = readManagerSkill(candidate.skill.id);
    const content = detail?.content?.trim();
    if (!content || content.length > MAX_INLINE_LOCAL_SKILL_CHARS) continue;
    if (totalChars + content.length > MAX_INLINE_LOCAL_SKILL_TOTAL_CHARS) continue;
    selected.set(candidate.skill.id, content);
    totalChars += content.length;
  }

  if (selected.size === 0) return skills;
  return skills.map((skill) => {
    const content = selected.get(skill.id);
    return content
      ? { ...skill, content, view_templates: readManagerSkillViewTemplates(skill.id) }
      : skill;
  });
}

function resolveManagerSkillsForTurn(
  provided: ManagerSkillSummary[] | undefined,
  pluginContext: HomerailPluginTurnContextV1,
  utterance: string,
): ResolvedManagerSkill[] {
  return inlineMatchingLocalSkills(
    inlineSelectedPluginSkills(scopedManagerSkills(provided, pluginContext), pluginContext),
    utterance,
  );
}

/**
 * Host and host-shell Agents remain same-UID authority and accept only
 * bundled assets. The isolated container placement may additionally receive
 * active Registry assets whose HRP publisher is still exactly trusted.
 */
function assertAgentPromptTrust(
  context: HomerailPluginTurnContextV1,
  placement: ManagerAgentRuntimePlacement,
): void {
  const plugins = new Map<string, string>();
  for (const entry of [...context.skills, ...context.tools, ...context.actions]) {
    const current = plugins.get(entry.plugin_id);
    if (current && current !== entry.plugin_version) throw new Error("Plugin Agent context mixes package versions");
    plugins.set(entry.plugin_id, entry.plugin_version);
  }
  for (const [pluginId, pluginVersion] of plugins) {
    const plugin = getActivePlugin(pluginId);
    if (plugin?.source === "builtin") continue;
    if (placement !== "container"
      || !plugin
      || plugin.plugin_version !== pluginVersion
      || !plugin.activation.enabled
      || !isTrustedRegistryPluginAgentAsset(pluginId, pluginVersion)) {
      throw new Error(
        `Installed Plugin Agent assets require an active trusted Registry HRP and isolated container placement: ${pluginId}`,
      );
    }
  }
}

/**
 * Resolve Plugin assets once before runtime placement. This is the parity
 * boundary shared by host Codex, host-shell and container workers.
 */
export function resolveManagerAgentTurnAssets(
  input: RunManagerAgentTurnInput,
): ResolvedManagerAgentTurnAssets {
  const placement = managerAgentRuntimePlacement(input.agent_config);
  if (input.plugin_context) {
    const pluginContext = assertCurrentPluginTurnContextSubset(input.plugin_context, undefined, {
      modality: input.response_mode === "voice" ? "voice" : "text",
    });
    assertAgentPromptTrust(pluginContext, placement);
    return {
      plugin_context: pluginContext,
      manager_skills: resolveManagerSkillsForTurn(input.manager_skills, pluginContext, input.message),
      route: null,
    };
  }
  const hints = input.plugin_routing;
  const modality = input.response_mode === "voice" ? "voice" : "text";
  const toolsBound = input.response_mode === "voice"
    && (input.generative_ui_mode === "prefer" || input.generative_ui_mode === "shadow");
  const sourceContext = hints?.source_context ?? assemblePluginTurnContext(undefined, {
    modality,
    include_agent_tools: toolsBound,
  });
  const route = routePluginCapabilities({
    utterance: input.message,
    modality,
    ...(hints?.inputs ? { inputs: hints.inputs } : {}),
    ...(hints?.explicit_plugin_id ? { explicit_plugin_id: hints.explicit_plugin_id } : {}),
    ...(hints?.explicit_capability_id ? { explicit_capability_id: hints.explicit_capability_id } : {}),
    ...(hints?.top_k !== undefined ? { top_k: hints.top_k } : {}),
    ...(hints?.prompt_byte_budget !== undefined ? { prompt_byte_budget: hints.prompt_byte_budget } : {}),
  }, undefined, {
    source_context: sourceContext,
  });
  const selectedContext = toolsBound
    ? selectPluginTurnContext(sourceContext, [
      ...new Set([
        ...route.replay.selected_capability_ids,
        CORE_GENERATIVE_UI_CAPABILITY_ID,
      ]),
    ], route.permission_revision)
    : route.selected_context;
  assertAgentPromptTrust(selectedContext, placement);
  return {
    plugin_context: selectedContext,
    manager_skills: resolveManagerSkillsForTurn(input.manager_skills, selectedContext, input.message),
    route,
  };
}

function pluginToolTurnToken(
  input: RunManagerAgentTurnInput,
  context: HomerailPluginTurnContextV1,
): string | undefined {
  if (context.tools.length === 0) return undefined;
  if (input.response_mode !== "voice") {
    throw new Error("M5 Plugin Tools are available only in a bound voice turn");
  }
  if (input.generative_ui_mode === "off" || input.generative_ui_mode === undefined) {
    throw new Error("Plugin Tool context is forbidden while Generative UI is off or unbound");
  }
  // Shadow retains the M3 pure local projection path. Only prefer makes the
  // Tool Bus authoritative and therefore receives an invocation credential.
  if (input.generative_ui_mode === "shadow") return undefined;
  const scopeId = input.voice_session_id ?? input.session_id;
  if (!scopeId) throw new Error("Plugin Tool routing requires a bound voice session id");
  return getPluginToolTurnAuthority().issue({
    context,
    modality: "voice",
    scope: { type: "voice_session", id: scopeId },
    generative_ui_mode: "prefer",
  }).token;
}

async function runManagerAgentTurnOnce(
  input: RunManagerAgentTurnInput,
  options?: ManagerAgentContainerOptions,
): Promise<RunManagerAgentTurnResult> {
  const runtimePlacement = managerAgentRuntimePlacement(input.agent_config);
  const turnAssets = resolveManagerAgentTurnAssets(input);
  const pluginContext = turnAssets.plugin_context;
  const managerSkills = turnAssets.manager_skills;
  const toolTurnToken = pluginToolTurnToken(input, pluginContext);
  if (runtimePlacement === "host") {
    try {
      const result = await runHostCodexManagerAgentTurn({
        message: input.message,
        project_id: input.project_id ?? undefined,
        session_id: input.session_id,
        voice_session_id: input.voice_session_id,
        continue_chat: input.continue_chat,
        history: input.history,
        canvas_context: input.canvas_context,
        agent_config: input.agent_config,
        managerRestUrl: options?.managerRestUrl,
        response_mode: input.response_mode,
        voice_ui_rules: input.voice_ui_rules,
        manager_skills: managerSkills,
        plugin_context: pluginContext,
        ...(toolTurnToken ? { plugin_tool_turn_token: toolTurnToken } : {}),
      });
      return {
        result,
        worker_id: typeof result.worker_id === "string" ? result.worker_id : "host-codex",
        container_name: typeof result.container_name === "string" ? result.container_name : null,
        runtime_placement: runtimePlacement,
        plugin_context: pluginContext,
      };
    } catch (err) {
      throw new ManagerAgentRuntimeError(
        "manager_chat_error",
        err instanceof Error ? err.message : String(err),
        runtimePlacement,
        {
          worker_id: "host-codex",
          project_id: input.project_id ?? null,
          ...(err instanceof HostCodexManagerAgentExecutionError ? err.data : {}),
        },
      );
    }
  }

  if (!options) {
    throw new ManagerAgentRuntimeError(
      "manager_container_options_missing",
      runtimePlacement === "host_shell"
        ? "Manager Agent host-shell options are not configured"
        : "Manager Agent container options are not configured",
      runtimePlacement,
      { project_id: input.project_id ?? null },
    );
  }

  if (runtimePlacement === "host_shell") {
    let hostAgent;
    try {
      hostAgent = await ensureHostShellManagerAgent(input.project_id ?? undefined, options);
    } catch (err) {
      throw new ManagerAgentRuntimeError(
        "manager_container_error",
        err instanceof Error ? err.message : String(err),
        runtimePlacement,
        { project_id: input.project_id ?? null },
      );
    }
    try {
      const result = await forwardChatToHostShellManagerAgent(hostAgent, {
        message: input.message,
        project_id: input.project_id,
        session_id: input.session_id,
        voice_session_id: input.voice_session_id,
        continue_chat: input.continue_chat,
        response_mode: input.response_mode,
        generative_ui_mode: input.generative_ui_mode,
        history: input.history,
        canvas_context: input.canvas_context,
        required_tool_calls: input.required_tool_calls,
        agent_config: input.agent_config,
        voice_ui_rules: input.voice_ui_rules,
        voice_system_contract: input.response_mode === "voice" ? loadVoiceSystemContract() : undefined,
        manager_skills: managerSkills,
        plugin_context: pluginContext,
        ...(toolTurnToken ? { plugin_tool_turn_token: toolTurnToken } : {}),
      });
      return {
        result,
        worker_id: hostAgent.workerId,
        container_name: hostAgent.processName,
        runtime_placement: runtimePlacement,
        plugin_context: pluginContext,
      };
    } catch (err) {
      throw new ManagerAgentRuntimeError(
        "manager_chat_error",
        err instanceof Error ? err.message : String(err),
        runtimePlacement,
        { worker_id: hostAgent.workerId, project_id: input.project_id ?? null },
      );
    }
  }

  let container;
  try {
    container = await ensureManagerAgentContainer(input.project_id ?? undefined, options);
  } catch (err) {
    throw new ManagerAgentRuntimeError(
      "manager_container_error",
      err instanceof Error ? err.message : String(err),
      runtimePlacement,
      { project_id: input.project_id ?? null },
    );
  }

  try {
    const result = await forwardChatToManagerAgentContainer(container, {
      message: input.message,
      project_id: input.project_id,
      session_id: input.session_id,
      voice_session_id: input.voice_session_id,
      continue_chat: input.continue_chat,
      response_mode: input.response_mode,
      generative_ui_mode: input.generative_ui_mode,
      history: input.history,
      canvas_context: input.canvas_context,
      required_tool_calls: input.required_tool_calls,
      agent_config: input.agent_config,
      voice_ui_rules: input.voice_ui_rules,
      voice_system_contract: input.response_mode === "voice" ? loadVoiceSystemContract() : undefined,
      manager_skills: managerSkills,
      plugin_context: pluginContext,
      ...(toolTurnToken ? { plugin_tool_turn_token: toolTurnToken } : {}),
    });
    return {
      result,
      worker_id: container.containerId,
      container_name: container.containerName,
      runtime_placement: runtimePlacement,
      plugin_context: pluginContext,
    };
  } catch (err) {
    throw new ManagerAgentRuntimeError(
      "manager_chat_error",
      err instanceof Error ? err.message : String(err),
      runtimePlacement,
      {
        project_id: input.project_id ?? null,
        container_id: container.containerId,
        worker_id: container.containerId,
      },
    );
  }
}

function continuationLease(input: RunManagerAgentTurnInput): {
  lease_id?: string;
  records: PluginAgentToolContinuationRecord[];
} {
  const scopeId = input.voice_session_id ?? input.session_id;
  if (input.response_mode !== "voice" || !scopeId) return { records: [] };
  return leasePluginAgentToolContinuations({
    scope: { type: "voice_session", id: scopeId },
  });
}

function messageWithContinuations(
  message: string,
  records: readonly PluginAgentToolContinuationRecord[],
): string {
  if (!records.length) return message;
  const payload = records.map((record) => record.payload);
  return [
    "Manager-confirmed Plugin Tool continuations are authoritative results from earlier user decisions.",
    "Continue from them without repeating the Tool call. Explicitly explain denied, expired, failed, or indeterminate outcomes.",
    `<homerail_plugin_tool_continuations>${JSON.stringify(payload)}</homerail_plugin_tool_continuations>`,
    "",
    message,
  ].join("\n");
}

export async function runManagerAgentTurn(
  input: RunManagerAgentTurnInput,
  options?: ManagerAgentContainerOptions,
): Promise<RunManagerAgentTurnResult> {
  const lease = continuationLease(input);
  try {
    const result = await runManagerAgentTurnOnce({
      ...input,
      message: messageWithContinuations(input.message, lease.records),
    }, options);
    if (lease.lease_id) acknowledgePluginAgentToolContinuationLease(lease.lease_id);
    return result;
  } catch (cause) {
    if (lease.lease_id) releasePluginAgentToolContinuationLease(lease.lease_id);
    throw cause;
  }
}

export async function* runManagerAgentTurnStream(
  input: RunManagerAgentTurnInput,
  options?: ManagerAgentContainerOptions,
): AsyncGenerator<RunManagerAgentTurnStreamEvent> {
  const runtimePlacement = managerAgentRuntimePlacement(input.agent_config);
  if (runtimePlacement !== "host") {
    yield { type: "result", result: await runManagerAgentTurn(input, options) };
    return;
  }

  const lease = continuationLease(input);
  let continuationAcknowledged = false;
  try {
    const turnAssets = resolveManagerAgentTurnAssets(input);
    const pluginContext = turnAssets.plugin_context;
    const managerSkills = turnAssets.manager_skills;
    const toolTurnToken = pluginToolTurnToken(input, pluginContext);
    for await (const event of runHostCodexManagerAgentTurnStream({
      message: messageWithContinuations(input.message, lease.records),
      project_id: input.project_id ?? undefined,
      session_id: input.session_id,
      voice_session_id: input.voice_session_id,
      continue_chat: input.continue_chat,
      history: input.history,
      canvas_context: input.canvas_context,
      agent_config: input.agent_config,
      managerRestUrl: options?.managerRestUrl,
      response_mode: input.response_mode,
      voice_ui_rules: input.voice_ui_rules,
      manager_skills: managerSkills,
      plugin_context: pluginContext,
      ...(toolTurnToken ? { plugin_tool_turn_token: toolTurnToken } : {}),
    })) {
      if (event.type === "commentary") {
        yield { type: "commentary", text: event.text };
      } else if (event.type === "result") {
        if (lease.lease_id && !continuationAcknowledged) {
          acknowledgePluginAgentToolContinuationLease(lease.lease_id);
          continuationAcknowledged = true;
        }
        yield {
          type: "result",
          result: {
            result: event.result,
            worker_id: typeof event.result.worker_id === "string" ? event.result.worker_id : "host-codex",
            container_name: typeof event.result.container_name === "string" ? event.result.container_name : null,
            runtime_placement: runtimePlacement,
            plugin_context: pluginContext,
          },
        };
      }
    }
  } catch (err) {
    throw new ManagerAgentRuntimeError(
      "manager_chat_error",
      err instanceof Error ? err.message : String(err),
      runtimePlacement,
      {
        worker_id: "host-codex",
        project_id: input.project_id ?? null,
        ...(err instanceof HostCodexManagerAgentExecutionError ? err.data : {}),
      },
    );
  } finally {
    if (lease.lease_id && !continuationAcknowledged) {
      releasePluginAgentToolContinuationLease(lease.lease_id);
    }
  }
}
