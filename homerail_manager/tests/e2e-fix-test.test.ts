import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { E2eFixCandidates } from "../src/runtime/e2e-fix-candidates.js";
import { E2eFixIsolatedTest, e2eFixDocker, validateE2eFixTestDefinition, type E2eFixDocker, type E2eFixTestDefinition } from "../src/runtime/e2e-fix-test.js";

const candidate = { task_id: "test", root_run_id: "root", round: 1, plan_sha256: "a".repeat(64), policy_sha256: "b".repeat(64),
  repo: "fixture/repo", base: "c".repeat(40), head: "d".repeat(40), tree: "e".repeat(40) };
const definition = (image = "sha256:" + "f".repeat(64)): E2eFixTestDefinition => ({ id: "regression", image,
  argv: ["node", "/checks/check.cjs"], cwd: ".", timeout_ms: 5000, memory_mb: 256, workspace_mb: 64, cpus: 1, pids_limit: 64,
  files: { "check.cjs": "require('node:assert/strict').equal(require('/work/sum.cjs')(2,3),5);console.log('assertion reached');" } });

class DockerFixture {
  calls: string[][] = [];
  container: any;
  lostCreateAck = false;
  disconnected = false;
  incompleteCapture = false;
  code = 0;
  docker: E2eFixDocker = args => {
    this.calls.push(args);
    if (this.disconnected) return { status: 1, stdout: "", stderr: "Cannot connect to Docker daemon" };
    if (args[1] === "inspect") return this.container ? { status: 0, stdout: JSON.stringify([this.container]), stderr: "" }
      : { status: 1, stdout: "", stderr: "Error: No such container: " + args[2] };
    if (args[1] === "create") {
      const value = (flag: string) => args[args.indexOf(flag) + 1];
      const imageIndex = args.findIndex(v => /^sha256:/.test(v));
      this.container = { Id: "1".repeat(64), Image: args[imageIndex], Config: { User: value("--user"), Entrypoint: [value("--entrypoint")], Cmd: args.slice(imageIndex + 1),
        Labels: { "homerail.e2e.intent": value("--label").split("=")[1] } },
        HostConfig: { NetworkMode: value("--network"), ReadonlyRootfs: true, Privileged: false, CapDrop: ["ALL"], SecurityOpt: ["no-new-privileges"], LogConfig: { Type: "none" },
          Memory: Number.parseInt(value("--memory")) * 1024 * 1024, PidsLimit: Number(value("--pids-limit")), NanoCpus: Number(value("--cpus")) * 1e9 },
        Mounts: args.flatMap((v, i) => v === "--mount" ? [args[i + 1]] : []).map(v => {
          const parts = Object.fromEntries(v.split(",").map(x => x.split("="))); return { Type: parts.type, Source: parts.src, Destination: parts.dst, RW: false };
        }), State: { Status: "created", Running: false } };
      return { status: this.lostCreateAck ? null : 0, stdout: this.lostCreateAck ? "" : this.container.Id,
        stderr: "", ...(this.lostCreateAck ? { error: "acknowledgement lost" } : {}) };
    }
    if (args[1] === "start") {
      this.container.State = { Status: "exited", Running: false, ExitCode: this.code, OOMKilled: false, Error: "",
        StartedAt: new Date().toISOString(), FinishedAt: new Date().toISOString() };
      return { status: 0, stdout: "actual test stdout\n", stderr: "", ...(this.incompleteCapture ? { error: "connection lost" } : {}) };
    }
    throw new Error(`unexpected Docker operation ${args.join(" ")}`);
  };
}

describe.skipIf(process.platform !== "linux")("isolated test stage contract", () => {
  let root: string;
  let snapshot: string;
  let boundCandidate: typeof candidate;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "homerail-e2e-test-")); const source = path.join(root, "source"); fs.mkdirSync(source);
    const git = (...args: string[]) => { const r = spawnSync("git", ["-C", source, ...args], { encoding: "utf8" }); if (r.status !== 0) throw new Error(r.stderr); return r.stdout.trim(); };
    git("init"); git("config", "user.name", "fixture"); git("config", "user.email", "fixture@example.invalid");
    fs.writeFileSync(path.join(source, "sum.cjs"), "module.exports=(a,b)=>a+b;"); git("add", "."); git("-c", "commit.gpgsign=false", "commit", "-m", "base");
    const base = git("rev-parse", "HEAD"); const tree = git("rev-parse", "HEAD^{tree}");
    const store = new E2eFixCandidates(path.join(root, "private")); store.seed(source, base);
    snapshot = store.snapshot(tree); boundCandidate = { ...candidate, base, head: base, tree };
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));
  function job(docker: DockerFixture) { return new E2eFixIsolatedTest(path.join(root, "job"), { candidate: boundCandidate, definition: definition(), snapshot, candidate_store: path.join(root, "private") }, docker.docker); }
  it("reconciles a lost create acknowledgement and reuses completed results", () => {
    const docker = new DockerFixture(); docker.lostCreateAck = true; const stage = job(docker);
    const result = stage.run(); expect(result.result).toBe("passed"); expect(stage.run()).toEqual(result);
    expect(docker.calls.filter(c => c[1] === "create")).toHaveLength(1);
    expect(docker.calls.filter(c => c[1] === "start")).toHaveLength(1);
    expect(docker.calls.find(c => c[1] === "create")).toContain("none");
  });
  it("does not turn daemon unavailability into container absence or retry creation", () => {
    const docker = new DockerFixture(); docker.disconnected = true;
    expect(() => job(docker).run()).toThrow(/observation/);
    expect(docker.calls.some(c => c[1] === "create")).toBe(false);
  });
  it("does not call start again when an existing execution lacks complete capture", () => {
    const docker = new DockerFixture(); const stage = job(docker); stage.run();
    fs.unlinkSync(path.join(root, "job", "receipt.json")); fs.unlinkSync(path.join(root, "job", "receipt.sha256"));
    fs.unlinkSync(path.join(root, "job", "capture.json"));
    expect(() => stage.run()).toThrow(/attachment lost/);
    expect(docker.calls.filter(c => c[1] === "start")).toHaveLength(1);
  });
  it("an incomplete output capture cannot pass even when the container exits zero", () => {
    const docker = new DockerFixture(); docker.incompleteCapture = true;
    expect(job(docker).run()).toMatchObject({ result: "interrupted", exit_code: 0 });
  });
  it.each([[], "npm ci", ["npm", ""], ["npm", "ci\0"]].map(setup => ({ setup })))("rejects malformed setup argv $setup before execution", ({ setup }) => {
    expect(() => validateE2eFixTestDefinition({ ...definition(), setup_argv: setup as string[] })).toThrow(/invalid frozen/);
  });
  it("rejects a changed setup command before any Docker operation", () => {
    const docker = new DockerFixture();
    const intent = { candidate: boundCandidate, definition: { ...definition(), setup_argv: ["npm", "ci", "--offline"] }, snapshot, candidate_store: path.join(root, "private") };
    const stage = new E2eFixIsolatedTest(path.join(root, "setup-job"), intent, docker.docker);
    intent.definition.setup_argv = ["node", "-e", "process.exit(0)"];
    expect(() => stage.run()).toThrow(/test intent changed/);
    expect(docker.calls).toHaveLength(0);
  });
  it("rejects drift of frozen tests before any Docker operation", () => {
    const docker = new DockerFixture(); const stage = job(docker);
    const file = path.join(stage.checks, "check.cjs"); fs.chmodSync(file, 0o644); fs.writeFileSync(file, "process.exit(0)");
    expect(() => stage.run()).toThrow(/definition changed/); expect(docker.calls).toHaveLength(0);
  });
  it("rejects changed completion receipts and logs", () => {
    const docker = new DockerFixture(); const stage = job(docker); stage.run();
    fs.appendFileSync(path.join(root, "job", "receipt.json"), " "); expect(() => stage.run()).toThrow(/evidence changed/);
  });
  it("repairs a missing receipt pin using original container evidence without another start", () => {
    const docker = new DockerFixture(); const stage = job(docker); const receipt = stage.run();
    fs.unlinkSync(path.join(root, "job", "receipt.sha256"));
    expect(stage.run()).toEqual(receipt);
    expect(docker.calls.filter(c => c[1] === "start")).toHaveLength(1);
  });
  it("rejects source bytes that do not match the candidate Git tree before starting Docker", () => {
    const docker = new DockerFixture(); const stage = job(docker); const file = path.join(snapshot, "sum.cjs");
    fs.chmodSync(file, 0o644); fs.writeFileSync(file, "forged source");
    expect(() => stage.run()).toThrow(/snapshot/); expect(docker.calls).toHaveLength(0);
  });
  it("rejects a container with matching labels but weaker isolation", () => {
    const docker = new DockerFixture(); const stage = job(docker); stage.run();
    fs.unlinkSync(path.join(root, "job", "receipt.json")); docker.container.HostConfig.NetworkMode = "host";
    expect(() => stage.run()).toThrow(/isolation/);
  });
});

describe.skipIf(process.platform !== "linux" || !process.env.HOMERAIL_E2E_FIX_TEST_IMAGE)("real Docker frozen candidate test proof", () => {
  it("reproduces the baseline failure, passes the Git candidate and protects test custody", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "homerail-e2e-docker-proof-"));
    const jobs: E2eFixIsolatedTest[] = [];
    try {
      const repo = path.join(root, "repo"); fs.mkdirSync(repo);
      const git = (...args: string[]) => {
        const r = spawnSync("git", ["-C", repo, ...args], { encoding: "utf8" }); if (r.status !== 0) throw new Error(r.stderr); return r.stdout.trim();
      };
      git("init"); git("config", "user.name", "fixture"); git("config", "user.email", "fixture@example.invalid");
      fs.writeFileSync(path.join(repo, "sum.cjs"), "module.exports=(a,b)=>a-b;\n"); git("add", "."); git("-c", "commit.gpgsign=false", "commit", "-m", "base");
      const base = git("rev-parse", "HEAD"); const baseTree = git("rev-parse", "HEAD^{tree}");
      const candidates = new E2eFixCandidates(path.join(root, "private")); candidates.seed(repo, base);
      const repaired = candidates.capture({ ...candidate, base, parent: base, allowed_paths: ["sum.cjs"], protected_paths: [], summary: "fix actual assertion",
        edits: [{ path: "sum.cjs", old: "a-b", new: "a+b" }] });
      const def = definition(process.env.HOMERAIL_E2E_FIX_TEST_IMAGE);
      def.files["check.cjs"] = `const fs=require('fs'),a=require('node:assert/strict');
        a.equal(process.env.HOMERAIL_SECRET_CANARY,undefined);
        a.equal(fs.existsSync('/var/run/docker.sock'),false);
        a.throws(()=>fs.writeFileSync('/checks/check.cjs','forged'));
        a.throws(()=>fs.writeFileSync('/candidate/sum.cjs','forged'));
        a.equal(require('/work/sum.cjs')(2,3),5);console.log('trusted checks reached completion');`;
      const receipts = [];
      for (const [index, value] of [{ ...candidate, base, head: base, tree: baseTree }, repaired].entries()) {
        const snapshot = candidates.snapshot(value.tree);
        const stage = new E2eFixIsolatedTest(path.join(root, `test-${index}`), { candidate: value, definition: def, snapshot, candidate_store: candidates.directory }); jobs.push(stage);
        const receipt = stage.run(); candidates.verifySnapshot(value.tree, snapshot); receipts.push(receipt);
        expect(stage.run()).toEqual(receipt);
      }
      const destination = process.env.HOMERAIL_E2E_FIX_EVIDENCE_DIR;
      if (destination) {
        const target = path.join(destination, "docker-isolation", path.basename(root)); fs.mkdirSync(target, { recursive: true });
        fs.writeFileSync(path.join(target, "proof.json"), JSON.stringify({ scope: "real Git + Docker tests; no model or GitHub", base, repaired, receipts }));
        for (let i = 0; i < jobs.length; i++) fs.cpSync(jobs[i].directory, path.join(target, `test-${i}`), { recursive: true });
      }
      expect(receipts[0]).toMatchObject({ result: "failed", exit_code: 1 });
      expect(receipts[1]).toMatchObject({ result: "passed", exit_code: 0, candidate: repaired });
    } finally {
      for (const stage of jobs) e2eFixDocker(["container", "rm", "--force", stage.name]);
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 30000);
});
