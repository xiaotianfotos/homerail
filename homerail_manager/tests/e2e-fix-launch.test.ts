import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { launchE2eFix, e2eFixManagerUrl, E2eFixLaunchHttpError, type E2eFixLaunchTransport } from "../src/runtime/e2e-fix-launch.js";
import { e2eFixDigest } from "../src/runtime/e2e-fix-candidates.js";
import { creationRequestDigest } from "../src/orchestration/run-creation-identity.js";

describe.skipIf(process.platform !== "linux")("E2E Fix start and read-only reconciliation", () => {
  let directory: string;
  const base = "http://127.0.0.1:12345";
  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-launch-"));
    fs.mkdirSync(path.join(directory, "task"), { mode: 0o700 });
    const config = { root_run_id: "root", task_id: "task", mode: "production", runtime_sha256: "a".repeat(64) };
    const artifacts: Record<string, string> = {
      "task/config.json": JSON.stringify(config), "task/config.sha256": e2eFixDigest(JSON.stringify(config)),
      "workflow.json": JSON.stringify({ metadata: { id: "root" } }), "runtime.json": "{}",
      "profile.json": JSON.stringify({ profile_id: "root", workflow_id: "root" }),
    };
    for (const [name, bytes] of Object.entries(artifacts)) fs.writeFileSync(path.join(directory, name), bytes);
    fs.writeFileSync(path.join(directory, "prepared.json"), JSON.stringify({ version: 1, started: false,
      root_run_id: "root", task_id: "task", runtime_sha256: config.runtime_sha256,
      policy_sha256: artifacts["task/config.sha256"],
      files: Object.fromEntries(Object.entries(artifacts).map(([name, bytes]) => [name, e2eFixDigest(bytes)])) }));
  });
  afterEach(() => fs.rmSync(directory, { recursive: true, force: true }));

  function manager(options: { loseResponse?: boolean; missingAfterCreate?: boolean; mismatch?: boolean; legacy?: boolean; unavailable?: number; noIdempotency?: boolean } = {}) {
    const calls: Array<{ route: string; body?: any }> = []; let existing: any = null;
    const transport: E2eFixLaunchTransport = async (route, body: any) => {
      calls.push({ route, body });
      if (route === "/api/e2e-fix/capabilities") return options.legacy ? null : { creation_identity_version: 1, idempotent_create_version: options.noIdempotency ? undefined : 1 };
      if (route === "/api/runs/root") return existing;
      if (route === "/api/dag/workflows/sync") return { workflow: { workflow_id: "root", head_revision: 7, canonical_hash: "b".repeat(64) } };
      if (route === "/api/dag/profiles/sync") return { profile: { workflow_id: "root", profile_id: "root", updated_at: "2026-09-01T00:00:00Z" } };
      if (route === "/api/runs/create-and-run") {
        // The intent must already be complete and readable before any dispatch.
        expect(JSON.parse(fs.readFileSync(path.join(directory, "launch-intent.json"), "utf8")).payload).toEqual(body);
        if (options.unavailable && options.unavailable-- > 0) throw new E2eFixLaunchHttpError(503, "dag_resources_unavailable");
        existing = options.missingAfterCreate ? null : { runId: body.runId, workflowId: body.workflow_id,
          workflowRevision: body.workflow_revision, canonicalHash: body.canonical_hash, status: "active",
          creationRequestDigest: options.mismatch ? "wrong" : creationRequestDigest({
            workflowId: body.workflow_id, profile: body.profile, prompt: body.prompt,
            expectedWorkflowRevision: body.workflow_revision, expectedCanonicalHash: body.canonical_hash,
            expectedProfileUpdatedAt: body.profile_updated_at }) };
        if (options.loseResponse) throw new Error("502 after Manager accepted");
        return { runId: "a response alone is not acceptance proof" };
      }
      throw new Error("unexpected request " + route);
    };
    return { calls, transport, setRun: (v: any) => { existing = v; } };
  }
  it("recovers a lost create response by exact persisted request identity with no second POST", async () => {
    const m = manager({ loseResponse: true });
    expect(await launchE2eFix(directory, base, "start", m.transport)).toMatchObject({ status: "observed", root_run_id: "root" });
    const count = m.calls.length;
    expect(await launchE2eFix(directory, base, "start", m.transport)).toMatchObject({ status: "observed" });
    expect(await launchE2eFix(directory, base, "reconcile", m.transport)).toMatchObject({ status: "observed" });
    expect(m.calls.slice(count).every(c => c.body === undefined)).toBe(true);
    expect(m.calls.filter(c => c.route === "/api/runs/create-and-run")).toHaveLength(1);
  });
  it("keeps an unobservable create unknown even after repeated start calls", async () => {
    const m = manager({ loseResponse: true, missingAfterCreate: true });
    expect(await launchE2eFix(directory, base, "start", m.transport)).toMatchObject({ status: "unknown" });
    expect(await launchE2eFix(directory, base, "start", m.transport)).toMatchObject({ status: "unknown" });
    expect(m.calls.filter(c => c.route === "/api/runs/create-and-run")).toHaveLength(1);
    expect(fs.existsSync(path.join(directory, "launched.json"))).toBe(false);
  });
  it("rejects a colliding request, changed artifact or changed Manager without further writes", async () => {
    const m = manager({ mismatch: true });
    await expect(launchE2eFix(directory, base, "start", m.transport)).rejects.toThrow(/does not match/);
    await expect(launchE2eFix(directory, "http://127.0.0.1:12346", "start", m.transport)).rejects.toThrow(/intent identity/);
    fs.appendFileSync(path.join(directory, "workflow.json"), " ");
    await expect(launchE2eFix(directory, base, "reconcile", m.transport)).rejects.toThrow(/artifact changed/);
    expect(m.calls.filter(c => c.route === "/api/runs/create-and-run")).toHaveLength(1);
  });
  it("does not adopt existing roots or start against an older Manager", async () => {
    const m = manager(); m.setRun({ runId: "root" });
    await expect(launchE2eFix(directory, base, "start", m.transport)).rejects.toThrow(/already exists/);
    const old = manager({ legacy: true });
    await expect(launchE2eFix(directory, base, "start", old.transport)).rejects.toThrow(/must support/);
    expect([...m.calls, ...old.calls].every(c => c.body === undefined)).toBe(true);
  });
  it("allows only one concurrent caller to submit create", async () => {
    const m = manager({ loseResponse: true });
    const result = await Promise.all([launchE2eFix(directory, base, "start", m.transport), launchE2eFix(directory, base, "start", m.transport)]);
    expect(result.every(r => ["observed", "unknown"].includes(r.status))).toBe(true);
    expect(m.calls.filter(c => c.route === "/api/runs/create-and-run")).toHaveLength(1);
  });
  it("reconcile never syncs or submits an unstarted preparation", async () => {
    const m = manager();
    expect(await launchE2eFix(directory, base, "reconcile", m.transport)).toEqual({ status: "not_submitted", root_run_id: "root" });
    expect(m.calls).toHaveLength(0);
  });
  it("does not recreate when an intent is missing but execution evidence remains", async () => {
    const m = manager();
    fs.mkdirSync(path.join(directory, "task/rounds"));
    await expect(launchE2eFix(directory, base, "start", m.transport)).rejects.toThrow(/execution evidence/);
    await expect(launchE2eFix(directory, base, "reconcile", m.transport)).rejects.toThrow(/execution evidence/);
    expect(m.calls).toHaveLength(0);
  });
  it("retains a resource rejection and explicitly retries the identical request after repair", async () => {
    const m = manager({ unavailable: 1 });
    expect(await launchE2eFix(directory, base, "start", m.transport)).toMatchObject({ status: "unknown" });
    expect(JSON.parse(fs.readFileSync(path.join(directory, "launch-response.json"), "utf8"))).toMatchObject({ response: "error", http_status: 503, code: "dag_resources_unavailable" });
    expect(await launchE2eFix(directory, base, "recover-start", m.transport)).toMatchObject({ status: "observed" });
    const creates = m.calls.filter(c => c.route === "/api/runs/create-and-run");
    expect(creates).toHaveLength(2); expect(creates[0].body).toEqual(creates[1].body);
    expect(m.calls.filter(c => c.route === "/api/dag/workflows/sync")).toHaveLength(1);
    await launchE2eFix(directory, base, "recover-start", m.transport);
    expect(m.calls.filter(c => c.route === "/api/runs/create-and-run")).toHaveLength(2);
  });
  it("bounds explicit recovery and keeps a claimed but unfinished retry unknown", async () => {
    const m = manager({ missingAfterCreate: true });
    await launchE2eFix(directory, base, "start", m.transport);
    for (let i = 0; i < 4; i++) await launchE2eFix(directory, base, "recover-start", m.transport);
    expect(m.calls.filter(c => c.route === "/api/runs/create-and-run")).toHaveLength(3);
    fs.unlinkSync(path.join(directory, "launch-recovery-1-response.json"));
    await launchE2eFix(directory, base, "recover-start", m.transport);
    expect(m.calls.filter(c => c.route === "/api/runs/create-and-run")).toHaveLength(3);
  });
  it("requires advertised idempotency and rejects a changed recovery claim", async () => {
    const m = manager({ missingAfterCreate: true, noIdempotency: true });
    await launchE2eFix(directory, base, "start", m.transport);
    await expect(launchE2eFix(directory, base, "recover-start", m.transport)).rejects.toThrow(/idempotent/);
    const capable = manager({ missingAfterCreate: true });
    fs.writeFileSync(path.join(directory, "launch-recovery-1.json"), '{"request_sha256":"changed"}');
    await expect(launchE2eFix(directory, base, "recover-start", capable.transport)).rejects.toThrow(/claim identity/);
    expect(m.calls.filter(c => c.route === "/api/runs/create-and-run")).toHaveLength(1);
    expect(capable.calls.every(c => c.body === undefined)).toBe(true);
  });
  it("never recreates a root lost from Manager after it was observed or produced stage evidence", async () => {
    const m = manager();
    await launchE2eFix(directory, base, "start", m.transport);
    m.setRun(null);
    expect(await launchE2eFix(directory, base, "recover-start", m.transport)).toMatchObject({ status: "unknown" });
    fs.unlinkSync(path.join(directory, "launched.json")); fs.mkdirSync(path.join(directory, "task/rounds"));
    await launchE2eFix(directory, base, "recover-start", m.transport);
    expect(m.calls.filter(c => c.route === "/api/runs/create-and-run")).toHaveLength(1);
  });
  it("refuses credentials and token-like query parameters in persisted URLs", () => {
    for (const url of ["http://user:secret@localhost", "http://localhost?token=secret", "file:///tmp/run"]) expect(() => e2eFixManagerUrl(url)).toThrow();
  });
});
