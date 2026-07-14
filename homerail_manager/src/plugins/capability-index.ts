import {
  GENERATIVE_UI_IR_VERSION,
  HOMERAIL_PLUGIN_API_VERSION,
  HOMERAIL_RENDERER_API_VERSION,
  validateHomerailPluginCompatibility,
  type HomerailPluginCompatibilityTargetV1,
  type HomerailPluginEffect,
  type HomerailPluginModality,
} from "homerail-protocol";
import {
  getPluginPermissionRevision,
  getPluginRegistryState,
  listPluginPermissionGrants,
  type PluginPermissionGrantRecord,
  type PluginRegistryState,
} from "../persistence/plugins.js";
import { pluginJsonDigest } from "./descriptor.js";
import { ensureBuiltinPluginsSynced } from "./registry.js";

const HOMERAIL_VERSION = "0.1.0";

export const DEFAULT_CAPABILITY_COMPATIBILITY_TARGET: Readonly<HomerailPluginCompatibilityTargetV1> = {
  homerail: HOMERAIL_VERSION,
  plugin_api: HOMERAIL_PLUGIN_API_VERSION,
  ui_ir: GENERATIVE_UI_IR_VERSION,
  renderer_api: HOMERAIL_RENDERER_API_VERSION,
};

export interface PluginCapabilityPermissionSnapshot {
  permission: string;
  status: "pending" | "granted" | "denied";
  revision: number;
}

export interface PluginCapabilityOperationIndexEntry {
  qualified_id: string;
  kind: "tool" | "workflow" | "action";
  effect: HomerailPluginEffect;
  permissions: string[];
  input_schema_id?: string;
  input_schema_digest?: string;
  output_schema_id?: string;
  output_schema_digest?: string;
  delegated_tool_id?: string;
}

/**
 * Searchable metadata only. Skill content, JSON Schemas and handler documents
 * deliberately stay out of this compact first-pass index.
 */
export interface PluginCapabilityIndexEntry {
  qualified_id: string;
  plugin_id: string;
  plugin_version: string;
  manifest_digest: string;
  package_digest: string;
  local_id: string;
  summary: string;
  intent_examples: string[];
  tags: string[];
  modalities: HomerailPluginModality[];
  required_inputs: string[];
  skill: {
    qualified_id: string;
    digest: string;
  };
  operations: PluginCapabilityOperationIndexEntry[];
  permissions: PluginCapabilityPermissionSnapshot[];
  side_effecting: boolean;
}

export interface PluginCapabilityIndex {
  index_version: 1;
  registry_revision: number;
  registry_fingerprint: string;
  permission_revision: number;
  entries: PluginCapabilityIndexEntry[];
  index_digest: string;
}

export interface CompilePluginCapabilityIndexOptions {
  grants?: readonly PluginPermissionGrantRecord[];
  permission_revision?: number;
  compatibility_target?: HomerailPluginCompatibilityTargetV1;
}

function qualified(pluginId: string, localId: string): string {
  return `${pluginId}:${localId}`;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort(compareText);
}

function effectRank(effect: HomerailPluginEffect): number {
  return { read: 0, write: 1, external: 2, destructive: 3 }[effect];
}

function collectGrants(
  state: PluginRegistryState,
  supplied: readonly PluginPermissionGrantRecord[] | undefined,
): PluginPermissionGrantRecord[] {
  if (supplied) return [...supplied];
  return state.plugins.flatMap((plugin) => (
    listPluginPermissionGrants(plugin.plugin_id, plugin.plugin_version)
  ));
}

function operationPermissions(
  requiredPluginPermissions: readonly string[],
  operationPermissions: readonly string[],
): string[] {
  return uniqueSorted([...requiredPluginPermissions, ...operationPermissions]);
}

export function compilePluginCapabilityIndex(
  state?: PluginRegistryState,
  options: CompilePluginCapabilityIndexOptions = {},
): PluginCapabilityIndex {
  if (!state) ensureBuiltinPluginsSynced();
  const registry = state ?? getPluginRegistryState();
  const target = options.compatibility_target ?? DEFAULT_CAPABILITY_COMPATIBILITY_TARGET;
  const grantRows = collectGrants(registry, options.grants);
  const grants = new Map<string, PluginPermissionGrantRecord>();
  for (const grant of grantRows) {
    const key = `${grant.plugin_id}@${grant.plugin_version}:${grant.permission}`;
    if (grants.has(key)) throw new Error(`Duplicate Plugin permission grant snapshot: ${key}`);
    grants.set(key, grant);
  }
  const entries: PluginCapabilityIndexEntry[] = [];

  for (const plugin of [...registry.plugins].sort((left, right) => compareText(left.plugin_id, right.plugin_id))) {
    if (!plugin.activation.enabled) continue;
    const { manifest } = plugin.descriptor;
    if (validateHomerailPluginCompatibility(manifest, target).length) continue;
    const skills = new Map(plugin.descriptor.skills.map((skill) => [skill.id, skill]));
    const schemas = new Map(plugin.descriptor.schemas.map((schema) => [schema.id, schema]));
    const tools = new Map(manifest.tools.map((tool) => [tool.id, tool]));
    const workflows = new Map(manifest.workflows.map((workflow) => [workflow.id, workflow]));
    const actions = new Map(manifest.actions.map((action) => [action.id, action]));
    const pluginRequired = manifest.permissions.required.map((entry) => entry.permission);

    for (const capability of [...manifest.capabilities].sort((left, right) => compareText(left.id, right.id))) {
      const skill = skills.get(capability.skill);
      if (!skill) continue;
      const operations: PluginCapabilityOperationIndexEntry[] = [];
      for (const id of [...capability.tools].sort()) {
        const tool = tools.get(id);
        if (!tool) continue;
        const inputSchema = schemas.get(tool.input_schema);
        const outputSchema = tool.output_schema ? schemas.get(tool.output_schema) : undefined;
        operations.push({
          qualified_id: qualified(plugin.plugin_id, id),
          kind: "tool",
          effect: tool.effect,
          permissions: operationPermissions(pluginRequired, tool.permissions),
          input_schema_id: tool.input_schema,
          ...(inputSchema ? { input_schema_digest: inputSchema.digest } : {}),
          ...(tool.output_schema ? { output_schema_id: tool.output_schema } : {}),
          ...(outputSchema ? { output_schema_digest: outputSchema.digest } : {}),
        });
      }
      for (const id of [...capability.workflows].sort()) {
        const workflow = workflows.get(id);
        if (!workflow) continue;
        operations.push({
          qualified_id: qualified(plugin.plugin_id, id),
          kind: "workflow",
          effect: workflow.effect,
          permissions: operationPermissions(pluginRequired, workflow.permissions),
        });
      }
      for (const id of [...capability.actions].sort()) {
        const action = actions.get(id);
        if (!action) continue;
        const delegatedTool = tools.get(action.tool);
        if (!delegatedTool) continue;
        const inputSchema = schemas.get(delegatedTool.input_schema);
        const outputSchema = delegatedTool.output_schema ? schemas.get(delegatedTool.output_schema) : undefined;
        operations.push({
          qualified_id: qualified(plugin.plugin_id, id),
          kind: "action",
          effect: delegatedTool.effect,
          permissions: operationPermissions(pluginRequired, delegatedTool.permissions),
          input_schema_id: delegatedTool.input_schema,
          ...(inputSchema ? { input_schema_digest: inputSchema.digest } : {}),
          ...(delegatedTool.output_schema ? { output_schema_id: delegatedTool.output_schema } : {}),
          ...(outputSchema ? { output_schema_digest: outputSchema.digest } : {}),
          delegated_tool_id: qualified(plugin.plugin_id, delegatedTool.id),
        });
      }
      operations.sort((left, right) => (
        compareText(left.qualified_id, right.qualified_id) || compareText(left.kind, right.kind)
      ));
      const requiredPermissions = uniqueSorted([
        ...pluginRequired,
        ...operations.flatMap((operation) => operation.permissions),
      ]);
      const permissions = requiredPermissions.map((permission): PluginCapabilityPermissionSnapshot => {
        const grant = grants.get(`${plugin.plugin_id}@${plugin.plugin_version}:${permission}`);
        return {
          permission,
          status: grant?.status ?? "pending",
          revision: grant?.revision ?? 0,
        };
      });
      entries.push({
        qualified_id: qualified(plugin.plugin_id, capability.id),
        plugin_id: plugin.plugin_id,
        plugin_version: plugin.plugin_version,
        manifest_digest: plugin.descriptor.manifest_digest,
        package_digest: plugin.package_digest,
        local_id: capability.id,
        summary: capability.summary,
        intent_examples: [...capability.intents],
        tags: uniqueSorted(capability.tags ?? []),
        modalities: [...capability.modalities].sort(),
        required_inputs: [...capability.required_inputs].sort(),
        skill: {
          qualified_id: qualified(plugin.plugin_id, capability.skill),
          digest: skill.digest,
        },
        operations,
        permissions,
        side_effecting: operations.some((operation) => effectRank(operation.effect) > 0),
      });
    }
  }

  entries.sort((left, right) => compareText(left.qualified_id, right.qualified_id));
  const permissionRevision = options.permission_revision ?? getPluginPermissionRevision();
  if (!Number.isSafeInteger(permissionRevision) || permissionRevision < 0) {
    throw new Error("Capability index permission revision must be a non-negative safe integer");
  }
  const unsigned = {
    index_version: 1 as const,
    registry_revision: registry.revision,
    registry_fingerprint: registry.fingerprint,
    permission_revision: permissionRevision,
    entries,
  };
  return { ...unsigned, index_digest: pluginJsonDigest(unsigned) };
}
