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
  loadVoiceSystemContract,
  runHostCodexManagerAgentTurn,
  runHostCodexManagerAgentTurnStream,
  type VoiceUiRules,
} from "./host-codex-manager-agent.js";
import { listManagerSkills, type ManagerSkillSummary } from "./manager-skills.js";
import {
  managerAgentRuntimePlacementForHarness,
  normalizeManagerAgentHarness,
  type ManagerAgentRuntimePlacement,
} from "homerail-protocol";

export type ManagerAgentResponseMode = "chat" | "voice";

export interface RunManagerAgentTurnInput {
  message: string;
  project_id?: string | null;
  session_id?: string;
  voice_session_id?: string;
  continue_chat?: boolean;
  response_mode?: ManagerAgentResponseMode;
  history?: Array<{ role?: string; content?: string; timestamp?: string }>;
  required_tool_calls?: string[];
  agent_config: ManagerAgentRuntimeConfig;
  voice_ui_rules?: VoiceUiRules;
  manager_skills?: ManagerSkillSummary[];
}

export interface RunManagerAgentTurnResult {
  result: Record<string, unknown>;
  worker_id: string | null;
  container_name: string | null;
  runtime_placement: ManagerAgentRuntimePlacement;
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

export async function runManagerAgentTurn(
  input: RunManagerAgentTurnInput,
  options?: ManagerAgentContainerOptions,
): Promise<RunManagerAgentTurnResult> {
  const runtimePlacement = managerAgentRuntimePlacement(input.agent_config);
  const managerSkills = input.manager_skills ?? listManagerSkills();
  if (runtimePlacement === "host") {
    try {
      const result = await runHostCodexManagerAgentTurn({
        message: input.message,
        project_id: input.project_id ?? undefined,
        session_id: input.session_id,
        voice_session_id: input.voice_session_id,
        continue_chat: input.continue_chat,
        history: input.history,
        agent_config: input.agent_config,
        managerRestUrl: options?.managerRestUrl,
        response_mode: input.response_mode,
        voice_ui_rules: input.voice_ui_rules,
        manager_skills: managerSkills,
      });
      return {
        result,
        worker_id: typeof result.worker_id === "string" ? result.worker_id : "host-codex",
        container_name: typeof result.container_name === "string" ? result.container_name : null,
        runtime_placement: runtimePlacement,
      };
    } catch (err) {
      throw new ManagerAgentRuntimeError(
        "manager_chat_error",
        err instanceof Error ? err.message : String(err),
        runtimePlacement,
        { worker_id: "host-codex", project_id: input.project_id ?? null },
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
        continue_chat: input.continue_chat,
        response_mode: input.response_mode,
        history: input.history,
        required_tool_calls: input.required_tool_calls,
        agent_config: input.agent_config,
        voice_ui_rules: input.voice_ui_rules,
        voice_system_contract: input.response_mode === "voice" ? loadVoiceSystemContract() : undefined,
        manager_skills: managerSkills,
      });
      return {
        result,
        worker_id: hostAgent.workerId,
        container_name: hostAgent.processName,
        runtime_placement: runtimePlacement,
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
      continue_chat: input.continue_chat,
      response_mode: input.response_mode,
      history: input.history,
      required_tool_calls: input.required_tool_calls,
      agent_config: input.agent_config,
      voice_ui_rules: input.voice_ui_rules,
      voice_system_contract: input.response_mode === "voice" ? loadVoiceSystemContract() : undefined,
      manager_skills: managerSkills,
    });
    return {
      result,
      worker_id: container.containerId,
      container_name: container.containerName,
      runtime_placement: runtimePlacement,
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

export async function* runManagerAgentTurnStream(
  input: RunManagerAgentTurnInput,
  options?: ManagerAgentContainerOptions,
): AsyncGenerator<RunManagerAgentTurnStreamEvent> {
  const runtimePlacement = managerAgentRuntimePlacement(input.agent_config);
  if (runtimePlacement !== "host") {
    yield { type: "result", result: await runManagerAgentTurn(input, options) };
    return;
  }

  try {
    const managerSkills = input.manager_skills ?? listManagerSkills();
    for await (const event of runHostCodexManagerAgentTurnStream({
      message: input.message,
      project_id: input.project_id ?? undefined,
      session_id: input.session_id,
      voice_session_id: input.voice_session_id,
      continue_chat: input.continue_chat,
      history: input.history,
      agent_config: input.agent_config,
      managerRestUrl: options?.managerRestUrl,
      response_mode: input.response_mode,
      voice_ui_rules: input.voice_ui_rules,
      manager_skills: managerSkills,
    })) {
      if (event.type === "commentary") {
        yield { type: "commentary", text: event.text };
      } else if (event.type === "result") {
        yield {
          type: "result",
          result: {
            result: event.result,
            worker_id: typeof event.result.worker_id === "string" ? event.result.worker_id : "host-codex",
            container_name: typeof event.result.container_name === "string" ? event.result.container_name : null,
            runtime_placement: runtimePlacement,
          },
        };
      }
    }
  } catch (err) {
    throw new ManagerAgentRuntimeError(
      "manager_chat_error",
      err instanceof Error ? err.message : String(err),
      runtimePlacement,
      { worker_id: "host-codex", project_id: input.project_id ?? null },
    );
  }
}
