#!/usr/bin/env node

import { pathToFileURL } from "node:url";

export const AUTO_FIX_IMPLEMENTATION_AGENTS = Object.freeze([
  "investigator",
  "implementer",
  "reviser",
]);
export const AUTO_FIX_REVIEW_AGENTS = Object.freeze([
  "correctness_reviewer",
  "regression_reviewer",
]);
export const AUTO_FIX_ARBITRATION_AGENTS = Object.freeze([
  "adversarial_reviewer",
  "arbiter",
  "publisher",
]);

function nonEmpty(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function enabled(value) {
  return value === true || value === 1;
}

function yamlString(value) {
  return JSON.stringify(String(value));
}

export function selectAutoFixRuntimeSetting(settings, selector, role) {
  const wanted = nonEmpty(selector);
  if (!wanted) throw new Error(`HOMERAIL_AUTO_FIX_${role.toUpperCase()}_MODEL is required`);
  const matches = settings.filter((setting) => (
    setting?.id === wanted || setting?.display_name === wanted || setting?.model_name === wanted
  ));
  if (matches.length !== 1) {
    throw new Error(matches.length === 0
      ? `Auto Fix ${role} model was not found in the stable Manager: ${wanted}`
      : `Auto Fix ${role} model selector is ambiguous in the stable Manager: ${wanted}`);
  }
  const setting = matches[0];
  if (!enabled(setting.is_active) || !enabled(setting.supports_llm)) {
    throw new Error(`Auto Fix ${role} model is not an active LLM setting: ${wanted}`);
  }
  if (!nonEmpty(setting.anthropic_base_url)) {
    throw new Error(`Auto Fix ${role} model has no Anthropic-compatible endpoint: ${wanted}`);
  }
  return setting;
}

function agentEntries(agentIds, setting) {
  return agentIds.flatMap((agentId) => [
    `  ${agentId}:`,
    `    llm_setting_id: ${yamlString(setting.id)}`,
    "    agent_type: claude-sdk",
  ]);
}

export function autoFixRuntimeProfileYaml({ profileId, implementation, review, arbitration }) {
  if (new Set([implementation.id, review.id, arbitration.id]).size !== 3) {
    throw new Error("Auto Fix implementation, review, and arbitration roles must use three distinct LLM settings");
  }
  return [
    `profile_id: ${yamlString(profileId)}`,
    "workflow_id: auto-fix",
    "description: Private mixed-model bindings for the stable Auto Fix control plane.",
    "agents:",
    ...agentEntries(AUTO_FIX_IMPLEMENTATION_AGENTS, implementation),
    ...agentEntries(AUTO_FIX_REVIEW_AGENTS, review),
    ...agentEntries(AUTO_FIX_ARBITRATION_AGENTS, arbitration),
    "",
  ].join("\n");
}

async function request(managerUrl, pathname, init) {
  const mutation = init?.method && init.method !== "GET";
  const response = await fetch(`${managerUrl}${pathname}`, {
    ...init,
    headers: {
      ...(init?.headers ?? {}),
      ...(mutation && process.env.HOMERAIL_DAG_MUTATION_TOKEN
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

export async function configureAutoFixRuntimeProfile({
  managerUrl = process.env.HOMERAIL_MANAGER_URL ?? "http://127.0.0.1:19191",
  profileId = process.env.HOMERAIL_AUTO_FIX_PROFILE_ID ?? "auto-fix-mixed",
  implementationSelector = process.env.HOMERAIL_AUTO_FIX_IMPLEMENTATION_MODEL,
  reviewSelector = process.env.HOMERAIL_AUTO_FIX_REVIEW_MODEL,
  arbitrationSelector = process.env.HOMERAIL_AUTO_FIX_ARBITRATION_MODEL,
} = {}) {
  const normalizedManagerUrl = managerUrl.replace(/\/+$/, "");
  const listed = await request(normalizedManagerUrl, "/api/llm/settings");
  const settings = Array.isArray(listed?.settings) ? listed.settings : [];
  const implementation = selectAutoFixRuntimeSetting(settings, implementationSelector, "implementation");
  const review = selectAutoFixRuntimeSetting(settings, reviewSelector, "review");
  const arbitration = selectAutoFixRuntimeSetting(settings, arbitrationSelector, "arbitration");
  const yamlText = autoFixRuntimeProfileYaml({ profileId, implementation, review, arbitration });
  const synced = await request(normalizedManagerUrl, "/api/dag/profiles/sync", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      yaml_text: yamlText,
      workflow_id: "auto-fix",
      source_path: "stable-runner:auto-fix-mixed",
    }),
  });
  if (synced?.profile?.profile_id !== profileId || synced?.profile?.workflow_id !== "auto-fix") {
    throw new Error("Manager synced an unexpected Auto Fix runtime profile");
  }
  return { profileId, implementation, review, arbitration, yamlText };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const configured = await configureAutoFixRuntimeProfile();
  process.stdout.write(configured.profileId);
}
