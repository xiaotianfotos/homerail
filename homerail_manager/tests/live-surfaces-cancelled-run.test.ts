import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseDAGYaml } from "../src/orchestration/yaml-loader.js";
import { closeDb } from "../src/persistence/db.js";
import { _clearAllPersistence } from "../src/persistence/store.js";
import {
  _clearActiveRuns,
  cancelActiveRun,
  createActiveRun,
} from "../src/runtime/active-runs.js";
import { createServer } from "../src/server/http.js";

/**
 * Regression coverage for issue #168 scenario C: a cancelled DAG must release
 * the live surface so the canonical UI can mount.
 *
 * `GET /api/runs/:run_id/live-surfaces` previously ignored `metadata.status`
 * entirely and kept returning projections/document for a cancelled run, which
 * kept `dagTaskCanvasPresent=true` on the frontend and suppressed the canonical
 * view even after a Canonical Block commit.
 */
describe("GET /api/runs/:run_id/live-surfaces (issue #168 cancelled run)", () => {
  let home: string;
  let previousHome: string | undefined;
  let server: http.Server | undefined;

  beforeEach(() => {
    previousHome = process.env.HOMERAIL_HOME;
    home = fs.mkdtempSync(path.join(os.tmpdir(), "homerail-live-surfaces-"));
    process.env.HOMERAIL_HOME = home;
    closeDb();
    _clearActiveRuns();
    _clearAllPersistence();
  });

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = undefined;
    }
    _clearActiveRuns();
    _clearAllPersistence();
    closeDb();
    if (previousHome === undefined) delete process.env.HOMERAIL_HOME;
    else process.env.HOMERAIL_HOME = previousHome;
    fs.rmSync(home, { recursive: true, force: true });
  });

  function oneActorDag() {
    return parseDAGYaml(`
name: live-surfaces-cancelled
workflow_id: live-surfaces-cancelled
agents:
  worker: { agent_type: deterministic }
nodes:
  research:
    agent: worker
    kind: task
`);
  }

  async function listen(srv: http.Server): Promise<string> {
    await new Promise<void>((resolve) => srv.listen(0, "127.0.0.1", resolve));
    const address = srv.address();
    if (!address || typeof address !== "object") throw new Error("server did not bind");
    return `http://127.0.0.1:${address.port}`;
  }

  async function getJson(url: string): Promise<{ status: number; body: Record<string, unknown> }> {
    const response = await fetch(url);
    return { status: response.status, body: await response.json() as Record<string, unknown> };
  }

  it("releases the surface for a cancelled run", async () => {
    const runId = "live-surfaces-cancelled-run";
    createActiveRun(runId, oneActorDag());
    cancelActiveRun(runId);

    server = createServer(0, undefined, undefined, false, { autoDetectCodex: false });
    const baseUrl = await listen(server);

    const { status, body } = await getJson(`${baseUrl}/api/runs/${runId}/live-surfaces`);
    expect(status).toBe(200);
    const data = body.data as Record<string, unknown>;
    expect(data.run_status).toBe("cancelled");
    expect(data.projections).toEqual([]);
    expect(data.surface_states).toEqual([]);
    expect(data.document).toBeNull();
  });

  it("still returns projections for an active (non-terminal) run", async () => {
    const runId = "live-surfaces-active-run";
    createActiveRun(runId, oneActorDag());

    server = createServer(0, undefined, undefined, false, { autoDetectCodex: false });
    const baseUrl = await listen(server);

    const { status, body } = await getJson(`${baseUrl}/api/runs/${runId}/live-surfaces`);
    expect(status).toBe(200);
    const data = body.data as Record<string, unknown>;
    // Active run status is non-terminal; the surface must NOT be released.
    expect(data.run_status).not.toBe("cancelled");
    expect(data.run_status).not.toBe("failed");
    expect(Array.isArray(data.projections)).toBe(true);
    expect(data).toHaveProperty("document");
  });
});
