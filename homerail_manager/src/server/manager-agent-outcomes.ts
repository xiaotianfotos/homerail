import {
  canonicalManagerAgentToolCallName,
  managerAgentPluginToolCallName,
  managerAgentSkillViewToolDefinitions,
  normalizeManagerAgentOutcomeCapabilities,
  type GenerativeUiCanvasContextV1,
  type HomerailPluginTurnContextV1,
  type ManagerAgentOutcomeCapability,
  type ManagerAgentOutcomeContract,
  type ManagerAgentSkillWithViewsV1,
} from "homerail-protocol";

const CORE_GENERATED_VIEW_TOOL_ID = "com.homerail.core:upsert_generated_view";

export interface ManagerAgentOutcomeEvidence {
  capability: ManagerAgentOutcomeCapability;
  tool_name: string;
  call_id: string;
  evidence: Record<string, unknown>;
}

export class ManagerAgentOutcomeUnsatisfiedError extends Error {
  readonly data: Record<string, unknown>;

  constructor(message: string, data: Record<string, unknown>) {
    super(message);
    this.name = "ManagerAgentOutcomeUnsatisfiedError";
    this.data = { code: "required_outcomes_unsatisfied", ...data };
    Object.setPrototypeOf(this, ManagerAgentOutcomeUnsatisfiedError.prototype);
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function parseRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "string") return record(value);
  try {
    return record(JSON.parse(value));
  } catch {
    return undefined;
  }
}

export function resolveManagerAgentOutcomeContracts(input: {
  required_outcomes?: unknown;
  response_mode?: "chat" | "voice";
  plugin_context: HomerailPluginTurnContextV1;
  manager_skills: readonly ManagerAgentSkillWithViewsV1[];
  canvas_context?: GenerativeUiCanvasContextV1;
}): ManagerAgentOutcomeContract[] {
  const capabilities = normalizeManagerAgentOutcomeCapabilities(input.required_outcomes);
  return capabilities.map((capability): ManagerAgentOutcomeContract => {
    if (capability === "canvas.view.committed") {
      const descriptor = input.response_mode === "voice"
        ? input.plugin_context.tools.find((tool) => tool.qualified_id === CORE_GENERATED_VIEW_TOOL_ID)
        : undefined;
      if (!descriptor) return { capability, tool_names: [] };
      const names = [managerAgentPluginToolCallName(descriptor, input.plugin_context.tools)];
      names.push(...managerAgentSkillViewToolDefinitions(input.manager_skills).map((definition) => definition.name));
      const selected = input.canvas_context?.selected_node_id
        ? input.canvas_context.nodes.find((node) => node.id === input.canvas_context?.selected_node_id)
        : undefined;
      if (selected?.kind === "com.homerail.core/generated_view") names.push("update_selected_generated_view");
      return { capability, tool_names: [...new Set(names)] };
    }
    if (capability === "artifact.published") {
      return { capability, tool_names: input.response_mode === "voice" ? ["publish_artifact"] : [] };
    }
    if (capability === "skill.loaded") return { capability, tool_names: ["read_skill"] };
    return { capability, tool_names: ["start_supervised_dag"] };
  });
}

export function assertManagerAgentOutcomeContractsResolvable(
  contracts: readonly ManagerAgentOutcomeContract[],
): void {
  const unavailable = contracts.filter((contract) => contract.tool_names.length === 0).map((contract) => contract.capability);
  if (unavailable.length === 0) return;
  throw new ManagerAgentOutcomeUnsatisfiedError(
    `Required HomeRail outcome is unavailable in this turn: ${unavailable.join(", ")}`,
    { required_outcomes: contracts.map((contract) => contract.capability), unavailable_outcomes: unavailable },
  );
}

interface SuccessfulToolResult {
  call_id: string;
  tool_name: string;
  body?: Record<string, unknown>;
}

function successfulToolResults(result: Record<string, unknown>): SuccessfulToolResult[] {
  const calls = Array.isArray(result.tool_calls)
    ? result.tool_calls.map(record).filter((item): item is Record<string, unknown> => Boolean(item))
    : [];
  const results = Array.isArray(result.tool_results)
    ? result.tool_results.map(record).filter((item): item is Record<string, unknown> => Boolean(item))
    : [];
  const resultById = new Map(results
    .filter((item) => item.is_error !== true && typeof item.tool_use_id === "string")
    .map((item) => [String(item.tool_use_id), item]));
  return calls.flatMap((call) => {
    const callId = typeof call.id === "string" ? call.id : "";
    const name = canonicalManagerAgentToolCallName(call.name);
    const toolResult = resultById.get(callId);
    if (!callId || !name || !toolResult) return [];
    return [{ call_id: callId, tool_name: name, body: parseRecord(toolResult.content) }];
  });
}

function canvasEvidence(result: SuccessfulToolResult): Record<string, unknown> | undefined {
  const response = record(result.body?.data) ?? result.body;
  const committed = response?.status === "committed";
  const output = record(response?.result);
  const revision = Number(output?.document_revision);
  if (!committed || output?.output_type !== "ui_transaction" || typeof output.document_id !== "string"
    || !Number.isSafeInteger(revision) || revision < 1) return undefined;
  return { document_id: output.document_id, document_revision: revision };
}

function artifactEvidence(result: SuccessfulToolResult): Record<string, unknown> | undefined {
  const data = record(result.body?.data) ?? result.body;
  const artifact = record(data?.artifact);
  if (result.body?.success !== true || typeof artifact?.url !== "string" || !artifact.url.startsWith("/api/")
    || typeof artifact.digest !== "string" || !/^[a-f0-9]{64}$/.test(artifact.digest)) return undefined;
  return { url: artifact.url, digest: artifact.digest, kind: artifact.kind };
}

function skillEvidence(result: SuccessfulToolResult): Record<string, unknown> | undefined {
  const data = record(result.body?.data) ?? result.body;
  if (result.body?.success !== true || typeof data?.content !== "string" || !data.content.trim()) return undefined;
  return {
    skill_id: typeof data.id === "string" ? data.id : null,
    digest: typeof data.digest === "string" ? data.digest : null,
  };
}

function dagEvidence(result: SuccessfulToolResult, turnResult: Record<string, unknown>): Record<string, unknown> | undefined {
  const runIds = Array.isArray(turnResult.run_ids)
    ? turnResult.run_ids.map((item) => typeof item === "string" ? item.trim() : "").filter(Boolean)
    : typeof turnResult.run_id === "string" && turnResult.run_id.trim()
      ? [turnResult.run_id.trim()]
      : [];
  return runIds.length ? { run_ids: runIds } : undefined;
}

export function enforceManagerAgentOutcomeContracts(
  result: Record<string, unknown>,
  contracts: readonly ManagerAgentOutcomeContract[],
): Record<string, unknown> {
  if (contracts.length === 0) return result;
  const successful = successfulToolResults(result);
  const evidence: ManagerAgentOutcomeEvidence[] = [];
  const missing: ManagerAgentOutcomeCapability[] = [];

  for (const contract of contracts) {
    let matched: ManagerAgentOutcomeEvidence | undefined;
    for (const toolResult of successful) {
      if (!contract.tool_names.includes(toolResult.tool_name)) continue;
      const detail = contract.capability === "canvas.view.committed"
        ? canvasEvidence(toolResult)
        : contract.capability === "artifact.published"
          ? artifactEvidence(toolResult)
          : contract.capability === "skill.loaded"
            ? skillEvidence(toolResult)
            : dagEvidence(toolResult, result);
      if (!detail) continue;
      matched = {
        capability: contract.capability,
        tool_name: toolResult.tool_name,
        call_id: toolResult.call_id,
        evidence: detail,
      };
      break;
    }
    if (matched) evidence.push(matched);
    else missing.push(contract.capability);
  }

  if (missing.length) {
    throw new ManagerAgentOutcomeUnsatisfiedError(
      `Manager Agent did not produce required committed outcomes: ${missing.join(", ")}`,
      {
        required_outcomes: contracts.map((contract) => contract.capability),
        missing_outcomes: missing,
        observed_tool_calls: successful.map((item) => item.tool_name),
        outcome_evidence: evidence,
      },
    );
  }

  const objective = record(result.objective) ?? {};
  return {
    ...result,
    objective: {
      ...objective,
      required_outcomes: contracts.map((contract) => contract.capability),
      outcome_evidence: evidence,
      satisfied: objective.satisfied !== false,
    },
  };
}
