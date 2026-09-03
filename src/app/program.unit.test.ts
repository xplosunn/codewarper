import assert from "node:assert/strict";
import test from "node:test";
import { formatElapsedTime } from "./program.ts";

test("formatElapsedTime shows seconds below a minute", () => {
  assert.equal(formatElapsedTime(0), "0.0s");
  assert.equal(formatElapsedTime(500), "0.5s");
  assert.equal(formatElapsedTime(42_700), "42.7s");
  assert.equal(formatElapsedTime(59_940), "59.9s");
});

test("formatElapsedTime switches to minutes and seconds at a minute", () => {
  assert.equal(formatElapsedTime(60_000), "1m 0.0s");
  assert.equal(formatElapsedTime(65_300), "1m 5.3s");
  assert.equal(formatElapsedTime(125_900), "2m 5.9s");
});

test("formatElapsedTime rounds seconds within the minute part", () => {
  assert.equal(formatElapsedTime(60_950), "1m 1.0s");
});

test("formatElapsedTime rolls over when seconds round up to 60", () => {
  assert.equal(formatElapsedTime(119_980), "2m 0.0s");
});
