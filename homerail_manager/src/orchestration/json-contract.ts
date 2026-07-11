import AjvModule, { type ErrorObject, type ValidateFunction } from "ajv";

const AjvConstructor = AjvModule as unknown as new (
  options?: Record<string, unknown>,
) => {
  compile(schema: object): ValidateFunction;
  validateSchema(schema: object): boolean;
  errors?: ErrorObject[] | null;
};

const ajv = new AjvConstructor({ allErrors: true, strict: true });
const validators = new WeakMap<object, ValidateFunction>();

function errorDetails(errors: ErrorObject[] | null | undefined): string {
  return (errors ?? [])
    .slice(0, 5)
    .map((error) => `${error.instancePath || error.schemaPath || "/"}: ${error.message ?? error.keyword}`)
    .join("; ");
}

export function validateJsonContractSchema(schema: unknown): { valid: boolean; details: string } {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    return { valid: false, details: "contract schema must be an object" };
  }
  if (validators.has(schema)) return { valid: true, details: "" };
  try {
    const valid = ajv.validateSchema(schema);
    if (!valid) return { valid: false, details: errorDetails(ajv.errors) };
    const validate = ajv.compile(schema);
    validators.set(schema, validate);
    return { valid: true, details: "" };
  } catch (error) {
    return { valid: false, details: error instanceof Error ? error.message : String(error) };
  }
}

export function validateJsonContract(schema: unknown, value: unknown): { valid: boolean; details: string } {
  const schemaResult = validateJsonContractSchema(schema);
  if (!schemaResult.valid || !schema || typeof schema !== "object" || Array.isArray(schema)) return schemaResult;
  const validate = validators.get(schema)!;
  const valid = validate(value);
  return { valid, details: errorDetails(validate.errors) };
}
