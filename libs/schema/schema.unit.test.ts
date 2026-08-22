import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { compile, formatErrors, SchemaCompileError, SchemaValidationError } from "../../libs/schema/schema.ts";

describe("compile", () => {
  it("passes when input matches schema", () => {
    const validate = compile({
      type: "object",
      properties: { name: { type: "string" }, age: { type: "number" } },
      required: ["name"],
      additionalProperties: false,
    });

    assert.doesNotThrow(() => validate({ name: "Alice", age: 30 }));
  });

  it("passes with only required fields", () => {
    const validate = compile({
      type: "object",
      properties: { name: { type: "string" }, age: { type: "number" } },
      required: ["name"],
      additionalProperties: false,
    });

    assert.doesNotThrow(() => validate({ name: "Bob" }));
  });

  it("fails on missing required property", () => {
    const validate = compile({
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
      additionalProperties: false,
    });

    assert.throws(
      () => validate({}),
      (err: unknown) => {
        assert.ok(err instanceof SchemaValidationError);
        assert.ok(err.message.includes("missing required property 'name'"));
        return true;
      },
    );
  });

  it("fails on wrong type", () => {
    const validate = compile({
      type: "object",
      properties: { count: { type: "number" } },
      required: ["count"],
      additionalProperties: false,
    });

    assert.throws(
      () => validate({ count: "not-a-number" }),
      (err: unknown) => {
        assert.ok(err instanceof SchemaValidationError);
        assert.ok(err.message.includes("expected number, got string"));
        return true;
      },
    );
  });

  it("fails on unexpected property when additionalProperties is false", () => {
    const validate = compile({
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
      additionalProperties: false,
    });

    assert.throws(
      () => validate({ name: "Alice", extra: true }),
      (err: unknown) => {
        assert.ok(err instanceof SchemaValidationError);
        assert.ok(err.message.includes("unexpected property 'extra'"));
        return true;
      },
    );
  });

  it("allows extra properties when additionalProperties is not false", () => {
    const validate = compile({
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
      // additionalProperties not set — defaults to allowing extras
    });

    assert.doesNotThrow(() => validate({ name: "Alice", extra: true }));
  });

  it("supports string enum", () => {
    const validate = compile({
      type: "string",
      enum: ["low", "medium", "high"],
    });

    assert.doesNotThrow(() => validate("low"));
    assert.doesNotThrow(() => validate("high"));

    assert.throws(
      () => validate("extreme"),
      (err: unknown) => {
        assert.ok(err instanceof SchemaValidationError);
        assert.ok(err.message.includes('must be one of ["low", "medium", "high"]'));
        return true;
      },
    );
  });

  it("supports boolean type", () => {
    const validate = compile({ type: "boolean" });

    assert.doesNotThrow(() => validate(true));
    assert.doesNotThrow(() => validate(false));

    assert.throws(
      () => validate("true"),
      (err: unknown) => {
        assert.ok(err instanceof SchemaValidationError);
        assert.ok(err.message.includes("expected boolean, got string"));
        return true;
      },
    );
  });

  it("validates nested objects", () => {
    const validate = compile({
      type: "object",
      properties: {
        user: {
          type: "object",
          properties: { email: { type: "string" } },
          required: ["email"],
          additionalProperties: false,
        },
      },
      required: ["user"],
      additionalProperties: false,
    });

    assert.doesNotThrow(() => validate({ user: { email: "a@b.com" } }));

    assert.throws(
      () => validate({ user: {} }),
      (err: unknown) => {
        assert.ok(err instanceof SchemaValidationError);
        assert.ok(err.message.includes("$.user: missing required property 'email'"));
        return true;
      },
    );
  });

  it("rejects null input for object schema", () => {
    const validate = compile({ type: "object" });

    assert.throws(
      () => validate(null),
      (err: unknown) => {
        assert.ok(err instanceof SchemaValidationError);
        assert.ok(err.message.includes("expected object, got null"));
        return true;
      },
    );
  });

  it("rejects array input for object schema", () => {
    const validate = compile({ type: "object" });

    assert.throws(
      () => validate([1, 2, 3]),
      (err: unknown) => {
        assert.ok(err instanceof SchemaValidationError);
        assert.ok(err.message.includes("expected object, got array"));
        return true;
      },
    );
  });

  it("validates arrays with item schemas", () => {
    const validate = compile({
      type: "array",
      items: {
        type: "object",
        properties: {
          oldText: { type: "string" },
          newText: { type: "string" },
        },
        required: ["oldText", "newText"],
        additionalProperties: false,
      },
    });

    assert.doesNotThrow(() => validate([{ oldText: "a", newText: "b" }]));

    assert.throws(
      () => validate([{ oldText: "a", newText: 1 }]),
      (err: unknown) => {
        assert.ok(err instanceof SchemaValidationError);
        assert.ok(err.message.includes("$[0].newText: expected string, got number"));
        return true;
      },
    );
  });

  it("supports integer type", () => {
    const validate = compile({ type: "integer" });

    assert.doesNotThrow(() => validate(1));

    assert.throws(
      () => validate(1.5),
      (err: unknown) => {
        assert.ok(err instanceof SchemaValidationError);
        assert.ok(err.message.includes("expected integer, got number"));
        return true;
      },
    );
  });

  it("rejects unsupported schema types at compile time", () => {
    assert.throws(
      () => compile({ type: "null" }),
      (err: unknown) => {
        assert.ok(err instanceof SchemaCompileError);
        assert.ok(err.message.includes('$.type: unsupported JSON Schema type "null"'));
        return true;
      },
    );
  });

  it("rejects unsupported schema keywords at compile time", () => {
    assert.throws(
      () => compile({ type: "string", oneOf: [{ type: "string" }] }),
      (err: unknown) => {
        assert.ok(err instanceof SchemaCompileError);
        assert.ok(err.message.includes("$.oneOf: unsupported JSON Schema keyword"));
        return true;
      },
    );
  });

  it("rejects unsupported nested schema keywords at compile time", () => {
    assert.throws(
      () => compile({ type: "array", items: { type: "string", minLength: 1 } }),
      (err: unknown) => {
        assert.ok(err instanceof SchemaCompileError);
        assert.ok(err.message.includes("$.items.minLength: unsupported JSON Schema keyword"));
        return true;
      },
    );
  });

  it("collects multiple errors", () => {
    const validate = compile({
      type: "object",
      properties: {
        name: { type: "string" },
        count: { type: "number" },
      },
      required: ["name", "count"],
      additionalProperties: false,
    });

    assert.throws(
      () => validate({ name: 123 }),
      (err: unknown) => {
        assert.ok(err instanceof SchemaValidationError);
        const messages = err.message;
        assert.ok(messages.includes("expected string, got number"));
        assert.ok(messages.includes("missing required property 'count'"));
        return true;
      },
    );
  });
});

describe("formatErrors", () => {
  it("formats a list of errors", () => {
    const result = formatErrors([
      { path: "$.a", message: "expected string" },
      { path: "$.b", message: "expected number" },
    ]);
    assert.equal(result, "$.a: expected string; $.b: expected number");
  });
});
