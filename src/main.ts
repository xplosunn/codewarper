#!/usr/bin/env node

import process from "node:process";
import readline from "node:readline/promises";
import { Effect } from "#effect";
import { run } from "./app/program.ts";
import { CliLive } from "./layers/index.ts";
import { createTerminal } from "./layers/terminal.ts";

const program = Effect.provide(run, CliLive);

Effect.runPromise(program).catch((error: unknown) => {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const terminal = createTerminal(rl);
    terminal.showFatalError(error);
  } finally {
    rl.close();
  }
  process.exitCode = 1;
});
