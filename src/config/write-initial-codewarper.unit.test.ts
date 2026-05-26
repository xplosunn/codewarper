import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { Effect } from "effect";
import { loadCodewarperConfigFromPath } from "./load-codewarper.ts";
import {
  INITIAL_CODEWARPER_STARTER_OPTIONS,
  type InitialCodewarperStarter,
  writeInitialCodewarperConfigIfMissing,
} from "./write-initial-codewarper.ts";

const expectedToolCounts: Record<InitialCodewarperStarter, number> = {
  empty: 0,
  local_files: 4,
  local_files_with_websearch: 5,
  all_config_options: 6,
  recommended_for_codewarper: 9,
};

interface StarterExpectations {
  toolCount: number;
  commandsEmpty: boolean;
  systemPromptNull: boolean;
  hooksNull: boolean;
  onProviderRequestNull: boolean;
  onProviderResponseNull: boolean;
}

const starterExpectations: Record<InitialCodewarperStarter, StarterExpectations> = {
  empty: {
    toolCount: 0,
    commandsEmpty: true,
    systemPromptNull: true,
    hooksNull: true,
    onProviderRequestNull: true,
    onProviderResponseNull: true,
  },
  local_files: {
    toolCount: 4,
    commandsEmpty: true,
    systemPromptNull: true,
    hooksNull: true,
    onProviderRequestNull: true,
    onProviderResponseNull: true,
  },
  local_files_with_websearch: {
    toolCount: 5,
    commandsEmpty: true,
    systemPromptNull: true,
    hooksNull: true,
    onProviderRequestNull: true,
    onProviderResponseNull: true,
  },
  all_config_options: {
    toolCount: 6,
    commandsEmpty: false,
    systemPromptNull: false,
    hooksNull: false,
    onProviderRequestNull: false,
    onProviderResponseNull: false,
  },
  recommended_for_codewarper: {
    toolCount: 9,
    commandsEmpty: false,
    systemPromptNull: false,
    hooksNull: true,
    onProviderRequestNull: true,
    onProviderResponseNull: true,
  },
};

test("initial codewarper config templates load as valid config", async (t) => {
  for (const { id: starter } of INITIAL_CODEWARPER_STARTER_OPTIONS) {
    await t.test(starter, async () => {
      const dir = await mkdtemp(path.join(tmpdir(), "codewarper-config-template-"));
      try {
        const configPath = path.join(dir, "codewarper.ts");

        const outcome = await writeInitialCodewarperConfigIfMissing(configPath, starter);
        assert.equal(outcome, "created");

        const config = await Effect.runPromise(loadCodewarperConfigFromPath(configPath));

        const expectations = starterExpectations[starter];
        assert.equal(config.tools.length, expectations.toolCount);

        if (expectations.commandsEmpty) {
          assert.deepEqual(config.commands, []);
        } else {
          assert.ok(config.commands.length > 0);
          assert.ok(config.commands.every((cmd) => cmd.description && typeof cmd.run === "function"));
        }

        if (expectations.systemPromptNull) {
          assert.equal(config.systemPrompt, null);
        } else {
          const sp = config.systemPrompt;
          assert.equal(typeof sp, "string");
          assert.ok((sp as string).length > 0);
        }

        if (expectations.hooksNull) {
          assert.equal(config.hooks, null);
        } else {
          assert.ok(config.hooks !== null);
          assert.equal(typeof config.hooks, "object");

          if (expectations.onProviderRequestNull) {
            assert.equal(config.hooks.onProviderRequest, null);
          } else {
            assert.equal(typeof config.hooks.onProviderRequest, "function");
          }

          if (expectations.onProviderResponseNull) {
            assert.equal(config.hooks.onProviderResponse, null);
          } else {
            assert.equal(typeof config.hooks.onProviderResponse, "function");
          }
        }
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  }
});
