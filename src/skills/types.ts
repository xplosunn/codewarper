export interface CodewarperSkillMarkdownFile {
  /** Path relative to the skill package directory. */
  relativePath: string;
  filePath: string;
}

export interface CodewarperSkill {
  /** Invocation/catalog name. */
  name: string;
  description: string;
  /** Primary markdown file, usually SKILL.md for packaged skills. */
  filePath: string;
  /** Directory used to resolve relative references in skill instructions. */
  directoryPath: string;
  content: string;
  /** Additional markdown files that belong to the same skill package. */
  supportingMarkdownFiles: CodewarperSkillMarkdownFile[];
  disableModelInvocation: boolean;
  /** Parsed but not currently enforced. */
  allowedTools: string[];
}
