import AjvModule from "ajv";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { validatePluginSkill } from "homerail-plugin-sdk";
import {
  GENERATIVE_UI_IR_VERSION,
  HOMERAIL_PLUGIN_SCHEMA_MAX_BYTES,
  HOMERAIL_PLUGIN_SKILL_MAX_BYTES,
  HOMERAIL_PLUGIN_API_VERSION,
  HOMERAIL_RENDERER_API_VERSION,
  HomerailPluginRendererMode,
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

function enforceM3TrustPolicy(
  manifest: HomerailPluginManifestV1,
  options: LoadPluginPackageOptions,
): void {
  if (manifest.runtime.trust === HomerailPluginRuntimeTrust.SANDBOXED_RUNTIME) {
    throw new Error(`Executable plugin runtimes are not enabled in M3: ${manifest.id}`);
  }
  if (
    manifest.runtime.trust === HomerailPluginRuntimeTrust.TRUSTED_BUILTIN
    && (options.source !== "builtin" || !options.trusted_builtin_ids?.has(manifest.id))
  ) {
    throw new Error(`Plugin is not authorized for trusted_builtin: ${manifest.id}`);
  }
  for (const renderer of manifest.renderers) {
    if (renderer.mode === HomerailPluginRendererMode.CUSTOM) {
      throw new Error(`Custom renderers are not enabled in M3: ${renderer.id}`);
    }
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
    if (renderer.source.type !== "declarative") continue;
    const document = parseJsonObject(buffers.get(renderer.source.file)!, renderer.source.file);
    const rendererValidation = validateHomerailDeclarativeRenderer(document);
    if (!rendererValidation.valid) {
      throw new Error(`Invalid declarative Renderer ${renderer.id}: ${JSON.stringify(rendererValidation.errors)}`);
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
