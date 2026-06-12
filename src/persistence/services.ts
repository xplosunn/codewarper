import { Context } from "#effect";

export interface AuthStore<AuthValue> {
  get(providerId: string): AuthValue | null;
  set(providerId: string, auth: AuthValue): void;
}

export interface FileSystem {
  home(): string;
  exists(path: string): boolean;
  readText(path: string): string;
  writeText(path: string, contents: string): void;
  mkdirAll(path: string, mode: number): void;
  chmod(path: string, mode: number): void;
}

export interface Paths {
  dirname(path: string): string;
  join(...parts: string[]): string;
}

export interface PersistenceRuntime {
  fileSystem: FileSystem;
  paths: Paths;
}

export class PersistenceRuntimeService extends Context.Tag("codewarper/PersistenceRuntimeService")<
  PersistenceRuntimeService,
  PersistenceRuntime
>() {}
