import { afterEach, describe, expect, it } from "vitest";

import { resolveManagerAgentRuntimeEnv, resolveWorkerRuntimeEnv } from "../src/server/http.js";

const ENV_KEYS = [
  "CLAUDE_CODE_MAX_OUTPUT_TOKENS",
  "CLAUDE_MAX_TURNS",
  "CLAUDE_SDK_QUERY_TIMEOUT_MS",
  "CLAUDE_THINKING_BUDGET",
  "HOMERAIL_ALLOW_INSECURE_REMOTE_WS",
  "GITEA_TOKEN",
  "ANTHROPIC_API_KEY",
  "HOMERAIL_MANAGER_ADMIN_TOKEN",
  "HOMERAIL_MANAGER_AGENT_BACKEND",
] as const;

const savedEnv = new Map<string, string | undefined>();

function saveEnv(): void {
  for (const key of ENV_KEYS) savedEnv.set(key, process.env[key]);
}

function restoreEnv(): void {
  for (const key of ENV_KEYS) {
    const value = savedEnv.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  savedEnv.clear();
}

describe("manager HTTP server worker runtime env", () => {
  afterEach(() => {
    restoreEnv();
  });

  it("passes only explicit safe runtime controls to provisioned workers", () => {
    saveEnv();
    process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS = "8192";
    process.env.CLAUDE_MAX_TURNS = "8";
    process.env.CLAUDE_SDK_QUERY_TIMEOUT_MS = "120000";
    process.env.CLAUDE_THINKING_BUDGET = "2048";
    process.env.HOMERAIL_ALLOW_INSECURE_REMOTE_WS = "1";
    process.env.GITEA_TOKEN = "<redacted-gitea-token>";
    process.env.ANTHROPIC_API_KEY = "should-not-propagate";

    expect(resolveWorkerRuntimeEnv()).toEqual({
      CLAUDE_CODE_MAX_OUTPUT_TOKENS: "8192",
      CLAUDE_MAX_TURNS: "8",
      CLAUDE_SDK_QUERY_TIMEOUT_MS: "120000",
      CLAUDE_THINKING_BUDGET: "2048",
      HOMERAIL_ALLOW_INSECURE_REMOTE_WS: "1",
    });
  });

  it("omits empty runtime controls and returns undefined when none are set", () => {
    saveEnv();
    delete process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS;
    delete process.env.CLAUDE_MAX_TURNS;
    process.env.CLAUDE_SDK_QUERY_TIMEOUT_MS = " ";
    delete process.env.CLAUDE_THINKING_BUDGET;
    delete process.env.HOMERAIL_ALLOW_INSECURE_REMOTE_WS;

    expect(resolveWorkerRuntimeEnv()).toBeUndefined();
  });

  it("keeps the Manager administrator credential out of every Worker runtime environment", () => {
    saveEnv();
    process.env.HOMERAIL_MANAGER_ADMIN_TOKEN = "manager-agent-admin-token-0123456789abcdef";
    process.env.HOMERAIL_MANAGER_AGENT_BACKEND = "claude-sdk";
    process.env.ANTHROPIC_API_KEY = "must-not-propagate";

    expect(resolveManagerAgentRuntimeEnv()).toEqual({
      HOMERAIL_MANAGER_AGENT_BACKEND: "claude-sdk",
      AGENT_BACKEND: "claude-sdk",
    });
    expect(resolveManagerAgentRuntimeEnv()).not.toHaveProperty("HOMERAIL_MANAGER_ADMIN_TOKEN");
    expect(resolveWorkerRuntimeEnv()).toBeUndefined();
  });
});
