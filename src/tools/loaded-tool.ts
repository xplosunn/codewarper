import * as Ajv from "ajv";
import type { ValidateFunction } from "ajv";
import type { Tool } from "./types.ts";

export type LoadedTool = {
  readonly tool: Tool;
  /** Throws `Error` if JSON Schema validation fails. */
  validateInput(input: unknown): void;
};

export function loadToolsWithValidators(tools: Tool[]): LoadedTool[] {
  const ajv = new Ajv.Ajv({ allErrors: true, strict: false });
  return tools.map((tool) => {
    let validator: ValidateFunction;
    try {
      validator = ajv.compile(tool.inputSchema as object);
    } catch (cause) {
      const message =
        cause instanceof Error
          ? cause.message
          : `Invalid JSON Schema for tool "${tool.name}" inputSchema.`;
      throw new Error(message, { cause });
    }

    const validateInput = (input: unknown): void => {
      if (!validator(input)) {
        throw new Error(
          `Tool "${tool.name}" input failed JSON Schema validation: ${ajv.errorsText(validator.errors)}`,
        );
      }
    };

    return { tool, validateInput };
  });
}
