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
  ],
};
