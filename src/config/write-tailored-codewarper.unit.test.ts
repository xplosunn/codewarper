import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { Effect } from "effect";
import { loadCodewarperConfigFromPath } from "./load-codewarper.ts";
import { normalizeTailoredCodewarperPlan, renderTailoredCodewarperConfig } from "./write-tailored-codewarper.ts";

test("tailored codewarper config renders as valid config", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "codewarper-tailored-config-"));
  try {
    const configPath = path.join(dir, "codewarper.ts");
    const contents = renderTailoredCodewarperConfig({
      summary: "Tailored for this test workspace.",
      systemPrompt: "Use this workspace's conventions.",
      toolset: "workspace_files_with_websearch",
      commands: [
        {
          name: "check",
          description: "Run project checks",
          command: "echo",
          args: ["ok"],
          timeoutMs: 10_000,
        },
      ],
      notes: ["Review generated commands before use."],
    });

    await writeFile(configPath, contents, "utf8");
    const config = await Effect.runPromise(loadCodewarperConfigFromPath(configPath));

    assert.equal(config.systemPrompt, "Use this workspace's conventions.");
    assert.equal(config.tools.length, 5);
    assert.equal(config.commands.length, 1);
    assert.equal(config.commands[0]!.name, "check");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("tailored codewarper config preserves default system prompt when plan uses null", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "codewarper-tailored-config-default-prompt-"));
  try {
    const configPath = path.join(dir, "codewarper.ts");
    const contents = renderTailoredCodewarperConfig({
      summary: "Use default prompt.",
      systemPrompt: null,
      toolset: "none",
      commands: [],
      notes: [],
    });

    await writeFile(configPath, contents, "utf8");
    const config = await Effect.runPromise(loadCodewarperConfigFromPath(configPath));

    assert.equal(config.systemPrompt, null);
    assert.equal(config.tools.length, 0);
    assert.equal(config.commands.length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("tailored codewarper plan normalization keeps only safe command shapes", () => {
  const plan = normalizeTailoredCodewarperPlan({
    summary: "Example",
    systemPrompt: "Prompt",
    toolset: "workspace_files",
    commands: [
      { name: "test", description: "Run tests", command: "pytest", args: ["-q"], timeoutMs: 120_000 },
      { name: "bad name", command: "rm", args: ["-rf", "/"] },
      { name: "test", command: "duplicate" },
    ],
    notes: ["note"],
  });

  assert.equal(plan.toolset, "workspace_files");
  assert.deepEqual(plan.commands.map((command) => command.name), ["test"]);
});
