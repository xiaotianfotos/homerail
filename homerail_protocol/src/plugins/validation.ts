import AjvModule, { type ErrorObject, type ValidateFunction } from "ajv";
import { analyzeGenerativeUiJsonValue } from "../generative-ui/json-value.js";
import { homerailPluginSchemas } from "./schemas.js";
import {
  HomerailPluginRendererMode,
  HomerailPluginRuntimeTrust,
  type HomerailPluginCompatibilityTargetV1,
  type HomerailPluginHandlerV1,
  type HomerailPluginManifestV1,
  type HomerailPluginPermission,
  type HomerailPluginTurnContextV1,
  type HomerailPluginUiProjectionV1,
  type HomerailResolvedPluginDescriptorV1,
  type HomerailPluginValidationError,
  type HomerailPluginValidationResult,
} from "./types.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const AjvClass = (AjvModule as any).default || AjvModule;
const MAX_MANIFEST_BYTES = 512 * 1024;
const MAX_MANIFEST_VALUES = 100_000;
const MAX_MANIFEST_DEPTH = 32;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let validator: any;

function createValidator() {
  const ajv = new AjvClass({ allErrors: true, strict: false, coerceTypes: false });
  for (const [name, schema] of Object.entries(homerailPluginSchemas)) {
    ajv.addSchema(schema, name);
  }
  return ajv;
}

function normalizeErrors(errors: ErrorObject[] | null | undefined): HomerailPluginValidationError[] {
  return (errors ?? []).map((error) => ({
    path: error.instancePath || "",
    message: error.message || "unknown validation error",
    keyword: error.keyword || "schema",
  }));
}

function error(
  path: string,
  message: string,
  keyword: string,
): HomerailPluginValidationError {
  return { path, message, keyword };
}

function duplicateErrors<T>(
  values: T[],
  key: (value: T) => string,
  path: string,
): HomerailPluginValidationError[] {
  const seen = new Set<string>();
  const errors: HomerailPluginValidationError[] = [];
  values.forEach((value, index) => {
    const id = key(value);
    if (seen.has(id)) {
      errors.push(error(`${path}/${index}`, `duplicate declaration: ${id}`, "uniqueDeclaration"));
    }
    seen.add(id);
  });
  return errors;
}

export function isSafeHomerailPluginPackagePath(value: string): boolean {
  if (!value || value.length > 300 || value.startsWith("/") || value.includes("\\")) return false;
  if (!/^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/.test(value)) return false;
  const segments = value.split("/");
  return segments.every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}

interface ParsedSemver {
  core: [number, number, number];
  prerelease: string[];
}

function parseSemver(value: string): ParsedSemver | null {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(value);
  if (!match) return null;
  const core = [Number(match[1]), Number(match[2]), Number(match[3])] as [number, number, number];
  if (!core.every(Number.isSafeInteger)) return null;
  const prerelease = match[4]?.split(".") ?? [];
  if (prerelease.some((part) => /^\d+$/.test(part) && part.length > 1 && part.startsWith("0"))) {
    return null;
  }
  return { core, prerelease };
}

function compareSemver(left: string, right: string): number | null {
  const a = parseSemver(left);
  const b = parseSemver(right);
  if (!a || !b) return null;
  for (let index = 0; index < 3; index += 1) {
    if (a.core[index] !== b.core[index]) return a.core[index] < b.core[index] ? -1 : 1;
  }
  if (!a.prerelease.length && !b.prerelease.length) return 0;
  if (!a.prerelease.length) return 1;
  if (!b.prerelease.length) return -1;
  const length = Math.max(a.prerelease.length, b.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const leftPart = a.prerelease[index];
    const rightPart = b.prerelease[index];
    if (leftPart === undefined) return -1;
    if (rightPart === undefined) return 1;
    if (leftPart === rightPart) continue;
    const leftNumeric = /^\d+$/.test(leftPart);
    const rightNumeric = /^\d+$/.test(rightPart);
    if (leftNumeric && rightNumeric) {
      if (leftPart.length !== rightPart.length) return leftPart.length < rightPart.length ? -1 : 1;
      return leftPart < rightPart ? -1 : 1;
    }
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    return leftPart < rightPart ? -1 : 1;
  }
  return 0;
}

function permissionSet(manifest: HomerailPluginManifestV1): Set<HomerailPluginPermission> {
  return new Set([
    ...manifest.permissions.required.map((grant) => grant.permission),
    ...manifest.permissions.optional.map((grant) => grant.permission),
  ]);
}

function referencedPermissionErrors(
  permissions: HomerailPluginPermission[],
  declared: Set<HomerailPluginPermission>,
  path: string,
): HomerailPluginValidationError[] {
  return permissions.flatMap((permission, index) => (
    declared.has(permission)
      ? []
      : [error(`${path}/${index}`, `permission is not declared: ${permission}`, "permissionReference")]
  ));
}

function handlerErrors(
  handler: HomerailPluginHandlerV1,
  trust: HomerailPluginRuntimeTrust,
  path: string,
): HomerailPluginValidationError[] {
  const errors: HomerailPluginValidationError[] = [];
  if (handler.type === "projection" && !isSafeHomerailPluginPackagePath(handler.file)) {
    errors.push(error(`${path}/file`, "must be a package-relative POSIX path", "packagePath"));
  }
  if (handler.type === "runtime" && trust !== HomerailPluginRuntimeTrust.SANDBOXED_RUNTIME) {
    errors.push(error(`${path}/type`, "runtime handlers require sandboxed_runtime", "runtimeTrust"));
  }
  if (handler.type === "builtin" && trust !== HomerailPluginRuntimeTrust.TRUSTED_BUILTIN) {
    errors.push(error(`${path}/type`, "builtin handlers require trusted_builtin", "runtimeTrust"));
  }
  return errors;
}

function semanticErrors(manifest: HomerailPluginManifestV1): HomerailPluginValidationError[] {
  const errors: HomerailPluginValidationError[] = [];
  errors.push(
    ...duplicateErrors(manifest.capabilities, (value) => value.id, "/capabilities"),
    ...duplicateErrors(manifest.skills, (value) => value.id, "/skills"),
    ...duplicateErrors(manifest.schemas, (value) => value.id, "/schemas"),
    ...duplicateErrors(manifest.schemas, (value) => value.file, "/schemas"),
    ...duplicateErrors(manifest.kinds, (value) => value.kind, "/kinds"),
    ...duplicateErrors(manifest.tools, (value) => value.id, "/tools"),
    ...duplicateErrors(manifest.workflows, (value) => value.id, "/workflows"),
    ...duplicateErrors(manifest.renderers, (value) => value.id, "/renderers"),
    ...duplicateErrors(manifest.actions, (value) => value.id, "/actions"),
  );

  if (compareSemver(manifest.compatibility.homerail.min, manifest.compatibility.homerail.max_exclusive) !== -1) {
    errors.push(error(
      "/compatibility/homerail",
      "min must be lower than max_exclusive",
      "compatibilityRange",
    ));
  }
  if (!parseSemver(manifest.version)) {
    errors.push(error("/version", "must be a canonical semantic version", "semver"));
  }
  if (!manifest.compatibility.plugin_api.includes(manifest.runtime.plugin_api)) {
    errors.push(error(
      "/runtime/plugin_api",
      "runtime plugin_api must be declared compatible",
      "compatibilityReference",
    ));
  }

  const skills = new Set(manifest.skills.map((value) => value.id));
  const schemas = new Set(manifest.schemas.map((value) => value.id));
  const tools = new Set(manifest.tools.map((value) => value.id));
  const workflows = new Set(manifest.workflows.map((value) => value.id));
  const actions = new Set(manifest.actions.map((value) => value.id));
  const declaredPermissions = permissionSet(manifest);

  errors.push(...duplicateErrors(
    [...manifest.permissions.required, ...manifest.permissions.optional],
    (value) => value.permission,
    "/permissions",
  ));
  [...manifest.permissions.required, ...manifest.permissions.optional].forEach((grant, index) => {
    if (grant.permission === "network.connect" && !grant.hosts?.length) {
      errors.push(error(
        `/permissions/${index}/hosts`,
        "network.connect requires a non-empty host allowlist",
        "networkAllowlist",
      ));
    }
    if (grant.permission !== "network.connect" && grant.hosts !== undefined) {
      errors.push(error(
        `/permissions/${index}/hosts`,
        "host allowlists are only valid for network.connect",
        "permissionScope",
      ));
    }
  });

  manifest.skills.forEach((skill, index) => {
    if (!isSafeHomerailPluginPackagePath(skill.path) || !skill.path.endsWith("/SKILL.md")) {
      errors.push(error(
        `/skills/${index}/path`,
        "must be a package-relative path ending in /SKILL.md",
        "skillPath",
      ));
    }
  });
  manifest.schemas.forEach((schema, index) => {
    if (!isSafeHomerailPluginPackagePath(schema.file) || !schema.file.endsWith(".json")) {
      errors.push(error(
        `/schemas/${index}/file`,
        "must be a package-relative JSON file",
        "schemaPath",
      ));
    }
  });

  manifest.capabilities.forEach((capability, index) => {
    if (!skills.has(capability.skill)) {
      errors.push(error(`/capabilities/${index}/skill`, `unknown skill: ${capability.skill}`, "skillReference"));
    }
    capability.tools.forEach((id, refIndex) => {
      if (!tools.has(id)) errors.push(error(`/capabilities/${index}/tools/${refIndex}`, `unknown tool: ${id}`, "toolReference"));
    });
    capability.workflows.forEach((id, refIndex) => {
      if (!workflows.has(id)) errors.push(error(`/capabilities/${index}/workflows/${refIndex}`, `unknown workflow: ${id}`, "workflowReference"));
    });
    capability.actions.forEach((id, refIndex) => {
      if (!actions.has(id)) errors.push(error(`/capabilities/${index}/actions/${refIndex}`, `unknown action: ${id}`, "actionReference"));
    });
  });

  manifest.tools.forEach((tool, index) => {
    if (!schemas.has(tool.input_schema)) {
      errors.push(error(`/tools/${index}/input_schema`, `unknown schema: ${tool.input_schema}`, "schemaReference"));
    }
    if (tool.output_schema && !schemas.has(tool.output_schema)) {
      errors.push(error(`/tools/${index}/output_schema`, `unknown schema: ${tool.output_schema}`, "schemaReference"));
    }
    errors.push(
      ...referencedPermissionErrors(tool.permissions, declaredPermissions, `/tools/${index}/permissions`),
      ...handlerErrors(tool.handler, manifest.runtime.trust, `/tools/${index}/handler`),
    );
    if (tool.effect === "destructive" && tool.confirmation === "never") {
      errors.push(error(`/tools/${index}/confirmation`, "destructive effects require confirmation", "effectConfirmation"));
    }
  });

  manifest.workflows.forEach((workflow, index) => {
    if (!workflow.uri.startsWith(`plugin://${manifest.id}/`)) {
      errors.push(error(`/workflows/${index}/uri`, "URI must be owned by this plugin", "pluginNamespace"));
    }
    const uriPath = workflow.uri.slice(`plugin://${manifest.id}/`.length);
    if (!isSafeHomerailPluginPackagePath(uriPath)) {
      errors.push(error(`/workflows/${index}/uri`, "URI path must be canonical and package-relative", "pluginUri"));
    }
    if (!isSafeHomerailPluginPackagePath(workflow.file)) {
      errors.push(error(`/workflows/${index}/file`, "must be a package-relative POSIX path", "packagePath"));
    }
    errors.push(...referencedPermissionErrors(
      workflow.permissions,
      declaredPermissions,
      `/workflows/${index}/permissions`,
    ));
    if (workflow.effect === "destructive" && workflow.confirmation === "never") {
      errors.push(error(`/workflows/${index}/confirmation`, "destructive effects require confirmation", "effectConfirmation"));
    }
  });

  const kindVersions = new Map<string, Map<number, Set<string>>>();
  manifest.kinds.forEach((kind, kindIndex) => {
    if (!kind.kind.startsWith(`${manifest.id}/`)) {
      errors.push(error(`/kinds/${kindIndex}/kind`, "kind must be owned by this plugin", "pluginNamespace"));
    }
    errors.push(...duplicateErrors(kind.versions, (value) => String(value.version), `/kinds/${kindIndex}/versions`));
    const orderedVersions = kind.versions.map((value) => value.version);
    if (
      orderedVersions.length !== kind.current_version
      || orderedVersions.some((version, index) => version !== index + 1)
    ) {
      errors.push(error(
        `/kinds/${kindIndex}/versions`,
        `versions must be ordered and contiguous from 1 through ${kind.current_version}`,
        "kindVersionSequence",
      ));
    }
    const expectedMigrations = Math.max(0, kind.current_version - 1);
    if (
      kind.migrations.length !== expectedMigrations
      || kind.migrations.some((migration, index) => (
        migration.from !== index + 1 || migration.to !== index + 2
      ))
    ) {
      errors.push(error(
        `/kinds/${kindIndex}/migrations`,
        "migrations must cover every adjacent kind version in order",
        "kindMigrationSequence",
      ));
    }
    kind.migrations.forEach((migration, migrationIndex) => {
      if (!isSafeHomerailPluginPackagePath(migration.file)) {
        errors.push(error(
          `/kinds/${kindIndex}/migrations/${migrationIndex}/file`,
          "must be a package-relative POSIX path",
          "packagePath",
        ));
      }
    });
    const versions = new Map<number, Set<string>>();
    kind.versions.forEach((version, versionIndex) => {
      versions.set(version.version, new Set(version.allowed_surfaces));
      if (!schemas.has(version.content_schema)) {
        errors.push(error(
          `/kinds/${kindIndex}/versions/${versionIndex}/content_schema`,
          `unknown schema: ${version.content_schema}`,
          "schemaReference",
        ));
      }
      if (!version.allowed_surfaces.includes(version.default_surface)) {
        errors.push(error(
          `/kinds/${kindIndex}/versions/${versionIndex}/default_surface`,
          "default_surface must occur in allowed_surfaces",
          "surfaceReference",
        ));
      }
      version.actions.forEach((id, actionIndex) => {
        if (!actions.has(id)) errors.push(error(
          `/kinds/${kindIndex}/versions/${versionIndex}/actions/${actionIndex}`,
          `unknown action: ${id}`,
          "actionReference",
        ));
      });
    });
    kindVersions.set(kind.kind, versions);
  });

  const rendererKeys = new Set<string>();
  manifest.renderers.forEach((renderer, index) => {
    if (!renderer.kind.startsWith(`${manifest.id}/`)) {
      errors.push(error(`/renderers/${index}/kind`, "renderer kind must be owned by this plugin", "pluginNamespace"));
    }
    const versions = kindVersions.get(renderer.kind);
    const allowedSurfaces = versions?.get(renderer.kind_version);
    if (!allowedSurfaces) {
      errors.push(error(`/renderers/${index}/kind_version`, "renderer references an unknown kind version", "kindReference"));
    } else {
      renderer.surfaces.forEach((value, surfaceIndex) => {
        if (!allowedSurfaces.has(value)) errors.push(error(
          `/renderers/${index}/surfaces/${surfaceIndex}`,
          "renderer surface is not allowed by its kind",
          "surfaceReference",
        ));
      });
    }
    if (!manifest.compatibility.renderer_api.includes(renderer.renderer_api)) {
      errors.push(error(`/renderers/${index}/renderer_api`, "renderer_api is not declared compatible", "compatibilityReference"));
    }
    if (
      (renderer.mode === HomerailPluginRendererMode.BUILTIN && renderer.source.type !== "builtin")
      || (renderer.mode === HomerailPluginRendererMode.DECLARATIVE && renderer.source.type !== "declarative")
      || (renderer.mode === HomerailPluginRendererMode.CUSTOM && renderer.source.type !== "custom")
    ) {
      errors.push(error(`/renderers/${index}/source`, "renderer source must match renderer mode", "rendererMode"));
    }
    if (renderer.source.type !== "builtin" && !isSafeHomerailPluginPackagePath(renderer.source.file)) {
      errors.push(error(`/renderers/${index}/source/file`, "must be a package-relative POSIX path", "packagePath"));
    }
    if (renderer.fallback.type === "core_projection" && !isSafeHomerailPluginPackagePath(renderer.fallback.file)) {
      errors.push(error(`/renderers/${index}/fallback/file`, "must be a package-relative POSIX path", "packagePath"));
    }
    for (const rendererSurface of renderer.surfaces) {
      for (const device of renderer.devices) {
        const key = `${renderer.kind}\0${renderer.kind_version}\0${rendererSurface}\0${device}`;
        if (rendererKeys.has(key)) errors.push(error(
          `/renderers/${index}`,
          `duplicate renderer resolution key for ${rendererSurface}/${device}`,
          "uniqueRendererKey",
        ));
        rendererKeys.add(key);
      }
    }
  });

  manifest.actions.forEach((action, index) => {
    if (!action.intent.startsWith(`${manifest.id}.`) && !action.intent.startsWith(`${manifest.id}:`)) {
      errors.push(error(`/actions/${index}/intent`, "action intent must be owned by this plugin", "pluginNamespace"));
    }
    if (!schemas.has(action.input_schema)) {
      errors.push(error(`/actions/${index}/input_schema`, `unknown schema: ${action.input_schema}`, "schemaReference"));
    }
    errors.push(
      ...referencedPermissionErrors(action.permissions, declaredPermissions, `/actions/${index}/permissions`),
      ...handlerErrors(action.handler, manifest.runtime.trust, `/actions/${index}/handler`),
    );
    if (action.effect === "destructive" && action.confirmation === "never") {
      errors.push(error(`/actions/${index}/confirmation`, "destructive effects require confirmation", "effectConfirmation"));
    }
  });

  if (manifest.runtime.trust === HomerailPluginRuntimeTrust.SANDBOXED_RUNTIME) {
    if (!manifest.runtime.entrypoint) {
      errors.push(error("/runtime/entrypoint", "sandboxed_runtime requires an entrypoint", "runtimeEntrypoint"));
    }
  } else if (manifest.runtime.entrypoint) {
    errors.push(error("/runtime/entrypoint", "only sandboxed_runtime may declare an entrypoint", "runtimeEntrypoint"));
  }
  if (manifest.runtime.entrypoint && !isSafeHomerailPluginPackagePath(manifest.runtime.entrypoint.file)) {
    errors.push(error("/runtime/entrypoint/file", "must be a package-relative POSIX path", "packagePath"));
  }

  const expectedStateMigrations = Math.max(0, manifest.state.schema_version - 1);
  if (
    manifest.state.migrations.length !== expectedStateMigrations
    || manifest.state.migrations.some((migration, index) => (
      migration.from !== index + 1 || migration.to !== index + 2
    ))
  ) {
    errors.push(error(
      "/state/migrations",
      "state migrations must cover every adjacent schema version in order",
      "stateMigrationSequence",
    ));
  }
  manifest.state.migrations.forEach((migration, index) => {
    if (!isSafeHomerailPluginPackagePath(migration.file)) {
      errors.push(error(`/state/migrations/${index}/file`, "must be a package-relative POSIX path", "packagePath"));
    }
    errors.push(...referencedPermissionErrors(
      migration.permissions,
      declaredPermissions,
      `/state/migrations/${index}/permissions`,
    ));
    if (migration.effect === "destructive" && migration.confirmation === "never") {
      errors.push(error(`/state/migrations/${index}/confirmation`, "destructive effects require confirmation", "effectConfirmation"));
    }
  });
  return errors;
}

export function resetHomerailPluginValidator(): void {
  validator = undefined;
}

export function validateHomerailPluginManifest(
  value: unknown,
): HomerailPluginValidationResult<HomerailPluginManifestV1> {
  const json = analyzeGenerativeUiJsonValue(value, {
    limits: {
      max_bytes: MAX_MANIFEST_BYTES,
      max_values: MAX_MANIFEST_VALUES,
      max_depth: MAX_MANIFEST_DEPTH,
    },
  });
  if (!json.valid) {
    return {
      valid: false,
      errors: [json.error ?? error("", "invalid JSON value", "jsonValue")],
    };
  }
  let stableValue: unknown;
  try {
    stableValue = structuredClone(value);
  } catch {
    return {
      valid: false,
      errors: [error("", "manifest could not be snapshotted safely", "jsonSnapshot")],
    };
  }
  validator ??= createValidator();
  const validateFn: ValidateFunction | undefined = validator.getSchema("homerail-plugin-manifest-v1");
  if (!validateFn) {
    return { valid: false, errors: [error("", "manifest schema is unavailable", "unknownSchema")] };
  }
  try {
    if (!validateFn(stableValue)) {
      return { valid: false, errors: normalizeErrors(validateFn.errors) };
    }
  } catch {
    return { valid: false, errors: [error("", "manifest schema validation failed safely", "schemaValidation")] };
  }
  const manifest = stableValue as HomerailPluginManifestV1;
  let errors: HomerailPluginValidationError[];
  try {
    errors = semanticErrors(manifest);
  } catch {
    return {
      valid: false,
      errors: [error("", "manifest semantic validation failed safely", "semanticValidation")],
    };
  }
  return errors.length
    ? { valid: false, errors }
    : { valid: true, value: manifest, errors: [] };
}

export function validateHomerailPluginCompatibility(
  manifest: HomerailPluginManifestV1,
  target: HomerailPluginCompatibilityTargetV1,
): HomerailPluginValidationError[] {
  const errors: HomerailPluginValidationError[] = [];
  const lower = compareSemver(target.homerail, manifest.compatibility.homerail.min);
  const upper = compareSemver(target.homerail, manifest.compatibility.homerail.max_exclusive);
  if (lower === null || upper === null || lower < 0 || upper >= 0) {
    errors.push(error(
      "/compatibility/homerail",
      `HomeRail ${target.homerail} is outside the supported range`,
      "incompatibleVersion",
    ));
  }
  for (const [field, version] of [
    ["plugin_api", target.plugin_api],
    ["ui_ir", target.ui_ir],
    ["renderer_api", target.renderer_api],
  ] as const) {
    if (!manifest.compatibility[field].includes(version)) {
      errors.push(error(
        `/compatibility/${field}`,
        `${field} ${version} is not supported`,
        "incompatibleVersion",
      ));
    }
  }
  return errors;
}

export function collectHomerailPluginFileReferences(
  manifest: HomerailPluginManifestV1,
): string[] {
  const references = new Set<string>();
  manifest.skills.forEach((skill) => references.add(skill.path));
  manifest.schemas.forEach((schema) => references.add(schema.file));
  manifest.kinds.forEach((kind) => kind.migrations.forEach((migration) => references.add(migration.file)));
  const addHandler = (handler: HomerailPluginHandlerV1) => {
    if (handler.type === "projection") references.add(handler.file);
  };
  manifest.tools.forEach((tool) => addHandler(tool.handler));
  manifest.workflows.forEach((workflow) => references.add(workflow.file));
  manifest.renderers.forEach((renderer) => {
    if (renderer.source.type !== "builtin") references.add(renderer.source.file);
    if (renderer.fallback.type === "core_projection") references.add(renderer.fallback.file);
  });
  manifest.actions.forEach((action) => addHandler(action.handler));
  if (manifest.runtime.entrypoint) references.add(manifest.runtime.entrypoint.file);
  manifest.state.migrations.forEach((migration) => references.add(migration.file));
  return [...references].sort();
}

function validatePluginWireValue<T>(
  schemaName: string,
  value: unknown,
): HomerailPluginValidationResult<T> {
  const json = analyzeGenerativeUiJsonValue(value, {
    limits: { max_bytes: 8 * 1024 * 1024, max_values: 1_000_000, max_depth: 64 },
  });
  if (!json.valid) {
    return { valid: false, errors: [json.error ?? error("", "invalid JSON value", "jsonValue")] };
  }
  let stableValue: unknown;
  try {
    stableValue = structuredClone(value);
  } catch {
    return { valid: false, errors: [error("", "value could not be snapshotted safely", "jsonSnapshot")] };
  }
  validator ??= createValidator();
  const validateFn: ValidateFunction | undefined = validator.getSchema(schemaName);
  if (!validateFn) return { valid: false, errors: [error("", `schema unavailable: ${schemaName}`, "unknownSchema")] };
  try {
    if (!validateFn(stableValue)) return { valid: false, errors: normalizeErrors(validateFn.errors) };
  } catch {
    return { valid: false, errors: [error("", "wire schema validation failed safely", "schemaValidation")] };
  }
  return { valid: true, value: stableValue as T, errors: [] };
}

function orderingErrors<T>(
  values: T[],
  key: (value: T) => string,
  path: string,
): HomerailPluginValidationError[] {
  const errors: HomerailPluginValidationError[] = [];
  let previous: string | undefined;
  values.forEach((value, index) => {
    const current = key(value);
    if (previous !== undefined && current <= previous) {
      errors.push(error(
        `${path}/${index}`,
        "entries must have unique keys in ascending canonical order",
        "canonicalOrder",
      ));
    }
    previous = current;
  });
  return errors;
}

function qualifiedIdentityErrors(
  value: { plugin_id: string; local_id: string; qualified_id: string },
  path: string,
): HomerailPluginValidationError[] {
  return value.qualified_id === `${value.plugin_id}:${value.local_id}`
    ? []
    : [error(`${path}/qualified_id`, "qualified_id does not match plugin_id and local_id", "qualifiedIdentity")];
}

export function homerailPluginTurnContextDigestInput(
  value: HomerailPluginTurnContextV1,
): Omit<HomerailPluginTurnContextV1, "context_digest"> {
  const { context_digest: _digest, ...input } = structuredClone(value);
  return input;
}

export function validateHomerailPluginTurnContext(
  value: unknown,
): HomerailPluginValidationResult<HomerailPluginTurnContextV1> {
  const validation = validatePluginWireValue<HomerailPluginTurnContextV1>(
    "homerail-plugin-turn-context-v1",
    value,
  );
  if (!validation.value) return validation;
  const context = validation.value;
  const errors: HomerailPluginValidationError[] = [
    ...orderingErrors(context.enabled_plugins, (entry) => entry.id, "/enabled_plugins"),
    ...orderingErrors(context.skills, (entry) => entry.qualified_id, "/skills"),
    ...orderingErrors(context.tools, (entry) => entry.qualified_id, "/tools"),
    ...orderingErrors(context.actions, (entry) => entry.qualified_id, "/actions"),
    ...duplicateErrors(context.tools, (entry) => entry.wire_id, "/tools"),
  ];
  const enabled = new Set(context.enabled_plugins.map((entry) => `${entry.id}@${entry.version}`));
  context.skills.forEach((entry, index) => {
    errors.push(...qualifiedIdentityErrors(entry, `/skills/${index}`));
    errors.push(...orderingErrors(entry.capability_ids, (id) => id, `/skills/${index}/capability_ids`));
    if (!enabled.has(`${entry.plugin_id}@${entry.plugin_version}`)) {
      errors.push(error(`/skills/${index}`, "Skill plugin is not enabled in this context", "enabledPluginReference"));
    }
  });
  context.tools.forEach((entry, index) => {
    errors.push(...qualifiedIdentityErrors(entry, `/tools/${index}`));
    errors.push(...orderingErrors(entry.capability_ids, (id) => id, `/tools/${index}/capability_ids`));
    if (!enabled.has(`${entry.plugin_id}@${entry.plugin_version}`)) {
      errors.push(error(`/tools/${index}`, "Tool plugin is not enabled in this context", "enabledPluginReference"));
    }
  });
  context.actions.forEach((entry, index) => {
    errors.push(...qualifiedIdentityErrors(entry, `/actions/${index}`));
    errors.push(...orderingErrors(entry.capability_ids, (id) => id, `/actions/${index}/capability_ids`));
    if (!enabled.has(`${entry.plugin_id}@${entry.plugin_version}`)) {
      errors.push(error(`/actions/${index}`, "Action plugin is not enabled in this context", "enabledPluginReference"));
    }
  });
  return errors.length ? { valid: false, errors } : validation;
}

export function validateHomerailPluginUiProjection(
  value: unknown,
): HomerailPluginValidationResult<HomerailPluginUiProjectionV1> {
  const validation = validatePluginWireValue<HomerailPluginUiProjectionV1>(
    "homerail-plugin-ui-projection-v1",
    value,
  );
  if (!validation.value) return validation;
  const projection = validation.value;
  const kindKey = (entry: HomerailPluginUiProjectionV1["kinds"][number]) => (
    `${entry.plugin_id}\0${entry.kind}\0${String(entry.kind_version).padStart(2, "0")}`
  );
  const rendererKey = (entry: HomerailPluginUiProjectionV1["renderers"][number]) => (
    `${entry.plugin_id}\0${entry.kind}\0${String(entry.kind_version).padStart(2, "0")}\0${entry.renderer_id}`
  );
  const errors: HomerailPluginValidationError[] = [
    ...orderingErrors(projection.kinds, kindKey, "/kinds"),
    ...orderingErrors(projection.renderers, rendererKey, "/renderers"),
    ...orderingErrors(projection.actions, (entry) => entry.qualified_id, "/actions"),
  ];
  const kinds = new Map(projection.kinds.map((entry) => [
    `${entry.plugin_id}\0${entry.plugin_version}\0${entry.kind}\0${entry.kind_version}`,
    entry,
  ]));
  const resolutionKeys = new Set<string>();
  projection.renderers.forEach((entry, index) => {
    const kind = kinds.get(`${entry.plugin_id}\0${entry.plugin_version}\0${entry.kind}\0${entry.kind_version}`);
    if (!kind || kind.enabled !== entry.enabled || kind.manifest_digest !== entry.manifest_digest) {
      errors.push(error(`/renderers/${index}`, "Renderer does not match an exact projected kind", "kindReference"));
    }
    for (const surfaceValue of entry.surfaces) {
      for (const device of entry.devices) {
        const key = `${entry.kind}\0${entry.kind_version}\0${surfaceValue}\0${device}`;
        if (resolutionKeys.has(key)) {
          errors.push(error(`/renderers/${index}`, "duplicate Renderer resolution key", "uniqueRendererKey"));
        }
        resolutionKeys.add(key);
      }
    }
  });
  projection.actions.forEach((entry, index) => {
    errors.push(...qualifiedIdentityErrors(entry, `/actions/${index}`));
    errors.push(...orderingErrors(entry.capability_ids, (id) => id, `/actions/${index}/capability_ids`));
  });
  return errors.length ? { valid: false, errors } : validation;
}

export function validateHomerailResolvedPluginDescriptorWire(
  value: unknown,
): HomerailPluginValidationResult<HomerailResolvedPluginDescriptorV1> {
  const validation = validatePluginWireValue<HomerailResolvedPluginDescriptorV1>(
    "homerail-resolved-plugin-descriptor-v1",
    value,
  );
  if (!validation.value) return validation;
  const descriptor = validation.value;
  const manifest = validateHomerailPluginManifest(descriptor.manifest);
  if (!manifest.valid) return { valid: false, errors: manifest.errors.map((entry) => ({
    ...entry,
    path: `/manifest${entry.path}`,
  })) };
  const errors: HomerailPluginValidationError[] = [];
  const expectedSchemas = descriptor.manifest.schemas;
  const expectedSkills = descriptor.manifest.skills;
  const expectedFiles = collectHomerailPluginFileReferences(descriptor.manifest);
  if (
    descriptor.schemas.length !== expectedSchemas.length
    || descriptor.schemas.some((entry, index) => (
      entry.id !== expectedSchemas[index]?.id || entry.file !== expectedSchemas[index]?.file
    ))
  ) errors.push(error("/schemas", "resolved schemas must exactly follow manifest order", "resolvedReference"));
  if (
    descriptor.skills.length !== expectedSkills.length
    || descriptor.skills.some((entry, index) => (
      entry.id !== expectedSkills[index]?.id || entry.path !== expectedSkills[index]?.path
    ))
  ) errors.push(error("/skills", "resolved Skills must exactly follow manifest order", "resolvedReference"));
  if (
    descriptor.referenced_files.length !== expectedFiles.length
    || descriptor.referenced_files.some((entry, index) => entry.path !== expectedFiles[index])
  ) errors.push(error("/referenced_files", "archived files must exactly cover references in canonical order", "resolvedReference"));
  return errors.length ? { valid: false, errors } : validation;
}
