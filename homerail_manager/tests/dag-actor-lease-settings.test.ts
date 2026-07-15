import { afterEach, describe, expect, it } from "vitest";

import {
  DEFAULT_DAG_ACTOR_RETENTION_TTL_MS,
  DEFAULT_DAG_WORKER_IDLE_TTL_MS,
  loadDagActorLeaseSettings,
  MAX_DAG_ACTOR_RETENTION_TTL_MS,
  MAX_DAG_WORKER_IDLE_TTL_MS,
  validateDagActorRetentionTtlMs,
  validateDagWorkerIdleTtlMs,
} from "../src/config/dag-actor-lease-settings.js";

const ENV_NAMES = [
  "HOMERAIL_DAG_WORKER_IDLE_TTL_MS",
  "HOMERAIL_DAG_ACTOR_RETENTION_TTL_MS",
] as const;
const inherited = Object.fromEntries(ENV_NAMES.map((name) => [name, process.env[name]]));

afterEach(() => {
  for (const name of ENV_NAMES) {
    const value = inherited[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

describe("DAG actor lease settings", () => {
  it("uses the five-minute idle and seven-day retention defaults", () => {
    expect(loadDagActorLeaseSettings({})).toEqual({
      worker_idle_ttl_ms: DEFAULT_DAG_WORKER_IDLE_TTL_MS,
      actor_retention_ttl_ms: DEFAULT_DAG_ACTOR_RETENTION_TTL_MS,
    });
    expect(DEFAULT_DAG_WORKER_IDLE_TTL_MS).toBe(5 * 60_000);
    expect(DEFAULT_DAG_ACTOR_RETENTION_TTL_MS).toBe(7 * 24 * 60 * 60_000);
  });

  it("accepts bounded base-10 environment overrides", () => {
    expect(loadDagActorLeaseSettings({
      HOMERAIL_DAG_WORKER_IDLE_TTL_MS: "1500",
      HOMERAIL_DAG_ACTOR_RETENTION_TTL_MS: "900000",
    })).toEqual({
      worker_idle_ttl_ms: 1_500,
      actor_retention_ttl_ms: 900_000,
    });
    expect(validateDagWorkerIdleTtlMs(MAX_DAG_WORKER_IDLE_TTL_MS))
      .toBe(MAX_DAG_WORKER_IDLE_TTL_MS);
    expect(validateDagActorRetentionTtlMs(MAX_DAG_ACTOR_RETENTION_TTL_MS))
      .toBe(MAX_DAG_ACTOR_RETENTION_TTL_MS);
  });

  it.each(["", "0", "-1", "1.5", "1e3", "Infinity", "NaN"])(
    "rejects an unsafe idle override %j",
    (value) => {
      expect(() => loadDagActorLeaseSettings({
        HOMERAIL_DAG_WORKER_IDLE_TTL_MS: value,
      })).toThrow(/HOMERAIL_DAG_WORKER_IDLE_TTL_MS/);
    },
  );

  it("rejects non-finite, fractional, and out-of-range TTL values", () => {
    expect(() => validateDagWorkerIdleTtlMs(Number.POSITIVE_INFINITY)).toThrow(/safe integer/);
    expect(() => validateDagWorkerIdleTtlMs(1.5)).toThrow(/safe integer/);
    expect(() => validateDagWorkerIdleTtlMs(MAX_DAG_WORKER_IDLE_TTL_MS + 1)).toThrow(/safe integer/);
    expect(() => validateDagActorRetentionTtlMs(MAX_DAG_ACTOR_RETENTION_TTL_MS + 1))
      .toThrow(/safe integer/);
  });
});
