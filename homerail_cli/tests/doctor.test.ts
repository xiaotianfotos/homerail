import { describe, expect, it, vi } from "vitest";
import { configuredModel, dockerReadiness, managerAgentReadiness } from "../src/commands/doctor.js";
import { resolveDockerBinary } from "../src/docker-bin.js";
import type { BaseResponse } from "../src/client.js";

function settings(settingsList: Array<Record<string, unknown>>): BaseResponse {
  return {
    success: true,
    message: "ok",
    data: { settings: settingsList },
  };
}

function runnerFor(results: Array<Record<string, unknown>>) {
  let index = 0;
  return vi.fn(() => {
    const result = results[index++] ?? { status: 0, stdout: "", stderr: "" };
    return {
      status: typeof result.status === "number" ? result.status : null,
      stdout: typeof result.stdout === "string" ? result.stdout : "",
      stderr: typeof result.stderr === "string" ? result.stderr : "",
      error: result.error as Error | undefined,
    };
  });
}

describe("doctor readiness helpers", () => {
  it("resolves the Docker Desktop CLI from the default Windows install path", () => {
    const expected = "C:\\Program Files\\Docker\\Docker\\resources\\bin\\docker.exe";
    expect(resolveDockerBinary({
      env: { ProgramFiles: "C:\\Program Files" } as NodeJS.ProcessEnv,
      platform: "win32",
      existsSync: (candidate) => candidate === expected,
    })).toBe(expected);
  });

  it("recognizes any active LLM setting instead of hard-coded providers", () => {
    const resp = settings([
      {
        id: "kimi-1",
        provider_id: "kimi",
        model_name: "kimi-k2.7-code",
        is_active: true,
        is_default: true,
        supports_llm: true,
      },
    ]);

    expect(configuredModel(resp)).toBe("kimi/kimi-k2.7-code");
  });

  it("ignores voice-only settings for model readiness", () => {
    const resp = settings([
      {
        id: "tts-1",
        provider_id: "xiaomi",
        model_name: "mimo-v2.5-tts",
        is_active: true,
        supports_llm: false,
        supports_tts: true,
      },
    ]);

    expect(configuredModel(resp)).toBeNull();
  });

  it("keeps LLM settings even when extra media capabilities are enabled", () => {
    const resp = settings([
      {
        id: "multi-capability-llm",
        provider_id: "kimi",
        model_name: "kimi-k2.7-code",
        is_active: true,
        supports_llm: true,
        supports_asr: true,
        supports_tts: true,
      },
    ]);

    expect(configuredModel(resp)).toBe("kimi/kimi-k2.7-code");
  });

  it("requires an Anthropic-compatible endpoint for claude_agent_sdk manager agent", () => {
    const resp = settings([
      {
        id: "deepseek-chat",
        provider_id: "deepseek",
        model_name: "deepseek-chat",
        is_active: true,
        is_default: true,
        supports_llm: true,
        protocol: "openai_compatible",
        base_url: "https://api.deepseek.com",
      },
    ]);

    const check = managerAgentReadiness({ harness: "claude_agent_sdk" }, resp);
    expect(check.ok).toBe(false);
    expect(check.detail).toContain("Anthropic-compatible");
  });

  it("accepts an Anthropic-compatible manager agent setting", () => {
    const resp = settings([
      {
        id: "glm-coding",
        provider_id: "glm",
        model_name: "glm-4.6",
        is_active: true,
        supports_llm: true,
        protocol: "anthropic_compatible",
        base_url: "https://open.bigmodel.cn/api/anthropic",
      },
    ]);

    const check = managerAgentReadiness({ harness: "claude_agent_sdk" }, resp);
    expect(check).toMatchObject({
      name: "manager-agent",
      ok: true,
      detail: "glm/glm-4.6 via claude_agent_sdk",
    });
  });

  it("accepts a Kimi CN setting for the Kimi Code manager agent", () => {
    const resp = settings([
      {
        id: "kimi-cn-coding",
        provider_id: "kimi_cn",
        model_name: "kimi-for-coding",
        is_active: true,
        is_default: true,
        supports_llm: true,
        protocol: "openai_compatible",
        base_url: "https://api.kimi.com/coding/v1",
      },
    ]);

    const check = managerAgentReadiness({ harness: "kimi_code" }, resp);
    expect(check).toMatchObject({
      name: "manager-agent",
      ok: true,
      detail: "kimi_cn/kimi-for-coding via kimi_code",
    });
  });

  it("reports Docker CLI absence for Docker-backed DAG readiness", () => {
    const checks = dockerReadiness(runnerFor([
      { status: null, error: Object.assign(new Error("spawn docker ENOENT"), { code: "ENOENT" }) },
    ]), "docker");

    expect(checks).toEqual([
      {
        name: "docker-cli",
        ok: false,
        detail: "command not found; install Docker Desktop, add docker.exe to PATH, or set HOMERAIL_DOCKER_BIN",
      },
      { name: "docker-daemon", ok: false, detail: "docker CLI unavailable" },
      { name: "worker-image", ok: false, detail: "docker CLI unavailable" },
    ]);
  });

  it("runs Docker checks through the resolved Docker binary", () => {
    const runner = runnerFor([
      { status: 0, stdout: "Docker version 27.0.0\n" },
      { status: 0, stdout: "linux\n" },
      { status: 0 },
    ]);

    dockerReadiness(runner, "C:\\Docker\\docker.exe");

    expect(runner).toHaveBeenNthCalledWith(
      1,
      "C:\\Docker\\docker.exe",
      ["--version"],
      { encoding: "utf-8" },
    );
    expect(runner).toHaveBeenNthCalledWith(
      2,
      "C:\\Docker\\docker.exe",
      ["version", "--format", "{{.Server.Os}}"],
      { encoding: "utf-8" },
    );
  });

  it("requires Docker Desktop Linux container mode", () => {
    const checks = dockerReadiness(runnerFor([
      { status: 0, stdout: "Docker version 27.0.0\n" },
      { status: 0, stdout: "windows\n" },
    ]), "docker");

    expect(checks).toContainEqual({
      name: "docker-daemon",
      ok: false,
      detail: "Docker daemon is windows; switch Docker Desktop to Linux containers",
    });
    expect(checks).toContainEqual({
      name: "worker-image",
      ok: false,
      detail: "Linux container daemon required",
    });
  });

  it("reports worker image presence when Docker is ready", () => {
    const checks = dockerReadiness(runnerFor([
      { status: 0, stdout: "Docker version 27.0.0\n" },
      { status: 0, stdout: "linux\n" },
      { status: 0 },
    ]), "docker");

    expect(checks).toEqual([
      { name: "docker-cli", ok: true, detail: "Docker version 27.0.0" },
      { name: "docker-daemon", ok: true, detail: "Linux containers" },
      { name: "worker-image", ok: true, detail: "homerail-worker:latest present" },
    ]);
  });
});
