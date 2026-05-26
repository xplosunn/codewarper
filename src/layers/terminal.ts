import process from "node:process";
import readline from "node:readline/promises";
import { Effect } from "effect";
import type { Terminal, TerminalStatus } from "../providers/services.ts";
import { formatCliRunError } from "./errors.ts";

const separatorChar = "━";
const textIndent = "  ";

type LineWriter = (text: string) => void;

function separatorLine(): string {
  return separatorChar.repeat(process.stdout.columns ?? 80);
}

function writeLine(text: string): void {
  process.stdout.write(`${text}\n`);
}

function writeErrorLine(text: string): void {
  process.stderr.write(`${text}\n`);
}

function formatOption(option: { label: string }, index: number): string {
  return `  ${index + 1}. ${option.label}`;
}

function stripWrappingNewlines(text: string): string {
  return text.replace(/^\n+|\n+$/g, "");
}

function writeTextLines(text: string, writer: LineWriter, options: { indent: boolean }): void {
  for (const line of stripWrappingNewlines(text).split("\n")) {
    writer(options.indent && line !== "" ? `${textIndent}${line}` : line);
  }
}

function renderBlankLine(writer: LineWriter = writeLine): void {
  writer("");
}

function renderSeparator(writer: LineWriter = writeLine): void {
  renderBlankLine(writer);
  writer(separatorLine());
  renderBlankLine(writer);
}

function renderSeparatedBlock(
  text: string,
  options: { title?: string; indent?: boolean; writer?: LineWriter } = {},
): void {
  const writer = options.writer ?? writeLine;
  const indent = options.indent ?? true;

  renderSeparator(writer);
  if (options.title !== undefined) writer(options.title);
  writeTextLines(text, writer, { indent });
  renderSeparator(writer);
}

function renderPlainBlock(text: string): void {
  writeTextLines(text, writeLine, { indent: true });
}

function renderBanner(title: string): void {
  renderSeparatedBlock(title, { indent: false });
}

function renderSystem(text: string): void {
  renderPlainBlock(text);
}

function renderAssistant(text: string): void {
  renderSeparatedBlock(text);
}

function renderError(text: string): void {
  renderSeparatedBlock(text, { title: "Error" });
}

function renderStatus(status: TerminalStatus): void {
  switch (status.type) {
    case "providerCall":
      writeTextLines("🚀 thinking…", writeLine, { indent: true });
      return;
    case "toolCall":
      writeTextLines("🚀 tool call: " + status.text, writeLine, { indent: true });
      return;
  }
}

function exitOnSigint(): void {
  process.stdout.write("\n");
  process.exit(0);
}

function abortOnSigint(controller: AbortController): void {
  controller.abort();
  process.stdout.write("\n");
}

function acquireSigintAbort(rl: readline.Interface): { controller: AbortController; abort: () => void } {
  const controller = new AbortController();
  const abort = () => abortOnSigint(controller);
  rl.off("SIGINT", exitOnSigint);
  rl.on("SIGINT", abort);
  return { controller, abort };
}

function releaseSigintAbort(rl: readline.Interface, handle: { abort: () => void }): void {
  rl.off("SIGINT", handle.abort);
  rl.on("SIGINT", exitOnSigint);
}

async function withSigintAbort<A>(rl: readline.Interface, run: (signal: AbortSignal) => Promise<A>): Promise<A> {
  const handle = acquireSigintAbort(rl);
  try {
    return await run(handle.controller.signal);
  } finally {
    releaseSigintAbort(rl, handle);
  }
}

export function createTerminal(rl: readline.Interface): Terminal {
  // Adding a listener here suppresses readline's default handler
  // (which would call rl.close() and permanently break the interface).
  // Scoped operations temporarily replace this listener with one that aborts
  // their own AbortController.
  rl.on("SIGINT", exitOnSigint);

  const show: Terminal["show"] = (message) => {
    switch (message.type) {
      case "blankLine":
        renderBlankLine();
        return;
      case "separator":
        renderSeparator();
        return;
      case "banner":
        renderBanner(message.title);
        return;
      case "system":
        renderSystem(message.text);
        return;
      case "assistant":
        renderAssistant(message.text);
        return;
      case "error":
        renderError(message.text);
        return;
      case "status":
        renderStatus(message.status);
        return;
    }
  };

  const showFatalError: Terminal["showFatalError"] = (error) => {
    renderSeparatedBlock(formatCliRunError(error), { title: "Fatal error", writer: writeErrorLine });
  };

  const runWithStepAbortSignal: Terminal["runWithStepAbortSignal"] = (run) =>
    Effect.acquireUseRelease(
      Effect.sync(() => acquireSigintAbort(rl)),
      (handle) => run(handle.controller.signal),
      (handle) => Effect.sync(() => releaseSigintAbort(rl, handle)),
    );

  const promptText: Terminal["promptText"] = async (message, options) => {
    const allowEmpty = options.allowEmpty;
    const signal = options.signal;
    let value = "";

    do {
      value = signal === null ? await rl.question(message) : await rl.question(message, { signal });
    } while (!(allowEmpty || value.trim()));

    return value;
  };

  const promptSelect: Terminal["promptSelect"] = async (message, options) => {
    let choice: (typeof options)[number]["value"] | undefined;

    do {
      await withSigintAbort(rl, async (signal) => {
        renderSeparator();
        writeLine(message);
        for (const [index, option] of options.entries()) {
          writeLine(formatOption(option, index));
        }

        const raw = (await rl.question("> ", { signal })).trim();
        const numeric = Number(raw);
        if (Number.isInteger(numeric) && numeric >= 1 && numeric <= options.length) {
          choice = options[numeric - 1]!.value;
        } else {
          writeLine(`  Please enter a number between 1 and ${options.length}.`);
        }
      });
    } while (choice === undefined);

    return choice;
  };

  return { show, showFatalError, runWithStepAbortSignal, promptText, promptSelect };
}
