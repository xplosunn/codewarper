import process from "node:process";
import readline from "node:readline/promises";
import { pathToFileURL } from "node:url";
import { Effect } from "#effect";
import { run } from "./app/program.ts";
import { CliLive } from "./layers/index.ts";
import { createTerminal } from "./layers/terminal.ts";

const program = Effect.provide(run, CliLive);

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
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
}
