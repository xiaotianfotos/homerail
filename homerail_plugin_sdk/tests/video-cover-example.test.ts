import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  buildHrpArchive,
  scanPluginSource,
  sourceFilesForPack,
  verifyPluginArchive,
} from "../src/index.js";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../plugins/examples/video-cover",
);

describe("video-cover executable Plugin example", () => {
  it("validates and reproducibly packages the complete sandboxed Runtime slice", () => {
    const snapshot = scanPluginSource(root);
    expect(snapshot.valid).toBe(true);
    expect(snapshot.issues.filter((issue) => issue.severity === "error")).toEqual([]);
    expect(snapshot.manifest).toMatchObject({
      id: "com.homerail.video-cover",
      runtime: {
        trust: "sandboxed_runtime",
        entrypoint: { file: "runtime/fake-gpu-runtime.mjs", args: ["--stdio"] },
      },
      permissions: {
        required: [{ permission: "artifact.write" }, { permission: "gpu.use" }],
      },
    });
    expect(snapshot.files.has("runtime/fake-gpu-runtime.mjs")).toBe(true);
    expect(fs.existsSync(path.join(root, "skills/generate-video-cover/SKILL.md"))).toBe(true);
    expect(fs.existsSync(path.join(root, "fixtures/runtime-descriptor.json"))).toBe(true);

    const first = buildHrpArchive(sourceFilesForPack(snapshot));
    const second = buildHrpArchive(sourceFilesForPack(scanPluginSource(root)));
    expect(first.archive.equals(second.archive)).toBe(true);
    expect(verifyPluginArchive(first.archive).snapshot).toMatchObject({
      valid: true,
      manifest: { id: "com.homerail.video-cover", version: "1.0.0" },
    });
  });
});
