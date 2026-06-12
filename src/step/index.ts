import { Effect } from "#effect";
import type {
  Message,
  ModelMessage,
  Provider,
  ProviderCompletion,
  ProviderSelection,
  ProviderToolCall,
  ToolResultMessage,
} from "../providers/index.ts";
import type { ProviderAuth } from "../providers/services.ts";
import { TerminalService } from "../providers/services.ts";
import type { LoadedTool } from "../tools/loaded-tool.ts";
import type { StepR } from "./services.ts";

export interface Conversation { history: Message[]; }

export interface SessionConfiguration {
  provider: Provider; auth: ProviderAuth; selection: ProviderSelection;
  systemPrompt: string; loadedTools: readonly LoadedTool[];
}

export interface StepResult { conversation: Conversation; newMessage: ModelMessage; done: boolean; }

export function step(
  conversation: Conversation, sessionConfiguration: SessionConfiguration, signal?: AbortSignal,
): Effect<StepResult, Error, StepR> {
  return Effect.gen(function* () {
    const terminal = yield* TerminalService;
    let history = conversation.history;
    while (true) {
      if (signal?.aborted) return yield* Effect.fail(new Error(signal.reason ? String(signal.reason) : "Interrupted."));
      terminal.show({ type: "status", status: { type: "providerCall" } });
      const completion = yield* sessionConfiguration.provider.complete(
        sessionConfiguration.auth, sessionConfiguration.selection, history,
        sessionConfiguration.systemPrompt, sessionConfiguration.loadedTools.map((loaded) => loaded.tool), signal,
      );
      const calls = completion.toolCalls;
      if (calls.length === 0) {
        const newMessage = modelMessageFromCompletion(completion);
        return { conversation: { history: [...history, newMessage] }, newMessage, done: true };
      }
      history = [...history, modelMessageFromCompletion(completion, calls)];
      const outputs: string[] = [];
      for (const call of calls) {
        if (signal?.aborted) return yield* Effect.fail(new Error(signal.reason ? String(signal.reason) : "Interrupted."));
        outputs.push(yield* runToolCall(call, sessionConfiguration.loadedTools));
      }
      history = [...history, ...formatToolResults(calls, outputs)];
    }
  });
}

function modelMessageFromCompletion(completion: ProviderCompletion, toolCalls?: ProviderToolCall[]): ModelMessage {
  return {
    type: "model", text: completion.text,
    ...(toolCalls !== undefined && toolCalls.length > 0 ? { toolCalls } : {}),
    ...(completion.roundTripContext !== undefined ? { roundTripContext: completion.roundTripContext } : {}),
  };
}

function runToolCall(call: ProviderToolCall, loadedTools: readonly LoadedTool[]): Effect<string, never, StepR> {
  return Effect.gen(function* () {
    const terminal = yield* TerminalService;
    const loaded = loadedTools.find((lt) => lt.tool.name === call.name);
    if (!loaded) {
      terminal.show({ type: "status", status: { type: "toolCall", text: `Unknown tool "${call.name}"` } });
      return formatToolError(call.name, new Error(`Unknown tool "${call.name}".`));
    }
    const validationResult = yield* Effect.either(Effect.try({ try: () => { loaded.validateInput(call.input); }, catch: toError }));
    if (validationResult._tag === "Left") {
      terminal.show({ type: "status", status: { type: "toolCall", text: `Schema validation error: ${validationResult.left.message}` } });
      return formatToolError(call.name, validationResult.left);
    }
    terminal.show({ type: "status", status: { type: "toolCall", text: loaded.tool.getCallStatusMessage(call.input) } });
    const runResult = yield* Effect.either(Effect.tryPromise({ try: () => loaded.tool.run(call.input), catch: toError }));
    if (runResult._tag === "Left") {
      terminal.show({ type: "status", status: { type: "toolCall", text: `Error: ${runResult.left.message}` } });
      return formatToolError(call.name, runResult.left);
    }
    return runResult.right;
  });
}

function formatToolResults(calls: ProviderToolCall[], outputs: string[]): ToolResultMessage[] {
  return calls.map((call, i) => ({ type: "tool_result", toolCallId: call.id, toolName: call.name, content: outputs[i]! }));
}

function formatToolError(toolName: string, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return `Error running tool "${toolName}": ${message}`;
}

function toError(error: unknown): Error { return error instanceof Error ? error : new Error(String(error)); }
