import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import type { AddressInfo } from "node:net";
import { gunzipSync } from "node:zlib";
import { createWorkspaceArtifactUploader } from "../workspace-artifact-uploader.js";

describe("workspace artifact uploader", () => {
  let home: string;
  let previousHome: string | undefined;
  let server: http.Server;

  beforeEach(() => {
    previousHome = process.env.HOMERAIL_HOME;
    home = fs.mkdtempSync(path.join(os.tmpdir(), "homerail-artifact-upload-"));
    process.env.HOMERAIL_HOME = home;
    const evidence = path.join(home, "workspace", "run-1", "evidence");
    fs.mkdirSync(evidence, { recursive: true });
    fs.writeFileSync(path.join(evidence, "result.json"), "{\"ok\":true}\n");
  });

  afterEach(async () => {
    if (server?.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(home, { recursive: true, force: true });
    if (previousHome === undefined) delete process.env.HOMERAIL_HOME;
    else process.env.HOMERAIL_HOME = previousHome;
  });

  it("streams a packaged directory to the scoped Manager URL and removes staging bytes", async () => {
    let received = Buffer.alloc(0);
    server = http.createServer(async (req, res) => {
      expect(req.method).toBe("PUT");
      expect(req.url).toBe("/api/runs/run-1/artifacts/evidence.tar.gz/upload");
      expect(req.headers.authorization).toBe("Bearer one-time-token");
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      received = Buffer.concat(chunks);
      expect(req.headers["content-length"]).toBe(String(received.length));
      res.writeHead(201, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: true }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    const upload = createWorkspaceArtifactUploader(`ws://127.0.0.1:${port}`);

    const result = await upload({
      workspace_id: "run-1",
      path: "evidence",
      archive: { format: "tar.gz", deterministic: true },
      limits: {
        max_files: 100,
        max_uncompressed_bytes: 1024 * 1024,
        max_compressed_bytes: 1024 * 1024,
        timeout_ms: 10_000,
      },
      media_type: "application/gzip",
      upload_url: "/api/runs/run-1/artifacts/evidence.tar.gz/upload",
      upload_token: "one-time-token",
    });

    expect(result.size_bytes).toBe(received.length);
    expect(result.file_count).toBe(1);
    expect(gunzipSync(received).includes(Buffer.from("result.json"))).toBe(true);
    expect(fs.readdirSync(path.join(home, "node", "artifact-staging"))).toEqual([]);
  });
});
