import { describe, expect, it } from "vitest";
import { isPluginToolEnvelopeFailure } from "../src/server/host-codex-manager-agent.js";

/**
 * Regression coverage for issue #168 (false canvas-update success).
 *
 * The Manager wraps plugin-tool outcomes as `{ success, data: { status,
 * error_code } }`. The host adapter only honors `result.is_error`, so a nested
 * `data.status = "failed"` must be translated into `is_error: true` — otherwise
 * the model falsely claims a generated UI update succeeded (the exact envelope
 * reported in the issue is asserted first).
 *
 * `invokePluginTool` routes every plugin/Generative-UI tool result through the
 * `pluginToolResult` helper, which derives `is_error` from
 * `isPluginToolEnvelopeFailure`. Locking the classification here is what
 * prevents the false-success regression.
 */
describe("isPluginToolEnvelopeFailure (issue #168 false-success)", () => {
  it("flags the exact envelope reported in the issue", () => {
    expect(
      isPluginToolEnvelopeFailure({
        success: true,
        data: { status: "failed", error_code: "invalid_output" },
      }),
    ).toBe(true);
  });

  it("flags every non-committed terminal status", () => {
    for (const status of ["failed", "denied", "cancelled"]) {
      expect(isPluginToolEnvelopeFailure({ success: true, data: { status } })).toBe(true);
    }
  });

  it("flags top-level success:false", () => {
    expect(isPluginToolEnvelopeFailure({ success: false })).toBe(true);
    expect(isPluginToolEnvelopeFailure({ success: false, data: { status: "running" } })).toBe(true);
  });

  it("flags a nested error_code when the status is neither committed nor running", () => {
    // An error_code with an absent/unknown (non-success) status is a failure.
    expect(
      isPluginToolEnvelopeFailure({ success: true, data: { error_code: "tool_failed" } }),
    ).toBe(true);
    expect(
      isPluginToolEnvelopeFailure({ success: true, data: { status: "awaiting_confirmation", error_code: "x" } }),
    ).toBe(true);
  });

  it("does NOT flag a nested error_code on an explicit committed/running status", () => {
    // Scope guard: an informational error_code accompanying a successful or
    // in-flight outcome must never be misclassified as a failure.
    expect(
      isPluginToolEnvelopeFailure({ success: true, data: { status: "committed", error_code: "info" } }),
    ).toBe(false);
    expect(
      isPluginToolEnvelopeFailure({ success: true, data: { status: "running", error_code: "info" } }),
    ).toBe(false);
  });

  it("does NOT flag a local projection envelope (non-terminal, parity with worker)", () => {
    // A local projection `{ status: "projected", committed: false }` is a
    // legitimate "projected but not yet committed" state produced identically by
    // the voice host and the non-voice worker. Treating it as an error would
    // break result-envelope parity (manager-agent-tool-parity). The #168
    // false-success bug is about the runtime invoke path returning
    // `data.status = "failed"`, which IS caught above.
    expect(isPluginToolEnvelopeFailure({ status: "projected", committed: false })).toBe(false);
  });

  it("does NOT flag a projected envelope even if a future error_code is attached", () => {
    // Defensive: the projected invariant must hold structurally, not rely on the
    // runtime never attaching error_code to a projection.
    expect(isPluginToolEnvelopeFailure({ status: "projected", committed: false, error_code: "x" })).toBe(false);
    expect(isPluginToolEnvelopeFailure({ success: true, data: { status: "projected", error_code: "x" } })).toBe(false);
  });

  it("does not flag a committed outcome", () => {
    expect(isPluginToolEnvelopeFailure({ success: true, data: { status: "committed" } })).toBe(false);
  });

  it("does not flag a still-running outcome", () => {
    expect(isPluginToolEnvelopeFailure({ success: true, data: { status: "running" } })).toBe(false);
  });

  it("tolerates non-object bodies", () => {
    expect(isPluginToolEnvelopeFailure(null)).toBe(false);
    expect(isPluginToolEnvelopeFailure("ok")).toBe(false);
    expect(isPluginToolEnvelopeFailure([1, 2, 3])).toBe(false);
    expect(isPluginToolEnvelopeFailure(undefined)).toBe(false);
  });
});
