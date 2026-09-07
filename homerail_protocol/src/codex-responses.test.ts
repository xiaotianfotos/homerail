/** @version 0.1.0 */
import { describe, expect, it } from "vitest";
import {
  HOMERAIL_CODEX_API_KEY_ENV,
  HOMERAIL_CODEX_MODEL_PROVIDER_ID,
  codexResponsesAppServerArgs,
  codexResponsesProviderEnvironment,
  normalizeCodexResponsesBaseUrl,
} from "./codex-responses.js";

describe("Codex Responses provider contract", () => {
  it("builds process-local Codex provider overrides without embedding credentials", () => {
    const args = codexResponsesAppServerArgs({
      providerName: "DeepSeek",
      baseUrl: "https://api.deepseek.com/responses/",
      apiKey: "sk-secret-must-not-appear",
    });
    expect(args[0]).toBe("app-server");
    expect(args.join(" ")).toContain(`model_providers.${HOMERAIL_CODEX_MODEL_PROVIDER_ID}.wire_api="responses"`);
    expect(args.join(" ")).toContain("https://api.deepseek.com");
    expect(args.join(" ")).toContain("skills.bundled.enabled=false");
    expect(args.join(" ")).toContain("shell_environment_policy.exclude");
    expect(args.join(" ")).toContain("features.plugins=false");
    expect(args.join(" ")).toContain("features.apps=false");
    expect(args.join(" ")).toContain("features.multi_agent=false");
    expect(args.join(" ")).not.toContain("sk-secret-must-not-appear");
    expect(codexResponsesProviderEnvironment({
      baseUrl: "https://api.deepseek.com",
      apiKey: "sk-test",
    })).toEqual({ [HOMERAIL_CODEX_API_KEY_ENV]: "sk-test" });
  });

  it("injects an isolated provider model catalog when supplied", () => {
    const args = codexResponsesAppServerArgs({
      providerName: "DeepSeek",
      baseUrl: "https://api.deepseek.com",
      modelCatalogPath: "/tmp/codex-home/deepseek-v4-flash.json",
    });
    expect(args).toContain("model_catalog_json=\"/tmp/codex-home/deepseek-v4-flash.json\"");
  });

  it("normalizes full Responses URLs to the API root Codex expects", () => {
    expect(normalizeCodexResponsesBaseUrl("http://127.0.0.1:8000/v1/responses/"))
      .toBe("http://127.0.0.1:8000/v1");
  });
});
