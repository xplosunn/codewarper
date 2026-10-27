export type CliArgs = {
  prompt?: string;
};

export function parseCliArgs(argv: string[]): CliArgs {
  const args: CliArgs = {};

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;

    if (arg === "--prompt" || arg === "-p") {
      const value = argv[i + 1];
      if (value === undefined) {
        throw new Error(`${arg} requires a value`);
      }
      args.prompt = value;
      i += 1;
      continue;
    }

    if (arg.startsWith("--prompt=")) {
      args.prompt = arg.slice("--prompt=".length);
      continue;
    }

    if (arg.startsWith("-p=")) {
      args.prompt = arg.slice("-p=".length);
      continue;
    }
  }

  return args;
}
