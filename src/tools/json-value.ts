export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export function isJsonValue(value: unknown): value is JsonValue {
  if (value === null) return true;
  const t = typeof value;
  if (t === "string" || t === "number" || t === "boolean") return true;
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (t === "object" && value !== null && !Array.isArray(value)) {
    const o = value as Record<string, unknown>;
    return Object.values(o).every(isJsonValue);
  }
  return false;
}
