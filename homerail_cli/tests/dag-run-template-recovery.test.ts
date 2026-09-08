import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createProgram } from "../src/index.js";

const RUN = "judger-known-run-284";
function reply(data: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => data } as Response;
}

describe("known-run submission recovery", () => {
  let home: string;
  let previousHome: string | undefined;
  let previousAssets: string | undefined;
  beforeEach(() => {
    previousHome = process.env.HOMERAIL_HOME;
    previousAssets = process.env.HOMERAIL_ASSET_DIR;
    home = fs.mkdtempSync(path.join(os.tmpdir(), "hr-run-recovery-"));
    process.env.HOMERAIL_HOME = home;
    delete process.env.HOMERAIL_ASSET_DIR;
    const assets = path.join(home, "asset", "orchestrations");
    fs.mkdirSync(assets, { recursive: true });
    fs.writeFileSync(path.join(assets, "recover.yaml.template"), "api_version: homerail.ai/v1\n");
    process.exitCode = undefined;
  });
  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = undefined;
    if (previousHome === undefined) delete process.env.HOMERAIL_HOME;
    else process.env.HOMERAIL_HOME = previousHome;
    if (previousAssets === undefined) delete process.env.HOMERAIL_ASSET_DIR;
    else process.env.HOMERAIL_ASSET_DIR = previousAssets;
    fs.rmSync(home, { recursive: true, force: true });
  });

  async function exercise(options: { terminal?: string; unavailable?: "missing" | "network" | "wrong_id";
      httpError?: number; noRunId?: boolean; lateVisibility?: boolean; invalidTimeout?: boolean } = {}) {
    const calls: Array<{ url: string; method: string }> = [];
    let polls = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      const target = String(url);
      calls.push({ url: target, method: String(init?.method ?? "GET") });
      if (target.endsWith("/api/dag/workflows/sync")) return reply({ success: true, data: { workflow: { workflow_id: "recover" } } });
      if (target.endsWith("/api/runs/create-and-run")) {
        if (options.httpError) return reply({ success: false, message: "create rejected" }, options.httpError);
        // Simulate a persisted run whose create acknowledgement was lost.
        throw new TypeError("fetch failed after remote create");
      }
      if (target.endsWith(`/api/runs/${RUN}/status`)) {
        polls++;
        if (options.unavailable === "missing" || (options.lateVisibility && polls === 1)) return reply({ success: false, message: "run not found" }, 404);
        if (options.unavailable === "network" || (options.lateVisibility && polls === 2)) throw new TypeError("status connection reset");
        return reply({ success: true, data: { run_id: options.unavailable === "wrong_id" ? "another-run" : RUN,
          status: options.lateVisibility && polls === 3 ? "running" : (options.terminal ?? "completed") } });
      }
      if (target.endsWith(`/api/runs/${RUN}/artifacts`)) return reply({ success: true, data: { artifacts: [] } });
      throw new Error("Unexpected request: " + target);
    });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const args = ["node", "hr", "--json", "dag", "run-template", "recover", "--input", "{}",
      "--wait", "--interval", "0.001", "--timeout", options.invalidTimeout ? "invalid" : "0.03"];
    if (!options.noRunId) args.push("--run-id", RUN);
    await createProgram().parseAsync(args);
    return { calls, polls, output: log.mock.calls.map(x => String(x[0])), errors: error.mock.calls.map(x => String(x[0])) };
  }

  it("recovers a lost create acknowledgement with one create and the same run", async () => {
    const r = await exercise({ lateVisibility: true });
    expect(process.exitCode).not.toBe(1);
    expect(r.output.some(x => JSON.parse(x).run_id === RUN && JSON.parse(x).status === "completed")).toBe(true);
    expect(r.calls.filter(x => x.url.endsWith("/create-and-run"))).toHaveLength(1);
    expect(r.polls).toBeGreaterThanOrEqual(4);
    expect(r.calls.filter(x => x.method === "POST")).toHaveLength(2); // sync + create only
  });

  it("preserves terminal failure after recovery instead of claiming completion", async () => {
    const r = await exercise({ terminal: "failed" });
    expect(r.output.some(x => JSON.parse(x).run_id === RUN && JSON.parse(x).status === "failed")).toBe(true);
    expect(r.output.some(x => JSON.parse(x).status === "completed")).toBe(false);
    expect(r.calls.filter(x => x.url.endsWith("/create-and-run"))).toHaveLength(1);
  });

  for (const unavailable of ["missing", "network", "wrong_id"] as const) {
    it(`bounds ${unavailable} observation without replacement, cancellation or success`, async () => {
      const r = await exercise({ unavailable });
      expect(process.exitCode).toBe(75);
      expect(r.output).toEqual([]);
      expect(r.errors.join(" ")).toContain(RUN);
      expect(r.errors.join(" ")).toContain("fetch failed after remote create");
      expect(r.calls.filter(x => x.url.endsWith("/create-and-run"))).toHaveLength(1);
      expect(r.calls.filter(x => x.method === "POST")).toHaveLength(2);
    }, 1500);
  }

  for (const httpError of [401, 409]) {
    it(`does not adopt an existing run after explicit HTTP ${httpError} rejection`, async () => {
      const r = await exercise({ httpError });
      expect(process.exitCode).toBe(1);
      expect(r.polls).toBe(0);
      expect(r.output).toEqual([]);
    });
  }

  it("does not invent a run identity after transport failure without an explicit ID", async () => {
    const r = await exercise({ noRunId: true });
    expect(process.exitCode).toBe(1);
    expect(r.polls).toBe(0);
    expect(r.output).toEqual([]);
  });

  it("validates recovery wait options before a create side effect", async () => {
    const r = await exercise({ invalidTimeout: true });
    expect(process.exitCode).toBe(1);
    expect(r.calls.some(x => x.url.endsWith("/create-and-run"))).toBe(false);
  });
});
