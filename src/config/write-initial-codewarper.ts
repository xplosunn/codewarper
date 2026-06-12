import { access, constants, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import * as emptyTemplate from "./templates/empty.js";
import * as localFilesTemplate from "./templates/local_files.js";
import * as localFilesWithWebsearchTemplate from "./templates/local_files_with_websearch.js";
import * as allConfigOptionsTemplate from "./templates/all_config_options.js";
import * as recommendedForCodewarperTemplate from "./templates/recommended_for_codewarper.js";

export type InitialCodewarperStarter =
  | "empty"
  | "local_files"
  | "local_files_with_websearch"
  | "all_config_options"
  | "recommended_for_codewarper";

export interface InitialCodewarperStarterOption {
  id: InitialCodewarperStarter;
  label: string;
}

export const INITIAL_CODEWARPER_STARTER_OPTIONS: InitialCodewarperStarterOption[] = [
  {
    id: "empty",
    label: "Empty: create a blank Codewarper config with no tools",
  },
  {
    id: "local_files",
    label: "Local files: list directories, read files, write files, and delete files",
  },
  {
    id: "local_files_with_websearch",
    label: "Local files + web search: local file tools plus Exa-backed web search",
  },
  {
    id: "all_config_options",
    label:
      "Showcase all config options: systemPrompt, tools, commands, hooks (onProviderRequest, onProviderResponse)",
  },
  {
    id: "recommended_for_codewarper",
    label:
      "Recommended for working on Codewarper itself: full set of development tools including pnpm test, grep, git review, and web search",
  },
];

const TEMPLATE_FILES: Record<InitialCodewarperStarter, string> = {
  empty: "empty.js",
  local_files: "local_files.js",
  local_files_with_websearch: "local_files_with_websearch.js",
  all_config_options: "all_config_options.js",
  recommended_for_codewarper: "recommended_for_codewarper.js",
};

function templateDir(): string {
  return path.dirname(fileURLToPath(import.meta.url));
}

export async function codewarperConfigExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export async function writeInitialCodewarperConfigIfMissing(
  filePath: string,
  starter: InitialCodewarperStarter,
): Promise<"created" | "exists"> {
  try {
    await access(filePath, constants.F_OK);
    return "exists";
  } catch {
    await writeFile(filePath, await getInitialCodewarperTemplateSource(starter), "utf8");
    return "created";
  }
}

export async function getInitialCodewarperTemplateSource(starter: InitialCodewarperStarter): Promise<string> {
  const templatePath = path.join(templateDir(), "templates", TEMPLATE_FILES[starter]);
  return readFile(templatePath, "utf8");
}

export function getInitialCodewarperTemplateConfig(starter: InitialCodewarperStarter): { default?: unknown } {
  switch (starter) {
    case "empty": return emptyTemplate;
    case "local_files": return localFilesTemplate;
    case "local_files_with_websearch": return localFilesWithWebsearchTemplate;
    case "all_config_options": return allConfigOptionsTemplate;
    case "recommended_for_codewarper": return recommendedForCodewarperTemplate;
  }
}
