#!/usr/bin/env node

import process from "node:process";
import readline from "node:readline/promises";
import { Effect } from "#effect";
import { run } from "./app/program.ts";
import { parseCliArgs, type CliArgs } from "./app/cli-args.ts";
import { CliLive } from "./layers/index.ts";
import { createTerminal } from "./layers/terminal.ts";

let cliArgs: CliArgs;
try {
  cliArgs = parseCliArgs(process.argv.slice(2));
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}

const program = Effect.provide(run(cliArgs), CliLive);

Effect.runPromise(program).then(
  () => process.exit(0),
  (error: unknown) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    try {
      const terminal = createTerminal(rl);
      terminal.showFatalError(error);
    } finally {
      rl.close();
    }
    process.exit(1);
  },
);
