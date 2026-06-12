import { access, constants } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { Context, Effect } from "#effect";
import type { Environment } from "../providers/services.ts";
import { loadToolsWithValidators, type LoadedTool } from "../tools/loaded-tool.ts";
import { isJsonValue } from "../tools/json-value.ts";
import type { Tool } from "../tools/types.ts";

const CONFIG_FILENAME = "codewarper.js";
export const CODEWARPER_CONFIG_ENV_VAR = "CODEWARPER_CONFIG";

export type CodewarperCommand = {
  name: string;
  description: string;
  run: (args: string[]) => Promise<string> | string;
};

export type ProviderRequestCallback = (request: Request) => Promise<void> | void;
export type ProviderResponseCallback = (request: Request, response: Response) => Promise<void> | void;

export interface CodewarperHooks {
  onProviderRequest: ProviderRequestCallback | null;
  onProviderResponse: ProviderResponseCallback | null;
}

export interface CodewarperConfig {
  tools: LoadedTool[];
  commands: CodewarperCommand[];
  systemPrompt: string | null;
  hooks: CodewarperHooks | null;
}

export interface CodewarperConfigLoader {
  path(): string;
  current(): CodewarperConfig;
  load(): Effect<CodewarperConfig, Error>;
  setCurrent(config: CodewarperConfig): void;
}

export class CodewarperConfigService extends Context.Tag("codewarper/CodewarperConfigService")<
  CodewarperConfigService,
  CodewarperConfigLoader
>() {}

export function createCodewarperConfigLoader(environment: Environment): CodewarperConfigLoader {
  let currentConfig = emptyCodewarperConfig();
  const currentPath = computeConfigPath(environment);

  return {
    path: () => currentPath,
    current: () => currentConfig,
    load: () =>
      loadCodewarperConfigFromPath(currentPath).pipe(
        Effect.tap((loaded) => Effect.sync(() => { currentConfig = loaded; })),
      ),
    setCurrent: (config) => { currentConfig = config; },
  };
}

function computeConfigPath(environment: Environment): string {
  const override = environment.get(CODEWARPER_CONFIG_ENV_VAR)?.trim();
  if (override) return path.resolve(process.cwd(), override);
  return path.join(process.cwd(), CONFIG_FILENAME);
}

function validateHooks(raw: unknown): CodewarperHooks | null {
  if (typeof raw === "undefined" || raw === null) return null;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("Codewarper config hooks must be an object when provided.");
  }
  const hooks = raw as Record<string, unknown>;

  const onProviderRequestUnknown = hooks.onProviderRequest;
  if (typeof onProviderRequestUnknown !== "undefined" && typeof onProviderRequestUnknown !== "function") {
    throw new Error("Codewarper config hooks.onProviderRequest must be a function when provided.");
  }

  const onProviderResponseUnknown = hooks.onProviderResponse;
  if (typeof onProviderResponseUnknown !== "undefined" && typeof onProviderResponseUnknown !== "function") {
    throw new Error("Codewarper config hooks.onProviderResponse must be a function when provided.");
  }

  return {
    onProviderRequest: typeof onProviderRequestUnknown === "function"
      ? onProviderRequestUnknown as ProviderRequestCallback
      : null,
    onProviderResponse: typeof onProviderResponseUnknown === "function"
      ? onProviderResponseUnknown as ProviderResponseCallback
      : null,
  };
}

export function loadCodewarperConfigFromPath(filePath: string): Effect<CodewarperConfig, Error> {
  return Effect.tryPromise({
    try: async () => {
      try {
        await access(filePath, constants.F_OK);
      } catch {
        return emptyCodewarperConfig();
      }

      const url = cacheBustedFileUrl(filePath);
      const mod = (await import(url)) as { default?: unknown };
      return parseConfigModule(mod, filePath);
    },
    catch: (e) => (e instanceof Error ? e : new Error(String(e))),
  });
}

export function parseConfigModule(mod: { default?: unknown }, label: string): CodewarperConfig {
  const def = mod.default;
  if (!def || typeof def !== "object") {
    throw new Error(`Codewarper config ${label} must default-export an object.`);
  }

  const toolsUnknown = (def as { tools?: unknown }).tools;
  if (typeof toolsUnknown !== "undefined" && !Array.isArray(toolsUnknown)) {
    throw new Error(`Codewarper config ${label} must use tools: Tool[] when provided.`);
  }
  const systemPromptUnknown = (def as { systemPrompt?: unknown }).systemPrompt;
  if (typeof systemPromptUnknown !== "undefined" && typeof systemPromptUnknown !== "string") {
    throw new Error(`Codewarper config ${label} must use a string for systemPrompt when provided.`);
  }

  const hooksUnknown = (def as { hooks?: unknown }).hooks;
  const hooks = validateHooks(hooksUnknown);

  const commandsUnknown = (def as { commands?: unknown }).commands;
  const tools = validateToolsArray(toolsUnknown ?? []);
  const commands = validateCommands(commandsUnknown);
  return {
    tools: loadToolsWithValidators(tools),
    commands,
    systemPrompt: typeof systemPromptUnknown === "string" ? systemPromptUnknown : null,
    hooks,
  };
}

function cacheBustedFileUrl(filePath: string): string {
  const url = new URL(pathToFileURL(filePath));
  url.searchParams.set("t", `${Date.now()}-${Math.random().toString(36).slice(2)}`);
  return url.href;
}

function emptyCodewarperConfig(): CodewarperConfig {
  return {
    tools: [],
    commands: [],
    systemPrompt: null,
    hooks: null,
  };
}

function validateCommands(commandsUnknown: unknown): CodewarperCommand[] {
  if (typeof commandsUnknown === "undefined") return [];
  if (!commandsUnknown || typeof commandsUnknown !== "object" || Array.isArray(commandsUnknown)) {
    throw new Error("commands must be an object when provided.");
  }

  const commands: CodewarperCommand[] = [];
  const commandNamePattern = /^[a-zA-Z][a-zA-Z0-9_-]*$/;
  for (const [name, raw] of Object.entries(commandsUnknown)) {
    if (!commandNamePattern.test(name)) {
      throw new Error(`commands.${name} must use a name matching ${commandNamePattern}.`);
    }
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error(`commands.${name} must be an object.`);
    }
    const command = raw as Record<string, unknown>;
    if (typeof command.description !== "string" || !command.description.trim()) {
      throw new Error(`commands.${name}.description must be a non-empty string.`);
    }
    if (typeof command.run !== "function") {
      throw new Error(`commands.${name}.run must be a function.`);
    }
    commands.push({ name, description: command.description, run: command.run as CodewarperCommand["run"] });
  }
  return commands;
}

function validateToolsArray(toolsUnknown: unknown[]): Tool[] {
  const tools: Tool[] = [];
  const seenNames = new Set<string>();
  for (let i = 0; i < toolsUnknown.length; i++) {
    const raw = toolsUnknown[i];
    if (!raw || typeof raw !== "object") throw new Error(`tools[${i}] must be an object.`);
    const t = raw as Record<string, unknown>;
    if (typeof t.name !== "string" || !t.name.trim()) throw new Error(`tools[${i}].name must be a non-empty string.`);
    const trimmedName = t.name.trim();
    if (seenNames.has(trimmedName)) throw new Error(`Duplicate tool name "${trimmedName}".`);
    seenNames.add(trimmedName);
    if (typeof t.description !== "string") throw new Error(`tools[${i}].description must be a string.`);
    if (!t.inputSchema || typeof t.inputSchema !== "object" || Array.isArray(t.inputSchema) || !isJsonValue(t.inputSchema)) {
      throw new Error(`tools[${i}].inputSchema must be a JSON-serializable object.`);
    }
    if (typeof t.getCallStatusMessage !== "function") throw new Error(`tools[${i}].getCallStatusMessage must be a function.`);
    if (typeof t.run !== "function") throw new Error(`tools[${i}].run must be a function.`);
    tools.push({
      name: trimmedName,
      description: t.description,
      inputSchema: t.inputSchema as Tool["inputSchema"],
      getCallStatusMessage: t.getCallStatusMessage as Tool["getCallStatusMessage"],
      run: t.run as Tool["run"],
    });
  }
  return tools;
}
