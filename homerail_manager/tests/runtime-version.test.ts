import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { versionHandler } from "../src/health/index.js";
import {
  MANAGER_RUNTIME_VERSION,
  readManagerRuntimeVersion,
} from "../src/runtime-version.js";

const packageMetadata = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as { version: string };

describe("Manager runtime version identity", () => {
  it("reads the package version from both source and compiled module layouts", () => {
    expect(readManagerRuntimeVersion(new URL("../src/runtime-version.ts", import.meta.url)))
      .toBe(packageMetadata.version);
    expect(readManagerRuntimeVersion(new URL("../dist/runtime-version.js", import.meta.url)))
      .toBe(packageMetadata.version);
    expect(MANAGER_RUNTIME_VERSION).toBe(packageMetadata.version);
  });

  it("reports the package version from /version", () => {
    expect(versionHandler()).toMatchObject({
      version: packageMetadata.version,
      runtime: "typescript",
    });
  });

  it("uses the package-derived version in every Manager Codex client identity", () => {
    for (const relativePath of [
      "../src/server/codex-appserver-client.ts",
      "../src/server/codex-models.ts",
      "../src/server/host-codex-manager-agent.ts",
    ]) {
      const source = readFileSync(new URL(relativePath, import.meta.url), "utf8");
      expect(source).toMatch(/clientInfo:\s*\{[\s\S]{0,180}version:\s*MANAGER_RUNTIME_VERSION/);
    }
  });
});
