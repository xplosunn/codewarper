/**
 * Codewarper config tailored for working on the Codewarper project itself.
 * Tools and commands run with your local user permissions.
 * After editing this file, run /reload in codewarper to pick up changes.
 */
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

/** Add `why` (required, string) to a JSON Schema object. */
function withWhy(schema) {
  return {
    ...schema,
    properties: { ...(schema.properties ?? {}), why: { type: "string" } },
    required: [...(schema.required ?? []), "why"],
    additionalProperties: false,
  };
}

function resolveUnderCwd(p) {
  return path.resolve(process.cwd(), p);
}

async function listDirRecursive(dir, base = dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const names = [];
  for (const entry of entries) {
    const entryPath = path.join(dir, entry.name);
    names.push(path.relative(base, entryPath) || entry.name);
    if (entry.isDirectory()) {
      names.push(...(await listDirRecursive(entryPath, base)));
    }
  }
  return names;
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

async function runPnpmScript(script) {
  try {
    const { stdout, stderr } = await execFileAsync("pnpm", ["run", script], {
      cwd: process.cwd(),
      maxBuffer: 10 * 1024 * 1024,
    });
    return [
      "exitCode: 0",
      stdout.trim() ? `stdout:\n${stdout.trim()}` : "",
      stderr.trim() ? `stderr:\n${stderr.trim()}` : "",
    ]
      .filter((part) => part.length > 0)
      .join("\n\n");
  } catch (error) {
    const e = error;
    return [
      `exitCode: ${String(e.code ?? "unknown")}`,
      e.stdout?.trim() ? `stdout:\n${e.stdout.trim()}` : "",
      e.stderr?.trim() ? `stderr:\n${e.stderr.trim()}` : "",
      e.message ? `error:\n${e.message}` : "",
    ]
      .filter((part) => part.length > 0)
      .join("\n\n");
  }
}

export default {
  systemPrompt: [
    "You are a concise coding assistant. Help with code, debugging, design, and implementation details.",
    "Be practical and direct.",
    "Use tools to discover the project and help the user. Always start by gathering real information before giving an answer.",
    "Summarize your answer. The user has a short attention span.",
  ].join("\n"),
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
    edit: {
      description:
        "Open Zed. Pass files/directories to open, or omit args to open the project root.",
      async run(args) {
        const openArgs = args.length > 0 ? args : ["."];
        const child = spawn("zeditor", openArgs, {
          cwd: process.cwd(),
          detached: true,
          stdio: "ignore",
        });
        child.unref();
        return `Started Zed: zed ${openArgs.join(" ")}`;
      },
    },
  },
  tools: [
    {
      name: "list_dir",
      description:
        "List file and directory names in a directory. Defaults to `.` when omitted. Set `recursive` to true to include nested entries.",
      inputSchema: withWhy({
        type: "object",
        properties: {
          dirPath: { type: "string" },
          recursive: { type: "boolean" },
        },
        required: [],
      }),
      getCallStatusMessage(input) {
        return `Listing directory ${input.dirPath ?? "."}${input.recursive ? " recursively" : ""} — why: ${input.why}`;
      },
      async run(input) {
        const dirPath = input.dirPath ?? ".";
        const fullPath = resolveUnderCwd(dirPath);
        if (input.recursive) {
          const names = await listDirRecursive(fullPath);
          return names.join("\n");
        }
        const names = await readdir(fullPath);
        return names.join("\n");
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
      getCallStatusMessage(input) {
        return `Reading file ${input.filePath} — why: ${input.why}`;
      },
      async run(input) {
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
      getCallStatusMessage(input) {
        return `Writing file ${input.filePath} — why: ${input.why}`;
      },
      async run(input) {
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
      getCallStatusMessage(input) {
        return `Deleting file ${input.filePath} — why: ${input.why}`;
      },
      async run(input) {
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
      getCallStatusMessage(input) {
        return `Searching for ${JSON.stringify(input.pattern)} in ${input.dirPath} — why: ${input.why}`;
      },
      async run(input) {
        const dir = resolveUnderCwd(input.dirPath);
        const entries = await readdir(dir, { withFileTypes: true });
        const matchedFiles = [];
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
        return matchedFiles.join("\n");
      },
    },
    {
      name: "grep",
      description:
        "Recursively search for a regex pattern in files using `grep -rn`, showing matching lines with file paths and line numbers. Use `filePattern` to filter by file name/extension (e.g. '\\.ts$' for TypeScript files).",
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
              "Optional regex to filter matching output by file path (e.g. '\\.ts:' for TypeScript files).",
          },
          maxResults: {
            type: "number",
            description: "Maximum number of matching lines to return. Defaults to 50.",
          },
        },
        required: ["pattern"],
      }),
      getCallStatusMessage(input) {
        return `Grep for ${JSON.stringify(input.pattern)} in ${input.dirPath ?? "."}${input.filePattern ? ` (output paths matching: ${input.filePattern})` : ""} — why: ${input.why}`;
      },
      async run(input) {
        const dir = resolveUnderCwd(input.dirPath ?? ".");
        const max = Math.min(input.maxResults ?? 50, 200);
        const args = ["-rn", "-e", input.pattern, dir];

        try {
          const { stdout } = await execFileAsync("grep", args, {
            maxBuffer: 2 * 1024 * 1024,
            timeout: 15_000,
          });
          let lines = stdout.split("\n").filter((line) => line.length > 0);
          if (input.filePattern) {
            const fileRegex = new RegExp(input.filePattern);
            lines = lines.filter((line) => fileRegex.test(line));
          }
          const truncated = lines.slice(0, max);
          let result = truncated.join("\n");
          if (lines.length > max) {
            result += `\n... (${lines.length - max} more matches truncated. Narrow your pattern or use filePattern.)`;
          }
          return result || "No matches found.";
        } catch (error) {
          const e = error;
          if (e.code === 1) {
            return "No matches found.";
          }
          return [
            `exitCode: ${String(e.code ?? "unknown")}`,
            e.stderr?.trim() ? `stderr:\n${e.stderr.trim()}` : "",
            e.message ? `error:\n${e.message}` : "",
          ]
            .filter((part) => part.length > 0)
            .join("\n\n");
        }
      },
    },
    {
      name: "run_pnpm_test",
      description:
        "Run `pnpm run test` in the working directory and return stdout/stderr plus the exit status.",
      inputSchema: withWhy({
        type: "object",
        properties: {},
        required: [],
      }),
      getCallStatusMessage(input) {
        return `Running pnpm run test — why: ${input.why}`;
      },
      async run(input) {
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
      getCallStatusMessage(input) {
        return `Reviewing git diff HEAD — why: ${input.why}`;
      },
      async run(input) {
        try {
          const { stdout, stderr } = await execFileAsync(
            "git",
            ["diff", "HEAD"],
            { cwd: process.cwd(), maxBuffer: 10 * 1024 * 1024 },
          );
          return stdout.trim() || stderr.trim() || "No changes.";
        } catch (error) {
          const e = error;
          return [
            `exitCode: ${String(e.code ?? "unknown")}`,
            e.stdout?.trim() ? `stdout:\n${e.stdout.trim()}` : "",
            e.stderr?.trim() ? `stderr:\n${e.stderr.trim()}` : "",
            e.message ? `error:\n${e.message}` : "",
          ]
            .filter((part) => part.length > 0)
            .join("\n\n");
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
      getCallStatusMessage(input) {
        return `Searching the web for ${JSON.stringify(input.query)} — why: ${input.why}`;
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
