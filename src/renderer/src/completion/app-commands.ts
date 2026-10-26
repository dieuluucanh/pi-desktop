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
export type AppCommandView = "settings" | "extensions" | "connections" | "skills" | "diagnostics";

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
  | { kind: "picker"; picker: "model" | "thinking" }
  /** Opens the unified model picker as the scope editor (2026-10-25). */
  | { kind: "scope" }
  /** Opens the project trust prompt (plan step 10). */
  | { kind: "trust" }
  /** Opens the session browser (plan step 11). */
  | { kind: "browser" }
  /** Opens this session's history tree (plan step 11). */
  | { kind: "tree" }
  /** Opens the fork-from-message dialog for this session (plan step 11). */
  | { kind: "fork" }
  /** Exports this session to HTML and reveals it (plan step 11). */
  | { kind: "export" }
  /** Imports a session JSONL, replacing this one (plan step 14). */
  | { kind: "import" }
  /** Shows Pi's packaged changelog (plan step 15). */
  | { kind: "changelog" }
  /** Opens the shortcuts help (plan step 15). */
  | { kind: "hotkeys" }
  /** Closes this session tab (plan step 15). */
  | { kind: "quit" }
  /** Uploads the session as a secret gist (plan step 18). */
  | { kind: "share" }
  /** Builds a local bug-report zip (plan step 18). */
  | { kind: "bug" }
  /** Copies the last assistant answer (`/copy`, plan step 12). */
  | { kind: "copyLast" }
  /** Shows this session's file, id, tokens and cost (`/session`, plan step 12). */
  | { kind: "sessionInfo" };

export interface AppCommand {
  /** Without the leading slash. */
  name: string;
  description: string;
  argumentHint?: string;
  /** Which app-owned argument completer (and submit behaviour) this command uses. */
  argumentKind?: "model" | "thinking" | "provider" | "exportFormat";
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
    argumentHint: "[provider]",
    argumentKind: "provider",
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
    description: "Browse and resume a recent session",
    action: { kind: "browser" },
  },
  {
    name: "tree",
    description: "Browse this session's conversation tree",
    action: { kind: "tree" },
  },
  {
    name: "fork",
    description: "Fork from an earlier message",
    action: { kind: "fork" },
  },
  {
    name: "export",
    description: "Export this session (HTML by default, or JSONL)",
    argumentHint: "[html|jsonl]",
    argumentKind: "exportFormat",
    action: { kind: "export" },
  },
  {
    name: "import",
    description: "Replace this session with one from a JSONL file",
    argumentHint: "[path]",
    action: { kind: "import" },
  },
  {
    name: "copy",
    description: "Copy the last assistant answer",
    action: { kind: "copyLast" },
  },
  {
    name: "session",
    description: "Show this session's file, tokens and cost",
    action: { kind: "sessionInfo" },
  },
  {
    name: "model",
    description: "Choose the model",
    argumentHint: "[provider/model]",
    argumentKind: "model",
    action: { kind: "picker", picker: "model" },
  },
  {
    name: "scoped-models",
    description: "Choose the model scope (starred models)",
    action: { kind: "scope" },
  },
  {
    name: "thinking",
    description: "Choose the thinking level",
    argumentHint: "[level]",
    argumentKind: "thinking",
    action: { kind: "picker", picker: "thinking" },
  },
  {
    name: "trust",
    description: "Review project trust",
    action: { kind: "trust" },
  },
  {
    name: "changelog",
    description: "Show the Pi coding agent changelog",
    action: { kind: "changelog" },
  },
  {
    name: "hotkeys",
    description: "Show every keyboard shortcut",
    action: { kind: "hotkeys" },
  },
  {
    name: "quit",
    description: "Close this session tab",
    action: { kind: "quit" },
  },
  {
    name: "share",
    description: "Share this session as a secret gist",
    action: { kind: "share" },
  },
  {
    name: "bug",
    description: "Create a bug-report zip for this session",
    argumentHint: "[what happened]",
    action: { kind: "bug" },
  },
];

/** The reserved app command with this name, if any. */
export function findAppCommand(name: string): AppCommand | undefined {
  return APP_COMMANDS.find((command) => command.name === name);
}
