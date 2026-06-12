import { spawn } from "node:child_process";
import http from "node:http";
import process from "node:process";
import type {
  OAuth,
  OAuthCallbackCode,
  OAuthCallbackHandle,
} from "../providers/services.ts";

function browserCommands(url: string): Array<[string, string[]]> {
  if (process.platform === "darwin") {
    return [["open", [url]]];
  }

  if (process.platform === "win32") {
    return [["cmd", ["/c", "start", "", url]]];
  }

  return [["xdg-open", [url]]];
}

function openUrl(url: string): void {
  for (const [command, args] of browserCommands(url)) {
    try {
      const child = spawn(command, args, {
        detached: true,
        stdio: "ignore",
      });
      child.on("error", () => {
        // Ignore launcher failures and fall back to the printed URL.
      });
      child.unref();
      return;
    } catch {
      // Try the next launcher.
    }
  }
}

function fallbackOAuthCallbackHandle(): OAuthCallbackHandle {
  const close = () => {
    // Nothing to close.
  };

  const cancel = () => {
    // Nothing to cancel.
  };

  const waitForCode: OAuthCallbackHandle["waitForCode"] = async () => null;

  return { close, cancel, waitForCode };
}

function startOAuthCallbackServer(expectedState: string, redirectUri: string): Promise<OAuthCallbackHandle> {
  let settle: (value: OAuthCallbackCode | null) => void = () => {};
  let settled = false;

  const codePromise = new Promise<OAuthCallbackCode | null>((resolve) => {
    settle = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
  });

  const callbackUrl = new URL(redirectUri);
  const port = Number(callbackUrl.port || "80");

  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const requestUrl = typeof req.url === "string" ? req.url : "";
      const url = new URL(requestUrl, redirectUri);

      if (url.pathname !== callbackUrl.pathname) {
        res.statusCode = 404;
        res.end("Not found");
        return;
      }

      if (url.searchParams.get("state") !== expectedState) {
        res.statusCode = 400;
        res.end("State mismatch");
        return;
      }

      const code = url.searchParams.get("code");
      if (!code) {
        res.statusCode = 400;
        res.end("Missing authorization code");
        return;
      }

      res.statusCode = 200;
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.end("<html><body><h1>Login complete</h1><p>You can close this window.</p></body></html>");
      settle({ code });
    });

    server.listen(port, () => {
      const handle: OAuthCallbackHandle = {
        close() {
          server.close();
        },

        cancel() {
          settle(null);
        },

        waitForCode() {
          return codePromise;
        },
      };
      resolve(handle);
    });

    server.on("error", () => {
      settle(null);
      resolve(fallbackOAuthCallbackHandle());
    });
  });
}

export function createOAuth(): OAuth {
  const startCallbackServer: OAuth["startCallbackServer"] = (expectedState, redirectUri) => {
    return startOAuthCallbackServer(expectedState, redirectUri);
  };

  return { openUrl, startCallbackServer };
}
