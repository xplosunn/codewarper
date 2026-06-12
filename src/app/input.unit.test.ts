import assert from "node:assert/strict";
import test from "node:test";
import { parseUserInput } from "./input.ts";

test("parseUserInput parses empty input", () => {
  assert.deepEqual(parseUserInput(""), { type: "empty" });
  assert.deepEqual(parseUserInput("   \n\t  "), { type: "empty" });
});

test("parseUserInput parses built-in commands", () => {
  assert.deepEqual(parseUserInput("/quit"), { type: "quit" });
  assert.deepEqual(parseUserInput("/exit"), { type: "quit" });
  assert.deepEqual(parseUserInput("/model"), { type: "switch_model" });
  assert.deepEqual(parseUserInput("/login"), { type: "login" });
  assert.deepEqual(parseUserInput("/reload"), { type: "reload" });
  assert.deepEqual(parseUserInput("/help"), { type: "help" });
});

test("parseUserInput trims commands", () => {
  assert.deepEqual(parseUserInput("  /help  "), { type: "help" });
});

test("/init is no longer a built-in command", () => {
  assert.deepEqual(parseUserInput("/init"), {
    type: "custom_command",
    name: "init",
    args: [],
  });
});

test("parseUserInput parses custom commands and args", () => {
  assert.deepEqual(parseUserInput("/review src/main.ts --fix"), {
    type: "custom_command",
    name: "review",
    args: ["src/main.ts", "--fix"],
  });

  assert.deepEqual(parseUserInput("/review   src/main.ts    --fix  "), {
    type: "custom_command",
    name: "review",
    args: ["src/main.ts", "--fix"],
  });
});

test("parseUserInput preserves prompt text exactly", () => {
  assert.deepEqual(parseUserInput("hello"), { type: "prompt", text: "hello" });
  assert.deepEqual(parseUserInput("  keep my spacing  "), {
    type: "prompt",
    text: "  keep my spacing  ",
  });
});
