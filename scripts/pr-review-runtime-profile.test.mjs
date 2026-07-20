import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  PR_REVIEW_ARBITER_AGENTS,
  configurePrReviewRuntimeProfile,
  prReviewRuntimeProfileYaml,
  selectRuntimeSetting,
} from "./configure-pr-review-runtime-profile.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const primary = {
  id: "setting-qwen38",
  display_name: "qwen3.8-max-preview",
  model_name: "qwen3.8-max-preview",
  is_active: true,
  supports_llm: true,
  anthropic_base_url: "https://qwen.example.test/anthropic",
};
const arbiter = {
  id: "setting-k3",
  display_name: "k3",
  model_name: "k3",
  is_active: true,
  supports_llm: true,
  anthropic_base_url: "https://kimi.example.test/anthropic",
};

test("selects one active Anthropic-compatible Seed Home model", () => {
  assert.equal(selectRuntimeSetting([primary, arbiter], "qwen3.8-max-preview", "primary"), primary);
  assert.equal(selectRuntimeSetting([primary, arbiter], "setting-k3", "arbiter"), arbiter);
  assert.throws(
    () => selectRuntimeSetting([primary, { ...primary, id: "other" }], primary.model_name, "primary"),
    /ambiguous/,
  );
  assert.throws(
    () => selectRuntimeSetting([{ ...primary, anthropic_base_url: null }], primary.id, "primary"),
    /no Anthropic-compatible endpoint/,
  );
});

test("binds primary review to one model and arbitration to a distinct model", () => {
  const yaml = prReviewRuntimeProfileYaml({ profileId: "pr-review-mixed", primary, arbiter });
  assert.match(yaml, /workflow_id: pr-review/);
  assert.match(yaml, /default:\n  llm_setting_id: "setting-qwen38"\n  agent_type: claude-sdk/);
  for (const agentId of PR_REVIEW_ARBITER_AGENTS) {
    assert.match(yaml, new RegExp(`  ${agentId}:\\n    llm_setting_id: "setting-k3"`));
  }
  assert.doesNotMatch(yaml, /api[_-]?key/i);
  assert.throws(
    () => prReviewRuntimeProfileYaml({ profileId: "same", primary, arbiter: primary }),
    /must use different LLM settings/,
  );
});

test("authenticates profile sync with the isolated DAG mutation token", async () => {
  const previousToken = process.env.HOMERAIL_DAG_MUTATION_TOKEN;
  const previousAdminToken = process.env.HOMERAIL_MANAGER_ADMIN_TOKEN;
  process.env.HOMERAIL_DAG_MUTATION_TOKEN = "test-mutation-token";
  process.env.HOMERAIL_MANAGER_ADMIN_TOKEN = "unused-admin-token";
  let syncHeaders;
  const server = http.createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.method === "GET" && request.url === "/api/llm/settings") {
      response.end(JSON.stringify({ success: true, data: { settings: [primary, arbiter] } }));
      return;
    }
    if (request.method === "POST" && request.url === "/api/dag/profiles/sync") {
      syncHeaders = request.headers;
      request.resume();
      response.end(JSON.stringify({
        success: true,
        data: { profile: { workflow_id: "pr-review", profile_id: "pr-review-mixed" } },
      }));
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ success: false, error: "not found" }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    await configurePrReviewRuntimeProfile({
      managerUrl: `http://127.0.0.1:${address.port}`,
      primarySelector: primary.model_name,
      arbiterSelector: arbiter.model_name,
    });
    assert.equal(syncHeaders?.["x-homerail-dag-token"], "test-mutation-token");
    assert.equal(syncHeaders?.authorization, undefined);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    if (previousToken === undefined) delete process.env.HOMERAIL_DAG_MUTATION_TOKEN;
    else process.env.HOMERAIL_DAG_MUTATION_TOKEN = previousToken;
    if (previousAdminToken === undefined) delete process.env.HOMERAIL_MANAGER_ADMIN_TOKEN;
    else process.env.HOMERAIL_MANAGER_ADMIN_TOKEN = previousAdminToken;
  }
});

test("live PR Review clones the Seed Home and switches from setting to profile", () => {
  const runner = fs.readFileSync(path.join(root, "scripts/run-dag-patterns-live-runner.sh"), "utf8");
  const workflow = fs.readFileSync(path.join(root, ".github/workflows/pr-review.yml"), "utf8");
  assert.match(runner, /cp -a --reflink=auto "\$HOME_TEMPLATE\/\." "\$HOMERAIL_HOME\/"/);
  assert.match(runner, /configure-pr-review-runtime-profile\.mjs/);
  assert.match(runner, /review_args\+=\(--profile "\$PROFILE_ID"\)/);
  assert.match(runner, /HOMERAIL_LIVE_HOME_TEMPLATE must not contain symbolic links/);
  assert.ok(
    runner.indexOf('dag sync pr-review') < runner.indexOf('configure-pr-review-runtime-profile.mjs'),
    "the workflow must be synced before its runtime profile",
  );
  assert.match(workflow, /vars\.HOMERAIL_PR_REVIEW_HOME_TEMPLATE/);
  assert.match(workflow, /vars\.HOMERAIL_PR_REVIEW_PRIMARY_MODEL/);
  assert.match(workflow, /vars\.HOMERAIL_PR_REVIEW_ARBITER_MODEL/);
});
