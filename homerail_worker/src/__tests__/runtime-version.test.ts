import { readFileSync } from "node:fs";
import { PROTOCOL_VERSION } from "homerail-protocol";
import { describe, expect, it } from "vitest";
import {
  WORKER_RUNTIME_VERSION,
  readWorkerRuntimeVersion,
  resolveWorkerRuntimeIdentity,
} from "../runtime-version.js";

const packageMetadata = JSON.parse(
  readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
) as { version: string };

describe("Worker runtime version identity", () => {
  it("reads the package version from both source and compiled module layouts", () => {
    expect(readWorkerRuntimeVersion(new URL("../runtime-version.ts", import.meta.url)))
      .toBe(packageMetadata.version);
    expect(readWorkerRuntimeVersion(new URL("../../dist/runtime-version.js", import.meta.url)))
      .toBe(packageMetadata.version);
    expect(WORKER_RUNTIME_VERSION).toBe(packageMetadata.version);
  });

  it("falls back to package and protocol metadata for an ordinary Docker build", () => {
    expect(resolveWorkerRuntimeIdentity({})).toEqual({
      worker_version: packageMetadata.version,
      protocol_version: PROTOCOL_VERSION,
      source_fingerprint: undefined,
      image_revision: undefined,
    });
    expect(resolveWorkerRuntimeIdentity({
      HOMERAIL_WORKER_VERSION: "  ",
      HOMERAIL_WORKER_PROTOCOL_VERSION: "",
    })).toMatchObject({
      worker_version: packageMetadata.version,
      protocol_version: PROTOCOL_VERSION,
    });
  });

  it("prefers explicit Manager build arguments and trims their runtime values", () => {
    expect(resolveWorkerRuntimeIdentity({
      HOMERAIL_WORKER_VERSION: " 9.8.7-test.1 ",
      HOMERAIL_WORKER_PROTOCOL_VERSION: " 7.6.5 ",
      HOMERAIL_WORKER_SOURCE_FINGERPRINT: " sha256:test ",
      HOMERAIL_WORKER_IMAGE_REVISION: " revision-test ",
    })).toEqual({
      worker_version: "9.8.7-test.1",
      protocol_version: "7.6.5",
      source_fingerprint: "sha256:test",
      image_revision: "revision-test",
    });
  });

  it("keeps Docker version arguments optional and passes them into the runtime environment", () => {
    const dockerfile = readFileSync(new URL("../../Dockerfile", import.meta.url), "utf8")
      .replace(/\r\n/g, "\n");
    expect(dockerfile).toContain("ARG HOMERAIL_WORKER_VERSION\n");
    expect(dockerfile).toContain("ARG HOMERAIL_WORKER_PROTOCOL_VERSION\n");
    expect(dockerfile).not.toMatch(/ARG HOMERAIL_WORKER_(?:PROTOCOL_)?VERSION=/);
    expect(dockerfile).toContain('HOMERAIL_WORKER_VERSION="${HOMERAIL_WORKER_VERSION}"');
    expect(dockerfile).toContain('HOMERAIL_WORKER_PROTOCOL_VERSION="${HOMERAIL_WORKER_PROTOCOL_VERSION}"');
  });

  it("uses the package-derived version in every Worker agent identity", () => {
    const expectedOccurrences = new Map([
      ["../agent/claude-sdk.ts", 1],
      ["../agent/codex-appserver.ts", 1],
      ["../agent/kimi-code.ts", 3],
    ]);
    for (const [relativePath, expectedCount] of expectedOccurrences) {
      const source = readFileSync(new URL(relativePath, import.meta.url), "utf8");
      expect(source.match(/version:\s*(?:WORKER_RUNTIME_VERSION|\$\{JSON\.stringify\(WORKER_RUNTIME_VERSION\)\})/g))
        .toHaveLength(expectedCount);
    }
  });
});
