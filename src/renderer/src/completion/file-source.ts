/**
 * `@` file completion (plan step 7).
 *
 * The file list comes from the host's `files.list`, which is rooted at the
 * session's own cwd — the renderer never names a path to list, so completion
 * cannot be used to look outside the workspace. The list is fetched once and
 * cached by the store; filtering and ranking happen here, per keystroke.
 *
 * Absolute (`@/…`) and home (`@~/…`) prefixes deliberately return nothing rather
 * than pretending: the host only knows the workspace, and silently completing a
 * different root would be worse than no suggestion. Tab (`force`) also completes
 * a plain path-shaped token, matching the terminal editor.
 */

import { fuzzyFilter } from "./fuzzy";
import { tokenAtCursor } from "./token";
import {
  applyCompletionInPlace,
  type CompletionItem,
  type CompletionProvider,
  type CompletionSuggestions,
} from "./types";

export interface FileListSnapshot {
  files: readonly string[];
  root?: string;
  truncated?: boolean;
}

export interface FileProviderOptions {
  loadFiles(options: { signal: AbortSignal; refresh?: boolean }): Promise<FileListSnapshot | null>;
  limit?: number;
}

export const DEFAULT_FILE_SUGGESTIONS = 50;

export function createFileProvider(options: FileProviderOptions): CompletionProvider {
  const limit = options.limit ?? DEFAULT_FILE_SUGGESTIONS;
  return {
    id: "workspace-files",
    triggerCharacters: ["@"],
    async getSuggestions(lines, cursorLine, cursorCol, completionOptions) {
      const trigger = fileTrigger(lines, cursorLine, cursorCol, completionOptions.force === true);
      if (!trigger) return null;

      const snapshot = await options.loadFiles({ signal: completionOptions.signal });
      if (snapshot === null || completionOptions.signal.aborted) return null;

      const ranked = fuzzyFilter(snapshot.files, trigger.query, (file) => file);
      if (ranked.length === 0) return null;
      return { items: ranked.slice(0, limit).map(toItem), prefix: trigger.prefix };
    },
    applyCompletion: applyCompletionInPlace,
  };
}

/** Maps a workspace path to a suggestion: value is what gets inserted. */
export function toItem(path: string): CompletionItem {
  const value = toCompletionValue(path);
  return {
    value,
    label: path,
    ...(directoryOf(path) ? { description: directoryOf(path) } : {}),
    source: "file",
  };
}

/** A directory entry (trailing slash) keeps the token open so the user descends. */
export function toCompletionValue(path: string): string {
  if (path.endsWith("/")) return path;
  return path;
}

function directoryOf(path: string): string {
  const cut = path.lastIndexOf("/");
  return cut > 0 ? path.slice(0, cut) : "";
}

interface FileTrigger {
  prefix: string;
  query: string;
}

function fileTrigger(
  lines: readonly string[],
  cursorLine: number,
  cursorCol: number,
  force: boolean,
): FileTrigger | null {
  const token = tokenAtCursor(lines, cursorLine, cursorCol);
  const query = token.query;
  if (query.startsWith("@")) {
    const rest = query.slice(1);
    // The host lists one root; an absolute or home path is not something we can
    // answer truthfully, so offer nothing rather than the wrong files.
    if (rest.startsWith("/") || rest.startsWith("~") || /^[a-zA-Z]:/.test(rest)) return null;
    return { prefix: query, query: rest };
  }
  if (!force) return null;
  if (query.length === 0) return null;
  // Tab on a plain word only offers files when it looks like a path.
  if (!query.includes("/") && !query.includes(".")) return null;
  return { prefix: query, query };
}

/** Convenience for tests and callers that already have a list. */
export function suggestionsFromFiles(
  files: readonly string[],
  query: string,
  prefix: string,
  limit = DEFAULT_FILE_SUGGESTIONS,
): CompletionSuggestions | null {
  const ranked = fuzzyFilter(files, query, (file) => file);
  if (ranked.length === 0) return null;
  return { items: ranked.slice(0, limit).map(toItem), prefix };
}
