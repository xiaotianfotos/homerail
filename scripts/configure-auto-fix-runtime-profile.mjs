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
  "adversarial_reviewer",
  "arbiter",
  "publisher",
]);
export const DEFAULT_AUTO_FIX_IMPLEMENTATION_MODEL_NAME = "qwen3.6";
export const DEFAULT_AUTO_FIX_REVIEW_MODEL_NAME = "qwen3.8-max-preview";

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

export function assertAutoFixRoleModel(setting, expectedModelName, role) {
  const expected = nonEmpty(expectedModelName);
  if (!expected) throw new Error(`Expected Auto Fix ${role} model name is required`);
  const actual = nonEmpty(setting?.model_name);
  if (actual?.toLowerCase() !== expected.toLowerCase()) {
    throw new Error(
      `Auto Fix ${role} resolved model ${actual ?? "<missing>"}; expected ${expected}`,
    );
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

export function autoFixRuntimeProfileYaml({ profileId, implementation, review }) {
  return [
    `profile_id: ${yamlString(profileId)}`,
    "workflow_id: auto-fix",
    "description: Private Qwen implementation and independent review bindings for stable Auto Fix.",
    "agents:",
    ...agentEntries(AUTO_FIX_IMPLEMENTATION_AGENTS, implementation),
    ...agentEntries(AUTO_FIX_REVIEW_AGENTS, review),
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
  profileId = process.env.HOMERAIL_AUTO_FIX_PROFILE_ID ?? "auto-fix-qwen36-qwen38-review",
  expectedImplementationModelName = DEFAULT_AUTO_FIX_IMPLEMENTATION_MODEL_NAME,
  expectedReviewModelName = DEFAULT_AUTO_FIX_REVIEW_MODEL_NAME,
  implementationSelector = process.env.HOMERAIL_AUTO_FIX_IMPLEMENTATION_MODEL
    ?? expectedImplementationModelName,
  reviewSelector = process.env.HOMERAIL_AUTO_FIX_REVIEW_MODEL
    ?? expectedReviewModelName,
} = {}) {
  const normalizedManagerUrl = managerUrl.replace(/\/+$/, "");
  const listed = await request(normalizedManagerUrl, "/api/llm/settings");
  const settings = Array.isArray(listed?.settings) ? listed.settings : [];
  const implementation = assertAutoFixRoleModel(
    selectAutoFixRuntimeSetting(settings, implementationSelector, "implementation"),
    expectedImplementationModelName,
    "implementation",
  );
  const review = assertAutoFixRoleModel(
    selectAutoFixRuntimeSetting(settings, reviewSelector, "review"),
    expectedReviewModelName,
    "review",
  );
  if (implementation.id === review.id) {
    throw new Error("Auto Fix implementation and review must use different stable Manager settings");
  }
  const yamlText = autoFixRuntimeProfileYaml({ profileId, implementation, review });
  const synced = await request(normalizedManagerUrl, "/api/dag/profiles/sync", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      yaml_text: yamlText,
      workflow_id: "auto-fix",
      source_path: "stable-runner:auto-fix-qwen36-qwen38-review",
    }),
  });
  if (synced?.profile?.profile_id !== profileId || synced?.profile?.workflow_id !== "auto-fix") {
    throw new Error("Manager synced an unexpected Auto Fix runtime profile");
  }
  return { profileId, implementation, review, yamlText };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const configured = await configureAutoFixRuntimeProfile();
  process.stderr.write(
    `Auto Fix model binding verified: implementation=${configured.implementation.model_name}; review=${configured.review.model_name}\n`,
  );
  process.stdout.write(configured.profileId);
}
