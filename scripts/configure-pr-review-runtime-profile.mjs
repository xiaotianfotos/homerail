#!/usr/bin/env node

import { pathToFileURL } from "node:url";

export const PR_REVIEW_MODEL_AGENTS = Object.freeze({
  qwen_reviewer: "primary",
  kimi_reviewer: "arbiter",
  glm_reviewer: "third",
});

function nonEmpty(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function bool(value) {
  return value === true || value === 1;
}

function yamlString(value) {
  return JSON.stringify(String(value));
}

function normalizedAgentType(value) {
  const agentType = nonEmpty(value) ?? "claude-sdk";
  if (agentType !== "claude-sdk" && agentType !== "deepseek_harness") {
    throw new Error(`Unsupported PR Review agent type: ${agentType}`);
  }
  return agentType;
}

export function resolvePrReviewProfileId(value, agentType) {
  agentType = normalizedAgentType(agentType);
  const profileId = nonEmpty(value)
    ?? (agentType === "deepseek_harness" ? "pr-review-dsh" : "pr-review-mixed");
  if (agentType === "deepseek_harness" && profileId === "pr-review-mixed") {
    throw new Error("DeepSeek Harness PR Review must not overwrite the pr-review-mixed profile");
  }
  return profileId;
}

function normalizedDshReasoningEffort(value, agentType, settings) {
  if (agentType !== "deepseek_harness") return undefined;
  const effort = nonEmpty(value);
  if (!effort) return undefined;
  for (const setting of new Set(settings)) {
    const effortMap = setting?.reasoning_effort_map;
    if (
      !effortMap
      || typeof effortMap !== "object"
      || !Object.prototype.hasOwnProperty.call(effortMap, effort)
    ) {
      throw new Error(
        `DeepSeek Harness model setting ${setting?.id ?? "unknown"} does not declare reasoning effort: ${effort}`,
      );
    }
  }
  return effort;
}

export function selectRuntimeSetting(settings, selector, role, agentType = "claude-sdk") {
  agentType = normalizedAgentType(agentType);
  const wanted = nonEmpty(selector);
  if (!wanted) throw new Error(`HOMERAIL_PR_REVIEW_${role.toUpperCase()}_MODEL is required for stable review`);
  const matches = settings.filter((setting) => (
    setting?.id === wanted || setting?.display_name === wanted || setting?.model_name === wanted
  ));
  if (matches.length !== 1) {
    throw new Error(matches.length === 0
      ? `PR Review ${role} model was not found in the stable Manager: ${wanted}`
      : `PR Review ${role} model selector is ambiguous in the stable Manager: ${wanted}`);
  }
  const setting = matches[0];
  if (!bool(setting.is_active) || !bool(setting.supports_llm)) {
    throw new Error(`PR Review ${role} model is not an active LLM setting: ${wanted}`);
  }
  if (agentType === "claude-sdk" && !nonEmpty(setting.anthropic_base_url)) {
    throw new Error(`PR Review ${role} model has no Anthropic-compatible endpoint: ${wanted}`);
  }
  if (agentType === "deepseek_harness" && setting.protocol !== "openai_compatible") {
    throw new Error(`PR Review ${role} model is not OpenAI-compatible for DeepSeek Harness: ${wanted}`);
  }
  if (
    agentType === "deepseek_harness"
    && !nonEmpty(setting.chat_completions_base_url)
    && !nonEmpty(setting.base_url)
  ) {
    throw new Error(`PR Review ${role} model has no Chat Completions endpoint: ${wanted}`);
  }
  return setting;
}

export function prReviewRuntimeProfileYaml({
  profileId,
  workflowId = "pr-review",
  primary,
  arbiter,
  third,
  agentType = "claude-sdk",
  reasoningEffort,
}) {
  agentType = normalizedAgentType(agentType);
  reasoningEffort = normalizedDshReasoningEffort(reasoningEffort, agentType, [primary, arbiter, third]);
  if (agentType === "claude-sdk" && new Set([primary.id, arbiter.id, third.id]).size !== 3) {
    throw new Error("PR Review requires three distinct LLM settings");
  }
  const settingsByRole = { primary, arbiter, third };
  const description = agentType === "deepseek_harness"
    ? "Three independent DeepSeek Harness reviewer processes; model settings may intentionally be shared."
    : "Three-model PR review with one independent vote per model.";
  return [
    `profile_id: ${yamlString(profileId)}`,
    `workflow_id: ${yamlString(workflowId)}`,
    `description: ${description}`,
    "default:",
    `  llm_setting_id: ${yamlString(primary.id)}`,
    `  agent_type: ${agentType}`,
    ...(reasoningEffort ? [`  reasoning_effort: ${yamlString(reasoningEffort)}`] : []),
    "agents:",
    ...Object.entries(PR_REVIEW_MODEL_AGENTS).flatMap(([agentId, role]) => [
      `  ${agentId}:`,
      `    llm_setting_id: ${yamlString(settingsByRole[role].id)}`,
      `    agent_type: ${agentType}`,
      ...(reasoningEffort ? [`    reasoning_effort: ${yamlString(reasoningEffort)}`] : []),
    ]),
    "",
  ].join("\n");
}

async function request(managerUrl, pathname, init) {
  const isMutation = init?.method && init.method !== "GET";
  const response = await fetch(`${managerUrl}${pathname}`, {
    ...init,
    headers: {
      ...(init?.headers ?? {}),
      ...(process.env.HOMERAIL_DAG_MUTATION_TOKEN && isMutation
        ? { "x-homerail-dag-token": process.env.HOMERAIL_DAG_MUTATION_TOKEN }
        : {}),
    },
  });
  const body = await response.json();
  if (!response.ok || body.success === false) {
    throw new Error(`${init?.method ?? "GET"} ${pathname}: ${body.error ?? body.message ?? `HTTP ${response.status}`}`);
  }
  return body.data;
}

export async function configurePrReviewRuntimeProfile({
  managerUrl = process.env.HOMERAIL_MANAGER_URL ?? "http://127.0.0.1:29191",
  profileId = process.env.HOMERAIL_PR_REVIEW_PROFILE_ID,
  workflowId = process.env.HOMERAIL_PR_REVIEW_WORKFLOW_ID ?? "pr-review",
  agentType = process.env.HOMERAIL_PR_REVIEW_AGENT_TYPE ?? "claude-sdk",
  modelSelector = process.env.HOMERAIL_PR_REVIEW_MODEL,
  primarySelector = process.env.HOMERAIL_PR_REVIEW_PRIMARY_MODEL,
  arbiterSelector = process.env.HOMERAIL_PR_REVIEW_ARBITER_MODEL,
  thirdSelector = process.env.HOMERAIL_PR_REVIEW_THIRD_MODEL,
  reasoningEffort = process.env.HOMERAIL_PR_REVIEW_REASONING_EFFORT,
} = {}) {
  const normalizedManagerUrl = managerUrl.replace(/\/+$/, "");
  workflowId = nonEmpty(workflowId) ?? "pr-review";
  agentType = normalizedAgentType(agentType);
  profileId = resolvePrReviewProfileId(profileId, agentType);
  modelSelector = nonEmpty(modelSelector);
  const listed = await request(normalizedManagerUrl, "/api/llm/settings");
  const settings = Array.isArray(listed?.settings) ? listed.settings : [];
  const primary = selectRuntimeSetting(settings, modelSelector ?? primarySelector, "primary", agentType);
  const arbiter = selectRuntimeSetting(settings, modelSelector ?? arbiterSelector, "arbiter", agentType);
  const third = selectRuntimeSetting(settings, modelSelector ?? thirdSelector, "third", agentType);
  const yamlText = prReviewRuntimeProfileYaml({
    profileId,
    workflowId,
    primary,
    arbiter,
    third,
    agentType,
    reasoningEffort,
  });
  const synced = await request(normalizedManagerUrl, "/api/dag/profiles/sync", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      yaml_text: yamlText,
      workflow_id: workflowId,
      source_path: `stable-runner:${profileId}`,
    }),
  });
  if (synced?.profile?.profile_id !== profileId || synced?.profile?.workflow_id !== workflowId) {
    throw new Error("Manager synced an unexpected PR Review runtime profile");
  }
  return { profileId, primary, arbiter, third, yamlText };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const configured = await configurePrReviewRuntimeProfile();
  process.stdout.write(configured.profileId);
}
