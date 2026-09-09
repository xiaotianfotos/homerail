import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { E2eFixCandidateSchema, type E2eFixCandidate } from "homerail-protocol";
import { E2eFixCandidates, e2eFixDigest, e2eFixPath, immutableE2eFixFile } from "./e2e-fix-candidates.js";

export interface E2eFixTestDefinition {
  id: string; image: string; argv: string[]; cwd: string; timeout_ms: number;
  /** Trusted test files, outside the candidate and never taken from a handoff. */
  files: Record<string, string>;
  /** Optional dependency snapshot baked into the frozen image from trusted base. */
  workspace_template?: string;
  /** Optional frozen dependency/setup command; a nonzero exit is infrastructure failure. */
  setup_argv?: string[];
  memory_mb: number; workspace_mb: number; cpus: number; pids_limit: number;
}
export interface E2eFixTestIntent {
  candidate: E2eFixCandidate; definition: E2eFixTestDefinition; snapshot: string; candidate_store: string;
  attempt?: number;
}
export interface E2eFixTestReceipt {
  candidate: E2eFixCandidate; check_id: string; execution_id: string; spec_digest: string;
  container_id: string; image: string; result: "passed" | "failed" | "unknown" | "interrupted";
  exit_code: number | null; signal: string | null; log_digest: string; error?: string;
  state: unknown; started_at: string; finished_at: string;
}
export interface DockerReply { status: number | null; stdout: string; stderr: string; error?: string }
export type E2eFixDocker = (args: string[], timeout?: number) => DockerReply;
export const e2eFixDocker: E2eFixDocker = (args, timeout = 30000) => {
  const r = spawnSync("docker", args, { encoding: "utf8", timeout, maxBuffer: 4 * 1024 * 1024 });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "", ...(r.error ? { error: r.error.message } : {}) };
};

// The trusted bootstrap copies source into tmpfs for build outputs. Only the
// copy is writable; tests, source evidence and all host custody remain outside.
const BOOTSTRAP = `import fs from 'node:fs';import path from 'node:path';import {spawnSync} from 'node:child_process';
const d=JSON.parse(fs.readFileSync('/checks/definition.json','utf8'));
const env={PATH:'/usr/local/bin:/usr/bin:/bin',HOME:'/tmp',TMPDIR:'/tmp',CI:'1',NPM_CONFIG_OFFLINE:'true'};
const run=argv=>spawnSync(argv[0],argv.slice(1),{cwd:path.join('/work',d.cwd),stdio:'inherit',env});
try {
  if(d.workspace_template)fs.cpSync(d.workspace_template,'/work',{recursive:true,dereference:false});
  fs.cpSync('/candidate','/work',{recursive:true,force:true});
  function writable(dir){for(const e of fs.readdirSync(dir,{withFileTypes:true})){const p=path.join(dir,e.name);if(e.isDirectory())writable(p);else if(e.isFile())fs.chmodSync(p,fs.statSync(p).mode|0o200);}}
  writable('/work');
  if(d.setup_argv){const r=run(d.setup_argv);if(r.error||r.signal||r.status!==0)throw new Error('setup command failed: '+(r.error?.message||r.signal||r.status));}
} catch(error){console.error('trusted test preparation failed',error?.message||String(error));process.exit(125);}
const r=run(d.argv);
if(r.error||r.signal){console.error('trusted test command did not complete',r.error?.message||r.signal);process.exit(125);}
process.exit(r.status??125);\n`;


export function validateE2eFixTestDefinition(d: E2eFixTestDefinition): void {
  const validArgv = (argv: unknown): argv is string[] => Array.isArray(argv) && argv.length > 0 && argv.length <= 100
    && argv.every(a => typeof a === "string" && a.length > 0 && !a.includes("\0"));
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(d.id) || !/^sha256:[a-f0-9]{64}$/.test(d.image)
    || !validArgv(d.argv) || (d.setup_argv !== undefined && !validArgv(d.setup_argv))
    || !Number.isSafeInteger(d.timeout_ms) || d.timeout_ms < 100 || d.timeout_ms > 3_600_000
    || !Number.isSafeInteger(d.memory_mb) || d.memory_mb < 64 || d.memory_mb > 16384
    || !Number.isSafeInteger(d.workspace_mb) || d.workspace_mb < 16 || d.workspace_mb > 16384
    || !Number.isFinite(d.cpus) || d.cpus < 0.1 || d.cpus > 16
    || !Number.isSafeInteger(d.pids_limit) || d.pids_limit < 8 || d.pids_limit > 2048) throw new Error("invalid frozen test definition");
  if (d.cwd !== ".") e2eFixPath(d.cwd);
  if (d.workspace_template && (!d.workspace_template.startsWith("/opt/") || d.workspace_template.includes(".."))) throw new Error("invalid frozen image template");
  if (!d.files || Object.keys(d.files).length > 50 || Buffer.byteLength(JSON.stringify(d.files)) > 1_000_000) throw new Error("invalid trusted test files");
  for (const [name, content] of Object.entries(d.files)) {
    e2eFixPath(name);
    if (["definition.json", "bootstrap.mjs"].includes(name) || typeof content !== "string") throw new Error("reserved test artifact");
  }
}

/** One isolated test stage, not a repair controller. Docker is reached only
 * from a trusted host. Passing attests command execution, not proof that every
 * possible assertion was reached or that candidate semantics are correct. */
export class E2eFixIsolatedTest {
  readonly executionId: string;
  readonly name: string;
  readonly digest: string;
  readonly checks: string;
  constructor(readonly directory: string, readonly intent: E2eFixTestIntent, private readonly docker: E2eFixDocker = e2eFixDocker) {
    if (process.platform !== "linux") throw new Error("isolated E2E Fix tests require Linux");
    E2eFixCandidateSchema.parse(intent.candidate); validateE2eFixTestDefinition(intent.definition);
    if (intent.attempt !== undefined && (!Number.isSafeInteger(intent.attempt) || intent.attempt < 1 || intent.attempt > 3)) throw new Error("invalid test attempt");
    if (!path.isAbsolute(directory) || !path.isAbsolute(intent.snapshot) || intent.snapshot.includes(",")) throw new Error("invalid test artifact location");
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (!fs.lstatSync(directory).isDirectory() || (fs.statSync(directory).mode & 0o077)) throw new Error("test directory must be private");
    this.digest = e2eFixDigest(JSON.stringify({ ...intent, bootstrap: e2eFixDigest(BOOTSTRAP) }));
    this.executionId = this.digest;
    this.name = "hr-e2e-test-" + this.digest.slice(0, 40);
    this.checks = path.join(directory, "checks");
    immutableE2eFixFile(path.join(directory, "intent.json"), JSON.stringify({ ...intent, bootstrap_sha256: e2eFixDigest(BOOTSTRAP), spec_digest: this.digest }));
    for (const [name, bytes] of Object.entries({ ...intent.definition.files, "definition.json": JSON.stringify(intent.definition), "bootstrap.mjs": BOOTSTRAP })) {
      const file = path.join(this.checks, name);
      immutableE2eFixFile(file, bytes);
      fs.chmodSync(file, 0o444);
      for (let dir = path.dirname(file); dir.startsWith(this.checks); dir = path.dirname(dir)) fs.chmodSync(dir, 0o755);
    }
  }
  private inspect(): any | undefined {
    const result = this.docker(["container", "inspect", this.name]);
    if (result.status !== 0) {
      // Only the daemon's explicit absence response allows creation. A timeout
      // or disconnected daemon is UNKNOWN, never an absent container.
      if (!result.error && /No such (object|container):/.test(result.stderr)) return undefined;
      throw new Error("Docker observation unavailable");
    }
    const rows = JSON.parse(result.stdout);
    if (!Array.isArray(rows) || rows.length !== 1) throw new Error("ambiguous Docker observation");
    return rows[0];
  }
  private args(): string[] {
    const d = this.intent.definition;
    return ["container", "create", "--name", this.name, "--label", `homerail.e2e.intent=${this.digest}`,
      "--network", "none", "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
      "--user", "65532:65532", "--pids-limit", String(d.pids_limit), "--memory", `${d.memory_mb}m`, "--cpus", String(d.cpus),
      "--tmpfs", "/tmp:rw,nosuid,nodev,size=64m,mode=1777", "--tmpfs", `/work:rw,nosuid,nodev,exec,size=${d.workspace_mb}m,mode=1777`,
      "--mount", `type=bind,src=${this.intent.snapshot},dst=/candidate,readonly`,
      "--mount", `type=bind,src=${this.checks},dst=/checks,readonly`,
      "--log-driver", "none",
      "--entrypoint", "/usr/bin/env", d.image,
      "-i", "PATH=/usr/local/bin:/usr/bin:/bin", "HOME=/tmp", "node", "/checks/bootstrap.mjs"];
  }
  private verifyContainer(c: any): void {
    const d = this.intent.definition;
    const mounts = c.Mounts ?? [];
    if (!/^[a-f0-9]{64}$/.test(c.Id) || c.Image !== d.image || c.Config?.Labels?.["homerail.e2e.intent"] !== this.digest
      || c.HostConfig?.NetworkMode !== "none" || c.HostConfig?.ReadonlyRootfs !== true || c.HostConfig?.Privileged !== false
      || c.Config?.User !== "65532:65532" || JSON.stringify(c.Config?.Entrypoint) !== '["/usr/bin/env"]'
      || JSON.stringify(c.Config?.Cmd) !== JSON.stringify(this.args().slice(-5))
      || !c.HostConfig.CapDrop?.includes("ALL") || !c.HostConfig.SecurityOpt?.includes("no-new-privileges")
      || (c.HostConfig.CapAdd?.length ?? 0) !== 0 || (c.HostConfig.Devices?.length ?? 0) !== 0
      || (c.HostConfig.DeviceRequests?.length ?? 0) !== 0 || (c.HostConfig.PidMode ?? "") !== ""
      || c.HostConfig.IpcMode === "host" || c.HostConfig.LogConfig?.Type !== "none"
      || c.HostConfig.SecurityOpt.length !== 1
      || c.HostConfig.Memory !== d.memory_mb * 1024 * 1024 || c.HostConfig.PidsLimit !== d.pids_limit
      || c.HostConfig.NanoCpus !== Math.round(d.cpus * 1e9)
      || mounts.filter((m: any) => m.Type === "bind").length !== 2
      || mounts.some((m: any) => m.Type !== "bind" && !(m.Type === "tmpfs" && ["/tmp", "/work"].includes(m.Destination)))
      || !mounts.some((m: any) => m.Type === "bind" && m.Source === this.intent.snapshot && m.Destination === "/candidate" && m.RW === false)
      || !mounts.some((m: any) => m.Type === "bind" && m.Source === this.checks && m.Destination === "/checks" && m.RW === false)) throw new Error("Docker container differs from frozen isolation intent");
  }
  private verifyFiles(): void {
    const candidates = new E2eFixCandidates(this.intent.candidate_store);
    candidates.verifyCandidate(this.intent.candidate);
    candidates.verifySnapshot(this.intent.candidate.tree, this.intent.snapshot);
    for (const [name, bytes] of Object.entries({ ...this.intent.definition.files, "definition.json": JSON.stringify(this.intent.definition), "bootstrap.mjs": BOOTSTRAP })) {
      const file = path.join(this.checks, name);
      if (!fs.lstatSync(file).isFile() || fs.readFileSync(file, "utf8") !== bytes) throw new Error("trusted test definition changed");
    }
  }
  run(): E2eFixTestReceipt {
    if (e2eFixDigest(JSON.stringify({ ...this.intent, bootstrap: e2eFixDigest(BOOTSTRAP) })) !== this.digest) throw new Error("test intent changed");
    this.verifyFiles();
    const receiptFile = path.join(this.directory, "receipt.json");
    if (fs.existsSync(receiptFile) && fs.existsSync(path.join(this.directory, "receipt.sha256"))) {
      const receipt = JSON.parse(fs.readFileSync(receiptFile, "utf8")) as E2eFixTestReceipt;
      if (e2eFixDigest(fs.readFileSync(receiptFile)) !== fs.readFileSync(path.join(this.directory, "receipt.sha256"), "utf8")
        || receipt.spec_digest !== this.digest || receipt.log_digest !== e2eFixDigest(fs.readFileSync(path.join(this.directory, "test.log")))) throw new Error("completed test evidence changed");
      return receipt;
    }
    let container = this.inspect();
    const identityFile = path.join(this.directory, "container.json");
    if (!container) {
      if (fs.existsSync(receiptFile) || fs.existsSync(identityFile) || fs.existsSync(path.join(this.directory, "create-intent.json"))) throw new Error("previous container creation cannot be reconciled");
      immutableE2eFixFile(path.join(this.directory, "create-intent.json"), JSON.stringify({ spec_digest: this.digest }));
      this.docker(this.args()); // Inspect even if acknowledgement was lost.
      container = this.inspect();
      if (!container) throw new Error("container creation outcome unknown");
    }
    this.verifyContainer(container);
    immutableE2eFixFile(identityFile, JSON.stringify({ spec_digest: this.digest, id: container.Id }));
    const startIntent = path.join(this.directory, "start-intent.json");
    if (container.State.Status === "created") {
      if (fs.existsSync(startIntent)) throw new Error("container start acknowledgement lost; outcome unknown");
      immutableE2eFixFile(startIntent, JSON.stringify({ id: container.Id, at: Date.now() }));
      // The host captures actual attached output with a hard byte/time bound.
      // Docker logging is disabled, so rotation cannot silently turn a suffix
      // into purported complete evidence. Lost attachment is explicitly unknown.
      const attached = this.docker(["container", "start", "--attach", container.Id], this.intent.definition.timeout_ms);
      const log = attached.stdout + attached.stderr;
      immutableE2eFixFile(path.join(this.directory, "test.log"), log);
      immutableE2eFixFile(path.join(this.directory, "capture.json"), JSON.stringify({
        spec_digest: this.digest, log_digest: e2eFixDigest(log), complete: !attached.error && attached.status !== null && attached.status >= 0 && attached.status < 125,
        ...(attached.error ? { error: attached.error } : {}), status: attached.status,
      }));
      container = this.inspect();
      if (!container || container.State.Status === "created") throw new Error("container start outcome unknown");
    }
    const captureFile = path.join(this.directory, "capture.json");
    if (!fs.existsSync(captureFile)) throw new Error("test attachment lost; execution will not be replayed");
    const capture = JSON.parse(fs.readFileSync(captureFile, "utf8"));
    const log = fs.readFileSync(path.join(this.directory, "test.log"));
    if (capture.spec_digest !== this.digest || capture.log_digest !== e2eFixDigest(log)) throw new Error("test capture identity mismatch");
    if (container.State.Running) this.docker(["container", "kill", container.Id]);
    container = this.inspect();
    if (!container) throw new Error("test container vanished before evidence collection");
    this.verifyContainer(container); this.verifyFiles();
    if (container.State.Status !== "exited") throw new Error("test container has no terminal execution result");
    const code = container.State.ExitCode;
    const interrupted = !capture.complete || capture.status !== code || container.State.OOMKilled || code === 125 || code >= 128 || !!container.State.Error;
    const receipt: E2eFixTestReceipt = {
      candidate: this.intent.candidate, check_id: this.intent.definition.id, execution_id: this.executionId, spec_digest: this.digest,
      container_id: container.Id, image: container.Image, result: interrupted ? "interrupted" : code === 0 ? "passed" : "failed",
      exit_code: code, signal: interrupted && code >= 128 ? `exit-${code}` : null, log_digest: e2eFixDigest(log),
      ...(interrupted ? { error: !capture.complete ? "test output attachment incomplete" : container.State.Error || "test process interrupted" } : {}),
      state: container.State, started_at: container.State.StartedAt, finished_at: container.State.FinishedAt,
    };
    immutableE2eFixFile(receiptFile, JSON.stringify(receipt));
    immutableE2eFixFile(path.join(this.directory, "receipt.sha256"), e2eFixDigest(JSON.stringify(receipt)));
    return receipt;
  }
}
