import { Context } from "#effect";
import type { PreferencesStore } from "./preferences-store.ts";

export class PreferencesStoreService extends Context.Tag("codewarper/PreferencesStoreService")<
  PreferencesStoreService,
  PreferencesStore
>() {}
