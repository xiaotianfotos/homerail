import assert from "node:assert/strict";
import fs from "node:fs";
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
});

test("production deployment is atomic, health checked, and rollback capable", () => {
  const deploy = fs.readFileSync(path.join(repoRoot, "scripts", "deploy-production.sh"), "utf8");
  const service = fs.readFileSync(path.join(repoRoot, "scripts", "run-production-service.sh"), "utf8");
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
  assert.match(deploy, /HOMERAIL_PRODUCTION_MANAGER_PORT=\$MANAGER_PORT/);
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
  assert.match(service, /Production UI must bind all interfaces/);
  assert.match(service, /HOMERAIL_UI_SERVE_STATIC=1/);
  assert.match(service, /RELEASE_ROOT="\$\(readlink -f "\$CURRENT"\)"/);
  assert.match(service, /HOMERAIL_REPO_ROOT="\$RELEASE_ROOT"/);
  assert.match(service, /--no-build-worker-image/);
  assert.match(service, /failed three consecutive health checks/);
  assert.match(service, /runtime_has_node/);
  assert.doesNotMatch(service, /homerail-worker:latest/);
});

test("tracked deployment configuration contains no machine-local identity", () => {
  const files = [
    ".github/workflows/deploy-production.yml",
    "docs/production-deployment.md",
    "ops/systemd/homerail-deploy-runner.service",
    "scripts/deploy-production.sh",
    "scripts/run-production-service.sh",
  ];
  const trackedConfiguration = files
    .map((file) => fs.readFileSync(path.join(repoRoot, file), "utf8"))
    .join("\n");
  assert.doesNotMatch(trackedConfiguration, /\b(?:10|192\.168|172\.(?:1[6-9]|2[0-9]|3[01]))\.[0-9]{1,3}\.[0-9]{1,3}\b/);
  assert.doesNotMatch(trackedConfiguration, /\/(?:Users|home|vol[0-9]*|mnt)\//);
  assert.doesNotMatch(trackedConfiguration, /\bssh\s+[A-Za-z0-9._-]+@/i);
});
