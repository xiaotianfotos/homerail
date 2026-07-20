import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("deploys only a successful main CI revision on the isolated deploy runner", () => {
  const workflow = fs.readFileSync(path.join(repoRoot, ".github", "workflows", "deploy-production.yml"), "utf8");
  assert.match(workflow, /workflow_run:/);
  assert.match(workflow, /workflows: \[CI\]/);
  assert.match(workflow, /conclusion == 'success'/);
  assert.match(workflow, /workflow_run\.event == 'push'/);
  assert.match(workflow, /head_branch == 'main'/);
  assert.match(workflow, /head_repository\.full_name == github\.repository/);
  assert.match(workflow, /runs-on: \[self-hosted, Linux, X64, homerail-deploy\]/);
  assert.match(workflow, /ref: \$\{\{ github\.event\.workflow_run\.head_sha/);
  assert.match(workflow, /persist-credentials: false/);
  assert.match(workflow, /cancel-in-progress: false/);
  assert.doesNotMatch(workflow, /cache:\s*npm/);
  assert.doesNotMatch(workflow, /cache-dependency-path:/);
});

test("production deployment is atomic, health checked, and rollback capable", () => {
  const deploy = fs.readFileSync(path.join(repoRoot, "scripts", "deploy-production.sh"), "utf8");
  const service = fs.readFileSync(path.join(repoRoot, "scripts", "run-production-service.sh"), "utf8");
  const runtime = fs.readFileSync(path.join(repoRoot, "scripts", "lib", "production-runtime.sh"), "utf8");
  assert.match(deploy, /flock -w 60/);
  assert.match(deploy, /homerail-worker:production-/);
  assert.match(deploy, /mv -Tf "\$NEXT_LINK" "\$PRODUCTION_ROOT\/current"/);
  assert.match(deploy, /systemctl --user restart/);
  assert.match(deploy, /rolling back/);
  assert.match(deploy, /PREVIOUS_TARGET/);
  assert.match(deploy, /UNIT_BACKUP/);
  assert.match(deploy, /curl -fkSs/);
  assert.match(deploy, /connected_nodes/);
  assert.match(deploy, /grep -Fxl -- "\$old_revision"/);
  assert.match(deploy, /HOMERAIL_PRODUCTION_MANAGER_HOST=\$MANAGER_HOST/);
  assert.match(deploy, /docker network inspect bridge/);
  assert.match(deploy, /\*:\*\) MANAGER_URL_HOST="\[\$MANAGER_HOST\]"/);
  assert.match(deploy, /http:\/\/\$MANAGER_URL_HOST:\$MANAGER_PORT/);
  assert.match(deploy, /requires Docker's default 'bridge' network/);
  assert.match(deploy, /loopback and wildcard binds are not supported/);
  assert.match(deploy, /MANAGER_HOST" != "\$DOCKER_BRIDGE_GATEWAY/);
  assert.match(deploy, /Production Manager may bind only to the Docker bridge gateway/);
  assert.match(deploy, /verify_production_dag_smoke/);
  assert.match(deploy, /Production Docker Worker DAG smoke failed/);
  assert.match(runtime, /smoke dag/);
  assert.match(runtime, /public-two-node\.yaml\.template/);
  assert.match(runtime, /offline-deterministic/);
  assert.match(runtime, /manager\/secrets\/dag-mutation\.token/);
  assert.match(runtime, /Production DAG mutation token is missing after service startup/);
  assert.match(deploy, /HOMERAIL_PRODUCTION_MANAGER_PORT=\$MANAGER_PORT/);
  assert.match(deploy, /HOMERAIL_PRODUCTION_ALLOW_INSECURE_REMOTE_WS:-0/);
  assert.match(deploy, /Environment=HOMERAIL_ALLOW_INSECURE_REMOTE_WS=\$ALLOW_INSECURE_REMOTE_WS/);
  assert.match(deploy, /HOMERAIL_PRODUCTION_UI_HOST=\$UI_HOST/);
  assert.match(deploy, /HOMERAIL_PRODUCTION_UI_PORT=\$UI_PORT/);
  assert.match(deploy, /HOMERAIL_PRODUCTION_UI_HTTP_PORT=\$UI_HTTP_PORT/);
  assert.match(deploy, /must be a LAN-accessible host or address/);
  assert.match(deploy, /HOMERAIL_PRODUCTION_UI_PORT:-19192/);
  assert.match(deploy, /HOMERAIL_HOME="\$\(realpath "\$HOMERAIL_HOME"\)"/);
  assert.match(deploy, /HOMERAIL_CODEX_BIN/);
  assert.match(deploy, /CODEX_BIN="\$\(realpath "\$CODEX_BIN"\)"/);
  assert.match(deploy, /stat -Lc '%u'/);
  assert.match(deploy, /8#022/);
  assert.match(deploy, /runtime\/codex/);
  assert.match(deploy, /exec "\\\$\(dirname "\\\$0"\)\/node" "\$CODEX_BIN" "\\\$@"/);
  assert.doesNotMatch(deploy, /find "\$HOME\/\.nvm/);
  assert.doesNotMatch(deploy, /SERVICE_PATH="\$\(dirname "\$CODEX_BIN"\):\$SERVICE_PATH"/);
  assert.match(deploy, /Environment=PATH=\$SERVICE_PATH/);
  assert.match(service, /HOMERAIL_PRODUCTION_UI_PORT:-19192/);
  assert.match(service, /docker network inspect bridge/);
  assert.match(service, /\*:\*\) MANAGER_URL_HOST="\[\$MANAGER_HOST\]"/);
  assert.match(service, /http:\/\/\$MANAGER_URL_HOST:\$MANAGER_PORT/);
  assert.match(service, /HOMERAIL_MANAGER_HOST="\$MANAGER_HOST"/);
  assert.match(service, /HOMERAIL_PRODUCTION_MANAGER_PUBLIC_URL:-\$MANAGER_URL/);
  assert.match(service, /HOMERAIL_PRODUCTION_ALLOW_INSECURE_REMOTE_WS/);
  assert.match(service, /export HOMERAIL_ALLOW_INSECURE_REMOTE_WS="\$ALLOW_INSECURE_REMOTE_WS"/);
  assert.match(service, /Production Manager must bind the Docker bridge gateway/);
  assert.match(service, /initialize_production_tokens/);
  assert.match(runtime, /node-registration\.token/);
  assert.match(runtime, /worker-registration\.token/);
  assert.match(runtime, /dag-mutation\.token/);
  assert.match(runtime, /randomBytes\(32\)\.toString\("base64url"\)/);
  assert.match(runtime, /chmod 0600 "\$token_file"/);
  assert.match(service, /export HOMERAIL_NODE_TOKEN/);
  assert.match(service, /export HOMERAIL_WORKER_TOKEN/);
  assert.match(service, /export HOMERAIL_DAG_MUTATION_TOKEN/);
  assert.doesNotMatch(service, /export HOMERAIL_CONTROL_PLANE_TOKEN/);
  assert.match(service, /Production UI must bind all interfaces/);
  assert.match(service, /HOMERAIL_UI_SERVE_STATIC=1/);
  assert.match(service, /RELEASE_ROOT="\$\(readlink -f "\$CURRENT"\)"/);
  assert.match(service, /HOMERAIL_REPO_ROOT="\$RELEASE_ROOT"/);
  assert.match(service, /--no-build-worker-image/);
  assert.match(service, /failed three consecutive health checks/);
  assert.match(service, /runtime_has_node/);
  assert.doesNotMatch(service, /homerail-worker:latest/);
});

test("production tokens are distinct, persistent, private, and fail closed", { skip: process.platform === "win32" }, () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "homerail-production-tokens-"));
  const secretDir = path.join(tempRoot, "manager", "secrets");
  const helper = path.join(repoRoot, "scripts", "lib", "production-runtime.sh");
  const initialize = () => spawnSync("bash", [
    "-c",
    'set -euo pipefail; source "$1"; initialize_production_tokens "$2" "$3"; printf "%s\\n%s\\n%s\\n" "$HOMERAIL_NODE_TOKEN" "$HOMERAIL_WORKER_TOKEN" "$HOMERAIL_DAG_MUTATION_TOKEN"',
    "production-token-test",
    helper,
    process.execPath,
    secretDir,
  ], { encoding: "utf8" });

  try {
    const first = initialize();
    assert.equal(first.status, 0, first.stderr);
    const firstTokens = first.stdout.trim().split("\n");
    assert.equal(firstTokens.length, 3);
    assert.equal(new Set(firstTokens).size, 3);
    assert.ok(firstTokens.every((token) => /^[A-Za-z0-9_-]{43}$/.test(token)));
    assert.equal(fs.statSync(secretDir).mode & 0o777, 0o700);
    for (const name of ["node-registration.token", "worker-registration.token", "dag-mutation.token"]) {
      assert.equal(fs.statSync(path.join(secretDir, name)).mode & 0o777, 0o600);
    }

    const second = initialize();
    assert.equal(second.status, 0, second.stderr);
    assert.deepEqual(second.stdout.trim().split("\n"), firstTokens);

    fs.writeFileSync(path.join(secretDir, "node-registration.token"), "");
    const empty = initialize();
    assert.notEqual(empty.status, 0);
    assert.match(empty.stderr, /must not be empty/);
    assert.equal(fs.existsSync(path.join(secretDir, "node-registration.token")), false);

    fs.mkdirSync(path.join(secretDir, "node-registration.token"));
    const directory = initialize();
    assert.notEqual(directory.status, 0);
    assert.match(directory.stderr, /must be a regular file/);

    fs.rmSync(path.join(secretDir, "node-registration.token"), { recursive: true });
    const failedGenerationPath = path.join(secretDir, "failed-generation.token");
    const failedGeneration = spawnSync("bash", [
      "-c",
      'set -euo pipefail; source "$1"; load_or_create_production_token "$2" "$3" "Failure test"',
      "production-token-generation-test",
      helper,
      "/bin/false",
      failedGenerationPath,
    ], { encoding: "utf8" });
    assert.notEqual(failedGeneration.status, 0);
    assert.match(failedGeneration.stderr, /token generation failed/);
    assert.equal(fs.existsSync(failedGenerationPath), false);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("production DAG smoke helper enforces token presence and command success", { skip: process.platform === "win32" }, () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "homerail-production-smoke-"));
  const productionRoot = path.join(tempRoot, "production");
  const home = path.join(tempRoot, "home");
  const current = path.join(productionRoot, "current");
  const capture = path.join(tempRoot, "capture.json");
  const helper = path.join(repoRoot, "scripts", "lib", "production-runtime.sh");
  const fakeNode = path.join(current, "runtime", "node");
  const fakeCli = path.join(current, "homerail_cli", "dist", "cli.js");
  const invoke = (extraEnv = {}) => spawnSync("bash", [
    "-c",
    'source "$1"; verify_production_dag_smoke "$2" "$3" "$4"',
    "production-smoke-test",
    helper,
    productionRoot,
    home,
    "http://127.0.0.1:39191",
  ], { encoding: "utf8", env: { ...process.env, CAPTURE_PATH: capture, ...extraEnv } });

  try {
    fs.mkdirSync(path.dirname(fakeNode), { recursive: true });
    fs.mkdirSync(path.dirname(fakeCli), { recursive: true });
    fs.mkdirSync(path.join(current, "assets", "orchestrations"), { recursive: true });
    fs.writeFileSync(fakeCli, "// fake cli\n");
    fs.writeFileSync(path.join(current, "assets", "orchestrations", "public-two-node.yaml.template"), "schema_version: 1\n");
    fs.writeFileSync(fakeNode, `#!/usr/bin/env bash\nprintf '{"token":"%s","repoRoot":"%s","args":"%s"}\\n' "$HOMERAIL_DAG_MUTATION_TOKEN" "$HOMERAIL_REPO_ROOT" "$*" > "$CAPTURE_PATH"\nexit "${'${FAKE_SMOKE_EXIT:-0}'}"\n`);
    fs.chmodSync(fakeNode, 0o755);

    const missing = invoke();
    assert.notEqual(missing.status, 0);
    assert.match(missing.stderr, /token is missing/);

    const secretDir = path.join(home, "manager", "secrets");
    fs.mkdirSync(secretDir, { recursive: true });
    fs.writeFileSync(path.join(secretDir, "dag-mutation.token"), "test-dag-token\n", { mode: 0o600 });
    const failed = invoke({ FAKE_SMOKE_EXIT: "7" });
    assert.equal(failed.status, 7);

    const passed = invoke();
    assert.equal(passed.status, 0, passed.stderr);
    const observed = JSON.parse(fs.readFileSync(capture, "utf8"));
    assert.equal(observed.token, "test-dag-token");
    assert.equal(observed.repoRoot, current);
    assert.match(observed.args, /--base-url http:\/\/127\.0\.0\.1:39191/);
    assert.match(observed.args, /smoke dag/);
    assert.match(observed.args, /public-two-node\.yaml\.template/);
    assert.match(observed.args, /offline-deterministic/);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("production deployment rolls back a failed DAG smoke and accepts a successful one", { skip: process.platform === "win32" }, () => {
  const deployScript = path.join(repoRoot, "scripts", "deploy-production.sh");
  const revision = "a".repeat(40);
  const previousRevision = "b".repeat(40);

  const runDeployment = (smokeExit) => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "homerail-production-deploy-"));
    const sourceRoot = path.join(tempRoot, "source");
    const productionRoot = path.join(tempRoot, "production");
    const home = path.join(tempRoot, "home");
    const fakeHome = path.join(tempRoot, "user-home");
    const fakeBin = path.join(tempRoot, "bin");
    const resources = path.join(tempRoot, "resources");
    const unitPath = path.join(fakeHome, ".config", "systemd", "user", "homerail-production.service");
    const previousRelease = path.join(productionRoot, "releases", "previous");
    const write = (relative, content, mode) => {
      const target = path.join(sourceRoot, relative);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, content);
      if (mode !== undefined) fs.chmodSync(target, mode);
    };
    const fakeCommand = (name, content) => {
      const target = path.join(fakeBin, name);
      fs.mkdirSync(fakeBin, { recursive: true });
      fs.writeFileSync(target, content);
      fs.chmodSync(target, 0o755);
    };

    fs.mkdirSync(previousRelease, { recursive: true });
    fs.writeFileSync(path.join(previousRelease, "REVISION"), `${previousRevision}\n`);
    fs.symlinkSync("releases/previous", path.join(productionRoot, "current"));
    fs.mkdirSync(path.dirname(unitPath), { recursive: true });
    fs.writeFileSync(unitPath, "previous-unit\n");
    fs.mkdirSync(path.join(home, "manager", "secrets"), { recursive: true });
    fs.writeFileSync(path.join(home, "manager", "secrets", "dag-mutation.token"), "sandbox-token\n", { mode: 0o600 });
    fs.mkdirSync(resources, { recursive: true });

    write("homerail_manager/dist/index.js", "// manager\n");
    write("homerail_node/dist/cli.js", "// node\n");
    write("homerail_cli/dist/cli.js", "process.exit(Number(process.env.FAKE_SMOKE_EXIT || 0));\n");
    write("agent-ui/dist/index.html", "<!doctype html>\n");
    write("homerail_worker/Dockerfile", "FROM scratch\n");
    write("assets/orchestrations/public-two-node.yaml.template", "schema_version: 1\n");
    write("scripts/run-production-service.sh", "#!/usr/bin/env bash\nexit 0\n", 0o755);
    write("scripts/lib/production-runtime.sh", fs.readFileSync(path.join(repoRoot, "scripts", "lib", "production-runtime.sh"), "utf8"), 0o755);

    fakeCommand("docker", `#!/usr/bin/env bash\nif [ "${'${1:-}'}" = network ] && [ "${'${2:-}'}" = inspect ] && [ "${'${3:-}'}" = bridge ]; then echo 172.17.0.1; fi\nexit 0\n`);
    fakeCommand("systemctl", "#!/usr/bin/env bash\nexit 0\n");
    fakeCommand("journalctl", "#!/usr/bin/env bash\nexit 0\n");
    fakeCommand("curl", `#!/usr/bin/env bash\nurl="${'${!#}'}"\ncase "$url" in */runtime/status) printf '{"connected_nodes":1}\\n' ;; esac\nexit 0\n`);
    fakeCommand("rsync", `#!/usr/bin/env bash\nprevious=""\nfor arg in "$@"; do source_path="$previous"; destination="$arg"; previous="$arg"; done\nmkdir -p "$destination"\ncp -a "${'${source_path%/}'}/." "$destination/"\n`);

    const result = spawnSync("bash", [deployScript], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${fakeBin}:${process.env.PATH}`,
        HOME: fakeHome,
        GITHUB_WORKSPACE: sourceRoot,
        HOMERAIL_PRODUCTION_ROOT: productionRoot,
        HOMERAIL_PRODUCTION_HOME: home,
        HOMERAIL_PRODUCTION_RESOURCES: resources,
        HOMERAIL_DEPLOY_REVISION: revision,
        HOMERAIL_PRODUCTION_PUBLIC_HOST: "production.test",
        HOMERAIL_PRODUCTION_ALLOW_INSECURE_REMOTE_WS: "1",
        HOMERAIL_CODEX_BIN: "/bin/true",
        FAKE_SMOKE_EXIT: String(smokeExit),
      },
    });
    return { result, tempRoot, productionRoot, unitPath };
  };

  const failed = runDeployment(7);
  try {
    assert.notEqual(failed.result.status, 0);
    assert.match(failed.result.stderr, /DAG smoke failed/);
    assert.match(failed.result.stderr, /rolling back/);
    assert.equal(fs.readlinkSync(path.join(failed.productionRoot, "current")), "releases/previous");
    assert.equal(fs.readFileSync(failed.unitPath, "utf8"), "previous-unit\n");
    assert.equal(fs.existsSync(path.join(failed.productionRoot, "last-successful-revision")), false);
  } finally {
    fs.rmSync(failed.tempRoot, { recursive: true, force: true });
  }

  const passed = runDeployment(0);
  try {
    assert.equal(passed.result.status, 0, passed.result.stderr);
    assert.equal(fs.readFileSync(path.join(passed.productionRoot, "last-successful-revision"), "utf8"), `${revision}\n`);
    assert.notEqual(fs.readlinkSync(path.join(passed.productionRoot, "current")), "releases/previous");
  } finally {
    fs.rmSync(passed.tempRoot, { recursive: true, force: true });
  }
});

test("tracked deployment configuration contains no machine-local identity", () => {
  const files = [
    ".github/workflows/deploy-production.yml",
    "docs/production-deployment.md",
    "ops/systemd/homerail-deploy-runner.service",
    "scripts/deploy-production.sh",
    "scripts/lib/production-runtime.sh",
    "scripts/run-production-service.sh",
  ];
  const trackedConfiguration = files
    .map((file) => fs.readFileSync(path.join(repoRoot, file), "utf8"))
    .join("\n");
  assert.doesNotMatch(trackedConfiguration, /\b(?:10|192\.168|172\.(?:1[6-9]|2[0-9]|3[01]))\.[0-9]{1,3}\.[0-9]{1,3}\b/);
  assert.doesNotMatch(trackedConfiguration, /\/(?:Users|home|vol[0-9]*|mnt)\//);
  assert.doesNotMatch(trackedConfiguration, /\bssh\s+[A-Za-z0-9._-]+@/i);
});
