import { compile, formatErrors, type ValidateFunction, SchemaValidationError } from "../../libs/schema/schema.ts";
import type { Tool } from "./types.ts";

export type LoadedTool = {
  readonly tool: Tool;
  /** Throws `Error` if JSON Schema validation fails. */
  validateInput(input: unknown): void;
};

export function loadToolsWithValidators(tools: Tool[]): LoadedTool[] {
  return tools.map((tool) => {
    let validator: ValidateFunction;
    try {
      validator = compile(tool.inputSchema);
    } catch (cause) {
      const detail = cause instanceof Error ? `: ${cause.message}` : ".";
      throw new Error(`Invalid JSON Schema for tool "${tool.name}" inputSchema${detail}`, { cause });
    }

    const validateInput = (input: unknown): void => {
      try {
        validator(input);
      } catch (error) {
        if (error instanceof SchemaValidationError) {
          throw new Error(
            `Tool "${tool.name}" input failed JSON Schema validation: ${formatErrors(error.errors)}`,
          );
        }
        throw error;
      }
    };

    return { tool, validateInput };
  });
}
