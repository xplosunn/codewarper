export interface CodewarperSkill {
  /** Invocation/catalog name. */
  name: string;
  description: string;
  filePath: string;
  content: string;
  disableModelInvocation: boolean;
  /** Parsed but not currently enforced. */
  allowedTools: string[];
}
