import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { closeDb } from "../src/persistence/db.js";
import { createServer } from "../src/server/http.js";

async function listen(server: http.Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address !== "object") throw new Error("server did not bind");
  return address.port;
}

async function close(server: http.Server): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

describe("DAG patterns API", () => {
  let server: http.Server;
  let baseUrl: string;
  let tmpHome: string;
  let oldHome: string | undefined;

  beforeEach(async () => {
    oldHome = process.env.HOMERAIL_HOME;
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "homerail-dag-pattern-api-"));
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

  it("lists and describes built-in patterns for AI clients", async () => {
    const listResponse = await fetch(`${baseUrl}/api/dag/patterns`);
    const listBody = await listResponse.json() as {
      success: boolean;
      data: { total: number; patterns: Array<{ id: string; typical_uses: string[] }> };
    };
    expect(listResponse.status).toBe(200);
    expect(listBody.success).toBe(true);
    expect(listBody.data.total).toBe(9);
    expect(listBody.data.patterns.find((pattern) => pattern.id === "quorum")?.typical_uses.length).toBeGreaterThan(0);

    const detailResponse = await fetch(`${baseUrl}/api/dag/patterns/ratchet`);
    const detailBody = await detailResponse.json() as {
      data: { required_primitives: string[]; workflow_template: { api_version: string; spec: { nodes: Record<string, unknown> } } };
    };
    expect(detailResponse.status).toBe(200);
    expect(detailBody.data.required_primitives).toContain("while_gateway");
    expect(detailBody.data.workflow_template.api_version).toBe("homerail.ai/v1");
    expect(detailBody.data.workflow_template.spec.nodes).toHaveProperty("target_gate");
  });

  it("instantiates a typed pattern and returns validated YAML without persisting it", async () => {
    const response = await fetch(`${baseUrl}/api/dag/patterns/quorum/instantiate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ parameters: { workflow_id: "api-quorum", threshold: 3 } }),
    });
    const body = await response.json() as {
      success: boolean;
      data: {
        parameters: { threshold: number };
        workflow: { workflow_id: string; pattern: { id: string } };
        yaml_text: string;
        validation: { valid: boolean };
      };
    };

    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data.parameters.threshold).toBe(3);
    expect(body.data.workflow).toMatchObject({
      api_version: "homerail.ai/v1",
      kind: "Workflow",
      metadata: { id: "api-quorum" },
      spec: { pattern: { id: "quorum" } },
    });
    expect(body.data.yaml_text).toContain("threshold: 3");
    expect(body.data.validation.valid).toBe(true);
  });

  it("reports invalid parameters and unknown patterns with API status codes", async () => {
    const invalid = await fetch(`${baseUrl}/api/dag/patterns/quorum/instantiate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ parameters: { threshold: 4 } }),
    });
    expect(invalid.status).toBe(400);

    const invalidContainer = await fetch(`${baseUrl}/api/dag/patterns/quorum/instantiate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ parameters: ["threshold=2"] }),
    });
    expect(invalidContainer.status).toBe(400);

    const missing = await fetch(`${baseUrl}/api/dag/patterns/unknown`);
    expect(missing.status).toBe(404);

    const missingInstance = await fetch(`${baseUrl}/api/dag/patterns/unknown/instantiate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    expect(missingInstance.status).toBe(404);
  });
});
