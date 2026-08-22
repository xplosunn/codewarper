import type { CodewarperSkill } from "./types.ts";

export function appendSkillGuidanceToSystemPrompt(base: string, skills: readonly CodewarperSkill[]): string {
  const visibleSkills = skills.filter((skill) => !skill.disableModelInvocation);
  if (visibleSkills.length === 0) return base;

  const lines = [
    base,
    "",
    "## Codewarper skills",
    "",
    "This project has configured skills. A skill is a directory package with a primary SKILL.md file.",
    "When a task matches a skill description, call the `read_skill` tool with the skill name, then follow the loaded instructions.",
    "The loaded skill may list supporting files. Read only the files you need by calling `read_skill` again with the `file` argument.",
    "When skill instructions reference relative paths, resolve them relative to the skill directory.",
    "",
    "<available_skills>",
  ];

  for (const skill of visibleSkills) {
    lines.push("  <skill>");
    lines.push(`    <name>${escapeXml(skill.name)}</name>`);
    lines.push(`    <description>${escapeXml(skill.description)}</description>`);
    lines.push(`    <location>${escapeXml(skill.filePath)}</location>`);
    lines.push("  </skill>");
  }

  lines.push("</available_skills>");
  return lines.join("\n");
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
