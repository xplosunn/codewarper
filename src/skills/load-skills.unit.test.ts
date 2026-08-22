import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { loadSkillsFromDirectories } from "./load-skills.ts";

test("loads skill packages from configured directories", async () => {
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
    await mkdir(path.join(dir, "nested", "review", "references"), { recursive: true });
    await writeFile(path.join(dir, "nested", "review", "reference.md"), "This is supporting docs, not a skill.");
    await writeFile(path.join(dir, "nested", "review", "references", "checklist.md"), "Checklist docs.");
    await writeFile(path.join(dir, "plain.md"), [
      "---",
      "description: This standalone markdown file is not a skill.",
      "---",
      "# Plain",
    ].join("\n"));

    const skills = await loadSkillsFromDirectories([dir]);
    assert.deepEqual(skills.map((skill) => skill.name), ["code-review"]);
    const reviewSkill = skills.find((skill) => skill.name === "code-review");
    assert.equal(reviewSkill?.allowedTools.length, 2);
    assert.equal(reviewSkill?.directoryPath, path.join(dir, "nested", "review"));
    assert.deepEqual(
      reviewSkill?.supportingMarkdownFiles.map((file) => file.relativePath),
      ["reference.md", "references/checklist.md"],
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("supports common frontmatter fields", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "codewarper-compatible-skills-"));
  try {
    await mkdir(path.join(dir, "compatible"), { recursive: true });
    await writeFile(path.join(dir, "compatible", "SKILL.md"), [
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

test("ignores unknown frontmatter fields", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "codewarper-unknown-skill-fields-"));
  try {
    await mkdir(path.join(dir, "unknown"), { recursive: true });
    await writeFile(path.join(dir, "unknown", "SKILL.md"), [
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
    await mkdir(path.join(dir, "bad"), { recursive: true });
    await writeFile(path.join(dir, "bad", "SKILL.md"), [
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
