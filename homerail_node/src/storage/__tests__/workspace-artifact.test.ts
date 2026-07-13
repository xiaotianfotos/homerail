import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { gunzipSync } from "node:zlib";
import { createWorkspaceArtifactArchive, type WorkspaceArtifactLimits } from "../workspace-artifact.js";

const LIMITS: WorkspaceArtifactLimits = {
  max_files: 100,
  max_uncompressed_bytes: 1024 * 1024,
  max_compressed_bytes: 1024 * 1024,
  timeout_ms: 10_000,
};

function tarEntries(compressed: Buffer): Array<{ name: string; type: string; content: Buffer }> {
  const tar = gunzipSync(compressed);
  const entries: Array<{ name: string; type: string; content: Buffer }> = [];
  let offset = 0;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const field = (start: number, length: number) => header.subarray(start, start + length).toString("utf8").replace(/\0.*$/, "");
    const prefix = field(345, 155);
    const leaf = field(0, 100);
    const name = prefix ? `${prefix}/${leaf}` : leaf;
    const size = Number.parseInt(field(124, 12).trim() || "0", 8);
    const type = String.fromCharCode(header[156]);
    const contentStart = offset + 512;
    entries.push({ name, type, content: tar.subarray(contentStart, contentStart + size) });
    offset = contentStart + Math.ceil(size / 512) * 512;
  }
  return entries;
}

describe("workspace artifact archive", () => {
  let home: string;
  let previousHome: string | undefined;

  beforeEach(() => {
    previousHome = process.env.HOMERAIL_HOME;
    home = fs.mkdtempSync(path.join(os.tmpdir(), "homerail-artifact-"));
    process.env.HOMERAIL_HOME = home;
    const evidence = path.join(home, "workspace", "run-1", "evidence");
    fs.mkdirSync(path.join(evidence, "nested"), { recursive: true });
    fs.writeFileSync(path.join(evidence, "a.json"), "{\"ok\":true}\n");
    fs.writeFileSync(path.join(evidence, "nested", "run.sh"), "#!/bin/sh\necho ok\n", { mode: 0o755 });
  });

  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
    if (previousHome === undefined) delete process.env.HOMERAIL_HOME;
    else process.env.HOMERAIL_HOME = previousHome;
  });

  it("creates byte-identical deterministic tar.gz archives with a stable directory root", async () => {
    const request = {
      workspace_id: "run-1",
      path: "evidence",
      archive: { format: "tar.gz" as const, deterministic: true },
      limits: LIMITS,
    };
    const first = await createWorkspaceArtifactArchive(request);
    fs.utimesSync(path.join(home, "workspace", "run-1", "evidence", "a.json"), new Date(), new Date());
    const second = await createWorkspaceArtifactArchive(request);

    const firstBytes = fs.readFileSync(first.path);
    const secondBytes = fs.readFileSync(second.path);
    expect(first.sha256).toBe(second.sha256);
    expect(firstBytes.equals(secondBytes)).toBe(true);
    expect(first.file_count).toBe(2);
    expect(tarEntries(firstBytes).map((entry) => [entry.name, entry.type])).toEqual([
      ["evidence/", "5"],
      ["evidence/a.json", "0"],
      ["evidence/nested/", "5"],
      ["evidence/nested/run.sh", "0"],
    ]);
    expect(tarEntries(firstBytes).find((entry) => entry.name === "evidence/a.json")?.content.toString()).toBe("{\"ok\":true}\n");
  });

  it("rejects traversal, symbolic links, and configured archive limits", async () => {
    await expect(createWorkspaceArtifactArchive({
      workspace_id: "run-1",
      path: "../evidence",
      archive: { format: "tar.gz", deterministic: true },
      limits: LIMITS,
    })).rejects.toThrow("unsafe path segment");

    fs.symlinkSync("a.json", path.join(home, "workspace", "run-1", "evidence", "link.json"));
    await expect(createWorkspaceArtifactArchive({
      workspace_id: "run-1",
      path: "evidence",
      archive: { format: "tar.gz", deterministic: true },
      limits: LIMITS,
    })).rejects.toThrow("symbolic links are not allowed");
    fs.rmSync(path.join(home, "workspace", "run-1", "evidence", "link.json"));

    await expect(createWorkspaceArtifactArchive({
      workspace_id: "run-1",
      path: "evidence",
      archive: { format: "tar.gz", deterministic: true },
      limits: { ...LIMITS, max_uncompressed_bytes: 1 },
    })).rejects.toThrow("max_uncompressed_bytes");
  });
});
