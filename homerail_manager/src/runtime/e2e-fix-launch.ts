import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { creationRequestDigest } from "../orchestration/run-creation-identity.js";
import { e2eFixDigest } from "./e2e-fix-candidates.js";

export type E2eFixLaunchTransport = (route: string, body?: unknown) => Promise<any | null>;
const files = ["task/config.json", "task/config.sha256", "runtime.json", "workflow.json", "profile.json"];
const read = (file: string) => JSON.parse(fs.readFileSync(file, "utf8"));

/** Atomically publish a complete record. A partial write is never an intent. */
function once(file: string, value: unknown): boolean {
  const temp = file + "." + randomUUID() + ".tmp";
  const fd = fs.openSync(temp, "wx", 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(value)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  try {
    try { fs.linkSync(temp, file); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") return false; throw error; }
    const dir = fs.openSync(path.dirname(file), "r");
    try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
    return true;
  } finally { fs.unlinkSync(temp); }
}

export function e2eFixManagerUrl(value: string): string {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error("Manager URL must be HTTP(S) without credentials, query or fragment");
  return url.href.replace(/\/$/, "");
}

export function e2eFixLaunchTransport(managerUrl: string, token: string): E2eFixLaunchTransport {
  const base = e2eFixManagerUrl(managerUrl);
  return async (route, body) => {
    const response = await fetch(base + route, { method: body === undefined ? "GET" : "POST",
      headers: { "content-type": "application/json", "x-homerail-dag-token": token },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(15000), redirect: "error" });
    if (response.status === 404 && body === undefined) return null;
    // Never persist/print an arbitrary response body or a credential header.
    if (!response.ok) throw new Error(`Manager request failed: HTTP ${response.status}`);
    const result = await response.json() as any;
    if (result.success === false) throw new Error("Manager rejected request");
    return result.data ?? result;
  };
}

function prepared(directory: string) {
  if (process.platform !== "linux" || !path.isAbsolute(directory)) throw new Error("launch requires an absolute Linux host directory");
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || (stat.mode & 0o077)) throw new Error("prepared custody must be private");
  const manifestBytes = fs.readFileSync(path.join(directory, "prepared.json"));
  const manifest = JSON.parse(manifestBytes.toString());
  if (manifest.version !== 1 || manifest.started !== false
    || !isDeepStrictEqual(Object.keys(manifest.files ?? {}).sort(), [...files].sort())) throw new Error("invalid preparation manifest");
  for (const name of files) {
    const file = path.join(directory, name);
    if (!fs.lstatSync(file).isFile() || e2eFixDigest(fs.readFileSync(file)) !== manifest.files[name]) throw new Error("prepared artifact changed: " + name);
  }
  const config = read(path.join(directory, "task/config.json"));
  const workflow = read(path.join(directory, "workflow.json")), profile = read(path.join(directory, "profile.json"));
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(config.root_run_id) || config.mode !== "production"
    || manifest.root_run_id !== config.root_run_id || manifest.task_id !== config.task_id
    || config.runtime_sha256 !== manifest.runtime_sha256
    || manifest.policy_sha256 !== manifest.files["task/config.json"]
    || fs.readFileSync(path.join(directory, "task/config.sha256"), "utf8") !== manifest.policy_sha256
    || workflow.metadata?.id !== config.root_run_id || profile.workflow_id !== config.root_run_id || profile.profile_id !== config.root_run_id) throw new Error("prepared task identity mismatch");
  return { config, manifest, manifestSha: e2eFixDigest(manifestBytes), workflow, profile };
}

function requestDigest(payload: any) {
  return creationRequestDigest({ runId: payload.runId, workflowId: payload.workflow_id,
    profile: payload.profile, prompt: payload.prompt, expectedWorkflowRevision: payload.workflow_revision,
    expectedCanonicalHash: payload.canonical_hash, expectedProfileUpdatedAt: payload.profile_updated_at });
}

/** Exactly one create attempt. All later invocations reconcile through GET.
 * A missing root after an uncertain request remains unknown, not unexecuted. */
export async function launchE2eFix(directory: string, managerUrl: string, action: "start" | "reconcile",
  transport: E2eFixLaunchTransport = e2eFixLaunchTransport(managerUrl, process.env.HOMERAIL_DAG_MUTATION_TOKEN ?? "")) {
  if (!["start", "reconcile"].includes(action)) throw new Error("invalid launch action");
  const p = prepared(directory), base = e2eFixManagerUrl(managerUrl);
  const intentFile = path.join(directory, "launch-intent.json"), ackFile = path.join(directory, "launched.json");
  const route = `/api/runs/${encodeURIComponent(p.config.root_run_id)}`;
  const readIntent = () => {
    const intent = read(intentFile), v = intent.payload;
    if (intent.version !== 1 || intent.manager_url !== base || intent.prepared_sha256 !== p.manifestSha
      || v?.runId !== p.config.root_run_id || v.workflow_id !== p.config.root_run_id || v.profile !== p.profile.profile_id
      || v.prompt !== JSON.stringify({ task_id: p.config.task_id })
      || !Number.isSafeInteger(v.workflow_revision) || v.workflow_revision < 1 || !/^[a-f0-9]{64}$/.test(v.canonical_hash)
      || typeof v.profile_updated_at !== "string" || !v.profile_updated_at || intent.request_sha256 !== requestDigest(v)) throw new Error("launch intent identity mismatch");
    return intent;
  };
  const reconcile = async () => {
    if (!fs.existsSync(intentFile)) return { status: "not_submitted", root_run_id: p.config.root_run_id };
    const intent = readIntent();
    const existing = await transport(route);
    if (!existing) return { status: "unknown", root_run_id: p.config.root_run_id, reason: "Creation intent exists but Manager has no observable root; no request was repeated." };
    if (existing.runId !== intent.payload.runId || existing.creationRequestDigest !== intent.request_sha256
      || existing.workflowId !== intent.payload.workflow_id || existing.workflowRevision !== intent.payload.workflow_revision
      || existing.canonicalHash !== intent.payload.canonical_hash) throw new Error("Manager run does not match launch intent (or lacks creation identity support)");
    const receipt = { version: 1, root_run_id: existing.runId, prepared_sha256: p.manifestSha,
      request_sha256: intent.request_sha256, workflow_revision: existing.workflowRevision,
      canonical_hash: existing.canonicalHash, manager_url: base };
    if (!once(ackFile, receipt) && !isDeepStrictEqual(read(ackFile), receipt)) throw new Error("launch receipt changed");
    return { status: "observed", root_run_id: existing.runId, run_status: existing.status };
  };
  if (!fs.existsSync(intentFile) && (fs.existsSync(ackFile) || fs.existsSync(path.join(directory, "task/rounds")))) throw new Error("execution evidence exists without launch intent; investigate instead of recreating");
  if (action === "reconcile" || fs.existsSync(intentFile)) return reconcile();
  const capabilities = await transport("/api/e2e-fix/capabilities");
  if (capabilities?.creation_identity_version !== 1) throw new Error("Manager must support E2E Fix creation identity before starting");
  // Do not adopt an unrelated run with a colliding ID.
  if (await transport(route)) throw new Error("root already exists without this preparation's launch intent");
  const synced = await transport("/api/dag/workflows/sync", { yaml_text: JSON.stringify(p.workflow), source_path: "e2e-fix:" + p.config.task_id });
  const profile = await transport("/api/dag/profiles/sync", { yaml_text: JSON.stringify(p.profile), workflow_id: p.config.root_run_id, source_path: "e2e-fix:" + p.config.task_id });
  if (synced?.workflow?.workflow_id !== p.config.root_run_id || profile?.profile?.profile_id !== p.profile.profile_id
    || profile.profile.workflow_id !== p.config.root_run_id) throw new Error("Manager synced unexpected workflow/profile");
  const payload = { runId: p.config.root_run_id, workflow_id: p.config.root_run_id, profile: p.profile.profile_id,
    prompt: JSON.stringify({ task_id: p.config.task_id }), workflow_revision: synced.workflow.head_revision,
    canonical_hash: synced.workflow.canonical_hash, profile_updated_at: profile.profile.updated_at };
  if (!Number.isSafeInteger(payload.workflow_revision) || payload.workflow_revision < 1
    || !/^[a-f0-9]{64}$/.test(payload.canonical_hash) || typeof payload.profile_updated_at !== "string" || !payload.profile_updated_at) throw new Error("invalid synced revision identity");
  const intent = { version: 1, manager_url: base, prepared_sha256: p.manifestSha, payload, request_sha256: requestDigest(payload) };
  if (!once(intentFile, intent)) return reconcile();
  // Any error after intent publication is conservative unknown. Even a lost
  // successful create response is handled by read-only reconciliation.
  try { await transport("/api/runs/create-and-run", payload); }
  catch { /* The original request may have succeeded. Never resend it here. */ }
  return reconcile();
}
