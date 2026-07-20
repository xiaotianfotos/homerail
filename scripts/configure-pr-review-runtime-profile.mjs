#!/usr/bin/env node

import { pathToFileURL } from "node:url";

export const PR_REVIEW_ARBITER_AGENTS = Object.freeze([
  "evidence_voter",
  "false_positive_voter",
  "coverage_voter",
  "refiner",
  "publisher",
]);

function nonEmpty(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function bool(value) {
  return value === true || value === 1;
}

function yamlString(value) {
  return JSON.stringify(String(value));
}

export function selectRuntimeSetting(settings, selector, role) {
  const wanted = nonEmpty(selector);
  if (!wanted) throw new Error(`HOMERAIL_PR_REVIEW_${role.toUpperCase()}_MODEL is required for Seed Home review`);
  const matches = settings.filter((setting) => (
    setting?.id === wanted || setting?.display_name === wanted || setting?.model_name === wanted
  ));
  if (matches.length !== 1) {
    throw new Error(matches.length === 0
      ? `PR Review ${role} model was not found in Seed Home: ${wanted}`
      : `PR Review ${role} model selector is ambiguous in Seed Home: ${wanted}`);
  }
  const setting = matches[0];
  if (!bool(setting.is_active) || !bool(setting.supports_llm)) {
    throw new Error(`PR Review ${role} model is not an active LLM setting: ${wanted}`);
  }
  if (!nonEmpty(setting.anthropic_base_url)) {
    throw new Error(`PR Review ${role} model has no Anthropic-compatible endpoint: ${wanted}`);
  }
  return setting;
}

export function prReviewRuntimeProfileYaml({ profileId, primary, arbiter }) {
  if (primary.id === arbiter.id) {
    throw new Error("PR Review primary and arbiter roles must use different LLM settings");
  }
  return [
    `profile_id: ${yamlString(profileId)}`,
    "workflow_id: pr-review",
    "description: Mixed-model PR review with an independent arbitration boundary.",
    "default:",
    `  llm_setting_id: ${yamlString(primary.id)}`,
    "  agent_type: claude-sdk",
    "agents:",
    ...PR_REVIEW_ARBITER_AGENTS.flatMap((agentId) => [
      `  ${agentId}:`,
      `    llm_setting_id: ${yamlString(arbiter.id)}`,
      "    agent_type: claude-sdk",
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
  profileId = process.env.HOMERAIL_PR_REVIEW_PROFILE_ID ?? "pr-review-mixed",
  primarySelector = process.env.HOMERAIL_PR_REVIEW_PRIMARY_MODEL,
  arbiterSelector = process.env.HOMERAIL_PR_REVIEW_ARBITER_MODEL,
} = {}) {
  const normalizedManagerUrl = managerUrl.replace(/\/+$/, "");
  const listed = await request(normalizedManagerUrl, "/api/llm/settings");
  const settings = Array.isArray(listed?.settings) ? listed.settings : [];
  const primary = selectRuntimeSetting(settings, primarySelector, "primary");
  const arbiter = selectRuntimeSetting(settings, arbiterSelector, "arbiter");
  const yamlText = prReviewRuntimeProfileYaml({ profileId, primary, arbiter });
  const synced = await request(normalizedManagerUrl, "/api/dag/profiles/sync", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      yaml_text: yamlText,
      workflow_id: "pr-review",
      source_path: "runner-seed:pr-review-mixed",
    }),
  });
  if (synced?.profile?.profile_id !== profileId || synced?.profile?.workflow_id !== "pr-review") {
    throw new Error("Manager synced an unexpected PR Review runtime profile");
  }
  return { profileId, primary, arbiter, yamlText };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const configured = await configurePrReviewRuntimeProfile();
  process.stdout.write(configured.profileId);
}
