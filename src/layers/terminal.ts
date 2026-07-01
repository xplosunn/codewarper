import process from "node:process";
import readline from "node:readline/promises";
import { Effect } from "#effect";
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

function renderInfo(text: string): void {
  writeTextLines(text, writeLine, { indent: false });
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
  controller.abort("Interrupted.");
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

type KeypressHandler = (...args: unknown[]) => void;

interface StepResource {
  onData: ((chunk: Buffer) => void) | undefined;
  keypressListeners: KeypressHandler[];
  rlHandle: ReturnType<typeof acquireSigintAbort>;
  decoder: InstanceType<typeof TextDecoder>;
}

export function createTerminal(rl: readline.Interface): Terminal {
  // Lives beyond acquire/release — read by flushSilentInput after the step.
  let silentInputBuffer = "";

  // Adding a listener here suppresses readline's default handler
  // (which would call rl.close() and permanently break the interface).
  // Scoped operations temporarily replace this listener with one that aborts
  // their own AbortController.
  rl.on("SIGINT", exitOnSigint);

  // Clean up the readline interface on process exit — no scope system needed.
  process.on("exit", () => {
    try { rl.close(); } catch {}
  });

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
      case "info":
        renderInfo(message.text);
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
      Effect.sync((): StepResource => {
        silentInputBuffer = "";

        // Temporarily remove readline's keypress listeners from stdin
        // so it stops processing input during step execution.
        const keypressListeners = process.stdin.listeners("keypress") as KeypressHandler[];
        for (const listener of keypressListeners) {
          process.stdin.removeListener("keypress", listener);
        }

        // Swap readline's SIGINT handler to abort the step controller
        const rlHandle = acquireSigintAbort(rl);

        if (!process.stdin.isTTY) {
          return { onData: undefined, keypressListeners, rlHandle, decoder: new TextDecoder() };
        }

        // Ensure raw mode so we receive every byte individually,
        // including Ctrl+C as byte 0x03 instead of a SIGINT signal.
        process.stdin.setRawMode(true);

        const decoder = new TextDecoder();

        // Own stdin during step execution:
        // - 0x03 (Ctrl+C) → abort the step controller
        // - everything else → silently buffer for later retrieval
        const onData = (chunk: Buffer) => {
          // Scan every byte so Ctrl+C is detected even if it arrives
          // in the same chunk as preceding characters.
          for (let i = 0; i < chunk.length; i++) {
            if (chunk[i] === 0x03) {
              // Buffer everything typed before the Ctrl+C
              if (i > 0) {
                silentInputBuffer += decoder.decode(chunk.subarray(0, i), { stream: true });
              }
              rlHandle.controller.abort("Interrupted.");
              process.stdout.write("\n");
              return;
            }
          }
          // No Ctrl+C found, buffer the whole chunk
          silentInputBuffer += decoder.decode(chunk, { stream: true });
        };
        process.stdin.on("data", onData);

        return { onData, keypressListeners, rlHandle, decoder };
      }),
      (handle: StepResource) => run(handle.rlHandle.controller.signal),
      (handle: StepResource) =>
        Effect.sync(() => {
          // Remove our data listener
          if (handle.onData) {
            process.stdin.removeListener("data", handle.onData);
          }

          // Restore readline's keypress listeners so prompts work again
          for (const listener of handle.keypressListeners) {
            process.stdin.on("keypress", listener);
          }

          // Restore readline's default SIGINT handler
          releaseSigintAbort(rl, handle.rlHandle);

          // Flush any remaining bytes from the streaming decoder
          silentInputBuffer += handle.decoder.decode();
        }),
    );

  const flushSilentInput: Terminal["flushSilentInput"] = () => {
    const value = silentInputBuffer;
    silentInputBuffer = "";
    return value;
  };

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

  return { show, showFatalError, runWithStepAbortSignal, promptText, promptSelect, flushSilentInput };
}
