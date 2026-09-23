import { describe, expect, it } from "vitest";
import { assertNativeCodexSubscriptionSelection } from "../src/codex-subscription.js";

describe("native subscription selection", () => {
  it("keeps model and reasoning identifiers unchanged", () => {
    const selection = { provider: "codex", model: "gpt-exact-1", reasoning_effort: "low" };
    assertNativeCodexSubscriptionSelection(selection);
    expect(selection).toEqual({ provider: "codex", model: "gpt-exact-1", reasoning_effort: "low" });
  });
  it.each([
    undefined, {}, { provider: "openai", model: "exact", reasoning_effort: "low" },
    { provider: "codex", model: "exact" },
    { provider: "codex", model: " exact ", reasoning_effort: "low" },
    { provider: "codex", model: "exact", reasoning_effort: "low", api_key: "forbidden" },
  ])("rejects implicit or mixed execution selection: %j", (selection) => {
    expect(() => assertNativeCodexSubscriptionSelection(selection)).toThrow();
  });
});
