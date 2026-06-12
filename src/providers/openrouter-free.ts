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
  ProviderRoundTripContext,
  ProviderSelection,
  ProviderToolCall,
} from "./index.ts";
import type { Tool } from "../tools/types.ts";

const PROVIDER_ID = "openrouter";
const PROVIDER_NAME = "OpenRouter";
const BASE_URL = "https://openrouter.ai/api/v1";

const CHAT_COMPLETIONS_ROUND_TRIP_KIND = "codewarper.openrouterFree.chatCompletions.v1" as const;

type ChatCompletionsRoundTripV1 = {
  readonly kind: typeof CHAT_COMPLETIONS_ROUND_TRIP_KIND;
  readonly reasoningContent: string;
};

function encodeChatCompletionsRoundTrip(reasoningContent: string): ProviderRoundTripContext {
  return { kind: CHAT_COMPLETIONS_ROUND_TRIP_KIND, reasoningContent } satisfies ChatCompletionsRoundTripV1;
}

function reasoningContentForChatRequest(roundTrip: ProviderRoundTripContext | undefined): string {
  if (!roundTrip || typeof roundTrip !== "object" || Array.isArray(roundTrip)) return "";
  const record = roundTrip as { kind?: unknown; reasoningContent?: unknown };
  if (record.kind !== CHAT_COMPLETIONS_ROUND_TRIP_KIND) return "";
  return typeof record.reasoningContent === "string" ? record.reasoningContent : "";
}

const ensureAuthenticated = (forceLogin: boolean): Effect<ProviderAuth, Error, ProviderAuthR> =>
  Effect.gen(function* () {
    const terminal = yield* TerminalService;
    const authStore = yield* ProviderAuthStoreService;
    const savedAuth = authStore.get(PROVIDER_ID);

    if (!forceLogin && savedAuth !== null && savedAuth.access.trim()) {
      terminal.show({ type: "system", text: "Using saved OpenRouter API key." });
      return savedAuth;
    }

    return yield* promptAndSaveAuth(terminal, authStore);
  });

const listOptions = (auth: ProviderAuth): Effect<ProviderOption[], Error, ProviderClientR> =>
  Effect.gen(function* () {
    const models: OpenRouterModel[] = yield* fetchModels(auth);

    const choices = models.map((model: OpenRouterModel) => ({ id: model.id, name: model.name }));

    // Always offer OpenRouter's automatic router as the top choice.
    choices.unshift({
      id: "openrouter/auto",
      name: "Auto (openrouter/auto - picks best model per request)",
    });

    if (models.length === 0) {
      return yield* Effect.fail(
        new Error("OpenRouter returned no models. Visit https://openrouter.ai/models for available models."),
      );
    }

    return [
      {
        id: "model",
        name: "Model",
        choices,
      },
    ];
  });

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
    if (!modelId) return yield* Effect.fail(new Error("Missing required OpenRouter option: model."));

    return yield* completeChatCompletions(auth, modelId, history, systemPrompt, tools, signal);
  });
}

export const openrouterProvider: Provider = {
  id: PROVIDER_ID,
  name: PROVIDER_NAME,
  ensureAuthenticated,
  listOptions,
  complete,
};

function promptAndSaveAuth(
  terminal: Terminal,
  authStore: ProviderAuthStore,
): Effect<ProviderAuth, Error> {
  return Effect.gen(function* () {
    const apiKey = (yield* fromPromise(() =>
      terminal.promptText("OpenRouter API key (get one at https://openrouter.ai/keys): ", { allowEmpty: false, signal: null }),
    )).trim();

    if (!apiKey) return yield* Effect.fail(new Error("OpenRouter API key is required."));

    const auth = {
      access: apiKey,
      refresh: "",
      expires: Number.MAX_SAFE_INTEGER,
      accountId: "openrouter",
    } satisfies ProviderAuth;

    authStore.set(PROVIDER_ID, auth);
    terminal.show({ type: "system", text: "OpenRouter API key saved." });
    return auth;
  });
}

type OpenRouterModel = {
  id: string;
  name: string;
};

const fetchModels = (auth: ProviderAuth): Effect<OpenRouterModel[], Error, ProviderClientR> =>
  Effect.gen(function* () {
    const http = yield* HttpClientService;
    const response = yield* fromPromise(() =>
      http.fetch(`${BASE_URL}/models?supported_parameters=tools`, {
        method: "GET",
        headers: {
          accept: "application/json",
          Authorization: `Bearer ${auth.access}`,
        },
      }),
    );

    if (!response.ok) {
      const message = yield* parseError(response);
      return yield* Effect.fail(new Error(`Could not fetch OpenRouter model list. ${message}`));
    }

    const body = yield* fromPromise(() => response.json());
    const bodyRecord = toRecord(body);
    if (bodyRecord === null || !Array.isArray(bodyRecord.data)) {
      return yield* Effect.fail(new Error("OpenRouter returned an unexpected model list."));
    }

    return bodyRecord.data.flatMap((item): OpenRouterModel[] => {
      const record = toRecord(item);
      if (record === null) return [];
      const id = typeof record.id === "string" && record.id.trim() ? record.id.trim() : "";
      if (!id) return [];
      const name = typeof record.name === "string" && record.name.trim() ? record.name.trim() : id;

      return [{ id, name }];
    }).sort((left, right) => left.name.localeCompare(right.name));
  });

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
    const response = yield* fromPromise(() =>
      http.fetch(`${BASE_URL}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${auth.access}`,
          "Content-Type": "application/json",
          "HTTP-Referer": "https://codewarper.ai",
          "X-OpenRouter-Title": "Codewarper",
        },
        body: JSON.stringify(createChatCompletionsRequestBody(modelId, history, systemPrompt, tools)),
        signal,
      }),
    );

    if (!response.ok) {
      const message = yield* parseError(response);
      return yield* Effect.fail(new Error(message));
    }

    return yield* parseChatCompletionsResponse(response);
  });
}

const createChatCompletionsRequestBody = (
  modelId: string,
  history: Message[],
  systemPrompt: string,
  tools: readonly Tool[],
) => ({
  model: modelId,
  stream: false,
  messages: messagesToChatCompletionsMessages(systemPrompt, history),
  ...(tools.length > 0 ? { tools: createChatCompletionsTools(tools), tool_choice: "auto", parallel_tool_calls: true } : {}),
});

const createChatCompletionsTools = (tools: readonly Tool[]) =>
  tools.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
    },
  }));

function messagesToChatCompletionsMessages(systemPrompt: string, history: Message[]): unknown[] {
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
        reasoning_content: reasoningContentForChatRequest(message.roundTripContext),
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

function parseChatCompletionsResponse(response: Response): Effect<ProviderCompletion, Error> {
  return Effect.gen(function* () {
    const body = yield* fromPromise(() => response.json());
    const bodyRecord = toRecord(body);
    const choices = bodyRecord === null ? null : bodyRecord.choices;
    const firstChoice = Array.isArray(choices) ? toRecord(choices[0]) : null;
    const message = firstChoice === null ? null : toRecord(firstChoice.message);
    if (bodyRecord === null || message === null) {
      return yield* Effect.fail(new Error("OpenRouter returned an unexpected chat completions response."));
    }

    const reasoningRaw = typeof message.reasoning_content === "string" ? message.reasoning_content : "";
    return {
      text: typeof message.content === "string" ? message.content : "",
      toolCalls: parseChatCompletionsToolCalls(message.tool_calls),
      roundTripContext: encodeChatCompletionsRoundTrip(reasoningRaw),
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
        id: record !== null && typeof record.id === "string" && record.id.trim() ? record.id.trim() : `openrouter_call_${index}`,
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

const parseError = (response: Response): Effect<string, never> =>
  fromPromise(() => response.text()).pipe(
    Effect.catchAll(() => Effect.succeed("")),
    Effect.map((raw) => {
      try {
        const parsedRecord = toRecord(JSON.parse(raw));
        const parsedError = parsedRecord === null ? null : toRecord(parsedRecord.error);
        if (parsedError !== null && typeof parsedError.message === "string" && parsedError.message.trim()) {
          return parsedError.message.trim();
        }
        if (parsedRecord !== null && typeof parsedRecord.error === "string" && parsedRecord.error.trim()) {
          return parsedRecord.error.trim();
        }
      } catch {
        // Ignore JSON parse failures.
      }

      return raw.trim() || `Request failed with status ${response.status}.`;
    }),
  );

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
