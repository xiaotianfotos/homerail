import { afterEach, describe, expect, it } from "vitest";

type WorkerVitestConfigModule = {
  default: {
    test?: { testTimeout?: number; hookTimeout?: number };
  };
  timeoutFromEnv: (name: string) => number | undefined;
};

async function loadWorkerVitestConfig(): Promise<WorkerVitestConfigModule> {
  return import(new URL("../../vitest.config.js", import.meta.url).href) as Promise<WorkerVitestConfigModule>;
}

const originalTestTimeout = process.env.VITEST_TEST_TIMEOUT;
const originalHookTimeout = process.env.VITEST_HOOK_TIMEOUT;

afterEach(() => {
  if (originalTestTimeout === undefined) delete process.env.VITEST_TEST_TIMEOUT;
  else process.env.VITEST_TEST_TIMEOUT = originalTestTimeout;
  if (originalHookTimeout === undefined) delete process.env.VITEST_HOOK_TIMEOUT;
  else process.env.VITEST_HOOK_TIMEOUT = originalHookTimeout;
});

describe("Worker Vitest timeout configuration", () => {
  it("binds the CI timeout environment variables into the default config", async () => {
    const { default: config, timeoutFromEnv } = await loadWorkerVitestConfig();
    expect(config.test?.testTimeout).toBe(timeoutFromEnv("VITEST_TEST_TIMEOUT"));
    expect(config.test?.hookTimeout).toBe(timeoutFromEnv("VITEST_HOOK_TIMEOUT"));
  });

  it("accepts only positive safe integer timeout values", async () => {
    const { timeoutFromEnv } = await loadWorkerVitestConfig();
    process.env.VITEST_TEST_TIMEOUT = "15000";
    expect(timeoutFromEnv("VITEST_TEST_TIMEOUT")).toBe(15_000);

    for (const invalid of ["", "0", "-1", "1.5", "not-a-number", String(Number.MAX_SAFE_INTEGER + 1)]) {
      process.env.VITEST_TEST_TIMEOUT = invalid;
      expect(timeoutFromEnv("VITEST_TEST_TIMEOUT")).toBeUndefined();
    }
  });
});
