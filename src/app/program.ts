import { Effect, type Req } from "#effect";
import {
  CodewarperConfigService,
  parseConfigModule,
} from "../config/load-codewarper.ts";
import {
  codewarperConfigExists,
  getInitialCodewarperTemplateConfig,
  INITIAL_CODEWARPER_STARTER_OPTIONS,
  type InitialCodewarperStarter,
  writeInitialCodewarperConfigIfMissing,
} from "../config/write-initial-codewarper.ts";
import {
  createAiConfigSessionTools,
  AI_CONFIG_SYSTEM_PROMPT,
  AI_CONFIG_USER_PROMPT,
} from "../config/ai-config-session.ts";
import { PreferencesStoreService } from "../persistence/preferences-service.ts";
import type {
  PreferencesStore,
  ProviderSelectionPreference,
} from "../persistence/preferences-store.ts";
import type {
  Message,
  Provider,
  ProviderOption,
  ProviderOptionChoice,
  ProviderR,
  ProviderSelection,
} from "../providers/index.ts";
import { ModelProvidersService } from "../providers/index.ts";
import {
  TerminalService,
  type SelectOption,
  type Terminal,
} from "../providers/services.ts";
import { step } from "../step/index.ts";
import type { SessionConfiguration } from "../step/index.ts";
import type { StepR } from "../step/services.ts";
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

const BUILT_IN_COMMANDS_HELP = [
  "/help",
  "/quit",
  "/exit",
  "/model",
  "/login",
  "/reload",
];
const AUTH_STATUS_KEY = "codewarperAuthStatus";

// -- R type definitions --------------------------------------------------

type AppR = Req<
  | typeof TerminalService
  | typeof PreferencesStoreService
  | typeof ModelProvidersService
  | typeof CodewarperConfigService
> &
  ProviderR;

type PromptR = StepR;

type InitialCodewarperInitMode = "templates" | "ai";

type SessionSelection = {
  provider: SessionConfiguration["provider"];
  auth: SessionConfiguration["auth"];
  selection: SessionConfiguration["selection"];
};

type StartupConfigChoice =
  | "continue_without_tools"
  | "create_config"
  | "load_without_creating";

// -- Entry point ---------------------------------------------------------

export const run: Effect<void, Error, AppR> = Effect.gen(function* () {
  const app = yield* initializeApp;
  const terminal = yield* TerminalService;
  yield* loop(app, terminal);
});

// -- Main loop -----------------------------------------------------------

const loop = (
  app: App,
  terminal: Terminal,
): Effect<void, Error, AppR> =>
  Effect.gen(function* () {
    terminal.show({ type: "separator" });
    const rawInput = yield* promptText(terminal, "you> ", {
      allowEmpty: true,
      signal: null,
    });
    const result = yield* handleUserInputReturningToPromptOnAbort(
      app,
      parseUserInput(rawInput),
    );
    if (result.type === "stop") return;
    return yield* loop(result.app, terminal);
  });

function handleUserInputReturningToPromptOnAbort(
  app: App,
  userInput: UserInput,
): Effect<LoopResult, Error, AppR> {
  return Effect.gen(function* () {
    const handled = yield* Effect.either(handleUserInput(app, userInput));
    if (handled._tag === "Right") return handled.right;
    if (isAbortError(handled.left)) return { type: "continue" as const, app };
    return yield* Effect.fail(handled.left);
  });
}

// -- App initialization --------------------------------------------------

const initializeApp: Effect<App, Error, AppR> = Effect.gen(function* () {
  const terminal = yield* TerminalService;
  const preferences = yield* PreferencesStoreService;
  const config = yield* CodewarperConfigService;
  const configPath = config.path();
  terminal.show({ type: "banner", title: bannerContent });

  let loadedConfig = yield* config.load();
  const configExists = yield* Effect.tryPromise({
    try: () => codewarperConfigExists(configPath),
    catch: toError,
  });
  let configOrigin = configExists ? configPath : "(no config file)";

  if (!configExists) {
    const choice = yield* promptForMissingConfigChoice();
    switch (choice) {
      case "create_config": {
        const mode = yield* promptForInitialCodewarperInitMode();
        if (mode === "ai") {
          const aiTools = createAiConfigSessionTools();
          yield* Effect.tryPromise({
            try: () =>
              writeInitialCodewarperConfigIfMissing(
                configPath,
                "local_files_with_websearch",
              ),
            catch: toError,
          });
          loadedConfig = yield* config.load();
          configOrigin = configPath;
          terminal.show({
            type: "system",
            text: `Created ${configPath} from template. Starting AI config session...`,
          });

          const savedSelection = preferences.getProviderSelection();
          const restoredSession = yield* restoreSavedSession(savedSelection);
          const aiSelection =
            restoredSession ?? (yield* promptForSessionSelection(false));
          saveProviderSelection(preferences, aiSelection.selection);

          const aiSessionConfig: SessionConfiguration = {
            provider: aiSelection.provider,
            auth: aiSelection.auth,
            selection: aiSelection.selection,
            systemPrompt: AI_CONFIG_SYSTEM_PROMPT,
            loadedTools: aiTools,
          };

          const aiHistory: Message[] = [
            { type: "user", text: AI_CONFIG_USER_PROMPT },
          ];
          const aiResult = yield* terminal.runWithStepAbortSignal((signal: AbortSignal) =>
            Effect.either(
              step({ history: aiHistory }, aiSessionConfig, signal),
            ),
          );

          if (aiResult._tag === "Right") {
            terminal.show({
              type: "assistant",
              text: aiResult.right.newMessage.text,
            });
          } else {
            terminal.show({
              type: "error",
              text: `AI config session failed: ${aiResult.left.message}`,
            });
          }

          loadedConfig = yield* config.load();
          terminal.show({
            type: "system",
            text: `AI config session complete. Run /reload to activate any new tools.`,
          });
          break;
        }
        const starter = yield* promptForInitialCodewarperStarter();
        yield* Effect.tryPromise({
          try: () =>
            writeInitialCodewarperConfigIfMissing(configPath, starter),
          catch: toError,
        });
        loadedConfig = yield* config.load();
        configOrigin = configPath;
        terminal.show({
          type: "system",
          text: `Created ${configPath}.`,
        });
        break;
      }
      case "load_without_creating": {
        const starter = yield* promptForInitialCodewarperStarter();
        const templateMod = getInitialCodewarperTemplateConfig(starter);
        loadedConfig = parseConfigModule(templateMod, `template:${starter}`);
        config.setCurrent(loadedConfig);
        configOrigin = `built-in template (${starterLabel(starter)})`;
        terminal.show({
          type: "system",
          text: `Loaded "${starterLabel(starter)}" configuration (not saved to disk).`,
        });
        break;
      }
      case "continue_without_tools": {
        configOrigin = "(no config file)";
        terminal.show({
          type: "system",
          text: "No config file found. Continuing without tools. Run /reload after creating a codewarper.js to load tools.",
        });
        break;
      }
    }
  }

  const loadedTools = loadedConfig.tools;
  const commands = loadedConfig.commands;
  const baseSystemPrompt = loadedConfig.systemPrompt ?? SYSTEM_PROMPT;

  const savedSelection = preferences.getProviderSelection();
  const restoredSession = yield* restoreSavedSession(savedSelection);
  const selection =
    restoredSession ?? (yield* promptForSessionSelection(false));
  saveProviderSelection(preferences, selection.selection);

  const sessionConfiguration: SessionConfiguration = {
    provider: selection.provider,
    auth: selection.auth,
    selection: selection.selection,
    systemPrompt: appendToolGuidanceToSystemPrompt(
      baseSystemPrompt,
      loadedTools,
    ),
    loadedTools,
  };

  terminal.show({
    type: "system",
    text: [
      authStatusFromAuth(sessionConfiguration.auth),
      `Loaded ${loadedTools.length} tool(s) and ${commands.length} command(s) from ${configOrigin}.`,
      `Provider: ${sessionConfiguration.provider.name}`,
      `Options: ${formatSelectionOptions(sessionConfiguration.selection)}`,
      `Commands: ${formatCommandsHelp(commands)}`,
    ]
      .filter(isNonEmptyString)
      .join("\n"),
  });

  return {
    sessionConfiguration,
    conversation: { history: [] },
    commands,
  };
});

function sessionWithReloadedTools(
  session: SessionConfiguration,
  loadedTools: LoadedTool[],
  systemPromptOverride: string | null,
): SessionConfiguration {
  const baseSystemPrompt = systemPromptOverride ?? SYSTEM_PROMPT;
  return {
    ...session,
    loadedTools,
    systemPrompt: appendToolGuidanceToSystemPrompt(
      baseSystemPrompt,
      loadedTools,
    ),
  };
}

function refreshToolsFromDisk(app: App): Effect<App, never, AppR> {
  return Effect.gen(function* () {
    const terminal = yield* TerminalService;
    const config = yield* CodewarperConfigService;
    const configPath = config.path();
    const result = yield* Effect.either(config.load());
    if (result._tag === "Left") {
      terminal.show({
        type: "error",
        text: `Reload failed: ${result.left.message}`,
      });
      return app;
    }
    const loadedTools = result.right.tools;
    const commands = result.right.commands;
    terminal.show({
      type: "system",
      text: `Reloaded ${loadedTools.length} tool(s) and ${commands.length} command(s) from ${configPath}.`,
    });
    return {
      ...app,
      commands,
      sessionConfiguration: sessionWithReloadedTools(
        app.sessionConfiguration,
        loadedTools,
        result.right.systemPrompt,
      ),
    };
  });
}

// -- User input handling -------------------------------------------------

function handleUserInput(
  app: App,
  userInput: UserInput,
): Effect<LoopResult, Error, AppR> {
  switch (userInput.type) {
    case "empty":
      return Effect.succeed({ type: "continue", app });
    case "quit":
      return Effect.succeed({ type: "stop" });
    case "switch_model":
      return Effect.gen(function* () {
        const terminal = yield* TerminalService;
        const preferences = yield* PreferencesStoreService;
        const selection = yield* selectProviderOptions(
          app.sessionConfiguration.provider,
          app.sessionConfiguration.auth,
        );
        saveProviderSelection(preferences, selection);
        terminal.show({
          type: "system",
          text: `Switched options: ${formatSelectionOptions(selection)}.`,
        });
        return {
          type: "continue" as const,
          app: {
            ...app,
            sessionConfiguration: {
              ...app.sessionConfiguration,
              selection,
            },
          },
        };
      });
    case "login":
      return Effect.gen(function* () {
        const terminal = yield* TerminalService;
        const preferences = yield* PreferencesStoreService;
        const selection = yield* promptForLoginSessionSelection(
          app.sessionConfiguration.provider.id,
        );
        saveProviderSelection(preferences, selection.selection);
        terminal.show({
          type: "system",
          text: `Switched to ${selection.provider.name} with options ${formatSelectionOptions(selection.selection)}.`,
        });
        return {
          type: "continue" as const,
          app: {
            ...app,
            sessionConfiguration: {
              ...app.sessionConfiguration,
              provider: selection.provider,
              auth: selection.auth,
              selection: selection.selection,
            },
          },
        };
      });
    case "reload":
      return Effect.gen(function* () {
        const nextApp = yield* refreshToolsFromDisk(app);
        return { type: "continue" as const, app: nextApp };
      });
    case "help":
      return Effect.gen(function* () {
        const terminal = yield* TerminalService;
        terminal.show({
          type: "system",
          text: [
            "Available commands:",
            "  /help   Show this help message",
            "  /quit   Exit the app",
            "  /exit   Exit the app",
            "  /model  Switch provider options",
            "  /login  Switch provider; picking the current provider forces re-login",
            "  /reload Reload tools and commands from the configured Codewarper config",
            ...app.commands.map(
              (command) => `  /${command.name} ${command.description}`,
            ),
            "",
            "Environment variables:",
            "  CODEWARPER_CONFIG Use a custom config path instead of the default './codewarper.js'. Relative paths are resolved from the working directory.",
          ].join("\n"),
        });
        return { type: "continue" as const, app };
      });
    case "custom_command":
      return runCustomCommand(app, userInput.name, userInput.args);
    case "unknown_command":
      return Effect.gen(function* () {
        const terminal = yield* TerminalService;
        terminal.show({
          type: "system",
          text: `Unknown command: ${userInput.command}`,
        });
        return { type: "continue" as const, app };
      });
    case "prompt":
      return Effect.map(
        runPrompt(app, userInput.text),
        (nextApp) => ({ type: "continue", app: nextApp }),
      );
  }
}

function runCustomCommand(
  app: App,
  name: string,
  args: string[],
): Effect<LoopResult, Error, AppR> {
  return Effect.gen(function* () {
    const terminal = yield* TerminalService;
    const command = app.commands.find((candidate) => candidate.name === name);
    if (!command) {
      terminal.show({
        type: "system",
        text: `Unknown command: /${name}`,
      });
      return { type: "continue" as const, app };
    }
    const result = yield* Effect.either(
      Effect.tryPromise({
        try: async () => await command.run(args),
        catch: toError,
      }),
    );
    if (result._tag === "Left")
      terminal.show({ type: "error", text: result.left.message });
    else if (result.right.trim())
      terminal.show({ type: "system", text: result.right });
    return { type: "continue" as const, app };
  });
}

function runPrompt(app: App, text: string): Effect<App, never, PromptR> {
  return Effect.gen(function* () {
    const terminal = yield* TerminalService;
    const nextConversation = {
      history: [
        ...app.conversation.history,
        { type: "user" as const, text },
      ],
    };
    return yield* terminal.runWithStepAbortSignal((signal: AbortSignal) =>
      Effect.gen(function* () {
        const result = yield* Effect.either(
          step(nextConversation, app.sessionConfiguration, signal),
        );
        if (result._tag === "Right") {
          terminal.show({
            type: "assistant",
            text: result.right.newMessage.text,
          });
          return {
            ...app,
            conversation: result.right.conversation,
          };
        }
        const message = result.left.message;
        if (message !== "Interrupted.")
          terminal.show({ type: "error", text: message });
        return app;
      }),
    );
  });
}

// -- Startup config prompt -----------------------------------------------

function promptForMissingConfigChoice(): Effect<
  StartupConfigChoice,
  Error,
  PromptR
> {
  return Effect.gen(function* () {
    const terminal = yield* TerminalService;
    return yield* promptSelect<StartupConfigChoice>(
      terminal,
      "No codewarper.js found in this directory. What would you like to do?",
      [
        { label: "Continue without tools", value: "continue_without_tools" },
        {
          label: "Create a codewarper.js config file",
          value: "create_config",
        },
        {
          label: "Load a configuration without creating a file",
          value: "load_without_creating",
        },
      ],
    );
  });
}

// -- Session & provider helpers ------------------------------------------

function restoreSavedSession(
  savedSelection: ProviderSelectionPreference | null,
): Effect<SessionSelection | null, Error, AppR> {
  return Effect.gen(function* () {
    const terminal = yield* TerminalService;
    const modelProviders = yield* ModelProvidersService;
    if (savedSelection === null) return null;
    const provider = modelProviders.findById(savedSelection.providerId);
    if (!provider) {
      terminal.show({
        type: "system",
        text: "Saved provider preference is no longer available. Using provider picker.",
      });
      return null;
    }
    const authResult = yield* Effect.either(
      provider.ensureAuthenticated(false),
    );
    if (authResult._tag === "Left") {
      terminal.show({
        type: "system",
        text: `Could not restore saved provider ${provider.name}: ${authResult.left.message}`,
      });
      return null;
    }
    const optionsResult = yield* Effect.either(
      provider.listOptions(authResult.right),
    );
    if (optionsResult._tag === "Left") {
      terminal.show({
        type: "system",
        text: `Could not restore saved options for ${provider.name}: ${optionsResult.left.message}`,
      });
      return null;
    }
    if (!selectionMatchesOptions(savedSelection, optionsResult.right)) {
      terminal.show({
        type: "system",
        text: `Saved options are unavailable for ${provider.name}. Using provider picker.`,
      });
      return null;
    }
    return {
      provider,
      auth: authResult.right,
      selection: savedSelection,
    };
  });
}

function promptForSessionSelection(
  forceLogin: boolean,
): Effect<SessionSelection, Error, AppR> {
  return promptForSessionSelectionWithForceLogin((_) => forceLogin);
}

function promptForLoginSessionSelection(
  currentProviderId: string,
): Effect<SessionSelection, Error, AppR> {
  return promptForSessionSelectionWithForceLogin(
    (provider: Provider) => provider.id === currentProviderId,
  );
}

function promptForSessionSelectionWithForceLogin(
  shouldForceLogin: (provider: Provider) => boolean,
): Effect<SessionSelection, Error, AppR> {
  return Effect.gen(function* () {
    const terminal = yield* TerminalService;
    const modelProviders = yield* ModelProvidersService;
    const provider = yield* promptSelect(
      terminal,
      "Pick a provider:",
      modelProviders.all.map((provider: Provider) => ({
        label: provider.name,
        value: provider,
      })),
    );
    const auth = yield* provider.ensureAuthenticated(
      shouldForceLogin(provider),
    );
    const selection = yield* selectProviderOptions(provider, auth);
    return { provider, auth, selection };
  });
}

// -- Initial config creation helpers -------------------------------------

function promptForInitialCodewarperInitMode(): Effect<
  InitialCodewarperInitMode,
  Error,
  PromptR
> {
  return Effect.gen(function* () {
    const terminal = yield* TerminalService;
    return yield* promptSelect<InitialCodewarperInitMode>(
      terminal,
      "How should Codewarper create the initial config?",
      [
        { label: "Use template", value: "templates" },
        {
          label:
            "Use the selected provider model to generate a config for this project",
          value: "ai",
        },
      ],
    );
  });
}

function promptForInitialCodewarperStarter(): Effect<
  InitialCodewarperStarter,
  Error,
  PromptR
> {
  return Effect.gen(function* () {
    const terminal = yield* TerminalService;
    return yield* promptSelect(
      terminal,
      "Pick a starter for the Codewarper config:",
      INITIAL_CODEWARPER_STARTER_OPTIONS.map((starter) => ({
        label: starter.label,
        value: starter.id,
      })),
    );
  });
}

function starterLabel(starter: InitialCodewarperStarter): string {
  const option = INITIAL_CODEWARPER_STARTER_OPTIONS.find(
    (o) => o.id === starter,
  );
  return option?.label ?? starter;
}

function saveProviderSelection(
  preferences: PreferencesStore,
  selection: ProviderSelection,
): void {
  preferences.setProviderSelection(selection);
}

function selectProviderOptions(
  provider: SessionConfiguration["provider"],
  auth: SessionConfiguration["auth"],
): Effect<ProviderSelection, Error, PromptR> {
  return collectOptions(provider.id, provider.name, () =>
    provider.listOptions(auth),
  );
}

function collectOptions<R extends Record<string, unknown>>(
  providerId: string,
  providerName: string,
  listOptions: () => Effect<ProviderOption[], Error, R>,
): Effect<ProviderSelection, Error, PromptR & R> {
  return Effect.gen(function* () {
    const terminal = yield* TerminalService;
    const options: Record<string, string> = {};
    yield* collectOptionsLevel(terminal, options, listOptions(), providerName);
    return { providerId, options };
  });
}

function collectOptionsLevel<R extends Record<string, unknown>>(
  terminal: Terminal,
  collected: Record<string, string>,
  optionsEffect: Effect<ProviderOption[], Error, R>,
  providerName: string,
): Effect<void, Error, R> {
  return Effect.gen(function* () {
    const providerOptions = yield* optionsEffect;
    for (const option of providerOptions) {
      const choice = yield* promptSelect<ProviderOptionChoice>(
        terminal,
        `Pick ${option.name}:`,
        option.choices.map((c: ProviderOptionChoice) => ({ label: c.name, value: c })),
      );
      collected[option.id] = choice.id;
      if (choice.options) {
        yield* collectOptionsLevel(
          terminal,
          collected,
          Effect.succeed(choice.options),
          providerName,
        );
      }
    }
  });
}

function selectionMatchesOptions(
  selection: ProviderSelection,
  options: ProviderOption[],
): boolean {
  return checkOptionsMatch(selection.options, options);
}

function checkOptionsMatch(
  collected: Record<string, string>,
  options: ProviderOption[],
): boolean {
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
  return Object.entries(selection.options)
    .map(([key, value]) => `${key}=${value}`)
    .join(", ");
}

function formatCommandsHelp(commands: App["commands"]): string {
  return [
    ...BUILT_IN_COMMANDS_HELP,
    ...commands.map((command) => `/${command.name}`),
  ].join(", ");
}

function authStatusFromAuth(
  auth: SessionConfiguration["auth"],
): string | null {
  const status = auth[AUTH_STATUS_KEY];
  return typeof status === "string" && status.trim() ? status : null;
}

function isNonEmptyString(value: string | null): value is string {
  return typeof value === "string" && value.length > 0;
}

// -- Low-level prompt helpers --------------------------------------------

function promptText(
  terminal: Terminal,
  message: string,
  options: { allowEmpty: boolean; signal: AbortSignal | null },
): Effect<string, Error> {
  return fromPromise(() => terminal.promptText(message, options));
}

function promptSelect<T>(
  terminal: Terminal,
  message: string,
  options: SelectOption<T>[],
): Effect<T, Error> {
  return fromPromise(() => terminal.promptSelect(message, options));
}

function fromPromise<A>(thunk: () => Promise<A>): Effect<A, Error> {
  return Effect.tryPromise({ try: thunk, catch: toError });
}

function isAbortError(error: Error): boolean {
  return error.name === "AbortError";
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
