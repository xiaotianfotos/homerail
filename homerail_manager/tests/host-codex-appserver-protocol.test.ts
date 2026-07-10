import { describe, expect, it } from "vitest";

import {
  _buildCodexAppServerArgsForTest,
  _buildCodexThreadStartParamsForTest,
  _buildCodexTurnStartParamsForTest,
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
      model: "gpt-5.5",
      config: { model_reasoning_effort: "ultra" },
      serviceTier: null,
    });
    expect(params).not.toHaveProperty("modelReasoningEffort");
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
});
