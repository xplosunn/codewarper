import { readdir, readFile } from "node:fs/promises";
import { Effect } from "effect";
import { CodewarperConfigService } from "../config/load-codewarper.ts";
import {
  ALL_CONFIG_OPTIONS_CODEWARPER_TS,
  codewarperConfigExists,
  INITIAL_CODEWARPER_STARTER_OPTIONS,
  type InitialCodewarperStarter,
  writeInitialCodewarperConfigIfMissing,
} from "../config/write-initial-codewarper.ts";
import {
  normalizeTailoredCodewarperPlan,
  renderTailoredCodewarperConfig,
  type TailoredCodewarperPlan,
  writeTailoredCodewarperConfigIfMissing,
} from "../config/write-tailored-codewarper.ts";
import { PreferencesStoreService } from "../persistence/preferences-service.ts";
import type { PreferencesStore, ProviderSelectionPreference } from "../persistence/preferences-store.ts";
import type { Message, Provider, ProviderOption, ProviderOptionChoice, ProviderRequirements, ProviderSelection } from "../providers/index.ts";
import { ModelProvidersService } from "../providers/index.ts";
import { TerminalService, type SelectOption, type Terminal } from "../providers/services.ts";
import { step } from "../step/index.ts";
import type { SessionConfiguration } from "../step/index.ts";
import type { StepRequirements } from "../step/services.ts";
import type { LoadedTool } from "../tools/loaded-tool.ts";
import { appendToolGuidanceToSystemPrompt } from "../tools/tool-system-prompt.ts";
import { parseUserInput } from "./input.ts";
import type { App, LoopResult, UserInput } from "./types.ts";
import { bannerContent } from "./banner-content.ts";

const SYSTEM_PROMPT = [
  "You are Codewarper, a concise coding assistant working in the user's current project.",
  "Focus on this repository's code, conventions, and existing architecture when helping with code, debugging, design, or implementation details.",
  "Use tools to gather context, proactively use them to inspect before replying.",
  "Be practical and direct.",
].join("\n");

const AI_INIT_SYSTEM_PROMPT = [
  "Return a JSON config plan for a Codewarper config.",
  "Shape: {\"summary\":\"...\",\"systemPrompt\":null,\"toolset\":\"none|workspace_files|workspace_files_with_websearch\",\"commands\":[{\"name\":\"...\",\"description\":\"...\",\"command\":\"...\",\"args\":[\"..\"],\"timeoutMs\":120000}],\"notes\":[\"...\"]}.",
  "Base your plan on the template shown in the user message.",
].join("\n");

const BUILT_IN_COMMANDS_HELP = ["/help", "/quit", "/exit", "/model", "/login", "/init", "/reload"];
const AUTH_STATUS_KEY = "codewarperAuthStatus";
const MAX_AI_INIT_TOP_LEVEL_ENTRIES = 80;
const MAX_AI_INIT_CONTEXT_FILE_CHARS = 4_000;
const AI_INIT_IGNORED_NAMES = new Set([
  ".git",
  "node_modules",
  "vendor",
  "dist",
  "build",
  "target",
  "coverage",
  ".next",
  ".venv",
  "venv",
]);
const AI_INIT_CONTEXT_FILE_NAMES = [
  "README.md",
  "README",
  "readme.md",
  "package.json",
  "pyproject.toml",
  "Cargo.toml",
  "go.mod",
  "Makefile",
  "Taskfile.yml",
  "justfile",
  "Gemfile",
  "pom.xml",
  "build.gradle",
  "deno.json",
  "tsconfig.json",
];

type AppRequirements = TerminalService | ProviderRequirements | PreferencesStoreService | ModelProvidersService | CodewarperConfigService;
type SelectOptionsRequirements = TerminalService | StepRequirements;
type PromptRequirements = TerminalService | StepRequirements;
type InitialCodewarperInitMode = "templates" | "ai";
type AiInitConsent = "continue" | "cancel";
type AiTailoredConfigAction = "create" | "templates" | "cancel";
type InitialCodewarperInitSelection =
  | { type: "template"; starter: InitialCodewarperStarter }
  | { type: "tailored"; plan: TailoredCodewarperPlan; contents: string }
  | null;
type ToolPlanDisplay = {
  name: string;
  description: string;
};
type SessionSelection = {
  provider: SessionConfiguration["provider"];
  auth: SessionConfiguration["auth"];
  selection: SessionConfiguration["selection"];
};

export const run: Effect.Effect<void, Error, AppRequirements> = Effect.gen(function* () {
  const app = yield* initializeApp;
  const terminal = yield* TerminalService;
  yield* loop(app, terminal);
});

const loop = (app: App, terminal: Terminal): Effect.Effect<void, Error, AppRequirements> =>
  Effect.gen(function* () {
    terminal.show({ type: "separator" });
    const rawInput = yield* promptText(terminal, "you> ", { allowEmpty: true, signal: null });
    const result = yield* handleUserInputReturningToPromptOnAbort(app, parseUserInput(rawInput));
    if (result.type === "stop") return;
    return yield* loop(result.app, terminal);
  });

function handleUserInputReturningToPromptOnAbort(
  app: App,
  userInput: UserInput,
): Effect.Effect<LoopResult, Error, AppRequirements> {
  return Effect.gen(function* () {
    const handled = yield* Effect.either(handleUserInput(app, userInput));
    if (handled._tag === "Right") return handled.right;
    if (isAbortError(handled.left)) return { type: "continue" as const, app };
    return yield* Effect.fail(handled.left);
  });
}

const initializeApp: Effect.Effect<App, Error, AppRequirements> = Effect.gen(function* () {
  const terminal = yield* TerminalService;
  const preferences = yield* PreferencesStoreService;
  const config = yield* CodewarperConfigService;
  const configPath = config.path();
  terminal.show({ type: "banner", title: bannerContent});

  const loadedConfig = yield* config.load();
  const loadedTools = loadedConfig.tools;
  const commands = loadedConfig.commands;
  const baseSystemPrompt = loadedConfig.systemPrompt ?? SYSTEM_PROMPT;

  const savedSelection = preferences.getProviderSelection();
  const restoredSession = yield* restoreSavedSession(savedSelection);
  const selection = restoredSession ?? (yield* promptForSessionSelection(false));
  saveProviderSelection(preferences, selection.selection);

  const sessionConfiguration: SessionConfiguration = {
    provider: selection.provider,
    auth: selection.auth,
    selection: selection.selection,
    systemPrompt: appendToolGuidanceToSystemPrompt(baseSystemPrompt, loadedTools),
    loadedTools,
  };

  terminal.show({
    type: "system",
    text: [
      authStatusFromAuth(sessionConfiguration.auth),
      `Loaded ${loadedTools.length} tool(s) and ${commands.length} command(s) from ${configPath}.`,
      `Provider: ${sessionConfiguration.provider.name}`,
      `Options: ${formatSelectionOptions(sessionConfiguration.selection)}`,
      `Commands: ${formatCommandsHelp(commands)}`,
    ].filter(isNonEmptyString).join("\n"),
  });

  return { sessionConfiguration, conversation: { history: [] }, commands };
});

function sessionWithReloadedTools(
  session: SessionConfiguration,
  loadedTools: LoadedTool[],
  systemPromptOverride: string | null,
): SessionConfiguration {
  const baseSystemPrompt = systemPromptOverride ?? SYSTEM_PROMPT;
  return { ...session, loadedTools, systemPrompt: appendToolGuidanceToSystemPrompt(baseSystemPrompt, loadedTools) };
}

function refreshToolsFromDisk(app: App): Effect.Effect<App, never, AppRequirements> {
  return Effect.gen(function* () {
    const terminal = yield* TerminalService;
    const config = yield* CodewarperConfigService;
    const configPath = config.path();
    const result = yield* Effect.either(config.load());
    if (result._tag === "Left") {
      terminal.show({ type: "error", text: `Reload failed: ${result.left.message}` });
      return app;
    }
    const loadedTools = result.right.tools;
    const commands = result.right.commands;
    terminal.show({ type: "system", text: `Reloaded ${loadedTools.length} tool(s) and ${commands.length} command(s) from ${configPath}.` });
    return {
      ...app,
      commands,
      sessionConfiguration: sessionWithReloadedTools(app.sessionConfiguration, loadedTools, result.right.systemPrompt),
    };
  });
}

function handleUserInput(app: App, userInput: UserInput): Effect.Effect<LoopResult, Error, AppRequirements> {
  switch (userInput.type) {
    case "empty": return Effect.succeed({ type: "continue", app });
    case "quit": return Effect.succeed({ type: "stop" });
    case "switch_model":
      return Effect.gen(function* () {
        const terminal = yield* TerminalService;
        const preferences = yield* PreferencesStoreService;
        const selection = yield* selectProviderOptions(app.sessionConfiguration.provider, app.sessionConfiguration.auth);
        saveProviderSelection(preferences, selection);
        terminal.show({ type: "system", text: `Switched options: ${formatSelectionOptions(selection)}.` });
        return { type: "continue" as const, app: { ...app, sessionConfiguration: { ...app.sessionConfiguration, selection } } };
      });
    case "login":
      return Effect.gen(function* () {
        const terminal = yield* TerminalService;
        const preferences = yield* PreferencesStoreService;
        const selection = yield* promptForLoginSessionSelection(app.sessionConfiguration.provider.id);
        saveProviderSelection(preferences, selection.selection);
        terminal.show({ type: "system", text: `Switched to ${selection.provider.name} with options ${formatSelectionOptions(selection.selection)}.` });
        return { type: "continue" as const, app: { ...app, sessionConfiguration: { ...app.sessionConfiguration, provider: selection.provider, auth: selection.auth, selection: selection.selection } } };
      });
    case "init":
      return Effect.gen(function* () {
        const terminal = yield* TerminalService;
        const config = yield* CodewarperConfigService;
        const configPath = config.path();
        const exists = yield* Effect.tryPromise({ try: () => codewarperConfigExists(configPath), catch: toError });
        if (exists) {
          terminal.show({ type: "system", text: `${configPath} already exists.` });
          return { type: "continue" as const, app };
        }
        const selection = yield* selectInitialCodewarperConfig(app.sessionConfiguration);
        if (selection === null) return { type: "continue" as const, app };
        const outcome = selection.type === "template"
          ? yield* Effect.tryPromise({ try: () => writeInitialCodewarperConfigIfMissing(configPath, selection.starter), catch: toError })
          : yield* Effect.tryPromise({ try: () => writeTailoredCodewarperConfigIfMissing(configPath, selection.contents), catch: toError });
        terminal.show({ type: "system", text: outcome === "exists" ? `${configPath} already exists.` : `Created ${configPath}. Run /reload to load tools and commands into this session.` });
        return { type: "continue" as const, app };
      });
    case "reload":
      return Effect.gen(function* () {
        const nextApp = yield* refreshToolsFromDisk(app);
        return { type: "continue" as const, app: nextApp };
      });
    case "help":
      return Effect.gen(function* () {
        const terminal = yield* TerminalService;
        terminal.show({ type: "system", text: [
          "Available commands:",
          "  /help   Show this help message",
          "  /quit   Exit the app",
          "  /exit   Exit the app",
          "  /model  Switch provider options",
          "  /login  Switch provider; picking the current provider forces re-login",
          "  /init   Create the configured Codewarper config from a template or AI-tailored plan",
          "  /reload Reload tools and commands from the configured Codewarper config",
          ...app.commands.map((command) => `  /${command.name} ${command.description}`),
          "",
          "Environment variables:",
          "  CODEWARPER_CONFIG Use a custom config path instead of the default './codewarper.ts'. Relative paths are resolved from the working directory.",
        ].join("\n") });
        return { type: "continue" as const, app };
      });
    case "custom_command": return runCustomCommand(app, userInput.name, userInput.args);
    case "unknown_command":
      return Effect.gen(function* () {
        const terminal = yield* TerminalService;
        terminal.show({ type: "system", text: `Unknown command: ${userInput.command}` });
        return { type: "continue" as const, app };
      });
    case "prompt": return Effect.map(runPrompt(app, userInput.text), (nextApp) => ({ type: "continue", app: nextApp }));
  }
}

function runCustomCommand(app: App, name: string, args: string[]): Effect.Effect<LoopResult, Error, AppRequirements> {
  return Effect.gen(function* () {
    const terminal = yield* TerminalService;
    const command = app.commands.find((candidate) => candidate.name === name);
    if (!command) {
      terminal.show({ type: "system", text: `Unknown command: /${name}` });
      return { type: "continue" as const, app };
    }
    const result = yield* Effect.either(Effect.tryPromise({ try: async () => await command.run(args), catch: toError }));
    if (result._tag === "Left") terminal.show({ type: "error", text: result.left.message });
    else if (result.right.trim()) terminal.show({ type: "system", text: result.right });
    return { type: "continue" as const, app };
  });
}

function runPrompt(app: App, text: string): Effect.Effect<App, never, PromptRequirements> {
  return Effect.gen(function* () {
    const terminal = yield* TerminalService;
    const nextConversation = { history: [...app.conversation.history, { type: "user" as const, text }] };
    return yield* terminal.runWithStepAbortSignal((signal) =>
      Effect.gen(function* () {
        const result = yield* Effect.either(step(nextConversation, app.sessionConfiguration, signal));
        if (result._tag === "Right") {
          terminal.show({ type: "assistant", text: result.right.newMessage.text });
          return { ...app, conversation: result.right.conversation };
        }
        const message = result.left.message;
        if (message !== "Interrupted.") terminal.show({ type: "error", text: message });
        return app;
      })
    );
  });
}

function restoreSavedSession(savedSelection: ProviderSelectionPreference | null): Effect.Effect<SessionSelection | null, Error, AppRequirements> {
  return Effect.gen(function* () {
    const terminal = yield* TerminalService;
    const modelProviders = yield* ModelProvidersService;
    if (savedSelection === null) return null;
    const provider = modelProviders.findById(savedSelection.providerId);
    if (!provider) {
      terminal.show({ type: "system", text: "Saved provider preference is no longer available. Using provider picker." });
      return null;
    }
    const authResult = yield* Effect.either(provider.ensureAuthenticated(false));
    if (authResult._tag === "Left") {
      terminal.show({ type: "system", text: `Could not restore saved provider ${provider.name}: ${authResult.left.message}` });
      return null;
    }
    const optionsResult = yield* Effect.either(provider.listOptions(authResult.right));
    if (optionsResult._tag === "Left") {
      terminal.show({ type: "system", text: `Could not restore saved options for ${provider.name}: ${optionsResult.left.message}` });
      return null;
    }
    if (!selectionMatchesOptions(savedSelection, optionsResult.right)) {
      terminal.show({ type: "system", text: `Saved options are unavailable for ${provider.name}. Using provider picker.` });
      return null;
    }
    return { provider, auth: authResult.right, selection: savedSelection };
  });
}

function promptForSessionSelection(forceLogin: boolean): Effect.Effect<SessionSelection, Error, AppRequirements> {
  return promptForSessionSelectionWithForceLogin((_) => forceLogin);
}

function promptForLoginSessionSelection(currentProviderId: string): Effect.Effect<SessionSelection, Error, AppRequirements> {
  return promptForSessionSelectionWithForceLogin((provider) => provider.id === currentProviderId);
}

function promptForSessionSelectionWithForceLogin(shouldForceLogin: (provider: Provider) => boolean): Effect.Effect<SessionSelection, Error, AppRequirements> {
  return Effect.gen(function* () {
    const terminal = yield* TerminalService;
    const modelProviders = yield* ModelProvidersService;
    const provider = yield* promptSelect(terminal, "Pick a provider:", modelProviders.all.map((provider) => ({ label: provider.name, value: provider })));
    const auth = yield* provider.ensureAuthenticated(shouldForceLogin(provider));
    const selection = yield* selectProviderOptions(provider, auth);
    return { provider, auth, selection };
  });
}

function selectInitialCodewarperConfig(
  sessionConfiguration: SessionConfiguration,
): Effect.Effect<InitialCodewarperInitSelection, Error, AppRequirements> {
  return Effect.gen(function* () {
    const mode = yield* promptForInitialCodewarperInitMode();
    if (mode === "templates") return { type: "template" as const, starter: yield* promptForInitialCodewarperStarter() };

    const tailored = yield* promptForAiTailoredCodewarperConfig(sessionConfiguration);
    if (tailored === null) return null;

    const terminal = yield* TerminalService;
    terminal.show({ type: "system", text: formatTailoredCodewarperPlan(tailored.plan) });

    const action = yield* promptSelect<AiTailoredConfigAction>(terminal, "Create this AI-tailored config?", [
      { label: "Create this config", value: "create" },
      { label: "Pick from existing templates instead", value: "templates" },
      { label: "Cancel", value: "cancel" },
    ]);

    switch (action) {
      case "create": return { type: "tailored", plan: tailored.plan, contents: tailored.contents };
      case "templates": return { type: "template" as const, starter: yield* promptForInitialCodewarperStarter() };
      case "cancel": return null;
    }
  });
}

function promptForInitialCodewarperInitMode(): Effect.Effect<InitialCodewarperInitMode, Error, AppRequirements> {
  return Effect.gen(function* () {
    const terminal = yield* TerminalService;
    return yield* promptSelect<InitialCodewarperInitMode>(terminal, "How should Codewarper create the initial config?", [
      { label: "Use template", value: "templates" },
      { label: "Generate an AI-tailored config", value: "ai" },
    ]);
  });
}

function promptForInitialCodewarperStarter(): Effect.Effect<InitialCodewarperStarter, Error, AppRequirements> {
  return Effect.gen(function* () {
    const terminal = yield* TerminalService;
    return yield* promptSelect(terminal, "Pick a starter for the Codewarper config:", INITIAL_CODEWARPER_STARTER_OPTIONS.map((starter) => ({ label: starter.label, value: starter.id })));
  });
}

function promptForAiTailoredCodewarperConfig(
  sessionConfiguration: SessionConfiguration,
): Effect.Effect<{ plan: TailoredCodewarperPlan; contents: string } | null, Error, AppRequirements> {
  return Effect.gen(function* () {
    const terminal = yield* TerminalService;
    const consent = yield* promptSelect<AiInitConsent>(terminal, "AI-tailored config will inspect a small workspace summary and send it to your selected model.", [
      { label: "Continue", value: "continue" },
      { label: "Cancel", value: "cancel" },
    ]);
    if (consent === "cancel") return null;

    terminal.show({ type: "system", text: "Scanning workspace for a small, generic project summary..." });
    const workspaceSummary = yield* Effect.tryPromise({ try: buildAiInitWorkspaceSummary, catch: toError });

    terminal.show({ type: "system", text: "Asking AI to design a tailored config plan..." });
    const history: Message[] = [{ type: "user", text: buildAiInitPrompt(workspaceSummary) }];
    const completion = yield* sessionConfiguration.provider.complete(
      sessionConfiguration.auth,
      sessionConfiguration.selection,
      history,
      AI_INIT_SYSTEM_PROMPT,
      [],
    );

    const plan = normalizeTailoredCodewarperPlan(parseJsonObject(completion.text));
    return { plan, contents: renderTailoredCodewarperConfig(plan) };
  });
}

async function buildAiInitWorkspaceSummary(): Promise<string> {
  const entries = await readdir(".", { withFileTypes: true });
  const visibleEntries = entries
    .filter((entry) => !AI_INIT_IGNORED_NAMES.has(entry.name))
    .sort((a, b) => a.name.localeCompare(b.name))
    .slice(0, MAX_AI_INIT_TOP_LEVEL_ENTRIES);
  const visibleNames = new Set(visibleEntries.map((entry) => entry.name));
  const lines = [
    "Top-level workspace entries:",
    ...visibleEntries.map((entry) => `- ${entry.name}${entry.isDirectory() ? "/" : ""}`),
  ];

  for (const fileName of AI_INIT_CONTEXT_FILE_NAMES) {
    if (!visibleNames.has(fileName)) continue;
    const entry = visibleEntries.find((candidate) => candidate.name === fileName);
    if (!entry || !entry.isFile()) continue;
    const content = await readFile(fileName, "utf8");
    lines.push("", `File: ${fileName}`, truncateForAiInit(content));
  }

  return lines.join("\n");
}

function buildAiInitPrompt(workspaceSummary: string): string {
  return [
    "Here's the base for the config you will create:",
    "",
    ALL_CONFIG_OPTIONS_CODEWARPER_TS,
    "",
    "Adapt it to this project:",
    workspaceSummary,
  ].join("\n");
}

function formatTailoredCodewarperPlan(plan: TailoredCodewarperPlan): string {
  return [
    "AI-tailored config plan",
    "",
    `Summary: ${plan.summary}`,
    "",
    formatToolSection(plan.toolset),
    "",
    formatSystemPromptSection(plan.systemPrompt),
    "",
    formatCommandSection(plan.commands),
    formatBulletSection("Notes", plan.notes),
    "Safety:",
    "- The AI returned a structured plan, not executable TypeScript.",
    "- Codewarper will render the config from trusted built-in snippets.",
    "- Review tools and commands above; they will run with your local user permissions.",
  ].filter((part) => part.length > 0).join("\n");
}

function formatSystemPromptSection(systemPrompt: string | null): string {
  if (systemPrompt === null) return "System prompt: default Codewarper coding-assistant prompt";
  return ["System prompt override:", systemPrompt].join("\n");
}

function formatToolSection(toolset: TailoredCodewarperPlan["toolset"]): string {
  const tools = toolsForToolset(toolset);
  if (tools.length === 0) return "Tools:\n- None";
  return [
    `Tools: ${formatToolset(toolset)}`,
    ...tools.map((tool) => `- ${tool.name}: ${tool.description}`),
  ].join("\n");
}

function toolsForToolset(toolset: TailoredCodewarperPlan["toolset"]): ToolPlanDisplay[] {
  const workspaceTools: ToolPlanDisplay[] = [
    { name: "list_dir", description: "List workspace directory entries." },
    { name: "read_file", description: "Read UTF-8 files inside the workspace." },
    { name: "write_file", description: "Create or overwrite UTF-8 files inside the workspace." },
    { name: "delete_file", description: "Delete files inside the workspace." },
  ];

  switch (toolset) {
    case "none": return [];
    case "workspace_files": return workspaceTools;
    case "workspace_files_with_websearch":
      return [
        ...workspaceTools,
        { name: "websearch", description: "Search the web for external docs or references." },
      ];
  }
}

function formatToolset(toolset: TailoredCodewarperPlan["toolset"]): string {
  switch (toolset) {
    case "none": return "No tools";
    case "workspace_files": return "Workspace file tools";
    case "workspace_files_with_websearch": return "Workspace file tools + web search";
  }
}

function formatCommandSection(commands: TailoredCodewarperPlan["commands"]): string {
  if (commands.length === 0) return "Commands:\n- None";
  return [
    "Commands:",
    ...commands.map((command) => `- /${command.name}: ${command.command} ${command.args.join(" ")} — ${command.description}`),
  ].join("\n");
}

function formatBulletSection(title: string, bullets: string[]): string {
  if (bullets.length === 0) return "";
  return [`${title}:`, ...bullets.map((bullet) => `- ${bullet}`)].join("\n");
}

function parseJsonObject(text: string): unknown {
  const trimmed = text.trim();
  const jsonText = trimmed.startsWith("{") && trimmed.endsWith("}")
    ? trimmed
    : trimmed.slice(trimmed.indexOf("{"), trimmed.lastIndexOf("}") + 1);
  if (!jsonText.startsWith("{") || !jsonText.endsWith("}")) {
    throw new Error("AI did not return JSON for the config plan.");
  }
  return JSON.parse(jsonText);
}

function truncateForAiInit(text: string): string {
  if (text.length <= MAX_AI_INIT_CONTEXT_FILE_CHARS) return text;
  return `${text.slice(0, MAX_AI_INIT_CONTEXT_FILE_CHARS)}\n... [truncated]`;
}

function saveProviderSelection(preferences: PreferencesStore, selection: ProviderSelection): void {
  preferences.setProviderSelection(selection);
}

function selectProviderOptions(provider: SessionConfiguration["provider"], auth: SessionConfiguration["auth"]): Effect.Effect<ProviderSelection, Error, SelectOptionsRequirements> {
  return collectOptions(provider.id, provider.name, () => provider.listOptions(auth));
}

/**
 * Collect options by walking the option tree depth-first.
 * When a chosen choice has sub-options (`options`), they are prompted for too.
 */
function collectOptions<R>(
  providerId: string,
  providerName: string,
  listOptions: () => Effect.Effect<ProviderOption[], Error, R>,
): Effect.Effect<ProviderSelection, Error, R | TerminalService> {
  return Effect.gen(function* () {
    const terminal = yield* TerminalService;
    const options: Record<string, string> = {};
    yield* collectOptionsLevel(terminal, options, listOptions(), providerName);
    return { providerId, options };
  });
}

function collectOptionsLevel<R>(
  terminal: Terminal,
  collected: Record<string, string>,
  optionsEffect: Effect.Effect<ProviderOption[], Error, R>,
  providerName: string,
): Effect.Effect<void, Error, R> {
  return Effect.gen(function* () {
    const providerOptions = yield* optionsEffect;
    for (const option of providerOptions) {
      const choice = yield* promptSelect<ProviderOptionChoice>(terminal, `Pick ${option.name}:`, option.choices.map((c) => ({ label: c.name, value: c })));
      collected[option.id] = choice.id;
      if (choice.options) {
        yield* collectOptionsLevel(terminal, collected, Effect.succeed(choice.options), providerName);
      }
    }
  });
}

function selectionMatchesOptions(selection: ProviderSelection, options: ProviderOption[]): boolean {
  return checkOptionsMatch(selection.options, options);
}

function checkOptionsMatch(collected: Record<string, string>, options: ProviderOption[]): boolean {
  return options.every((option) => {
    const selected = collected[option.id];
    if (typeof selected !== "string") return false;
    const match = option.choices.find((choice) => choice.id === selected);
    if (!match) return false;
    if (match.options) {
      return checkOptionsMatch(collected, match.options);
    }
    return true;
  });
}

function formatSelectionOptions(selection: ProviderSelection): string {
  return Object.entries(selection.options).map(([key, value]) => `${key}=${value}`).join(", ");
}

function formatCommandsHelp(commands: App["commands"]): string {
  return [...BUILT_IN_COMMANDS_HELP, ...commands.map((command) => `/${command.name}`)].join(", ");
}

function authStatusFromAuth(auth: SessionConfiguration["auth"]): string | null {
  const status = auth[AUTH_STATUS_KEY];
  return typeof status === "string" && status.trim() ? status : null;
}

function isNonEmptyString(value: string | null): value is string {
  return typeof value === "string" && value.length > 0;
}

function promptText(terminal: Terminal, message: string, options: { allowEmpty: boolean; signal: AbortSignal | null }): Effect.Effect<string, Error> {
  return fromPromise(() => terminal.promptText(message, options));
}

function promptSelect<T>(terminal: Terminal, message: string, options: SelectOption<T>[]): Effect.Effect<T, Error> {
  return fromPromise(() => terminal.promptSelect(message, options));
}

function fromPromise<A>(thunk: () => Promise<A>): Effect.Effect<A, Error> {
  return Effect.tryPromise({ try: thunk, catch: toError });
}

function isAbortError(error: Error): boolean {
  return error.name === "AbortError";
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
