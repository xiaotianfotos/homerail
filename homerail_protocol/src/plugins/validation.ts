import AjvModule, { type ErrorObject, type ValidateFunction } from "ajv";
import { isSafeGenerativeUiArtifactUri } from "../generative-ui/artifact-uri.js";
import {
  GENERATIVE_UI_MAX_TRANSACTION_BYTES,
  analyzeGenerativeUiJsonValue,
} from "../generative-ui/json-value.js";
import {
  isValidGenerativeUiTimestamp,
  validateGenerativeUiNode,
  validateGenerativeUiTransaction,
} from "../generative-ui/validation.js";
import { homerailPluginSchemas } from "./schemas.js";
import {
  HOMERAIL_ACTION_ARGUMENT_MAX_BYTES,
  HOMERAIL_ACTION_CAPABILITY_MAX_TTL_MS,
  HOMERAIL_ACTION_CONFIRMATION_MAX_TTL_MS,
  HOMERAIL_ACTION_REQUEST_MAX_TTL_MS,
  HOMERAIL_RUNTIME_DOMAIN_OUTPUT_MAX_BYTES,
  HomerailPluginRendererMode,
  HomerailPluginRuntimeTrust,
  type HomerailPluginToolBindingV1,
  type HomerailPluginToolCapabilityClaimsV1,
  type HomerailPluginToolConfirmationChallengeV1,
  type HomerailPluginToolConfirmationDecisionV1,
  type HomerailPluginToolInvocationV1,
  type HomerailPluginActionTargetV1,
  type HomerailPluginToolValidationOptionsV1,
  type HomerailPluginAuthorizedToolInvocationV1,
  type HomerailPluginCompatibilityTargetV1,
  type HomerailDeclarativeRendererV1,
  type HomerailDirectUiProjectionV1,
  type HomerailPluginHandlerV1,
  type HomerailPluginManifestV1,
  type HomerailPluginEffectivePermissionGrantV1,
  type HomerailPluginPermission,
  type HomerailPluginTurnContextV1,
  type HomerailPluginToolExecutionEnvelopeV1,
  type HomerailPluginUiProjectionV1,
  type HomerailPluginRuntimeArtifactV1,
  type HomerailPluginRuntimeLogEntryV1,
  type HomerailPluginRuntimeRpcRequestV1,
  type HomerailPluginRuntimeRpcResponseV1,
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

export function isCanonicalHomerailPluginSemver(value: unknown): value is string {
  return typeof value === "string" && value.length >= 5 && value.length <= 64 && parseSemver(value) !== null;
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
  if (
    handler.type === "runtime"
    && trust !== HomerailPluginRuntimeTrust.SANDBOXED_RUNTIME
    && trust !== HomerailPluginRuntimeTrust.TRUSTED_BUILTIN
  ) {
    errors.push(error(`${path}/type`, "runtime handlers require sandboxed_runtime or trusted_builtin", "runtimeTrust"));
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
    ...duplicateErrors(manifest.workflows, (value) => value.uri, "/workflows"),
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
      const tool = manifest.tools.find((entry) => entry.id === id);
      if (!tool) errors.push(error(`/capabilities/${index}/tools/${refIndex}`, `unknown tool: ${id}`, "toolReference"));
      else if (!tool.exposure.includes("agent")) errors.push(error(
        `/capabilities/${index}/tools/${refIndex}`,
        `Action-only Tool cannot enter an Agent capability catalog: ${id}`,
        "toolExposure",
      ));
    });
    capability.workflows.forEach((id, refIndex) => {
      if (!workflows.has(id)) errors.push(error(`/capabilities/${index}/workflows/${refIndex}`, `unknown workflow: ${id}`, "workflowReference"));
    });
    capability.actions.forEach((id, refIndex) => {
      if (!actions.has(id)) errors.push(error(`/capabilities/${index}/actions/${refIndex}`, `unknown action: ${id}`, "actionReference"));
    });
  });

  manifest.tools.forEach((tool, index) => {
    if (tool.exposure.some((value, exposureIndex) => exposureIndex > 0 && value <= tool.exposure[exposureIndex - 1])) {
      errors.push(error(`/tools/${index}/exposure`, "Tool exposure must be unique and canonical", "canonicalOrder"));
    }
    if (!schemas.has(tool.input_schema)) {
      errors.push(error(`/tools/${index}/input_schema`, `unknown schema: ${tool.input_schema}`, "schemaReference"));
    }
    if (tool.output_schema && !schemas.has(tool.output_schema)) {
      errors.push(error(`/tools/${index}/output_schema`, `unknown schema: ${tool.output_schema}`, "schemaReference"));
    }
    if (tool.handler.type === "projection" && !tool.output_schema) {
      errors.push(error(
        `/tools/${index}/output_schema`,
        "projection Tools require an output schema",
        "projectionOutputSchema",
      ));
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
    if (
      renderer.source.type === "custom"
      && !/\.(?:mjs|js)$/.test(renderer.source.file)
    ) {
      errors.push(error(
        `/renderers/${index}/source/file`,
        "custom Renderer source must be an ES module ending in .js or .mjs",
        "customRendererModule",
      ));
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
    if (!tools.has(action.tool)) {
      errors.push(error(`/actions/${index}/tool`, `unknown tool: ${action.tool}`, "toolReference"));
    } else if (!manifest.tools.find((entry) => entry.id === action.tool)?.exposure.includes("action")) {
      errors.push(error(
        `/actions/${index}/tool`,
        "delegated Tool must explicitly allow Action exposure",
        "toolExposure",
      ));
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
    if (entry.handler.type === "projection") {
      if (!entry.output_schema) {
        errors.push(error(`/tools/${index}/output_schema`, "projection Tools require an output schema", "projectionOutputSchema"));
      }
      const projection = validateHomerailDirectUiProjection(entry.handler.document);
      if (!projection.valid) {
        errors.push(...projection.errors.map((entryError) => ({
          ...entryError,
          path: `/tools/${index}/handler/document${entryError.path}`,
        })));
      }
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

export function validateHomerailDirectUiProjection(
  value: unknown,
): HomerailPluginValidationResult<HomerailDirectUiProjectionV1> {
  const validation = validatePluginWireValue<HomerailDirectUiProjectionV1>(
    "homerail-direct-ui-projection-v1",
    value,
  );
  if (!validation.value) return validation;
  const projection = validation.value;
  const errors: HomerailPluginValidationError[] = [];
  errors.push(...duplicateErrors(projection.actions ?? [], (action) => action.id, "/actions"));
  projection.fallback.item_projections?.forEach((item, index) => {
    if (item.mode === "records" && !item.title_pointer) {
      errors.push(error(
        `/fallback/item_projections/${index}/title_pointer`,
        "record fallback projections require title_pointer",
        "fallbackProjection",
      ));
    }
    if (item.mode !== "records" && (
      item.title_pointer !== undefined
      || item.detail_pointer !== undefined
      || item.items_pointer !== undefined
    )) {
      errors.push(error(
        `/fallback/item_projections/${index}`,
        "scalar and string fallback projections cannot declare record pointers",
        "fallbackProjection",
      ));
    }
  });
  if (projection.legacy_bridge) {
    if (projection.actions?.length) {
      errors.push(error("/actions", "legacy bridge projections cannot materialize Actions", "legacyActionBridge"));
    }
    if (
      projection.node_id_pointer !== "/id"
      || projection.content_pointer !== ""
      || projection.fallback.title_pointer !== "/title"
      || projection.omit_content_fields.length !== 1
      || projection.omit_content_fields[0] !== "id"
    ) {
      errors.push(error(
        "/legacy_bridge",
        "legacy bridges require the reversible flat projector profile",
        "reversibleLegacyBridge",
      ));
    }
  }
  return errors.length ? { valid: false, errors } : validation;
}

export function validateHomerailDeclarativeRenderer(
  value: unknown,
): HomerailPluginValidationResult<HomerailDeclarativeRendererV1> {
  const validation = validatePluginWireValue<HomerailDeclarativeRendererV1>(
    "homerail-declarative-renderer-v1",
    value,
  );
  if (!validation.value) return validation;
  const ids = new Set<string>();
  const errors: HomerailPluginValidationError[] = [];
  validation.value.sections.forEach((section, index) => {
    if (ids.has(section.id)) {
      errors.push(error(`/sections/${index}/id`, `duplicate section id: ${section.id}`, "uniqueSectionId"));
    }
    ids.add(section.id);
  });
  return errors.length ? { valid: false, errors } : validation;
}

export function validateHomerailPluginToolExecutionEnvelope(
  value: unknown,
): HomerailPluginValidationResult<HomerailPluginToolExecutionEnvelopeV1> {
  const validation = validatePluginWireValue<HomerailPluginToolExecutionEnvelopeV1>(
    "homerail-plugin-tool-execution-envelope-v1",
    value,
  );
  if (!validation.value) return validation;
  const envelope = validation.value;
  const errors: HomerailPluginValidationError[] = [];
  if (envelope.tool.qualified_id !== `${envelope.plugin.id}:${envelope.tool.local_id}`) {
    errors.push(error("/tool/qualified_id", "Tool identity does not match plugin", "qualifiedIdentity"));
  }
  const node = validateGenerativeUiNode(envelope.projection.node);
  if (!node.valid || !node.value) {
    errors.push(...node.errors.map((entry) => ({ ...entry, path: `/projection/node${entry.path}` })));
  } else if (
    node.value.owner.id !== envelope.plugin.id
    || node.value.owner.version !== envelope.plugin.version
  ) {
    errors.push(error("/projection/node/owner", "Projected node owner does not match plugin", "pluginOwnership"));
  }
  if (node.value && !node.value.id.startsWith(`${envelope.plugin.id}:`)) {
    errors.push(error(
      "/projection/node/id",
      "Projected plugin node id must be namespaced by the owning plugin id",
      "pluginOwnership",
    ));
  }
  const widget = envelope.projection.legacy_widget;
  if (widget && widget.id !== envelope.projection.node.id) {
    errors.push(error("/projection/legacy_widget/id", "Legacy widget id must match projected node", "projectionIdentity"));
  }
  return errors.length ? { valid: false, errors } : validation;
}

const ACTION_BINDING_FIELDS: Array<keyof HomerailPluginToolBindingV1> = [
  "plugin_id",
  "plugin_version",
  "manifest_digest",
  "package_digest",
  "context_digest",
  "registry_revision",
  "permission_revision",
];

const ACTION_TARGET_FIELDS: Array<keyof HomerailPluginActionTargetV1> = [
  "document_id",
  "document_revision",
  "node_id",
  "node_revision",
  "action_id",
  "action_intent",
];

function prefixedPluginErrors(
  errors: HomerailPluginValidationError[],
  prefix: string,
): HomerailPluginValidationError[] {
  return errors.map((entry) => ({ ...entry, path: `${prefix}${entry.path}` }));
}

function timestampMillis(value: string): number | null {
  if (!isValidGenerativeUiTimestamp(value)) return null;
  const millis = Date.parse(value);
  return Number.isFinite(millis) ? millis : null;
}

function actionTimestampErrors(
  value: string,
  path: string,
): HomerailPluginValidationError[] {
  return timestampMillis(value) === null
    ? [error(path, "must be a valid RFC 3339 timestamp", "date-time")]
    : [];
}

function canonicalPermissionErrors(
  permissions: HomerailPluginPermission[],
  path: string,
): HomerailPluginValidationError[] {
  return permissions.some((permissionValue, index) => (
    index > 0 && permissionValue <= permissions[index - 1]
  ))
    ? [error(path, "permissions must be unique and in ascending canonical order", "canonicalOrder")]
    : [];
}

function equalPermissions(
  left: HomerailPluginPermission[],
  right: HomerailPluginPermission[],
): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function isCanonicalPermissionPathScope(value: string): boolean {
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

function isCanonicalPermissionHostScope(value: string): boolean {
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
  if (port !== undefined && (!Number.isSafeInteger(Number(port)) || Number(port) > 65_535)) {
    return false;
  }
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

function canonicalStringListErrors(
  values: string[] | undefined,
  path: string,
  isValid: (value: string) => boolean,
  scopeLabel: string,
): HomerailPluginValidationError[] {
  if (!values) return [];
  const errors: HomerailPluginValidationError[] = [];
  values.forEach((value, index) => {
    if (!isValid(value)) {
      errors.push(error(`${path}/${index}`, `must be a canonical ${scopeLabel} scope`, "permissionScope"));
    }
    if (index > 0 && value <= values[index - 1]) {
      errors.push(error(
        path,
        `${scopeLabel} scopes must be unique and in ascending canonical order`,
        "canonicalOrder",
      ));
    }
  });
  return errors;
}

function effectivePermissionGrantErrors(
  grants: HomerailPluginEffectivePermissionGrantV1[],
  permissions: HomerailPluginPermission[],
  path: string,
): HomerailPluginValidationError[] {
  const errors: HomerailPluginValidationError[] = [];
  grants.forEach((grant, index) => {
    if (index > 0 && grant.permission <= grants[index - 1].permission) {
      errors.push(error(
        path,
        "effective grants must have unique permissions in ascending canonical order",
        "canonicalOrder",
      ));
    }
    errors.push(
      ...canonicalStringListErrors(grant.paths, `${path}/${index}/paths`, isCanonicalPermissionPathScope, "path"),
      ...canonicalStringListErrors(grant.hosts, `${path}/${index}/hosts`, isCanonicalPermissionHostScope, "host"),
    );
    if (grant.permission === "network.connect") {
      if (!grant.hosts?.length) {
        errors.push(error(
          `${path}/${index}/hosts`,
          "network.connect effective grants require a non-empty host allowlist",
          "networkAllowlist",
        ));
      }
    } else if (grant.hosts !== undefined) {
      errors.push(error(
        `${path}/${index}/hosts`,
        "host scopes are only valid for network.connect",
        "permissionScope",
      ));
    }
  });
  const grantPermissions = grants.map((grant) => grant.permission);
  if (!equalPermissions(permissions, grantPermissions)) {
    errors.push(error(
      path,
      "effective grants must exactly match the permissions index without widening or dropping authority",
      "permissionEscalation",
    ));
  }
  return errors;
}

function equalOptionalStrings(left?: string[], right?: string[]): boolean {
  if (left === undefined || right === undefined) return left === right;
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function equalEffectivePermissionGrants(
  left: HomerailPluginEffectivePermissionGrantV1[],
  right: HomerailPluginEffectivePermissionGrantV1[],
): boolean {
  return left.length === right.length && left.every((grant, index) => {
    const expected = right[index];
    return expected !== undefined
      && grant.permission === expected.permission
      && equalOptionalStrings(grant.paths, expected.paths)
      && equalOptionalStrings(grant.hosts, expected.hosts);
  });
}

function actionBindingErrors(
  actual: HomerailPluginToolBindingV1,
  expected: HomerailPluginToolBindingV1,
  path: string,
): HomerailPluginValidationError[] {
  return ACTION_BINDING_FIELDS.flatMap((field) => actual[field] === expected[field]
    ? []
    : [error(`${path}/${field}`, `does not match the exact resolved ${field}`, "bindingMismatch")]);
}

function actionTargetErrors(
  actual: HomerailPluginActionTargetV1,
  expected: HomerailPluginActionTargetV1,
  path: string,
): HomerailPluginValidationError[] {
  return ACTION_TARGET_FIELDS.flatMap((field) => actual[field] === expected[field]
    ? []
    : [error(`${path}/${field}`, `does not match the live ${field}`, "staleTarget")]);
}

function toolIdentityErrors(
  actual: HomerailPluginToolInvocationV1["tool"],
  expected: HomerailPluginToolInvocationV1["tool"],
  path: string,
): HomerailPluginValidationError[] {
  const errors: HomerailPluginValidationError[] = [];
  for (const field of ["local_id", "qualified_id", "wire_id"] as const) {
    if (actual[field] !== expected[field]) {
      errors.push(error(`${path}/${field}`, `does not match the exact resolved Tool ${field}`, "toolIdentity"));
    }
  }
  if (actual.handler.type !== expected.handler.type) {
    errors.push(error(`${path}/handler/type`, "does not match the exact resolved Tool handler", "handlerIdentity"));
  } else if (
    (actual.handler.type === "projection" && expected.handler.type === "projection" && actual.handler.digest !== expected.handler.digest)
    || (actual.handler.type === "runtime" && expected.handler.type === "runtime" && actual.handler.method !== expected.handler.method)
    || (actual.handler.type === "builtin" && expected.handler.type === "builtin" && actual.handler.id !== expected.handler.id)
  ) {
    errors.push(error(`${path}/handler`, "does not match the exact resolved Tool handler identity", "handlerIdentity"));
  }
  return errors;
}

function toolSourceErrors(
  actual: HomerailPluginToolInvocationV1["source"],
  expected: HomerailPluginToolInvocationV1["source"],
  path: string,
): HomerailPluginValidationError[] {
  if (actual.type !== expected.type) {
    return [error(`${path}/type`, "does not match the Manager-resolved invocation source", "sourceIdentity")];
  }
  if (actual.type === "ui_action" && expected.type === "ui_action") {
    const errors = actionTargetErrors(actual.target, expected.target, `${path}/target`);
    if (actual.action.local_id !== expected.action.local_id) {
      errors.push(error(`${path}/action/local_id`, "does not match the resolved Action", "actionIdentity"));
    }
    if (actual.action.qualified_id !== expected.action.qualified_id) {
      errors.push(error(`${path}/action/qualified_id`, "does not match the resolved Action", "actionIdentity"));
    }
    if (actual.input_digest !== expected.input_digest) {
      errors.push(error(`${path}/input_digest`, "does not match the exact user Action input", "requestDigest"));
    }
    return errors;
  }
  if (actual.type === "agent" && expected.type === "agent") {
    const errors: HomerailPluginValidationError[] = [];
    if (actual.call_id !== expected.call_id) errors.push(error(`${path}/call_id`, "does not match the Agent Tool call", "sourceIdentity"));
    if (actual.modality !== expected.modality) errors.push(error(`${path}/modality`, "does not match the routed modality", "sourceIdentity"));
    if (actual.scope.type !== expected.scope.type || actual.scope.id !== expected.scope.id) {
      errors.push(error(`${path}/scope`, "does not match the Manager-resolved scope", "scopeIdentity"));
    }
    if (
      actual.target.document_id !== expected.target.document_id
      || actual.target.base_revision !== expected.target.base_revision
    ) errors.push(error(`${path}/target`, "does not match the Manager-resolved canonical document", "staleTarget"));
    return errors;
  }
  return [];
}

/** Canonical digest input. Hashing/signing is deliberately owned by Manager. */
export function homerailPluginToolInvocationDigestInput(
  value: HomerailPluginToolInvocationV1,
): Omit<HomerailPluginToolInvocationV1, "request_digest"> {
  const { request_digest: _digest, ...input } = structuredClone(value);
  return input;
}

export function validateHomerailPluginToolInvocation(
  value: unknown,
  options: HomerailPluginToolValidationOptionsV1 = {},
): HomerailPluginValidationResult<HomerailPluginToolInvocationV1> {
  const validation = validatePluginWireValue<HomerailPluginToolInvocationV1>(
    "homerail-plugin-tool-invocation-v1",
    value,
  );
  if (!validation.value) return validation;
  const invocation = validation.value;
  const errors: HomerailPluginValidationError[] = [
    ...actionTimestampErrors(invocation.invoked_at, "/invoked_at"),
    ...actionTimestampErrors(invocation.deadline_at, "/deadline_at"),
    ...canonicalPermissionErrors(invocation.policy.permissions, "/policy/permissions"),
    ...effectivePermissionGrantErrors(
      invocation.policy.effective_grants,
      invocation.policy.permissions,
      "/policy/effective_grants",
    ),
  ];

  if (invocation.tool.qualified_id !== `${invocation.binding.plugin_id}:${invocation.tool.local_id}`) {
    errors.push(error(
      "/tool/qualified_id",
      "qualified Tool identity does not match the exact plugin and local id",
      "qualifiedIdentity",
    ));
  }
  if (invocation.source.type === "ui_action") {
    if (invocation.source.action.qualified_id !== `${invocation.binding.plugin_id}:${invocation.source.action.local_id}`) {
      errors.push(error(
        "/source/action/qualified_id",
        "qualified Action identity does not match the exact plugin and local id",
        "qualifiedIdentity",
      ));
    }
    if (invocation.source.target.action_id !== invocation.source.action.local_id) {
      errors.push(error(
        "/source/target/action_id",
        "node Action id does not match the resolved plugin Action local id",
        "actionIdentity",
      ));
    }
    if (
      !invocation.source.target.action_intent.startsWith(`${invocation.binding.plugin_id}:`)
      && !invocation.source.target.action_intent.startsWith(`${invocation.binding.plugin_id}.`)
    ) {
      errors.push(error(
        "/source/target/action_intent",
        "symbolic Action intent must be owned by the bound plugin",
        "pluginNamespace",
      ));
    }
  }
  if (
    (invocation.policy.confirmation === "always" && !invocation.policy.confirmation_required)
    || (invocation.policy.confirmation === "never" && invocation.policy.confirmation_required)
    || (invocation.policy.effect === "destructive" && !invocation.policy.confirmation_required)
  ) {
    errors.push(error(
      "/policy/confirmation_required",
      "resolved confirmation requirement conflicts with the declared effect/confirmation policy",
      "confirmationPolicy",
    ));
  }

  const invokedAt = timestampMillis(invocation.invoked_at);
  const deadlineAt = timestampMillis(invocation.deadline_at);
  if (invokedAt !== null && deadlineAt !== null) {
    const lifetime = deadlineAt - invokedAt;
    if (lifetime <= 0 || lifetime > HOMERAIL_ACTION_REQUEST_MAX_TTL_MS) {
      errors.push(error(
        "/deadline_at",
        `Tool deadline must be after invocation and within ${HOMERAIL_ACTION_REQUEST_MAX_TTL_MS} ms`,
        "requestLifetime",
      ));
    }
    if (options.now_ms !== undefined && options.now_ms > deadlineAt) {
      errors.push(error("/deadline_at", "Tool request deadline has expired", "staleRequest"));
    }
    if (options.now_ms !== undefined && invokedAt > options.now_ms + 30_000) {
      errors.push(error("/invoked_at", "Tool invocation is unacceptably far in the future", "futureTimestamp"));
    }
  }

  const argumentAnalysis = analyzeGenerativeUiJsonValue(invocation.arguments, {
    path: "/arguments",
    limits: {
      max_bytes: HOMERAIL_ACTION_ARGUMENT_MAX_BYTES,
      max_values: 4_096,
      max_depth: 32,
    },
  });
  if (!argumentAnalysis.valid) {
    errors.push(argumentAnalysis.error ?? error(
      "/arguments",
      `Tool arguments exceed ${HOMERAIL_ACTION_ARGUMENT_MAX_BYTES} bytes`,
      "maxPayloadBytes",
    ));
  }

  if (options.expected) {
    errors.push(
      ...(options.expected.tool ? toolIdentityErrors(invocation.tool, options.expected.tool, "/tool") : []),
      ...actionBindingErrors(invocation.binding, options.expected.binding, "/binding"),
      ...(options.expected.source ? toolSourceErrors(invocation.source, options.expected.source, "/source") : []),
    );
    if (options.expected.request_id && invocation.request_id !== options.expected.request_id) {
      errors.push(error("/request_id", "request id does not match expected execution", "requestIdentity"));
    }
    if (options.expected.request_digest && invocation.request_digest !== options.expected.request_digest) {
      errors.push(error("/request_digest", "request digest does not match expected execution", "requestDigest"));
    }
    if (options.expected.policy) {
      const expectedPolicy = options.expected.policy;
      if (invocation.policy.effect !== expectedPolicy.effect) {
        errors.push(error("/policy/effect", "Tool effect differs from the resolved manifest policy", "effectEscalation"));
      }
      if (!equalPermissions(invocation.policy.permissions, expectedPolicy.permissions)) {
        errors.push(error(
          "/policy/permissions",
          "Tool permissions differ from the resolved manifest/grant policy",
          "permissionEscalation",
        ));
      }
      if (!equalEffectivePermissionGrants(
        invocation.policy.effective_grants,
        expectedPolicy.effective_grants,
      )) {
        errors.push(error(
          "/policy/effective_grants",
          "Tool effective grants differ from the exact resolved manifest/grant scope",
          "permissionEscalation",
        ));
      }
      if (
        invocation.policy.confirmation !== expectedPolicy.confirmation
        || invocation.policy.confirmation_required !== expectedPolicy.confirmation_required
      ) {
        errors.push(error(
          "/policy/confirmation_required",
          "Tool confirmation differs from the resolved host policy",
          "confirmationPolicy",
        ));
      }
    }
  }
  const previous = options.idempotency_records?.get(invocation.idempotency_key);
  if (previous && (
    previous.request_id !== invocation.request_id
    || previous.request_digest !== invocation.request_digest
  )) {
    errors.push(error(
      "/idempotency_key",
      "idempotency key is already bound to a different request",
      "idempotencyCollision",
    ));
  }
  return errors.length ? { valid: false, errors } : validation;
}

export function validateHomerailPluginToolCapabilityClaims(
  value: unknown,
  invocation?: HomerailPluginToolInvocationV1,
  options: HomerailPluginToolValidationOptionsV1 = {},
): HomerailPluginValidationResult<HomerailPluginToolCapabilityClaimsV1> {
  const validation = validatePluginWireValue<HomerailPluginToolCapabilityClaimsV1>(
    "homerail-plugin-tool-capability-claims-v1",
    value,
  );
  if (!validation.value) return validation;
  const claims = validation.value;
  const errors: HomerailPluginValidationError[] = [
    ...actionTimestampErrors(claims.issued_at, "/issued_at"),
    ...actionTimestampErrors(claims.expires_at, "/expires_at"),
    ...canonicalPermissionErrors(claims.permissions, "/permissions"),
    ...effectivePermissionGrantErrors(claims.effective_grants, claims.permissions, "/effective_grants"),
  ];
  const issuedAt = timestampMillis(claims.issued_at);
  const expiresAt = timestampMillis(claims.expires_at);
  if (issuedAt !== null && expiresAt !== null) {
    const lifetime = expiresAt - issuedAt;
    if (lifetime <= 0 || lifetime > HOMERAIL_ACTION_CAPABILITY_MAX_TTL_MS) {
      errors.push(error(
        "/expires_at",
        `capability must expire after issuance and within ${HOMERAIL_ACTION_CAPABILITY_MAX_TTL_MS} ms`,
        "capabilityLifetime",
      ));
    }
    if (options.now_ms !== undefined && options.now_ms < issuedAt) {
      errors.push(error("/issued_at", "capability is not active yet", "capabilityNotActive"));
    }
    if (options.now_ms !== undefined && options.now_ms >= expiresAt) {
      errors.push(error("/expires_at", "capability has expired", "capabilityExpired"));
    }
  }
  if (options.consumed_capability_nonces?.has(claims.nonce)) {
    errors.push(error("/nonce", "single-use capability nonce has already been consumed", "capabilityReplay"));
  }
  if (invocation) {
    if (claims.request_id !== invocation.request_id) {
      errors.push(error("/request_id", "capability is bound to a different request", "requestIdentity"));
    }
    if (claims.request_digest !== invocation.request_digest) {
      errors.push(error("/request_digest", "capability is bound to a different request digest", "requestDigest"));
    }
    errors.push(...actionBindingErrors(claims.binding, invocation.binding, "/binding"));
    if (claims.effect !== invocation.policy.effect) {
      errors.push(error("/effect", "capability effect does not exactly match requested effect", "effectEscalation"));
    }
    if (!equalPermissions(claims.permissions, invocation.policy.permissions)) {
      errors.push(error(
        "/permissions",
        "capability permissions must exactly match the requested permission set",
        "permissionEscalation",
      ));
    }
    if (!equalEffectivePermissionGrants(claims.effective_grants, invocation.policy.effective_grants)) {
      errors.push(error(
        "/effective_grants",
        "capability effective grants must exactly match the requested permission scopes",
        "permissionEscalation",
      ));
    }
    if (issuedAt !== null) {
      const invokedAt = timestampMillis(invocation.invoked_at);
      if (invokedAt !== null && issuedAt < invokedAt) {
        errors.push(error("/issued_at", "capability cannot predate its request", "capabilityBinding"));
      }
    }
    if (expiresAt !== null) {
      const deadlineAt = timestampMillis(invocation.deadline_at);
      if (deadlineAt !== null && expiresAt > deadlineAt) {
        errors.push(error("/expires_at", "capability cannot outlive its request", "capabilityBinding"));
      }
    }
  }
  return errors.length ? { valid: false, errors } : validation;
}

export function validateHomerailPluginToolConfirmationChallenge(
  value: unknown,
  invocation?: HomerailPluginToolInvocationV1,
  options: HomerailPluginToolValidationOptionsV1 = {},
): HomerailPluginValidationResult<HomerailPluginToolConfirmationChallengeV1> {
  const validation = validatePluginWireValue<HomerailPluginToolConfirmationChallengeV1>(
    "homerail-plugin-tool-confirmation-challenge-v1",
    value,
  );
  if (!validation.value) return validation;
  const challenge = validation.value;
  const errors: HomerailPluginValidationError[] = [
    ...actionTimestampErrors(challenge.issued_at, "/issued_at"),
    ...actionTimestampErrors(challenge.expires_at, "/expires_at"),
    ...canonicalPermissionErrors(challenge.permissions, "/permissions"),
    ...effectivePermissionGrantErrors(
      challenge.effective_grants,
      challenge.permissions,
      "/effective_grants",
    ),
  ];
  const issuedAt = timestampMillis(challenge.issued_at);
  const expiresAt = timestampMillis(challenge.expires_at);
  if (issuedAt !== null && expiresAt !== null) {
    const lifetime = expiresAt - issuedAt;
    if (lifetime <= 0 || lifetime > HOMERAIL_ACTION_CONFIRMATION_MAX_TTL_MS) {
      errors.push(error(
        "/expires_at",
        `confirmation challenge must expire within ${HOMERAIL_ACTION_CONFIRMATION_MAX_TTL_MS} ms`,
        "confirmationLifetime",
      ));
    }
    if (options.now_ms !== undefined && options.now_ms >= expiresAt) {
      errors.push(error("/expires_at", "confirmation challenge has expired", "confirmationExpired"));
    }
  }
  if (invocation) {
    if (challenge.request_id !== invocation.request_id) {
      errors.push(error("/request_id", "challenge is bound to a different request", "requestIdentity"));
    }
    if (challenge.request_digest !== invocation.request_digest) {
      errors.push(error("/request_digest", "challenge is bound to a different request digest", "requestDigest"));
    }
    if (challenge.effect !== invocation.policy.effect) {
      errors.push(error("/effect", "challenge effect does not match request policy", "effectEscalation"));
    }
    if (!equalPermissions(challenge.permissions, invocation.policy.permissions)) {
      errors.push(error("/permissions", "challenge permissions do not match request policy", "permissionEscalation"));
    }
    if (!equalEffectivePermissionGrants(challenge.effective_grants, invocation.policy.effective_grants)) {
      errors.push(error(
        "/effective_grants",
        "challenge effective grants do not match request policy scopes",
        "permissionEscalation",
      ));
    }
    if (issuedAt !== null) {
      const invokedAt = timestampMillis(invocation.invoked_at);
      if (invokedAt !== null && issuedAt < invokedAt) {
        errors.push(error("/issued_at", "confirmation cannot predate its request", "confirmationBinding"));
      }
    }
    if (expiresAt !== null) {
      const deadlineAt = timestampMillis(invocation.deadline_at);
      if (deadlineAt !== null && expiresAt > deadlineAt) {
        errors.push(error("/expires_at", "confirmation cannot outlive its request", "confirmationBinding"));
      }
    }
  }
  return errors.length ? { valid: false, errors } : validation;
}

export function validateHomerailPluginToolConfirmationDecision(
  value: unknown,
  invocation?: HomerailPluginToolInvocationV1,
  challenge?: HomerailPluginToolConfirmationChallengeV1,
): HomerailPluginValidationResult<HomerailPluginToolConfirmationDecisionV1> {
  const validation = validatePluginWireValue<HomerailPluginToolConfirmationDecisionV1>(
    "homerail-plugin-tool-confirmation-decision-v1",
    value,
  );
  if (!validation.value) return validation;
  const decision = validation.value;
  const errors: HomerailPluginValidationError[] = [
    ...actionTimestampErrors(decision.decided_at, "/decided_at"),
  ];
  if (invocation) {
    if (decision.request_id !== invocation.request_id) {
      errors.push(error("/request_id", "decision is bound to a different request", "requestIdentity"));
    }
    if (decision.request_digest !== invocation.request_digest) {
      errors.push(error("/request_digest", "decision is bound to a different request digest", "requestDigest"));
    }
  }
  if (challenge) {
    if (decision.challenge_id !== challenge.challenge_id) {
      errors.push(error("/challenge_id", "decision does not answer this challenge", "challengeIdentity"));
    }
    if (
      decision.request_id !== challenge.request_id
      || decision.request_digest !== challenge.request_digest
    ) {
      errors.push(error("/request_digest", "decision and challenge request bindings differ", "confirmationBinding"));
    }
    const decidedAt = timestampMillis(decision.decided_at);
    const issuedAt = timestampMillis(challenge.issued_at);
    const expiresAt = timestampMillis(challenge.expires_at);
    if (
      decidedAt !== null
      && issuedAt !== null
      && expiresAt !== null
      && (decidedAt < issuedAt || decidedAt >= expiresAt)
    ) {
      errors.push(error(
        "/decided_at",
        "decision must occur while the exact challenge is active",
        "confirmationExpired",
      ));
    }
  }
  return errors.length ? { valid: false, errors } : validation;
}

export function validateHomerailPluginAuthorizedToolInvocation(
  value: unknown,
  options: HomerailPluginToolValidationOptionsV1 = {},
): HomerailPluginValidationResult<HomerailPluginAuthorizedToolInvocationV1> {
  const validation = validatePluginWireValue<HomerailPluginAuthorizedToolInvocationV1>(
    "homerail-plugin-authorized-tool-invocation-v1",
    value,
  );
  if (!validation.value) return validation;
  const authorization = validation.value;
  const invocation = validateHomerailPluginToolInvocation(authorization.invocation, options);
  const capability = validateHomerailPluginToolCapabilityClaims(
    authorization.capability,
    authorization.invocation,
    options,
  );
  const errors: HomerailPluginValidationError[] = [
    ...prefixedPluginErrors(invocation.errors, "/invocation"),
    ...prefixedPluginErrors(capability.errors, "/capability"),
  ];
  const confirmation = authorization.confirmation;
  if (authorization.invocation.policy.confirmation_required && !confirmation) {
    errors.push(error(
      "/confirmation",
      "resolved Action policy requires an exact approved confirmation",
      "confirmationRequired",
    ));
  }
  if (!authorization.invocation.policy.confirmation_required && confirmation) {
    errors.push(error(
      "/confirmation",
      "confirmation is forbidden when the resolved Action policy does not require it",
      "confirmationPolicy",
    ));
  }
  if (confirmation) {
    const challenge = validateHomerailPluginToolConfirmationChallenge(
      confirmation.challenge,
      authorization.invocation,
      options,
    );
    const decision = validateHomerailPluginToolConfirmationDecision(
      confirmation.decision,
      authorization.invocation,
      confirmation.challenge,
    );
    errors.push(
      ...prefixedPluginErrors(challenge.errors, "/confirmation/challenge"),
      ...prefixedPluginErrors(decision.errors, "/confirmation/decision"),
    );
    if (confirmation.decision.decision !== "approved") {
      errors.push(error(
        "/confirmation/decision/decision",
        "denied confirmation cannot authorize execution",
        "confirmationDenied",
      ));
    }
    const decisionAt = timestampMillis(confirmation.decision.decided_at);
    const capabilityAt = timestampMillis(authorization.capability.issued_at);
    if (decisionAt !== null && capabilityAt !== null && capabilityAt < decisionAt) {
      errors.push(error(
        "/capability/issued_at",
        "execution capability cannot predate required confirmation",
        "capabilityBinding",
      ));
    }
  }
  return errors.length ? { valid: false, errors } : validation;
}

function runtimeLogAndArtifactErrors(
  logs: HomerailPluginRuntimeLogEntryV1[],
  artifacts: HomerailPluginRuntimeArtifactV1[],
  completedAt: string,
): HomerailPluginValidationError[] {
  const errors: HomerailPluginValidationError[] = [];
  const completedAtMs = timestampMillis(completedAt);
  logs.forEach((entry, index) => {
    if (entry.sequence !== index) {
      errors.push(error(
        `/logs/${index}/sequence`,
        "log sequence must be contiguous and start at zero",
        "canonicalOrder",
      ));
    }
    errors.push(...actionTimestampErrors(entry.timestamp, `/logs/${index}/timestamp`));
    const logAt = timestampMillis(entry.timestamp);
    if (completedAtMs !== null && logAt !== null && logAt > completedAtMs) {
      errors.push(error(
        `/logs/${index}/timestamp`,
        "log timestamp cannot be after response completion",
        "timestampOrder",
      ));
    }
  });
  let previousArtifactId: string | undefined;
  artifacts.forEach((artifact, index) => {
    if (previousArtifactId !== undefined && artifact.id <= previousArtifactId) {
      errors.push(error(
        `/artifacts/${index}/id`,
        "artifact ids must be unique and in ascending canonical order",
        "canonicalOrder",
      ));
    }
    previousArtifactId = artifact.id;
    if (!isSafeGenerativeUiArtifactUri(artifact.uri)) {
      errors.push(error(
        `/artifacts/${index}/uri`,
        "must be a passive http(s), artifact, drive, or local path reference",
        "artifactUri",
      ));
    }
  });
  return errors;
}

export function validateHomerailPluginRuntimeRpcRequest(
  value: unknown,
  options: HomerailPluginToolValidationOptionsV1 = {},
): HomerailPluginValidationResult<HomerailPluginRuntimeRpcRequestV1> {
  const validation = validatePluginWireValue<HomerailPluginRuntimeRpcRequestV1>(
    "homerail-plugin-runtime-rpc-request-v1",
    value,
  );
  if (!validation.value) return validation;
  const request = validation.value;
  const errors: HomerailPluginValidationError[] = [
    ...actionTimestampErrors(request.sent_at, "/sent_at"),
  ];
  if (request.method === "execute" || request.method === "prepare") {
    const authorization = validateHomerailPluginAuthorizedToolInvocation(
      request.params.authorization,
      options,
    );
    errors.push(...prefixedPluginErrors(authorization.errors, "/params/authorization"));
    const sentAt = timestampMillis(request.sent_at);
    const invocation = request.params.authorization.invocation;
    const invokedAt = timestampMillis(invocation.invoked_at);
    const deadlineAt = timestampMillis(invocation.deadline_at);
    const capabilityAt = timestampMillis(request.params.authorization.capability.issued_at);
    const capabilityExpiresAt = timestampMillis(request.params.authorization.capability.expires_at);
    const confirmationExpiresAt = request.params.authorization.confirmation
      ? timestampMillis(request.params.authorization.confirmation.challenge.expires_at)
      : null;
    if (
      sentAt !== null
      && ((invokedAt !== null && sentAt < invokedAt)
        || (deadlineAt !== null && sentAt >= deadlineAt)
        || (capabilityAt !== null && sentAt < capabilityAt)
        || (capabilityExpiresAt !== null && sentAt >= capabilityExpiresAt)
        || (confirmationExpiresAt !== null && sentAt >= confirmationExpiresAt))
    ) {
      errors.push(error(
        "/sent_at",
        `${request.method} RPC must be sent while the request, capability, and confirmation are active`,
        "timestampOrder",
      ));
    }
    if (request.method === "execute" && request.params.artifact_uploads) {
      const uploads = request.params.artifact_uploads;
      if (!request.params.authorization.invocation.policy.permissions.includes("artifact.write")) {
        errors.push(error("/params/artifact_uploads", "artifact uploads require artifact.write authority", "permissionEscalation"));
      }
      uploads.forEach((upload, index) => {
        if (index > 0 && upload.id <= uploads[index - 1]!.id) {
          errors.push(error("/params/artifact_uploads", "artifact upload ids must be unique and canonical", "canonicalOrder"));
        }
        try {
          const target = new URL(upload.upload_url);
          if ((target.protocol !== "http:" && target.protocol !== "https:")
            || target.username || target.password || target.hash) {
            errors.push(error(`/params/artifact_uploads/${index}/upload_url`, "upload URL is not an exact broker endpoint", "artifactBroker"));
          }
        } catch {
          errors.push(error(`/params/artifact_uploads/${index}/upload_url`, "upload URL is invalid", "artifactBroker"));
        }
      });
    }
  } else if (request.method === "cancel" || request.method === "reconcile") {
    if (options.expected?.request_id && request.params.request_id !== options.expected.request_id) {
      errors.push(error("/params/request_id", `${request.method} targets a different request`, "requestIdentity"));
    }
    if (
      options.expected?.request_digest
      && request.params.request_digest !== options.expected.request_digest
    ) {
      errors.push(error("/params/request_digest", `${request.method} targets a different digest`, "requestDigest"));
    }
  } else if (options.expected) {
    errors.push(...actionBindingErrors(request.params.binding, options.expected.binding, "/params/binding"));
  }
  return errors.length ? { valid: false, errors } : validation;
}

export function validateHomerailPluginRuntimeRpcResponse(
  value: unknown,
  options: HomerailPluginToolValidationOptionsV1 = {},
): HomerailPluginValidationResult<HomerailPluginRuntimeRpcResponseV1> {
  const validation = validatePluginWireValue<HomerailPluginRuntimeRpcResponseV1>(
    "homerail-plugin-runtime-rpc-response-v1",
    value,
  );
  if (!validation.value) return validation;
  const response = validation.value;
  const errors: HomerailPluginValidationError[] = [
    ...actionTimestampErrors(response.completed_at, "/completed_at"),
    ...runtimeLogAndArtifactErrors(response.logs, response.artifacts, response.completed_at),
  ];

  if (response.message_type === "error") {
    const hasRequestId = response.request_id !== undefined;
    const hasRequestDigest = response.request_digest !== undefined;
    if (hasRequestId !== hasRequestDigest) {
      errors.push(error(
        "/request_digest",
        "error correlation must include both request id and request digest or neither",
        "requestIdentity",
      ));
    }
    if ((response.method === "prepare" || response.method === "execute" || response.method === "cancel" || response.method === "reconcile") && !hasRequestId) {
      errors.push(error(
        "/request_id",
        "prepare/execute/cancel/reconcile errors require exact Action request correlation",
        "requestIdentity",
      ));
    }
    if (response.method === "health" && hasRequestId) {
      errors.push(error(
        "/request_id",
        "health errors cannot claim Action request correlation",
        "requestIdentity",
      ));
    }
    if (response.method === "health" && !response.binding) {
      errors.push(error(
        "/binding",
        "health errors require the exact runtime package/context binding",
        "bindingMismatch",
      ));
    }
    if (response.method !== "health" && response.binding) {
      errors.push(error(
        "/binding",
        "prepare/execute/cancel/reconcile errors are bound by request digest and cannot replace it with a runtime binding",
        "bindingMismatch",
      ));
    }
    if (response.method === "health" && response.binding && options.expected) {
      errors.push(...actionBindingErrors(response.binding, options.expected.binding, "/binding"));
    }
    if (
      response.method !== "health"
      && options.expected?.request_id
      && response.request_id !== options.expected.request_id
    ) {
      errors.push(error("/request_id", "response belongs to a different request", "requestIdentity"));
    }
    if (
      response.method !== "health"
      && options.expected?.request_digest
      && response.request_digest !== options.expected.request_digest
    ) {
      errors.push(error("/request_digest", "response belongs to a different digest", "requestDigest"));
    }
    return errors.length ? { valid: false, errors } : validation;
  }

  if (response.method === "prepare") {
    if (options.expected?.request_id && response.request_id !== options.expected.request_id) {
      errors.push(error("/request_id", "prepare result belongs to a different request", "requestIdentity"));
    }
    if (options.expected?.request_digest && response.request_digest !== options.expected.request_digest) {
      errors.push(error("/request_digest", "prepare result belongs to a different digest", "requestDigest"));
    }
    if (options.expected) errors.push(...actionBindingErrors(response.binding, options.expected.binding, "/binding"));
    if (response.artifacts.length !== 0) {
      errors.push(error("/artifacts", "prepare is pure and cannot publish passive artifacts", "preparePurity"));
    }
    response.artifact_declarations.forEach((declaration, index, declarations) => {
      if (index > 0 && declaration.id <= declarations[index - 1]!.id) {
        errors.push(error("/artifact_declarations", "artifact declaration ids must be unique and canonical", "canonicalOrder"));
      }
    });
  } else if (response.method === "execute") {
    if (options.expected?.request_id && response.request_id !== options.expected.request_id) {
      errors.push(error("/request_id", "response belongs to a different request", "requestIdentity"));
    }
    if (
      options.expected?.request_digest
      && response.request_digest !== options.expected.request_digest
    ) {
      errors.push(error("/request_digest", "response belongs to a different digest", "requestDigest"));
    }
    if (options.expected) {
      errors.push(...actionBindingErrors(response.binding, options.expected.binding, "/binding"));
    }
    if (response.output.type === "domain_output") {
      const output = analyzeGenerativeUiJsonValue(response.output.output, {
        path: "/output/output",
        limits: {
          max_bytes: HOMERAIL_RUNTIME_DOMAIN_OUTPUT_MAX_BYTES,
          max_values: 20_000,
          max_depth: 32,
        },
      });
      if (!output.valid) {
        errors.push(output.error ?? error(
          "/output/output",
          `domain output exceeds ${HOMERAIL_RUNTIME_DOMAIN_OUTPUT_MAX_BYTES} bytes`,
          "maxPayloadBytes",
        ));
      }
    } else {
      const transactionAnalysis = analyzeGenerativeUiJsonValue(response.output.transaction, {
        path: "/output/transaction",
        limits: { max_bytes: GENERATIVE_UI_MAX_TRANSACTION_BYTES },
      });
      if (!transactionAnalysis.valid) {
        errors.push(transactionAnalysis.error ?? error(
          "/output/transaction",
          `UI transaction exceeds ${GENERATIVE_UI_MAX_TRANSACTION_BYTES} bytes`,
          "maxPayloadBytes",
        ));
      } else {
        const transaction = validateGenerativeUiTransaction(response.output.transaction);
        errors.push(...prefixedPluginErrors(transaction.errors, "/output/transaction"));
        if (transaction.value) {
          if (transaction.value.transaction_id !== response.request_id) {
            errors.push(error(
              "/output/transaction/transaction_id",
              "UI transaction id must equal the idempotent Action request id",
              "requestIdentity",
            ));
          }
          if (
            transaction.value.actor.type !== "plugin"
            || (options.expected?.tool !== undefined
              && transaction.value.actor.id !== options.expected.tool.qualified_id)
            || transaction.value.actor.plugin?.id !== response.binding.plugin_id
            || transaction.value.actor.plugin?.version !== response.binding.plugin_version
          ) {
            errors.push(error(
              "/output/transaction/actor",
              "UI transaction actor must be the exact bound Tool and plugin version",
              "bindingMismatch",
            ));
          }
          const expectedTarget = options.expected?.source?.type === "ui_action"
            ? {
              document_id: options.expected.source.target.document_id,
              base_revision: options.expected.source.target.document_revision,
            }
            : options.expected?.source?.type === "agent"
              ? options.expected.source.target
              : undefined;
          if (expectedTarget && (
            transaction.value.document_id !== expectedTarget.document_id
            || transaction.value.base_revision !== expectedTarget.base_revision
          )) {
            errors.push(error(
              "/output/transaction/base_revision",
              "UI transaction does not target the exact source document revision",
              "staleTarget",
            ));
          }
        }
      }
    }
  } else if (response.method === "cancel") {
    if (options.expected?.request_id && response.request_id !== options.expected.request_id) {
      errors.push(error("/request_id", "cancel result belongs to a different request", "requestIdentity"));
    }
    if (
      options.expected?.request_digest
      && response.request_digest !== options.expected.request_digest
    ) {
      errors.push(error("/request_digest", "cancel result belongs to a different digest", "requestDigest"));
    }
  } else if (response.method === "reconcile") {
    if (options.expected?.request_id && response.request_id !== options.expected.request_id) {
      errors.push(error("/request_id", "reconciliation belongs to a different request", "requestIdentity"));
    }
    if (options.expected?.request_digest && response.request_digest !== options.expected.request_digest) {
      errors.push(error("/request_digest", "reconciliation belongs to a different digest", "requestDigest"));
    }
    if (options.expected) errors.push(...actionBindingErrors(response.binding, options.expected.binding, "/binding"));
    const hasOutput = response.output !== undefined || response.output_digest !== undefined;
    if (response.status === "completed") {
      if (!response.output || !response.output_digest) {
        errors.push(error("/output", "completed reconciliation requires exact output and digest", "reconcileOutput"));
      }
      if (response.error) errors.push(error("/error", "completed reconciliation cannot include an error", "reconcileOutput"));
    } else if (hasOutput) {
      errors.push(error("/output", "non-completed reconciliation cannot claim output", "reconcileOutput"));
    }
    if (response.status === "failed" && !response.error) {
      errors.push(error("/error", "failed reconciliation requires an error", "reconcileError"));
    }
    if (response.status !== "failed" && response.error) {
      errors.push(error("/error", "only failed reconciliation may include an error", "reconcileError"));
    }
  } else {
    if (options.expected) {
      errors.push(...actionBindingErrors(response.binding, options.expected.binding, "/binding"));
    }
    const startedAt = timestampMillis(response.started_at);
    const completedAt = timestampMillis(response.completed_at);
    errors.push(...actionTimestampErrors(response.started_at, "/started_at"));
    if (startedAt !== null && completedAt !== null && startedAt > completedAt) {
      errors.push(error("/started_at", "runtime cannot start after health completion", "timestampOrder"));
    }
  }
  return errors.length ? { valid: false, errors } : validation;
}
