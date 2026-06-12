import type { CodewarperCommand } from "../config/load-codewarper.ts";
import type { Conversation, SessionConfiguration } from "../step/index.ts";

export type App = {
  sessionConfiguration: SessionConfiguration;
  conversation: Conversation;
  commands: CodewarperCommand[];
};

export type UserInput =
  | { type: "empty" }
  | { type: "quit" }
  | { type: "switch_model" }
  | { type: "login" }
  | { type: "reload" }
  | { type: "help" }
  | { type: "custom_command"; name: string; args: string[] }
  | { type: "unknown_command"; command: string }
  | { type: "prompt"; text: string };

export type LoopResult =
  | { type: "stop" }
  | { type: "continue"; app: App };
