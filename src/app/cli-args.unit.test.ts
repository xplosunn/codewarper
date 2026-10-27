import assert from "node:assert/strict";
import test from "node:test";
import { parseCliArgs } from "./cli-args.ts";

test("parseCliArgs parses --prompt", () => {
  assert.deepEqual(parseCliArgs(["--prompt", "hello"]), { prompt: "hello" });
});

test("parseCliArgs parses --prompt=value", () => {
  assert.deepEqual(parseCliArgs(["--prompt=hello world"]), {
    prompt: "hello world",
  });
});

test("parseCliArgs parses -p", () => {
  assert.deepEqual(parseCliArgs(["-p", "hello"]), { prompt: "hello" });
});

test("parseCliArgs parses -p=value", () => {
  assert.deepEqual(parseCliArgs(["-p=hello"]), { prompt: "hello" });
});

test("parseCliArgs allows an empty prompt value", () => {
  assert.deepEqual(parseCliArgs(["--prompt", ""]), { prompt: "" });
});

test("parseCliArgs ignores unrelated args", () => {
  assert.deepEqual(parseCliArgs(["run", "--prompt", "hello"]), {
    prompt: "hello",
  });
});

test("parseCliArgs returns no prompt when the flag is absent", () => {
  assert.deepEqual(parseCliArgs(["run"]), {});
});

test("parseCliArgs throws when --prompt has no value", () => {
  assert.throws(() => parseCliArgs(["--prompt"]), /--prompt requires a value/);
});

test("parseCliArgs throws when -p has no value", () => {
  assert.throws(() => parseCliArgs(["-p"]), /-p requires a value/);
});
