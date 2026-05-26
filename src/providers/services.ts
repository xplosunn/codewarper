import { Context, Effect } from "effect";
import type { AuthStore } from "../persistence/services.ts";

export interface PromptTextOptions {
  allowEmpty: boolean;
  signal: AbortSignal | null;
}

export interface SelectOption<T> {
  label: string;
  value: T;
}

export type TerminalStatus =
  | { type: "providerCall" }
  | { type: "toolCall"; text: string };

export type TerminalMessage =
  | { type: "blankLine" }
  | { type: "separator" }
  | { type: "banner"; title: string }
  | { type: "system"; text: string }
  | { type: "assistant"; text: string }
  | { type: "error"; text: string }
  | { type: "status"; status: TerminalStatus };

export interface Terminal {
  show(message: TerminalMessage): void;
  showFatalError(error: unknown): void;
  runWithStepAbortSignal<A, E, R>(run: (signal: AbortSignal) => Effect.Effect<A, E, R>): Effect.Effect<A, E, R>;
  promptText(message: string, options: PromptTextOptions): Promise<string>;
  promptSelect<T>(message: string, options: SelectOption<T>[]): Promise<T>;
}

export class TerminalService extends Context.Tag("codewarper/TerminalService")<
  TerminalService,
  Terminal
>() {}

export interface HttpClient {
  fetch(input: Request | string | URL, init: RequestInit): Promise<Response>;
}

export class HttpClientService extends Context.Tag("codewarper/HttpClientService")<
  HttpClientService,
  HttpClient
>() {}

export interface SystemInfo {
  platform(): string;
  release(): string;
  arch(): string;
}

export class SystemInfoService extends Context.Tag("codewarper/SystemInfoService")<
  SystemInfoService,
  SystemInfo
>() {}

export interface Clock {
  now(): number;
}

export class ClockService extends Context.Tag("codewarper/ClockService")<
  ClockService,
  Clock
>() {}

export interface Environment {
  get(name: string): string | undefined;
}

export class EnvironmentService extends Context.Tag("codewarper/EnvironmentService")<
  EnvironmentService,
  Environment
>() {}

export interface ProviderAuth {
  access: string;
  refresh: string;
  expires: number;
  accountId: string;
  [key: string]: unknown;
}

export interface OAuthCallbackCode {
  code: string;
}

export interface OAuthCallbackHandle {
  close(): void;
  cancel(): void;
  waitForCode(): Promise<OAuthCallbackCode | null>;
}

export interface OAuth {
  openUrl(url: string): void;
  startCallbackServer(expectedState: string, redirectUri: string): Promise<OAuthCallbackHandle>;
}

export class OAuthService extends Context.Tag("codewarper/OAuthService")<
  OAuthService,
  OAuth
>() {}

export interface Crypto {
  createPkcePair(): { verifier: string; challenge: string };
  createRandomHex(byteLength: number): string;
  decodeJsonWebTokenPayload(token: string): { [key: string]: unknown } | null;
}

export class CryptoService extends Context.Tag("codewarper/CryptoService")<
  CryptoService,
  Crypto
>() {}

export type ProviderAuthStore = AuthStore<ProviderAuth>;

export class ProviderAuthStoreService extends Context.Tag("codewarper/ProviderAuthStoreService")<
  ProviderAuthStoreService,
  ProviderAuthStore
>() {}
