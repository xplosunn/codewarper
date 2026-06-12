import { Effect } from "#effect";
import type {
  Clock,
  Crypto,
  HttpClient,
  OAuth,
  OAuthCallbackCode,
  ProviderAuth,
  Terminal,
} from "./services.ts";

const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const AUTHORIZE_URL = "https://auth.openai.com/oauth/authorize";
const TOKEN_URL = "https://auth.openai.com/oauth/token";
const REDIRECT_URI = "http://localhost:1455/auth/callback";
const SCOPE = "openid profile email offline_access";
const JWT_CLAIM_PATH = "https://api.openai.com/auth";
const ORIGINATOR = "pi";

export function refreshOpenAICodexAuth(
  runtime: { http: HttpClient; clock: Clock; crypto: Crypto },
  auth: ProviderAuth,
): Effect<ProviderAuth, Error> {
  return Effect.gen(function* () {
    const response = yield* fromPromise(() =>
      runtime.http.fetch(TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: auth.refresh,
          client_id: CLIENT_ID,
        }),
      }),
    );

    const { accessToken, refreshToken, expiresIn, idToken } = yield* parseTokenResponse(response, "Token refresh failed");

    return {
      access: accessToken,
      refresh: refreshToken,
      expires: runtime.clock.now() + expiresIn * 1000,
      accountId: extractAccountId(runtime.crypto, accessToken, idToken),
    };
  });
}

export function loginOpenAICodex(
  runtime: { terminal: Terminal; http: HttpClient; clock: Clock; oauth: OAuth; crypto: Crypto },
): Effect<ProviderAuth, Error> {
  return Effect.scoped(Effect.gen(function* () {
    const { verifier, challenge } = generatePkce(runtime.crypto);
    const state = createState(runtime.crypto);
    const url = createAuthorizationUrl(challenge, state);
    const server = yield* Effect.acquireRelease(
      fromPromise(() => runtime.oauth.startCallbackServer(state, REDIRECT_URI)),
      (handle) => Effect.sync(() => { handle.close(); }),
    );

    runtime.terminal.show({ type: "banner", title: "OpenAI Codex login" });
    runtime.terminal.show({ type: "system", text: `Open this URL in your browser:\n${url.toString()}` });
    runtime.oauth.openUrl(url.toString());
    runtime.terminal.show({ type: "system", text: "Trying to open your browser now. If nothing happens, open the URL manually." });

    const manualAbort = new AbortController();
    const manualPrompt = runtime.terminal
      .promptText(
        "Paste the final redirect URL or the authorization code here.\nPress Enter to keep waiting for the browser callback.\n> ",
        { allowEmpty: true, signal: manualAbort.signal },
      )
      .catch((error: unknown) => {
        if (error instanceof Error && (error.name === "AbortError" || error.message.includes("aborted"))) {
          return "";
        }
        throw error;
      });

    const callbackPromise = server.waitForCode();
    const winner = yield* fromPromise(() => {
      const callbackWinner: Promise<{ source: "callback"; result: OAuthCallbackCode | null }> =
        callbackPromise.then((result: OAuthCallbackCode | null) => ({ source: "callback", result }));
      const manualWinner: Promise<{ source: "manual"; value: string }> = manualPrompt.then((value) => ({
        source: "manual",
        value,
      }));
      return Promise.race([callbackWinner, manualWinner]);
    });

    let code: string | null = null;

    if (winner.source === "callback") {
      if (winner.result !== null) {
        manualAbort.abort();
        code = winner.result.code;
      }
    } else if (winner.source === "manual" && winner.value.trim()) {
      server.cancel();
      const parsed = parseAuthorizationInput(winner.value);
      if (parsed.state !== null && parsed.state !== state) {
        return yield* Effect.fail(new Error("State mismatch."));
      }
      code = parsed.code;
    } else {
      const callbackResult = yield* fromPromise(() => callbackPromise);
      if (callbackResult !== null) {
        manualAbort.abort();
        code = callbackResult.code;
      }
    }

    if (!code) {
      code = yield* readManualAuthorizationCode(runtime.terminal, state);
    }

    if (!code) {
      return yield* Effect.fail(new Error("Missing authorization code."));
    }

    return yield* exchangeAuthorizationCode(runtime, code, verifier);
  }));
}

function generatePkce(crypto: Crypto) { return crypto.createPkcePair(); }
function createState(crypto: Crypto): string { return crypto.createRandomHex(16); }

function decodeJwtPayload(crypto: Crypto, token: string): { [key: string]: unknown } | null {
  return crypto.decodeJsonWebTokenPayload(token);
}

function readAccountIdFromToken(crypto: Crypto, token: string | null): string | null {
  if (!token) return null;
  const payload = decodeJwtPayload(crypto, token);
  if (!payload) return null;

  const topLevelAccountId = payload.chatgpt_account_id;
  if (typeof topLevelAccountId === "string" && topLevelAccountId.length > 0) return topLevelAccountId;

  const auth = payload[JWT_CLAIM_PATH];
  if (auth && typeof auth === "object" && !Array.isArray(auth)) {
    const authRecord = toRecord(auth);
    const nestedAccountId = authRecord === null ? null : authRecord.chatgpt_account_id;
    if (typeof nestedAccountId === "string" && nestedAccountId.length > 0) return nestedAccountId;
  }

  const organizations = payload.organizations;
  if (!Array.isArray(organizations)) return null;
  for (const organization of organizations) {
    const organizationRecord = toRecord(organization);
    if (organizationRecord === null) continue;
    const id = organizationRecord.id;
    if (typeof id === "string" && id.length > 0) return id;
  }
  return null;
}

function extractAccountId(crypto: Crypto, accessToken: string, idToken: string | null): string {
  let accountId = readAccountIdFromToken(crypto, idToken);
  if (accountId === null) accountId = readAccountIdFromToken(crypto, accessToken);
  if (!accountId) throw new Error("Failed to extract ChatGPT account ID from login tokens.");
  return accountId;
}

function readSearchParam(params: URLSearchParams, key: string): string | null {
  const value = params.get(key);
  return typeof value === "string" ? value : null;
}

function parseAuthorizationInput(input: string): { code: string | null; state: string | null } {
  const value = input.trim();
  if (!value) return { code: null, state: null };
  try {
    const url = new URL(value);
    return {
      code: readSearchParam(url.searchParams, "code"),
      state: readSearchParam(url.searchParams, "state"),
    };
  } catch {}
  if (value.includes("code=")) {
    const params = new URLSearchParams(value);
    return { code: readSearchParam(params, "code"), state: readSearchParam(params, "state") };
  }
  if (value.includes("#")) {
    const [code, state] = value.split("#", 2);
    return { code, state };
  }
  return { code: value, state: null };
}

function parseTokenResponse(
  response: Response,
  errorPrefix: string,
): Effect<{ accessToken: string; refreshToken: string; expiresIn: number; idToken: string | null }, Error> {
  return Effect.gen(function* () {
    if (!response.ok) {
      const body = yield* fromPromise(() => response.text().catch(() => ""));
      return yield* Effect.fail(new Error(`${errorPrefix} (${response.status}). ${body}`.trim()));
    }
    const json = yield* fromPromise(() => response.json());
    const jsonRecord = toRecord(json);
    if (jsonRecord === null) {
      return yield* Effect.fail(new Error(`${errorPrefix} succeeded but returned an unexpected payload.`));
    }
    const accessToken = jsonRecord.access_token;
    const refreshToken = jsonRecord.refresh_token;
    const expiresIn = jsonRecord.expires_in;
    const rawIdToken = jsonRecord.id_token;
    if (typeof accessToken !== "string" || typeof refreshToken !== "string" || typeof expiresIn !== "number") {
      return yield* Effect.fail(new Error(`${errorPrefix} succeeded but returned an unexpected payload.`));
    }
    return {
      accessToken,
      refreshToken,
      expiresIn,
      idToken: typeof rawIdToken === "string" ? rawIdToken : null,
    };
  });
}

function exchangeAuthorizationCode(
  runtime: { http: HttpClient; clock: Clock; crypto: Crypto },
  code: string,
  verifier: string,
): Effect<ProviderAuth, Error> {
  return Effect.gen(function* () {
    const response = yield* fromPromise(() =>
      runtime.http.fetch(TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          client_id: CLIENT_ID,
          code,
          code_verifier: verifier,
          redirect_uri: REDIRECT_URI,
        }),
      }),
    );
    const { accessToken, refreshToken, expiresIn, idToken } = yield* parseTokenResponse(response, "Token exchange failed");
    return {
      access: accessToken,
      refresh: refreshToken,
      expires: runtime.clock.now() + expiresIn * 1000,
      accountId: extractAccountId(runtime.crypto, accessToken, idToken),
    };
  });
}

function createAuthorizationUrl(challenge: string, state: string): URL {
  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", CLIENT_ID);
  url.searchParams.set("redirect_uri", REDIRECT_URI);
  url.searchParams.set("scope", SCOPE);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", state);
  url.searchParams.set("id_token_add_organizations", "true");
  url.searchParams.set("codex_cli_simplified_flow", "true");
  url.searchParams.set("originator", ORIGINATOR);
  return url;
}

function readManualAuthorizationCode(terminal: Terminal, expectedState: string): Effect<string | null, Error> {
  return Effect.gen(function* () {
    const manual = yield* fromPromise(() =>
      terminal.promptText("Paste the redirect URL or authorization code:\n> ", { allowEmpty: false, signal: null }),
    );
    const parsed = parseAuthorizationInput(manual);
    if (parsed.state !== null && parsed.state !== expectedState) {
      return yield* Effect.fail(new Error("State mismatch."));
    }
    return parsed.code;
  });
}

function toRecord(value: unknown): { [key: string]: unknown } | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record: { [key: string]: unknown } = {};
  for (const key of Object.keys(value)) record[key] = Reflect.get(value, key);
  return record;
}

function fromPromise<A>(thunk: () => Promise<A>): Effect<A, Error> {
  return Effect.tryPromise({ try: thunk, catch: toError });
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
