import assert from "node:assert/strict";
import test from "node:test";
import { createHttpClient } from "./http-client.ts";
import {
  DEFAULT_CONFIG_FILENAME,
  type CodewarperConfig,
  type CodewarperConfigLoader,
} from "../config/load-codewarper.ts";

function configLoader(config: Partial<CodewarperConfig>): CodewarperConfigLoader {
  const current: CodewarperConfig = {
    tools: [],
    commands: [],
    systemPrompt: null,
    hooks: null,
    ...config,
  };
  return {
    path: () => DEFAULT_CONFIG_FILENAME,
    current: () => current,
    load: () => { throw new Error("not needed"); },
    setCurrent: () => {},
  };
}

function nextTick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

test("createHttpClient passes cloned request and response to provider hooks", async () => {
  let requestUrl = "";
  let requestBody = "";
  let responseRequestBody = "";
  let responseBody = "";

  const http = createHttpClient(
    configLoader({
      hooks: {
        async onProviderRequest(request) {
          requestUrl = request.url;
          requestBody = await request.text();
        },
        async onProviderResponse(request, response) {
          responseRequestBody = await request.text();
          responseBody = await response.text();
        },
      },
    }),
    async (input) => {
      const request = input instanceof Request ? input : new Request(input);
      assert.equal(await request.text(), JSON.stringify({ hello: "world" }));
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  );

  const response = await http.fetch("https://example.test/api", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ hello: "world" }),
  });

  assert.equal(await response.text(), JSON.stringify({ ok: true }));
  await nextTick();

  assert.equal(requestUrl, "https://example.test/api");
  assert.equal(requestBody, JSON.stringify({ hello: "world" }));
  assert.equal(responseRequestBody, JSON.stringify({ hello: "world" }));
  assert.equal(responseBody, JSON.stringify({ ok: true }));
});

test("createHttpClient taps streaming response without consuming returned response", async () => {
  let hookedResponseBody = "";

  const http = createHttpClient(
    configLoader({
      hooks: {
        onProviderRequest: null,
        async onProviderResponse(_request, response) {
          hookedResponseBody = await response.text();
        },
      },
    }),
    async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            const encoder = new TextEncoder();
            controller.enqueue(encoder.encode("hello "));
            controller.enqueue(encoder.encode("stream"));
            controller.close();
          },
        }),
      ),
  );

  const response = await http.fetch("https://example.test/stream", { method: "GET" });
  assert.equal(await response.text(), "hello stream");

  // The hook runs from the tapped stream finish, which is asynchronous.
  await nextTick();
  assert.equal(hookedResponseBody, "hello stream");
});
