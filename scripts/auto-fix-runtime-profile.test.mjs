import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_AUTO_FIX_IMPLEMENTATION_MODEL_NAME,
  DEFAULT_AUTO_FIX_REVIEW_MODEL_NAME,
  AUTO_FIX_IMPLEMENTATION_AGENTS,
  AUTO_FIX_REVIEW_AGENTS,
  assertAutoFixRoleModel,
  autoFixRuntimeProfileYaml,
  configureAutoFixRuntimeProfile,
  selectAutoFixRuntimeSetting,
} from "./configure-auto-fix-runtime-profile.mjs";

const setting = (id, displayName, modelName = `${id}-model`) => ({
  id,
  display_name: displayName,
  model_name: modelName,
  is_active: true,
  supports_llm: true,
  anthropic_base_url: `https://${id}.example.test/anthropic`,
});

test("selects one active Anthropic-compatible stable Manager setting", () => {
  const settings = [setting("implementation", "Implementer"), setting("review", "Reviewer")];
  assert.equal(selectAutoFixRuntimeSetting(settings, "Implementer", "implementation").id, "implementation");
  assert.equal(selectAutoFixRuntimeSetting(settings, "review-model", "review").id, "review");
  assert.throws(() => selectAutoFixRuntimeSetting(settings, "missing", "arbitration"), /was not found/);
  assert.throws(() => selectAutoFixRuntimeSetting([
    setting("one", "duplicate"),
    setting("two", "duplicate"),
  ], "duplicate", "review"), /ambiguous/);
  assert.throws(() => selectAutoFixRuntimeSetting([
    { ...setting("inactive", "Inactive"), is_active: false },
  ], "inactive", "review"), /not an active LLM setting/);
  assert.throws(() => selectAutoFixRuntimeSetting([
    { ...setting("openai", "OpenAI only"), anthropic_base_url: undefined },
  ], "openai", "review"), /no Anthropic-compatible endpoint/);
});

test("maps implementation, review, and arbitration roles without provider configuration", () => {
  const yaml = autoFixRuntimeProfileYaml({
    profileId: "auto-fix-mixed",
    implementation: setting("setting-implementation", "Implementation"),
    review: setting("setting-review", "Review"),
  });
  for (const agent of AUTO_FIX_IMPLEMENTATION_AGENTS) {
    assert.match(yaml, new RegExp(`${agent}:\\n    llm_setting_id: "setting-implementation"`));
  }
  for (const agent of AUTO_FIX_REVIEW_AGENTS) {
    assert.match(yaml, new RegExp(`${agent}:\\n    llm_setting_id: "setting-review"`));
  }
  assert.doesNotMatch(yaml, /^\s*(?:provider|model|api_key|base_url):/m);
  const singleModel = autoFixRuntimeProfileYaml({
    profileId: "single-model",
    implementation: setting("same", "One"),
    review: setting("same", "Two"),
  });
  assert.equal((singleModel.match(/llm_setting_id: "same"/g) ?? []).length, 8);
});

test("binds all reviewers, arbitration, and publication to the review model", () => {
  assert.deepEqual(AUTO_FIX_REVIEW_AGENTS, [
    "correctness_reviewer",
    "regression_reviewer",
    "adversarial_reviewer",
    "arbiter",
    "publisher",
  ]);
});

test("attests exact implementation and review model names", () => {
  assert.equal(DEFAULT_AUTO_FIX_IMPLEMENTATION_MODEL_NAME, "qwen3.6");
  assert.equal(DEFAULT_AUTO_FIX_REVIEW_MODEL_NAME, "qwen3.8-max-preview");
  assert.equal(
    assertAutoFixRoleModel(
      setting("implementation", "Implementation", "qwen3.6"),
      "QWEN3.6",
      "implementation",
    ).id,
    "implementation",
  );
  assert.throws(
    () => assertAutoFixRoleModel(
      setting("wrong", "Wrong", "qwen3.8-max-preview"),
      "qwen3.6",
      "implementation",
    ),
    /resolved model qwen3\.8-max-preview; expected qwen3\.6/,
  );
});

test("syncs the private profile after resolving and attesting two stable settings", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    if (String(url).endsWith("/api/llm/settings")) {
      return new Response(JSON.stringify({
        success: true,
        data: { settings: [
          setting("implementation", "Implementation", "qwen3.6"),
          setting("review", "Review", "qwen3.8-max-preview"),
        ] },
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify({
      success: true,
      data: { profile: { workflow_id: "auto-fix", profile_id: "auto-fix-mixed" } },
    }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const oldToken = process.env.HOMERAIL_DAG_MUTATION_TOKEN;
  process.env.HOMERAIL_DAG_MUTATION_TOKEN = "test-token";
  try {
    const configured = await configureAutoFixRuntimeProfile({
      managerUrl: "http://127.0.0.1:39191/",
      profileId: "auto-fix-mixed",
      implementationSelector: "implementation",
      reviewSelector: "review",
      expectedImplementationModelName: "qwen3.6",
      expectedReviewModelName: "qwen3.8-max-preview",
    });
    assert.equal(configured.profileId, "auto-fix-mixed");
    assert.equal(calls.length, 2);
    assert.equal(calls[1].url, "http://127.0.0.1:39191/api/dag/profiles/sync");
    assert.equal(calls[1].init.headers["x-homerail-dag-token"], "test-token");
    const body = JSON.parse(calls[1].init.body);
    assert.equal(body.workflow_id, "auto-fix");
    assert.match(body.yaml_text, /profile_id: "auto-fix-mixed"/);
  } finally {
    globalThis.fetch = originalFetch;
    if (oldToken === undefined) delete process.env.HOMERAIL_DAG_MUTATION_TOKEN;
    else process.env.HOMERAIL_DAG_MUTATION_TOKEN = oldToken;
  }
});
