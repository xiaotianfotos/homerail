import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  PR_REVIEW_MODEL_AGENTS,
  configurePrReviewRuntimeProfile,
  prReviewRuntimeProfileYaml,
  resolvePrReviewProfileId,
  selectRuntimeSetting,
} from "./configure-pr-review-runtime-profile.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const primary = {
  id: "setting-qwen38",
  display_name: "qwen3.8-max",
  model_name: "qwen3.8-max",
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
const third = {
  id: "setting-glm52",
  display_name: "glm-5.2",
  model_name: "glm-5.2",
  is_active: true,
  supports_llm: true,
  anthropic_base_url: "https://glm.example.test/anthropic",
};

test("selects one active Anthropic-compatible stable Manager model", () => {
  assert.equal(selectRuntimeSetting([primary, arbiter], "qwen3.8-max", "primary"), primary);
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

test("binds the three review votes to three distinct models", () => {
  const yaml = prReviewRuntimeProfileYaml({ profileId: "pr-review-mixed", primary, arbiter, third });
  assert.match(yaml, /workflow_id: "pr-review"/);
  assert.match(yaml, /default:\n  llm_setting_id: "setting-qwen38"\n  agent_type: claude-sdk/);
  for (const [agentId, role] of Object.entries(PR_REVIEW_MODEL_AGENTS)) {
    const setting = { primary, arbiter, third }[role];
    assert.match(yaml, new RegExp(`  ${agentId}:\\n    llm_setting_id: "${setting.id}"`));
  }
  assert.doesNotMatch(yaml, /api[_-]?key/i);
  assert.throws(
    () => prReviewRuntimeProfileYaml({ profileId: "same", primary, arbiter, third: primary }),
    /three distinct LLM settings/,
  );
  assert.match(
    prReviewRuntimeProfileYaml({
      profileId: "pr-review-candidate",
      workflowId: "pr-review-candidate",
      primary,
      arbiter,
      third,
    }),
    /workflow_id: "pr-review-candidate"/,
  );
});

test("binds three independent DSH reviewers to one OpenAI-compatible Qwen setting", () => {
  const qwenLocal = {
    id: "setting-qwen38-local",
    display_name: "Qwen3.8 27B Local · DSH",
    model_name: "qwen3.8",
    protocol: "openai_compatible",
    base_url: "http://192.168.100.10:5000/v1",
    chat_completions_base_url: "http://192.168.100.10:5000/v1",
    reasoning_effort_map: { medium: "medium", xhigh: "xhigh" },
    is_active: true,
    supports_llm: true,
  };
  assert.equal(
    selectRuntimeSetting([qwenLocal], qwenLocal.display_name, "primary", "deepseek_harness"),
    qwenLocal,
  );
  const yaml = prReviewRuntimeProfileYaml({
    profileId: "pr-review-qwen38-dsh",
    primary: qwenLocal,
    arbiter: qwenLocal,
    third: qwenLocal,
    agentType: "deepseek_harness",
  });
  assert.match(yaml, /description: Three independent DeepSeek Harness reviewer processes/);
  assert.equal((yaml.match(/llm_setting_id: "setting-qwen38-local"/g) ?? []).length, 4);
  assert.equal((yaml.match(/agent_type: deepseek_harness/g) ?? []).length, 4);
  assert.doesNotMatch(yaml, /reasoning_effort:/);
  assert.match(
    prReviewRuntimeProfileYaml({
      profileId: "pr-review-qwen38-dsh-xhigh",
      primary: qwenLocal,
      arbiter: qwenLocal,
      third: qwenLocal,
      agentType: "deepseek_harness",
      reasoningEffort: "xhigh",
    }),
    /reasoning_effort: "xhigh"/,
  );

  const yamlSensitiveEffort = "medium: fast # operator choice\nretained";
  const yamlSensitiveSetting = {
    ...qwenLocal,
    reasoning_effort_map: { [yamlSensitiveEffort]: "balanced" },
  };
  const yamlWithSensitiveEffort = prReviewRuntimeProfileYaml({
    profileId: "pr-review-qwen38-dsh-sensitive-effort",
    primary: yamlSensitiveSetting,
    arbiter: yamlSensitiveSetting,
    third: yamlSensitiveSetting,
    agentType: "deepseek_harness",
    reasoningEffort: yamlSensitiveEffort,
  });
  assert.equal(
    (yamlWithSensitiveEffort.match(/reasoning_effort: "medium: fast # operator choice\\nretained"/g) ?? []).length,
    4,
  );
  assert.throws(
    () => prReviewRuntimeProfileYaml({
      profileId: "pr-review-qwen38-dsh-invalid",
      primary: qwenLocal,
      arbiter: qwenLocal,
      third: qwenLocal,
      agentType: "deepseek_harness",
      reasoningEffort: "ultra",
    }),
    /does not declare reasoning effort: ultra/,
  );
  assert.throws(
    () => prReviewRuntimeProfileYaml({
      profileId: "pr-review-qwen38-dsh-inherited-selector",
      primary: qwenLocal,
      arbiter: qwenLocal,
      third: qwenLocal,
      agentType: "deepseek_harness",
      reasoningEffort: "toString",
    }),
    /does not declare reasoning effort: toString/,
  );
  assert.throws(
    () => selectRuntimeSetting([{ ...qwenLocal, protocol: "anthropic_compatible" }], qwenLocal.id, "primary", "deepseek_harness"),
    /not OpenAI-compatible/,
  );
});

test("keeps omitted DSH profile ids isolated from the mixed-model profile", () => {
  assert.equal(resolvePrReviewProfileId(undefined, "claude-sdk"), "pr-review-mixed");
  assert.equal(resolvePrReviewProfileId(undefined, "deepseek_harness"), "pr-review-dsh");
  assert.equal(resolvePrReviewProfileId("pr-review-qwen38-dsh", "deepseek_harness"), "pr-review-qwen38-dsh");
  assert.throws(
    () => resolvePrReviewProfileId("pr-review-mixed", "deepseek_harness"),
    /must not overwrite the pr-review-mixed profile/,
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
      response.end(JSON.stringify({ success: true, data: { settings: [primary, arbiter, third] } }));
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
      workflowId: "pr-review",
      primarySelector: primary.model_name,
      arbiterSelector: arbiter.model_name,
      thirdSelector: third.model_name,
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

test("formal PR Review submits to the durable stable Manager", () => {
  const runner = fs.readFileSync(path.join(root, "scripts/run-stable-dag-runner.sh"), "utf8");
  const workflow = fs.readFileSync(path.join(root, ".github/workflows/pr-review.yml"), "utf8");
  assert.match(runner, /initialize_stable_automation_runtime/);
  assert.match(runner, /configure-pr-review-runtime-profile\.mjs/);
  assert.match(runner, /--profile "\$PROFILE_ID"/);
  assert.match(workflow, /run-pr-review-stable-runner\.sh/);
  assert.match(workflow, /homerail-pr-review/);
  assert.match(
    workflow,
    /HOMERAIL_PR_REVIEW_PROFILE_ID: \$\{\{ inputs\.profile_id \|\| \(inputs\.agent_type == 'deepseek_harness' && 'pr-review-dsh' \|\| 'pr-review-mixed'\) \}\}/,
  );
  assert.doesNotMatch(workflow, /inputs\.profile_id \|\| 'pr-review-mixed'/);
  assert.match(
    workflow,
    /HOMERAIL_PR_REVIEW_AGENT_TYPE: \$\{\{ inputs\.agent_type \|\| 'claude-sdk' \}\}/,
  );
  assert.match(
    workflow,
    /HOMERAIL_PR_REVIEW_REASONING_EFFORT: \$\{\{ inputs\.reasoning_effort \}\}/,
  );
  assert.doesNotMatch(workflow, /install:all|build:packages|run-pr-review-live-runner/);
  assert.doesNotMatch(workflow, /vars\.HOMERAIL_PR_REVIEW_(?:HOME_TEMPLATE|PRIMARY_MODEL|ARBITER_MODEL|THIRD_MODEL)/);
});

test("formal PR Review runs for maintainer-owned PRs when they become ready", () => {
  const workflow = fs
    .readFileSync(path.join(root, ".github/workflows/pr-review.yml"), "utf8")
    .replace(/\r\n/g, "\n");
  const eventBlock = workflow.slice(workflow.indexOf("on:\n"), workflow.indexOf("\npermissions:"));
  assert.match(eventBlock, /workflow_dispatch:/);
  assert.match(eventBlock, /pull_request:\n[\s\S]*types: \[opened, reopened, ready_for_review\]/);
  assert.doesNotMatch(eventBlock, /paths-ignore:/);
  assert.match(workflow, /github\.event\.pull_request\.user\.login == 'xiaotianfotos'/);
  assert.match(workflow, /github\.event\.pull_request\.draft == false/);
  assert.match(workflow, /github\.event\.pull_request\.head\.repo\.full_name == github\.repository/);
  assert.doesNotMatch(workflow, /pull_request_target:/);
});
