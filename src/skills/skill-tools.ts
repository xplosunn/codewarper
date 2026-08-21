import path from "node:path";
import { loadToolsWithValidators, type LoadedTool } from "../tools/loaded-tool.ts";
import type { Tool } from "../tools/types.ts";
import type { CodewarperSkill } from "./types.ts";

export const READ_SKILL_TOOL_NAME = "read_skill";

export function createSkillTools(skills: readonly CodewarperSkill[]): LoadedTool[] {
  const modelInvocableSkills = skills.filter((skill) => !skill.disableModelInvocation);
  if (modelInvocableSkills.length === 0) return [];
  const tool: Tool = {
    name: READ_SKILL_TOOL_NAME,
    description: "Read the full markdown instructions for a configured Codewarper skill by name.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "The skill name from the available_skills catalog." },
      },
      required: ["name"],
      additionalProperties: false,
    },
    getCallStatusMessage(input) {
      return `Reading skill ${readSkillName(input)}`.trim();
    },
    async run(input) {
      const name = readSkillName(input);
      const skill = modelInvocableSkills.find((candidate) => candidate.name === name);
      if (!skill) throw new Error(`Unknown skill: ${name}`);
      return [
        `# Skill: ${skill.name}`,
        `Description: ${skill.description}`,
        `File: ${skill.filePath}`,
        `Directory: ${path.dirname(skill.filePath)}`,
        "",
        skill.content,
      ].join("\n");
    },
  };
  return loadToolsWithValidators([tool]);
}

function readSkillName(input: unknown): string {
  const name = readObjectProperty(input, "name");
  return typeof name === "string" ? name.trim() : "";
}

function readObjectProperty(input: unknown, key: string): unknown {
  if (!isObjectRecord(input)) return undefined;
  return input[key];
}

function isObjectRecord(input: unknown): input is Readonly<Record<string, unknown>> {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}
