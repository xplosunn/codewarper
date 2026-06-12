import type { AuthStore, PersistenceRuntime } from "./services.ts";

interface AuthData<AuthValue> {
  [providerId: string]: AuthValue;
}

export function createAuthStore<AuthValue>(
  runtime: PersistenceRuntime,
  filePath: string = defaultAuthPath(runtime),
): AuthStore<AuthValue> {
  return {
    get(providerId) {
      const auth = readAuthData<AuthValue>(runtime, filePath)[providerId];
      if (auth === undefined) {
        return null;
      }

      return auth;
    },
    set(providerId, auth) {
      writeAuthData(
        runtime,
        filePath,
        withProviderAuth(readAuthData<AuthValue>(runtime, filePath), providerId, auth),
      );
    },
  };
}

function defaultAuthPath(runtime: PersistenceRuntime): string {
  return runtime.paths.join(runtime.fileSystem.home(), ".codewarper", "auth.json");
}

function readAuthData<AuthValue>(
  runtime: PersistenceRuntime,
  filePath: string,
): AuthData<AuthValue> {
  if (!runtime.fileSystem.exists(filePath)) {
    return {};
  }

  try {
    const raw = runtime.fileSystem.readText(filePath);
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed;
    }

    return {};
  } catch {
    return {};
  }
}

function writeAuthData<AuthValue>(
  runtime: PersistenceRuntime,
  filePath: string,
  data: AuthData<AuthValue>,
): void {
  const directory = runtime.paths.dirname(filePath);
  if (!runtime.fileSystem.exists(directory)) {
    runtime.fileSystem.mkdirAll(directory, 0o700);
  }

  runtime.fileSystem.writeText(filePath, JSON.stringify(data, null, 2));

  try {
    runtime.fileSystem.chmod(filePath, 0o600);
  } catch {
    // Best effort only.
  }
}

function withProviderAuth<AuthValue>(
  data: AuthData<AuthValue>,
  providerId: string,
  auth: AuthValue,
): AuthData<AuthValue> {
  return {
    ...data,
    [providerId]: auth,
  };
}
