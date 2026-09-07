#!/usr/bin/env node

import assert from "node:assert/strict";
import {
  autoFixV2RuntimeProfileYaml,
  selectAutoFixV2Setting,
} from "./configure-auto-fix-v2-runtime-profile.mjs";

const setting = (id, model, endpoint) => ({
  id,
  display_name: model,
  model_name: model,
  is_active: 1,
  supports_llm: 1,
  ...endpoint,
});

const settings = [
  setting("qwen3.8-max", "Qwen3.8-Max", { responses_base_url: "https://models.example/v1/responses" }),
  setting("glm-5-2", "GLM-5.2", { anthropic_base_url: "https://models.example/v1" }),
];
const implementation = selectAutoFixV2Setting(settings, "qwen3.8-max", "implementation");
const review = selectAutoFixV2Setting(settings, "glm-5-2", "review");
const yaml = autoFixV2RuntimeProfileYaml({ profileId: "pilot", implementation, review });

assert.match(yaml, /workflow_id: auto-fix-v2/);
assert.doesNotMatch(yaml, /analyzer:/);
for (const id of ["implementer", "aggregator", "fixer"]) {
  assert.match(yaml, new RegExp(`${id}:\\n    llm_setting_id: "qwen3.8-max"\\n    agent_type: codex_appserver\\n    reasoning_effort: max`));
}
assert.match(yaml, /reviewer:\n    llm_setting_id: "glm-5-2"/);
assert.throws(() => selectAutoFixV2Setting(settings, "glm-5-2", "implementation"), /required model family/);
assert.throws(() => selectAutoFixV2Setting([
  setting("qwen3.8-max-preview", "Qwen3.8-Max-Preview", { responses_base_url: "https://models.example/v1/responses" }),
], "qwen3.8-max-preview", "implementation"), /required model family/);
assert.throws(() => selectAutoFixV2Setting([
  setting("qwen-no-responses", "Qwen3.8-Max", { anthropic_base_url: "https://models.example/v1" }),
], "qwen-no-responses", "implementation"), /no Responses endpoint for Codex/);

process.stdout.write("auto-fix-v2 runtime profile tests passed\n");
