import * as http from "node:http";
import { isHomerailPluginId } from "homerail-protocol";
import { getGenerativeUiKindRegistry } from "../generative-ui/kind-registry.js";
import { assemblePluginTurnContext } from "../plugins/context-assembler.js";
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
  rollbackInstalledPlugin,
  uninstallInstalledPlugin,
} from "../plugins/package-lifecycle.js";

const MAX_BODY_BYTES = 8 * 1024;
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

function readBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
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
      if (declaredLength > MAX_BODY_BYTES) {
        req.resume();
        reject(new Error("Plugin request body is too large"));
        return;
      }
    }
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => {
      if (rejected) return;
      bytes += Buffer.byteLength(chunk);
      if (bytes > MAX_BODY_BYTES) {
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

function optionalExpectedRevision(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new Error("expected_revision must be a positive integer");
  }
  return Number(value);
}

function routeError(res: http.ServerResponse, cause: unknown): void {
  const message = cause instanceof Error ? cause.message : String(cause);
  const normalized = message.toLowerCase();
  const status = normalized.includes("not installed") || normalized.includes("no plugin")
    ? 404
    : normalized.includes("locked") || normalized.includes("conflict") || normalized.includes("not healthy")
      || normalized.includes("ungranted") || normalized.includes("cannot be")
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
      kinds: plugin.descriptor.manifest.kinds.map((entry) => entry.kind),
      renderers: plugin.descriptor.manifest.renderers.map((entry) => entry.id),
      actions: plugin.descriptor.manifest.actions.map((entry) => entry.id),
    })),
  };
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
  if (url.pathname === "/api/plugins/install" && req.method === "POST") {
    const contentType = String(req.headers["content-type"] ?? "").split(";", 1)[0].trim().toLowerCase();
    if (contentType !== "application/vnd.homerail.plugin+zip" && contentType !== "application/zip") {
      json(res, 415, { success: false, error: "Plugin install requires application/vnd.homerail.plugin+zip" });
      return true;
    }
    const channel = url.searchParams.get("channel") ?? "staging";
    if (channel === "registry") {
      json(res, 400, { success: false, error: "Remote registry installs require the signed M6 registry pipeline" });
      return true;
    }
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
