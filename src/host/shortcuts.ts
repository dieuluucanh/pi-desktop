/**
 * Extension shortcuts host surface (plan step 15).
 *
 * Extensions register keyboard shortcuts on the session's `ExtensionRunner`;
 * the host lists them (`shortcuts.list`) and runs a handler (`shortcuts.invoke`)
 * with the runner's own extension context, so a shortcut fires exactly as it
 * would from terminal Pi. Only a session host can answer: the control host has
 * no `ExtensionRunner` and replies `not_implemented`.
 *
 * Both methods have no RPC equivalent, which
 * `docs/architecture/host-protocol.md` records.
 */

import type { HostMethod } from "../shared/host-protocol";
import { sortShortcuts, type ExtensionShortcutSummary } from "../shared/shortcuts";
import type { HostHandler } from "./service";

export class ShortcutError extends Error {
  readonly code: string;

  constructor(message: string, code = "bad_request") {
    super(message);
    this.name = "ShortcutError";
    this.code = code;
  }
}

/** The methods this module answers (session hosts only). */
export const SHORTCUT_METHODS = [
  "shortcuts.list",
  "shortcuts.invoke",
] as const satisfies readonly HostMethod[];

/** One registered shortcut as Pi reports it. */
export interface RunnerShortcut {
  key: string;
  description?: string;
  extensionPath: string;
}

/**
 * Pi's extension context, forwarded opaquely (its fields belong to the SDK).
 * Typed as `object` — not `unknown` — so threading it through the handlers
 * needs no casts in host code, while the SDK adapter downcasts once at its
 * own boundary.
 */
export type ShortcutContext = object;

/** The narrow `ExtensionRunner` surface the handlers drive. */
export interface ShortcutRunner {
  /** Registered shortcuts keyed by their chord, resolved against the user bindings. */
  getShortcuts(resolvedKeybindings: Record<string, unknown>): Map<string, RunnerShortcut>;
  /** Loader diagnostics for shortcuts (collisions, bad keys). */
  getShortcutDiagnostics(): Array<{ type?: unknown; message?: unknown; path?: unknown }>;
  /** The extension context a handler runs with. */
  createContext(): ShortcutContext;
  /** Runs one shortcut's handler. */
  invokeShortcut(key: string, context: ShortcutContext): Promise<unknown> | unknown;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** Lists shortcuts through the runner, sanitized for the renderer. */
export function listShortcuts(
  runner: ShortcutRunner | null,
  resolvedKeybindings: Record<string, unknown>,
  now: () => number = Date.now,
): {
  shortcuts: ExtensionShortcutSummary[];
  diagnostics: Array<{ type: "warning" | "error" | "collision"; message: string; path?: string }>;
  loadedAt: number;
} {
  if (!runner) {
    throw new ShortcutError(
      "shortcuts are not available in this host: open a session first",
      "not_implemented",
    );
  }
  const shortcuts: ExtensionShortcutSummary[] = [];
  for (const shortcut of runner.getShortcuts(resolvedKeybindings).values()) {
    if (typeof shortcut.key !== "string" || typeof shortcut.extensionPath !== "string") continue;
    const path = shortcut.extensionPath;
    const tail =
      path
        .replace(/[\\/]+$/, "")
        .split(/[\\/]/)
        .pop() ?? path;
    shortcuts.push({
      key: shortcut.key,
      ...(typeof shortcut.description === "string" && shortcut.description.length > 0
        ? { description: shortcut.description }
        : {}),
      extensionPath: path,
      source: tail,
    });
  }
  const diagnostics = runner.getShortcutDiagnostics().flatMap((entry) => {
    const message = typeof entry.message === "string" ? entry.message : null;
    if (!message) return [];
    const type: "warning" | "error" | "collision" =
      entry.type === "error" || entry.type === "collision" ? entry.type : "warning";
    const path = typeof entry.path === "string" ? entry.path : undefined;
    return [{ type, message, ...(path ? { path } : {}) }];
  });
  return { shortcuts: sortShortcuts(shortcuts), diagnostics, loadedAt: now() };
}

export interface ShortcutHandlerOptions {
  /** The live runner, or null when this host has no session (control hosts). */
  resolveRunner(): ShortcutRunner | null;
  /**
   * Effective user bindings, so shortcuts resolve the user's remaps. Async
   * because the port may read `keybindings.json` from disk.
   */
  resolveKeybindings(): Record<string, unknown> | Promise<Record<string, unknown>>;
}

export function createShortcutHandlers(options: ShortcutHandlerOptions): {
  handlers(): Partial<Record<HostMethod, HostHandler>>;
} {
  return {
    handlers: () => ({
      "shortcuts.list": async () =>
        listShortcuts(options.resolveRunner(), await options.resolveKeybindings()),
      "shortcuts.invoke": async (params) => {
        const runner = options.resolveRunner();
        if (!runner) {
          throw new ShortcutError(
            "shortcuts are not available in this host: open a session first",
            "not_implemented",
          );
        }
        const key = asRecord(params).key;
        if (typeof key !== "string" || key.length === 0) {
          throw new ShortcutError("shortcuts.invoke requires a key");
        }
        await runner.invokeShortcut(key, runner.createContext());
        return { invoked: key };
      },
    }),
  };
}
