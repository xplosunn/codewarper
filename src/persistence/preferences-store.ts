import type { ProviderSelection } from "../providers/index.ts";
import type { PersistenceRuntime } from "./services.ts";

export type ProviderSelectionPreference = ProviderSelection;

interface PreferenceData {
  providerSelection?: unknown;
}

export interface PreferencesStore {
  getProviderSelection(): ProviderSelectionPreference | null;
  setProviderSelection(selection: ProviderSelectionPreference): void;
}

export function createPreferencesStore(
  runtime: PersistenceRuntime,
  filePath: string = defaultPreferencesPath(runtime),
): PreferencesStore {
  return {
    getProviderSelection() {
      const data = readPreferenceData(runtime, filePath);
      return parseProviderSelectionPreference(data.providerSelection);
    },
    setProviderSelection(selection) {
      writePreferenceData(runtime, filePath, {
        ...readPreferenceData(runtime, filePath),
        providerSelection: selection,
      });
    },
  };
}

function defaultPreferencesPath(runtime: PersistenceRuntime): string {
  return runtime.paths.join(runtime.fileSystem.home(), ".codewarper", "preferences.json");
}

function readPreferenceData(runtime: PersistenceRuntime, filePath: string): PreferenceData {
  if (!runtime.fileSystem.exists(filePath)) {
    return {};
  }

  try {
    const raw = runtime.fileSystem.readText(filePath);
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as PreferenceData;
    }

    return {};
  } catch {
    return {};
  }
}

function writePreferenceData(runtime: PersistenceRuntime, filePath: string, data: PreferenceData): void {
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

function parseProviderSelectionPreference(value: unknown): ProviderSelectionPreference | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const providerId = Reflect.get(value, "providerId");
  if (typeof providerId !== "string" || providerId.length === 0) {
    return null;
  }

  const options = Reflect.get(value, "options");
  if (isStringRecord(options)) {
    return { providerId, options };
  }

  return null;
}

function isStringRecord(value: unknown): value is Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  return Object.entries(value).every(
    ([key, optionValue]) => key.length > 0 && typeof optionValue === "string" && optionValue.length > 0,
  );
}
