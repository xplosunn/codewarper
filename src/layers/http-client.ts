import type { CodewarperConfigLoader } from "../config/load-codewarper.ts";
import type { HttpClient } from "../providers/services.ts";

const MAX_RETRIES = 2;

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || (status >= 500 && status <= 599);
}

export function createHttpClient(config: CodewarperConfigLoader, fetchFn: typeof fetch = fetch): HttpClient {
  return {
    async fetch(input, init) {
      const request = createRequest(input, init);

      for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
        try {
          const activeConfig = config.current();
          await runHookSafely(() => activeConfig.hooks?.onProviderRequest?.(request.clone()));

          // Clone the Request so retries can safely re-send request bodies.
          const response = await fetchFn(request.clone());

          if (!isRetryableStatus(response.status) || attempt === MAX_RETRIES) {
            if (!activeConfig.hooks?.onProviderResponse) return response;
            return tapResponse(response, (responseForCallback) =>
              activeConfig.hooks?.onProviderResponse?.(request.clone(), responseForCallback),
            );
          }
        } catch (error) {
          // If the signal was aborted (e.g. user pressed Ctrl+C) don't retry —
          // propagate the error immediately so the cancellation is responsive.
          if (init?.signal?.aborted) throw error;
          if (attempt === MAX_RETRIES) throw error;
        }
      }

      throw new Error("HTTP request retry loop exited unexpectedly.");
    },
  };
}

function createRequest(input: Request | string | URL, init: RequestInit): Request {
  return input instanceof Request ? new Request(input, init) : new Request(input, init);
}

function tapResponse(
  response: Response,
  onResponse: (response: Response) => Promise<void> | void,
): Response {
  if (!response.body) {
    void runHookSafely(() => onResponse(response.clone()));
    return response;
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let finished = false;

  const finish = () => {
    if (finished) return;
    finished = true;
    const body = new Blob(chunks);
    const responseForCallback = new Response(body, responseInit(response));
    void runHookSafely(() => onResponse(responseForCallback));
    try { reader.releaseLock(); } catch {}
  };

  const tappedBody = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) {
        finish();
        controller.close();
        return;
      }
      chunks.push(value.slice());
      controller.enqueue(value);
    },
    async cancel(reason) {
      try {
        await reader.cancel(reason);
      } finally {
        finish();
      }
    },
  });

  return new Response(tappedBody, responseInit(response));
}

async function runHookSafely(run: () => Promise<void> | void | undefined): Promise<void> {
  try {
    await run();
  } catch {
    // Provider hooks are observational. They must not break provider requests.
  }
}

function responseInit(response: Response): ResponseInit {
  return {
    status: response.status,
    statusText: response.statusText,
    headers: new Headers(response.headers),
  };
}
