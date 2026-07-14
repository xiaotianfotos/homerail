#!/usr/bin/env node

const managerUrl = (process.env.HOMERAIL_MANAGER_URL ?? "http://127.0.0.1:29191").replace(/\/+$/, "");
const modelBaseUrl = (process.env.HOMERAIL_PATTERN_MODEL_BASE_URL ?? "").replace(/\/+$/, "");
const modelName = process.env.HOMERAIL_PATTERN_MODEL ?? "qwen3.6";
const providerId = process.env.HOMERAIL_PATTERN_PROVIDER_ID ?? "homerail-runner-live";
const providerName = process.env.HOMERAIL_PATTERN_PROVIDER_NAME ?? `HomeRail Runner ${modelName}`;
const modelApiKey = process.env.HOMERAIL_PATTERN_MODEL_API_KEY ?? "local-no-key";
const modelProtocol = process.env.HOMERAIL_PATTERN_MODEL_PROTOCOL ?? "anthropic_compatible";
const managerAdminToken = process.env.HOMERAIL_MANAGER_ADMIN_TOKEN ?? "";

if (!modelBaseUrl) {
  throw new Error("HOMERAIL_PATTERN_MODEL_BASE_URL is required");
}

if (modelProtocol !== "anthropic_compatible") {
  throw new Error(
    `Live DAG validation requires an Anthropic-compatible endpoint; received ${modelProtocol}`,
  );
}

async function request(path, init) {
  const response = await fetch(`${managerUrl}${path}`, {
    ...init,
    headers: {
      ...(init?.headers ?? {}),
      ...(managerAdminToken && init?.method && init.method !== "GET"
        ? { Authorization: `Bearer ${managerAdminToken}` }
        : {}),
    },
  });
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
    name: providerName,
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
    api_key: modelApiKey,
    protocol: modelProtocol,
    base_url: modelBaseUrl,
    anthropic_base_url: modelBaseUrl,
    is_active: true,
    is_default: true,
    supports_llm: true,
  }),
});

if (!setting?.id) throw new Error("Manager did not return an LLM setting id");
process.stdout.write(String(setting.id));
