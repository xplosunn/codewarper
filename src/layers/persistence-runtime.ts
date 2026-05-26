import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FileSystem, Paths, PersistenceRuntime } from "../persistence/services.ts";

export function createPersistenceRuntime(): PersistenceRuntime {
  const fileSystem: FileSystem = {
    home: () => os.homedir(),
    exists: (filePath) => existsSync(filePath),
    readText: (filePath) => readFileSync(filePath, "utf8"),
    writeText: (filePath, contents) => writeFileSync(filePath, contents, "utf8"),
    mkdirAll: (directoryPath, mode) => {
      mkdirSync(directoryPath, { recursive: true, mode });
    },
    chmod: (filePath, mode) => chmodSync(filePath, mode),
  };

  const paths: Paths = {
    dirname: (filePath) => path.dirname(filePath),
    join: (...parts) => path.join(...parts),
  };

  return { fileSystem, paths };
}
