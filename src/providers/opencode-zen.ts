import { Effect } from "effect";
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
  ProviderCompletion,
  ProviderOption,
  ProviderRoundTripContext,
  ProviderSelection,
  ProviderToolCall,
} from "./index.ts";
import type { Tool } from "../tools/types.ts";

const PROVIDER_ID = "opencode";
const PROVIDER_NAME = "OpenCode";
const ZEN_BASE_URL = "https://opencode.ai/zen/v1";
const GO_BASE_URL = "https://opencode.ai/zen/go/v1";
const MODELS_DEV_URL = "https://models.dev/api.json";

const SUPPORTED_NPM_PACKAGES = new Set([
  "@ai-sdk/openai",
  "@ai-sdk/openai-compatible",
  "@ai-sdk/alibaba",
  "@ai-sdk/anthropic",
]);

// ── Shared sub-options ─────────────────────────────────────────────────

const REASONING_EFFORT_OPTION: ProviderOption = {
  id: "reasoning_effort",
  name: "Reasoning effort",
  choices: [
    { id: "low", name: "Low" },
    { id: "medium", name: "Medium" },
    { id: "high", name: "High" },
  ],
};

const TEXT_VERBOSITY_OPTION: ProviderOption = {
  id: "text_verbosity",
  name: "Text verbosity",
  choices: [
    { id: "low", name: "Low" },
    { id: "medium", name: "Medium" },
    { id: "high", name: "High" },
  ],
};

// ── Products ────────────────────────────────────────────────────────────

type ProductId = "zen" | "go";
type ProductConfig = {
  id: ProductId;
  label: string;
  providerKey: "opencode" | "opencode-go";
  baseUrl: string;
  modelsUrl: string;
  defaultNpm: string;
};

const PRODUCTS: readonly ProductConfig[] = [
  {
    id: "zen",
    label: "Zen",
    providerKey: "opencode",
    baseUrl: ZEN_BASE_URL,
    modelsUrl: `${ZEN_BASE_URL}/models`,
    defaultNpm: "@ai-sdk/openai-compatible",
  },
  {
    id: "go",
    label: "Go",
    providerKey: "opencode-go",
    baseUrl: GO_BASE_URL,
    modelsUrl: `${GO_BASE_URL}/models`,
    defaultNpm: "@ai-sdk/openai-compatible",
  },
];

// ── Model metadata types ────────────────────────────────────────────────

type SupportedAdapter = "responses" | "chat_completions";
type OpenCodeModelStatus = "alpha" | "beta" | "deprecated";

type OpenCodeModel = {
  selectionId: string;
  product: ProductId;
  id: string;
  name: string;
  apiUrl: string;
  npm: string;
  adapter: SupportedAdapter;
  status?: OpenCodeModelStatus;
  /** Whether model.dev metadata advertises reasoning support. */
  reasoning?: boolean;
  /** Whether model.dev metadata advertises temperature support. */
  temperature?: boolean;
};

// ── Authentication ──────────────────────────────────────────────────────

const ensureAuthenticated = (forceLogin: boolean): Effect.Effect<ProviderAuth, Error, TerminalService | ProviderAuthStoreService> =>
  Effect.gen(function* () {
    const terminal = yield* TerminalService;
    const authStore = yield* ProviderAuthStoreService;
    const savedAuth = authStore.get(PROVIDER_ID);

    if (!forceLogin && savedAuth !== null && savedAuth.access.trim()) {
      terminal.show({ type: "system", text: "Using saved OpenCode API key." });
      return savedAuth;
    }

    return yield* promptAndSaveAuth(terminal, authStore);
  });

// ── Option listing (per-model sub-options) ──────────────────────────────

const listOptions = (auth: ProviderAuth): Effect.Effect<ProviderOption[], Error, HttpClientService> =>
  Effect.gen(function* () {
    const models = yield* fetchSupportedModels(auth);
    if (models.length === 0) {
      return yield* Effect.fail(
        new Error("OpenCode returned no models supported by this Codewarper build."),
      );
    }

    return [
      {
        id: "model",
        name: "Model",
        choices: models.map((model) => ({
          id: model.selectionId,
          name: `${productLabel(model.product)} — ${model.name}`,
          options: buildModelOptions(model),
        })),
      },
    ];
  });

/**
 * Determine which sub-options to surface for a model based on model.dev
 * capability flags.
 */
function buildModelOptions(model: OpenCodeModel): ProviderOption[] | undefined {
  const options: ProviderOption[] = [];

  // Reasoning-effort and text-verbosity via the Responses API.
  // model.dev must explicitly set `reasoning: true` to show these.
  if (model.reasoning === true) {
    options.push(REASONING_EFFORT_OPTION, TEXT_VERBOSITY_OPTION);
  }

  return options.length > 0 ? options : undefined;
}

// ── Completion ──────────────────────────────────────────────────────────

function complete(
  auth: ProviderAuth,
  selection: ProviderSelection,
  history: Message[],
  systemPrompt: string,
  tools: readonly Tool[],
  signal?: AbortSignal,
): Effect.Effect<ProviderCompletion, Error, HttpClientService | TerminalService> {
  return Effect.gen(function* () {
    const selectedModel = selection.options.model;
    if (!selectedModel) return yield* Effect.fail(new Error("Missing required OpenCode option: model."));

    const models = yield* fetchSupportedModels(auth);
    const model = models.find((candidate) => candidate.selectionId === selectedModel);
    if (!model) {
      return yield* Effect.fail(new Error(`OpenCode model is unavailable or unsupported: ${selectedModel}.`));
    }

    if (model.adapter === "responses") {
      return yield* completeResponses(auth, model, selection, history, systemPrompt, tools, signal);
    }

    return yield* completeChatCompletions(auth, model, selection, history, systemPrompt, tools, signal);
  });
}

export const opencodeZenProvider: Provider = {
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
): Effect.Effect<ProviderAuth, Error> {
  return Effect.gen(function* () {
    const apiKey = (yield* fromPromise(() =>
      terminal.promptText("OpenCode API key (Zen or Go): ", { allowEmpty: false, signal: null }),
    )).trim();

    if (!apiKey) return yield* Effect.fail(new Error("OpenCode API key is required."));

    const auth = {
      access: apiKey,
      refresh: "",
      expires: Number.MAX_SAFE_INTEGER,
      accountId: "opencode",
    } satisfies ProviderAuth;

    authStore.set(PROVIDER_ID, auth);
    terminal.show({ type: "system", text: "OpenCode API key saved." });
    return auth;
  });
}

// ── Model fetching ──────────────────────────────────────────────────────

const fetchSupportedModels = (auth: ProviderAuth): Effect.Effect<OpenCodeModel[], Error, HttpClientService> =>
  Effect.gen(function* () {
    const results = yield* Effect.all(
      PRODUCTS.map((product) => Effect.either(fetchSupportedProductModels(auth, product))),
      { concurrency: "unbounded" },
    );

    const models = results.flatMap((result) => result._tag === "Right" ? result.right : []);
    if (models.length > 0) {
      return models.sort((left, right) => {
        const productOrder = productIndex(left.product) - productIndex(right.product);
        return productOrder === 0 ? left.name.localeCompare(right.name) : productOrder;
      });
    }

    const messages = results.flatMap((result) => result._tag === "Left" ? [result.left.message] : []);
    return yield* Effect.fail(new Error(`Could not fetch OpenCode model lists. ${messages.join(" ")}`));
  });

const fetchSupportedProductModels = (
  auth: ProviderAuth,
  product: ProductConfig,
): Effect.Effect<OpenCodeModel[], Error, HttpClientService> =>
  Effect.gen(function* () {
    const [available, metadata] = yield* Effect.all([
      fetchProductModelIds(auth, product),
      fetchModelsDevProductModels(product),
    ], { concurrency: "unbounded" });

    const availableSet = new Set(available);
    return metadata
      .filter((model) => availableSet.has(model.id))
      .filter((model) => model.status !== "deprecated")
      .filter((model) => SUPPORTED_NPM_PACKAGES.has(model.npm));
  });

const fetchProductModelIds = (auth: ProviderAuth, product: ProductConfig): Effect.Effect<string[], Error, HttpClientService> =>
  Effect.gen(function* () {
    const http = yield* HttpClientService;
    const response = yield* fromPromise(() =>
      http.fetch(product.modelsUrl, {
        method: "GET",
        headers: {
          accept: "application/json",
          Authorization: `Bearer ${auth.access}`,
        },
      }),
    );

    if (!response.ok) {
      const message = yield* parseError(response);
      return yield* Effect.fail(new Error(`Could not fetch OpenCode ${product.label} model list. ${message}`));
    }

    const body = yield* fromPromise(() => response.json());
    const bodyRecord = toRecord(body);
    if (bodyRecord === null || !Array.isArray(bodyRecord.data)) {
      return yield* Effect.fail(new Error(`OpenCode ${product.label} returned an unexpected model list.`));
    }

    return bodyRecord.data.flatMap((item): string[] => {
      const record = toRecord(item);
      return record !== null && typeof record.id === "string" && record.id.trim() ? [record.id.trim()] : [];
    });
  });

const fetchModelsDevProductModels = (product: ProductConfig): Effect.Effect<OpenCodeModel[], Error, HttpClientService> => Effect.gen(function* () {
  const http = yield* HttpClientService;
  const response = yield* fromPromise(() =>
    http.fetch(MODELS_DEV_URL, {
      method: "GET",
      headers: { accept: "application/json" },
    }),
  );

  if (!response.ok) {
    const message = yield* parseError(response);
    return yield* Effect.fail(new Error(`Could not fetch models.dev metadata. ${message}`));
  }

  const body = yield* fromPromise(() => response.json());
  const root = toRecord(body);
  const provider = root === null ? null : toRecord(root[product.providerKey]);
  const models = provider === null ? null : toRecord(provider.models);
  if (provider === null || models === null) {
    return yield* Effect.fail(new Error(`models.dev returned no OpenCode ${product.label} model metadata.`));
  }

  const providerApi = typeof provider.api === "string" && provider.api.trim() ? provider.api.trim() : product.baseUrl;
  const providerNpm = typeof provider.npm === "string" && provider.npm.trim() ? provider.npm.trim() : product.defaultNpm;

  return Object.entries(models).flatMap(([id, rawModel]): OpenCodeModel[] => {
    const record = toRecord(rawModel);
    if (record === null) return [];
    const providerOverride = toRecord(record.provider);
    const npm = readNonEmptyString(providerOverride?.npm) ?? providerNpm;
    const apiUrl = readNonEmptyString(providerOverride?.api) ?? providerApi;
    const name = readNonEmptyString(record.name) ?? id;
    const adapter = adapterFromNpm(npm);
    const status = parseModelStatus(record.status);
    if (adapter === null) return [];

    // Pull capability flags from model.dev metadata.
    const reasoning = typeof record.reasoning === "boolean" ? record.reasoning : undefined;
    const temperature = typeof record.temperature === "boolean" ? record.temperature : undefined;

    return [{
      selectionId: `${product.id}:${id}`,
      product: product.id,
      id,
      name,
      apiUrl,
      npm,
      adapter,
      ...(status ? { status } : {}),
      ...(reasoning !== undefined ? { reasoning } : {}),
      ...(temperature !== undefined ? { temperature } : {}),
    }];
  });
});

function adapterFromNpm(npm: string): SupportedAdapter | null {
  if (npm === "@ai-sdk/openai") return "responses";
  if (npm === "@ai-sdk/openai-compatible") return "chat_completions";
  if (npm === "@ai-sdk/alibaba") return "chat_completions";
  if (npm === "@ai-sdk/anthropic") return "chat_completions";
  return null;
}

function productLabel(product: ProductId): string {
  return PRODUCTS.find((candidate) => candidate.id === product)?.label ?? product;
}

function productIndex(product: ProductId): number {
  return PRODUCTS.findIndex((candidate) => candidate.id === product);
}

function readNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function parseModelStatus(value: unknown): OpenCodeModelStatus | undefined {
  if (value === "alpha" || value === "beta" || value === "deprecated") return value;
  return undefined;
}

// ── Responses API completion ────────────────────────────────────────────

function completeResponses(
  auth: ProviderAuth,
  model: OpenCodeModel,
  selection: ProviderSelection,
  history: Message[],
  systemPrompt: string,
  tools: readonly Tool[],
  signal?: AbortSignal,
): Effect.Effect<ProviderCompletion, Error, HttpClientService> {
  return Effect.gen(function* () {
    const http = yield* HttpClientService;
    const response = yield* fromPromise(() =>
      http.fetch(resolveResponsesUrl(model.apiUrl), {
        method: "POST",
        headers: {
          Authorization: `Bearer ${auth.access}`,
          accept: "text/event-stream",
          "content-type": "application/json",
        },
        body: JSON.stringify(createResponsesRequestBody(model, selection, history, systemPrompt, tools)),
        signal,
      }),
    );

    if (!response.ok) {
      const message = yield* parseError(response);
      return yield* Effect.fail(new Error(message));
    }

    return yield* collectResponsesStream(response, signal);
  });
}

// ── Chat completions completion ─────────────────────────────────────────

function completeChatCompletions(
  auth: ProviderAuth,
  model: OpenCodeModel,
  selection: ProviderSelection,
  history: Message[],
  systemPrompt: string,
  tools: readonly Tool[],
  signal?: AbortSignal,
): Effect.Effect<ProviderCompletion, Error, HttpClientService> {
  return Effect.gen(function* () {
    const http = yield* HttpClientService;
    const response = yield* fromPromise(() =>
      http.fetch(resolveChatCompletionsUrl(model.apiUrl), {
        method: "POST",
        headers: {
          Authorization: `Bearer ${auth.access}`,
          accept: "application/json",
          "content-type": "application/json",
        },
        body: JSON.stringify(createChatCompletionsRequestBody(model, selection, history, systemPrompt, tools)),
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

// ── URL resolution ──────────────────────────────────────────────────────

function resolveResponsesUrl(baseUrl: string): string {
  const normalized = baseUrl.replace(/\/+$/, "");
  if (normalized.endsWith("/responses")) return normalized;
  return `${normalized}/responses`;
}

function resolveChatCompletionsUrl(baseUrl: string): string {
  const normalized = baseUrl.replace(/\/+$/, "");
  if (normalized.endsWith("/chat/completions")) return normalized;
  if (normalized.endsWith("/chat")) return `${normalized}/completions`;
  return `${normalized}/chat/completions`;
}

// ── Request body construction ───────────────────────────────────────────

function createResponsesRequestBody(
  model: OpenCodeModel,
  selection: ProviderSelection,
  history: Message[],
  systemPrompt: string,
  tools: readonly Tool[],
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: model.id,
    store: false,
    stream: true,
    instructions: systemPrompt,
    input: messagesToResponsesInput(history),
  };

  if (tools.length > 0) {
    body.tools = createResponsesTools(tools);
    body.tool_choice = "auto";
    body.parallel_tool_calls = true;
  }

  if (selection.options.reasoning_effort) {
    body.reasoning = { effort: selection.options.reasoning_effort };
  }
  if (selection.options.text_verbosity) {
    body.text = { verbosity: selection.options.text_verbosity };
  }

  return body;
}

function createChatCompletionsRequestBody(
  model: OpenCodeModel,
  selection: ProviderSelection,
  history: Message[],
  systemPrompt: string,
  tools: readonly Tool[],
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: model.id,
    stream: false,
    messages: messagesToChatCompletionsMessages(systemPrompt, history),
  };

  if (tools.length > 0) {
    body.tools = createChatCompletionsTools(tools);
    body.tool_choice = "auto";
  }

  return body;
}

// ── Tool formatting ─────────────────────────────────────────────────────

const createResponsesTools = (tools: readonly Tool[]) =>
  tools.map((tool) => ({ type: "function", name: tool.name, description: tool.description, parameters: tool.inputSchema, strict: false }));

const createChatCompletionsTools = (tools: readonly Tool[]) =>
  tools.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
    },
  }));

// ── Message formatting for Responses API ────────────────────────────────

const messagesToResponsesInput = (history: Message[]) => history.flatMap(messageToResponsesInput);

function messageToResponsesInput(message: Message, index: number): unknown[] {
  if (message.type === "user") return [{ role: "user", content: [{ type: "input_text", text: message.text }] }];
  if (message.type === "tool_result") {
    return [{ type: "function_call_output", call_id: splitToolCallId(message.toolCallId).callId, output: message.content }];
  }

  const output: unknown[] = [];
  if (message.text.trim()) {
    output.push({
      type: "message",
      role: "assistant",
      id: `msg_${index}`,
      status: "completed",
      content: [{ type: "output_text", text: message.text, annotations: [] }],
    });
  }

  for (const toolCall of message.toolCalls ?? []) {
    const { callId, itemId } = splitToolCallId(toolCall.id);
    output.push({
      type: "function_call",
      ...(itemId ? { id: itemId } : {}),
      call_id: callId,
      name: toolCall.name,
      arguments: JSON.stringify(toolCall.input),
    });
  }

  return output;
}

// ── Message formatting for Chat Completions ─────────────────────────────

const CHAT_COMPLETIONS_ROUND_TRIP_KIND = "codewarper.opencodeZen.chatCompletions.v1" as const;

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
      // DeepSeek thinking models require `reasoning_content` on every assistant
      // message when replaying history; empty string is accepted. Payload lives
      // in `roundTripContext` (see encodeChatCompletionsRoundTrip).
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

// ── SSE stream accumulation (Responses API) ─────────────────────────────

type StreamAccumulator = {
  accumulatedText: string;
  completedMessageText: string;
  toolCalls: ProviderToolCall[];
  pendingFunctionCalls: Record<string, PendingFunctionCall>;
  pendingFunctionCallOrder: string[];
};

type PendingFunctionCall = {
  callId: string;
  itemId: string | null;
  name: string;
  argumentsJson: string;
};

const initialResponsesAccumulator = (): StreamAccumulator => ({
  accumulatedText: "",
  completedMessageText: "",
  toolCalls: [],
  pendingFunctionCalls: {},
  pendingFunctionCallOrder: [],
});

function parseSseEvent(chunk: string): { [key: string]: unknown } | null {
  const data = chunk
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim())
    .join("\n")
    .trim();
  if (!data || data === "[DONE]") return null;
  try {
    const parsedRecord = toRecord(JSON.parse(data));
    return parsedRecord !== null ? parsedRecord : null;
  } catch {
    return null;
  }
}

function splitStreamBuffer(buffer: string): { chunks: string[]; remainder: string } {
  const chunks: string[] = [];
  let remainder = buffer;
  let separatorIndex = remainder.indexOf("\n\n");
  while (separatorIndex !== -1) {
    chunks.push(remainder.slice(0, separatorIndex));
    remainder = remainder.slice(separatorIndex + 2);
    separatorIndex = remainder.indexOf("\n\n");
  }
  return { chunks, remainder };
}

type ResponseEventReduction = { state: StreamAccumulator; doneCompletion: ProviderCompletion | null; errorMessage: string | null };

function reduceResponsesEvent(state: StreamAccumulator, event: { [key: string]: unknown }): ResponseEventReduction {
  const errorMessage = readResponsesErrorMessage(event);
  if (errorMessage) return { state, doneCompletion: null, errorMessage };
  if (event.type === "response.output_text.delta" && typeof event.delta === "string") return { state: appendDelta(state, event.delta), doneCompletion: null, errorMessage: null };
  if (event.type === "response.refusal.delta" && typeof event.delta === "string") return { state: appendDelta(state, event.delta), doneCompletion: null, errorMessage: null };
  if (event.type === "response.output_item.added") return { state: upsertPendingFunctionCall(state, event.item), doneCompletion: null, errorMessage: null };
  if (event.type === "response.function_call_arguments.delta") return { state: appendFunctionCallArguments(state, event.item_id, event.delta), doneCompletion: null, errorMessage: null };
  if (event.type === "response.function_call_arguments.done") return { state: replaceFunctionCallArguments(state, event.item_id, event.arguments), doneCompletion: null, errorMessage: null };
  if (event.type === "response.output_item.done") return { state: completeFunctionCall(rememberCompletedMessage(state, extractModelTextFromOutputItem(event.item)), event.item), doneCompletion: null, errorMessage: null };
  if (event.type === "response.completed" || event.type === "response.incomplete" || event.type === "response.done") return { state, doneCompletion: finalizeCompletion(state), errorMessage: null };
  return { state, doneCompletion: null, errorMessage: null };
}

function readResponsesErrorMessage(event: { [key: string]: unknown }): string {
  if (event.type === "error" && typeof event.message === "string" && event.message.trim()) return event.message.trim();
  if (event.type !== "response.failed") return "";
  const response = toRecord(event.response);
  const error = response === null ? null : toRecord(response.error);
  if (error !== null && typeof error.message === "string" && error.message.trim()) return error.message.trim();
  return "OpenCode response failed.";
}

type StreamStep =
  | { readonly _tag: "Continue"; readonly buffer: string; readonly accumulator: StreamAccumulator }
  | { readonly _tag: "Done"; readonly value: ProviderCompletion };

const collectResponsesStream = (response: Response, signal?: AbortSignal): Effect.Effect<ProviderCompletion, Error> =>
  Effect.gen(function* () {
    if (!response.body) return yield* Effect.fail(new Error("OpenCode returned no response body."));
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const initialStep: StreamStep = { _tag: "Continue", buffer: "", accumulator: initialResponsesAccumulator() };
    try {
      const finalStep = yield* Effect.iterate<StreamStep, never, Error>(initialStep, {
        while: (step): boolean => step._tag === "Continue",
        body: (step) => Effect.gen(function* () {
          if (step._tag === "Done") return step;

          // Check for abort signal between iterations
          if (signal?.aborted) {
            return yield* Effect.fail(new Error(signal.reason ? String(signal.reason) : "Interrupted."));
          }

          const { done, value } = yield* fromPromise(() => reader.read());
          if (done) {
            const completion = finalizeCompletion(step.accumulator);
            if (completion.text || completion.toolCalls.length > 0) return { _tag: "Done" as const, value: completion };
            return yield* Effect.fail(new Error("OpenCode returned no model output."));
          }

          const buffer = step.buffer + decoder.decode(value, { stream: true });
          const { chunks, remainder } = splitStreamBuffer(buffer);
          let accumulator = step.accumulator;
          for (const chunk of chunks) {
            const event = parseSseEvent(chunk);
            if (!event) continue;
            const next = reduceResponsesEvent(accumulator, event);
            if (next.errorMessage) return yield* Effect.fail(new Error(next.errorMessage));
            accumulator = next.state;
            if (next.doneCompletion !== null) return { _tag: "Done" as const, value: next.doneCompletion };
          }
          return { _tag: "Continue" as const, buffer: remainder, accumulator };
        }),
      });

      if (finalStep._tag === "Done") return finalStep.value;
      return yield* Effect.fail(new Error("OpenCode stream ended in an unexpected state."));
    } finally {
      yield* fromPromise(() => reader.cancel().catch(() => undefined));
      yield* Effect.sync(() => { try { reader.releaseLock(); } catch {} });
    }
  });

function appendDelta(state: StreamAccumulator, delta: string): StreamAccumulator {
  return { ...state, accumulatedText: state.accumulatedText + delta };
}

function rememberCompletedMessage(state: StreamAccumulator, text: string): StreamAccumulator {
  return text === "" ? state : { ...state, completedMessageText: text };
}

function finalizeCompletion(state: StreamAccumulator): ProviderCompletion {
  return {
    text: (state.accumulatedText.trim() || state.completedMessageText.trim()),
    toolCalls: [...state.toolCalls, ...finalizePendingFunctionCalls(state)],
  };
}

function upsertPendingFunctionCall(state: StreamAccumulator, item: unknown): StreamAccumulator {
  const itemRecord = toRecord(item);
  if (itemRecord === null || itemRecord.type !== "function_call") return state;
  const callId = typeof itemRecord.call_id === "string" ? itemRecord.call_id : "";
  const name = typeof itemRecord.name === "string" ? itemRecord.name : "";
  if (!callId || !name) return state;
  const itemId = typeof itemRecord.id === "string" && itemRecord.id ? itemRecord.id : null;
  const key = itemId ?? callId;
  const existing = state.pendingFunctionCalls[key];
  const argumentsJson = typeof itemRecord.arguments === "string" ? itemRecord.arguments : existing?.argumentsJson ?? "";
  return {
    ...state,
    pendingFunctionCalls: { ...state.pendingFunctionCalls, [key]: { callId, itemId, name, argumentsJson } },
    pendingFunctionCallOrder: existing ? state.pendingFunctionCallOrder : [...state.pendingFunctionCallOrder, key],
  };
}

function appendFunctionCallArguments(state: StreamAccumulator, itemId: unknown, delta: unknown): StreamAccumulator {
  if (typeof delta !== "string") return state;
  const key = resolvePendingFunctionCallKey(state, itemId);
  if (key === null) return state;
  const pending = state.pendingFunctionCalls[key];
  if (!pending) return state;
  return { ...state, pendingFunctionCalls: { ...state.pendingFunctionCalls, [key]: { ...pending, argumentsJson: pending.argumentsJson + delta } } };
}

function replaceFunctionCallArguments(state: StreamAccumulator, itemId: unknown, args: unknown): StreamAccumulator {
  if (typeof args !== "string") return state;
  const key = resolvePendingFunctionCallKey(state, itemId);
  if (key === null) return state;
  const pending = state.pendingFunctionCalls[key];
  if (!pending) return state;
  return { ...state, pendingFunctionCalls: { ...state.pendingFunctionCalls, [key]: { ...pending, argumentsJson: args } } };
}

function completeFunctionCall(state: StreamAccumulator, item: unknown): StreamAccumulator {
  const stateWithPending = upsertPendingFunctionCall(state, item);
  const itemRecord = toRecord(item);
  if (itemRecord === null || itemRecord.type !== "function_call") return stateWithPending;
  const itemId = typeof itemRecord.id === "string" && itemRecord.id ? itemRecord.id : null;
  const callId = typeof itemRecord.call_id === "string" ? itemRecord.call_id : "";
  const key = resolvePendingFunctionCallKey(stateWithPending, itemId ?? callId);
  if (key === null) return stateWithPending;
  const pending = stateWithPending.pendingFunctionCalls[key];
  if (!pending) return stateWithPending;
  const toolCall = pendingToToolCall(pending);
  const { [key]: _removed, ...remaining } = stateWithPending.pendingFunctionCalls;
  return {
    ...stateWithPending,
    toolCalls: stateWithPending.toolCalls.some((call) => call.id === toolCall.id) ? stateWithPending.toolCalls : [...stateWithPending.toolCalls, toolCall],
    pendingFunctionCalls: remaining,
    pendingFunctionCallOrder: stateWithPending.pendingFunctionCallOrder.filter((k) => k !== key),
  };
}

const finalizePendingFunctionCalls = (state: StreamAccumulator): ProviderToolCall[] =>
  state.pendingFunctionCallOrder.flatMap((key) => {
    const pending = state.pendingFunctionCalls[key];
    return pending ? [pendingToToolCall(pending)] : [];
  });

function resolvePendingFunctionCallKey(state: StreamAccumulator, itemId: unknown): string | null {
  if (typeof itemId === "string" && itemId && state.pendingFunctionCalls[itemId]) return itemId;
  return state.pendingFunctionCallOrder.at(-1) ?? null;
}

function pendingToToolCall(pending: PendingFunctionCall): ProviderToolCall {
  return {
    id: pending.itemId ? `${pending.callId}|${pending.itemId}` : pending.callId,
    name: pending.name,
    input: parseArguments(pending.argumentsJson),
  };
}

function extractModelTextFromOutputItem(item: unknown): string {
  const itemRecord = toRecord(item);
  if (itemRecord === null || itemRecord.type !== "message") return "";
  return extractContentText(itemRecord.content).join("").trim();
}

function extractContentText(content: unknown): string[] {
  if (!Array.isArray(content)) return [];
  return content.flatMap((part) => {
    const partRecord = toRecord(part);
    if (partRecord === null || typeof partRecord.type !== "string") return [];
    if (partRecord.type === "output_text" && typeof partRecord.text === "string") return [partRecord.text];
    if (partRecord.type === "refusal" && typeof partRecord.refusal === "string") return [partRecord.refusal];
    return [];
  });
}

// ── Chat completions response parsing ───────────────────────────────────

function parseChatCompletionsResponse(response: Response): Effect.Effect<ProviderCompletion, Error> {
  return Effect.gen(function* () {
    const body = yield* fromPromise(() => response.json());
    const bodyRecord = toRecord(body);
    const choices = bodyRecord === null ? null : bodyRecord.choices;
    const firstChoice = Array.isArray(choices) ? toRecord(choices[0]) : null;
    const message = firstChoice === null ? null : toRecord(firstChoice.message);
    if (bodyRecord === null || message === null) {
      return yield* Effect.fail(new Error("OpenCode returned an unexpected chat completions response."));
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
        id: record !== null && typeof record.id === "string" && record.id.trim() ? record.id.trim() : `chatcmpl_call_${index}`,
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

const parseError = (response: Response): Effect.Effect<string, never> =>
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

function fromPromise<A>(thunk: () => Promise<A>): Effect.Effect<A, Error> {
  return Effect.tryPromise({ try: thunk, catch: toError });
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
