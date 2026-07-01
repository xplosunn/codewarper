import assert from "node:assert/strict";
import test from "node:test";
import { Effect, Layer, type Req } from "#effect";
import type { CodewarperConfig, CodewarperConfigLoader } from "../src/config/load-codewarper.ts";
import { createAuthStore } from "../src/persistence/auth-store.ts";
import { providers, type Provider, type ProviderOption, type ProviderSelection } from "../src/providers/index.ts";
import {
  ClockService,
  CryptoService,
  HttpClientService,
  OAuthService,
  ProviderAuthStoreService,
  SystemInfoService,
  TerminalService,
  type OAuth,
  type ProviderAuth,
  type Terminal,
} from "../src/providers/services.ts";
import { createClock, createSystemInfo } from "../src/layers/platform.ts";
import { createCrypto } from "../src/layers/crypto-impl.ts";
import { createHttpClient } from "../src/layers/http-client.ts";
import { createPersistenceRuntime } from "../src/layers/persistence-runtime.ts";

const PROMPT = "Reply exactly: OK";
const SYSTEM_PROMPT = "Return only the exact text requested by the user.";
const PROVIDER_TIMEOUT_MS = 120_000;
const TEST_PROVIDER = process.env.TEST_PROVIDER?.trim();

const emptyConfig: CodewarperConfig = {
  tools: [],
  commands: [],
  systemPrompt: null,
  hooks: null,
};

const configLoader: CodewarperConfigLoader = {
  path: () => "codewarper.ts",
  current: () => emptyConfig,
  load: () => Effect.succeed(emptyConfig),
  setCurrent: () => {},
};

type IntegrationRequirements = Req<
  | typeof TerminalService
  | typeof HttpClientService
  | typeof SystemInfoService
  | typeof ClockService
  | typeof OAuthService
  | typeof CryptoService
  | typeof ProviderAuthStoreService
>;

const terminal: Terminal = {
  show: () => {},
  showFatalError: () => {},
  runWithStepAbortSignal: (run) => run(new AbortController().signal),
  promptText: async () => {
    throw new Error("Interactive login is disabled in integration tests. Log in before running this test.");
  },
  promptSelect: async () => {
    throw new Error("Interactive option selection is disabled in integration tests.");
  },
  flushSilentInput: () => "",
};

const disabledOAuth: OAuth = {
  openUrl: () => {
    throw new Error("Interactive OAuth login is disabled in integration tests. Log in before running this test.");
  },
  startCallbackServer: async () => {
    throw new Error("Interactive OAuth login is disabled in integration tests. Log in before running this test.");
  },
};

const IntegrationLive = Layer.mergeAll(
  Layer.succeed(TerminalService, terminal),
  Layer.succeed(HttpClientService, createHttpClient(configLoader)),
  Layer.succeed(SystemInfoService, createSystemInfo()),
  Layer.succeed(ClockService, createClock()),
  Layer.succeed(CryptoService, createCrypto()),
  Layer.succeed(OAuthService, disabledOAuth),
  Layer.succeed(ProviderAuthStoreService, createAuthStore<ProviderAuth>(createPersistenceRuntime())),
);

test("all providers reply with OK for every advertised option combination", async (t) => {
  assert.notEqual(providers.length, 0, "Expected at least one provider to be registered.");

  const testProviders = selectTestProviders(providers);
  assert.notEqual(
    testProviders.length,
    0,
    `No provider name matched TEST_PROVIDER=${JSON.stringify(TEST_PROVIDER)}.`,
  );

  if (TEST_PROVIDER) {
    t.diagnostic(`TEST_PROVIDER=${JSON.stringify(TEST_PROVIDER)} matched: ${testProviders.map((provider) => provider.name).join(", ")}`);
  }

  for (const provider of testProviders) {
    await t.test(provider.name, async (t) => {
      const auth = await run(provider.ensureAuthenticated(false));
      const options = await run(provider.listOptions(auth));
      const selections = createSelections(provider.id, options);

      t.diagnostic(`Testing ${selections.length} option combination(s).`);

      for (const selection of selections) {
        await t.test(formatSelectionName(selection, options), { timeout: PROVIDER_TIMEOUT_MS }, async () => {
          const completion = await run(
            provider.complete(
              auth,
              selection,
              [{ type: "user", text: PROMPT }],
              SYSTEM_PROMPT,
              [],
            ),
          );

          assert.deepEqual(
            completion.toolCalls,
            [],
            "Provider returned tool calls even though no tools were supplied.",
          );
          assert.ok(
            completion.text.trim().includes("OK"),
            `Expected provider response to contain "OK". Raw response: ${JSON.stringify(completion.text)}`,
          );
        });
      }
    });
  }
});

function selectTestProviders(allProviders: Provider[]): Provider[] {
  if (!TEST_PROVIDER) return allProviders;

  const normalizedFilter = TEST_PROVIDER.toLowerCase();
  return allProviders.filter((provider) => provider.name.toLowerCase().includes(normalizedFilter));
}

function run<A, E>(effect: Effect<A, E, IntegrationRequirements>): Promise<A> {
  return Effect.runPromise(Effect.provide(effect, IntegrationLive));
}

/**
 * Generate selections by walking the option tree per model:
 * - The "model" option's choices each produce a set of combinations with
 *   their sub-options. Choices without sub-options produce a single combo.
 * - Sibling non-model options (not expected in current providers)
 *   are treated as flat dimensions crossed with model combos.
 */
function createSelections(providerId: string, options: ProviderOption[]): ProviderSelection[] {
  for (const option of options) {
    assert.notEqual(
      option.choices.length,
      0,
      `Provider option ${providerId}.${option.id} did not advertise any choices.`,
    );
  }

  // Separate model-level options (those with choices that may have sub-options)
  // from flat options.
  const modelOptions = options.filter((o) => o.choices.some((c) => c.options));
  const flatOptions = options.filter((o) => o.choices.every((c) => !c.options));

  // Generate combinations for model options — each model choice plus its sub-option combos.
  const modelCombos = modelOptions.flatMap((option) =>
    option.choices.flatMap((choice) => {
      const base = { [option.id]: choice.id };
      if (!choice.options) return [base];
      // Cartesian product of sub-option choices.
      const subCombos = cartesianProduct(
        choice.options.map((sub) => sub.choices.map((c) => c.id)),
      );
      return subCombos.map((values) => ({
        ...base,
        ...Object.fromEntries(choice.options!.map((sub, i) => [sub.id, values[i] ?? ""])),
      }));
    }),
  );

  // Cross with flat option combinations.
  const flatCombos = flatOptions.length > 0
    ? cartesianProduct(flatOptions.map((o) => o.choices.map((c) => c.id)))
    : [[]];

  // If there are no model options, just use flat combos.
  if (modelCombos.length === 0) {
    return flatCombos.map((values) => ({
      providerId,
      options: Object.fromEntries(flatOptions.map((o, i) => [o.id, values[i] ?? ""])),
    }));
  }

  // Cross model combos with flat combos.
  return modelCombos.flatMap((modelPart) =>
    flatCombos.map((flatValues) => ({
      providerId,
      options: {
        ...modelPart,
        ...Object.fromEntries(flatOptions.map((o, i) => [o.id, flatValues[i] ?? ""])),
      },
    })),
  );
}

function cartesianProduct<T>(dimensions: T[][]): T[][] {
  if (dimensions.length === 0) return [[]];
  return dimensions.reduce<T[][]>(
    (accumulated, dimension) =>
      accumulated.flatMap((prefix) => dimension.map((value) => [...prefix, value])),
    [[]],
  );
}

function formatSelectionName(selection: ProviderSelection, options: ProviderOption[]): string {
  const entries: string[] = [];
  for (const option of options) {
    entries.push(`${option.id}=${selection.options[option.id] ?? ""}`);
    // Also include sub-option values.
    for (const choice of option.choices) {
      if (choice.options && choice.id === selection.options[option.id]) {
        for (const sub of choice.options) {
          entries.push(`${sub.id}=${selection.options[sub.id] ?? ""}`);
        }
      }
    }
  }
  return entries.length === 0 ? "default options" : entries.join(", ");
}
