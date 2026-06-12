import type { JsonValue } from "./json-value.ts";

export type InputSchema = { [key: string]: JsonValue };

export interface Tool {
  name: string;
  description: string;
  inputSchema: InputSchema;
  getCallStatusMessage: (input: unknown) => string;
  run: (input: unknown) => Promise<string>;
}

export interface Command {
  description: string;
  run: (args: string[]) => Promise<string> | string;
}

export interface CodewarperConfig {
  tools?: Tool[];
  commands?: Record<string, Command>;
  systemPrompt?: string;
}
