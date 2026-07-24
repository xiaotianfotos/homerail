import { beforeEach, describe, expect, it } from "vitest";
import {
  _clearCodexThreadLeasesForTest,
  acquireCodexThreadLease,
  codexThreadLeaseOwner,
} from "../src/server/codex-thread-lease.js";

beforeEach(() => {
  _clearCodexThreadLeasesForTest();
});

describe("Codex thread leases", () => {
  it("allows one owner at a time and releases idempotently", () => {
    const liveLease = acquireCodexThreadLease(" session-1 ", "live:owner-1");

    expect(liveLease).not.toBeNull();
    expect(liveLease?.owner).toBe("live:owner-1");
    expect(codexThreadLeaseOwner("session-1")).toBe("live:owner-1");
    expect(acquireCodexThreadLease("session-1", "turn:owner-2")).toBeNull();

    liveLease?.release();
    liveLease?.release();
    expect(codexThreadLeaseOwner("session-1")).toBeUndefined();

    const turnLease = acquireCodexThreadLease("session-1", "turn:owner-2");
    expect(turnLease?.owner).toBe("turn:owner-2");
    turnLease?.release();
  });

  it("rejects an empty session id", () => {
    expect(() => acquireCodexThreadLease("   ", "live:owner")).toThrow(
      "Codex thread lease requires a session id",
    );
  });
});
