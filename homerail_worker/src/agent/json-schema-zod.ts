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

function encodedJsonObjectSchema(): ZodSchema {
  return z.string().transform((value, context) => {
    const parsed = parseJsonObjectString(value);
    if (parsed === value) {
      context.addIssue({ code: "custom", message: "Expected a JSON-encoded object" });
      return z.NEVER;
    }
    return parsed;
  }) as unknown as ZodSchema;
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
      out = z.union([
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
