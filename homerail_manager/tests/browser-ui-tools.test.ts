import { createServer, request, type Server } from "node:http";
import { once } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { PersistedRunSummary } from "../src/persistence/store.js";
import {
  browserUiToolRoutesHandler,
  resolveBrowserUiDagRun,
} from "../src/server/browser-ui-tools.js";
import type { HomeRailUiToolName } from "homerail-protocol";

let server: Server | null = null;

afterEach(async () => {
  if (!server?.listening) return;
  server.close();
  await once(server, "close");
  server = null;
});

async function routeRequest(input: {
  authorize: boolean;
  body: Record<string, unknown>;
  browser_tools_transport?: "none" | "desktop" | "renderer";
  browser_tools_target?: Record<string, string>;
  invoke?: (name: HomeRailUiToolName, value: unknown, options?: unknown) => Promise<unknown>;
}): Promise<{ status: number; body: Record<string, unknown> }> {
  server = createServer((req, res) => {
    browserUiToolRoutesHandler(req, res, {
      authorize: () => input.authorize,
      browser_tools_transport: input.browser_tools_transport,
      browser_tools_target: input.browser_tools_target as never,
      invoke: input.invoke as never,
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing test server address");
  return new Promise((resolve, reject) => {
    const req = request({
      host: "127.0.0.1",
      port: address.port,
      path: "/api/browser-tools/invoke",
      method: "POST",
      headers: { "Content-Type": "application/json" },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      res.on("end", () => resolve({
        status: res.statusCode ?? 0,
        body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>,
      }));
    });
    req.once("error", reject);
    req.end(JSON.stringify(input.body));
  });
}

const runs: PersistedRunSummary[] = [
  { runId: "run-001", workflowId: "sync", workflowName: "Data Sync", status: "active", createdAt: 3 },
  { runId: "run-002", workflowId: "review", workflowName: "PR Review", status: "completed", createdAt: 2 },
  { runId: "run-003", workflowId: "sync-nightly", workflowName: "Data Sync Nightly", status: "waiting", createdAt: 1 },
];

describe("Manager browser UI target resolution", () => {
  it("resolves exact ids and unique names and rejects ambiguity", () => {
    expect(resolveBrowserUiDagRun(runs, { entity_id: "run-002" })).toBe("run-002");
    expect(resolveBrowserUiDagRun(runs, { query: "PR Review" })).toBe("run-002");
    expect(resolveBrowserUiDagRun(runs, { query: "nightly" })).toBe("run-003");
    expect(resolveBrowserUiDagRun(runs, {})).toBeUndefined();
    expect(() => resolveBrowserUiDagRun(runs, { query: "run-00" })).toThrow(/ambiguous/);
    expect(() => resolveBrowserUiDagRun(runs, { query: "missing" })).toThrow(/No DAG run matches/);
    expect(() => resolveBrowserUiDagRun(runs, { entity_id: "run-404" })).toThrow(/not found/);
  });

  it("requires a Manager turn and invokes the same trusted broker callback", async () => {
    await expect(routeRequest({
      authorize: false,
      body: { name: "ui_get_state", input: {} },
    })).resolves.toMatchObject({ status: 403 });

    const invoke = vi.fn(async () => ({ ok: true, state: { active_surface: null } }));
    const response = await routeRequest({
      authorize: true,
      body: { name: "ui_get_state", input: {} },
      invoke,
    });
    expect(response).toMatchObject({
      status: 200,
      body: { success: true, data: { result: { ok: true } } },
    });
    expect(invoke).toHaveBeenCalledWith("ui_get_state", {}, expect.objectContaining({
      browser_tools_transport: "none",
      browser_tools_target: null,
      signal: expect.any(AbortSignal),
    }));
  });

  it("rejects schema-invalid input at the HTTP boundary before invoking the broker", async () => {
    const invoke = vi.fn(async () => ({ ok: true }));
    const response = await routeRequest({
      authorize: true,
      body: {
        name: "ui_open_surface",
        input: { surface: "dag_status", run_id: "run-001" },
      },
      invoke: invoke as never,
    });

    expect(response).toMatchObject({
      status: 400,
      body: { success: false },
    });
    expect(String(response.body.error)).toContain("unsupported field: run_id");
    expect(invoke).not.toHaveBeenCalled();
  });

  it("forwards an exact widget revision through the authorized Manager boundary", async () => {
    const invoke = vi.fn(async () => ({ ok: true, widget: { widget_id: "widget-one" } }));
    const input = {
      document_id: "document-one",
      document_revision: 4,
      widget_id: "widget-one",
      widget_revision: 2,
      expanded: true,
    };
    const response = await routeRequest({
      authorize: true,
      body: { name: "ui_set_widget_expanded", input },
      invoke,
    });

    expect(response).toMatchObject({
      status: 200,
      body: { success: true, data: { result: { ok: true } } },
    });
    expect(invoke).toHaveBeenCalledWith("ui_set_widget_expanded", input, expect.objectContaining({
      browser_tools_transport: "none",
      browser_tools_target: null,
      signal: expect.any(AbortSignal),
    }));
  });

  it("uses only the signed route context and never a target from the request body", async () => {
    const invoke = vi.fn(async () => ({ ok: true }));
    const signedTarget = {
      connection_id: "connection-signed",
      ui_session_id: "ui-signed",
      tab_id: "tab-signed",
      navigation_id: "navigation-signed",
    };
    const response = await routeRequest({
      authorize: true,
      browser_tools_transport: "renderer",
      browser_tools_target: signedTarget,
      body: {
        name: "ui_get_state",
        input: {},
        browser_tools_transport: "desktop",
      },
      invoke,
    });
    expect(response.status).toBe(200);
    expect(invoke).toHaveBeenCalledWith("ui_get_state", {}, expect.objectContaining({
      browser_tools_transport: "renderer",
      browser_tools_target: signedTarget,
    }));
  });
});
