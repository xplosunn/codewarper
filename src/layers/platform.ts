import process from "node:process";
import os from "node:os";
import type { Clock, Environment, SystemInfo } from "../providers/services.ts";

export function createSystemInfo(): SystemInfo {
  return {
    platform: () => os.platform(),
    release: () => os.release(),
    arch: () => os.arch(),
  };
}

export function createClock(): Clock {
  return {
    now: () => Date.now(),
  };
}

export function createEnvironment(): Environment {
  return {
    get: (name) => process.env[name],
  };
}
