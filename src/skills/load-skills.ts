import { readdir, readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { CodewarperSkill } from "./types.ts";

const MAX_NAME_LENGTH = 64;
const MAX_DESCRIPTION_LENGTH = 1024;
export async function loadSkillsFromDirectories(skillDirectories: readonly string[]): Promise<CodewarperSkill[]> {
  const skills: CodewarperSkill[] = [];
  const seenNames = new Set<string>();
  for (const rawDir of skillDirectories) {
    const dir = resolveConfiguredPath(rawDir);
    const files = await discoverMarkdownFiles(dir);
    for (const filePath of files) {
      const skill = await loadSkillFromMarkdownFile(filePath);
      if (seenNames.has(skill.name)) {
        throw new Error(`Duplicate skill name "${skill.name}" from ${filePath}.`);
      }
      seenNames.add(skill.name);
      skills.push(skill);
    }
  }
  return skills;
}

function resolveConfiguredPath(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) throw new Error("skillDirectories entries must be non-empty strings.");
  if (trimmed === "~") return os.homedir();
  if (trimmed.startsWith(`~${path.sep}`) || trimmed.startsWith("~/")) {
    return path.join(os.homedir(), trimmed.slice(2));
  }
  return path.resolve(process.cwd(), trimmed);
}

async function discoverMarkdownFiles(root: string): Promise<string[]> {
  const rootStat = await stat(root).catch((error: unknown) => {
    if (isNotFoundError(error)) return null;
    throw error;
  });
  if (rootStat === null) return [];
  if (!rootStat.isDirectory()) throw new Error(`skillDirectories entry is not a directory: ${root}`);

  const files: string[] = [];
  await walk(root, files);
  files.sort();
  return files;
}

async function walk(dir: string, files: string[]): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true });

  const skillFile = entries.find((entry) => entry.isFile() && entry.name === "SKILL.md");
  if (skillFile) {
    // Treat a directory containing SKILL.md as a skill package root. Supporting
    // markdown under references/, docs/, etc. is not independently loaded as a skill.
    files.push(path.join(dir, skillFile.name));
    return;
  }

  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name === ".git") continue;
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await walk(fullPath, files);
      continue;
    }
    if (entry.isFile() && isMarkdownFile(entry.name)) files.push(fullPath);
  }
}

function isMarkdownFile(fileName: string): boolean {
  return fileName.toLowerCase().endsWith(".md");
}

async function loadSkillFromMarkdownFile(filePath: string): Promise<CodewarperSkill> {
  const content = await readFile(filePath, "utf8");
  const { frontmatter } = parseFrontmatter(content, filePath);
  // Keep loading compatible with skill files from other agents: validate the
  // fields Codewarper uses, but ignore unknown frontmatter keys.
  const name = readOptionalString(frontmatter, "name") ?? defaultNameFromFilePath(filePath);
  validateName(name, filePath);
  const description = readRequiredString(frontmatter, "description", filePath);
  validateDescription(description, filePath);

  return {
    name,
    description,
    filePath,
    content,
    disableModelInvocation: readOptionalBoolean(frontmatter, "disable-model-invocation", filePath) ?? false,
    allowedTools: readAllowedTools(frontmatter["allowed-tools"], filePath),
  };
}

function parseFrontmatter(content: string, filePath: string): { frontmatter: Record<string, unknown> } {
  const lines = content.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") {
    throw new Error(`Skill ${filePath} must start with YAML frontmatter delimited by ---.`);
  }
  const end = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
  if (end === -1) throw new Error(`Skill ${filePath} is missing closing frontmatter delimiter ---.`);
  const frontmatterLines = lines.slice(1, end);
  if (frontmatterLines.length === 0) throw new Error(`Skill ${filePath} frontmatter must not be empty.`);
  return { frontmatter: parseSimpleYaml(frontmatterLines, filePath) };
}

function parseSimpleYaml(lines: string[], filePath: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i];
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    if (/^\s/.test(rawLine)) throw new Error(`Skill ${filePath} has unsupported nested frontmatter at line ${i + 2}.`);

    const colon = rawLine.indexOf(":");
    if (colon === -1) throw new Error(`Skill ${filePath} has invalid frontmatter at line ${i + 2}: ${rawLine}`);
    const key = rawLine.slice(0, colon).trim();
    const valueText = stripInlineComment(rawLine.slice(colon + 1).trim());
    if (!key) throw new Error(`Skill ${filePath} has empty frontmatter key at line ${i + 2}.`);

    if (valueText === "|" || valueText === ">") {
      const collected: string[] = [];
      while (i + 1 < lines.length && isIndentedContentLine(lines[i + 1])) {
        i++;
        collected.push(removeCommonYamlIndent(lines[i]));
      }
      result[key] = valueText === ">" ? collected.map((line) => line.trim()).join(" ").trim() : collected.join("\n").trimEnd();
      continue;
    }

    if (valueText === "") {
      const collected: string[] = [];
      let sawNested = false;
      while (i + 1 < lines.length && isIndentedContentLine(lines[i + 1])) {
        i++;
        sawNested = true;
        const nested = lines[i].trim();
        if (nested.startsWith("- ")) collected.push(nested.slice(2).trim());
      }
      result[key] = collected.length > 0 ? collected : sawNested ? {} : "";
      continue;
    }

    result[key] = parseScalar(valueText);
  }
  return result;
}

function isIndentedContentLine(line: string): boolean {
  return line.trim() === "" || /^\s+/.test(line);
}

function removeCommonYamlIndent(line: string): string {
  if (line.startsWith("  ")) return line.slice(2);
  if (line.startsWith("\t")) return line.slice(1);
  return line.trimStart();
}

function stripInlineComment(value: string): string {
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if ((ch === '"' || ch === "'") && (i === 0 || value[i - 1] !== "\\")) {
      quote = quote === ch ? null : quote === null ? ch : quote;
      continue;
    }
    if (ch === "#" && quote === null && (i === 0 || /\s/.test(value[i - 1]))) {
      return value.slice(0, i).trimEnd();
    }
  }
  return value;
}

function parseScalar(value: string): unknown {
  if (value === "") return "";
  if (value === "true") return true;
  if (value === "false") return false;
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  if (value.startsWith("[") && value.endsWith("]")) {
    const inner = value.slice(1, -1).trim();
    if (!inner) return [];
    return inner.split(",").map((part) => String(parseScalar(part.trim())));
  }
  return value;
}

function defaultNameFromFilePath(filePath: string): string {
  const base = path.basename(filePath, path.extname(filePath));
  if (base.toLowerCase() === "skill") return path.basename(path.dirname(filePath));
  return base;
}

function readRequiredString(frontmatter: Record<string, unknown>, key: string, filePath: string): string {
  const value = readOptionalString(frontmatter, key);
  if (value === undefined || !value.trim()) throw new Error(`Skill ${filePath} frontmatter.${key} must be a non-empty string.`);
  return value.trim();
}

function readOptionalString(frontmatter: Record<string, unknown>, key: string): string | undefined {
  const value = frontmatter[key];
  if (typeof value === "undefined") return undefined;
  return typeof value === "string" ? value : undefined;
}

function readOptionalBoolean(frontmatter: Record<string, unknown>, key: string, filePath: string): boolean | undefined {
  const value = frontmatter[key];
  if (typeof value === "undefined") return undefined;
  if (typeof value !== "boolean") throw new Error(`Skill ${filePath} frontmatter.${key} must be a boolean.`);
  return value;
}

function readAllowedTools(value: unknown, filePath: string): string[] {
  if (typeof value === "undefined" || value === null || value === "") return [];
  if (typeof value === "string") return value.split(/[\s,]+/).map((tool) => tool.trim()).filter(Boolean);
  if (Array.isArray(value) && value.every((item) => typeof item === "string")) return value;
  throw new Error(`Skill ${filePath} frontmatter.allowed-tools must be a string or string array.`);
}

function validateName(name: string, filePath: string): void {
  if (!name.trim()) throw new Error(`Skill ${filePath} name must be non-empty.`);
  if (name.length > MAX_NAME_LENGTH) throw new Error(`Skill ${filePath} name exceeds ${MAX_NAME_LENGTH} characters.`);
  if (!/^[a-z0-9-]+$/.test(name)) throw new Error(`Skill ${filePath} name must use lowercase letters, numbers, and hyphens only.`);
  if (name.startsWith("-") || name.endsWith("-") || name.includes("--")) {
    throw new Error(`Skill ${filePath} name must not start/end with hyphen or contain consecutive hyphens.`);
  }
}

function validateDescription(description: string, filePath: string): void {
  if (description.length > MAX_DESCRIPTION_LENGTH) throw new Error(`Skill ${filePath} description exceeds ${MAX_DESCRIPTION_LENGTH} characters.`);
}

function isNotFoundError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
