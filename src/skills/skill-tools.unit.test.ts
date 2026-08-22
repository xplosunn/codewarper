import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createSkillTools } from "./skill-tools.ts";
import type { CodewarperSkill } from "./types.ts";

function skill(overrides: Partial<CodewarperSkill>): CodewarperSkill {
  return {
    name: "visible",
    description: "Visible skill.",
    filePath: "/tmp/visible/SKILL.md",
    directoryPath: "/tmp/visible",
    content: "---\ndescription: Visible skill.\n---\n# Visible",
    supportingMarkdownFiles: [],
    disableModelInvocation: false,
    allowedTools: [],
    ...overrides,
  };
}

test("createSkillTools omits disabled model invocation skills", async () => {
  const tools = createSkillTools([
    skill({ name: "visible", disableModelInvocation: false }),
    skill({
      name: "manual-only",
      description: "Manual only.",
      filePath: "/tmp/manual-only/SKILL.md",
      directoryPath: "/tmp/manual-only",
      disableModelInvocation: true,
    }),
  ]);

  assert.equal(tools.length, 1);
  const readSkill = tools[0]!;
  assert.equal(readSkill.tool.name, "read_skill");
  assert.match(await readSkill.tool.run({ name: "visible" }), /# Skill: visible/);
  assert.match(await readSkill.tool.run({ name: "visible" }), /Directory: \/tmp\/visible/);
  await assert.rejects(
    () => readSkill.tool.run({ name: "manual-only" }),
    /Unknown skill: manual-only/,
  );
});

test("read_skill lists supporting files without loading their contents", async () => {
  const tools = createSkillTools([
    skill({
      name: "visible",
      supportingMarkdownFiles: [{ relativePath: "reference.md", filePath: "/tmp/visible/reference.md" }],
    }),
  ]);

  const output = await tools[0]!.tool.run({ name: "visible" });
  assert.match(output, /## Supporting files/);
  assert.match(output, /- reference\.md/);
  assert.doesNotMatch(output, /Extra instructions\./);
});

test("read_skill reads one supporting file by relative path", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "codewarper-skill-tool-"));
  try {
    const referencePath = path.join(dir, "reference.md");
    await writeFile(referencePath, "Extra instructions.");
    const tools = createSkillTools([
      skill({
        name: "visible",
        directoryPath: dir,
        supportingMarkdownFiles: [{ relativePath: "reference.md", filePath: referencePath }],
      }),
    ]);

    const output = await tools[0]!.tool.run({ name: "visible", file: "./reference.md" });
    assert.match(output, /Supporting file: reference\.md/);
    assert.match(output, /Extra instructions\./);
    await assert.rejects(
      () => tools[0]!.tool.run({ name: "visible", file: "missing.md" }),
      /Unknown supporting file/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("createSkillTools returns no tool when all skills are manual-only", () => {
  const tools = createSkillTools([
    skill({ name: "manual-only", disableModelInvocation: true }),
  ]);

  assert.deepEqual(tools, []);
});
