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
 * A `!` / `!!` line is a shell command and has **no built-in source**: it is
 * never a `/` command, an `@` mention, a `#` document or a forced file list.
 * That matches terminal Pi, which has no shell autocomplete provider. The
 * extension chain still runs after the built-ins and may answer `!` itself.
 *
 * Extension providers are not merged into that decision. They are applied as
 * **wrappers** in registration order — Pi's own
 * `addAutocompleteProvider((current) => …)` shape — so an extension sees every
 * keystroke first, may answer it, and may delegate to us when it has nothing.
 * That is what makes host-forwarded providers (step 16) behave exactly like they
 * do in the terminal, including an extension that opts into `!` completion.
 */

import { isShellCommand } from "../../../shared/shell-command";
import { tokenAtCursor } from "./token";
import {
  applyCompletionInPlace,
  type CompletionProvider,
  type CompletionProviderFactory,
} from "./types";
import {
  createExtensionCompletionProvider,
  type ExtensionCompletionBridge,
} from "./extension-source";

export interface CompletionStackOptions {
  command?: CompletionProvider | null;
  file?: CompletionProvider | null;
  document?: CompletionProvider | null;
  /**
   * Host-run extension providers (plan step 16). The factories live in the host
   * (a function cannot cross the frame boundary), so the whole chain is
   * evaluated there and this bridge fetches the result.
   */
  extension?: ExtensionCompletionBridge | null;
  /** Local factories, applied in registration order (tests and future sources). */
  extensionFactories?: readonly CompletionProviderFactory[];
}

export function createCompletionProvider(options: CompletionStackOptions = {}): CompletionProvider {
  let base = createBaseProvider(options);
  if (options.extension) base = createExtensionCompletionProvider(base, options.extension);
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
      // Deliberately permissive on a shell line: the base provider returns
      // null there, but Tab must still reach an extension that opts into `!`
      // completion. Do not turn this into a shell-line guard.
      //
      // A `/` command line is never a file path — including its argument
      // section, where Tab asks the command hook again (Pi parity).
      if (cursorLine === 0 && (lines[0] ?? "").startsWith("/")) return false;
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

function isShellBuffer(lines: readonly string[]): boolean {
  return isShellCommand(lines.join("\n"));
}

function selectProvider(
  options: CompletionStackOptions,
  lines: readonly string[],
  cursorLine: number,
  cursorCol: number,
  force: boolean,
): CompletionProvider | null {
  const token = tokenAtCursor(lines, cursorLine, cursorCol).query;

  // A `!`/`!!` buffer is a shell command and has no built-in source. Returning
  // null here still lets the extension wrapper answer it after the built-ins.
  if (isShellBuffer(lines)) return null;

  // A `/` on the first line is always a command line (name or arguments),
  // never a path. Checking the whole line matters after the first space: the
  // token is then `use`, not `/profile`, but the provider must still answer.
  if (cursorLine === 0 && (lines[0] ?? "").startsWith("/")) return options.command ?? null;
  if (token.startsWith("@")) return options.file ?? null;
  if (token.startsWith("#")) return options.document ?? null;
  if (force && options.file) return options.file;
  return null;
}
