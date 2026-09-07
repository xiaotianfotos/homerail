import { describe, expect, it } from "vitest";
import {
  appendWorkspaceRunIds,
  shouldSyncLiveVoiceRunIds,
} from "../src/server/voice-agent-bootstrap.js";

/**
 * Regression coverage for issue #168 (reconnect clears the canvas owner).
 *
 * `flush_tool_state` writes the in-memory `createdRunIds` back to the persisted
 * workspace via `syncWorkspaceRunIds`. A fresh binding starts with whatever was
 * hydrated, but if a flush ever runs with an empty list (e.g. a reconnect before
 * any Manager tool has run), it would set `manager_run_id = null` and yank the
 * canvas to the canonical view. `shouldSyncLiveVoiceRunIds` encodes the guard:
 * an empty list must never overwrite an existing pointer.
 */
describe("shouldSyncLiveVoiceRunIds (issue #168 reconnect guard)", () => {
  it("refuses to sync an empty list (the reconnect-wipe guard)", () => {
    expect(shouldSyncLiveVoiceRunIds([])).toBe(false);
  });

  it("syncs a non-empty list", () => {
    expect(shouldSyncLiveVoiceRunIds(["run-1"])).toBe(true);
    expect(shouldSyncLiveVoiceRunIds(["run-1", "run-2"])).toBe(true);
  });

  it("treats a freshly-hydrated list as syncable", () => {
    // After hydration, createdRunIds mirrors the persisted workspace run ids;
    // a subsequent flush should still be allowed to write them.
    expect(shouldSyncLiveVoiceRunIds(["hydrated-run-1", "hydrated-run-2"])).toBe(true);
  });
});

/**
 * Regression coverage for the pass-3 review finding: a stale createdRunIds
 * snapshot must NOT overwrite a newer canvas owner. `appendWorkspaceRunIds`
 * merges this binding's newly-created runs onto the LATEST persisted history
 * instead of replacing it, so an external owner change is preserved.
 */
describe("appendWorkspaceRunIds (issue #168 merge-not-overwrite)", () => {
  // Minimal workspace shape — appendWorkspaceRunIds only reads these two fields.
  const ws = (manager_run_ids: string[], manager_run_id: string | null) =>
    ({ session_id: "s", manager_run_ids, manager_run_id }) as never;

  it("appends this binding's new runs after the latest persisted history", () => {
    // Persisted owner advanced to run-B externally; this binding created run-C.
    const merged = appendWorkspaceRunIds(ws(["run-A"], "run-B"), ["run-C"]);
    expect(merged).toEqual(["run-A", "run-B", "run-C"]);
    // syncWorkspaceRunIds sets manager_run_id = merged.at(-1), so the active
    // pointer advances to run-C (the genuinely-newer run) while run-B stays in
    // history instead of being reverted.
    expect(merged.at(-1)).toBe("run-C");
  });

  it("preserves an external owner change when this binding created nothing new", () => {
    // Empty newRunIds would be skipped by shouldSyncLiveVoiceRunIds anyway, but
    // the helper still must not drop the persisted history.
    const merged = appendWorkspaceRunIds(ws(["run-A"], "run-B"), []);
    expect(merged).toEqual(["run-A", "run-B"]);
    expect(merged.at(-1)).toBe("run-B");
  });

  it("does not reactivate a terminal run from history when only history exists", () => {
    // Only historical (terminal) IDs persisted, no new runs this binding.
    const merged = appendWorkspaceRunIds(ws(["run-old-1", "run-old-2"], null), []);
    expect(merged.at(-1)).toBe("run-old-2");
    // The active pointer stays on the latest history entry; no new run is
    // fabricated and nothing older is promoted over it.
    expect(merged).toHaveLength(2);
  });

  it("de-duplicates while preserving order", () => {
    const merged = appendWorkspaceRunIds(ws(["run-A", "run-B"], "run-B"), ["run-B", "run-C"]);
    expect(merged).toEqual(["run-A", "run-B", "run-C"]);
  });

  it("trims and filters blank/empty entries", () => {
    const merged = appendWorkspaceRunIds(ws(["run-A", "  "], "run-A"), ["", "run-C"]);
    expect(merged).toEqual(["run-A", "run-C"]);
  });
});
