import { Effect } from "#effect";
import {
  HttpClientService,
  ProviderAuthStoreService,
  TerminalService,
  type ProviderAuth,
  type ProviderAuthStore,
  type Terminal,
} from "./services.ts";
import type {
  Message,
  Provider,
  ProviderClientR,
  ProviderAuthR,
  ProviderCompletion,
  ProviderOption,
  ProviderSelection,
  ProviderToolCall,
} from "./index.ts";
import type { Tool } from "../tools/types.ts";

const PROVIDER_ID = "lmstudio";
const PROVIDER_NAME = "LM Studio";
const DEFAULT_BASE_URL = "http://127.0.0.1:1234/v1";

// ── Authentication ──────────────────────────────────────────────────────

const ensureAuthenticated = (forceLogin: boolean): Effect<ProviderAuth, Error, ProviderAuthR> =>
  Effect.gen(function* () {
    const terminal = yield* TerminalService;
    const authStore = yield* ProviderAuthStoreService;
    const savedAuth = authStore.get(PROVIDER_ID);

    if (!forceLogin && savedAuth !== null) {
      terminal.show({ type: "system", text: "Using saved LM Studio connection settings." });
      return savedAuth;
    }

    return yield* promptAndSaveAuth(terminal, authStore);
  });

// ── Option listing ──────────────────────────────────────────────────────

const listOptions = (auth: ProviderAuth): Effect<ProviderOption[], Error, ProviderClientR> =>
  Effect.gen(function* () {
    const models: LmStudioModel[] = yield* fetchModels(auth);

    if (models.length === 0) {
      return yield* Effect.fail(
        new Error(
          "LM Studio returned no models. Make sure a model is loaded in LM Studio (http://127.0.0.1:1234).",
        ),
      );
    }

    const choices = models.map((model) => ({ id: model.id, name: model.id }));

    return [
      {
        id: "model",
        name: "Model",
        choices,
      },
    ];
  });

// ── Completion ──────────────────────────────────────────────────────────

function complete(
  auth: ProviderAuth,
  selection: ProviderSelection,
  history: Message[],
  systemPrompt: string,
  tools: readonly Tool[],
  signal?: AbortSignal,
): Effect<ProviderCompletion, Error, ProviderClientR> {
  return Effect.gen(function* () {
    const modelId = selection.options.model;
    if (!modelId) return yield* Effect.fail(new Error("Missing required LM Studio option: model."));

    return yield* completeChatCompletions(auth, modelId, history, systemPrompt, tools, signal);
  });
}

export const lmStudioProvider: Provider = {
  id: PROVIDER_ID,
  name: PROVIDER_NAME,
  ensureAuthenticated,
  listOptions,
  complete,
};

// ── Auth helpers ────────────────────────────────────────────────────────

function promptAndSaveAuth(
  terminal: Terminal,
  authStore: ProviderAuthStore,
): Effect<ProviderAuth, Error> {
  return Effect.gen(function* () {
    const baseUrl = (
      yield* fromPromise(() =>
        terminal.promptText(
          `LM Studio base URL (default: ${DEFAULT_BASE_URL}): `,
          { allowEmpty: true, signal: null },
        ),
      )
    ).trim();

    const resolvedBaseUrl = baseUrl || DEFAULT_BASE_URL;

    const apiKey = (
      yield* fromPromise(() =>
        terminal.promptText(
          "LM Studio API key (press Enter to skip if none): ",
          { allowEmpty: true, signal: null },
        ),
      )
    ).trim();

    const auth = {
      access: apiKey,
      refresh: resolvedBaseUrl, // store base URL in refresh field
      expires: Number.MAX_SAFE_INTEGER,
      accountId: "lmstudio",
    } satisfies ProviderAuth;

    authStore.set(PROVIDER_ID, auth);
    terminal.show({ type: "system", text: `LM Studio connection saved (${resolvedBaseUrl}).` });
    return auth;
  });
}

// ── Model fetching ──────────────────────────────────────────────────────

type LmStudioModel = {
  id: string;
};

function getBaseUrl(auth: ProviderAuth): string {
  return (typeof auth.refresh === "string" && auth.refresh.trim()) || DEFAULT_BASE_URL;
}

function fetchConnectionHelp(baseUrl: string): string {
  return [
    `Could not connect to LM Studio at ${baseUrl}.`,
    "Make sure LM Studio is running and the local server is started.",
    "If LM Studio is running on a different port, use /login to reconfigure the base URL.",
    "Tip: If you see an IPv6 ::1 error, use 127.0.0.1 instead of localhost in the URL.",
  ].join(" ");
}

const fetchModels = (auth: ProviderAuth): Effect<LmStudioModel[], Error, ProviderClientR> =>
  Effect.gen(function* () {
    const http = yield* HttpClientService;
    const baseUrl = getBaseUrl(auth);

    const response = yield* Effect.catchAll(
      fromPromise(() =>
        http.fetch(`${baseUrl}/models`, {
          method: "GET",
          headers: buildHeaders(auth),
        }),
      ),
      (cause) => Effect.fail(new Error(fetchConnectionHelp(baseUrl), { cause })),
    );

    if (!response.ok) {
      const message = yield* parseError(response);
      return yield* Effect.fail(
        new Error(`Could not fetch LM Studio model list. ${message}`),
      );
    }

    const body = yield* fromPromise(() => response.json());
    const bodyRecord = toRecord(body);

    const data = bodyRecord?.data ?? body;

    if (!Array.isArray(data)) {
      // LM Studio returns { object: "list", data: [...] }
      return yield* Effect.fail(new Error("LM Studio returned an unexpected model list."));
    }

    return data.flatMap((item): LmStudioModel[] => {
      const record = toRecord(item);
      if (record === null) return [];
      const id = typeof record.id === "string" && record.id.trim() ? record.id.trim() : "";
      if (!id) return [];
      return [{ id }];
    });
  });

// ── Chat completions ────────────────────────────────────────────────────

function completeChatCompletions(
  auth: ProviderAuth,
  modelId: string,
  history: Message[],
  systemPrompt: string,
  tools: readonly Tool[],
  signal?: AbortSignal,
): Effect<ProviderCompletion, Error, ProviderClientR> {
  return Effect.gen(function* () {
    const http = yield* HttpClientService;
    const baseUrl = getBaseUrl(auth);

    const response = yield* Effect.catchAll(
      fromPromise(() =>
        http.fetch(`${baseUrl}/chat/completions`, {
          method: "POST",
          headers: {
            ...buildHeaders(auth),
            "Content-Type": "application/json",
          },
          body: JSON.stringify(
            createChatCompletionsRequestBody(modelId, history, systemPrompt, tools),
          ),
          signal,
        }),
      ),
      (cause) => Effect.fail(new Error(fetchConnectionHelp(baseUrl), { cause })),
    );

    if (!response.ok) {
      const message = yield* parseError(response);
      return yield* Effect.fail(new Error(message));
    }

    return yield* parseChatCompletionsResponse(response);
  });
}

function buildHeaders(auth: ProviderAuth): Record<string, string> {
  const headers: Record<string, string> = {
    accept: "application/json",
  };
  if (auth.access) {
    headers["Authorization"] = `Bearer ${auth.access}`;
  }
  return headers;
}

function createChatCompletionsRequestBody(
  modelId: string,
  history: Message[],
  systemPrompt: string,
  tools: readonly Tool[],
) {
  return {
    model: modelId,
    stream: false,
    messages: messagesToChatCompletionsMessages(systemPrompt, history),
    ...(tools.length > 0
      ? {
          tools: createChatCompletionsTools(tools),
          tool_choice: "auto",
        }
      : {}),
  };
}

function createChatCompletionsTools(tools: readonly Tool[]) {
  return tools.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
    },
  }));
}

function messagesToChatCompletionsMessages(
  systemPrompt: string,
  history: Message[],
): unknown[] {
  return [
    { role: "system", content: systemPrompt },
    ...history.map((message) => {
      if (message.type === "user") return { role: "user", content: message.text };
      if (message.type === "tool_result") {
        return {
          role: "tool",
          tool_call_id: splitToolCallId(message.toolCallId).callId,
          content: message.content,
        };
      }
      return {
        role: "assistant",
        content: message.text,
        ...(message.toolCalls && message.toolCalls.length > 0
          ? { tool_calls: message.toolCalls.map(toolCallToChatCompletions) }
          : {}),
      };
    }),
  ];
}

function toolCallToChatCompletions(toolCall: ProviderToolCall) {
  return {
    id: splitToolCallId(toolCall.id).callId,
    type: "function",
    function: {
      name: toolCall.name,
      arguments: JSON.stringify(toolCall.input),
    },
  };
}

function splitToolCallId(id: string): { callId: string; itemId: string | null } {
  const [callId, itemId] = id.split("|", 2);
  return { callId: callId || id, itemId: itemId || null };
}

// ── Response parsing ────────────────────────────────────────────────────

function parseChatCompletionsResponse(
  response: Response,
): Effect<ProviderCompletion, Error> {
  return Effect.gen(function* () {
    const body = yield* fromPromise(() => response.json());
    const bodyRecord = toRecord(body);
    const choices = bodyRecord === null ? null : bodyRecord.choices;
    const firstChoice = Array.isArray(choices) ? toRecord(choices[0]) : null;
    const message = firstChoice === null ? null : toRecord(firstChoice.message);

    if (bodyRecord === null || message === null) {
      return yield* Effect.fail(
        new Error("LM Studio returned an unexpected chat completions response."),
      );
    }

    return {
      text: typeof message.content === "string" ? message.content : "",
      toolCalls: parseChatCompletionsToolCalls(message.tool_calls),
    };
  });
}

function parseChatCompletionsToolCalls(value: unknown): ProviderToolCall[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((toolCall, index): ProviderToolCall[] => {
    const record = toRecord(toolCall);
    const fn = record === null ? null : toRecord(record.function);
    if (fn === null || typeof fn.name !== "string" || !fn.name.trim()) return [];
    return [
      {
        id:
          record !== null &&
          typeof record.id === "string" &&
          record.id.trim()
            ? record.id.trim()
            : `lmstudio_call_${index}`,
        name: fn.name.trim(),
        input: parseArguments(fn.arguments),
      },
    ];
  });
}

function parseArguments(value: unknown): unknown {
  if (typeof value !== "string") return value ?? {};
  if (!value.trim()) return {};
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}

// ── Utilities ───────────────────────────────────────────────────────────

function parseError(response: Response): Effect<string, never> {
  return fromPromise(() => response.text()).pipe(
    Effect.catchAll(() => Effect.succeed("")),
    Effect.map((raw) => {
      try {
        const parsedRecord = toRecord(JSON.parse(raw));
        const parsedError =
          parsedRecord === null ? null : toRecord(parsedRecord.error);
        if (
          parsedError !== null &&
          typeof parsedError.message === "string" &&
          parsedError.message.trim()
        ) {
          return parsedError.message.trim();
        }
        if (
          parsedRecord !== null &&
          typeof parsedRecord.error === "string" &&
          parsedRecord.error.trim()
        ) {
          return parsedRecord.error.trim();
        }
      } catch {
        // Ignore JSON parse failures.
      }

      return raw.trim() || `Request failed with status ${response.status}.`;
    }),
  );
}

function toRecord(value: unknown): { [key: string]: unknown } | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record: { [key: string]: unknown } = {};
  for (const key of Object.keys(value)) record[key] = Reflect.get(value, key);
  return record;
}

function fromPromise<A>(thunk: () => Promise<A>): Effect<A, Error> {
  return Effect.tryPromise({ try: thunk, catch: toError });
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
