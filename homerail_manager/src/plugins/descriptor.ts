import { createHash } from "node:crypto";
import {
  HOMERAIL_PLUGIN_DESCRIPTOR_MAX_BYTES,
  HOMERAIL_PLUGIN_SCHEMA_MAX_BYTES,
  HOMERAIL_PLUGIN_SKILL_MAX_BYTES,
  analyzeHomerailPluginSchemaPolicy,
  decodeHomerailPluginUtf8,
  analyzeGenerativeUiJsonValue,
  collectHomerailPluginFileReferences,
  validateHomerailPluginManifest,
  validateHomerailResolvedPluginDescriptorWire,
  type HomerailResolvedPluginDescriptorV1,
} from "homerail-protocol";

const DIGEST_PATTERN = /^[a-f0-9]{64}$/;

export function pluginJsonDigest(value: unknown, maxBytes = HOMERAIL_PLUGIN_DESCRIPTOR_MAX_BYTES): string {
  const hash = createHash("sha256");
  const analysis = analyzeGenerativeUiJsonValue(value, {
    limits: { max_bytes: maxBytes, max_depth: 64, max_values: 500_000 },
    on_token: (chunk) => hash.update(chunk),
  });
  if (!analysis.valid) {
    throw new Error(analysis.error?.message || "invalid plugin JSON value");
  }
  return hash.digest("hex");
}

export function pluginTextDigest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function pluginDescriptorPackageDigest(
  descriptor: Omit<HomerailResolvedPluginDescriptorV1, "package_digest">,
): string {
  return pluginJsonDigest({
    descriptor_version: descriptor.descriptor_version,
    manifest_digest: descriptor.manifest_digest,
    referenced_files: [...descriptor.referenced_files]
      .map((entry) => ({ path: entry.path, digest: entry.digest }))
      .sort((left, right) => left.path.localeCompare(right.path)),
  });
}

export function validateResolvedPluginDescriptor(
  descriptor: HomerailResolvedPluginDescriptorV1,
): string[] {
  const errors: string[] = [];
  const wire = validateHomerailResolvedPluginDescriptorWire(descriptor);
  if (!wire.valid) {
    errors.push(`invalid descriptor wire contract: ${JSON.stringify(wire.errors)}`);
    return errors;
  }
  if (descriptor.descriptor_version !== 1) errors.push("descriptor_version must be 1");
  const manifestValidation = validateHomerailPluginManifest(descriptor.manifest);
  if (!manifestValidation.valid) {
    errors.push(`invalid manifest: ${JSON.stringify(manifestValidation.errors)}`);
    return errors;
  }
  if (!DIGEST_PATTERN.test(descriptor.manifest_digest)) errors.push("manifest_digest must be SHA-256 hex");
  if (!DIGEST_PATTERN.test(descriptor.package_digest)) errors.push("package_digest must be SHA-256 hex");
  try {
    if (pluginJsonDigest(descriptor.manifest, 512 * 1024) !== descriptor.manifest_digest) {
      errors.push("manifest_digest does not match manifest");
    }
  } catch (cause) {
    errors.push(cause instanceof Error ? cause.message : String(cause));
  }

  const expectedSchemas = new Map(descriptor.manifest.schemas.map((entry) => [entry.id, entry.file]));
  const seenSchemas = new Set<string>();
  for (const schema of descriptor.schemas) {
    const expectedFile = expectedSchemas.get(schema.id);
    if (!expectedFile || expectedFile !== schema.file || seenSchemas.has(schema.id)) {
      errors.push(`unexpected or duplicate resolved schema: ${schema.id}`);
      continue;
    }
    seenSchemas.add(schema.id);
    if (!schema.schema || typeof schema.schema !== "object" || Array.isArray(schema.schema)) {
      errors.push(`resolved schema must be an object: ${schema.id}`);
      continue;
    }
    if (schema.schema.type !== "object" || schema.schema.additionalProperties !== false) {
      errors.push(`resolved schema must be a closed object schema: ${schema.id}`);
    }
    for (const issue of analyzeHomerailPluginSchemaPolicy(schema.schema)) {
      errors.push(`resolved schema violates policy at ${schema.id}${issue.path}: ${issue.message}`);
    }
    try { pluginJsonDigest(schema.schema, HOMERAIL_PLUGIN_SCHEMA_MAX_BYTES); } catch (cause) {
      errors.push(`invalid resolved schema ${schema.id}: ${cause instanceof Error ? cause.message : String(cause)}`);
    }
  }
  if (seenSchemas.size !== expectedSchemas.size) errors.push("resolved schemas are incomplete");

  const expectedSkills = new Map(descriptor.manifest.skills.map((entry) => [entry.id, entry.path]));
  const seenSkills = new Set<string>();
  for (const skill of descriptor.skills) {
    const expectedPath = expectedSkills.get(skill.id);
    if (!expectedPath || expectedPath !== skill.path || seenSkills.has(skill.id)) {
      errors.push(`unexpected or duplicate resolved skill: ${skill.id}`);
      continue;
    }
    seenSkills.add(skill.id);
    if (Buffer.byteLength(skill.content, "utf8") > HOMERAIL_PLUGIN_SKILL_MAX_BYTES) {
      errors.push(`resolved skill exceeds ${HOMERAIL_PLUGIN_SKILL_MAX_BYTES} bytes: ${skill.id}`);
    }
    if (pluginTextDigest(skill.content) !== skill.digest) {
      errors.push(`resolved skill digest mismatch: ${skill.id}`);
    }
  }
  if (seenSkills.size !== expectedSkills.size) errors.push("resolved skills are incomplete");

  const expectedFiles = collectHomerailPluginFileReferences(descriptor.manifest);
  const actualFiles = [...descriptor.referenced_files].sort((left, right) => left.path.localeCompare(right.path));
  if (
    actualFiles.length !== expectedFiles.length
    || actualFiles.some((entry, index) => entry.path !== expectedFiles[index])
  ) {
    errors.push("referenced_files do not exactly cover the manifest");
  }
  const seenFiles = new Set<string>();
  const fileBytes = new Map<string, Buffer>();
  let totalFileBytes = 0;
  for (const entry of actualFiles) {
    if (seenFiles.has(entry.path)) errors.push(`duplicate referenced file: ${entry.path}`);
    seenFiles.add(entry.path);
    if (!DIGEST_PATTERN.test(entry.digest)) errors.push(`invalid referenced file digest: ${entry.path}`);
    if (entry.encoding !== "base64" || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(entry.content)) {
      errors.push(`invalid referenced file encoding: ${entry.path}`);
      continue;
    }
    const bytes = Buffer.from(entry.content, "base64");
    if (bytes.toString("base64") !== entry.content) {
      errors.push(`non-canonical referenced file encoding: ${entry.path}`);
      continue;
    }
    totalFileBytes += bytes.byteLength;
    if (totalFileBytes > HOMERAIL_PLUGIN_DESCRIPTOR_MAX_BYTES) errors.push("referenced files exceed descriptor byte budget");
    if (createHash("sha256").update(bytes).digest("hex") !== entry.digest) {
      errors.push(`referenced file digest mismatch: ${entry.path}`);
    }
    fileBytes.set(entry.path, bytes);
  }
  for (const schema of descriptor.schemas) {
    const file = actualFiles.find((entry) => entry.path === schema.file);
    if (file && file.digest !== schema.digest) errors.push(`schema/file digest mismatch: ${schema.id}`);
    const bytes = fileBytes.get(schema.file);
    if (bytes) {
      try {
        const parsed = JSON.parse(decodeHomerailPluginUtf8(bytes, schema.file)) as unknown;
        if (
          pluginJsonDigest(parsed, HOMERAIL_PLUGIN_SCHEMA_MAX_BYTES)
          !== pluginJsonDigest(schema.schema, HOMERAIL_PLUGIN_SCHEMA_MAX_BYTES)
        ) {
          errors.push(`resolved schema content mismatch: ${schema.id}`);
        }
      } catch (cause) {
        errors.push(`invalid archived schema ${schema.id}: ${cause instanceof Error ? cause.message : String(cause)}`);
      }
    }
  }
  for (const skill of descriptor.skills) {
    const file = actualFiles.find((entry) => entry.path === skill.path);
    if (file && file.digest !== skill.digest) errors.push(`skill/file digest mismatch: ${skill.id}`);
    const bytes = fileBytes.get(skill.path);
    if (bytes && decodeHomerailPluginUtf8(bytes, skill.path) !== skill.content) {
      errors.push(`resolved skill content mismatch: ${skill.id}`);
    }
  }

  try {
    const { package_digest: _packageDigest, ...unsigned } = descriptor;
    if (pluginDescriptorPackageDigest(unsigned) !== descriptor.package_digest) {
      errors.push("package_digest does not match descriptor file set");
    }
  } catch (cause) {
    errors.push(cause instanceof Error ? cause.message : String(cause));
  }
  return errors;
}
