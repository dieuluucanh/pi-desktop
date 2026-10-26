/**
 * The `ShortcutRunner` over a live session's `ExtensionRunner` (plan step 15).
 *
 * `getShortcuts` receives the app's effective bindings, so an extension
 * shortcut the user remapped in `keybindings.json` is listed under — and
 * invoked through — the remapped chord, exactly as terminal Pi resolves it.
 * Invocation runs the handler with the runner's own extension context.
 *
 * Only root-exported SDK types are used (`ExtensionShortcut`); the runner
 * itself arrives as the session core's injected `extensionRunner`.
 */

import type { ExtensionContext, ExtensionShortcut } from "@earendil-works/pi-coding-agent";
import type { RunnerShortcut, ShortcutContext, ShortcutRunner } from "../shortcuts";

/** The narrow runner surface the adapter drives (mirrors the SDK's runner). */
export interface SdkExtensionRunner {
  getShortcuts(
    resolvedKeybindings: Record<string, string | readonly string[]>,
  ): Map<unknown, ExtensionShortcut>;
  getShortcutDiagnostics(): Array<{ type?: unknown; message?: unknown; path?: unknown }>;
  createContext(): ShortcutContext;
}

function toSummary(key: string, shortcut: ExtensionShortcut): RunnerShortcut {
  return {
    key,
    ...(typeof shortcut.description === "string" && shortcut.description.length > 0
      ? { description: shortcut.description }
      : {}),
    extensionPath: shortcut.extensionPath,
  };
}

export function createSdkShortcutRunner(runner: SdkExtensionRunner): ShortcutRunner {
  /**
   * The bindings the last `getShortcuts` call resolved. The renderer lists
   * shortcuts (with the user's effective bindings) and then invokes the chord it
   * matched, so the invocation must resolve against the *same* table — an empty
   * map here would silently miss a remapped shortcut (session-parity step 23).
   */
  let lastResolved: Record<string, unknown> = {};

  const entries = (
    resolved: Record<string, unknown>,
  ): Array<{ key: string; shortcut: ExtensionShortcut }> => {
    lastResolved = resolved;
    const listed: Array<{ key: string; shortcut: ExtensionShortcut }> = [];
    for (const [key, shortcut] of runner.getShortcuts(
      resolved as Record<string, string | readonly string[]>,
    )) {
      const chord = typeof key === "string" ? key : String(shortcut.shortcut ?? key);
      listed.push({ key: chord, shortcut });
    }
    return listed;
  };

  return {
    getShortcuts: (resolved) => {
      const map = new Map<string, RunnerShortcut>();
      for (const { key, shortcut } of entries(resolved)) map.set(key, toSummary(key, shortcut));
      return map;
    },
    getShortcutDiagnostics: () => runner.getShortcutDiagnostics(),
    createContext: () => runner.createContext(),
    invokeShortcut: async (key, context) => {
      // The renderer sends back a key from `shortcuts.list`, so an exact match
      // is the honest lookup — no fuzzy remapping of the user's intent. Resolve
      // against the bindings that produced that list, not an empty table.
      const found = entries(lastResolved).find((entry) => entry.key === key);
      if (!found) throw new Error(`no extension shortcut is bound to "${key}"`);
      await found.shortcut.handler(context as ExtensionContext);
    },
  };
}
