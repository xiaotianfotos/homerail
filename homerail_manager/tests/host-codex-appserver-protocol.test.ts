import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { describe, expect, it } from "vitest";

import {
  _buildCodexAppServerArgsForTest,
  _buildCodexThreadResumeParamsForTest,
  _buildCodexThreadStartParamsForTest,
  _buildCodexTurnStartParamsForTest,
  _mapCodexAppServerNotificationForTest,
  _mapCodexAppServerNotificationSequenceForTest,
  _nativeCommentaryMessagesForTest,
  materializeHostCodexManagerPluginSkills,
} from "../src/server/host-codex-manager-agent.js";

describe("Host Codex app-server protocol params", () => {
  it("passes HomeRail reasoning effort through thread config instead of the removed legacy field", () => {
    const params = _buildCodexThreadStartParamsForTest({
      systemPrompt: "You are HomeRail.",
      cwd: "/workspace",
      model: "gpt-5.5",
      sandbox: "workspace-write",
      dynamicTools: [{ name: "write_widget_file" }],
      reasoningEffort: "ultra",
    });

    expect(params).toMatchObject({
      baseInstructions: null,
      developerInstructions: "You are HomeRail.",
      model: "gpt-5.5",
      config: { model_reasoning_effort: "ultra" },
      serviceTier: null,
      tools: { web_search: { context_size: "medium" } },
      ephemeral: true,
    });
    expect(params).not.toHaveProperty("modelReasoningEffort");
  });

  it("uses a persisted Codex thread for a stable Manager Agent session", () => {
    const started = _buildCodexThreadStartParamsForTest({
      systemPrompt: "You are HomeRail.",
      cwd: "/workspace",
      model: "gpt-5.6",
      sandbox: "workspace-write",
      dynamicTools: [{ name: "get_dag_supervision" }, { name: "send_dag_actor_command" }],
      ephemeral: false,
    });
    expect(started).toMatchObject({ ephemeral: false });

    const resumed = _buildCodexThreadResumeParamsForTest({
      threadId: "019f0000-0000-7000-8000-000000000000",
      systemPrompt: "Updated HomeRail contract",
      cwd: "/workspace",
      model: "gpt-5.6",
      sandbox: "workspace-write",
      reasoningEffort: "high",
    });
    expect(resumed).toMatchObject({
      threadId: "019f0000-0000-7000-8000-000000000000",
      baseInstructions: null,
      developerInstructions: "Updated HomeRail contract",
      cwd: "/workspace",
      model: "gpt-5.6",
      approvalPolicy: "never",
      sandbox: "workspace-write",
      config: { model_reasoning_effort: "high" },
    });
  });

  it("materializes immutable Plugin Skills for Codex native discovery", () => {
    const previousHome = process.env.HOMERAIL_HOME;
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "homerail-codex-plugin-skills-"));
    process.env.HOMERAIL_HOME = home;
    try {
      const skills = [{
        id: "com.homerail.core:voice-generative-ui",
        name: "voice-generative-ui",
        description: "Build truthful generated interfaces.",
        source: "plugin",
        projection_content: [
          "---",
          "name: voice-generative-ui",
          "description: Old nested metadata.",
          "---",
          "",
          "Follow the HomeRail visual contract.",
        ].join("\n"),
      }, {
        id: "home-only",
        source: "home",
        projection_content: "Must not be copied into the Plugin projection root.",
      }];

      const first = materializeHostCodexManagerPluginSkills(skills);
      const second = materializeHostCodexManagerPluginSkills(skills);
      expect(first).toBe(second);
      expect(first).toContain(path.join(home, "runtime", "codex-manager-plugin-skills"));
      const directories = fs.readdirSync(first!);
      expect(directories).toHaveLength(1);
      const body = fs.readFileSync(path.join(first!, directories[0]!, "SKILL.md"), "utf8");
      expect(body).toContain("HomeRail Skill id: com.homerail.core:voice-generative-ui");
      expect(body).toContain("Follow the HomeRail visual contract.");
      expect(body).not.toContain("Old nested metadata.");
      expect(body).not.toContain("Must not be copied");
    } finally {
      if (previousHome === undefined) delete process.env.HOMERAIL_HOME;
      else process.env.HOMERAIL_HOME = previousHome;
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("passes HomeRail reasoning effort through turn/start effort", () => {
    const params = _buildCodexTurnStartParamsForTest({
      threadId: "thread-1",
      prompt: "Run this task.",
      cwd: "/workspace",
      model: "gpt-5.5",
      reasoningEffort: "max",
      serviceTier: "priority",
    });

    expect(params).toMatchObject({
      threadId: "thread-1",
      model: "gpt-5.5",
      effort: "max",
      serviceTier: "priority",
      input: [{ type: "text", text: "Run this task.", text_elements: [] }],
    });
    expect(params).not.toHaveProperty("modelReasoningEffort");
  });

  it("starts app-server without a hidden Fast service-tier override", () => {
    expect(_buildCodexAppServerArgsForTest()).toEqual(["app-server"]);
  });

  it("maps built-in web search activity to tool events without synthetic chat commentary", () => {
    expect(_mapCodexAppServerNotificationForTest("item/started", {
      item: {
        type: "webSearch",
        id: "search-1",
        query: "latest product release notes",
      },
    })).toEqual([{
      type: "tool_use",
      id: "search-1",
      name: "web_search",
      input: {},
    }]);
    expect(_mapCodexAppServerNotificationForTest("item/completed", {
      item: {
        type: "webSearch",
        id: "search-1",
        query: "latest product release notes",
      },
    })).toEqual([{
      type: "tool_result",
      tool_use_id: "search-1",
      content: "Web search completed.",
    }]);
  });

  it("preserves native assistant message phases and never exposes reasoning as commentary", () => {
    const events = _mapCodexAppServerNotificationSequenceForTest([
      {
        method: "item/started",
        payload: { item: { type: "agentMessage", id: "commentary-1", text: "", phase: "commentary" } },
      },
      {
        method: "item/agentMessage/delta",
        payload: { itemId: "commentary-1", delta: "正在核对真实状态。" },
      },
      {
        method: "item/completed",
        payload: { item: { type: "agentMessage", id: "commentary-1", text: "正在核对真实状态。", phase: "commentary" } },
      },
      {
        method: "item/reasoning/summaryTextDelta",
        payload: { itemId: "reasoning-1", delta: "private reasoning" },
      },
      {
        method: "item/started",
        payload: { item: { type: "agentMessage", id: "final-1", text: "", phase: "final_answer" } },
      },
      {
        method: "item/agentMessage/delta",
        payload: { itemId: "final-1", delta: "已经完成。" },
      },
      {
        method: "item/completed",
        payload: { item: { type: "agentMessage", id: "final-1", text: "已经完成。", phase: "final_answer" } },
      },
    ]);

    expect(events).toEqual([
      { type: "commentary", text: "正在核对真实状态。" },
      { type: "thinking", text: "private reasoning" },
      { type: "text", text: "已经完成。" },
    ]);
  });

  it("treats a provider message with no phase as final-compatible text", () => {
    expect(_mapCodexAppServerNotificationSequenceForTest([
      {
        method: "item/started",
        payload: { item: { type: "agentMessage", id: "legacy-1", text: "", phase: null } },
      },
      {
        method: "item/agentMessage/delta",
        payload: { itemId: "legacy-1", delta: "legacy response" },
      },
      { method: "turn/completed", payload: { turn: { status: "completed" } } },
    ])).toEqual([
      { type: "text", text: "legacy response" },
      { type: "turn_complete" },
    ]);
  });

  it("preserves each native commentary message boundary instead of merging progress", () => {
    expect(_nativeCommentaryMessagesForTest([
      "先检查配置。",
      "配置已确认，继续核对运行状态。",
      "先检查配置。",
    ])).toEqual([
      "先检查配置。",
      "配置已确认，继续核对运行状态。",
    ]);
  });
});
