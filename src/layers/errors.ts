export function formatCliRunError(error: unknown): string {
  if (error instanceof Error) {
    if (typeof error.stack === "string" && error.stack !== "") {
      return error.stack;
    }

    return error.message;
  }

  return String(error);
}
