/** @version 0.1.0 */
import { describe, expect, it } from "vitest";
import {
  buildCodexProviderModelCatalogFromBundled,
  codexResponsesModelSupport,
  resolveCodexProviderModelProfile,
  selectCodexBundledBaseInstructions,
} from "./codex-provider-profiles.js";

describe("Codex Responses provider profiles", () => {
  const bundled = JSON.stringify({
    models: [{ slug: "current-codex", base_instructions: "You are the current native Codex contract." }],
  });

  it("gates known providers by model while preserving custom-provider fallback", () => {
    expect(codexResponsesModelSupport("deepseek", "deepseek-v4-flash")).toBe("supported");
    expect(codexResponsesModelSupport("deepseek", "deepseek-v4-pro")).toBe("unsupported");
    expect(codexResponsesModelSupport("deepseek", "legacy-model")).toBe("unsupported");
    expect(codexResponsesModelSupport("local-responses", "custom-model")).toBe("fallback");
  });

  it("advertises every live-verified DeepSeek reasoning effort", () => {
    expect(resolveCodexProviderModelProfile("deepseek", "deepseek-v4-flash")?.supported_reasoning_efforts)
      .toEqual(["none", "low", "high", "max"]);
  });

  it("builds provider metadata around the installed native Codex prompt", () => {
    const catalog = buildCodexProviderModelCatalogFromBundled(
      "deepseek",
      "deepseek-v4-flash",
      bundled,
    );
    expect(catalog?.models[0]).toMatchObject({
      slug: "deepseek-v4-flash",
      base_instructions: "You are the current native Codex contract.",
      context_window: 1_048_576,
      default_reasoning_level: "high",
      include_skills_usage_instructions: false,
    });
  });

  it("does not inject provider metadata for an unregistered local Responses provider", () => {
    expect(buildCodexProviderModelCatalogFromBundled("local-responses", "local-coder", bundled))
      .toBeUndefined();
  });

  it("rejects malformed bundled catalogs", () => {
    expect(() => selectCodexBundledBaseInstructions("{}"))
      .toThrow("does not contain models");
  });
});
