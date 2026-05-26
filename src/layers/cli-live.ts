import process from "node:process";
import readline from "node:readline/promises";
import { Effect, Layer } from "effect";
import { CodewarperConfigService, createCodewarperConfigLoader } from "../config/load-codewarper.ts";
import { createAuthStore } from "../persistence/auth-store.ts";
import { PreferencesStoreService } from "../persistence/preferences-service.ts";
import { createPreferencesStore } from "../persistence/preferences-store.ts";
import { PersistenceRuntimeService } from "../persistence/services.ts";
import { BuiltInModelProviders, ModelProvidersService } from "../providers/index.ts";
import type { ProviderAuth } from "../providers/services.ts";
import {
  ClockService,
  CryptoService,
  EnvironmentService,
  HttpClientService,
  OAuthService,
  ProviderAuthStoreService,
  SystemInfoService,
  TerminalService,
} from "../providers/services.ts";
import { createClock, createEnvironment, createSystemInfo } from "./platform.ts";
import { createCrypto } from "./crypto-impl.ts";
import { createHttpClient } from "./http-client.ts";
import { createOAuth } from "./oauth.ts";
import { createPersistenceRuntime } from "./persistence-runtime.ts";
import { createTerminal } from "./terminal.ts";

const TerminalLive = Layer.scoped(
  TerminalService,
  Effect.acquireRelease(
    Effect.sync(() => readline.createInterface({ input: process.stdin, output: process.stdout })),
    (interface_) => Effect.sync(() => interface_.close()),
  ).pipe(Effect.map((rl) => createTerminal(rl))),
);

const environment = createEnvironment();
const codewarperConfigLoader = createCodewarperConfigLoader(environment);
const HttpClientLive = Layer.succeed(HttpClientService, createHttpClient(codewarperConfigLoader));
const SystemInfoLive = Layer.succeed(SystemInfoService, createSystemInfo());
const ClockLive = Layer.succeed(ClockService, createClock());
const EnvironmentLive = Layer.succeed(EnvironmentService, environment);
const CodewarperConfigLive = Layer.succeed(CodewarperConfigService, codewarperConfigLoader);
const OAuthLive = Layer.succeed(OAuthService, createOAuth());
const CryptoLive = Layer.succeed(CryptoService, createCrypto());
const ModelProvidersLive = Layer.succeed(ModelProvidersService, BuiltInModelProviders);
const PersistenceRuntimeLive = Layer.sync(PersistenceRuntimeService, createPersistenceRuntime);
const ProviderAuthStoreLive = Layer.effect(
  ProviderAuthStoreService,
  Effect.map(PersistenceRuntimeService, (runtime) => createAuthStore<ProviderAuth>(runtime)),
);
const PreferencesStoreLive = Layer.effect(
  PreferencesStoreService,
  Effect.map(PersistenceRuntimeService, (runtime) => createPreferencesStore(runtime)),
);
const PersistenceStoresLive = Layer.mergeAll(ProviderAuthStoreLive, PreferencesStoreLive).pipe(
  Layer.provide(PersistenceRuntimeLive),
);

export const CliLive = Layer.mergeAll(
  TerminalLive,
  HttpClientLive,
  SystemInfoLive,
  ClockLive,
  EnvironmentLive,
  CodewarperConfigLive,
  OAuthLive,
  CryptoLive,
  ModelProvidersLive,
  PersistenceRuntimeLive,
  PersistenceStoresLive,
);
