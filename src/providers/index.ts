import { Context, Effect, type Req } from "#effect";
import type {
  ClockService,
  CryptoService,
  HttpClientService,
  OAuthService,
  ProviderAuth,
  ProviderAuthStoreService,
  SystemInfoService,
  TerminalService,
} from "./services.ts";
import { openaiCodexProvider } from "./openai-codex.ts";
import { opencodeZenProvider } from "./opencode-zen.ts";
import { openrouterProvider } from "./openrouter-free.ts";
import type { Tool } from "../tools/types.ts";

export interface AvailableModel { id: string; name: string; }

export interface ProviderOptionChoice {
  id: string; name: string;
  options?: ProviderOption[];
}

export interface ProviderOption {
  id: string; name: string;
  choices: ProviderOptionChoice[];
}

export interface ProviderSelection {
  providerId: string;
  options: Record<string, string>;
}

export interface UserMessage { type: "user"; text: string; }
export type ProviderRoundTripContext = unknown;

export interface ModelMessage {
  type: "model"; text: string;
  toolCalls?: ProviderToolCall[];
  roundTripContext?: ProviderRoundTripContext;
}

export interface ToolResultMessage { type: "tool_result"; toolCallId: string; toolName: string; content: string; }
export interface ProviderToolCall { id: string; name: string; input: unknown; }
export interface ProviderCompletion { text: string; toolCalls: ProviderToolCall[]; roundTripContext?: ProviderRoundTripContext; }
export type Message = UserMessage | ModelMessage | ToolResultMessage;

export type ProviderClientR = Req<typeof HttpClientService | typeof SystemInfoService | typeof TerminalService>;
export type ProviderAuthR = Req<typeof TerminalService | typeof ProviderAuthStoreService | typeof ClockService | typeof OAuthService | typeof CryptoService | typeof HttpClientService>;
export type ProviderR = ProviderAuthR & ProviderClientR;

export interface Provider {
  id: string; name: string;
  ensureAuthenticated(forceLogin: boolean): Effect<ProviderAuth, Error, ProviderAuthR>;
  listOptions(auth: ProviderAuth): Effect<ProviderOption[], Error, ProviderClientR>;
  complete(auth: ProviderAuth, selection: ProviderSelection, history: Message[], systemPrompt: string, tools: readonly Tool[], signal?: AbortSignal): Effect<ProviderCompletion, Error, ProviderClientR>;
}

export interface ModelProviders {
  readonly all: readonly Provider[];
  readonly findById: (id: string) => Provider | undefined;
}

export function createModelProviders(providers: readonly Provider[]): ModelProviders {
  return { all: providers, findById: (id) => providers.find((provider) => provider.id === id) };
}

export class ModelProvidersService extends Context.Tag("codewarper/ModelProvidersService")<ModelProvidersService, ModelProviders>() {}

export const builtInProviders: Provider[] = [openaiCodexProvider, opencodeZenProvider, openrouterProvider];
export const BuiltInModelProviders = createModelProviders(builtInProviders);
export const providers = builtInProviders;

export function flattenChoices(options: ProviderOption[]): ProviderOptionChoice[] {
  const result: ProviderOptionChoice[] = [];
  for (const option of options) {
    for (const choice of option.choices) {
      result.push(choice);
      if (choice.options) result.push(...flattenChoices(choice.options));
    }
  }
  return result;
}
