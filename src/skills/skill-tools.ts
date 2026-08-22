import { readFile } from "node:fs/promises";
import { loadToolsWithValidators, type LoadedTool } from "../tools/loaded-tool.ts";
import type { Tool } from "../tools/types.ts";
import type { CodewarperSkill } from "./types.ts";

export const READ_SKILL_TOOL_NAME = "read_skill";

export function createSkillTools(skills: readonly CodewarperSkill[]): LoadedTool[] {
  const modelInvocableSkills = skills.filter((skill) => !skill.disableModelInvocation);
  if (modelInvocableSkills.length === 0) return [];
  const tool: Tool = {
    name: READ_SKILL_TOOL_NAME,
    description: "Read a configured Codewarper skill. Without `file`, reads the primary skill markdown and lists supporting files. With `file`, reads one supporting file by relative path.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "The skill name from the available_skills catalog." },
        file: { type: "string", description: "Optional supporting file path relative to the skill directory, such as references/api.md." },
      },
      required: ["name"],
      additionalProperties: false,
    },
    getCallStatusMessage(input) {
      const name = readSkillName(input);
      const file = readSkillFile(input);
      return `Reading skill ${name}${file ? ` file ${file}` : ""}`.trim();
    },
    async run(input) {
      const name = readSkillName(input);
      const skill = modelInvocableSkills.find((candidate) => candidate.name === name);
      if (!skill) throw new Error(`Unknown skill: ${name}`);
      const file = readSkillFile(input);
      return file ? formatSupportingFileForModel(skill, file) : formatSkillForModel(skill);
    },
  };
  return loadToolsWithValidators([tool]);
}

export function formatSkillForModel(skill: CodewarperSkill): string {
  const lines = [
    `# Skill: ${skill.name}`,
    `Description: ${skill.description}`,
    `File: ${skill.filePath}`,
    `Directory: ${skill.directoryPath}`,
    "",
    skill.content,
  ];

  if (skill.supportingMarkdownFiles.length > 0) {
    lines.push(
      "",
      "## Supporting files",
      "",
      "Load these only if needed with `read_skill` using the `file` argument:",
      ...skill.supportingMarkdownFiles.map((file) => `- ${file.relativePath}`),
    );
  }

  return lines.join("\n");
}

async function formatSupportingFileForModel(skill: CodewarperSkill, requestedFile: string): Promise<string> {
  const normalizedFile = normalizeRequestedFilePath(requestedFile);
  const file = skill.supportingMarkdownFiles.find((candidate) => candidate.relativePath === normalizedFile);
  if (!file) {
    const availableFiles = skill.supportingMarkdownFiles.map((candidate) => `- ${candidate.relativePath}`).join("\n");
    throw new Error(`Unknown supporting file for skill ${skill.name}: ${requestedFile}${availableFiles ? `\nAvailable files:\n${availableFiles}` : ""}`);
  }
  return [
    `# Skill: ${skill.name}`,
    `Supporting file: ${file.relativePath}`,
    `File: ${file.filePath}`,
    `Directory: ${skill.directoryPath}`,
    "",
    await readFile(file.filePath, "utf8"),
  ].join("\n");
}

function normalizeRequestedFilePath(filePath: string): string {
  return filePath.trim().replace(/\\/g, "/").replace(/^\.\//, "");
}

function readSkillName(input: unknown): string {
  const name = readObjectProperty(input, "name");
  return typeof name === "string" ? name.trim() : "";
}

function readSkillFile(input: unknown): string {
  const file = readObjectProperty(input, "file");
  return typeof file === "string" ? file.trim() : "";
}

function readObjectProperty(input: unknown, key: string): unknown {
  if (!isObjectRecord(input)) return undefined;
  return input[key];
}

function isObjectRecord(input: unknown): input is Readonly<Record<string, unknown>> {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}
