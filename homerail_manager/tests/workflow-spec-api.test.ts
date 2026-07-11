import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeDb } from "../src/persistence/db.js";
import { createServer } from "../src/server/http.js";
import { workflowSchemaHash } from "../src/orchestration/workflow-spec-v1.js";

async function listen(server: http.Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address !== "object") throw new Error("server did not bind");
  return address.port;
}

async function close(server: http.Server): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

const VALID_SOURCE = `
api_version: homerail.ai/v1
kind: Workflow
metadata:
  id: api-validation
  name: API Validation
spec:
  contracts:
    Input:
      type: object
  agents:
    worker:
      system: Return the input.
  nodes:
    execute:
      kind: agent
      agent: worker
      inputs:
        task: { contract: Input }
      outputs:
        result: { contract: Input }
    done:
      kind: terminal
      outcome: success
      inputs:
        result: { contract: Input }
  edges:
    - { from: $run.input, to: execute.task }
    - { from: execute.result, to: done.result }
`;

describe("WorkflowSpec API", () => {
  let server: http.Server;
  let baseUrl: string;
  let tmpHome: string;
  let oldHome: string | undefined;

  beforeEach(async () => {
    oldHome = process.env.HOMERAIL_HOME;
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "homerail-workflow-spec-api-"));
    process.env.HOMERAIL_HOME = tmpHome;
    closeDb();
    server = createServer(0, undefined, undefined, false);
    baseUrl = `http://127.0.0.1:${await listen(server)}`;
  });

  afterEach(async () => {
    await close(server);
    closeDb();
    if (oldHome === undefined) delete process.env.HOMERAIL_HOME;
    else process.env.HOMERAIL_HOME = oldHome;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it("serves the exact validator schema with stable cache metadata", async () => {
    const response = await fetch(`${baseUrl}/api/dag/schema`);
    const body = await response.json() as {
      success: boolean;
      data: { api_version: string; schema_hash: string; schema: Record<string, unknown> };
    };

    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data.api_version).toBe("homerail.ai/v1");
    expect(body.data.schema_hash).toBe(workflowSchemaHash());
    expect(response.headers.get("etag")).toBe(`"${body.data.schema_hash}"`);
    expect(JSON.stringify(body.data.schema)).not.toContain("api_key");

    const cached = await fetch(`${baseUrl}/api/dag/schema`, {
      headers: { "If-None-Match": response.headers.get("etag")! },
    });
    expect(cached.status).toBe(304);
  });

  it("returns structured validation results for AI and CLI clients", async () => {
    const valid = await fetch(`${baseUrl}/api/dag/validate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ source: VALID_SOURCE }),
    });
    const validBody = await valid.json() as {
      success: boolean;
      data: { valid: boolean; canonical_hash: string; summary: { node_count: number } };
    };
    expect(valid.status).toBe(200);
    expect(validBody.success).toBe(true);
    expect(validBody.data.valid).toBe(true);
    expect(validBody.data.canonical_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(validBody.data.summary.node_count).toBe(2);

    const invalid = await fetch(`${baseUrl}/api/dag/validate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ source: VALID_SOURCE.replace("agent: worker", "agent: missing") }),
    });
    const invalidBody = await invalid.json() as {
      success: boolean;
      data: { diagnostics: Array<{ code: string; path: string; line: number }> };
    };
    expect(invalid.status).toBe(200);
    expect(invalidBody.success).toBe(false);
    expect(invalidBody.data.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: "DAG_SEMANTIC_UNKNOWN_AGENT",
        path: "/spec/nodes/execute/agent",
        line: expect.any(Number),
      }),
    ]));
  });

  it("exposes immutable workflow revision provenance after sync", async () => {
    const sync = await fetch(`${baseUrl}/api/dag/workflows/sync`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ yaml_text: VALID_SOURCE }),
    });
    const syncBody = await sync.json() as {
      data: { workflow: { head_revision: number; canonical_hash: string }; revision_created: boolean };
    };
    expect(sync.status).toBe(201);
    expect(syncBody.data.workflow.head_revision).toBe(1);
    expect(syncBody.data.revision_created).toBe(true);

    const list = await fetch(`${baseUrl}/api/dag/workflows/api-validation/revisions`);
    const listBody = await list.json() as {
      data: { revisions: Array<{ revision: number; canonical_hash: string }>; total: number };
    };
    expect(list.status).toBe(200);
    expect(listBody.data).toMatchObject({ total: 1 });
    expect(listBody.data.revisions[0]).toMatchObject({
      revision: 1,
      canonical_hash: syncBody.data.workflow.canonical_hash,
    });

    const detail = await fetch(`${baseUrl}/api/dag/workflows/api-validation/revisions/1`);
    const detailBody = await detail.json() as {
      data: { revision: number; source_text: string; canonical_json: string };
    };
    expect(detail.status).toBe(200);
    expect(detailBody.data.revision).toBe(1);
    expect(detailBody.data.source_text).toBe(VALID_SOURCE);
    expect(JSON.parse(detailBody.data.canonical_json)).toMatchObject({ workflow_id: "api-validation" });
  });
});
