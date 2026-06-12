import { Effect } from "#effect";
import {
  ClockService,
  CryptoService,
  HttpClientService,
  OAuthService,
  ProviderAuthStoreService,
  SystemInfoService,
  TerminalService,
  type Clock,
  type Crypto,
  type HttpClient,
  type OAuth,
  type ProviderAuthStore,
  type SystemInfo,
  type Terminal,
  type ProviderAuth,
} from "./services.ts";
import { loginOpenAICodex, refreshOpenAICodexAuth } from "./openai-codex-oauth.ts";
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

const PROVIDER_ID = "openai-codex";
const PROVIDER_NAME = "ChatGPT Plus/Pro (Codex Subscription)";
const DEFAULT_BASE_URL = "https://chatgpt.com/backend-api";
const ORIGINATOR = "pi";
const AUTH_EXPIRY_GRACE_MS = 60_000;
const AUTH_STATUS_KEY = "codewarperAuthStatus";

/** Reasoning-effort and text-verbosity nested under each model choice. */
const MODEL_OPTIONS: ProviderOption[] = [
  {
    id: "reasoning_effort",
    name: "Reasoning effort",
    choices: [
      { id: "low", name: "Low" },
      { id: "medium", name: "Medium" },
      { id: "high", name: "High" },
    ],
  },
  {
    id: "text_verbosity",
    name: "Text verbosity",
    choices: [
      { id: "low", name: "Low" },
      { id: "medium", name: "Medium" },
      { id: "high", name: "High" },
    ],
  },
];

const OPTIONS: ProviderOption[] = [
  {
    id: "model",
    name: "Model",
    choices: [
      { id: "gpt-5.5", name: "GPT-5.5", options: MODEL_OPTIONS },
      { id: "gpt-5.4", name: "GPT-5.4", options: MODEL_OPTIONS },
      { id: "gpt-5.4-mini", name: "GPT-5.4 Mini", options: MODEL_OPTIONS },
    ],
  },
];

function withAuthStatus(auth: ProviderAuth, status: string): ProviderAuth {
  return { ...auth, [AUTH_STATUS_KEY]: status };
}

const ensureAuthenticated = (forceLogin: boolean): Effect<ProviderAuth, Error, ProviderAuthR> =>
  Effect.gen(function* () {
    const terminal = yield* TerminalService;
    const authStore = yield* ProviderAuthStoreService;
    const clock = yield* ClockService;
    const oauth = yield* OAuthService;
    const crypto = yield* CryptoService;
    const http = yield* HttpClientService;
    const savedAuth = authStore.get(PROVIDER_ID);

    if (!forceLogin && savedAuth !== null && savedAuth.expires > clock.now() + AUTH_EXPIRY_GRACE_MS) {
      return withAuthStatus(savedAuth, "Using saved OpenAI Codex login.");
    }

    if (!forceLogin && savedAuth !== null && savedAuth.refresh) {
      const refreshed = yield* Effect.either(refreshAndSaveAuth(authStore, { http, clock, crypto }, savedAuth));
      if (refreshed._tag === "Right") return withAuthStatus(refreshed.right, "Refreshed saved OpenAI Codex login.");
      terminal.show({
        type: "system",
        text: "Saved OpenAI Codex login could not be refreshed. Starting a new login.",
      });
    }

    return yield* loginAndSaveAuth(authStore, { terminal, http, clock, oauth, crypto });
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
    validateSelection(selection);
    const http = yield* HttpClientService;
    const systemInfo = yield* SystemInfoService;
    const response = yield* fromPromise(() =>
      http.fetch(resolveUrl(), {
        method: "POST",
        headers: buildHeaders(systemInfo, auth),
        body: JSON.stringify(createRequestBody(selection, history, systemPrompt, tools)),
        signal,
      }),
    );

    if (!response.ok) {
      const message = yield* parseError(response);
      return yield* Effect.fail(new Error(message));
    }

    return yield* collectStreamedCompletion(response, signal);
  });
}

const listOptions = (_auth: ProviderAuth): Effect<ProviderOption[], Error, ProviderClientR> => Effect.succeed(OPTIONS);

export const openaiCodexProvider: Provider = {
  id: PROVIDER_ID,
  name: PROVIDER_NAME,
  ensureAuthenticated,
  listOptions,
  complete,
};

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

const resolveUrl = (baseUrl: string = DEFAULT_BASE_URL): string => {
  const normalized = baseUrl.replace(/\/+$/, "");
  if (normalized.endsWith("/codex/responses")) return normalized;
  if (normalized.endsWith("/codex")) return `${normalized}/responses`;
  return `${normalized}/codex/responses`;
};

const createUserAgent = (systemInfo: SystemInfo): string =>
  `codewarper (${systemInfo.platform()} ${systemInfo.release()}; ${systemInfo.arch()})`;

const buildHeaders = (systemInfo: SystemInfo, auth: ProviderAuth): Headers =>
  new Headers({
    Authorization: `Bearer ${auth.access}`,
    "chatgpt-account-id": auth.accountId,
    originator: ORIGINATOR,
    "User-Agent": createUserAgent(systemInfo),
    "OpenAI-Beta": "responses=experimental",
    accept: "text/event-stream",
    "content-type": "application/json",
  });

const messageToInput = (message: Message, index: number): unknown[] => {
  if (message.type === "user") {
    return [{ role: "user", content: [{ type: "input_text", text: message.text }] }];
  }

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
};

const splitToolCallId = (id: string): { callId: string; itemId: string | null } => {
  const [callId, itemId] = id.split("|", 2);
  return { callId: callId || id, itemId: itemId || null };
};

const messagesToInput = (history: Message[]) => history.flatMap(messageToInput);

const createTools = (tools: readonly Tool[]) =>
  tools.map((tool) => ({ type: "function", name: tool.name, description: tool.description, parameters: tool.inputSchema, strict: false }));

const extractContentText = (content: unknown): string[] => {
  if (!Array.isArray(content)) return [];
  return content.flatMap((part) => {
    const partRecord = toRecord(part);
    if (partRecord === null || typeof partRecord.type !== "string") return [];
    if (partRecord.type === "output_text" && typeof partRecord.text === "string") return [partRecord.text];
    if (partRecord.type === "refusal" && typeof partRecord.refusal === "string") return [partRecord.refusal];
    return [];
  });
};

const extractModelTextFromOutputItem = (item: unknown): string => {
  const itemRecord = toRecord(item);
  if (itemRecord === null || itemRecord.type !== "message") return "";
  return extractContentText(itemRecord.content).join("").trim();
};

const finalizeStreamText = ({ accumulatedText, completedMessageText }: StreamAccumulator): string =>
  accumulatedText.trim() || completedMessageText.trim();

const appendDelta = (state: StreamAccumulator, delta: string): StreamAccumulator => ({ ...state, accumulatedText: state.accumulatedText + delta });

const rememberCompletedMessage = (state: StreamAccumulator, text: string): StreamAccumulator => text === "" ? state : { ...state, completedMessageText: text };

const finalizeCompletion = (state: StreamAccumulator): ProviderCompletion => ({
  text: finalizeStreamText(state),
  toolCalls: [...state.toolCalls, ...finalizePendingFunctionCalls(state)],
});

const upsertPendingFunctionCall = (state: StreamAccumulator, item: unknown): StreamAccumulator => {
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
};

const appendFunctionCallArguments = (state: StreamAccumulator, itemId: unknown, delta: unknown): StreamAccumulator => {
  if (typeof delta !== "string") return state;
  const key = resolvePendingFunctionCallKey(state, itemId);
  if (key === null) return state;
  const pending = state.pendingFunctionCalls[key];
  if (!pending) return state;
  return { ...state, pendingFunctionCalls: { ...state.pendingFunctionCalls, [key]: { ...pending, argumentsJson: pending.argumentsJson + delta } } };
};

const replaceFunctionCallArguments = (state: StreamAccumulator, itemId: unknown, args: unknown): StreamAccumulator => {
  if (typeof args !== "string") return state;
  const key = resolvePendingFunctionCallKey(state, itemId);
  if (key === null) return state;
  const pending = state.pendingFunctionCalls[key];
  if (!pending) return state;
  return { ...state, pendingFunctionCalls: { ...state.pendingFunctionCalls, [key]: { ...pending, argumentsJson: args } } };
};

const completeFunctionCall = (state: StreamAccumulator, item: unknown): StreamAccumulator => {
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
};

const finalizePendingFunctionCalls = (state: StreamAccumulator): ProviderToolCall[] =>
  state.pendingFunctionCallOrder.flatMap((key) => {
    const pending = state.pendingFunctionCalls[key];
    return pending ? [pendingToToolCall(pending)] : [];
  });

const resolvePendingFunctionCallKey = (state: StreamAccumulator, itemId: unknown): string | null => {
  if (typeof itemId === "string" && itemId && state.pendingFunctionCalls[itemId]) return itemId;
  return state.pendingFunctionCallOrder.at(-1) ?? null;
};

const pendingToToolCall = (pending: PendingFunctionCall): ProviderToolCall => ({
  id: pending.itemId ? `${pending.callId}|${pending.itemId}` : pending.callId,
  name: pending.name,
  input: parseArguments(pending.argumentsJson),
});

const parseArguments = (raw: string): unknown => {
  if (!raw.trim()) return {};
  try { return JSON.parse(raw); } catch { return {}; }
};

const parseSseEvent = (chunk: string): { [key: string]: unknown } | null => {
  const data = chunk.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).join("\n").trim();
  if (!data || data === "[DONE]") return null;
  try {
    const parsedRecord = toRecord(JSON.parse(data));
    return parsedRecord !== null ? parsedRecord : null;
  } catch { return null; }
};

const readFailedResponseMessage = (event: { [key: string]: unknown }): string => {
  if (event.type === "error" && typeof event.message === "string" && event.message.trim()) return event.message.trim();
  if (event.type !== "response.failed") return "";
  let response: { [key: string]: unknown } | null = null;
  const eventResponse = toRecord(event.response);
  if (eventResponse !== null) response = eventResponse;
  let error: { [key: string]: unknown } | null = null;
  if (response !== null) {
    const responseError = toRecord(response.error);
    if (responseError !== null) error = responseError;
  }
  if (error !== null && typeof error.message === "string" && error.message.trim()) return error.message.trim();
  return "Codex response failed.";
};

type ResponseEventReduction = { state: StreamAccumulator; doneCompletion: ProviderCompletion | null; errorMessage: string | null };

const reduceResponseEvent = (state: StreamAccumulator, event: { [key: string]: unknown }): ResponseEventReduction => {
  const errorMessage = readFailedResponseMessage(event);
  if (errorMessage) return { state, doneCompletion: null, errorMessage };
  if (event.type === "response.output_text.delta" && typeof event.delta === "string") return { state: appendDelta(state, event.delta), doneCompletion: null, errorMessage: null };
  if (event.type === "response.refusal.delta" && typeof event.delta === "string") return { state: appendDelta(state, event.delta), doneCompletion: null, errorMessage: null };
  if (event.type === "response.output_item.added") return { state: upsertPendingFunctionCall(state, event.item), doneCompletion: null, errorMessage: null };
  if (event.type === "response.function_call_arguments.delta") return { state: appendFunctionCallArguments(state, event.item_id, event.delta), doneCompletion: null, errorMessage: null };
  if (event.type === "response.function_call_arguments.done") return { state: replaceFunctionCallArguments(state, event.item_id, event.arguments), doneCompletion: null, errorMessage: null };
  if (event.type === "response.output_item.done") return { state: completeFunctionCall(rememberCompletedMessage(state, extractModelTextFromOutputItem(event.item)), event.item), doneCompletion: null, errorMessage: null };
  if (event.type === "response.completed" || event.type === "response.incomplete" || event.type === "response.done") return { state, doneCompletion: finalizeCompletion(state), errorMessage: null };
  return { state, doneCompletion: null, errorMessage: null };
};

const splitStreamBuffer = (buffer: string): { chunks: string[]; remainder: string } => {
  const chunks: string[] = [];
  let remainder = buffer;
  let separatorIndex = remainder.indexOf("\n\n");
  while (separatorIndex !== -1) {
    chunks.push(remainder.slice(0, separatorIndex));
    remainder = remainder.slice(separatorIndex + 2);
    separatorIndex = remainder.indexOf("\n\n");
  }
  return { chunks, remainder };
};

type StreamStep =
  | { readonly _tag: "Continue"; readonly buffer: string; readonly accumulator: StreamAccumulator }
  | { readonly _tag: "Done"; readonly value: ProviderCompletion };

const collectStreamedCompletion = (response: Response, signal?: AbortSignal): Effect<ProviderCompletion, Error> =>
  Effect.gen(function* () {
    if (!response.body) return yield* Effect.fail(new Error("The provider returned no response body."));
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const initialStep: StreamStep = { _tag: "Continue", buffer: "", accumulator: { accumulatedText: "", completedMessageText: "", toolCalls: [], pendingFunctionCalls: {}, pendingFunctionCallOrder: [] } };
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
            return yield* Effect.fail(new Error("The provider returned no model output."));
          }
          const buffer = step.buffer + decoder.decode(value, { stream: true });
          const { chunks, remainder } = splitStreamBuffer(buffer);
          let accumulator = step.accumulator;
          for (const chunk of chunks) {
            const event = parseSseEvent(chunk);
            if (!event) continue;
            const next = reduceResponseEvent(accumulator, event);
            if (next.errorMessage) return yield* Effect.fail(new Error(next.errorMessage));
            accumulator = next.state;
            if (next.doneCompletion !== null) return { _tag: "Done" as const, value: next.doneCompletion };
          }
          return { _tag: "Continue" as const, buffer: remainder, accumulator };
        }),
      });
      if (finalStep._tag === "Done") return finalStep.value;
      return yield* Effect.fail(new Error("The provider stream ended in an unexpected state."));
    } finally {
      yield* fromPromise(() => reader.cancel().catch(() => undefined));
      yield* Effect.sync(() => { try { reader.releaseLock(); } catch {} });
    }
  });

const parseError = (response: Response): Effect<string, Error> =>
  Effect.gen(function* () {
    const raw = yield* fromPromise(() => response.text().catch(() => ""));
    try {
      const parsed = toRecord(JSON.parse(raw));
      const parsedError = parsed === null ? null : toRecord(parsed.error);
      if (parsedError !== null && typeof parsedError.message === "string" && parsedError.message.trim()) return parsedError.message.trim();
    } catch {}
    return raw.trim() || `Request failed with status ${response.status}.`;
  });

const loginAndSaveAuth = (authStore: ProviderAuthStore, loginRuntime: { terminal: Terminal; http: HttpClient; clock: Clock; oauth: OAuth; crypto: Crypto }): Effect<ProviderAuth, Error> =>
  Effect.gen(function* () {
    const auth = yield* loginOpenAICodex(loginRuntime);
    authStore.set(PROVIDER_ID, auth);
    loginRuntime.terminal.show({ type: "system", text: "OpenAI Codex login saved." });
    return auth;
  });

const refreshAndSaveAuth = (authStore: ProviderAuthStore, refreshRuntime: { http: HttpClient; clock: Clock; crypto: Crypto }, auth: ProviderAuth): Effect<ProviderAuth, Error> =>
  Effect.gen(function* () {
    const refreshed = yield* refreshOpenAICodexAuth(refreshRuntime, auth);
    authStore.set(PROVIDER_ID, refreshed);
    return refreshed;
  });

const createRequestBody = (selection: ProviderSelection, history: Message[], systemPrompt: string, tools: readonly Tool[]) => ({
  model: selection.options.model,
  store: false,
  stream: true,
  instructions: systemPrompt,
  input: messagesToInput(history),
  reasoning: { effort: selection.options.reasoning_effort },
  ...(tools.length > 0 ? { tools: createTools(tools), tool_choice: "auto", parallel_tool_calls: true } : {}),
  text: { verbosity: selection.options.text_verbosity },
});

function validateSelection(selection: ProviderSelection): void {
  if (!selection.options.model) throw new Error("Missing required OpenAI Codex option: model.");
  if (!selection.options.reasoning_effort) throw new Error("Missing required OpenAI Codex option: reasoning_effort.");
  if (!selection.options.text_verbosity) throw new Error("Missing required OpenAI Codex option: text_verbosity.");
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
