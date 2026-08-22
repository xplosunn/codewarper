import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { Effect } from "#effect";
import { loadCodewarperConfigFromPath } from "./load-codewarper.ts";

function toolSource(name: string): string {
  return `{
    name: ${JSON.stringify(name)},
    description: "Test tool.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    getCallStatusMessage() { return "Running test tool"; },
    run() { return "ok"; },
  }`;
}

async function writeSkillPackage(skillsDir: string, name: string, frontmatterLines: string[] = []): Promise<void> {
  await mkdir(path.join(skillsDir, name), { recursive: true });
  await writeFile(path.join(skillsDir, name, "SKILL.md"), [
    "---",
    `name: ${name}`,
    ...frontmatterLines,
    "---",
    `# ${name}`,
  ].join("\n"));
}

test("loadCodewarperConfigFromPath loads skills from configured directories", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "codewarper-config-skills-"));
  try {
    const skillsDir = path.join(dir, "skills");
    await writeSkillPackage(skillsDir, "review", ["description: Use when reviewing changes."]);

    const configPath = path.join(dir, "codewarper.mjs");
    await writeFile(configPath, `export default { skillDirectories: [${JSON.stringify(skillsDir)}] };`);

    const config = await Effect.runPromise(loadCodewarperConfigFromPath(configPath));
    assert.equal(config.skillDirectories.length, 1);
    assert.equal(config.skills.length, 1);
    assert.equal(config.skills[0]!.name, "review");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("loadCodewarperConfigFromPath rejects unsupported tool inputSchema keywords", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "codewarper-config-bad-schema-"));
  try {
    const configPath = path.join(dir, "codewarper.mjs");
    await writeFile(configPath, `export default {
      tools: [{
        name: "bad_tool",
        description: "Test tool.",
        inputSchema: { type: "object", oneOf: [{ type: "object" }] },
        getCallStatusMessage() { return "Running test tool"; },
        run() { return "ok"; },
      }],
    };`);

    await assert.rejects(
      () => Effect.runPromise(loadCodewarperConfigFromPath(configPath)),
      /Invalid JSON Schema for tool "bad_tool" inputSchema: \$\.oneOf: unsupported JSON Schema keyword/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("loadCodewarperConfigFromPath rejects read_skill tool collision when skills are model-invocable", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "codewarper-config-skill-collision-"));
  try {
    const skillsDir = path.join(dir, "skills");
    await writeSkillPackage(skillsDir, "review", ["description: Use when reviewing changes."]);

    const configPath = path.join(dir, "codewarper.mjs");
    await writeFile(configPath, `export default {
      skillDirectories: [${JSON.stringify(skillsDir)}],
      tools: [${toolSource("read_skill")}],
    };`);

    await assert.rejects(
      () => Effect.runPromise(loadCodewarperConfigFromPath(configPath)),
      /reserved for Codewarper skills/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("loadCodewarperConfigFromPath allows read_skill user tool when all skills are manual-only", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "codewarper-config-manual-skill-collision-"));
  try {
    const skillsDir = path.join(dir, "skills");
    await writeSkillPackage(skillsDir, "manual", [
      "description: Manual-only skill.",
      "disable-model-invocation: true",
    ]);

    const configPath = path.join(dir, "codewarper.mjs");
    await writeFile(configPath, `export default {
      skillDirectories: [${JSON.stringify(skillsDir)}],
      tools: [${toolSource("read_skill")}],
    };`);

    const config = await Effect.runPromise(loadCodewarperConfigFromPath(configPath));
    assert.equal(config.tools.length, 1);
    assert.equal(config.skills.length, 1);
    assert.equal(config.skills[0]!.disableModelInvocation, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
