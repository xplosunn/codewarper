import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { Effect, Layer, type Req } from "#effect";
import { createAuthStore } from "../src/persistence/auth-store.ts";
import {
  providers,
  type Message,
  type Provider,
  type ProviderOption,
  type ProviderSelection,
} from "../src/providers/index.ts";
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
import { step } from "../src/step/index.ts";
import type { SessionConfiguration } from "../src/step/index.ts";
import { loadSkillsFromDirectories } from "../src/skills/load-skills.ts";
import { createSkillTools } from "../src/skills/skill-tools.ts";
import { appendSkillGuidanceToSystemPrompt } from "../src/skills/skill-system-prompt.ts";
import { appendToolGuidanceToSystemPrompt } from "../src/tools/tool-system-prompt.ts";
import type { CodewarperConfig, CodewarperConfigLoader } from "../src/config/load-codewarper.ts";

const TEST_PROVIDER = process.env.TEST_PROVIDER?.trim();
const PROVIDER_TIMEOUT_MS = 120_000;

const BASE_SYSTEM_PROMPT = "You are Codewarper running an integration test.";

const emptyConfig: CodewarperConfig = {
  tools: [],
  commands: [],
  systemPrompt: null,
  hooks: null,
  skills: [],
  skillDirectories: [],
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

test("real provider can load and use a configured skill", { timeout: PROVIDER_TIMEOUT_MS }, async (t) => {
  const selectedProviders = selectTestProviders(providers);
  assert.notEqual(selectedProviders.length, 0, `No provider name matched TEST_PROVIDER=${JSON.stringify(TEST_PROVIDER)}.`);

  const provider = selectedProviders[Math.floor(Math.random() * selectedProviders.length)]!;
  t.diagnostic(`Selected provider: ${provider.name}`);

  const tmpRoot = tmpdir();
  await mkdir(tmpRoot, { recursive: true });
  const dir = await mkdtemp(path.join(tmpRoot, "codewarper-skill-integration-"));
  try {
    const skillsDir = path.join(dir, "skills", "nested");
    const skillDir = path.join(skillsDir, "nonce-reply");
    await mkdir(skillDir, { recursive: true });

    const nonce = `CW_SKILL_TEST_${crypto.randomUUID().replace(/-/g, "").slice(0, 8)}_OK`;
    await writeFile(path.join(skillDir, "SKILL.md"), [
      "---",
      "name: nonce-reply",
      "description: Use only when the user asks for the Codewarper skill integration nonce reply. This skill defines the required nonce response for integration testing.",
      "---",
      "# Nonce Reply Skill",
      "",
      "When this skill is used, reply with exactly this text and nothing else:",
      "",
      nonce,
      "",
    ].join("\n"));

    const skills = await loadSkillsFromDirectories([path.join(dir, "skills")]);
    const loadedTools = createSkillTools(skills);
    const systemPrompt = appendToolGuidanceToSystemPrompt(
      appendSkillGuidanceToSystemPrompt(BASE_SYSTEM_PROMPT, skills),
      loadedTools,
    );

    const auth = await run(provider.ensureAuthenticated(false));
    const options = await run(provider.listOptions(auth));
    const selection = firstSelection(provider.id, options);

    const sessionConfiguration: SessionConfiguration = {
      provider,
      auth,
      selection,
      systemPrompt,
      loadedTools,
    };

    const prompt = "Please perform the Codewarper skill integration nonce reply task.";

    const result = await run(
      step({ history: [{ type: "user", text: prompt }] }, sessionConfiguration),
    );

    assert.equal(result.newMessage.text.trim(), nonce);
    assert.ok(hasReadSkillToolCall(result.conversation.history), "Expected provider to call read_skill.");
    assert.ok(hasSkillToolResult(result.conversation.history, nonce), "Expected read_skill tool result to include nonce.");
  } finally {
    await rm(dir, { recursive: true, force: true });
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

function firstSelection(providerId: string, options: ProviderOption[]): ProviderSelection {
  const selections = createSelections(providerId, options);
  assert.notEqual(selections.length, 0, `Provider ${providerId} advertised no selectable option combinations.`);
  return selections[0]!;
}

function createSelections(providerId: string, options: ProviderOption[]): ProviderSelection[] {
  for (const option of options) {
    assert.notEqual(
      option.choices.length,
      0,
      `Provider option ${providerId}.${option.id} did not advertise any choices.`,
    );
  }

  const modelOptions = options.filter((o) => o.choices.some((c) => c.options));
  const flatOptions = options.filter((o) => o.choices.every((c) => !c.options));

  const modelCombos = modelOptions.flatMap((option) =>
    option.choices.flatMap((choice) => {
      const base = { [option.id]: choice.id };
      if (!choice.options) return [base];
      const subCombos = cartesianProduct(
        choice.options.map((sub) => sub.choices.map((c) => c.id)),
      );
      return subCombos.map((values) => ({
        ...base,
        ...Object.fromEntries(choice.options!.map((sub, i) => [sub.id, values[i] ?? ""])),
      }));
    }),
  );

  const flatCombos = flatOptions.length > 0
    ? cartesianProduct(flatOptions.map((o) => o.choices.map((c) => c.id)))
    : [[]];

  if (modelCombos.length === 0) {
    return flatCombos.map((values) => ({
      providerId,
      options: Object.fromEntries(flatOptions.map((o, i) => [o.id, values[i] ?? ""])),
    }));
  }

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

function hasReadSkillToolCall(history: Message[]): boolean {
  return history.some((message) =>
    message.type === "model" &&
    message.toolCalls?.some((call) =>
      call.name === "read_skill" && readToolCallName(call.input) === "nonce-reply",
    ),
  );
}

function readToolCallName(input: unknown): unknown {
  if (!isObjectRecord(input)) return undefined;
  return input.name;
}

function isObjectRecord(input: unknown): input is Readonly<Record<string, unknown>> {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}

function hasSkillToolResult(history: Message[], nonce: string): boolean {
  return history.some((message) =>
    message.type === "tool_result" &&
    message.toolName === "read_skill" &&
    message.content.includes(nonce),
  );
}
