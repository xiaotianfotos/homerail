import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("deploys main daily or an owner-dispatched revision on the isolated deploy runner", () => {
  const workflow = fs
    .readFileSync(path.join(repoRoot, ".github", "workflows", "deploy-production.yml"), "utf8")
    .replace(/\r\n/g, "\n");
  assert.match(workflow, /schedule:\n\s+# GitHub cron is UTC/);
  assert.match(workflow, /cron: "30 19 \* \* \*"/);
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /github\.event_name == 'schedule'/);
  assert.match(workflow, /github\.event_name == 'workflow_dispatch' && github\.actor == 'xiaotianfotos'/);
  assert.doesNotMatch(workflow, /workflow_run:/);
  assert.match(workflow, /runs-on: \[self-hosted, Linux, X64, homerail-deploy\]/);
  assert.match(workflow, /ref: \$\{\{ inputs\.revision \|\| 'main' \}\}/);
  assert.match(workflow, /revision="\$\(git rev-parse HEAD\)"/);
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
  assert.match(deploy, /org\.homerail\.worker\.source_fingerprint=\$WORKER_SOURCE_FINGERPRINT/);
  assert.match(deploy, /org\.homerail\.worker\.protocol_version=\$WORKER_CONTRACT_VERSION/);
  assert.match(deploy, /org\.opencontainers\.image\.version=\$WORKER_VERSION/);
  assert.match(deploy, /HOMERAIL_WORKER_SOURCE_FINGERPRINT=\$WORKER_SOURCE_FINGERPRINT/);
  assert.match(deploy, /HOMERAIL_WORKER_PROTOCOL_VERSION=\$WORKER_CONTRACT_VERSION/);
  assert.match(deploy, /HOMERAIL_WORKER_VERSION=\$WORKER_VERSION/);
  assert.match(deploy, /HOMERAIL_WORKER_IMAGE_REVISION=\$REVISION/);
  assert.match(deploy, /HOMERAIL_PRODUCTION_HEALTH_ATTEMPTS:-60/);
  assert.match(deploy, /HOMERAIL_PRODUCTION_HEALTH_ATTEMPTS must be an integer from 1 through 300/);
  assert.match(deploy, /mv -Tf "\$NEXT_LINK" "\$PRODUCTION_ROOT\/current"/);
  assert.match(deploy, /systemctl --user restart/);
  assert.match(deploy, /rolling back/);
  assert.match(deploy, /PREVIOUS_TARGET/);
  assert.match(deploy, /UNIT_BACKUP/);
  assert.match(deploy, /systemctl --user stop "\$SERVICE_NAME"/);
  assert.match(deploy, /DATABASE_BACKUP/);
  assert.match(deploy, /DATABASE_WAL_BACKUP/);
  assert.match(deploy, /PREVIOUS_DATABASE_COMPATIBLE/);
  assert.match(deploy, /refusing an incompatible code rollback/);
  assert.match(deploy, /chmod 700 "\$PRODUCTION_ROOT\/locks"/);
  assert.match(
    deploy,
    /cleanup_deploy_temporaries\(\)[\s\S]*rm -f "\$DATABASE_BACKUP" "\$DATABASE_WAL_BACKUP"/,
  );
  assert.match(deploy, /loginctl show-user "\$DEPLOY_USER" --property=Linger --value/);
  assert.match(deploy, /sudo loginctl enable-linger \$DEPLOY_USER/);
  assert.match(deploy, /StartLimitIntervalSec=0/);
  assert.doesNotMatch(deploy, /StartLimitBurst=/);
  assert.match(deploy, /WorkingDirectory=%h/);
  assert.doesNotMatch(deploy, /WorkingDirectory=\$PRODUCTION_ROOT\/current/);
  assert.doesNotMatch(deploy, /# `current` release/);
  assert.match(
    deploy,
    /ExecStart=\/bin\/bash -c 'release="\\\$HOMERAIL_PRODUCTION_ROOT\/current"; until \[ -x "\\\$release\/scripts\/run-production-service\.sh" \]; do sleep 10; done; cd "\\\$release"; exec "\\\$release\/scripts\/run-production-service\.sh"'/,
  );
  assert.doesNotMatch(deploy, /After=network-online\.target docker\.service/);
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
  assert.match(deploy, /HOMERAIL_PRODUCTION_DAG_COMMAND_ALLOWLIST:-node/);
  assert.match(deploy, /Environment=HOMERAIL_PRODUCTION_DAG_COMMAND_ALLOWLIST=\$DAG_COMMAND_ALLOWLIST/);
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
  assert.match(service, /HOMERAIL_PRODUCTION_DAG_COMMAND_ALLOWLIST:-node/);
  assert.match(service, /export HOMERAIL_DAG_COMMAND_ALLOWLIST="\$DAG_COMMAND_ALLOWLIST"/);
  assert.match(service, /restricted to the built-in node runtime/);
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
  assert.match(service, /export PATH="\$RELEASE_ROOT\/runtime:\$PATH"/);
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
    assert.match(observed.args, /--template assets\/orchestrations\/public-two-node\.yaml\.template/);
    assert.doesNotMatch(observed.args, /--template \/.*public-two-node\.yaml\.template/);
    assert.match(observed.args, /offline-deterministic/);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("production deployment preserves database compatibility across success and rollback", { skip: process.platform === "win32" }, () => {
  const deployScript = path.join(repoRoot, "scripts", "deploy-production.sh");
  const revision = "a".repeat(40);
  const previousRevision = "b".repeat(40);
  const workerFingerprint = "c".repeat(16);

  const runDeployment = (smokeExit, {
    previousDatabaseCompatible = true,
    failUnitMove = false,
    extraEnv = {},
  } = {}) => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "homerail-production-deploy-"));
    const sourceRoot = path.join(tempRoot, "source");
    const productionRoot = path.join(tempRoot, "production");
    const home = path.join(tempRoot, "home");
    const fakeHome = path.join(tempRoot, "user-home");
    const fakeBin = path.join(tempRoot, "bin");
    const resources = path.join(tempRoot, "resources");
    const unitPath = path.join(fakeHome, ".config", "systemd", "user", "homerail-production.service");
    const previousRelease = path.join(productionRoot, "releases", "previous");
    const databasePath = path.join(home, "manager", "homerail.db");
    const dockerBuildArgsPath = path.join(tempRoot, "docker-build-args.txt");
    const dockerRemovalsPath = path.join(tempRoot, "docker-removals.txt");
    const systemctlLogPath = path.join(tempRoot, "systemctl.log");
    const findOutputPath = path.join(tempRoot, "find-output.txt");
    const duplicateOldRelease = path.join(productionRoot, "releases", "duplicate-old");
    const unreferencedOldRelease = path.join(productionRoot, "releases", "unreferenced-old");
    const unreferencedRevision = "d".repeat(40);
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
    fs.mkdirSync(duplicateOldRelease, { recursive: true });
    fs.writeFileSync(path.join(duplicateOldRelease, "REVISION"), `${previousRevision}\n`);
    fs.mkdirSync(unreferencedOldRelease, { recursive: true });
    fs.writeFileSync(path.join(unreferencedOldRelease, "REVISION"), `${unreferencedRevision}\n`);
    fs.writeFileSync(
      findOutputPath,
      [
        `5 ${path.join(productionRoot, "releases", "newest-placeholder")}`,
        `4 ${path.join(productionRoot, "releases", "newer-placeholder")}`,
        `3 ${path.join(productionRoot, "releases", "third-placeholder")}`,
        `2 ${duplicateOldRelease}`,
        `1 ${unreferencedOldRelease}`,
      ].join("\n") + "\n",
    );
    fs.mkdirSync(path.join(previousRelease, "runtime"), { recursive: true });
    fs.symlinkSync(process.execPath, path.join(previousRelease, "runtime", "node"));
    fs.mkdirSync(path.join(previousRelease, "homerail_manager", "dist", "persistence"), { recursive: true });
    fs.writeFileSync(path.join(previousRelease, "homerail_manager", "package.json"), '{"type":"module"}\n');
    fs.writeFileSync(
      path.join(previousRelease, "homerail_manager", "dist", "persistence", "db.js"),
      previousDatabaseCompatible
        ? "export function getDb() {};\nexport function closeDb() {};\n"
        : 'export function getDb() { throw new Error("Database schema version is newer than supported version"); };\nexport function closeDb() {};\n',
    );
    fs.symlinkSync("releases/previous", path.join(productionRoot, "current"));
    fs.mkdirSync(path.dirname(unitPath), { recursive: true });
    fs.writeFileSync(unitPath, "previous-unit\n");
    fs.mkdirSync(path.join(home, "manager", "secrets"), { recursive: true });
    fs.writeFileSync(databasePath, "pre-deployment-database\n", { mode: 0o600 });
    fs.writeFileSync(`${databasePath}-wal`, "pre-deployment-wal\n", { mode: 0o600 });
    fs.writeFileSync(path.join(home, "manager", "secrets", "dag-mutation.token"), "sandbox-token\n", { mode: 0o600 });
    fs.mkdirSync(resources, { recursive: true });

    write("homerail_manager/dist/index.js", "// manager\n");
    write("homerail_manager/package.json", '{"type":"module"}\n');
    write(
      "homerail_manager/dist/server/dag-environment.js",
      `export function dagWorkerSourceFingerprint() { return "${workerFingerprint}"; }\n`,
    );
    write("homerail_node/dist/cli.js", "// node\n");
    write(
      "homerail_cli/dist/cli.js",
      'require("node:fs").appendFileSync(require("node:path").join(process.env.HOMERAIL_PRODUCTION_HOME, "manager", "homerail.db"), "rollout-write\\n");\n'
        + 'require("node:fs").appendFileSync(require("node:path").join(process.env.HOMERAIL_PRODUCTION_HOME, "manager", "homerail.db-wal"), "rollout-wal-write\\n");\n'
        + 'require("node:fs").writeFileSync(require("node:path").join(process.env.HOMERAIL_PRODUCTION_HOME, "manager", "homerail.db-shm"), "rollout-shm\\n");\n'
        + "process.exit(Number(process.env.FAKE_SMOKE_EXIT || 0));\n",
    );
    write("homerail_protocol/package.json", '{"type":"module"}\n');
    write("homerail_protocol/dist/index.js", 'export const WORKER_CONTRACT_VERSION = "1";\n');
    write("homerail_worker/package.json", '{"version":"0.1.0"}\n');
    write("agent-ui/dist/index.html", "<!doctype html>\n");
    write("homerail_worker/Dockerfile", "FROM scratch\n");
    write("assets/orchestrations/public-two-node.yaml.template", "schema_version: 1\n");
    write("scripts/run-production-service.sh", "#!/usr/bin/env bash\nexit 0\n", 0o755);
    write("scripts/lib/production-runtime.sh", fs.readFileSync(path.join(repoRoot, "scripts", "lib", "production-runtime.sh"), "utf8"), 0o755);
    write("scripts/lib/worker-build-network.sh", fs.readFileSync(path.join(repoRoot, "scripts", "lib", "worker-build-network.sh"), "utf8"), 0o755);
    // The shared helper delegates URL validation to this Worker script; the
    // sandbox must stage it at the exact repository-relative path or builds
    // must fail closed instead of silently keeping unknown sources.
    write("homerail_worker/scripts/configure-apt-sources.mjs", fs.readFileSync(path.join(repoRoot, "homerail_worker/scripts/configure-apt-sources.mjs"), "utf8"), 0o755);

    fakeCommand("docker", `#!/usr/bin/env bash\nif [ "${'${1:-}'}" = network ] && [ "${'${2:-}'}" = inspect ] && [ "${'${3:-}'}" = bridge ]; then echo 172.17.0.1; fi\nif [ "${'${1:-}'}" = build ]; then printf '%s\\n' "$@" > "$CAPTURE_DOCKER_BUILD_ARGS"; fi\nif [ "${'${1:-}'}" = image ] && [ "${'${2:-}'}" = rm ]; then printf '%s\\n' "${'${3:-}'}" >> "$CAPTURE_DOCKER_REMOVALS"; fi\nexit 0\n`);
    fakeCommand("codex", "#!/usr/bin/env bash\nexit 0\n");
    fakeCommand("find", "#!/usr/bin/env bash\ncat \"$FAKE_FIND_OUTPUT\"\n");
    fakeCommand("flock", "#!/usr/bin/env bash\nexit 0\n");
    fakeCommand("install", `#!/usr/bin/env bash\nsource_path="${'${3:-}'}"; destination="${'${4:-}'}"; ln -s "$source_path" "$destination"\n`);
    fakeCommand("loginctl", "#!/usr/bin/env bash\nprintf 'yes\\n'\n");
    fakeCommand("mv", `#!/usr/bin/env bash\nif [ "${'${FAIL_UNIT_MOVE:-0}'}" = 1 ] && [[ "${'${1:-}'}" == *.service.tmp ]]; then exit 19; fi\nif [ "${'${1:-}'}" = -Tf ]; then source_path="$2"; destination="$3"; /bin/rm -f "$destination"; exec /bin/mv -f "$source_path" "$destination"; fi\nexec /bin/mv "$@"\n`);
    fakeCommand("stat", `#!/usr/bin/env bash\ncase "${'${2:-}'}" in '%u') id -u ;; '%a') printf '755\\n' ;; *) exit 1 ;; esac\n`);
    fakeCommand("systemctl", "#!/usr/bin/env bash\nprintf '%s\\n' \"$*\" >> \"$CAPTURE_SYSTEMCTL\"\nexit 0\n");
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
        HOMERAIL_PRODUCTION_HEALTH_ATTEMPTS: "1",
        HOMERAIL_CODEX_BIN: path.join(fakeBin, "codex"),
        FAKE_SMOKE_EXIT: String(smokeExit),
        FAIL_UNIT_MOVE: failUnitMove ? "1" : "0",
        CAPTURE_DOCKER_BUILD_ARGS: dockerBuildArgsPath,
        CAPTURE_DOCKER_REMOVALS: dockerRemovalsPath,
        CAPTURE_SYSTEMCTL: systemctlLogPath,
        FAKE_FIND_OUTPUT: findOutputPath,
        HOMERAIL_WORKER_BUILD_APT_MIRROR: "",
        HOMERAIL_WORKER_BUILD_APT_SECURITY_MIRROR: "",
        HOMERAIL_WORKER_BUILD_NPM_REGISTRY: "",
        HOMERAIL_WORKER_BUILD_DSH_GIT_REMOTE: "",
        HTTP_PROXY: "",
        HTTPS_PROXY: "",
        NO_PROXY: "",
        http_proxy: "",
        https_proxy: "",
        no_proxy: "",
        ...extraEnv,
      },
    });
    return {
      result,
      tempRoot,
      productionRoot,
      unitPath,
      databasePath,
      dockerBuildArgsPath,
      dockerRemovalsPath,
      systemctlLogPath,
      duplicateOldRelease,
      unreferencedOldRelease,
      unreferencedRevision,
    };
  };

  const failed = runDeployment(7);
  try {
    assert.notEqual(failed.result.status, 0);
    assert.match(failed.result.stderr, /DAG smoke failed/);
    assert.match(failed.result.stderr, /rolling back/);
    assert.equal(fs.readlinkSync(path.join(failed.productionRoot, "current")), "releases/previous");
    assert.equal(fs.readFileSync(failed.unitPath, "utf8"), "previous-unit\n");
    assert.equal(fs.readFileSync(failed.databasePath, "utf8"), "pre-deployment-database\n");
    assert.equal(fs.readFileSync(`${failed.databasePath}-wal`, "utf8"), "pre-deployment-wal\n");
    assert.equal(fs.existsSync(`${failed.databasePath}-shm`), false);
    assert.equal(fs.existsSync(path.join(failed.productionRoot, "last-successful-revision")), false);
  } finally {
    fs.rmSync(failed.tempRoot, { recursive: true, force: true });
  }

  const incompatible = runDeployment(7, { previousDatabaseCompatible: false });
  try {
    assert.notEqual(incompatible.result.status, 0);
    assert.match(incompatible.result.stderr, /refusing an incompatible code rollback/);
    assert.notEqual(fs.readlinkSync(path.join(incompatible.productionRoot, "current")), "releases/previous");
    assert.equal(fs.readFileSync(incompatible.databasePath, "utf8"), "pre-deployment-database\n");
    assert.equal(fs.readFileSync(`${incompatible.databasePath}-wal`, "utf8"), "pre-deployment-wal\n");
    assert.equal(fs.existsSync(`${incompatible.databasePath}-shm`), false);
    assert.equal(fs.existsSync(path.join(incompatible.productionRoot, "last-successful-revision")), false);
  } finally {
    fs.rmSync(incompatible.tempRoot, { recursive: true, force: true });
  }

  const interrupted = runDeployment(0, { failUnitMove: true });
  try {
    assert.notEqual(interrupted.result.status, 0);
    assert.equal(fs.readlinkSync(path.join(interrupted.productionRoot, "current")), "releases/previous");
    const systemctlLog = fs.readFileSync(interrupted.systemctlLogPath, "utf8");
    assert.match(systemctlLog, /--user stop homerail-production\.service/);
    assert.match(systemctlLog, /--user start homerail-production\.service/);
    const lockEntries = fs.readdirSync(path.join(interrupted.productionRoot, "locks"));
    assert.equal(lockEntries.some((name) => name.startsWith("homerail.db.pre-")), false);
  } finally {
    fs.rmSync(interrupted.tempRoot, { recursive: true, force: true });
  }

  const passed = runDeployment(0);
  try {
    assert.equal(passed.result.status, 0, passed.result.stderr);
    assert.equal(fs.readFileSync(path.join(passed.productionRoot, "last-successful-revision"), "utf8"), `${revision}\n`);
    assert.equal(fs.readFileSync(passed.databasePath, "utf8"), "pre-deployment-database\nrollout-write\n");
    assert.equal(fs.readFileSync(`${passed.databasePath}-wal`, "utf8"), "pre-deployment-wal\nrollout-wal-write\n");
    assert.notEqual(fs.readlinkSync(path.join(passed.productionRoot, "current")), "releases/previous");
    assert.equal(fs.existsSync(passed.duplicateOldRelease), false);
    assert.equal(fs.existsSync(passed.unreferencedOldRelease), false);
    const dockerRemovals = fs.readFileSync(passed.dockerRemovalsPath, "utf8");
    assert.match(dockerRemovals, new RegExp(`homerail-worker:production-${passed.unreferencedRevision.slice(0, 12)}`));
    assert.doesNotMatch(dockerRemovals, new RegExp(`homerail-worker:production-${previousRevision.slice(0, 12)}`));
    const dockerBuildArgs = fs.readFileSync(passed.dockerBuildArgsPath, "utf8");
    assert.match(dockerBuildArgs, new RegExp(`org\\.homerail\\.worker\\.source_fingerprint=${workerFingerprint}`));
    assert.match(dockerBuildArgs, /org\.homerail\.worker\.protocol_version=1/);
    assert.match(dockerBuildArgs, /org\.opencontainers\.image\.version=0\.1\.0/);
    assert.match(dockerBuildArgs, new RegExp(`org\\.opencontainers\\.image\\.revision=${revision}`));
    assert.match(dockerBuildArgs, new RegExp(`HOMERAIL_WORKER_SOURCE_FINGERPRINT=${workerFingerprint}`));
    assert.match(dockerBuildArgs, /HOMERAIL_WORKER_PROTOCOL_VERSION=1/);
    assert.match(dockerBuildArgs, /HOMERAIL_WORKER_VERSION=0\.1\.0/);
    assert.match(dockerBuildArgs, new RegExp(`HOMERAIL_WORKER_IMAGE_REVISION=${revision}`));
    assert.doesNotMatch(dockerBuildArgs, /HOMERAIL_WORKER_BUILD_APT/);
    assert.doesNotMatch(dockerBuildArgs, /NPM_CONFIG_REGISTRY/);
    assert.doesNotMatch(dockerBuildArgs, /HOMERAIL_DSH_FORK_REPOSITORY/);
    assert.doesNotMatch(dockerBuildArgs, /(?:HTTP|HTTPS|NO)_PROXY/i);
    const unit = fs.readFileSync(passed.unitPath, "utf8");
    assert.match(unit, /StartLimitIntervalSec=0/);
    assert.doesNotMatch(unit, /StartLimitBurst=/);
    assert.match(unit, /WorkingDirectory=%h/);
    assert.match(
      unit,
      /ExecStart=\/bin\/bash -c 'release="\$HOMERAIL_PRODUCTION_ROOT\/current"; until \[ -x "\$release\/scripts\/run-production-service\.sh" \]; do sleep 10; done; cd "\$release"; exec "\$release\/scripts\/run-production-service\.sh"'/,
    );
  } finally {
    fs.rmSync(passed.tempRoot, { recursive: true, force: true });
  }

  const customSources = runDeployment(0, {
    extraEnv: {
      HOMERAIL_WORKER_BUILD_APT_MIRROR: "https://deb.fn.example/debian/",
      HOMERAIL_WORKER_BUILD_APT_SECURITY_MIRROR: "https://deb.fn.example/debian-security",
      HOMERAIL_WORKER_BUILD_NPM_REGISTRY: "https://npm.fn.example",
      HOMERAIL_WORKER_BUILD_DSH_GIT_REMOTE: "https://git.fn.example/deepseek-harness.git",
    },
  });
  try {
    assert.equal(customSources.result.status, 0, customSources.result.stderr);
    const customBuildArgs = fs.readFileSync(customSources.dockerBuildArgsPath, "utf8");
    assert.match(customBuildArgs, /--build-arg\nHOMERAIL_WORKER_BUILD_APT_MIRROR=https:\/\/deb\.fn\.example\/debian\n/);
    assert.match(customBuildArgs, /--build-arg\nHOMERAIL_WORKER_BUILD_APT_SECURITY_MIRROR=https:\/\/deb\.fn\.example\/debian-security\n/);
    assert.match(customBuildArgs, /--build-arg\nNPM_CONFIG_REGISTRY=https:\/\/npm\.fn\.example\n/);
    assert.match(customBuildArgs, /--build-arg\nHOMERAIL_DSH_FORK_REPOSITORY=https:\/\/git\.fn\.example\/deepseek-harness\.git\n/);
    assert.match(customBuildArgs, new RegExp(`HOMERAIL_WORKER_SOURCE_FINGERPRINT=${workerFingerprint}`));
  } finally {
    fs.rmSync(customSources.tempRoot, { recursive: true, force: true });
  }

  const proxyForwarding = runDeployment(0, {
    extraEnv: {
      HTTPS_PROXY: "http://proxy.fn.example:3128",
      http_proxy: "http://proxy.fn.example:3128",
      NO_PROXY: "localhost",
      HTTP_PROXY: " \t ",
      https_proxy: "\n ",
      no_proxy: "   ",
    },
  });
  try {
    assert.equal(proxyForwarding.result.status, 0, proxyForwarding.result.stderr);
    const proxyBuildArgs = fs.readFileSync(proxyForwarding.dockerBuildArgsPath, "utf8");
    const proxyArgLines = proxyBuildArgs.split("\n");
    const valuelessProxyArgs = [];
    for (let index = 0; index < proxyArgLines.length - 1; index += 1) {
      if (proxyArgLines[index] === "--build-arg" && !proxyArgLines[index + 1].includes("=")) {
        valuelessProxyArgs.push(proxyArgLines[index + 1]);
      }
    }
    assert.deepEqual(valuelessProxyArgs, ["HTTPS_PROXY", "NO_PROXY", "http_proxy"]);
    assert.doesNotMatch(proxyBuildArgs, /proxy\.fn\.example/);
  } finally {
    fs.rmSync(proxyForwarding.tempRoot, { recursive: true, force: true });
  }

  const invalidSource = runDeployment(0, {
    extraEnv: { HOMERAIL_WORKER_BUILD_NPM_REGISTRY: "ftp://npm.fn.example" },
  });
  try {
    assert.notEqual(invalidSource.result.status, 0);
    assert.match(invalidSource.result.stderr, /HOMERAIL_WORKER_BUILD_NPM_REGISTRY/);
    assert.doesNotMatch(invalidSource.result.stderr, /ftp:\/\/npm\.fn\.example/);
    assert.equal(fs.existsSync(invalidSource.dockerBuildArgsPath), false);
  } finally {
    fs.rmSync(invalidSource.tempRoot, { recursive: true, force: true });
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


test("worker build network contract is shared by production and live entry points", () => {
  const helper = fs.readFileSync(path.join(repoRoot, "scripts", "lib", "worker-build-network.sh"), "utf8");
  const deploy = fs.readFileSync(path.join(repoRoot, "scripts", "deploy-production.sh"), "utf8");
  const runner = fs.readFileSync(path.join(repoRoot, "scripts", "run-dag-patterns-live-runner.sh"), "utf8");

  assert.match(deploy, /source "\$SOURCE_ROOT\/scripts\/lib\/worker-build-network\.sh"/);
  assert.match(deploy, /homerail_worker_build_network_args/);
  assert.match(deploy, /HOMERAIL_WORKER_BUILD_NETWORK_ARGS/);
  assert.match(runner, /source "\$REPO_ROOT\/scripts\/lib\/worker-build-network\.sh"/);
  assert.match(runner, /homerail_worker_build_network_args/);
  assert.match(runner, /HOMERAIL_WORKER_BUILD_NETWORK_ARGS/);
  assert.doesNotMatch(helper, /\beval\b/);
  assert.doesNotMatch(deploy, /\beval\b/);
  assert.doesNotMatch(runner, /\beval\b/);
  for (const name of [
    "HOMERAIL_WORKER_BUILD_APT_MIRROR",
    "HOMERAIL_WORKER_BUILD_APT_SECURITY_MIRROR",
    "HOMERAIL_WORKER_BUILD_NPM_REGISTRY",
    "HOMERAIL_WORKER_BUILD_DSH_GIT_REMOTE",
  ]) {
    assert.ok(helper.includes(name), `helper must consume ${name}`);
  }
  assert.ok(
    helper.includes("HTTP_PROXY HTTPS_PROXY NO_PROXY http_proxy https_proxy no_proxy"),
    "helper must forward every recognized proxy variable name in a fixed order",
  );
  assert.match(helper, /NPM_CONFIG_REGISTRY=/);
  assert.match(helper, /HOMERAIL_DSH_FORK_REPOSITORY=/);
});

test("worker build network helper validates sources and forwards proxy names only", { skip: process.platform === "win32" }, () => {
  const helperPath = path.join(repoRoot, "scripts", "lib", "worker-build-network.sh");
  const runHelper = (extraEnv = {}) => spawnSync("bash", [
    "-c",
    [
      "set -euo pipefail",
      'source "$1"',
      "homerail_worker_build_network_args || exit 1",
      'if [ ${#HOMERAIL_WORKER_BUILD_NETWORK_ARGS[@]} -gt 0 ]; then printf "%s\\n" "${HOMERAIL_WORKER_BUILD_NETWORK_ARGS[@]}"; fi',
    ].join("\n"),
    "worker-build-network-helper-test",
    helperPath,
  ], { encoding: "utf8", env: { PATH: process.env.PATH, ...extraEnv } });

  const baseline = runHelper();
  assert.equal(baseline.status, 0, baseline.stderr);
  assert.equal(baseline.stdout, "");

  const whitespaceOnly = runHelper({ HOMERAIL_WORKER_BUILD_APT_MIRROR: " \t " });
  assert.equal(whitespaceOnly.status, 0, whitespaceOnly.stderr);
  assert.equal(whitespaceOnly.stdout, "");

  const whitespaceOnlyProxy = runHelper({
    HTTP_PROXY: " \t ",
    https_proxy: "\n  ",
    NO_PROXY: "   ",
  });
  assert.equal(whitespaceOnlyProxy.status, 0, whitespaceOnlyProxy.stderr);
  assert.equal(whitespaceOnlyProxy.stdout, "");

  const custom = runHelper({
    HOMERAIL_WORKER_BUILD_APT_MIRROR: "HTTPS://DEB.example.com:8443/debian/",
    HOMERAIL_WORKER_BUILD_APT_SECURITY_MIRROR: "  https://deb.example.com/debian-security  ",
    HOMERAIL_WORKER_BUILD_NPM_REGISTRY: "https://npm.example.com/",
    HOMERAIL_WORKER_BUILD_DSH_GIT_REMOTE: "https://git.example.com/deepseek-harness.git/",
    HTTP_PROXY: "http://proxy.example:3128",
    no_proxy: "localhost",
    HTTPS_PROXY: "",
  });
  assert.equal(custom.status, 0, custom.stderr);
  assert.deepEqual(custom.stdout.trim().split("\n"), [
    "--build-arg",
    "HOMERAIL_WORKER_BUILD_APT_MIRROR=https://deb.example.com:8443/debian",
    "--build-arg",
    "HOMERAIL_WORKER_BUILD_APT_SECURITY_MIRROR=https://deb.example.com/debian-security",
    "--build-arg",
    "NPM_CONFIG_REGISTRY=https://npm.example.com",
    "--build-arg",
    "HOMERAIL_DSH_FORK_REPOSITORY=https://git.example.com/deepseek-harness.git",
    "--build-arg",
    "HTTP_PROXY",
    "--build-arg",
    "no_proxy",
  ]);
  assert.doesNotMatch(custom.stdout, /proxy\.example/);

  // A NODE_BIN shim captures the exact argv handed to Node: only environment
  // variable names and the helper path may cross the boundary, never values.
  const argvCaptureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "homerail-build-network-argv-"));
  const argvLog = path.join(argvCaptureRoot, "node-argv.txt");
  const nodeShim = path.join(argvCaptureRoot, "node");
  fs.writeFileSync(
    nodeShim,
    `#!/usr/bin/env bash
printf '%s\\n' "$@" >> "$ARGV_LOG"
exec "${process.execPath}" "$@"
`,
    { mode: 0o755 },
  );
  try {
    const shimmed = runHelper({
      NODE_BIN: nodeShim,
      ARGV_LOG: argvLog,
      HOMERAIL_WORKER_BUILD_APT_MIRROR: "https://deb.example.com/debian/",
      HOMERAIL_WORKER_BUILD_NPM_REGISTRY: "https://npm.example.com/",
      HOMERAIL_WORKER_BUILD_DSH_GIT_REMOTE: "https://git.example.com/deepseek-harness.git/",
      HTTPS_PROXY: "http://proxy.example:3128",
    });
    assert.equal(shimmed.status, 0, shimmed.stderr);
    assert.deepEqual(shimmed.stdout.trim().split("\n"), [
      "--build-arg",
      "HOMERAIL_WORKER_BUILD_APT_MIRROR=https://deb.example.com/debian",
      "--build-arg",
      "NPM_CONFIG_REGISTRY=https://npm.example.com",
      "--build-arg",
      "HOMERAIL_DSH_FORK_REPOSITORY=https://git.example.com/deepseek-harness.git",
      "--build-arg",
      "HTTPS_PROXY",
    ]);
    const capturedArgv = fs.readFileSync(argvLog, "utf8");
    assert.match(capturedArgv, /--print-env/);
    assert.match(capturedArgv, /configure-apt-sources\.mjs/);
    for (const expected of [
      "HOMERAIL_WORKER_BUILD_APT_MIRROR",
      "HOMERAIL_WORKER_BUILD_APT_SECURITY_MIRROR",
      "HOMERAIL_WORKER_BUILD_NPM_REGISTRY",
      "HOMERAIL_WORKER_BUILD_DSH_GIT_REMOTE",
    ]) {
      assert.ok(capturedArgv.includes(expected), `delegation must name ${expected} only`);
    }
    for (const prohibited of [
      "https://deb.example.com/debian/",
      "https://npm.example.com/",
      "https://git.example.com/deepseek-harness.git/",
      "http://proxy.example:3128",
    ]) {
      assert.ok(!capturedArgv.includes(prohibited), "source and proxy values must never reach argv");
    }
  } finally {
    fs.rmSync(argvCaptureRoot, { recursive: true, force: true });
  }

  const invalidValues = {
    HOMERAIL_WORKER_BUILD_APT_MIRROR: [
      "ftp://deb.example.com",
      "http://user:pass@deb.example.com",
      "http://deb.example.com/?mirror=1",
      "http://deb.example.com/#debian",
      "http://",
      "http://deb.example.com/debian suite",
      "http://deb.example.com/\u0001",
    ],
    HOMERAIL_WORKER_BUILD_APT_SECURITY_MIRROR: [
      "not-a-url",
      "https://",
      "https://deb.example.com:port",
    ],
    HOMERAIL_WORKER_BUILD_NPM_REGISTRY: [
      "ftp://npm.example.com",
      "https://npm.example.com/<script>",
    ],
    HOMERAIL_WORKER_BUILD_DSH_GIT_REMOTE: [
      "ssh://git.example.com/deepseek-harness.git",
      "https://user:secret@git.example.com/deepseek-harness.git",
      "https://git.example.com/deepseek-harness$(touch).git",
      "https://git.example.com/deepseek-harness(test).git",
    ],
  };
  for (const [name, values] of Object.entries(invalidValues)) {
    for (const value of values) {
      const failed = runHelper({ [name]: value });
      assert.notEqual(failed.status, 0, `${name} must reject invalid value`);
      assert.match(failed.stderr, new RegExp(name));
      assert.ok(!failed.stderr.includes(value), "error must not echo the rejected value");
    }
  }
});
