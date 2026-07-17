import { z } from "zod";

type JsonSchema = Record<string, unknown>;
type ZodSchema = { optional: () => ZodSchema; describe: (description: string) => ZodSchema };
type ZodShape = Record<string, ZodSchema>;

function asRecord(value: unknown): JsonSchema {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as JsonSchema
    : {};
}

function withDescription(schema: ZodSchema, json: JsonSchema): ZodSchema {
  return typeof json.description === "string" && json.description
    ? schema.describe(json.description)
    : schema;
}

function literalUnion(values: unknown[]): ZodSchema {
  if (values.length === 0) return z.never();
  const literals = values.map((value) => z.literal(value as never));
  if (literals.length === 1) return literals[0];
  return z.union(literals as unknown as [never, never, ...never[]]);
}

function schemaType(json: JsonSchema): string {
  const type = json.type;
  return Array.isArray(type) ? String(type.find((item) => item !== "null") ?? "") : String(type ?? "");
}

function localSchemaRef(root: JsonSchema, ref: string): JsonSchema | undefined {
  if (!ref.startsWith("#/")) return undefined;
  let current: unknown = root;
  for (const rawPart of ref.slice(2).split("/")) {
    if (!current || typeof current !== "object" || Array.isArray(current)) return undefined;
    const part = rawPart.replace(/~1/g, "/").replace(/~0/g, "~");
    current = (current as JsonSchema)[part];
  }
  return current && typeof current === "object" && !Array.isArray(current)
    ? current as JsonSchema
    : undefined;
}

function parseJsonObjectString(value: unknown): unknown {
  if (typeof value !== "string") return value;
  if (value.length > 1024 * 1024) return value;
  let encoded = value.trim();
  for (let depth = 0; depth < 2; depth += 1) {
    try {
      const parsed = JSON.parse(encoded);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
      if (typeof parsed !== "string") return value;
      encoded = parsed.trim();
    } catch {
      return value;
    }
  }
  return value;
}

function unpackPackedObjectProperty(
  propertyName: string,
  value: string,
  properties: JsonSchema,
): Record<string, unknown> | undefined {
  if (value.length > 1024 * 1024) return undefined;
  const encoded = value.trim();
  if (!encoded.startsWith("{")) return undefined;
  const prefix = `{${JSON.stringify(propertyName)}:`;
  for (const candidate of [`${prefix}${encoded}`, `${prefix}${encoded}}`]) {
    try {
      const parsed = JSON.parse(candidate);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
      const record = parsed as Record<string, unknown>;
      const packedValue = record[propertyName];
      if (!packedValue || typeof packedValue !== "object" || Array.isArray(packedValue)) continue;
      if (Object.keys(record).some((key) => !Object.prototype.hasOwnProperty.call(properties, key))) continue;
      return record;
    } catch {
      // Try the alternate root-brace form.
    }
  }
  return undefined;
}

function unpackNestedRootProperties(
  propertyName: string,
  value: Record<string, unknown>,
  properties: JsonSchema,
  required: ReadonlySet<string>,
  rootValue: Record<string, unknown>,
): { propertyValue: Record<string, unknown>; siblings: Record<string, unknown> } | undefined {
  const missingRequired = [...required]
    .filter((key) => key !== propertyName && rootValue[key] === undefined);
  if (missingRequired.length === 0
    || missingRequired.some((key) => value[key] === undefined || !Object.prototype.hasOwnProperty.call(properties, key))) {
    return undefined;
  }

  const propertyValue = { ...value };
  const siblings: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (key === propertyName
      || rootValue[key] !== undefined
      || !Object.prototype.hasOwnProperty.call(properties, key)) continue;
    siblings[key] = entry;
    delete propertyValue[key];
  }
  return Object.keys(siblings).length > 0 ? { propertyValue, siblings } : undefined;
}

/**
 * Claude-compatible providers sometimes preserve JSON-encoded nested objects
 * after MCP validation. Decode only fields that the original JSON Schema says
 * are objects, then let the tool handler apply its authoritative validation.
 */
export function normalizeJsonObjectStringsBySchema(
  value: unknown,
  schema: Record<string, unknown>,
  rootSchema: Record<string, unknown> = schema,
  depth = 0,
): unknown {
  if (depth > 32) return value;
  let json = asRecord(schema);
  if (typeof json.$ref === "string") {
    const resolved = localSchemaRef(rootSchema, json.$ref);
    if (resolved) json = resolved;
  }

  if (schemaType(json) === "object") {
    const decoded = parseJsonObjectString(value);
    if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) return value;
    const properties = asRecord(json.properties);
    const additional = asRecord(json.additionalProperties);
    const required = new Set(Array.isArray(json.required) ? json.required.map(String) : []);
    const normalized: Record<string, unknown> = { ...decoded as Record<string, unknown> };
    if (depth === 0) {
      for (const [key, entry] of Object.entries(normalized)) {
        const propertySchema = asRecord(properties[key]);
        if (schemaType(propertySchema) !== "object" || typeof entry !== "string") continue;
        const decodedEntry = parseJsonObjectString(entry);
        if (decodedEntry !== entry) {
          normalized[key] = decodedEntry;
          continue;
        }
        const packed = unpackPackedObjectProperty(key, entry, properties);
        if (!packed) continue;
        normalized[key] = packed[key];
        for (const [packedKey, packedEntry] of Object.entries(packed)) {
          if (packedKey !== key && normalized[packedKey] === undefined) normalized[packedKey] = packedEntry;
        }
      }
      for (const [key, entry] of Object.entries(normalized)) {
        const propertySchema = asRecord(properties[key]);
        if (schemaType(propertySchema) !== "object"
          || !entry
          || typeof entry !== "object"
          || Array.isArray(entry)) continue;
        const unpacked = unpackNestedRootProperties(
          key,
          entry as Record<string, unknown>,
          properties,
          required,
          normalized,
        );
        if (!unpacked) continue;
        normalized[key] = unpacked.propertyValue;
        Object.assign(normalized, unpacked.siblings);
      }
    }
    for (const [key, entry] of Object.entries(normalized)) {
      const propertySchema = asRecord(properties[key]);
      if (Object.keys(propertySchema).length > 0) {
        normalized[key] = normalizeJsonObjectStringsBySchema(
          entry,
          propertySchema,
          rootSchema,
          depth + 1,
        );
      } else if (Object.keys(additional).length > 0) {
        normalized[key] = normalizeJsonObjectStringsBySchema(
          entry,
          additional,
          rootSchema,
          depth + 1,
        );
      }
    }
    return normalized;
  }

  if (schemaType(json) === "array" && Array.isArray(value)) {
    const itemSchema = asRecord(json.items);
    return value.map((entry) => normalizeJsonObjectStringsBySchema(
      entry,
      itemSchema,
      rootSchema,
      depth + 1,
    ));
  }

  return value;
}

function encodedJsonObjectSchema(): ZodSchema {
  // Keep malformed strings alive until the schema-aware compatibility pass.
  // Some Anthropic-compatible providers pack sibling arguments into one
  // object-valued field, so rejecting here would bypass the DAG handler and
  // its authoritative validation entirely.
  return z.string().transform((value) => parseJsonObjectString(value)) as unknown as ZodSchema;
}

function convertSchema(json: JsonSchema, root: JsonSchema): ZodSchema {
  if (typeof json.$ref === "string") {
    const resolved = localSchemaRef(root, json.$ref);
    if (resolved) return convertSchema(resolved, root);
  }

  if (Array.isArray(json.enum)) {
    return withDescription(literalUnion(json.enum), json);
  }

  const variants = Array.isArray(json.anyOf) ? json.anyOf : Array.isArray(json.oneOf) ? json.oneOf : undefined;
  if (variants && variants.length > 0) {
    const converted = variants.map((item) => convertSchema(asRecord(item), root));
    const union = converted.length === 1
      ? converted[0]
      : z.union(converted as unknown as [never, never, ...never[]]);
    return withDescription(union, json);
  }

  let out: ZodSchema;
  switch (schemaType(json)) {
    case "string":
      out = z.string();
      break;
    case "integer":
      out = z.number().int();
      break;
    case "number":
      out = z.number();
      break;
    case "boolean":
      out = z.boolean();
      break;
    case "array":
      out = z.array(convertSchema(asRecord(json.items), root) as never);
      break;
    case "object": {
      const properties = asRecord(json.properties);
      const required = Array.isArray(json.required) ? json.required.map(String) : [];
      const shape: ZodShape = {};
      for (const [name, propSchema] of Object.entries(properties)) {
        const prop = convertSchema(asRecord(propSchema), root);
        shape[name] = required.includes(name) ? prop : prop.optional();
      }
      const objectSchema = Object.keys(shape).length > 0
        ? z.object(shape).passthrough()
        : z.record(z.string(), z.unknown());
      // Some Anthropic-compatible models serialize nested Tool objects as JSON
      // strings. Keep that compatibility explicit in the SDK-facing schema so
      // MCP validation can reach the decoder; Manager validates the decoded
      // object again against the original strict JSON Schema.
      out = json["x-homerail-sdk-object-only"] === true
        ? objectSchema
        : z.union([
            objectSchema,
            encodedJsonObjectSchema() as never,
          ] as unknown as [never, never]) as unknown as ZodSchema;
      break;
    }
    default:
      out = z.unknown();
      break;
  }

  return withDescription(out, json);
}

export function jsonSchemaObjectToZodRawShape(schema: Record<string, unknown>): Record<string, unknown> {
  const root = asRecord(schema);
  const properties = asRecord(root.properties);
  const required = Array.isArray(root.required) ? root.required.map(String) : [];
  const shape: ZodShape = {};
  for (const [name, propSchema] of Object.entries(properties)) {
    const prop = convertSchema(asRecord(propSchema), root);
    shape[name] = required.includes(name) ? prop : prop.optional();
  }
  return shape as Record<string, unknown>;
}
