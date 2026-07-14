import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  HOMERAIL_PLUGIN_DESCRIPTOR_MAX_BYTES,
  HomerailPluginPermission,
  decodeHomerailPluginUtf8,
  homerailPluginTurnContextDigestInput,
  isHomerailPluginId,
  isSafeHomerailPluginPackagePath,
  validateHomerailPluginTurnContext,
  type HomerailPluginConfirmation,
  type HomerailPluginEffect,
  type HomerailPluginEffectivePermissionGrantV1,
  type HomerailPluginPermission as HomerailPluginPermissionValue,
  type HomerailPluginTurnContextV1,
} from "homerail-protocol";
import {
  getPluginRegistryState,
  type PluginRegistryState,
} from "../persistence/plugins.js";
import {
  assemblePluginTurnContext,
  selectPluginTurnContext,
} from "./context-assembler.js";
import {
  routePluginCapabilities,
  type PluginCapabilityRouteRequest,
} from "./capability-router.js";
import {
  pluginJsonDigest,
  validateResolvedPluginDescriptor,
} from "./descriptor.js";
import { ensureBuiltinPluginsSynced } from "./registry.js";

const PLUGIN_URI = /^plugin:\/\/([a-z0-9]+(?:[.-][a-z0-9]+)+)\/([A-Za-z0-9._/-]+)$/;
const LOCAL_ID = /^[a-z][a-z0-9._-]{0,79}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const PERMISSIONS = new Set<string>(Object.values(HomerailPluginPermission));

export interface ResolvePluginWorkflowUriRequestV1 {
  /** Exact manifest URI. URL normalization, aliases, query strings and fragments are forbidden. */
  uri: string;
  /** Exact qualified capability selected by Capability Router. */
  capability_id: string;
  /** Narrow Manager-owned context returned by Capability Router for this selection. */
  selected_context: HomerailPluginTurnContextV1;
}

/**
 * Immutable, deterministic workflow source resolution. `effective_grants`
 * describes the requested manifest scope; it is not proof that the scope has
 * been granted. A later Workflow invocation must still pass through the shared
 * Effect/Permission/Confirmation Broker. This resolver never parses or runs
 * workflow instructions.
 */
export interface ResolvedPluginWorkflowUriV1 {
  resolution_version: 1;
  uri: string;
  capability_id: string;
  plugin_id: string;
  plugin_version: string;
  workflow_id: string;
  workflow_file: string;
  manifest_digest: string;
  package_digest: string;
  content_digest: string;
  content_bytes: number;
  content: string;
  effect: HomerailPluginEffect;
  permissions: HomerailPluginPermissionValue[];
  effective_grants: HomerailPluginEffectivePermissionGrantV1[];
  confirmation: HomerailPluginConfirmation;
  registry_revision: number;
  registry_fingerprint: string;
  activation_revision: number;
  permission_revision: number;
  selected_context_digest: string;
  resolution_digest: string;
}

export interface SelectAndResolvePluginWorkflowUriRequestV1 {
  uri: string;
  capability_id: string;
  /** Intent/input hints only. Manager supplies and owns the exact target/context. */
  selection: Omit<PluginCapabilityRouteRequest,
    "explicit_plugin_id" | "explicit_capability_id" | "top_k">;
}

export interface SelectedPluginWorkflowResolutionV1 {
  selection: {
    selection_version: 1;
    manager_owned: true;
    capability_id: string;
    route_request_digest: string;
    route_result_digest: string;
    selected_context_digest: string;
    registry_revision: number;
    registry_fingerprint: string;
    permission_revision: number;
  };
  resolution: ResolvedPluginWorkflowUriV1;
}

interface NormalizedRequest {
  uri: string;
  uri_plugin_id: string;
  capability_id: string;
  capability_plugin_id: string;
  capability_local_id: string;
  selected_context: HomerailPluginTurnContextV1;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort(compareText);
}

function parseQualifiedCapability(value: unknown): {
  qualified_id: string;
  plugin_id: string;
  local_id: string;
} {
  if (typeof value !== "string" || value.length > 300) {
    throw new Error("Plugin workflow capability_id must be a qualified capability id");
  }
  const separator = value.indexOf(":");
  if (
    separator < 1
    || separator !== value.lastIndexOf(":")
    || !isHomerailPluginId(value.slice(0, separator))
    || !LOCAL_ID.test(value.slice(separator + 1))
  ) throw new Error("Plugin workflow capability_id must be a qualified capability id");
  return {
    qualified_id: value,
    plugin_id: value.slice(0, separator),
    local_id: value.slice(separator + 1),
  };
}

function parsePluginUri(value: unknown): { uri: string; plugin_id: string } {
  if (typeof value !== "string" || value.length < 12 || value.length > 400) {
    throw new Error("Plugin workflow URI is invalid");
  }
  const match = PLUGIN_URI.exec(value);
  if (
    !match
    || !isHomerailPluginId(match[1])
    || !isSafeHomerailPluginPackagePath(match[2])
  ) throw new Error("Plugin workflow URI must be an exact canonical plugin:// URI");
  return { uri: value, plugin_id: match[1] };
}

function normalizeRequest(value: unknown): NormalizedRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Plugin workflow resolution request must be an object");
  }
  const input = value as Record<string, unknown>;
  const allowed = new Set(["uri", "capability_id", "selected_context"]);
  if (
    Object.keys(input).some((key) => !allowed.has(key))
    || !Object.prototype.hasOwnProperty.call(input, "uri")
    || !Object.prototype.hasOwnProperty.call(input, "capability_id")
    || !Object.prototype.hasOwnProperty.call(input, "selected_context")
  ) throw new Error("Plugin workflow resolution request has unknown or missing fields");
  const uri = parsePluginUri(input.uri);
  const capability = parseQualifiedCapability(input.capability_id);
  if (!input.selected_context || typeof input.selected_context !== "object" || Array.isArray(input.selected_context)) {
    throw new Error("Plugin workflow resolution requires a selected Plugin Context");
  }
  return {
    uri: uri.uri,
    uri_plugin_id: uri.plugin_id,
    capability_id: capability.qualified_id,
    capability_plugin_id: capability.plugin_id,
    capability_local_id: capability.local_id,
    selected_context: input.selected_context as HomerailPluginTurnContextV1,
  };
}

function normalizeSelectionResolutionRequest(value: unknown): {
  uri: string;
  capability_id: string;
  capability_plugin_id: string;
  selection: Record<string, unknown>;
} {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Plugin workflow select/resolve request must be an object");
  }
  const input = value as Record<string, unknown>;
  const allowed = new Set(["uri", "capability_id", "selection"]);
  if (
    Object.keys(input).some((key) => !allowed.has(key))
    || !Object.prototype.hasOwnProperty.call(input, "uri")
    || !Object.prototype.hasOwnProperty.call(input, "capability_id")
    || !Object.prototype.hasOwnProperty.call(input, "selection")
  ) throw new Error("Plugin workflow select/resolve request has unknown or missing fields");
  const uri = parsePluginUri(input.uri);
  const capability = parseQualifiedCapability(input.capability_id);
  if (uri.plugin_id !== capability.plugin_id) {
    throw new Error("Plugin workflow URI and selected capability must have the same plugin owner");
  }
  if (!input.selection || typeof input.selection !== "object" || Array.isArray(input.selection)) {
    throw new Error("Plugin workflow selection hints must be an object");
  }
  const selection = input.selection as Record<string, unknown>;
  if (["explicit_plugin_id", "explicit_capability_id", "top_k", "source_context", "selected_context"]
    .some((key) => Object.prototype.hasOwnProperty.call(selection, key))) {
    throw new Error("Plugin workflow target and selected context are Manager-owned");
  }
  return {
    uri: uri.uri,
    capability_id: capability.qualified_id,
    capability_plugin_id: capability.plugin_id,
    selection: structuredClone(selection),
  };
}

function selectedCapabilityIds(context: HomerailPluginTurnContextV1): string[] {
  return uniqueSorted([
    ...context.skills.flatMap((entry) => entry.capability_ids),
    ...context.tools.flatMap((entry) => entry.capability_ids),
    ...context.actions.flatMap((entry) => entry.capability_ids),
  ]);
}

function canonicalPermissionPath(value: string): boolean {
  if (value === "/") return true;
  if (
    value !== value.normalize("NFC")
    || value.includes("\\")
    || /[\u0000-\u001f\u007f]/.test(value)
    || value === "."
    || value === ".."
    || (value.length > 1 && value.endsWith("/"))
  ) return false;
  const segments = value.split("/");
  return segments.every((segment, index) => (
    (index === 0 && segment === "" && value.startsWith("/"))
    || (segment.length > 0 && segment !== "." && segment !== "..")
  ));
}

function canonicalPermissionHost(value: string): boolean {
  const match = /^([a-z0-9](?:[a-z0-9.-]*[a-z0-9])?)(?::([1-9][0-9]{0,4}))?$/.exec(value);
  if (!match) return false;
  const hostname = match[1];
  const port = match[2];
  if (
    hostname.length > 253
    || hostname.includes("..")
    || hostname.split(".").some((label) => (
      label.length < 1
      || label.length > 63
      || label.startsWith("-")
      || label.endsWith("-")
    ))
  ) return false;
  if (port !== undefined && (!Number.isSafeInteger(Number(port)) || Number(port) > 65_535)) return false;
  if (/^[0-9.]+$/.test(hostname)) {
    const octets = hostname.split(".");
    if (
      octets.length !== 4
      || octets.some((octet) => (
        !/^(?:0|[1-9][0-9]{0,2})$/.test(octet)
        || Number(octet) > 255
      ))
    ) return false;
  }
  return true;
}

/**
 * Context digests provide integrity, not authority. Rebuild the narrowed
 * context from the live Manager registry and demand exact equality so a caller
 * cannot self-digest injected Skill/Tool metadata or widen the selection.
 */
function assertCurrentSelectedContext(
  value: HomerailPluginTurnContextV1,
  state: PluginRegistryState,
): HomerailPluginTurnContextV1 {
  const validation = validateHomerailPluginTurnContext(value);
  if (
    !validation.valid
    || !validation.value
    || pluginJsonDigest(homerailPluginTurnContextDigestInput(value)) !== value.context_digest
  ) throw new Error("Selected Plugin Context failed validation or digest verification");
  const supplied = validation.value;
  const capabilityIds = selectedCapabilityIds(supplied);
  if (!capabilityIds.length) throw new Error("Selected Plugin Context contains no capabilities");
  const full = assemblePluginTurnContext(state);
  if (supplied.permission_revision !== full.permission_revision) {
    throw new Error("Selected Plugin Context permission snapshot is stale");
  }
  const expected = selectPluginTurnContext(full, capabilityIds, full.permission_revision);
  if (!isDeepStrictEqual(supplied, expected)) {
    throw new Error("Selected Plugin Context is not the current Manager-owned selection");
  }
  return structuredClone(supplied);
}

function normalizedScope(
  value: readonly string[] | undefined,
  label: "paths" | "hosts",
): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || !value.length || value.some((entry) => typeof entry !== "string" || !entry.length)) {
    throw new Error(`Plugin workflow permission ${label} scope must be a non-empty string array`);
  }
  const normalized = uniqueSorted(value.map((entry) => (
    label === "hosts" ? entry.toLowerCase() : entry.normalize("NFC")
  )));
  const canonical = label === "hosts" ? canonicalPermissionHost : canonicalPermissionPath;
  if (normalized.some((entry) => !canonical(entry))) {
    throw new Error(`Plugin workflow permission ${label} scope is not canonical`);
  }
  return normalized;
}

function effectiveGrants(
  manifest: PluginRegistryState["plugins"][number]["descriptor"]["manifest"],
  workflowPermissions: readonly HomerailPluginPermissionValue[],
): HomerailPluginEffectivePermissionGrantV1[] {
  if (new Set(workflowPermissions).size !== workflowPermissions.length) {
    throw new Error("Plugin workflow permissions must be unique");
  }
  const declarations = [...manifest.permissions.required, ...manifest.permissions.optional];
  const declarationByPermission = new Map<HomerailPluginPermissionValue, typeof declarations[number]>();
  for (const declaration of declarations) {
    if (!PERMISSIONS.has(declaration.permission)) {
      throw new Error(`Plugin workflow permission is invalid: ${String(declaration.permission)}`);
    }
    if (declarationByPermission.has(declaration.permission)) {
      throw new Error(`Plugin workflow permission declaration is ambiguous: ${declaration.permission}`);
    }
    declarationByPermission.set(declaration.permission, declaration);
  }
  const permissions = uniqueSorted([
    ...manifest.permissions.required.map((entry) => entry.permission),
    ...workflowPermissions,
  ]) as HomerailPluginPermissionValue[];
  return permissions.map((permission) => {
    const declaration = declarationByPermission.get(permission);
    if (!declaration) throw new Error(`Plugin workflow permission was not declared: ${permission}`);
    const paths = normalizedScope(declaration.paths, "paths");
    const hosts = normalizedScope(declaration.hosts, "hosts");
    if (permission === HomerailPluginPermission.NETWORK_CONNECT && !hosts?.length) {
      throw new Error("Plugin workflow network.connect permission requires an effective host allowlist");
    }
    if (permission !== HomerailPluginPermission.NETWORK_CONNECT && hosts !== undefined) {
      throw new Error(`Plugin workflow permission cannot declare hosts: ${permission}`);
    }
    return {
      permission,
      ...(paths ? { paths } : {}),
      ...(hosts ? { hosts } : {}),
    };
  });
}

function archivedWorkflowContent(
  plugin: PluginRegistryState["plugins"][number],
  workflowFile: string,
): { content: string; digest: string; bytes: number } {
  const matches = plugin.descriptor.referenced_files.filter((entry) => entry.path === workflowFile);
  if (matches.length !== 1) {
    throw new Error(`Plugin workflow archive reference must be unique: ${plugin.plugin_id}:${workflowFile}`);
  }
  const archived = matches[0];
  if (
    archived.encoding !== "base64"
    || !SHA256.test(archived.digest)
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(archived.content)
  ) throw new Error(`Plugin workflow archive entry is invalid: ${plugin.plugin_id}:${workflowFile}`);
  const bytes = Buffer.from(archived.content, "base64");
  if (
    bytes.byteLength > HOMERAIL_PLUGIN_DESCRIPTOR_MAX_BYTES
    || bytes.toString("base64") !== archived.content
    || createHash("sha256").update(bytes).digest("hex") !== archived.digest
  ) throw new Error(`Plugin workflow archive digest is invalid: ${plugin.plugin_id}:${workflowFile}`);
  const content = decodeHomerailPluginUtf8(bytes, workflowFile);
  if (!content.trim()) throw new Error(`Plugin workflow archive is empty: ${plugin.plugin_id}:${workflowFile}`);
  return { content, digest: archived.digest, bytes: bytes.byteLength };
}

/**
 * Resolve a selected plugin:// workflow URI to immutable package text and
 * policy metadata. Resolution performs no Workflow parsing, authorization,
 * side effect, runtime startup or DAG synchronization.
 */
export function resolvePluginWorkflowUri(
  requestValue: unknown,
  state?: PluginRegistryState,
): ResolvedPluginWorkflowUriV1 {
  const request = normalizeRequest(requestValue);
  if (!state) ensureBuiltinPluginsSynced();
  const registry = state ?? getPluginRegistryState();
  const selectedContext = assertCurrentSelectedContext(request.selected_context, registry);
  const selectedIds = new Set(selectedCapabilityIds(selectedContext));
  if (!selectedIds.has(request.capability_id)) {
    throw new Error(`Plugin workflow capability was not selected: ${request.capability_id}`);
  }
  if (request.uri_plugin_id !== request.capability_plugin_id) {
    throw new Error("Plugin workflow URI and selected capability must have the same plugin owner");
  }

  const plugin = registry.plugins.find((entry) => (
    entry.plugin_id === request.capability_plugin_id && entry.activation.enabled
  ));
  if (!plugin) throw new Error(`Plugin workflow owner is not enabled: ${request.capability_plugin_id}`);
  const contextPlugin = selectedContext.enabled_plugins.find((entry) => entry.id === plugin.plugin_id);
  if (
    !contextPlugin
    || contextPlugin.version !== plugin.plugin_version
    || contextPlugin.manifest_digest !== plugin.descriptor.manifest_digest
  ) throw new Error("Plugin workflow owner does not match the selected immutable package version");
  const descriptorErrors = validateResolvedPluginDescriptor(plugin.descriptor);
  if (descriptorErrors.length) {
    throw new Error(`Plugin workflow owner descriptor is invalid: ${JSON.stringify(descriptorErrors)}`);
  }

  const capability = plugin.descriptor.manifest.capabilities.find((entry) => (
    entry.id === request.capability_local_id
  ));
  if (!capability) throw new Error(`Selected Plugin capability is unavailable: ${request.capability_id}`);
  const workflowMatches = plugin.descriptor.manifest.workflows.filter((entry) => entry.uri === request.uri);
  if (workflowMatches.length !== 1) {
    throw new Error(`Plugin workflow URI must resolve to exactly one active declaration: ${request.uri}`);
  }
  const workflow = workflowMatches[0];
  if (!capability.workflows.includes(workflow.id)) {
    throw new Error(`Plugin workflow is not reachable from the selected capability: ${request.uri}`);
  }
  const content = archivedWorkflowContent(plugin, workflow.file);
  const grants = effectiveGrants(plugin.descriptor.manifest, workflow.permissions);
  const permissions = grants.map((grant) => grant.permission);
  const unsigned = {
    resolution_version: 1 as const,
    uri: workflow.uri,
    capability_id: request.capability_id,
    plugin_id: plugin.plugin_id,
    plugin_version: plugin.plugin_version,
    workflow_id: workflow.id,
    workflow_file: workflow.file,
    manifest_digest: plugin.descriptor.manifest_digest,
    package_digest: plugin.package_digest,
    content_digest: content.digest,
    content_bytes: content.bytes,
    effect: workflow.effect,
    permissions,
    effective_grants: grants,
    confirmation: workflow.confirmation,
    registry_revision: registry.revision,
    registry_fingerprint: registry.fingerprint,
    activation_revision: plugin.activation.revision,
    permission_revision: selectedContext.permission_revision,
    selected_context_digest: selectedContext.context_digest,
  };
  return {
    ...unsigned,
    content: content.content,
    // The digest binds the immutable content digest instead of duplicating the
    // complete Workflow source in the canonical resolution proof.
    resolution_digest: pluginJsonDigest(unsigned),
  };
}

/**
 * Production entrypoint: Capability Router creates the exact selected context
 * inside Manager, then the immutable resolver revalidates that context. The
 * returned Workflow is source text only; this function never parses, syncs,
 * invokes, authorizes or executes it.
 */
export function selectAndResolvePluginWorkflowUri(
  requestValue: unknown,
  state?: PluginRegistryState,
): SelectedPluginWorkflowResolutionV1 {
  const request = normalizeSelectionResolutionRequest(requestValue);
  if (!state) ensureBuiltinPluginsSynced();
  const registry = state ?? getPluginRegistryState();
  const route = routePluginCapabilities({
    ...request.selection,
    explicit_plugin_id: request.capability_plugin_id,
    explicit_capability_id: request.capability_id,
    top_k: 1,
  }, registry);
  const selected = route.selected.find((entry) => entry.capability_id === request.capability_id);
  if (!selected || route.selected.length !== 1) {
    const candidate = route.candidates.find((entry) => entry.qualified_id === request.capability_id);
    const blockers = [
      ...(candidate?.missing_inputs ?? []).map((entry) => `input:${entry}`),
      ...(candidate?.missing_grants ?? []).map((entry) => `ungranted:${entry}`),
      ...(candidate?.denied_permissions ?? []).map((entry) => `denied:${entry}`),
    ];
    throw new Error(
      `Plugin workflow capability was not selected by Manager${blockers.length ? ` (${blockers.join(", ")})` : ""}`,
    );
  }
  const resolution = resolvePluginWorkflowUri({
    uri: request.uri,
    capability_id: request.capability_id,
    selected_context: route.selected_context,
  }, registry);
  return {
    selection: {
      selection_version: 1,
      manager_owned: true,
      capability_id: request.capability_id,
      route_request_digest: route.request_digest,
      route_result_digest: route.replay.result_digest,
      selected_context_digest: route.selected_context.context_digest,
      registry_revision: route.registry_revision,
      registry_fingerprint: route.registry_fingerprint,
      permission_revision: route.permission_revision,
    },
    resolution,
  };
}
