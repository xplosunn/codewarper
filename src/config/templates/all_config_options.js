/**
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
// Utilities
// ---------------------------------------------------------------------------

/** Resolve a path relative to the workspace root, rejecting paths that escape it. */
function resolveWorkspacePath(inputPath) {
  const cwd = process.cwd();
  const resolved = path.resolve(cwd, inputPath);
  if (resolved !== cwd && !resolved.startsWith(cwd + path.sep)) {
    throw new Error(`Path is outside the current working directory: ${inputPath}`);
  }
  return resolved;
}

/** Call the Exa MCP web search API. */
async function exaCall(tool, args, timeoutMs) {
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
      throw new Error(`Exa MCP request failed: ${response.status} ${response.statusText}`);
    }
    const body = await response.text();
    for (const line of body.split("\n")) {
      if (!line.startsWith("data: ")) continue;
      const parsed = JSON.parse(line.slice(6));
      const text = parsed.result?.content?.[0]?.text;
      if (text) return text;
    }
    try {
      const parsed = JSON.parse(body);
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
  ].join("\n"),

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
      getCallStatusMessage(input) {
        return `Listing directory ${input.dirPath ?? "."}`;
      },
      async run(input) {
        const names = await readdir(resolveWorkspacePath(input.dirPath ?? "."));
        return names.join("\n");
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
      getCallStatusMessage(input) {
        return `Reading file ${input.filePath}`;
      },
      async run(input) {
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
      getCallStatusMessage(input) {
        return `Writing file ${input.filePath}`;
      },
      async run(input) {
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
      getCallStatusMessage(input) {
        return `Deleting file ${input.filePath}`;
      },
      async run(input) {
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
            description: "Regex to filter file paths (e.g. '\\.ts$')",
          },
          maxResults: {
            type: "number",
            description: "Maximum matching lines to return (default 50)",
          },
        },
        required: ["pattern"],
        additionalProperties: false,
      },
      getCallStatusMessage(input) {
        return `Searching for ${JSON.stringify(input.pattern)}`;
      },
      async run(input) {
        const dir = resolveWorkspacePath(input.dirPath ?? ".");
        const max = Math.min(input.maxResults ?? 50, 200);
        try {
          const { stdout } = await execFileAsync("grep", [
            "-rn",
            "-e",
            input.pattern,
            dir,
          ], { maxBuffer: 2 * 1024 * 1024, timeout: 15_000 });
          let lines = stdout.split("\n").filter((l) => l.length > 0);
          if (input.filePattern) {
            const fileRegex = new RegExp(input.filePattern);
            lines = lines.filter((l) => fileRegex.test(l));
          }
          const truncated = lines.slice(0, max);
          let result = truncated.join("\n");
          if (lines.length > max) {
            result += `\n... (${lines.length - max} more matches)`;
          }
          return result || "No matches found.";
        } catch (e) {
          const err = e;
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
      getCallStatusMessage(input) {
        return `Searching the web for ${JSON.stringify(input.query)}`;
      },
      async run(input) {
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
  //   async run(args) — The handler; its return value is printed
  commands: {
    changed_files: {
      description:
        "Show files changed from HEAD. Pass git diff args after the command, e.g. /changed_files --staged",
      async run(args) {
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
    onProviderRequest(request) {
      console.log(`[Provider Request] ${request.method} ${request.url}`);
    },

    // Called after every response from the LLM provider.  Use it for logging,
    // usage tracking, or inspecting the Response.
    // Return void or a Promise<void>.
    onProviderResponse(request, response) {
      console.log(`[Provider Response] ${response.status} ${response.statusText}`);
    },
  },
};
