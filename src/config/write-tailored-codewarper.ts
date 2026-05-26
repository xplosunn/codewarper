import { access, constants, writeFile } from "node:fs/promises";

export type TailoredCodewarperToolset = "none" | "workspace_files" | "workspace_files_with_websearch";

export interface TailoredCodewarperCommand {
  name: string;
  description: string;
  command: string;
  args: string[];
  timeoutMs: number;
}

export interface TailoredCodewarperPlan {
  summary: string;
  systemPrompt: string | null;
  toolset: TailoredCodewarperToolset;
  commands: TailoredCodewarperCommand[];
  notes: string[];
}

const COMMAND_NAME_PATTERN = /^[a-zA-Z][a-zA-Z0-9_-]*$/;
const MAX_COMMANDS = 8;
const MAX_ARGS = 20;
const DEFAULT_COMMAND_TIMEOUT_MS = 120_000;
const MIN_COMMAND_TIMEOUT_MS = 1_000;
const MAX_COMMAND_TIMEOUT_MS = 600_000;

export async function writeTailoredCodewarperConfigIfMissing(
  filePath: string,
  contents: string,
): Promise<"created" | "exists"> {
  try {
    await access(filePath, constants.F_OK);
    return "exists";
  } catch {
    await writeFile(filePath, contents, "utf8");
    return "created";
  }
}

export function normalizeTailoredCodewarperPlan(raw: unknown): TailoredCodewarperPlan {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("AI did not return a config plan object.");
  }

  const record = raw as Record<string, unknown>;
  const toolset = normalizeToolset(record.toolset);
  const commands = normalizeCommands(record.commands);

  return {
    summary: optionalString(record.summary) ?? "AI-generated Codewarper config tailored to this workspace.",
    systemPrompt: optionalString(record.systemPrompt) ?? null,
    toolset,
    commands,
    notes: optionalStringArray(record.notes).slice(0, 6),
  };
}

export function renderTailoredCodewarperConfig(plan: TailoredCodewarperPlan): string {
  const tools = renderTools(plan.toolset);
  const commands = renderCommands(plan.commands);
  const systemPromptEntry = plan.systemPrompt === null ? "" : `  systemPrompt: ${JSON.stringify(plan.systemPrompt)},\n`;

  return `/**
 * Codewarper config.
 * Generated from an AI-suggested plan and rendered by Codewarper's trusted template code.
 * Review before use. Tools and commands run with your local user permissions.
 * After editing this file, run /reload in codewarper to pick up changes.
 *
 * Summary: ${commentSafe(plan.summary)}
 */
import { spawn } from "node:child_process";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

type ListDirInput = { dirPath?: string };
type ReadFileInput = { filePath: string };
type WriteFileInput = { filePath: string; contents: string };
type DeleteFileInput = { filePath: string };
type WebsearchInput = {
  query: string;
  numResults?: number;
  livecrawl?: "fallback" | "preferred";
  type?: "auto" | "fast" | "deep";
  contextMaxCharacters?: number;
};

function resolveWorkspacePath(inputPath: string): string {
  const cwd = process.cwd();
  const resolved = path.resolve(cwd, inputPath);

  if (resolved !== cwd && !resolved.startsWith(cwd + path.sep)) {
    throw new Error(\`Path is outside the current working directory: \${inputPath}\`);
  }

  return resolved;
}

async function runCommand(command: string, args: string[], timeoutMs: number): Promise<string> {
  const child = spawn(command, args, { cwd: process.cwd(), shell: false });
  let stdout = "";
  let stderr = "";

  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });

  const exitCode = await new Promise<number | null>((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(\`Command timed out after \${timeoutMs}ms: \${command} \${args.join(" ")}\`));
    }, timeoutMs);

    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      resolve(code);
    });
  });

  const output = [stdout.trim(), stderr.trim()].filter(Boolean).join("\\n");
  if (exitCode === 0) return output || "ok";
  throw new Error(output || \`Command failed with exit code \${exitCode}: \${command} \${args.join(" ")}\`);
}

async function exaCall(tool: string, args: Record<string, unknown>, timeoutMs: number): Promise<string | undefined> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch("https://mcp.exa.ai/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: tool,
          arguments: args,
        },
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(\`Exa MCP request failed: \${response.status} \${response.statusText}\`);
    }

    const body = await response.text();
    for (const line of body.split("\\n")) {
      if (!line.startsWith("data: ")) continue;
      const parsed = JSON.parse(line.slice(6)) as {
        result?: { content?: Array<{ text?: string }> };
      };
      const text = parsed.result?.content?.[0]?.text;
      if (text) return text;
    }

    try {
      const parsed = JSON.parse(body) as {
        result?: { content?: Array<{ text?: string }> };
      };
      return parsed.result?.content?.[0]?.text;
    } catch {
      return undefined;
    }
  } finally {
    clearTimeout(timeout);
  }
}

export default {
${systemPromptEntry}  tools: [
${indent(tools, 4)}
  ],
  commands: {
${indent(commands, 4)}
  },
};
`;
}

function normalizeToolset(value: unknown): TailoredCodewarperToolset {
  if (value === "none" || value === "workspace_files" || value === "workspace_files_with_websearch") return value;
  throw new Error("AI config plan must use toolset: none, workspace_files, or workspace_files_with_websearch.");
}

function normalizeCommands(value: unknown): TailoredCodewarperCommand[] {
  if (typeof value === "undefined") return [];
  if (!Array.isArray(value)) throw new Error("AI config plan commands must be an array.");

  const commands: TailoredCodewarperCommand[] = [];
  const seen = new Set<string>();
  for (const raw of value.slice(0, MAX_COMMANDS)) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const record = raw as Record<string, unknown>;
    const name = optionalString(record.name);
    const command = optionalString(record.command);
    if (!name || !COMMAND_NAME_PATTERN.test(name) || seen.has(name)) continue;
    if (!command) continue;
    seen.add(name);
    commands.push({
      name,
      description: optionalString(record.description) ?? `Run ${name}`,
      command,
      args: optionalStringArray(record.args).slice(0, MAX_ARGS),
      timeoutMs: clampTimeout(record.timeoutMs),
    });
  }
  return commands;
}

function clampTimeout(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_COMMAND_TIMEOUT_MS;
  return Math.max(MIN_COMMAND_TIMEOUT_MS, Math.min(MAX_COMMAND_TIMEOUT_MS, Math.floor(value)));
}

function optionalString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed || /[\0\r\n]/.test(trimmed)) return undefined;
  return trimmed;
}

function optionalStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map(optionalString).filter((item): item is string => item !== undefined);
}

function renderTools(toolset: TailoredCodewarperToolset): string {
  if (toolset === "none") return "";
  return [
    listDirTool(),
    readFileTool(),
    writeFileTool(),
    deleteFileTool(),
    ...(toolset === "workspace_files_with_websearch" ? [websearchTool()] : []),
  ].join(",\n");
}

function renderCommands(commands: TailoredCodewarperCommand[]): string {
  return commands.map((command) => {
    return `${JSON.stringify(command.name)}: {
  description: ${JSON.stringify(command.description)},
  async run() {
    return await runCommand(${JSON.stringify(command.command)}, ${JSON.stringify(command.args)}, ${command.timeoutMs});
  },
}`;
  }).join(",\n");
}

function listDirTool(): string {
  return `{
  name: "list_dir",
  description: "List file and directory names inside the current working directory. Defaults to .",
  inputSchema: {
    type: "object",
    properties: {
      dirPath: { type: "string" },
    },
    required: [],
    additionalProperties: false,
  },
  getCallStatusMessage(input: ListDirInput) {
    return \`Listing directory \${input.dirPath ?? "."}\`;
  },
  async run(input: ListDirInput) {
    const dirPath = input.dirPath ?? ".";
    const names = await readdir(resolveWorkspacePath(dirPath));
    return names.join("\\n");
  },
}`;
}

function readFileTool(): string {
  return `{
  name: "read_file",
  description: "Read a UTF-8 text file inside the current working directory.",
  inputSchema: {
    type: "object",
    properties: {
      filePath: { type: "string" },
    },
    required: ["filePath"],
    additionalProperties: false,
  },
  getCallStatusMessage(input: ReadFileInput) {
    return \`Reading file \${input.filePath}\`;
  },
  async run(input: ReadFileInput) {
    return await readFile(resolveWorkspacePath(input.filePath), "utf8");
  },
}`;
}

function writeFileTool(): string {
  return `{
  name: "write_file",
  description: "Create or overwrite a UTF-8 text file inside the current working directory. Creates parent directories if needed.",
  inputSchema: {
    type: "object",
    properties: {
      filePath: { type: "string" },
      contents: { type: "string" },
    },
    required: ["filePath", "contents"],
    additionalProperties: false,
  },
  getCallStatusMessage(input: WriteFileInput) {
    return \`Writing file \${input.filePath}\`;
  },
  async run(input: WriteFileInput) {
    const filePath = resolveWorkspacePath(input.filePath);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, input.contents, "utf8");
    return "ok";
  },
}`;
}

function deleteFileTool(): string {
  return `{
  name: "delete_file",
  description: "Delete a file inside the current working directory.",
  inputSchema: {
    type: "object",
    properties: {
      filePath: { type: "string" },
    },
    required: ["filePath"],
    additionalProperties: false,
  },
  getCallStatusMessage(input: DeleteFileInput) {
    return \`Deleting file \${input.filePath}\`;
  },
  async run(input: DeleteFileInput) {
    await rm(resolveWorkspacePath(input.filePath));
    return "ok";
  },
}`;
}

function websearchTool(): string {
  return `{
  name: "websearch",
  description: "Search the web via Exa MCP. Returns search results as plain text.",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string" },
      numResults: { type: "number" },
      livecrawl: { type: "string", enum: ["fallback", "preferred"] },
      type: { type: "string", enum: ["auto", "fast", "deep"] },
      contextMaxCharacters: { type: "number" },
    },
    required: ["query"],
    additionalProperties: false,
  },
  getCallStatusMessage(input: WebsearchInput) {
    return \`Searching the web for \${JSON.stringify(input.query)}\`;
  },
  async run(input: WebsearchInput) {
    const result = await exaCall(
      "web_search_exa",
      {
        query: input.query,
        type: input.type ?? "auto",
        numResults: input.numResults ?? 8,
        livecrawl: input.livecrawl ?? "fallback",
        contextMaxCharacters: input.contextMaxCharacters,
      },
      25_000,
    );
    return result ?? "No search results found. Please try a different query.";
  },
}`;
}

function indent(text: string, spaces: number): string {
  if (!text) return "";
  const prefix = " ".repeat(spaces);
  return text.split("\n").map((line) => `${prefix}${line}`).join("\n");
}

function commentSafe(text: string): string {
  return text.replace(/\*\//g, "* /");
}
