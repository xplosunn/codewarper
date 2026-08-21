import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { loadSkillsFromDirectories } from "./load-skills.ts";

test("loads nested markdown skills from configured directories", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "codewarper-skills-"));
  try {
    await mkdir(path.join(dir, "nested", "review"), { recursive: true });
    await writeFile(path.join(dir, "nested", "review", "SKILL.md"), [
      "---",
      "name: code-review",
      "description: Use when reviewing code changes.",
      "allowed-tools: read_file grep",
      "---",
      "# Review",
      "Check risks.",
    ].join("\n"));
    await writeFile(path.join(dir, "nested", "review", "reference.md"), "This is supporting docs, not a skill.");
    await writeFile(path.join(dir, "plain.md"), [
      "---",
      "description: Use for plain markdown skill files.",
      "---",
      "# Plain",
    ].join("\n"));

    const skills = await loadSkillsFromDirectories([dir]);
    assert.deepEqual(skills.map((skill) => skill.name), ["code-review", "plain"]);
    assert.equal(skills.find((skill) => skill.name === "code-review")?.allowedTools.length, 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("supports common frontmatter fields from other agents", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "codewarper-compatible-skills-"));
  try {
    await writeFile(path.join(dir, "compatible.md"), [
      "---",
      "name: compatible",
      "description: >",
      "  Use when checking compatibility with common Agent Skills fields.",
      "disable-model-invocation: true",
      "allowed-tools:",
      "  - read_file",
      "  - grep",
      "metadata:",
      "  owner: test",
      "argument-hint: [file]",
      "---",
      "# Compatible",
    ].join("\n"));

    const skills = await loadSkillsFromDirectories([dir]);
    assert.equal(skills.length, 1);
    assert.equal(skills[0]!.name, "compatible");
    assert.equal(skills[0]!.description, "Use when checking compatibility with common Agent Skills fields.");
    assert.equal(skills[0]!.disableModelInvocation, true);
    assert.deepEqual(skills[0]!.allowedTools, ["read_file", "grep"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("ignores unknown frontmatter fields from other agents", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "codewarper-unknown-skill-fields-"));
  try {
    await writeFile(path.join(dir, "unknown.md"), [
      "---",
      "name: unknown-fields",
      "description: Loads even when other agents add their own metadata.",
      "x-other-agent-field: yes",
      "---",
      "# Unknown fields",
    ].join("\n"));

    const skills = await loadSkillsFromDirectories([dir]);
    assert.equal(skills.length, 1);
    assert.equal(skills[0]!.name, "unknown-fields");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("throws for invalid skills", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "codewarper-bad-skills-"));
  try {
    await writeFile(path.join(dir, "bad.md"), [
      "---",
      "name: Bad Name",
      "description: Invalid name.",
      "---",
      "Body",
    ].join("\n"));

    await assert.rejects(
      () => loadSkillsFromDirectories([dir]),
      /name must use lowercase letters/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
