import assert from "node:assert/strict";
import test from "node:test";
import { createSkillTools } from "./skill-tools.ts";
import type { CodewarperSkill } from "./types.ts";

function skill(overrides: Partial<CodewarperSkill>): CodewarperSkill {
  return {
    name: "visible",
    description: "Visible skill.",
    filePath: "/tmp/visible.md",
    content: "---\ndescription: Visible skill.\n---\n# Visible",
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
      filePath: "/tmp/manual-only.md",
      disableModelInvocation: true,
    }),
  ]);

  assert.equal(tools.length, 1);
  const readSkill = tools[0]!;
  assert.equal(readSkill.tool.name, "read_skill");
  assert.match(await readSkill.tool.run({ name: "visible" }), /# Skill: visible/);
  await assert.rejects(
    () => readSkill.tool.run({ name: "manual-only" }),
    /Unknown skill: manual-only/,
  );
});

test("createSkillTools returns no tool when all skills are manual-only", () => {
  const tools = createSkillTools([
    skill({ name: "manual-only", disableModelInvocation: true }),
  ]);

  assert.deepEqual(tools, []);
});
