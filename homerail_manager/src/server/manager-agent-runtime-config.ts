import * as fs from "node:fs";
import * as path from "node:path";
import { ensureDefaultWorkspacePath } from "../config/env.js";
import { getProject } from "../persistence/projects-changes.js";
import { resolveAgentRuntimeConfig } from "../runtime/agent-runtime-resolver.js";
import {
  type ManagerAgentHarness,
  type ManagerAgentReasoningEffort,
  type ManagerAgentServiceTier,
} from "homerail-protocol";

export type ManagerAgentHostRuntimePlacement = "host" | "host_shell";

export interface ManagerAgentRuntimeConfig {
  provider_name: string;
  model: string;
  api_key: string;
  base_url: string;
  protocol?: string;
  agent_type: string;
  runtime_placement: ManagerAgentHostRuntimePlacement;
  project_id?: string;
  project_workspace?: string;
  reasoning_effort?: ManagerAgentReasoningEffort;
  service_tier: ManagerAgentServiceTier;
}

function resolveProjectWorkspace(projectId?: string): string | undefined {
  if (projectId) {
    const project = getProject(projectId);
    const candidate = project?.workspace_path ?? project?.project_root;
    if (candidate && fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
      return path.resolve(candidate);
    }
    return undefined;
  }
  const explicit = process.env.HOMERAIL_PROJECT_WORKSPACE || process.env.HOMERAIL_REPO_ROOT;
  if (explicit && fs.existsSync(explicit) && fs.statSync(explicit).isDirectory()) {
    return path.resolve(explicit);
  }
  return ensureDefaultWorkspacePath();
}

export function resolveManagerAgentConfig(
  projectId: string | undefined,
  providerName?: string,
  modelName?: string,
  settingId?: string,
  harness?: ManagerAgentHarness | string | null,
  reasoningEffort?: ManagerAgentReasoningEffort | string | null,
  serviceTier?: ManagerAgentServiceTier,
): ManagerAgentRuntimeConfig {
  const effort = typeof reasoningEffort === "string" && reasoningEffort.trim()
    ? reasoningEffort.trim()
    : undefined;
  const normalizedServiceTier = serviceTier === "fast" ? "priority" : serviceTier ?? null;
  const resolved = resolveAgentRuntimeConfig({
    surface: "manager_agent",
    providerName,
    modelName,
    settingId,
    harness,
  });
  if (resolved.runtime_placement === "container") {
    throw new Error("Manager Agent must run on the host");
  }
  return {
    ...resolved,
    runtime_placement: resolved.runtime_placement,
    project_id: projectId,
    project_workspace: resolveProjectWorkspace(projectId),
    reasoning_effort: effort ?? "low",
    service_tier: normalizedServiceTier,
  };
}
