import { access, constants, writeFile } from "node:fs/promises";

export type InitialCodewarperStarter =
  | "empty"
  | "local_files"
  | "local_files_with_websearch"
  | "all_config_options"
  | "recommended_for_codewarper";

export interface InitialCodewarperStarterOption {
  id: InitialCodewarperStarter;
  label: string;
}

export const INITIAL_CODEWARPER_STARTER_OPTIONS: InitialCodewarperStarterOption[] = [
  {
    id: "empty",
    label: "Empty: create a blank Codewarper config with no tools",
  },
  {
    id: "local_files",
    label: "Local files: list directories, read files, write files, and delete files",
  },
  {
    id: "local_files_with_websearch",
    label: "Local files + web search: local file tools plus Exa-backed web search",
  },
  {
    id: "all_config_options",
    label:
      "Showcase all config options: systemPrompt, tools, commands, hooks (onProviderRequest, onProviderResponse)",
  },
  {
    id: "recommended_for_codewarper",
    label:
      "Recommended for working on Codewarper itself: full set of development tools including pnpm test, grep, git review, and web search",
  },
];

const EMPTY_CODEWARPER_TS = `/**
 * Codewarper config.
 * Tools and commands run with your local user permissions.
 * After editing this file, run /reload in codewarper to pick up changes.
 */
export default {
  tools: [],
};
`;

const LOCAL_FILES_CODEWARPER_TS = `/**
 * Codewarper config.
 * Tools and commands run with your local user permissions.
 * After editing this file, run /reload in codewarper to pick up changes.
 */
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

type ListDirInput = { dirPath?: string };
type ReadFileInput = { filePath: string };
type WriteFileInput = { filePath: string; contents: string };
type DeleteFileInput = { filePath: string };

function resolveWorkspacePath(inputPath: string): string {
  const cwd = process.cwd();
  const resolved = path.resolve(cwd, inputPath);

  if (resolved !== cwd && !resolved.startsWith(cwd + path.sep)) {
    throw new Error(\`Path is outside the current working directory: \${inputPath}\`);
  }

  return resolved;
}

export default {
  tools: [
    {
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
    },
    {
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
    },
    {
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
    },
    {
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
    },
  ],
};
`;

const LOCAL_FILES_WITH_WEBSEARCH_CODEWARPER_TS = `/**
 * Codewarper config.
 * Tools and commands run with your local user permissions.
 * After editing this file, run /reload in codewarper to pick up changes.
 */
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
  tools: [
    {
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
    },
    {
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
    },
    {
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
    },
    {
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
    },
    {
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
    },
  ],
};
`;

export const ALL_CONFIG_OPTIONS_CODEWARPER_TS = `/**
 * Codewarper Config — All Configuration Options
 * ==============================================
 *
 * This template showcases every configuration option available in Codewarper.
 * Use it as a reference for building your own config.
 *
 * Options demonstrated:
 *   systemPrompt         — Custom system instructions for the AI
 *   tools                — Define tools the AI can invoke
 *   commands             — Register custom slash commands (/command_name)
 *   hooks                — Lifecycle hooks (onProviderRequest, onProviderResponse, …)
 *
 * Tools and commands run with your local user permissions.
 * After editing this file, run /reload in codewarper to pick up changes.
 */
import { execFile } from "node:child_process";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Type helpers — used to type tool input parameters
// ---------------------------------------------------------------------------

type ListDirInput = { dirPath?: string };
type ReadFileInput = { filePath: string };
type WriteFileInput = { filePath: string; contents: string };
type DeleteFileInput = { filePath: string };
type GrepInput = {
  pattern: string;
  dirPath?: string;
  filePattern?: string;
  maxResults?: number;
};
type WebsearchInput = {
  query: string;
  numResults?: number;
  livecrawl?: "fallback" | "preferred";
  type?: "auto" | "fast" | "deep";
  contextMaxCharacters?: number;
};

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

/** Resolve a path relative to the workspace root, rejecting paths that escape it. */
function resolveWorkspacePath(inputPath: string): string {
  const cwd = process.cwd();
  const resolved = path.resolve(cwd, inputPath);
  if (resolved !== cwd && !resolved.startsWith(cwd + path.sep)) {
    throw new Error(\`Path is outside the current working directory: \${inputPath}\`);
  }
  return resolved;
}

/** Call the Exa MCP web search API. */
async function exaCall(
  tool: string,
  args: Record<string, unknown>,
  timeoutMs: number,
): Promise<string | undefined> {
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
        params: { name: tool, arguments: args },
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
  // =========================================================================
  // systemPrompt  (optional — set to null or omit to use the built-in prompt)
  // =========================================================================
  // Controls the AI's behaviour. The built-in default is a general-purpose
  // coding-assistant prompt. Override it here when you need a different
  // persona or specialised instructions for your workspace.
  systemPrompt: [
    "You are a helpful assistant with access to a full set of Codewarper tools and commands.",
    "Demonstrate the capabilities at your disposal when helping the user.",
    "Be concise and practical.",
  ].join("\\n"),

  // =========================================================================
  // tools  (optional — default: [])
  // =========================================================================
  // Each tool has five fields:
  //   name                — Unique identifier used by the AI
  //   description         — Prompted to the AI so it knows when to call it
  //   inputSchema         — JSON Schema describing the expected arguments
  //   getCallStatusMessage(input) — Returns a human-readable status string
  //   async run(input)    — The implementation; return value is shown to the AI
  tools: [
    // --- Workspace file tools ---
    {
      name: "list_dir",
      description:
        "List file and directory names inside the current working directory. Defaults to .",
      inputSchema: {
        type: "object",
        properties: { dirPath: { type: "string" } },
        required: [],
        additionalProperties: false,
      },
      getCallStatusMessage(input: ListDirInput) {
        return \`Listing directory \${input.dirPath ?? "."}\`;
      },
      async run(input: ListDirInput) {
        const names = await readdir(resolveWorkspacePath(input.dirPath ?? "."));
        return names.join("\\n");
      },
    },
    {
      name: "read_file",
      description: "Read a UTF-8 text file inside the current working directory.",
      inputSchema: {
        type: "object",
        properties: { filePath: { type: "string" } },
        required: ["filePath"],
        additionalProperties: false,
      },
      getCallStatusMessage(input: ReadFileInput) {
        return \`Reading file \${input.filePath}\`;
      },
      async run(input: ReadFileInput) {
        return await readFile(resolveWorkspacePath(input.filePath), "utf8");
      },
    },
    {
      name: "write_file",
      description:
        "Create or overwrite a UTF-8 text file inside the current working directory. Creates parent directories if needed.",
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
    },
    {
      name: "delete_file",
      description: "Delete a file inside the current working directory.",
      inputSchema: {
        type: "object",
        properties: { filePath: { type: "string" } },
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
    },

    // --- Search tool (grep) ---
    {
      name: "grep",
      description:
        "Recursively search for a regex pattern in files. Use filePattern to filter by file name or extension.",
      inputSchema: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "Regular expression pattern" },
          dirPath: { type: "string", description: "Directory to search in" },
          filePattern: {
            type: "string",
            description: "Regex to filter file paths (e.g. '\\\\.ts$')",
          },
          maxResults: {
            type: "number",
            description: "Maximum matching lines to return (default 50)",
          },
        },
        required: ["pattern"],
        additionalProperties: false,
      },
      getCallStatusMessage(input: GrepInput) {
        return \`Searching for \${JSON.stringify(input.pattern)}\`;
      },
      async run(input: GrepInput) {
        const dir = resolveWorkspacePath(input.dirPath ?? ".");
        const max = Math.min(input.maxResults ?? 50, 200);
        try {
          const { stdout } = await execFileAsync("grep", [
            "-rn",
            "-e",
            input.pattern,
            dir,
          ], { maxBuffer: 2 * 1024 * 1024, timeout: 15_000 });
          let lines = stdout.split("\\n").filter((l: string) => l.length > 0);
          if (input.filePattern) {
            const fileRegex = new RegExp(input.filePattern);
            lines = lines.filter((l: string) => fileRegex.test(l));
          }
          const truncated = lines.slice(0, max);
          let result = truncated.join("\\n");
          if (lines.length > max) {
            result += \`\\n... (\${lines.length - max} more matches)\`;
          }
          return result || "No matches found.";
        } catch (e) {
          const err = e as Error & { code?: number };
          if (err.code === 1) return "No matches found.";
          throw err;
        }
      },
    },

    // --- External API tool (web search via Exa) ---
    {
      name: "websearch",
      description:
        "Search the web via Exa MCP. Returns search results as plain text.",
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
    },
  ],

  // =========================================================================
  // commands  (optional — default: {})
  // =========================================================================
  // Custom slash commands are accessible at the prompt as /command_name.
  // Each command has:
  //   description  — Shown in /help output
  //   async run(args: string[]) — The handler; its return value is printed
  commands: {
    changed_files: {
      description:
        "Show files changed from HEAD. Pass git diff args after the command, e.g. /changed_files --staged",
      async run(args: string[]) {
        const { stdout } = await execFileAsync(
          "git",
          ["diff", "--name-only", ...args],
          { cwd: process.cwd(), maxBuffer: 10 * 1024 * 1024 },
        );
        return stdout.trim() || "No changed files.";
      },
    },
  },

  // =========================================================================
  // hooks  (optional — default: null)
  // =========================================================================
  // Lifecycle hooks that fire at specific points during the provider request
  // lifecycle. Add new hooks here as they become available.
  hooks: {
    // Called before every request to the LLM provider.  Use it for logging,
    // rate-limiting, auditing, or modifying the outgoing fetch Request.
    // Return void or a Promise<void>.
    onProviderRequest(request: Request): void | Promise<void> {
      console.log(\`[Provider Request] \${request.method} \${request.url}\`);
    },

    // Called after every response from the LLM provider.  Use it for logging,
    // usage tracking, or inspecting the Response.
    // Return void or a Promise<void>.
    onProviderResponse(request: Request, response: Response): void | Promise<void> {
      console.log(\`[Provider Response] \${response.status} \${response.statusText}\`);
    },
  },
};
`;

const RECOMMENDED_FOR_CODEWARPER_TS = `/**
 * Codewarper config tailored for working on the Codewarper project itself.
 * Tools and commands run with your local user permissions.
 * After editing this file, run /reload in codewarper to pick up changes.
 */
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Type helpers — used to type tool input parameters
// ---------------------------------------------------------------------------

type ListDirInput = { dirPath?: string; recursive?: boolean; why: string };
type ReadFileInput = { filePath: string; why: string };
type WriteFileInput = { filePath: string; contents: string; why: string };
type DeleteFileInput = { filePath: string; why: string };
type SearchInFilesInput = { dirPath: string; pattern: string; why: string };
type GrepInput = {
  pattern: string;
  dirPath?: string;
  filePattern?: string;
  maxResults?: number;
  why: string;
};
type WebsearchInput = {
  query: string;
  numResults?: number;
  livecrawl?: "fallback" | "preferred";
  type?: "auto" | "fast" | "deep";
  contextMaxCharacters?: number;
  why: string;
};

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

/** Add \\\`why\\\` (required, string) to a JSON Schema object. */
function withWhy<T extends { properties?: Record<string, unknown>; required?: string[] }>(schema: T) {
  return {
    ...schema,
    properties: { ...(schema.properties ?? {}), why: { type: "string" } },
    required: [...(schema.required ?? []), "why"],
    additionalProperties: false,
  };
}

function resolveUnderCwd(p: string): string {
  return path.resolve(process.cwd(), p);
}

async function listDirRecursive(dir: string, base = dir): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const names: string[] = [];
  for (const entry of entries) {
    const entryPath = path.join(dir, entry.name);
    names.push(path.relative(base, entryPath) || entry.name);
    if (entry.isDirectory()) {
      names.push(...(await listDirRecursive(entryPath, base)));
    }
  }
  return names;
}

async function exaCall(
  tool: string,
  args: Record<string, unknown>,
  timeoutMs: number,
): Promise<string | undefined> {
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
        params: { name: tool, arguments: args },
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

async function runPnpmScript(script: string): Promise<string> {
  try {
    const { stdout, stderr } = await execFileAsync("pnpm", ["run", script], {
      cwd: process.cwd(),
      maxBuffer: 10 * 1024 * 1024,
    });
    return [
      \`exitCode: 0\`,
      stdout.trim() ? \`stdout:\\n\${stdout.trim()}\` : "",
      stderr.trim() ? \`stderr:\\n\${stderr.trim()}\` : "",
    ]
      .filter((part) => part.length > 0)
      .join("\\n\\n");
  } catch (error) {
    const e = error as Error & {
      stdout?: string;
      stderr?: string;
      code?: number | string;
    };
    return [
      \`exitCode: \${String(e.code ?? "unknown")}\`,
      e.stdout?.trim() ? \`stdout:\\n\${e.stdout.trim()}\` : "",
      e.stderr?.trim() ? \`stderr:\\n\${e.stderr.trim()}\` : "",
      e.message ? \`error:\\n\${e.message}\` : "",
    ]
      .filter((part) => part.length > 0)
      .join("\\n\\n");
  }
}

export default {
  systemPrompt: [
    "You are a concise coding assistant. Help with code, debugging, design, and implementation details.",
    "Be practical and direct.",
    "Use tools to discover the project and help the user. Always start by gathering real information before giving an answer.",
    "Summarize your answer. The user has a short attention span.",
  ].join("\\n"),
  commands: {
    changed_files: {
      description:
        "Show files changed from HEAD. Pass git diff args after the command, e.g. /changed_files --staged",
      async run(args: string[]) {
        const { stdout } = await execFileAsync(
          "git",
          ["diff", "--name-only", ...args],
          { cwd: process.cwd(), maxBuffer: 10 * 1024 * 1024 },
        );
        return stdout.trim() || "No changed files.";
      },
    },
  },
  tools: [
    {
      name: "list_dir",
      description:
        "List file and directory names in a directory. Defaults to \\\`.\\\` when omitted. Set \\\`recursive\\\` to true to include nested entries.",
      inputSchema: withWhy({
        type: "object",
        properties: {
          dirPath: { type: "string" },
          recursive: { type: "boolean" },
        },
        required: [],
      }),
      getCallStatusMessage(input: ListDirInput) {
        return \`Listing directory \${input.dirPath ?? "."}\${input.recursive ? " recursively" : ""} \\u2014 why: \${input.why}\`;
      },
      async run(input: ListDirInput) {
        const dirPath = input.dirPath ?? ".";
        const fullPath = resolveUnderCwd(dirPath);
        if (input.recursive) {
          const names = await listDirRecursive(fullPath);
          return names.join("\\n");
        }
        const names = await readdir(fullPath);
        return names.join("\\n");
      },
    },
    {
      name: "read_file",
      description:
        "Read a UTF-8 text file. Path is relative to the working directory unless absolute.",
      inputSchema: withWhy({
        type: "object",
        properties: { filePath: { type: "string" } },
        required: ["filePath"],
      }),
      getCallStatusMessage(input: ReadFileInput) {
        return \`Reading file \${input.filePath} \\u2014 why: \${input.why}\`;
      },
      async run(input: ReadFileInput) {
        return await readFile(resolveUnderCwd(input.filePath), "utf8");
      },
    },
    {
      name: "write_file",
      description:
        "Create or overwrite a UTF-8 text file. Creates parent directories if needed. Path is relative to the working directory unless absolute.",
      inputSchema: withWhy({
        type: "object",
        properties: {
          filePath: { type: "string" },
          contents: { type: "string" },
        },
        required: ["filePath", "contents"],
      }),
      getCallStatusMessage(input: WriteFileInput) {
        return \`Writing file \${input.filePath} \\u2014 why: \${input.why}\`;
      },
      async run(input: WriteFileInput) {
        const p = resolveUnderCwd(input.filePath);
        await mkdir(path.dirname(p), { recursive: true });
        await writeFile(p, input.contents, "utf8");
        return "ok";
      },
    },
    {
      name: "delete_file",
      description:
        "Delete a file. Path is relative to the working directory unless absolute.",
      inputSchema: withWhy({
        type: "object",
        properties: { filePath: { type: "string" } },
        required: ["filePath"],
      }),
      getCallStatusMessage(input: DeleteFileInput) {
        return \`Deleting file \${input.filePath} \\u2014 why: \${input.why}\`;
      },
      async run(input: DeleteFileInput) {
        await rm(resolveUnderCwd(input.filePath), { force: true });
        return "ok";
      },
    },
    {
      name: "search_in_files",
      description:
        "Search for a text pattern within files in a directory. Returns a list of file names that contain the pattern.",
      inputSchema: withWhy({
        type: "object",
        properties: {
          dirPath: { type: "string" },
          pattern: { type: "string" },
        },
        required: ["dirPath", "pattern"],
      }),
      getCallStatusMessage(input: SearchInFilesInput) {
        return \`Searching for \${JSON.stringify(input.pattern)} in \${input.dirPath} \\u2014 why: \${input.why}\`;
      },
      async run(input: SearchInFilesInput) {
        const dir = resolveUnderCwd(input.dirPath);
        const entries = await readdir(dir, { withFileTypes: true });
        const matchedFiles: string[] = [];
        const regex = new RegExp(input.pattern, "i");
        for (const entry of entries) {
          if (entry.isFile()) {
            const filePath = path.join(dir, entry.name);
            const content = await readFile(filePath, "utf8");
            if (regex.test(content)) {
              matchedFiles.push(entry.name);
            }
          }
        }
        return matchedFiles.join("\\n");
      },
    },
    {
      name: "grep",
      description:
        "Recursively search for a regex pattern in files using \\\`grep -rn\\\`, showing matching lines with file paths and line numbers. Use \\\`filePattern\\\` to filter by file name/extension (e.g. '\\\\.ts$' for TypeScript files).",
      inputSchema: withWhy({
        type: "object",
        properties: {
          pattern: {
            type: "string",
            description: "Regular expression pattern to search for",
          },
          dirPath: {
            type: "string",
            description: "Directory to search in. Defaults to the current working directory.",
          },
          filePattern: {
            type: "string",
            description:
              "Optional regex to filter matching output by file path (e.g. '\\\\.ts:' for TypeScript files).",
          },
          maxResults: {
            type: "number",
            description: "Maximum number of matching lines to return. Defaults to 50.",
          },
        },
        required: ["pattern"],
      }),
      getCallStatusMessage(input: GrepInput) {
        return \`Grep for \${JSON.stringify(input.pattern)} in \${input.dirPath ?? "."}\${input.filePattern ? \` (output paths matching: \${input.filePattern})\` : ""} \\u2014 why: \${input.why}\`;
      },
      async run(input: GrepInput) {
        const dir = resolveUnderCwd(input.dirPath ?? ".");
        const max = Math.min(input.maxResults ?? 50, 200);
        const args = ["-rn", "-e", input.pattern, dir];

        try {
          const { stdout } = await execFileAsync("grep", args, {
            maxBuffer: 2 * 1024 * 1024,
            timeout: 15_000,
          });
          let lines = stdout.split("\\n").filter((line) => line.length > 0);
          if (input.filePattern) {
            const fileRegex = new RegExp(input.filePattern);
            lines = lines.filter((line) => fileRegex.test(line));
          }
          const truncated = lines.slice(0, max);
          let result = truncated.join("\\n");
          if (lines.length > max) {
            result += \`\\n... (\${lines.length - max} more matches truncated. Narrow your pattern or use filePattern.)\`;
          }
          return result || "No matches found.";
        } catch (error) {
          const e = error as Error & { code?: number | string; stderr?: string };
          if (e.code === 1) {
            return "No matches found.";
          }
          return [
            \`exitCode: \${String(e.code ?? "unknown")}\`,
            e.stderr?.trim() ? \`stderr:\\n\${e.stderr.trim()}\` : "",
            e.message ? \`error:\\n\${e.message}\` : "",
          ]
            .filter((part) => part.length > 0)
            .join("\\n\\n");
        }
      },
    },
    {
      name: "run_pnpm_test",
      description:
        "Run \\\`pnpm run test\\\` in the working directory and return stdout/stderr plus the exit status.",
      inputSchema: withWhy({
        type: "object",
        properties: {},
        required: [],
      }),
      getCallStatusMessage(input: { why: string }) {
        return \`Running pnpm run test \\u2014 why: \${input.why}\`;
      },
      async run(input: { why: string }) {
        return await runPnpmScript("test");
      },
    },
    {
      name: "reviewChanges",
      description:
        "Return the current git diff against HEAD.",
      inputSchema: withWhy({
        type: "object",
        properties: {},
        required: [],
      }),
      getCallStatusMessage(input: { why: string }) {
        return \`Reviewing git diff HEAD \\u2014 why: \${input.why}\`;
      },
      async run(input: { why: string }) {
        try {
          const { stdout, stderr } = await execFileAsync(
            "git",
            ["diff", "HEAD"],
            { cwd: process.cwd(), maxBuffer: 10 * 1024 * 1024 },
          );
          return stdout.trim() || stderr.trim() || "No changes.";
        } catch (error) {
          const e = error as Error & {
            stdout?: string;
            stderr?: string;
            code?: number | string;
          };
          return [
            \`exitCode: \${String(e.code ?? "unknown")}\`,
            e.stdout?.trim() ? \`stdout:\\n\${e.stdout.trim()}\` : "",
            e.stderr?.trim() ? \`stderr:\\n\${e.stderr.trim()}\` : "",
            e.message ? \`error:\\n\${e.message}\` : "",
          ]
            .filter((part) => part.length > 0)
            .join("\\n\\n");
        }
      },
    },
    {
      name: "websearch",
      description:
        "Search the web via Exa MCP. Returns search results as plain text.",
      inputSchema: withWhy({
        type: "object",
        properties: {
          query: { type: "string" },
          numResults: { type: "number" },
          livecrawl: {
            type: "string",
            enum: ["fallback", "preferred"],
          },
          type: {
            type: "string",
            enum: ["auto", "fast", "deep"],
          },
          contextMaxCharacters: { type: "number" },
        },
        required: ["query"],
      }),
      getCallStatusMessage(input: WebsearchInput) {
        return \`Searching the web for \${JSON.stringify(input.query)} \\u2014 why: \${input.why}\`;
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
    },
  ],
};
`;

export async function codewarperConfigExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export async function writeInitialCodewarperConfigIfMissing(
  filePath: string,
  starter: InitialCodewarperStarter,
): Promise<"created" | "exists"> {
  try {
    await access(filePath, constants.F_OK);
    return "exists";
  } catch {
    await writeFile(filePath, getInitialCodewarperTemplate(starter), "utf8");
    return "created";
  }
}

function getInitialCodewarperTemplate(starter: InitialCodewarperStarter): string {
  switch (starter) {
    case "empty":
      return EMPTY_CODEWARPER_TS;
    case "local_files":
      return LOCAL_FILES_CODEWARPER_TS;
    case "local_files_with_websearch":
      return LOCAL_FILES_WITH_WEBSEARCH_CODEWARPER_TS;
    case "all_config_options":
      return ALL_CONFIG_OPTIONS_CODEWARPER_TS;
    case "recommended_for_codewarper":
      return RECOMMENDED_FOR_CODEWARPER_TS;
  }
}
