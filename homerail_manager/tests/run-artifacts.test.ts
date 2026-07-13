import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AddressInfo } from "node:net";
import type { DAGArtifactDeclaration, ParsedDAG } from "../src/orchestration/graph.js";
import { createActiveRun, handoffActiveRun, _clearActiveRuns } from "../src/runtime/active-runs.js";
import { finalizeRunArtifacts } from "../src/runtime/run-artifact-service.js";
import { closeDb } from "../src/persistence/db.js";
import { ensureRunDir, _clearAllPersistence } from "../src/persistence/store.js";
import {
  getRunArtifactBlobPath,
  authorizeRunArtifactUpload,
  completeRunArtifactUpload,
  initializeRunArtifacts,
  listRunArtifacts,
  prepareRunArtifactUpload,
} from "../src/persistence/run-artifacts.js";
import { createServer } from "../src/server/http.js";

const RESULT_CONTRACT = {
  type: "object",
  additionalProperties: false,
  required: ["status", "details"],
  properties: {
    status: { type: "string", enum: ["ok"] },
    details: { type: "object" },
  },
};

function artifactDag(): ParsedDAG {
  return {
    meta: {
      name: "Artifact run",
      workflow_id: "artifact-run",
      contracts: { Result: RESULT_CONTRACT },
      artifacts: [{
        name: "result.json",
        source: { type: "handoff", node: "execute", port: "reported" },
        media_type: "application/json",
        contract: "Result",
        required: true,
        publish: "success",
      }],
    },
    graph: {
      nodes: [{
        node_id: "execute",
        name: "Execute",
        description: "",
        node_type: "agent",
        agent: "worker",
        after: [],
        outputs: { reported: { to: "", condition: "on_success" } },
        extra: { workflow_spec_v1: { input_contracts: {}, output_contracts: { reported: "Result" } } },
      }],
      edges: [{
        from_node: "execute",
        from_port: "reported",
        to_node: "",
        to_port: "",
        condition: "on_success",
        terminal_outcome: "success",
      }],
    },
    loop_sources: [],
  };
}

const WORKSPACE_ARTIFACT: DAGArtifactDeclaration = {
  name: "evidence.tar.gz",
  source: { type: "workspace", path: "evidence", produced_by: "execute" },
  media_type: "application/gzip",
  archive: { format: "tar.gz", deterministic: true },
  required: false,
  publish: "always",
  limits: {
    max_files: 100,
    max_uncompressed_bytes: 1024 * 1024,
    max_compressed_bytes: 1024 * 1024,
    timeout_ms: 10_000,
  },
};

describe("run artifacts", () => {
  let home: string;
  let previousHome: string | undefined;

  beforeEach(() => {
    previousHome = process.env.HOMERAIL_HOME;
    home = fs.mkdtempSync(path.join(os.tmpdir(), "homerail-manager-artifacts-"));
    process.env.HOMERAIL_HOME = home;
    closeDb();
    _clearActiveRuns();
    _clearAllPersistence();
  });

  afterEach(() => {
    _clearActiveRuns();
    _clearAllPersistence();
    closeDb();
    fs.rmSync(home, { recursive: true, force: true });
    if (previousHome === undefined) delete process.env.HOMERAIL_HOME;
    else process.env.HOMERAIL_HOME = previousHome;
  });

  it("materializes a declared JSON handoff as stable contract-validated bytes", async () => {
    createActiveRun("artifact-handoff-run", artifactDag());
    handoffActiveRun("artifact-handoff-run", "execute", "reported", {
      status: "ok",
      details: { z: 2, a: 1 },
    });

    const artifacts = await finalizeRunArtifacts("artifact-handoff-run", "success");

    expect(artifacts).toEqual([
      expect.objectContaining({ name: "result.json", status: "ready", required: true }),
    ]);
    const blobPath = getRunArtifactBlobPath("artifact-handoff-run", "result.json");
    expect(blobPath).toBeDefined();
    expect(fs.readFileSync(blobPath!, "utf8")).toBe(
      "{\n  \"details\": {\n    \"a\": 1,\n    \"z\": 2\n  },\n  \"status\": \"ok\"\n}\n",
    );
  });

  it("materializes Markdown handoffs without an issue-specific output path", async () => {
    const parsed = artifactDag();
    parsed.meta.contracts = undefined;
    parsed.meta.artifacts = [{
      name: "report.md",
      source: { type: "handoff", node: "execute", port: "reported" },
      media_type: "text/markdown",
      required: true,
      publish: "always",
    }];
    delete parsed.graph.nodes[0]?.extra;
    createActiveRun("artifact-markdown-run", parsed);
    handoffActiveRun("artifact-markdown-run", "execute", "reported", "# Diagnosis\n\nEverything is grounded.");

    await finalizeRunArtifacts("artifact-markdown-run", "success");

    const blobPath = getRunArtifactBlobPath("artifact-markdown-run", "report.md");
    expect(fs.readFileSync(blobPath!, "utf8")).toBe("# Diagnosis\n\nEverything is grounded.\n");
  });

  it("serializes a raw string contract as a valid JSON string artifact", async () => {
    const parsed = artifactDag();
    parsed.meta.contracts = { Text: { type: "string" } };
    parsed.meta.artifacts = [{
      name: "message.json",
      source: { type: "handoff", node: "execute", port: "reported" },
      media_type: "application/json",
      contract: "Text",
      required: true,
      publish: "always",
    }];
    parsed.graph.nodes[0]!.extra = {
      workflow_spec_v1: { input_contracts: {}, output_contracts: { reported: "Text" } },
    };
    createActiveRun("artifact-json-string-run", parsed);
    handoffActiveRun("artifact-json-string-run", "execute", "reported", "hello");

    await finalizeRunArtifacts("artifact-json-string-run", "success");

    const blobPath = getRunArtifactBlobPath("artifact-json-string-run", "message.json");
    expect(fs.readFileSync(blobPath!, "utf8")).toBe("\"hello\"\n");
  });

  it("dispatches workspace packaging to the Node that provisioned the producer", async () => {
    const parsed = artifactDag();
    parsed.meta.artifacts = [WORKSPACE_ARTIFACT];
    createActiveRun("artifact-workspace-run", parsed);
    const archiveBytes = Buffer.from("node-created-tar-gzip");

    const artifacts = await finalizeRunArtifacts("artifact-workspace-run", "success", {
      listProvisioned: () => [{
        runId: "artifact-workspace-run",
        nodeId: "execute",
        workerId: "worker-1",
        containerId: "container-1",
        dockerNodeId: "runner-112",
        provisionedAt: Date.now(),
      }],
      listNodes: () => [],
      sendLifecycle: async (nodeId, resourceType, operation, spec) => {
        expect([nodeId, resourceType, operation]).toEqual(["runner-112", "workspace_artifact", "archive_upload"]);
        expect(spec).toMatchObject({ workspace_id: "artifact-workspace-run", path: "evidence" });
        const target = authorizeRunArtifactUpload(
          "artifact-workspace-run",
          "evidence.tar.gz",
          String(spec.upload_token),
        );
        fs.writeFileSync(target.temporary_path, archiveBytes);
        fs.renameSync(target.temporary_path, target.final_path);
        completeRunArtifactUpload("artifact-workspace-run", "evidence.tar.gz", {
          sizeBytes: archiveBytes.length,
          sha256: createHash("sha256").update(archiveBytes).digest("hex"),
          uncompressedBytes: 100,
          fileCount: 2,
        });
        return { status: "success" };
      },
    });

    expect(artifacts).toEqual([
      expect.objectContaining({
        name: "evidence.tar.gz",
        status: "ready",
        size_bytes: archiveBytes.length,
        uncompressed_bytes: 100,
        file_count: 2,
      }),
    ]);
  });

  it("accepts a one-time streamed Node upload and supports list, HEAD, and byte ranges", async () => {
    const server = createServer(0, { allowLoopbackWithoutToken: true }, {
      dispatch: () => ({ status: "failed", reason: "unused", retryable: false }),
    }, false);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const port = (server.address() as AddressInfo).port;
      const base = `http://127.0.0.1:${port}`;
      ensureRunDir("artifact-upload-run");
      initializeRunArtifacts("artifact-upload-run", [WORKSPACE_ARTIFACT]);
      const prepared = prepareRunArtifactUpload("artifact-upload-run", "evidence.tar.gz");
      const bytes = Buffer.from("fake deterministic tar gzip bytes");
      const sha256 = createHash("sha256").update(bytes).digest("hex");

      const denied = await fetch(`${base}/api/runs/artifact-upload-run/artifacts/evidence.tar.gz/upload`, {
        method: "PUT",
        headers: { Authorization: "Bearer wrong", "Content-Type": "application/gzip" },
        body: bytes,
      });
      expect(denied.status).toBe(401);

      const uploaded = await fetch(`${base}/api/runs/artifact-upload-run/artifacts/evidence.tar.gz/upload`, {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${prepared.token}`,
          "Content-Type": "application/gzip",
          "X-Homerail-Artifact-Sha256": sha256,
          "X-Homerail-Artifact-Uncompressed-Bytes": "123",
          "X-Homerail-Artifact-File-Count": "4",
        },
        body: bytes,
      });
      expect(uploaded.status, await uploaded.text()).toBe(201);

      const reused = await fetch(`${base}/api/runs/artifact-upload-run/artifacts/evidence.tar.gz/upload`, {
        method: "PUT",
        headers: { Authorization: `Bearer ${prepared.token}`, "Content-Type": "application/gzip" },
        body: bytes,
      });
      expect(reused.status).toBe(409);

      const listed = await fetch(`${base}/api/runs/artifact-upload-run/artifacts`);
      const listBody = await listed.json() as any;
      expect(listBody.data.artifacts[0]).toMatchObject({
        name: "evidence.tar.gz",
        status: "ready",
        size_bytes: bytes.length,
        uncompressed_bytes: 123,
        file_count: 4,
        sha256,
      });
      expect(JSON.stringify(listBody)).not.toContain(prepared.token);

      const head = await fetch(`${base}/api/runs/artifact-upload-run/artifacts/evidence.tar.gz/content`, { method: "HEAD" });
      expect(head.status).toBe(200);
      expect(head.headers.get("etag")).toBe(`"${sha256}"`);
      expect(head.headers.get("content-length")).toBe(String(bytes.length));

      const ranged = await fetch(`${base}/api/runs/artifact-upload-run/artifacts/evidence.tar.gz/content`, {
        headers: { Range: "bytes=5-17" },
      });
      expect(ranged.status).toBe(206);
      expect(Buffer.from(await ranged.arrayBuffer()).equals(bytes.subarray(5, 18))).toBe(true);
      expect(listRunArtifacts("artifact-upload-run")[0]).toMatchObject({ status: "ready", sha256 });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
