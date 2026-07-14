import * as http from "node:http";
import { isCanonicalHomerailPluginSemver, isHomerailPluginId } from "homerail-protocol";
import { getGenerativeUiKindRegistry } from "../generative-ui/kind-registry.js";
import { assemblePluginTurnContext } from "../plugins/context-assembler.js";
import { compilePluginCapabilityIndex } from "../plugins/capability-index.js";
import { routePluginCapabilities } from "../plugins/capability-router.js";
import { getPluginActionBus, getPluginToolInvocationService } from "../plugins/action-bus.js";
import { selectAndResolvePluginWorkflowUri } from "../plugins/workflow-uri-resolver.js";
import { readActiveCustomRendererSource } from "../plugins/custom-renderer-source.js";
import { HomerailPluginRegistry } from "../plugins/registry.js";
import { emit } from "../events/bus.js";
import {
  getActivePlugin,
  listPluginPermissionGrants,
  listPluginVersions,
  pluginVersionSetDigest,
  setPluginGrantStatus,
  type PluginVersionRecord,
} from "../persistence/plugins.js";
import {
  activateInstalledPlugin,
  inspectInstalledPlugin,
  installHrpArchive,
  reconcileInstalledPluginPublisherTrust,
  rollbackInstalledPlugin,
  uninstallInstalledPlugin,
} from "../plugins/package-lifecycle.js";
import {
  getPluginDistributionRevision,
  listPluginPublisherTrust,
  listPluginPublisherTrustEvents,
  setPluginPublisherTrustAndRevokePackages,
} from "../persistence/plugin-distribution.js";
import {
  activateRemotePluginRegistryRelease,
  configureRemotePluginRegistry,
  enableRemotePluginRegistryRelease,
  installRemotePluginRegistryRelease,
  remotePluginRegistryState,
  rollbackRemotePluginRegistryRelease,
  syncRemotePluginRegistryIndex,
} from "../plugins/remote-registry.js";
import { preflightInstalledPluginRuntime } from "../plugins/runtime-orchestrator.js";

const MAX_BODY_BYTES = 8 * 1024;
// Tool/Action arguments are independently schema-bounded to 32 KiB and the
// opaque turn credential is bounded to 16 KiB. Keep their HTTP envelope large
// enough for every legal Protocol value without widening unrelated routes.
const MAX_TOOL_BODY_BYTES = 64 * 1024;
const MAX_REGISTRY_INDEX_BODY_BYTES = 2 * 1024 * 1024;
const MAX_ARCHIVE_BYTES = 8 * 1024 * 1024;

function json(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function cacheableJson(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  etag: string,
  body: unknown,
): void {
  res.setHeader("Cache-Control", "private, no-cache");
  res.setHeader("ETag", etag);
  if (req.headers["if-none-match"] === etag) {
    res.writeHead(304);
    res.end();
    return;
  }
  json(res, 200, body);
}

function registryUnavailable(res: http.ServerResponse, cause: unknown): void {
  console.error("plugin registry request failed", cause);
  json(res, 500, { success: false, error: "Plugin registry is unavailable" });
}

function readBody(
  req: http.IncomingMessage,
  maxBytes: number = MAX_BODY_BYTES,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let body = "";
    let bytes = 0;
    let rejected = false;
    const rawLength = req.headers["content-length"];
    if (rawLength !== undefined) {
      const declaredLength = Number(rawLength);
      if (!Number.isSafeInteger(declaredLength) || declaredLength < 0) {
        req.resume();
        reject(new Error("Plugin request Content-Length is invalid"));
        return;
      }
      if (declaredLength > maxBytes) {
        req.resume();
        reject(new Error("Plugin request body is too large"));
        return;
      }
    }
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => {
      if (rejected) return;
      bytes += Buffer.byteLength(chunk);
      if (bytes > maxBytes) {
        rejected = true;
        body = "";
        reject(new Error("Plugin request body is too large"));
        return;
      }
      body += chunk;
    });
    req.on("end", () => {
      if (rejected) return;
      try {
        const value = JSON.parse(body || "{}") as unknown;
        if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("body must be an object");
        resolve(value as Record<string, unknown>);
      } catch (cause) {
        reject(cause);
      }
    });
    req.on("error", reject);
  });
}

function readArchive(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    let rejected = false;
    const declaredLength = Number(req.headers["content-length"]);
    if (Number.isFinite(declaredLength) && declaredLength > MAX_ARCHIVE_BYTES) {
      rejected = true;
      req.resume();
      reject(new Error("Plugin archive is too large"));
      return;
    }
    req.on("data", (chunk: Buffer | string) => {
      if (rejected) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += buffer.byteLength;
      if (bytes > MAX_ARCHIVE_BYTES) {
        rejected = true;
        chunks.length = 0;
        reject(new Error("Plugin archive is too large"));
        return;
      }
      chunks.push(buffer);
    });
    req.on("end", () => {
      if (rejected) return;
      if (!bytes) reject(new Error("Plugin archive body is empty"));
      else if (bytes <= MAX_ARCHIVE_BYTES) resolve(Buffer.concat(chunks));
    });
    req.on("error", reject);
  });
}

function decodePluginId(raw: string, res: http.ServerResponse): string | undefined {
  try {
    const pluginId = decodeURIComponent(raw);
    if (!isHomerailPluginId(pluginId)) throw new Error("invalid plugin id");
    return pluginId;
  } catch {
    json(res, 400, { success: false, error: "Invalid plugin id" });
    return undefined;
  }
}

function decodeRegistryId(raw: string, res: http.ServerResponse): string | undefined {
  try {
    const registryId = decodeURIComponent(raw);
    if (!/^[a-z][a-z0-9._-]{0,79}$/.test(registryId)) throw new Error("invalid registry id");
    return registryId;
  } catch {
    json(res, 400, { success: false, error: "Invalid plugin registry id" });
    return undefined;
  }
}

function decodeBase64UrlBody(value: unknown, label: string): Buffer {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new Error(`${label} must be unpadded base64url`);
  }
  const decoded = Buffer.from(value, "base64url");
  if (decoded.toString("base64url") !== value) throw new Error(`${label} encoding is invalid`);
  return decoded;
}

function optionalExpectedRevision(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new Error("expected_revision must be a positive integer");
  }
  return Number(value);
}

function nonNegativeExpectedRevision(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new Error("expected_revision must be a non-negative integer");
  }
  return Number(value);
}

function routeError(res: http.ServerResponse, cause: unknown): void {
  const message = cause instanceof Error ? cause.message : String(cause);
  const normalized = message.toLowerCase();
  const status = normalized.includes("not installed") || normalized.includes("no plugin")
    || normalized.includes("not catalogued") || normalized.includes("source is not configured")
    || normalized.includes("generative ui document not found")
    || normalized.includes("plugin action request does not exist")
    || normalized.includes("plugin tool request does not exist")
    ? 404
    : normalized.includes("locked") || normalized.includes("conflict") || normalized.includes("not healthy")
      || normalized.includes("ungranted") || normalized.includes("cannot be")
      || normalized.includes("stale") || normalized.includes("collision")
      || normalized.includes("denied:")
      || normalized.includes("reconciliation") || normalized.includes("unresolved execution")
      || normalized.includes("no longer pending") || normalized.includes("expired")
      || normalized.includes("rollback or replay") || normalized.includes("root pin is immutable")
      ? 409
      : normalized.includes("too large") ? 413 : 400;
  json(res, status, { success: false, error: message });
}

function emitRegistryChange(
  pluginId: string,
  before: ReturnType<HomerailPluginRegistry["snapshot"]>,
  after: ReturnType<HomerailPluginRegistry["snapshot"]>,
): void {
  if (before.fingerprint === after.fingerprint) return;
  const active = after.plugins.find((plugin) => plugin.plugin_id === pluginId);
  emit("plugin:registry_changed", {
    plugin_id: pluginId,
    enabled: active?.activation.enabled ?? false,
    registry_revision: after.revision,
    registry_fingerprint: after.fingerprint,
  });
}

function versionSummary(version: PluginVersionRecord): Record<string, unknown> {
  return {
    plugin_id: version.plugin_id,
    plugin_version: version.plugin_version,
    package_digest: version.package_digest,
    source: version.source,
    installed_at: version.installed_at,
    active: version.active,
    enabled: version.enabled,
    ...(version.installation ? {
      installation: {
        archive_digest: version.installation.archive_digest,
        payload_digest: version.installation.payload_digest,
        channel: version.installation.channel,
        lifecycle_state: version.installation.lifecycle_state,
        health_state: version.installation.health_state,
        signature_state: version.installation.signature_state,
        installed_at: version.installation.installed_at,
        updated_at: version.installation.updated_at,
        removed_at: version.installation.removed_at,
      },
    } : {}),
  };
}

function listResponse(registry: HomerailPluginRegistry): Record<string, unknown> {
  const state = registry.snapshot();
  return {
    registry_revision: state.revision,
    registry_fingerprint: state.fingerprint,
    plugins: state.plugins.map((plugin) => ({
      id: plugin.plugin_id,
      name: plugin.descriptor.manifest.name,
      version: plugin.plugin_version,
      package_digest: plugin.package_digest,
      manifest_digest: plugin.descriptor.manifest_digest,
      source: plugin.source,
      enabled: plugin.activation.enabled,
      locked: plugin.activation.locked,
      activation_revision: plugin.activation.revision,
      capabilities: plugin.descriptor.manifest.capabilities.map((entry) => entry.id),
      skills: plugin.descriptor.manifest.skills.map((entry) => entry.id),
      tools: plugin.descriptor.manifest.tools.map((entry) => entry.id),
      workflows: plugin.descriptor.manifest.workflows.map((entry) => entry.id),
      kinds: plugin.descriptor.manifest.kinds.map((entry) => entry.kind),
      renderers: plugin.descriptor.manifest.renderers.map((entry) => entry.id),
      actions: plugin.descriptor.manifest.actions.map((entry) => entry.id),
    })),
  };
}

function publicRemoteRegistryState(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(publicRemoteRegistryState);
  if (!value || typeof value !== "object") return value;
  const entry = value as Record<string, unknown>;
  const attempts = Array.isArray(entry.attempts) ? entry.attempts.map((attempt) => {
    if (!attempt || typeof attempt !== "object" || Array.isArray(attempt)) return attempt;
    const safe = { ...(attempt as Record<string, unknown>) };
    delete safe.error;
    delete safe.data;
    return safe;
  }) : entry.attempts;
  return { ...entry, attempts };
}

export function pluginRoutesHandler(req: http.IncomingMessage, res: http.ServerResponse): boolean {
  try {
    return pluginRoutesHandlerUnsafe(req, res);
  } catch (cause) {
    registryUnavailable(res, cause);
    return true;
  }
}

function pluginRoutesHandlerUnsafe(req: http.IncomingMessage, res: http.ServerResponse): boolean {
  const url = new URL(req.url || "/", "http://localhost");
  const registry = new HomerailPluginRegistry();
  if (url.pathname === "/api/plugins" && req.method === "GET") {
    try {
      const data = listResponse(registry);
      cacheableJson(req, res, `"plugins-${String(data.registry_fingerprint)}"`, { success: true, data });
    } catch (cause) {
      registryUnavailable(res, cause);
    }
    return true;
  }
  if (url.pathname === "/api/plugins/context" && req.method === "GET") {
    try {
      const data = assemblePluginTurnContext(registry.snapshot());
      cacheableJson(req, res, `"plugin-context-${data.context_digest}"`, { success: true, data });
    } catch (cause) {
      registryUnavailable(res, cause);
    }
    return true;
  }
  if (url.pathname === "/api/plugins/capabilities" && req.method === "GET") {
    try {
      const data = compilePluginCapabilityIndex(registry.snapshot());
      cacheableJson(req, res, `"plugin-capabilities-${data.index_digest}"`, { success: true, data });
    } catch (cause) {
      registryUnavailable(res, cause);
    }
    return true;
  }
  if (url.pathname === "/api/plugins/capabilities/select" && req.method === "POST") {
    readBody(req).then((body) => {
      const data = routePluginCapabilities(body, registry.snapshot());
      json(res, 200, { success: true, data });
    }).catch((cause) => routeError(res, cause));
    return true;
  }
  if (url.pathname === "/api/plugins/workflows/resolve" && req.method === "POST") {
    readBody(req).then((body) => {
      const data = selectAndResolvePluginWorkflowUri(body, registry.snapshot());
      json(res, 200, { success: true, data });
    }).catch((cause) => routeError(res, cause));
    return true;
  }
  if (url.pathname === "/api/plugins/actions" && req.method === "POST") {
    readBody(req, MAX_TOOL_BODY_BYTES).then(async (body) => {
      const data = await getPluginActionBus().invoke(body);
      json(res, 200, { success: true, data });
    }).catch((cause) => routeError(res, cause));
    return true;
  }
  if (url.pathname === "/api/plugins/tools/invoke" && req.method === "POST") {
    readBody(req, MAX_TOOL_BODY_BYTES).then(async (body) => {
      const data = await getPluginToolInvocationService().invokeAgent(body);
      json(res, 200, { success: true, data });
    }).catch((cause) => routeError(res, cause));
    return true;
  }
  const toolConfirmationMatch = url.pathname.match(/^\/api\/plugins\/tools\/([^/]+)\/confirmation$/);
  if (toolConfirmationMatch && req.method === "POST") {
    let requestId: string;
    try { requestId = decodeURIComponent(toolConfirmationMatch[1]); } catch {
      json(res, 400, { success: false, error: "Invalid Tool request id" });
      return true;
    }
    readBody(req).then(async (body) => {
      const data = await getPluginToolInvocationService().confirm(requestId, body);
      json(res, 200, { success: true, data });
    }).catch((cause) => routeError(res, cause));
    return true;
  }
  const toolReconcileMatch = url.pathname.match(/^\/api\/plugins\/tools\/([^/]+)\/reconcile$/);
  if (toolReconcileMatch && req.method === "POST") {
    let requestId: string;
    try { requestId = decodeURIComponent(toolReconcileMatch[1]); } catch {
      json(res, 400, { success: false, error: "Invalid Tool request id" });
      return true;
    }
    req.resume();
    getPluginToolInvocationService().reconcile(requestId)
      .then((data) => json(res, 200, { success: true, data }))
      .catch((cause) => routeError(res, cause));
    return true;
  }
  const actionConfirmationMatch = url.pathname.match(/^\/api\/plugins\/actions\/([^/]+)\/confirmation$/);
  if (actionConfirmationMatch && req.method === "POST") {
    let requestId: string;
    try { requestId = decodeURIComponent(actionConfirmationMatch[1]); } catch {
      json(res, 400, { success: false, error: "Invalid Action request id" });
      return true;
    }
    readBody(req).then(async (body) => {
      const data = await getPluginActionBus().confirm(requestId, body);
      json(res, 200, { success: true, data });
    }).catch((cause) => routeError(res, cause));
    return true;
  }
  if (url.pathname === "/api/plugins/ui-registry" && req.method === "GET") {
    try {
      registry.syncBuiltins();
      const data = getGenerativeUiKindRegistry().uiProjection();
      cacheableJson(req, res, `"plugin-ui-${data.registry_fingerprint}"`, { success: true, data });
    } catch (cause) {
      registryUnavailable(res, cause);
    }
    return true;
  }
  if (url.pathname === "/api/plugins/publishers" && req.method === "GET") {
    try {
      const revision = getPluginDistributionRevision();
      cacheableJson(req, res, `"plugin-publishers-${revision}"`, {
        success: true,
        data: {
          revision,
          publishers: listPluginPublisherTrust(),
          events: listPluginPublisherTrustEvents(),
        },
      });
    } catch (cause) {
      registryUnavailable(res, cause);
    }
    return true;
  }
  const publisherMatch = url.pathname.match(/^\/api\/plugins\/publishers\/([^/]+)$/);
  if (publisherMatch && req.method === "PUT") {
    let keyId: string;
    try { keyId = decodeURIComponent(publisherMatch[1]); } catch {
      json(res, 400, { success: false, error: "Invalid publisher key id" });
      return true;
    }
    readBody(req).then((body) => {
      if (
        typeof body.publisher !== "string"
        || typeof body.public_key_spki !== "string"
        || (body.state !== "trusted" && body.state !== "revoked")
        || body.expected_revision === undefined
        || (body.reason !== undefined && typeof body.reason !== "string")
        || Object.keys(body).some((key) => ![
          "publisher", "public_key_spki", "state", "expected_revision", "reason",
        ].includes(key))
      ) throw new Error("Publisher trust update requires publisher, public_key_spki, state, and expected_revision");
      const before = registry.snapshot();
      const revocation = setPluginPublisherTrustAndRevokePackages({
        entry: {
          key_id: keyId,
          publisher: body.publisher,
          public_key_spki: body.public_key_spki,
          state: body.state,
        },
        expected_revision: nonNegativeExpectedRevision(body.expected_revision),
        actor: "admin-api",
        ...(typeof body.reason === "string" ? { reason: body.reason } : {}),
      });
      const reconciliation = reconcileInstalledPluginPublisherTrust();
      if (reconciliation.failures.length) {
        throw new Error(`Publisher trust reconciliation failed: ${JSON.stringify(reconciliation.failures)}`);
      }
      const after = registry.snapshot();
      const pluginIds = new Set([
        ...before.plugins.map((plugin) => plugin.plugin_id),
        ...after.plugins.map((plugin) => plugin.plugin_id),
      ]);
      for (const pluginId of pluginIds) emitRegistryChange(pluginId, before, after);
      json(res, 200, { success: true, data: { ...revocation, reconciliation } });
    }).catch((cause) => routeError(res, cause));
    return true;
  }
  if (url.pathname === "/api/plugins/registries" && req.method === "GET") {
    try {
      json(res, 200, {
        success: true,
        data: { registries: publicRemoteRegistryState(remotePluginRegistryState()) },
      });
    } catch (cause) {
      registryUnavailable(res, cause);
    }
    return true;
  }
  const registryStateMatch = url.pathname.match(/^\/api\/plugins\/registries\/([^/]+)$/);
  if (registryStateMatch && req.method === "GET") {
    const registryId = decodeRegistryId(registryStateMatch[1], res);
    if (!registryId) return true;
    const data = publicRemoteRegistryState(remotePluginRegistryState(registryId));
    if (!data) json(res, 404, { success: false, error: `Plugin registry source is not configured: ${registryId}` });
    else json(res, 200, { success: true, data });
    return true;
  }
  const registrySourceMatch = url.pathname.match(/^\/api\/plugins\/registries\/([^/]+)\/source$/);
  if (registrySourceMatch && req.method === "PUT") {
    const registryId = decodeRegistryId(registrySourceMatch[1], res);
    if (!registryId) return true;
    readBody(req).then((body) => {
      if (
        typeof body.source_url !== "string"
        || typeof body.root_key_id !== "string"
        || Object.keys(body).some((key) => !["source_url", "root_key_id"].includes(key))
      ) throw new Error("Plugin registry source requires source_url and root_key_id");
      const source = configureRemotePluginRegistry({
        registry_id: registryId,
        source_url: body.source_url,
        root_key_id: body.root_key_id,
      });
      json(res, 200, { success: true, data: { source } });
    }).catch((cause) => routeError(res, cause));
    return true;
  }
  const registrySyncMatch = url.pathname.match(/^\/api\/plugins\/registries\/([^/]+)\/sync$/);
  if (registrySyncMatch && req.method === "POST") {
    const registryId = decodeRegistryId(registrySyncMatch[1], res);
    if (!registryId) return true;
    readBody(req, MAX_REGISTRY_INDEX_BODY_BYTES).then((body) => {
      if (Object.keys(body).join(",") !== "index_base64") {
        throw new Error("Plugin registry sync requires only index_base64");
      }
      const data = syncRemotePluginRegistryIndex({
        registry_id: registryId,
        index_bytes: decodeBase64UrlBody(body.index_base64, "Plugin registry index"),
      });
      json(res, 200, { success: true, data });
    }).catch((cause) => routeError(res, cause));
    return true;
  }
  const registryReleaseMatch = url.pathname.match(
    /^\/api\/plugins\/registries\/([^/]+)\/releases\/([^/]+)\/([^/]+)\/(install|update|activate)$/,
  );
  if (registryReleaseMatch) {
    const registryId = decodeRegistryId(registryReleaseMatch[1], res);
    if (!registryId) return true;
    const pluginId = decodePluginId(registryReleaseMatch[2], res);
    if (!pluginId) return true;
    let pluginVersion: string;
    try { pluginVersion = decodeURIComponent(registryReleaseMatch[3]); } catch {
      json(res, 400, { success: false, error: "Invalid plugin version" });
      return true;
    }
    if (!isCanonicalHomerailPluginSemver(pluginVersion)) {
      json(res, 400, { success: false, error: "Invalid plugin version" });
      return true;
    }
    const operation = registryReleaseMatch[4] as "install" | "update" | "activate";
    if (req.method !== "POST") {
      json(res, 405, { success: false, error: "Plugin registry release operation requires POST" });
      return true;
    }
    if (operation === "activate") {
      const before = registry.snapshot();
      readBody(req).then((body) => {
        if (Object.keys(body).join(",") !== "expected_revision") {
          throw new Error("Plugin registry activation requires only expected_revision");
        }
        const data = activateRemotePluginRegistryRelease({
          registry_id: registryId,
          plugin_id: pluginId,
          plugin_version: pluginVersion,
          expected_revision: optionalExpectedRevision(body.expected_revision)!,
        });
        emitRegistryChange(pluginId, before, registry.snapshot());
        json(res, 200, { success: true, data });
      }).catch((cause) => routeError(res, cause));
      return true;
    }
    const contentType = String(req.headers["content-type"] ?? "").split(";", 1)[0].trim().toLowerCase();
    if (contentType !== "application/vnd.homerail.plugin+zip" && contentType !== "application/zip") {
      json(res, 415, { success: false, error: "Plugin registry install requires application/vnd.homerail.plugin+zip" });
      return true;
    }
    const before = registry.snapshot();
    readArchive(req).then((archive) => {
      const data = installRemotePluginRegistryRelease({
        registry_id: registryId,
        plugin_id: pluginId,
        plugin_version: pluginVersion,
        archive,
        operation,
      });
      emitRegistryChange(pluginId, before, registry.snapshot());
      json(res, data.installed.idempotent ? 200 : 201, { success: true, data });
    }).catch((cause) => routeError(res, cause));
    return true;
  }
  const registryRollbackMatch = url.pathname.match(
    /^\/api\/plugins\/registries\/([^/]+)\/plugins\/([^/]+)\/rollback$/,
  );
  if (registryRollbackMatch && req.method === "POST") {
    const registryId = decodeRegistryId(registryRollbackMatch[1], res);
    if (!registryId) return true;
    const pluginId = decodePluginId(registryRollbackMatch[2], res);
    if (!pluginId) return true;
    const before = registry.snapshot();
    readBody(req).then((body) => {
      if (
        body.expected_revision === undefined
        || (body.version !== undefined && !isCanonicalHomerailPluginSemver(body.version))
        || Object.keys(body).some((key) => !["expected_revision", "version"].includes(key))
      ) throw new Error("Plugin registry rollback requires expected_revision and optional canonical version");
      const data = rollbackRemotePluginRegistryRelease({
        registry_id: registryId,
        plugin_id: pluginId,
        ...(typeof body.version === "string" ? { plugin_version: body.version } : {}),
        expected_revision: optionalExpectedRevision(body.expected_revision)!,
      });
      emitRegistryChange(pluginId, before, registry.snapshot());
      json(res, 200, { success: true, data });
    }).catch((cause) => routeError(res, cause));
    return true;
  }
  const registryEnableMatch = url.pathname.match(
    /^\/api\/plugins\/registries\/([^/]+)\/plugins\/([^/]+)\/enabled$/,
  );
  if (registryEnableMatch && req.method === "PUT") {
    const registryId = decodeRegistryId(registryEnableMatch[1], res);
    if (!registryId) return true;
    const pluginId = decodePluginId(registryEnableMatch[2], res);
    if (!pluginId) return true;
    const before = registry.snapshot();
    readBody(req).then((body) => {
      if (
        body.enabled !== true
        || body.expected_revision === undefined
        || !isCanonicalHomerailPluginSemver(body.expected_active_version)
        || Object.keys(body).some((key) => ![
          "enabled", "expected_revision", "expected_active_version",
        ].includes(key))
      ) throw new Error("Plugin registry enablement requires enabled=true and exact activation state");
      const data = enableRemotePluginRegistryRelease({
        registry_id: registryId,
        plugin_id: pluginId,
        expected_revision: optionalExpectedRevision(body.expected_revision)!,
        expected_active_version: body.expected_active_version as string,
      });
      emitRegistryChange(pluginId, before, registry.snapshot());
      json(res, 200, { success: true, data });
    }).catch((cause) => routeError(res, cause));
    return true;
  }
  const rendererSourceMatch = url.pathname.match(/^\/api\/plugins\/renderers\/([^/]+)\/([^/]+)\/source$/);
  if (rendererSourceMatch && req.method === "GET") {
    const pluginId = decodePluginId(rendererSourceMatch[1], res);
    if (!pluginId) return true;
    let rendererId: string;
    try { rendererId = decodeURIComponent(rendererSourceMatch[2]); } catch {
      json(res, 400, { success: false, error: "Invalid Renderer id" });
      return true;
    }
    const pluginVersion = url.searchParams.get("plugin_version");
    const digest = url.searchParams.get("digest");
    if (
      !/^[a-z][a-z0-9._-]{0,79}$/.test(rendererId)
      || !isCanonicalHomerailPluginSemver(pluginVersion)
      || typeof digest !== "string"
      || !/^[a-f0-9]{64}$/.test(digest)
    ) {
      json(res, 400, { success: false, error: "Invalid exact custom Renderer reference" });
      return true;
    }
    try {
      registry.syncBuiltins();
      const data = readActiveCustomRendererSource({
        plugin_id: pluginId,
        plugin_version: pluginVersion,
        renderer_id: rendererId,
        digest,
      });
      if (!data) {
        json(res, 404, { success: false, error: "Custom Renderer source not found" });
        return true;
      }
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
      res.setHeader("Content-Security-Policy", "default-src 'none'; sandbox");
      cacheableJson(
        req,
        res,
        `"plugin-renderer-${data.plugin_id}-${data.renderer_id}-${data.digest}"`,
        { success: true, data },
      );
    } catch (cause) {
      registryUnavailable(res, cause);
    }
    return true;
  }
  if (url.pathname === "/api/plugins/install" && req.method === "POST") {
    const contentType = String(req.headers["content-type"] ?? "").split(";", 1)[0].trim().toLowerCase();
    if (contentType !== "application/vnd.homerail.plugin+zip" && contentType !== "application/zip") {
      json(res, 415, { success: false, error: "Plugin install requires application/vnd.homerail.plugin+zip" });
      return true;
    }
    const channel = url.searchParams.get("channel") ?? "staging";
    if (channel !== "staging" && channel !== "local") {
      json(res, 400, { success: false, error: "Invalid plugin install channel" });
      return true;
    }
    registry.syncBuiltins();
    const before = registry.snapshot();
    readArchive(req).then((archive) => {
      const installed = installHrpArchive(archive, { channel });
      const after = registry.snapshot();
      emitRegistryChange(installed.package.plugin_id, before, after);
      json(res, installed.idempotent ? 200 : 201, {
        success: true,
        data: {
          plugin_id: installed.package.plugin_id,
          plugin_version: installed.package.plugin_version,
          archive_digest: installed.archive_digest,
          payload_digest: installed.payload_digest,
          package_digest: installed.package.package_digest,
          installation: {
            channel: installed.installation.channel,
            lifecycle_state: installed.installation.lifecycle_state,
            health_state: installed.installation.health_state,
            signature_state: installed.installation.signature_state,
          },
          activation: installed.activation,
          data_only_eligible: installed.data_only_eligible,
          m5_projection_action_eligible: installed.m5_projection_action_eligible,
          m5_projection_action_eligibility_reasons:
            installed.m5_projection_action_eligibility_reasons,
          m5_workflow_resolution_eligible: installed.m5_workflow_resolution_eligible,
          m5_workflow_resolution_eligibility_reasons:
            installed.m5_workflow_resolution_eligibility_reasons,
          m6_custom_renderer_eligible: installed.m6_custom_renderer_eligible,
          m6_custom_renderer_eligibility_reasons:
            installed.m6_custom_renderer_eligibility_reasons,
          idempotent: installed.idempotent,
          registry: listResponse(registry),
        },
      });
    }).catch((cause) => routeError(res, cause));
    return true;
  }

  const versionsMatch = url.pathname.match(/^\/api\/plugins\/([^/]+)\/versions$/);
  if (versionsMatch && req.method === "GET") {
    const pluginId = decodePluginId(versionsMatch[1], res);
    if (!pluginId) return true;
    const versions = listPluginVersions(pluginId);
    if (!versions.length) json(res, 404, { success: false, error: `Plugin is not installed: ${pluginId}` });
    else json(res, 200, {
      success: true,
      data: {
        plugin_id: pluginId,
        activation: getActivePlugin(pluginId)?.activation ?? null,
        version_set_digest: pluginVersionSetDigest(pluginId),
        versions: versions.map(versionSummary),
      },
    });
    return true;
  }

  const runtimePreflightMatch = url.pathname.match(/^\/api\/plugins\/([^/]+)\/versions\/([^/]+)\/runtime\/preflight$/);
  if (runtimePreflightMatch && req.method === "POST") {
    const pluginId = decodePluginId(runtimePreflightMatch[1], res);
    if (!pluginId) return true;
    let pluginVersion: string;
    try {
      pluginVersion = decodeURIComponent(runtimePreflightMatch[2]);
    } catch {
      json(res, 400, { success: false, error: "Plugin Runtime preflight version encoding is invalid" });
      return true;
    }
    if (!isCanonicalHomerailPluginSemver(pluginVersion)) {
      json(res, 400, { success: false, error: "Plugin Runtime preflight version is invalid" });
      return true;
    }
    readBody(req).then(async (body) => {
      if (Object.keys(body).length) throw new Error("Plugin Runtime preflight body must be empty");
      const launch = await preflightInstalledPluginRuntime({ plugin_id: pluginId, plugin_version: pluginVersion });
      json(res, 200, {
        success: true,
        data: {
          plugin_id: pluginId,
          plugin_version: pluginVersion,
          node_id: launch.node_id,
          image_digest: launch.image_digest,
          measurement_digest: launch.measurement_digest,
          attestation_id: launch.attestation.claims.attestation_id,
        },
      });
    }).catch((cause) => routeError(res, cause));
    return true;
  }

  const activeVersionMatch = url.pathname.match(/^\/api\/plugins\/([^/]+)\/active-version$/);
  if (activeVersionMatch && req.method === "PUT") {
    const pluginId = decodePluginId(activeVersionMatch[1], res);
    if (!pluginId) return true;
    const before = registry.snapshot();
    readBody(req).then((body) => {
      if (
        typeof body.version !== "string"
        || body.expected_revision === undefined
        || Object.keys(body).some((key) => !["version", "expected_revision"].includes(key))
      ) {
        throw new Error("Plugin activation requires version and expected_revision");
      }
      const activation = activateInstalledPlugin(
        pluginId,
        body.version,
        optionalExpectedRevision(body.expected_revision),
      );
      const after = registry.snapshot();
      emitRegistryChange(pluginId, before, after);
      json(res, 200, { success: true, data: { activation, registry: listResponse(registry) } });
    }).catch((cause) => routeError(res, cause));
    return true;
  }

  const rollbackMatch = url.pathname.match(/^\/api\/plugins\/([^/]+)\/rollback$/);
  if (rollbackMatch && req.method === "POST") {
    const pluginId = decodePluginId(rollbackMatch[1], res);
    if (!pluginId) return true;
    const before = registry.snapshot();
    readBody(req).then((body) => {
      if (
        (body.version !== undefined && typeof body.version !== "string")
        || body.expected_revision === undefined
        || Object.keys(body).some((key) => !["version", "expected_revision"].includes(key))
      ) {
        throw new Error("Plugin rollback requires expected_revision and accepts optional version");
      }
      const activation = rollbackInstalledPlugin(
        pluginId,
        typeof body.version === "string" ? body.version : undefined,
        optionalExpectedRevision(body.expected_revision),
      );
      const after = registry.snapshot();
      emitRegistryChange(pluginId, before, after);
      json(res, 200, { success: true, data: { activation, registry: listResponse(registry) } });
    }).catch((cause) => routeError(res, cause));
    return true;
  }

  const permissionsMatch = url.pathname.match(/^\/api\/plugins\/([^/]+)\/permissions$/);
  if (permissionsMatch && req.method === "GET") {
    const pluginId = decodePluginId(permissionsMatch[1], res);
    if (!pluginId) return true;
    const version = url.searchParams.get("version") ?? undefined;
    json(res, 200, { success: true, data: { plugin_id: pluginId, grants: listPluginPermissionGrants(pluginId, version) } });
    return true;
  }
  if (permissionsMatch && req.method === "PUT") {
    const pluginId = decodePluginId(permissionsMatch[1], res);
    if (!pluginId) return true;
    readBody(req).then((body) => {
      if (
        typeof body.version !== "string"
        || typeof body.permission !== "string"
        || (body.status !== "granted" && body.status !== "denied")
        || body.expected_revision === undefined
        || Object.keys(body).some((key) => !["version", "permission", "status", "expected_revision"].includes(key))
      ) throw new Error("Plugin grant update requires version, permission, and granted|denied status");
      const grant = setPluginGrantStatus({
        plugin_id: pluginId,
        plugin_version: body.version,
        permission: body.permission,
        status: body.status,
        expected_revision: optionalExpectedRevision(body.expected_revision),
      });
      json(res, 200, { success: true, data: { grant, grants: listPluginPermissionGrants(pluginId, body.version) } });
    }).catch((cause) => routeError(res, cause));
    return true;
  }

  const doctorMatch = url.pathname.match(/^\/api\/plugins\/([^/]+)\/doctor$/);
  if (doctorMatch && req.method === "GET") {
    const pluginId = decodePluginId(doctorMatch[1], res);
    if (!pluginId) return true;
    const report = inspectInstalledPlugin(pluginId);
    json(res, report.versions.length ? 200 : 404, {
      success: report.healthy,
      data: { ...report, versions: report.versions.map(versionSummary) },
    });
    return true;
  }

  const uninstallMatch = url.pathname.match(/^\/api\/plugins\/([^/]+)$/);
  if (uninstallMatch && req.method === "DELETE") {
    const pluginId = decodePluginId(uninstallMatch[1], res);
    if (!pluginId) return true;
    readBody(req).then((body) => {
      if (
        typeof body.expected_version_set_digest !== "string"
        || !/^[a-f0-9]{64}$/.test(body.expected_version_set_digest)
        || Object.keys(body).some((key) => key !== "expected_version_set_digest")
      ) throw new Error("Plugin uninstall requires expected_version_set_digest");
      const before = registry.snapshot();
      const versions = uninstallInstalledPlugin(pluginId, body.expected_version_set_digest);
      const after = registry.snapshot();
      emitRegistryChange(pluginId, before, after);
      json(res, 200, { success: true, data: { plugin_id: pluginId, retained_versions: versions.length, registry: listResponse(registry) } });
    }).catch((cause) => routeError(res, cause));
    return true;
  }
  const match = url.pathname.match(/^\/api\/plugins\/([^/]+)\/enabled$/);
  if (!match) return false;
  if (req.method !== "PUT") {
    json(res, 405, { success: false, error: "Plugin activation requires PUT" });
    return true;
  }
  const pluginId = decodePluginId(match[1], res);
  if (!pluginId) return true;
  readBody(req).then((body) => {
    if (
      typeof body.enabled !== "boolean"
      || typeof body.expected_active_version !== "string"
      || body.expected_revision === undefined
      || Object.keys(body).some((key) => !["enabled", "expected_revision", "expected_active_version"].includes(key))
    ) {
      json(res, 400, { success: false, error: "Plugin activation requires enabled, expected_revision, and expected_active_version" });
      return;
    }
    const before = registry.snapshot();
    const activation = registry.setEnabled(pluginId, body.enabled, {
      expected_revision: optionalExpectedRevision(body.expected_revision),
      expected_active_version: body.expected_active_version,
    });
    const after = registry.snapshot();
    emitRegistryChange(pluginId, before, after);
    json(res, 200, {
      success: true,
      data: {
        activation,
        registry: listResponse(registry),
      },
    });
  }).catch((cause) => routeError(res, cause));
  return true;
}
