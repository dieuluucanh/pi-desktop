/**
 * The composable completion stack (plan step 7).
 *
 * One provider decides which built-in source answers a keystroke:
 *
 *   `/` on the first line, before any space → commands
 *   `@…`                                    → workspace files
 *   `#…`                                    → open Office documents
 *   Tab (`force`) on a path-shaped token     → workspace files
 *
 * Extension providers are not merged into that decision. They are applied as
 * **wrappers** in registration order — Pi's own
 * `addAutocompleteProvider((current) => …)` shape — so an extension sees every
 * keystroke first, may answer it, and may delegate to us when it has nothing.
 * That is what makes host-forwarded providers (step 16) behave exactly like they
 * do in the terminal.
 */

import { tokenAtCursor } from "./token";
import {
  applyCompletionInPlace,
  type CompletionProvider,
  type CompletionProviderFactory,
} from "./types";

export interface CompletionStackOptions {
  command?: CompletionProvider | null;
  file?: CompletionProvider | null;
  document?: CompletionProvider | null;
  /** Extension providers, applied in registration order. */
  extensionFactories?: readonly CompletionProviderFactory[];
}

export function createCompletionProvider(options: CompletionStackOptions = {}): CompletionProvider {
  const base = createBaseProvider(options);
  return applyProviderFactories(base, options.extensionFactories ?? []);
}

/** The built-in source picker, without extension wrappers. */
export function createBaseProvider(options: CompletionStackOptions): CompletionProvider {
  return {
    id: "pi-desktop-completion",
    triggerCharacters: ["/", "@", "#"],
    async getSuggestions(lines, cursorLine, cursorCol, completionOptions) {
      const provider = selectProvider(
        options,
        lines,
        cursorLine,
        cursorCol,
        completionOptions.force === true,
      );
      if (!provider) return null;
      const suggestions = await provider.getSuggestions(
        lines,
        cursorLine,
        cursorCol,
        completionOptions,
      );
      if (!suggestions || suggestions.items.length === 0) return null;
      return suggestions;
    },
    applyCompletion: applyCompletionInPlace,
    shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
      const token = tokenAtCursor(lines, cursorLine, cursorCol);
      if (token.query.startsWith("@") || token.query.startsWith("#")) return false;
      return !token.query.startsWith("/");
    },
  };
}

/** Applies Pi's factory shape left to right: each wrapper receives the current provider. */
export function applyProviderFactories(
  base: CompletionProvider,
  factories: readonly CompletionProviderFactory[],
): CompletionProvider {
  let current = base;
  for (const factory of factories) {
    const next = factory(current);
    if (next) current = next;
  }
  return current;
}

function selectProvider(
  options: CompletionStackOptions,
  lines: readonly string[],
  cursorLine: number,
  cursorCol: number,
  force: boolean,
): CompletionProvider | null {
  const token = tokenAtCursor(lines, cursorLine, cursorCol).query;

  // A `/` on the first line before any space is always a command, never a path.
  if (cursorLine === 0 && token.startsWith("/")) return options.command ?? null;
  if (token.startsWith("@")) return options.file ?? null;
  if (token.startsWith("#")) return options.document ?? null;
  if (force && options.file) return options.file;
  return null;
}
