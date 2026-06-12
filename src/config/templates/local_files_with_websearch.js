/**
 * Codewarper config.
 * Tools and commands run with your local user permissions.
 * After editing this file, run /reload in codewarper to pick up changes.
 */
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

function resolveWorkspacePath(inputPath) {
  const cwd = process.cwd();
  const resolved = path.resolve(cwd, inputPath);

  if (resolved !== cwd && !resolved.startsWith(cwd + path.sep)) {
    throw new Error(`Path is outside the current working directory: ${inputPath}`);
  }

  return resolved;
}

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
        params: {
          name: tool,
          arguments: args,
        },
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
      getCallStatusMessage(input) {
        return `Listing directory ${input.dirPath ?? "."}`;
      },
      async run(input) {
        const dirPath = input.dirPath ?? ".";
        const names = await readdir(resolveWorkspacePath(dirPath));
        return names.join("\n");
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
      getCallStatusMessage(input) {
        return `Reading file ${input.filePath}`;
      },
      async run(input) {
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
        properties: {
          filePath: { type: "string" },
        },
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
};
