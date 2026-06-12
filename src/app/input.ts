import type { UserInput } from "./types.ts";

export function parseUserInput(rawInput: string): UserInput {
  const text = rawInput.trim();

  if (!text) return { type: "empty" };
  if (text === "/quit" || text === "/exit") return { type: "quit" };
  if (text === "/model") return { type: "switch_model" };
  if (text === "/login") return { type: "login" };
  if (text === "/reload") return { type: "reload" };
  if (text === "/help") return { type: "help" };
  if (text.startsWith("/")) {
    const parts = text
      .slice(1)
      .split(/\s+/)
      .filter((part) => part.length > 0);
    const [name, ...args] = parts;
    if (name) return { type: "custom_command", name, args };
    return { type: "unknown_command", command: text };
  }
  return { type: "prompt", text: rawInput };
}
