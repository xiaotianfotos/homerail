import { isDeepStrictEqual } from "node:util";
import {
  HomerailPluginConfirmation,
  HomerailPluginEffect,
  type HomerailPluginConfirmation as HomerailPluginConfirmationValue,
  type HomerailPluginEffectivePermissionGrantV1,
  type HomerailPluginEffect as HomerailPluginEffectValue,
  type HomerailPluginPermission,
} from "homerail-protocol";
import {
  getPluginPermissionRevision,
  listPluginPackages,
  listPluginPermissionGrants,
  type PluginPermissionGrantRecord,
} from "../persistence/plugins.js";
import { pluginJsonDigest } from "./descriptor.js";

export interface PluginPermissionPolicyGrantV1 {
  permission: HomerailPluginPermission;
  status: "pending" | "granted" | "denied";
  revision: number;
  required: boolean;
  paths?: string[];
  hosts?: string[];
}

export interface PluginPermissionPolicySnapshotV1 {
  plugin_id: string;
  plugin_version: string;
  permission_revision: number;
  effect: HomerailPluginEffectValue;
  confirmation: HomerailPluginConfirmationValue;
  confirmation_required: boolean;
  grants: PluginPermissionPolicyGrantV1[];
  effective_grants: HomerailPluginEffectivePermissionGrantV1[];
  missing_permissions: HomerailPluginPermission[];
  denied_permissions: HomerailPluginPermission[];
  runnable: boolean;
  policy_digest: string;
}

function decodedGrant(record: PluginPermissionGrantRecord): PluginPermissionPolicyGrantV1 {
  const declaration = record.declaration;
  const grant = declaration.grant;
  if (
    typeof declaration.required !== "boolean"
    || !grant
    || typeof grant !== "object"
    || Array.isArray(grant)
    || (grant as Record<string, unknown>).permission !== record.permission
  ) {
    throw new Error(`Invalid persisted plugin permission declaration: ${record.permission}`);
  }
  const value = grant as Record<string, unknown>;
  const paths = Array.isArray(value.paths) && value.paths.every((entry) => typeof entry === "string")
    ? [...value.paths].sort() as string[]
    : undefined;
  const hosts = Array.isArray(value.hosts) && value.hosts.every((entry) => typeof entry === "string")
    ? [...value.hosts].sort() as string[]
    : undefined;
  return {
    permission: record.permission as HomerailPluginPermission,
    status: record.status,
    revision: record.revision,
    required: declaration.required,
    ...(paths ? { paths } : {}),
    ...(hosts ? { hosts } : {}),
  };
}

function requiresConfirmation(
  effect: HomerailPluginEffectValue,
  confirmation: HomerailPluginConfirmationValue,
): boolean {
  if (confirmation === HomerailPluginConfirmation.ALWAYS) return true;
  if (effect === HomerailPluginEffect.DESTRUCTIVE) return true;
  return confirmation === HomerailPluginConfirmation.POLICY && effect !== HomerailPluginEffect.READ;
}

/** Exact version-scoped policy snapshot used to bind confirmation and capability tokens. */
export function resolvePluginPermissionPolicy(input: {
  plugin_id: string;
  plugin_version: string;
  permissions: readonly HomerailPluginPermission[];
  effect: HomerailPluginEffectValue;
  confirmation: HomerailPluginConfirmationValue;
}): PluginPermissionPolicySnapshotV1 {
  const requested = [...new Set(input.permissions)].sort();
  if (requested.length !== input.permissions.length) {
    throw new Error("Plugin action permissions must be unique");
  }
  const pluginPackage = listPluginPackages().find((candidate) => (
    candidate.plugin_id === input.plugin_id && candidate.plugin_version === input.plugin_version
  ));
  if (!pluginPackage) {
    throw new Error(`Plugin action permission package is unavailable: ${input.plugin_id}@${input.plugin_version}`);
  }
  const exactDeclarations = new Map<string, Record<string, unknown>>();
  for (const grant of pluginPackage.descriptor.manifest.permissions.required) {
    exactDeclarations.set(grant.permission, { required: true, grant });
  }
  for (const grant of pluginPackage.descriptor.manifest.permissions.optional) {
    exactDeclarations.set(grant.permission, { required: false, grant });
  }
  const declared = new Map(listPluginPermissionGrants(input.plugin_id, input.plugin_version)
    .map((record) => {
      const expected = exactDeclarations.get(record.permission);
      if (!expected || !isDeepStrictEqual(record.declaration, expected)) {
        throw new Error(`Persisted plugin permission scope does not match the immutable package: ${record.permission}`);
      }
      return [record.permission, decodedGrant(record)];
    }));
  const grants = requested.map((permission) => {
    const grant = declared.get(permission);
    if (!grant) throw new Error(`Plugin action permission was not declared: ${permission}`);
    return grant;
  });
  const effectiveGrants: HomerailPluginEffectivePermissionGrantV1[] = grants.map((grant) => ({
    permission: grant.permission,
    ...(grant.paths?.length ? { paths: [...grant.paths] } : {}),
    ...(grant.hosts?.length ? { hosts: [...grant.hosts] } : {}),
  }));
  const permissionRevision = getPluginPermissionRevision();
  const missing = grants.filter((grant) => grant.status === "pending").map((grant) => grant.permission);
  const denied = grants.filter((grant) => grant.status === "denied").map((grant) => grant.permission);
  const confirmationRequired = requiresConfirmation(input.effect, input.confirmation);
  const digestInput = {
    plugin_id: input.plugin_id,
    plugin_version: input.plugin_version,
    permission_revision: permissionRevision,
    effect: input.effect,
    confirmation: input.confirmation,
    confirmation_required: confirmationRequired,
    grants,
  };
  return {
    ...digestInput,
    effective_grants: effectiveGrants,
    missing_permissions: missing,
    denied_permissions: denied,
    runnable: missing.length === 0 && denied.length === 0,
    policy_digest: pluginJsonDigest(digestInput),
  };
}
