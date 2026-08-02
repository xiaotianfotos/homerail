import { defineConfig } from "vitest/config";

function timeoutFromEnv(name: string): number | undefined {
  const value = process.env[name];
  if (value === undefined) return undefined;

  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    testTimeout: timeoutFromEnv("VITEST_TEST_TIMEOUT"),
    hookTimeout: timeoutFromEnv("VITEST_HOOK_TIMEOUT"),
  },
});
