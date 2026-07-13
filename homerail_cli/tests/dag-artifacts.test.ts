import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import type { AddressInfo } from "node:net";
import { HomeRailClient } from "../src/client.js";
import { cmdDagArtifact, cmdDagArtifacts, type RunArtifact } from "../src/commands/dag-artifacts.js";

describe("DAG artifact commands", () => {
  let temp: string;
  let server: http.Server;
  let baseUrl: string;
  const bytes = Buffer.from("compressed-directory-bytes");
  let artifact: RunArtifact;

  beforeEach(async () => {
    temp = fs.mkdtempSync(path.join(os.tmpdir(), "homerail-cli-artifact-"));
    artifact = {
      artifact_id: "artifact-1",
      run_id: "run-1",
      name: "evidence.tar.gz",
      status: "ready",
      media_type: "application/gzip",
      required: false,
      publish: "always",
      source: { type: "workspace", path: "evidence", produced_by: "investigate" },
      size_bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
    server = http.createServer((req, res) => {
      if (req.url === "/api/runs/run-1/artifacts") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ data: { run_id: "run-1", artifacts: [artifact], total: 1 } }));
        return;
      }
      if (req.url === "/api/runs/run-1/artifacts/evidence.tar.gz/content") {
        res.writeHead(200, { "Content-Type": "application/gzip", "Content-Length": bytes.length });
        res.end(bytes);
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(temp, { recursive: true, force: true });
  });

  it("lists artifact metadata as generic JSON", async () => {
    const output = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const result = await cmdDagArtifacts(new HomeRailClient({ baseUrl }), "run-1", true);

    expect(result).toBe(0);
    expect(JSON.parse(String(output.mock.calls[0]?.[0]))).toEqual([artifact]);
  });

  it("downloads a binary artifact atomically and verifies size and SHA-256", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const output = path.join(temp, "downloads", "evidence.tar.gz");

    const result = await cmdDagArtifact(
      new HomeRailClient({ baseUrl }),
      "run-1",
      "evidence.tar.gz",
      { output },
      false,
    );

    expect(result).toBe(0);
    expect(fs.readFileSync(output).equals(bytes)).toBe(true);
    expect(fs.readdirSync(path.dirname(output))).toEqual(["evidence.tar.gz"]);
  });

  it("does not publish a corrupt or unexpectedly overwriting download", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const output = path.join(temp, "evidence.tar.gz");
    artifact = { ...artifact, sha256: "0".repeat(64) };
    expect(await cmdDagArtifact(new HomeRailClient({ baseUrl }), "run-1", artifact.name, { output }, false)).toBe(1);
    expect(fs.existsSync(output)).toBe(false);
    expect(String(errors.mock.calls.at(-1)?.[0])).toContain("SHA-256 mismatch");

    artifact = { ...artifact, sha256: createHash("sha256").update(bytes).digest("hex") };
    fs.writeFileSync(output, "keep");
    expect(await cmdDagArtifact(new HomeRailClient({ baseUrl }), "run-1", artifact.name, { output }, false)).toBe(1);
    expect(fs.readFileSync(output, "utf8")).toBe("keep");
    expect(String(errors.mock.calls.at(-1)?.[0])).toContain("use --force");

    vi.spyOn(console, "log").mockImplementation(() => undefined);
    expect(await cmdDagArtifact(new HomeRailClient({ baseUrl }), "run-1", artifact.name, { output, force: true }, false)).toBe(0);
    expect(fs.readFileSync(output).equals(bytes)).toBe(true);
  });
});
