/**
 * The commands the **app** owns (plan step 7).
 *
 * Pi's TUI keeps its built-ins in `BUILTIN_SLASH_COMMANDS`, which the package
 * does not export, so the desktop app declares its own table instead of reaching
 * into an unexported constant. `/` therefore lists three layers: these commands
 * (source `app`), then the host's extension commands, prompt templates and
 * skills from `commands.list`.
 *
 * Two rules make the table safe:
 *  - a name here is **reserved**: it is dispatched before a same-named extension
 *    command, but completion still shows both so nothing is silently shadowed
 *    (see `dispatch.ts` and its collision tests);
 *  - an entry whose UI does not exist yet says so, naming the step that owns it.
 *    A dead `/tree` that quietly does nothing would be worse than an honest hint.
 *
 * Everything *not* in this table (extension commands, prompt templates,
 * `/skill:*`) is sent through `prompt`, where the SDK expands it.
 */

import type { HostMethod } from "../../../shared/host-protocol";

/** The views an app command can open (a subset of the app's `AppView`). */
export type AppCommandView =
  "settings" | "extensions" | "connections" | "skills" | "diagnostics" | "office";

export type AppCommandAction =
  /** Runs a host method on this session's host. */
  | {
      kind: "host";
      method: HostMethod;
      requiresArgument?: boolean;
      params?: (argument: string) => Record<string, unknown>;
    }
  /** Opens an app view. */
  | { kind: "view"; view: AppCommandView }
  /** Shows the command list. */
  | { kind: "help" }
  /** Not wired yet; the message names the owning step. */
  | { kind: "pending"; message: string }
  /** Opens one of the app's pickers (plan step 8). */
  | { kind: "picker"; picker: "model" | "thinking" };

export interface AppCommand {
  /** Without the leading slash. */
  name: string;
  description: string;
  argumentHint?: string;
  action: AppCommandAction;
}

export const APP_COMMANDS: readonly AppCommand[] = [
  {
    name: "new",
    description: "Start a new session in this project",
    action: { kind: "host", method: "session.new" },
  },
  {
    name: "clone",
    description: "Clone this session and switch to the copy",
    action: { kind: "host", method: "session.clone" },
  },
  {
    name: "name",
    description: "Rename this session",
    argumentHint: "<title>",
    action: {
      kind: "host",
      method: "session.rename",
      requiresArgument: true,
      params: (argument) => ({ name: argument }),
    },
  },
  {
    name: "compact",
    description: "Compact the conversation to free context",
    argumentHint: "[instructions]",
    action: {
      kind: "host",
      method: "compact",
      params: (argument) => (argument.length > 0 ? { instructions: argument } : {}),
    },
  },
  {
    name: "reload",
    description: "Reload extensions, skills and settings",
    action: { kind: "host", method: "session.reload" },
  },
  {
    name: "settings",
    description: "Open settings",
    action: { kind: "view", view: "settings" },
  },
  {
    name: "extensions",
    description: "Open the extensions hub",
    action: { kind: "view", view: "extensions" },
  },
  {
    name: "login",
    description: "Sign in to a provider",
    action: { kind: "view", view: "connections" },
  },
  {
    name: "logout",
    description: "Sign out of a provider",
    action: { kind: "view", view: "connections" },
  },
  {
    name: "help",
    description: "Show the commands and keys",
    action: { kind: "help" },
  },
  {
    name: "resume",
    description: "Resume a recent session",
    action: { kind: "pending", message: "the session browser arrives in step 11" },
  },
  {
    name: "tree",
    description: "Browse this session's conversation tree",
    action: { kind: "pending", message: "the session tree view arrives in step 11" },
  },
  {
    name: "fork",
    description: "Fork from an earlier message",
    action: { kind: "pending", message: "fork-from-message arrives in step 11" },
  },
  {
    name: "export",
    description: "Export this session to HTML",
    action: { kind: "pending", message: "HTML export arrives in step 11" },
  },
  {
    name: "model",
    description: "Choose the model",
    action: { kind: "picker", picker: "model" },
  },
  {
    name: "thinking",
    description: "Choose the thinking level",
    action: { kind: "picker", picker: "thinking" },
  },
  {
    name: "trust",
    description: "Review project trust",
    action: { kind: "pending", message: "the trust dialog arrives in step 10" },
  },
];

/** The reserved app command with this name, if any. */
export function findAppCommand(name: string): AppCommand | undefined {
  return APP_COMMANDS.find((command) => command.name === name);
}
