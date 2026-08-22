// Minimal JSON Schema validator for Codewarper tools.
//
// Supported validation subset:
//   type: "object" | "array" | "string" | "number" | "integer" | "boolean"
//   object: properties, required, additionalProperties: boolean
//   array: items
//   string: enum
//
// Unsupported validation keywords are rejected at compile time instead of being
// ignored. That keeps a misspelled or too-rich schema from silently turning
// validation into a no-op.

export interface SchemaValidationErrorItem {
  path: string;
  message: string;
}

export class SchemaValidationError extends Error {
  readonly errors: readonly SchemaValidationErrorItem[];

  constructor(errors: readonly SchemaValidationErrorItem[]) {
    super(errors.map((e) => `${e.path}: ${e.message}`).join("; "));
    this.name = "SchemaValidationError";
    this.errors = errors;
  }
}

export class SchemaCompileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SchemaCompileError";
  }
}

export type ValidateFunction = (input: unknown) => void;

export type Schema =
  | { type: "object"; properties?: Record<string, Schema>; required?: readonly string[]; additionalProperties?: boolean }
  | { type: "array"; items?: Schema }
  | { type: "string"; enum?: readonly string[] }
  | { type: "number" | "integer" | "boolean" };

const ANNOTATION_KEYWORDS = new Set([
  "$schema",
  "$id",
  "description",
  "title",
  "default",
  "examples",
  "readOnly",
  "writeOnly",
  "deprecated",
]);

const COMMON_SCHEMA_KEYWORDS = new Set(["type", ...ANNOTATION_KEYWORDS]);
const OBJECT_SCHEMA_KEYWORDS = new Set(["properties", "required", "additionalProperties", ...COMMON_SCHEMA_KEYWORDS]);
const ARRAY_SCHEMA_KEYWORDS = new Set(["items", ...COMMON_SCHEMA_KEYWORDS]);
const STRING_SCHEMA_KEYWORDS = new Set(["enum", ...COMMON_SCHEMA_KEYWORDS]);
const SCALAR_SCHEMA_KEYWORDS = COMMON_SCHEMA_KEYWORDS;

export function compile(schema: unknown): ValidateFunction {
  const parsed = parseSchema(schema, "$", new Set());
  return (input: unknown): void => {
    const errors: SchemaValidationErrorItem[] = [];
    validate(parsed, input, errors, "$");
    if (errors.length > 0) throw new SchemaValidationError(errors);
  };
}

export function formatErrors(errors: readonly SchemaValidationErrorItem[]): string {
  return errors.map((e) => `${e.path}: ${e.message}`).join("; ");
}

function parseSchema(rawSchema: unknown, path: string, seenSchemas: Set<unknown>): Schema {
  if (!isObjectRecord(rawSchema)) {
    throw new SchemaCompileError(`${path}: schema must be an object`);
  }
  if (seenSchemas.has(rawSchema)) {
    throw new SchemaCompileError(`${path}: recursive schemas are not supported`);
  }
  seenSchemas.add(rawSchema);

  try {
    const schema = rawSchema as Record<string, unknown>;
    const rawType = schema.type;
    if (typeof rawType !== "string") {
      throw new SchemaCompileError(`${path}.type: expected a supported string type`);
    }

    switch (rawType) {
      case "object":
        rejectUnsupportedKeywords(schema, OBJECT_SCHEMA_KEYWORDS, path);
        return parseObjectSchema(schema, path, seenSchemas);
      case "array":
        rejectUnsupportedKeywords(schema, ARRAY_SCHEMA_KEYWORDS, path);
        return parseArraySchema(schema, path, seenSchemas);
      case "string":
        rejectUnsupportedKeywords(schema, STRING_SCHEMA_KEYWORDS, path);
        return parseStringSchema(schema, path);
      case "number":
      case "integer":
      case "boolean":
        rejectUnsupportedKeywords(schema, SCALAR_SCHEMA_KEYWORDS, path);
        return { type: rawType };
      default:
        throw new SchemaCompileError(`${path}.type: unsupported JSON Schema type ${JSON.stringify(rawType)}`);
    }
  } finally {
    seenSchemas.delete(rawSchema);
  }
}

function parseObjectSchema(schema: Record<string, unknown>, path: string, seenSchemas: Set<unknown>): Schema {
  const rawProperties = schema.properties;
  let properties: Record<string, Schema> | undefined;
  if (typeof rawProperties !== "undefined") {
    if (!isObjectRecord(rawProperties)) {
      throw new SchemaCompileError(`${path}.properties: expected an object`);
    }
    properties = {};
    for (const [key, value] of Object.entries(rawProperties)) {
      properties[key] = parseSchema(value, `${path}.properties.${key}`, seenSchemas);
    }
  }

  const rawRequired = schema.required;
  let required: readonly string[] | undefined;
  if (typeof rawRequired !== "undefined") {
    if (!Array.isArray(rawRequired) || !rawRequired.every((value) => typeof value === "string")) {
      throw new SchemaCompileError(`${path}.required: expected a string[]`);
    }
    required = [...rawRequired];
  }

  const rawAdditionalProperties = schema.additionalProperties;
  let additionalProperties: boolean | undefined;
  if (typeof rawAdditionalProperties !== "undefined") {
    if (typeof rawAdditionalProperties !== "boolean") {
      throw new SchemaCompileError(`${path}.additionalProperties: only boolean values are supported`);
    }
    additionalProperties = rawAdditionalProperties;
  }

  return { type: "object", properties, required, additionalProperties };
}

function parseArraySchema(schema: Record<string, unknown>, path: string, seenSchemas: Set<unknown>): Schema {
  const rawItems = schema.items;
  if (typeof rawItems === "undefined") {
    return { type: "array" };
  }
  if (Array.isArray(rawItems)) {
    throw new SchemaCompileError(`${path}.items: tuple validation is not supported`);
  }
  return { type: "array", items: parseSchema(rawItems, `${path}.items`, seenSchemas) };
}

function parseStringSchema(schema: Record<string, unknown>, path: string): Schema {
  const rawEnum = schema.enum;
  if (typeof rawEnum === "undefined") {
    return { type: "string" };
  }
  if (!Array.isArray(rawEnum) || !rawEnum.every((value) => typeof value === "string")) {
    throw new SchemaCompileError(`${path}.enum: expected a string[]`);
  }
  return { type: "string", enum: [...rawEnum] };
}

function rejectUnsupportedKeywords(schema: Record<string, unknown>, supportedKeywords: ReadonlySet<string>, path: string): void {
  for (const key of Object.keys(schema)) {
    if (!supportedKeywords.has(key)) {
      throw new SchemaCompileError(`${path}.${key}: unsupported JSON Schema keyword`);
    }
  }
}

function validate(
  schema: Schema,
  input: unknown,
  errors: SchemaValidationErrorItem[],
  path: string,
): void {
  if (schema.type === "object") {
    validateObject(schema, input, errors, path);
    return;
  }

  if (schema.type === "array") {
    validateArray(schema, input, errors, path);
    return;
  }

  if (schema.type === "integer") {
    if (!Number.isInteger(input)) {
      errors.push({ path, message: `expected integer, got ${typeLabel(input)}` });
    }
    return;
  }

  if (typeof input !== schema.type || input === null || Array.isArray(input)) {
    errors.push({ path, message: `expected ${schema.type}, got ${typeLabel(input)}` });
    return;
  }

  if (schema.type === "string" && schema.enum) {
    const stringInput = input as string;
    if (!schema.enum.includes(stringInput)) {
      errors.push({
        path,
        message: `must be one of [${schema.enum.map((v) => JSON.stringify(v)).join(", ")}]`,
      });
    }
  }
}

function validateObject(
  schema: Extract<Schema, { type: "object" }>,
  input: unknown,
  errors: SchemaValidationErrorItem[],
  path: string,
): void {
  if (!isObjectRecord(input)) {
    errors.push({ path, message: `expected object, got ${typeLabel(input)}` });
    return;
  }

  const properties = schema.properties ?? {};
  const required = new Set(schema.required ?? []);
  const blockExtra = schema.additionalProperties === false;

  for (const key of required) {
    if (!(key in input)) {
      errors.push({ path, message: `missing required property '${key}'` });
    }
  }

  for (const key of Object.keys(input)) {
    if (blockExtra && !(key in properties)) {
      errors.push({ path, message: `unexpected property '${key}'` });
      continue;
    }
    if (key in properties) {
      validate(properties[key]!, input[key], errors, `${path}.${key}`);
    }
  }
}

function validateArray(
  schema: Extract<Schema, { type: "array" }>,
  input: unknown,
  errors: SchemaValidationErrorItem[],
  path: string,
): void {
  if (!Array.isArray(input)) {
    errors.push({ path, message: `expected array, got ${typeLabel(input)}` });
    return;
  }

  if (!schema.items) return;
  input.forEach((item, index) => {
    validate(schema.items!, item, errors, `${path}[${index}]`);
  });
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function typeLabel(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}
