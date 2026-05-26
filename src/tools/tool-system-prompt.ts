import type { LoadedTool } from "./loaded-tool.ts";

/**
 * Appends brief guidance for provider-native tools to the base system prompt.
 */
export function appendToolGuidanceToSystemPrompt(base: string, loadedTools: readonly LoadedTool[]): string {
  if (loadedTools.length === 0) {
    return base;
  }

  const lines: string[] = [
    base,
    "",
    "## Codewarper user tools",
    "",
    "This project may define tools in its Codewarper config. Use the provider-native tool calling interface when a tool would help.",
    "",
    "Rules:",
    "- Tool inputs must match the tool input_schema below.",
    "- If you are not calling a tool, respond normally in text.",
    "",
    "### Tool catalog",
    "",
  ];

  for (const { tool } of loadedTools) {
    lines.push(`#### ${tool.name}`, "", tool.description, "", "`input_schema`:", "```json", JSON.stringify(tool.inputSchema, null, 2), "```", "");
  }

  return lines.join("\n");
}
