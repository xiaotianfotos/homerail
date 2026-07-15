import { defineConfig } from "vitest/config";

function timeoutFromEnv(name: string): number | undefined {
  const value = process.env[name];
  if (value === undefined) return undefined;

  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    exclude: ["node_modules/**", "dist/**"],
    setupFiles: ["./tests/setup.ts"],
    testTimeout: timeoutFromEnv("VITEST_TEST_TIMEOUT"),
    hookTimeout: timeoutFromEnv("VITEST_HOOK_TIMEOUT"),
  },
});
