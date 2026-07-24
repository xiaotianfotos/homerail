import type { SpawnSyncReturns } from "node:child_process";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  _clearCodexLiveVoiceCapabilityCacheForTest,
  inspectCodexInstallation,
} from "../src/server/codex-live-voice-capability.js";

function result(status: number, stdout = "", stderr = ""): SpawnSyncReturns<string> {
  return {
    pid: 1,
    output: [null, stdout, stderr],
    stdout,
    stderr,
    status,
    signal: null,
  };
}

function inspect(version: string, features: string) {
  const runCommand = vi.fn((_command: string, args: string[]) => (
    args[0] === "--version" ? result(0, `${version}\n`) : result(0, features)
  ));
  const installation = inspectCodexInstallation({
    requested: "/test/codex",
    resolveBinary: () => ({
      command: "/test/codex",
      requested: "/test/codex",
      needsShell: false,
    }),
    runCommand,
    statMtimeMs: () => 42,
  });
  return { installation, runCommand };
}

beforeEach(() => {
  _clearCodexLiveVoiceCapabilityCacheForTest();
});

describe("inspectCodexInstallation", () => {
  it("reports a missing binary without probing features", () => {
    const installation = inspectCodexInstallation({
      requested: "codex",
      resolveBinary: () => null,
    });

    expect(installation).toMatchObject({
      available: false,
      binary: "codex",
      live_voice: {
        supported: false,
        minimum_version: "0.145.0",
        reason: "missing",
      },
    });
  });

  it("rejects an unparseable version", () => {
    const { installation, runCommand } = inspect(
      "custom-codex development",
      "realtime_conversation under development false\n",
    );

    expect(installation.live_voice).toMatchObject({
      supported: false,
      reason: "unparseable",
    });
    expect(runCommand).toHaveBeenCalledTimes(1);
  });

  it("rejects Codex versions before 0.145.0", () => {
    const { installation, runCommand } = inspect(
      "codex-cli 0.144.9",
      "realtime_conversation under development false\n",
    );

    expect(installation).toMatchObject({
      available: true,
      semantic_version: "0.144.9",
      live_voice: {
        supported: false,
        reason: "too_old",
      },
    });
    expect(runCommand).toHaveBeenCalledTimes(1);
  });

  it("treats a 0.145.0 prerelease as older than the stable minimum", () => {
    const { installation, runCommand } = inspect(
      "codex-cli 0.145.0-beta.1",
      "realtime_conversation under development false\n",
    );

    expect(installation).toMatchObject({
      semantic_version: "0.145.0-beta.1",
      live_voice: {
        supported: false,
        reason: "too_old",
      },
    });
    expect(runCommand).toHaveBeenCalledTimes(1);
  });

  it("accepts 0.145.0 when the experimental feature is present but disabled", () => {
    const { installation } = inspect(
      "codex-cli 0.145.0",
      "realtime_conversation under development false\nremote_control removed false\n",
    );

    expect(installation).toMatchObject({
      semantic_version: "0.145.0",
      live_voice: {
        supported: true,
        protocol: "v3",
        transport: "webrtc",
        feature: "realtime_conversation",
        voices: ["juniper", "maple", "spruce", "ember", "vale", "breeze", "arbor", "sol", "cove"],
        default_voice: "cove",
        stage: "under development",
      },
    });
  });

  it("rejects a missing or removed feature on a newer version", () => {
    const { installation } = inspect(
      "codex-cli 0.200.1",
      "realtime_conversation removed false\n",
    );

    expect(installation.live_voice).toMatchObject({
      supported: false,
      stage: "removed",
      reason: "feature_missing",
    });
  });

  it("caches the feature probe for the same binary build", () => {
    const first = inspect(
      "codex-cli 0.145.0",
      "realtime_conversation under development false\n",
    );
    const second = inspect(
      "codex-cli 0.145.0",
      "realtime_conversation under development false\n",
    );

    expect(first.runCommand).toHaveBeenCalledTimes(2);
    expect(second.runCommand).toHaveBeenCalledTimes(1);
    expect(second.installation.live_voice.supported).toBe(true);
  });
});
