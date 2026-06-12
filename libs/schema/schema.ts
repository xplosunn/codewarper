// Minimal JSON Schema validator — covers the subset used by Codewarper tools:
//   type: "object" | "string" | "number" | "boolean"
//   properties, required, additionalProperties, enum

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

export type ValidateFunction = (input: unknown) => void;

export type Schema =
  | { type: "object"; properties?: Record<string, Schema>; required?: readonly string[]; additionalProperties?: boolean }
  | { type: "string"; enum?: readonly string[] }
  | { type: "number" | "boolean" };

const TYPE_MAP: Record<string, string> = {
  object: "object",
  string: "string",
  number: "number",
  boolean: "boolean",
};

export function compile(schema: Schema): ValidateFunction {
  return (input: unknown): void => {
    const errors: SchemaValidationErrorItem[] = [];
    validate(schema, input, errors, "$");
    if (errors.length > 0) throw new SchemaValidationError(errors);
  };
}

export function formatErrors(errors: readonly SchemaValidationErrorItem[]): string {
  return errors.map((e) => `${e.path}: ${e.message}`).join("; ");
}

function validate(
  schema: Schema,
  input: unknown,
  errors: SchemaValidationErrorItem[],
  path: string,
): void {
  const kind = TYPE_MAP[schema.type];
  if (kind === undefined) return; // unknown type — skip validation

  // --- type check ---
  if (Array.isArray(input) || input === null || typeof input !== kind) {
    errors.push({ path, message: `expected ${kind}, got ${typeLabel(input)}` });
    return;
  }

  // --- string enum ---
  if (schema.type === "string" && "enum" in schema && schema.enum) {
    if (!schema.enum.includes(input as string)) {
      errors.push({
        path,
        message: `must be one of [${schema.enum.map((v) => JSON.stringify(v)).join(", ")}]`,
      });
    }
    return;
  }

  // --- object ---
  if (schema.type === "object") {
    const record = input as Record<string, unknown>;
    const properties = schema.properties ?? {};
    const required = new Set(schema.required ?? []);
    const blockExtra = schema.additionalProperties === false;

    for (const key of required) {
      if (!(key in record)) {
        errors.push({ path, message: `missing required property '${key}'` });
      }
    }

    for (const key of Object.keys(record)) {
      if (blockExtra && !(key in properties)) {
        errors.push({ path, message: `unexpected property '${key}'` });
        continue;
      }
      if (key in properties) {
        validate(properties[key]!, record[key], errors, `${path}.${key}`);
      }
    }
  }
}

function typeLabel(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}
