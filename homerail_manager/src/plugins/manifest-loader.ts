import AjvModule from "ajv";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  validatePluginCustomRendererSource,
  validatePluginSkill,
} from "homerail-plugin-sdk";
import {
  GENERATIVE_UI_IR_VERSION,
  HOMERAIL_PLUGIN_SCHEMA_MAX_BYTES,
  HOMERAIL_PLUGIN_SKILL_MAX_BYTES,
  HOMERAIL_PLUGIN_API_VERSION,
  HOMERAIL_RENDERER_API_VERSION,
  HomerailPluginRuntimeTrust,
  analyzeHomerailPluginSchemaPolicy,
  decodeHomerailPluginUtf8,
  collectHomerailPluginFileReferences,
  validateHomerailDeclarativeRenderer,
  validateHomerailPluginCompatibility,
  validateHomerailDirectUiProjection,
  validateHomerailPluginManifest,
  type HomerailPluginManifestV1,
  type HomerailResolvedPluginDescriptorV1,
} from "homerail-protocol";
import { repoRoot } from "../assets/root.js";
import {
  pluginDescriptorPackageDigest,
  pluginJsonDigest,
  pluginTextDigest,
  validateResolvedPluginDescriptor,
} from "./descriptor.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const AjvClass = (AjvModule as any).default || AjvModule;
const HOMERAIL_VERSION = "0.1.0";
const MAX_MANIFEST_BYTES = 512 * 1024;
const MAX_REFERENCED_FILE_BYTES = 512 * 1024;
const MAX_PACKAGE_BYTES = 4 * 1024 * 1024;

export interface LoadPluginPackageOptions {
  source: "builtin" | "installed" | "development";
  /** Package lifecycle only: resolve executable bytes that remain staged until explicit M6 Runtime preflight. */
  allow_staged_runtime?: boolean;
  trusted_builtin_ids?: ReadonlySet<string>;
  builtin_renderer_ids?: ReadonlySet<string>;
  legacy_bridge_plugin_ids?: ReadonlySet<string>;
}

function readBoundedFile(file: string, maxBytes: number): Buffer {
  const stat = fs.lstatSync(file);
  if (stat.isSymbolicLink()) throw new Error(`Plugin packages cannot reference symlinks: ${file}`);
  if (!stat.isFile()) throw new Error(`Plugin package reference is not a file: ${file}`);
  if (stat.size > maxBytes) throw new Error(`Plugin package file exceeds ${maxBytes} bytes: ${file}`);
  return fs.readFileSync(file);
}

function resolvePackageFile(packageRoot: string, relativePath: string): string {
  const root = fs.realpathSync(packageRoot);
  const candidate = path.resolve(root, ...relativePath.split("/"));
  const relative = path.relative(root, candidate);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Plugin file escapes or aliases the package root: ${relativePath}`);
  }
  if (fs.lstatSync(candidate).isSymbolicLink()) {
    throw new Error(`Plugin packages cannot reference symlinks: ${relativePath}`);
  }
  const resolved = fs.realpathSync(candidate);
  const resolvedRelative = path.relative(root, resolved);
  if (resolvedRelative.startsWith("..") || path.isAbsolute(resolvedRelative)) {
    throw new Error(`Plugin file resolves outside the package root: ${relativePath}`);
  }
  return resolved;
}

function parseJsonObject(buffer: Buffer, label: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(decodeHomerailPluginUtf8(buffer, label));
  } catch (cause) {
    throw new Error(`${label} is not valid JSON: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must contain a JSON object`);
  }
  return value as Record<string, unknown>;
}

function validateCompiledSchema(schemaId: string, schema: Record<string, unknown>): void {
  if (schema.type !== "object" || schema.additionalProperties !== false) {
    throw new Error(`Plugin schema ${schemaId} must be a closed object schema`);
  }
  const policyIssues = analyzeHomerailPluginSchemaPolicy(schema);
  if (policyIssues.length) throw new Error(`Plugin schema ${schemaId} violates schema policy: ${JSON.stringify(policyIssues)}`);
  const ajv = new AjvClass({ allErrors: true, strict: true, coerceTypes: false });
  try {
    ajv.compile(schema);
  } catch (cause) {
    throw new Error(`Plugin schema ${schemaId} does not compile: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
}

function schemaAtPointer(schema: Record<string, unknown>, pointer: string): Record<string, unknown> | undefined {
  if (pointer === "") return schema;
  let current: unknown = schema;
  for (const encoded of pointer.slice(1).split("/")) {
    const segment = encoded.replace(/~1/g, "/").replace(/~0/g, "~");
    if (!current || typeof current !== "object" || Array.isArray(current)) return undefined;
    const properties = (current as Record<string, unknown>).properties;
    if (!properties || typeof properties !== "object" || Array.isArray(properties)) return undefined;
    current = (properties as Record<string, unknown>)[segment];
  }
  return current && typeof current === "object" && !Array.isArray(current)
    ? current as Record<string, unknown>
    : undefined;
}

function enforceM3TrustPolicy(
  manifest: HomerailPluginManifestV1,
  options: LoadPluginPackageOptions,
): void {
  if (
    manifest.runtime.trust === HomerailPluginRuntimeTrust.SANDBOXED_RUNTIME
    && (options.source !== "installed" || options.allow_staged_runtime !== true)
  ) {
    throw new Error(`Executable plugin runtimes may only be retained as staged installed packages before M6: ${manifest.id}`);
  }
  if (
    manifest.runtime.trust === HomerailPluginRuntimeTrust.TRUSTED_BUILTIN
    && (options.source !== "builtin" || !options.trusted_builtin_ids?.has(manifest.id))
  ) {
    throw new Error(`Plugin is not authorized for trusted_builtin: ${manifest.id}`);
  }
  for (const renderer of manifest.renderers) {
    if (
      renderer.source.type === "builtin"
      && (
        options.source !== "builtin"
        || !options.builtin_renderer_ids?.has(renderer.source.id)
      )
    ) {
      throw new Error(`Unknown precompiled renderer id: ${renderer.source.id}`);
    }
    if (renderer.fallback.type === "core_projection" && manifest.id !== "com.homerail.core") {
      throw new Error(`Only Core may declare a Core projection fallback: ${renderer.id}`);
    }
  }
}

export function loadPluginPackage(
  packageRoot: string,
  options: LoadPluginPackageOptions,
): HomerailResolvedPluginDescriptorV1 {
  const rootStat = fs.lstatSync(packageRoot);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error(`Plugin package root must be a real directory: ${packageRoot}`);
  }
  const manifestFile = path.join(packageRoot, "homerail.plugin.json");
  const manifestBuffer = readBoundedFile(manifestFile, MAX_MANIFEST_BYTES);
  const parsedManifest = parseJsonObject(manifestBuffer, "homerail.plugin.json");
  const validation = validateHomerailPluginManifest(parsedManifest);
  if (!validation.valid || !validation.value) {
    throw new Error(`Invalid HomeRail plugin manifest: ${JSON.stringify(validation.errors)}`);
  }
  const manifest = validation.value;
  const compatibilityErrors = validateHomerailPluginCompatibility(manifest, {
    homerail: HOMERAIL_VERSION,
    plugin_api: HOMERAIL_PLUGIN_API_VERSION,
    ui_ir: GENERATIVE_UI_IR_VERSION,
    renderer_api: HOMERAIL_RENDERER_API_VERSION,
  });
  if (compatibilityErrors.length) {
    throw new Error(`Incompatible HomeRail plugin: ${JSON.stringify(compatibilityErrors)}`);
  }
  enforceM3TrustPolicy(manifest, options);

  const referencedPaths = collectHomerailPluginFileReferences(manifest);
  let packageBytes = manifestBuffer.byteLength;
  const buffers = new Map<string, Buffer>();
  for (const relativePath of referencedPaths) {
    const file = resolvePackageFile(packageRoot, relativePath);
    const buffer = readBoundedFile(file, MAX_REFERENCED_FILE_BYTES);
    packageBytes += buffer.byteLength;
    if (packageBytes > MAX_PACKAGE_BYTES) {
      throw new Error(`Plugin package exceeds ${MAX_PACKAGE_BYTES} referenced bytes: ${manifest.id}`);
    }
    buffers.set(relativePath, buffer);
  }

  const schemas = manifest.schemas.map((declaration) => {
    const buffer = buffers.get(declaration.file)!;
    if (buffer.byteLength > HOMERAIL_PLUGIN_SCHEMA_MAX_BYTES) {
      throw new Error(`Plugin schema ${declaration.id} exceeds ${HOMERAIL_PLUGIN_SCHEMA_MAX_BYTES} bytes`);
    }
    const schema = parseJsonObject(buffer, declaration.file);
    validateCompiledSchema(declaration.id, schema);
    return {
      id: declaration.id,
      file: declaration.file,
      digest: createHash("sha256").update(buffers.get(declaration.file)!).digest("hex"),
      schema,
    };
  });
  for (const renderer of manifest.renderers) {
    if (renderer.source.type === "declarative") {
      const document = parseJsonObject(buffers.get(renderer.source.file)!, renderer.source.file);
      const rendererValidation = validateHomerailDeclarativeRenderer(document);
      if (!rendererValidation.valid) {
        throw new Error(`Invalid declarative Renderer ${renderer.id}: ${JSON.stringify(rendererValidation.errors)}`);
      }
    } else if (renderer.source.type === "custom") {
      validatePluginCustomRendererSource(
        buffers.get(renderer.source.file)!,
        `Custom Renderer ${renderer.id} (${renderer.source.file})`,
      );
    }
  }
  for (const tool of manifest.tools) {
    if (tool.handler.type !== "projection") continue;
    const projection = parseJsonObject(buffers.get(tool.handler.file)!, tool.handler.file);
    const projectionValidation = validateHomerailDirectUiProjection(projection);
    if (!projectionValidation.valid || !projectionValidation.value) {
      throw new Error(`Invalid declarative Tool projection ${tool.id}: ${JSON.stringify(projectionValidation.errors)}`);
    }
    if (
      projectionValidation.value.legacy_bridge
      && (
        options.source !== "builtin"
        || !options.legacy_bridge_plugin_ids?.has(manifest.id)
      )
    ) {
      throw new Error(`Legacy UI bridges are restricted to approved builtin migrations: ${manifest.id}:${tool.id}`);
    }
    const target = manifest.kinds.find((kind) => (
      kind.kind === projectionValidation.value!.kind
      && kind.versions.some((version) => version.version === projectionValidation.value!.kind_version)
    ));
    if (!target) throw new Error(`Tool projection ${tool.id} targets an undeclared kind version`);
    const targetVersion = target.versions.find((version) => version.version === projectionValidation.value!.kind_version)!;
    if (!targetVersion.allowed_surfaces.includes(projectionValidation.value.defaults.surface)) {
      throw new Error(`Tool projection ${tool.id} defaults to a surface not allowed by its target Kind`);
    }
    if (tool.output_schema !== targetVersion.content_schema) {
      throw new Error(`Tool projection ${tool.id} output_schema must match its target kind content schema`);
    }
    const inputSchema = schemas.find((schema) => schema.id === tool.input_schema)?.schema;
    if (!inputSchema) throw new Error(`Tool projection ${tool.id} input_schema is unavailable`);
    if (projectionValidation.value.a2ui_pointer) {
      const projectedA2ui = schemaAtPointer(inputSchema, projectionValidation.value.a2ui_pointer);
      if (!projectedA2ui || projectedA2ui.type !== "object") {
        throw new Error(`Tool projection ${tool.id} a2ui_pointer must resolve to an object in input_schema`);
      }
    }
    for (const [label, pointerValue] of [
      ["surface_pointer", projectionValidation.value.surface_pointer],
      ["importance_pointer", projectionValidation.value.importance_pointer],
      ["density_pointer", projectionValidation.value.density_pointer],
      ["canvas_size_pointer", projectionValidation.value.canvas_size_pointer],
      ["motion_profile_pointer", projectionValidation.value.motion_profile_pointer],
      ["persistence_pointer", projectionValidation.value.persistence_pointer],
    ] as const) {
      if (!pointerValue) continue;
      const projectedValue = schemaAtPointer(inputSchema, pointerValue);
      if (!projectedValue || projectedValue.type !== "string") {
        throw new Error(`Tool projection ${tool.id} ${label} must resolve to a string in input_schema`);
      }
    }
    for (const projectedAction of projectionValidation.value.actions ?? []) {
      const action = manifest.actions.find((entry) => entry.id === projectedAction.id);
      if (!action || !targetVersion.actions.includes(action.id)) {
        throw new Error(`Tool projection ${tool.id} materializes an Action not allowed by its target Kind: ${projectedAction.id}`);
      }
      const delegatedTool = manifest.tools.find((entry) => entry.id === action.tool);
      if (!delegatedTool?.exposure.includes("action")) {
        throw new Error(`Projected Action ${action.id} does not delegate to an Action-exposed Tool`);
      }
      if (projectedAction.arguments_pointer) {
        const argumentSchema = inputSchema
          ? schemaAtPointer(inputSchema, projectedAction.arguments_pointer)
          : undefined;
        if (!argumentSchema || argumentSchema.type !== "object") {
          throw new Error(`Projected Action ${action.id} arguments_pointer must resolve to an object in Tool input_schema`);
        }
      }
    }
    const outputSchema = schemas.find((schema) => schema.id === tool.output_schema)?.schema;
    const outputProperties = outputSchema?.properties;
    if (
      projectionValidation.value.legacy_bridge
      && outputProperties
      && typeof outputProperties === "object"
      && !Array.isArray(outputProperties)
      && Object.prototype.hasOwnProperty.call(outputProperties, "visual")
    ) {
      throw new Error(`Legacy UI bridge Tool ${tool.id} cannot reserve the content field visual`);
    }
  }
  for (const action of manifest.actions) {
    const delegatedTool = manifest.tools.find((tool) => tool.id === action.tool);
    if (!delegatedTool) throw new Error(`Action ${action.id} delegates to a missing Tool`);
    if (!manifest.capabilities.some((capability) => capability.actions.includes(action.id))) {
      throw new Error(`Action ${action.id} is not reachable from a capability`);
    }
    const exposedBy = manifest.kinds.flatMap((kind) => kind.versions
      .filter((version) => version.actions.includes(action.id))
      .map((version) => ({ kind, version })));
    if (!exposedBy.length) throw new Error(`Action is not exposed by a Kind version: ${action.id}`);
    if (delegatedTool.handler.type === "projection") {
      const projection = validateHomerailDirectUiProjection(
        parseJsonObject(buffers.get(delegatedTool.handler.file)!, delegatedTool.handler.file),
      );
      if (!projection.valid || !projection.value) throw new Error(`Action Tool projection is invalid: ${action.id}`);
      if (projection.value.legacy_bridge) {
        throw new Error(`Action Tool projections cannot emit legacy UI bridges: ${manifest.id}:${action.id}`);
      }
      for (const { kind, version } of exposedBy) {
        if (kind.kind !== projection.value.kind || version.version !== projection.value.kind_version) {
          throw new Error(`Action Tool ${delegatedTool.id} must preserve every exposing Kind version for ${action.id}`);
        }
      }
    }
  }
  const skills = manifest.skills.map((declaration) => {
    const buffer = buffers.get(declaration.path)!;
    if (buffer.byteLength > HOMERAIL_PLUGIN_SKILL_MAX_BYTES) {
      throw new Error(`Plugin Skill ${declaration.id} exceeds ${HOMERAIL_PLUGIN_SKILL_MAX_BYTES} bytes`);
    }
    const content = decodeHomerailPluginUtf8(buffer, declaration.path);
    validatePluginSkill(declaration.id, content);
    return {
      id: declaration.id,
      path: declaration.path,
      digest: pluginTextDigest(content),
      content,
    };
  });
  const schemaDigests = new Map(schemas.map((schema) => [schema.file, schema.digest]));
  const skillDigests = new Map(skills.map((skill) => [skill.path, skill.digest]));
  const referencedFiles = referencedPaths.map((relativePath) => ({
    path: relativePath,
    digest: schemaDigests.get(relativePath)
      ?? skillDigests.get(relativePath)
      ?? createHash("sha256").update(buffers.get(relativePath)!).digest("hex"),
    encoding: "base64" as const,
    content: buffers.get(relativePath)!.toString("base64"),
  }));
  const unsigned: Omit<HomerailResolvedPluginDescriptorV1, "package_digest"> = {
    descriptor_version: 1,
    manifest,
    manifest_digest: pluginJsonDigest(manifest, MAX_MANIFEST_BYTES),
    schemas,
    skills,
    referenced_files: referencedFiles,
  };
  const descriptor: HomerailResolvedPluginDescriptorV1 = {
    ...unsigned,
    package_digest: pluginDescriptorPackageDigest(unsigned),
  };
  const descriptorErrors = validateResolvedPluginDescriptor(descriptor);
  if (descriptorErrors.length) {
    throw new Error(`Invalid resolved plugin descriptor: ${JSON.stringify(descriptorErrors)}`);
  }
  return structuredClone(descriptor);
}

export function getBuiltinPluginRoot(): string {
  return path.join(repoRoot(), "plugins", "builtin");
}

export function listBuiltinPluginPackageRoots(root = getBuiltinPluginRoot()): string[] {
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && fs.existsSync(path.join(root, entry.name, "homerail.plugin.json")))
    .map((entry) => path.join(root, entry.name))
    .sort((left, right) => left.localeCompare(right));
}
