import { describe, expect, it } from "vitest";

import {
  GENERATIVE_UI_MODE_ENV,
  GenerativeUiModeValidationError,
  parseGenerativeUiMode,
  resolveConfiguredGenerativeUiMode,
  resolveConfiguredGenerativeUiModeDetails,
  resolveSessionGenerativeUiMode,
} from "../src/generative-ui/mode.js";

describe("Generative UI mode parser", () => {
  it("defaults missing and blank values to off", () => {
    expect(parseGenerativeUiMode(undefined)).toBe("off");
    expect(parseGenerativeUiMode(null)).toBe("off");
    expect(parseGenerativeUiMode("  ")).toBe("off");
  });

  it("accepts normalized off, shadow, and prefer while keeping strict reserved", () => {
    expect(parseGenerativeUiMode(" OFF ")).toBe("off");
    expect(parseGenerativeUiMode(" Shadow ")).toBe("shadow");
    expect(parseGenerativeUiMode(" Prefer ")).toBe("prefer");
    expect(() => parseGenerativeUiMode("strict")).toThrow(GenerativeUiModeValidationError);
    expect(() => parseGenerativeUiMode("strict")).toThrow(/reserved and is not available/);
    expect(() => parseGenerativeUiMode("enabled")).toThrow(/must be one of: off, shadow, prefer/);
    expect(() => parseGenerativeUiMode(true)).toThrow(/must be one of: off, shadow, prefer/);
  });

  it("lets a non-empty environment value override persisted configuration", () => {
    expect(resolveConfiguredGenerativeUiMode("shadow", undefined)).toBe("shadow");
    expect(resolveConfiguredGenerativeUiMode("shadow", "")).toBe("shadow");
    expect(resolveConfiguredGenerativeUiMode("shadow", "off")).toBe("off");
    expect(resolveConfiguredGenerativeUiMode("off", "shadow")).toBe("shadow");
    expect(resolveConfiguredGenerativeUiMode("off", "prefer")).toBe("prefer");
    expect(() => resolveConfiguredGenerativeUiMode("off", "strict")).toThrow(
      new RegExp(GENERATIVE_UI_MODE_ENV),
    );
    expect(resolveConfiguredGenerativeUiModeDetails("off", "shadow")).toEqual({
      configured_mode: "off",
      effective_mode: "shadow",
      source: "environment",
    });
  });

  it("keeps sessions pinned while allowing a global off kill switch", () => {
    expect(resolveSessionGenerativeUiMode("shadow", "shadow")).toBe("shadow");
    expect(resolveSessionGenerativeUiMode("shadow", "off")).toBe("off");
    expect(resolveSessionGenerativeUiMode("off", "shadow")).toBe("off");
    expect(resolveSessionGenerativeUiMode(undefined, "shadow")).toBe("off");
    expect(resolveSessionGenerativeUiMode("prefer", "prefer")).toBe("prefer");
    expect(resolveSessionGenerativeUiMode("prefer", "off")).toBe("off");
  });
});
