import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { loadToolsWithValidators, type LoadedTool } from "../tools/loaded-tool.ts";
import type { Tool } from "../tools/types.ts";

const CONFIG_FILENAME = "codewarper.js";

function resolveWorkspacePath(inputPath: string): string {
  const cwd = process.cwd();
  const resolved = path.resolve(cwd, inputPath);
  if (resolved !== cwd && !resolved.startsWith(cwd + path.sep)) {
    throw new Error(`Path is outside the current working directory: ${inputPath}`);
  }
  return resolved;
}

// ---------------------------------------------------------------------------
// Tools for the AI config session
// ---------------------------------------------------------------------------

const readFileTool: Tool = {
  name: "read_file",
  description: "Read a UTF-8 text file. Path is relative to the working directory unless absolute.",
  inputSchema: {
    type: "object",
    properties: {
      filePath: { type: "string" },
      why: { type: "string" },
    },
    required: ["filePath", "why"],
    additionalProperties: false,
  },
  getCallStatusMessage(input: unknown) {
    const i = input as { filePath: string; why: string };
    return `Reading file ${i.filePath} — why: ${i.why}`;
  },
  async run(input: unknown) {
    const i = input as { filePath: string };
    return await readFile(resolveWorkspacePath(i.filePath), "utf8");
  },
};

const writeConfigTool: Tool = {
  name: "write_file",
  description:
    "Create or overwrite a UTF-8 text file inside the current working directory. Creates parent directories if needed. In this session, only codewarper.js can be written.",
  inputSchema: {
    type: "object",
    properties: {
      filePath: { type: "string" },
      contents: { type: "string" },
      why: { type: "string" },
    },
    required: ["filePath", "contents", "why"],
    additionalProperties: false,
  },
  getCallStatusMessage(input: unknown) {
    const i = input as { filePath: string; why: string };
    return `Writing file ${i.filePath} — why: ${i.why}`;
  },
  async run(input: unknown) {
    const i = input as { filePath: string; contents: string };
    const resolved = resolveWorkspacePath(i.filePath);
    const configPath = path.join(process.cwd(), CONFIG_FILENAME);
    if (resolved !== configPath) {
      throw new Error(
        `This session can only write to ${CONFIG_FILENAME}. Requested: ${i.filePath}`,
      );
    }
    await mkdir(path.dirname(resolved), { recursive: true });
    await writeFile(resolved, i.contents, "utf8");
    return "ok";
  },
};

const AI_CONFIG_TOOLS: Tool[] = [readFileTool, writeConfigTool];

export function createAiConfigSessionTools(): LoadedTool[] {
  return loadToolsWithValidators(AI_CONFIG_TOOLS);
}

export const AI_CONFIG_SYSTEM_PROMPT = [
  "You are configuring Codewarper for this project.",
  "You have two tools: read_file (read any file in the workspace) and write_file (write only codewarper.js).",
  "",
  "WORKFLOW:",
  "1. Read package.json (or equivalent project manifest) and the current codewarper.js to understand the project and config format.",
  "2. Read additional files as needed: linter configs, test setup, build scripts, CI config, etc.",
  "3. Write an improved codewarper.js that adds project-specific tools: build, test, lint, typecheck, etc.",
  "",
  "RULES:",
  "- Keep all existing tools from the template.",
  "- Add new tools as additional entries in the tools array. Never remove the template tools.",
  "- Use the same code style as the existing file.",
  "- For commands that run shell programs, use the spawn-based runCommand pattern.",
  "- Keep the file valid JavaScript. The user will /reload after reviewing.",
  "",
  "Be thorough but concise.",
].join("\n");

export const AI_CONFIG_USER_PROMPT = [
  "Analyze this project and update codewarper.js to add tools for iterating on the project:",
  "- Building / compiling",
  "- Running tests",
  "- Linting / formatting",
  "- Any other project-specific workflows",
  "",
  "Start by reading the current codewarper.js and package.json (or equivalent).",
  "Then explore further and write the improved config.",
].join("\n");
