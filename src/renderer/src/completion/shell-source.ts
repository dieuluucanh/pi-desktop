/**
 * Path completion after a shell prefix (2026-10-30 rail-shell-checkpoint plan).
 *
 * `!command` and `!!command` are executed by the host, but the argument is
 * still a path in the session folder. This provider reuses the `@` file source
 * so a shell line gets the same workspace-relative completion without a second
 * file cache. It never suggests absolute/home paths: the host only lists the
 * session root.
 */

import { fuzzyFilter } from "./fuzzy";
import { toItem, type FileListSnapshot } from "./file-source";
import { tokenAtCursor } from "./token";
import {
  applyCompletionInPlace,
  type CompletionProvider,
  type CompletionSuggestions,
} from "./types";

export interface ShellProviderOptions {
  loadFiles(options: { signal: AbortSignal; refresh?: boolean }): Promise<FileListSnapshot | null>;
  limit?: number;
}

export const DEFAULT_SHELL_SUGGESTIONS = 50;

/** True when the cursor's line is a `!` / `!!` shell line. */
export function isShellLine(lines: readonly string[], cursorLine: number): boolean {
  if (cursorLine !== 0) return false;
  return (lines[0] ?? "").trimStart().startsWith("!");
}

export function createShellProvider(options: ShellProviderOptions): CompletionProvider {
  const limit = options.limit ?? DEFAULT_SHELL_SUGGESTIONS;
  return {
    id: "shell-paths",
    triggerCharacters: ["!"],
    async getSuggestions(lines, cursorLine, cursorCol, completionOptions) {
      if (!isShellLine(lines, cursorLine)) return null;
      const token = tokenAtCursor(lines, cursorLine, cursorCol);
      const query = token.query;
      // A flag is not a path, and the host listing is rooted at the workspace,
      // so an absolute or home path has no truthful answer here.
      if (query.length === 0) return null;
      if (query.startsWith("-") || query.startsWith("/") || query.startsWith("~")) return null;
      if (/^[a-zA-Z]:[\\/]/.test(query)) return null;

      const snapshot = await options.loadFiles({ signal: completionOptions.signal });
      if (snapshot === null || completionOptions.signal.aborted) return null;

      const ranked = fuzzyFilter(snapshot.files, query, (file) => file);
      if (ranked.length === 0) return null;
      return { items: ranked.slice(0, limit).map(toItem), prefix: query };
    },
    applyCompletion: applyCompletionInPlace,
  };
}

/** Convenience for tests and callers that already have a list. */
export function suggestionsFromShellFiles(
  files: readonly string[],
  query: string,
  prefix: string,
  limit = DEFAULT_SHELL_SUGGESTIONS,
): CompletionSuggestions | null {
  const ranked = fuzzyFilter(files, query, (file) => file);
  if (ranked.length === 0) return null;
  return { items: ranked.slice(0, limit).map(toItem), prefix };
}
