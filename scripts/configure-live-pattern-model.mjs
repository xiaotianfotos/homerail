#!/usr/bin/env node

const managerUrl = (process.env.HOMERAIL_MANAGER_URL ?? "http://127.0.0.1:29191").replace(/\/+$/, "");
const modelBaseUrl = (process.env.HOMERAIL_PATTERN_MODEL_BASE_URL ?? "http://192.168.100.10:5000")
  .replace(/\/+$/, "");
const modelName = process.env.HOMERAIL_PATTERN_MODEL ?? "qwen3.6";
const providerId = "homerail-runner-qwen36";

async function request(path, init) {
  const response = await fetch(`${managerUrl}${path}`, init);
  const body = await response.json();
  if (!response.ok || body.success === false) {
    throw new Error(`${init?.method ?? "GET"} ${path}: ${body.error ?? body.message ?? `HTTP ${response.status}`}`);
  }
  return body.data;
}

await request("/api/llm/providers", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    id: providerId,
    name: "HomeRail Runner Qwen3.6",
    status: "active",
    default_model: modelName,
    base_url: modelBaseUrl,
    anthropic_base_url: modelBaseUrl,
    supports_llm: true,
  }),
});

const setting = await request("/api/llm/settings", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    provider_id: providerId,
    endpoint_id: `${providerId}_custom`,
    model_name: modelName,
    api_key: "local-no-key",
    protocol: "anthropic_compatible",
    base_url: modelBaseUrl,
    anthropic_base_url: modelBaseUrl,
    is_active: true,
    is_default: true,
    supports_llm: true,
  }),
});

if (!setting?.id) throw new Error("Manager did not return an LLM setting id");
process.stdout.write(String(setting.id));
