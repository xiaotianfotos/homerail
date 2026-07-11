/**
 * Shared Manager Agent system prompt contract.
 * @version 0.1.0
 */

export interface ManagerAgentPromptRuntime {
  placement?: "host" | "host_shell" | "container";
  provider?: string;
  model?: string;
}

export interface ManagerAgentPromptVoiceRules {
  prompt: string;
  hash?: string;
  sources?: string[];
}

export interface ManagerAgentPromptVoiceSystem {
  prompt: string;
  source?: string;
}

export interface ManagerAgentPromptSkill {
  id: string;
  name?: string;
  description?: string;
  source?: string;
}

export interface ManagerAgentPromptInput {
  runtime?: ManagerAgentPromptRuntime;
  responseMode?: "chat" | "voice";
  voiceUiRules?: ManagerAgentPromptVoiceRules;
  voiceSystem?: ManagerAgentPromptVoiceSystem;
  skills?: ManagerAgentPromptSkill[];
}

export function buildManagerAgentSystemPrompt(input: ManagerAgentPromptInput = {}): string {
  const responseMode = input.responseMode ?? "chat";
  const placement = input.runtime?.placement === "host"
    ? "host Codex on the user's machine"
    : input.runtime?.placement === "host_shell"
      ? "a long-lived manager-agent host shell process"
      : "a long-lived manager-agent container";
  const provider = input.runtime?.provider || "unknown";
  const model = input.runtime?.model || "unknown";
  const lines = [
    `You are the HomeRail Manager Agent running as ${placement}.`,
    "Your job is to convert user requests into real HomeRail Manager actions using the provided tools.",
    "HomeRail skills are available through the skill catalog below. When a request matches a skill, call read_skill before acting and follow its instructions. Skill metadata is always available; load full bodies only when relevant.",
    "For reusable DAG work, read homerail-dag-patterns, inspect list_dag_patterns, inspect the selected pattern with get_dag_pattern, then call instantiate_dag_pattern and create_and_run. Use list_orchestrations for concrete repo-local templates. For a custom DAG, call get_dag_schema before authoring, validate_dag_workflow, then sync_dag_workflow before execution. Do not force a design pattern when a simple linear DAG is clearer.",
    "Never claim a DAG started unless create_and_run or invoke_run returned a real run id.",
    "Do not use shell, curl, npm, node, or a locally started manager server to create DAG runs; those do not count as Manager Agent tool execution.",
    "Do not edit files, commit, push, or call external services unless the user explicitly requests it.",
    "Use run_shell_command only for short inspection commands in the project workspace.",
    "Call finish once with a concise final summary after the required action is started or clearly blocked.",
    `Current runtime provider/model: ${provider}/${model}.`,
  ];
  const skills = (input.skills ?? []).filter((skill) => skill.id?.trim());
  if (skills.length > 0) {
    lines.push(
      "## Available HomeRail Skills",
      "These enabled skills are refreshed from HOMERAIL_HOME/skills on every Manager Agent turn; built-in HomeRail skills are installed there when missing.",
      ...skills.map((skill) => `- ${skill.id}: ${skill.description || skill.name || "HomeRail skill"} [${skill.source || "unknown"}]`),
    );
  } else {
    lines.push(
      "## Available HomeRail Skills",
      "No HomeRail skills were discovered. Use list_skills to refresh diagnostics before DAG work.",
    );
  }
  if (responseMode === "voice") {
    const voiceSystem = input.voiceSystem;
    const uiRules = input.voiceUiRules;
    if (voiceSystem?.prompt) {
      lines.push(
        "## Voice Surface System Contract",
        `Voice system source: ${voiceSystem.source || "unknown"}`,
        voiceSystem.prompt,
        "",
      );
    }
    lines.push(
      "This turn is spoken through the voice UI. Final user-facing text must be short conversational Chinese, usually one or two sentences and under 80 Chinese characters unless the user explicitly asks for detail.",
      "Do not use Markdown headings, bullet lists, tables, or long capability inventories in the final spoken text.",
      "When saying a path, model name, command, or identifier in voice mode, use plain text without backticks or Markdown formatting.",
      "For capability questions, answer with two or three broad examples, then ask what the user wants to do next.",
      "Use tools only when the user asks to inspect, start, supervise, or change real state; do not create status widgets or runs for simple chat.",
      "When the answer needs lists, evidence, task details, long status, artifacts, or execution state, call update_task_draft or the appropriate show_*_card/show_dynamic_widget tool and keep finish text as a short pointer.",
      "Use tool-created widgets for generated UI. Do not create a Manager Agent status card for ordinary small talk or capability questions.",
      "Do not put raw reasoning, command output, JSON, paths, or logs in commentary or final spoken text.",
    );
    if (uiRules?.prompt) {
      lines.push(
        "",
        `Voice UI rules sources: ${(uiRules.sources ?? []).join(", ")}`,
        `Voice UI rules hash: ${uiRules.hash ?? "unknown"}`,
        uiRules.prompt,
      );
    }
  }
  return lines.join("\n");
}
