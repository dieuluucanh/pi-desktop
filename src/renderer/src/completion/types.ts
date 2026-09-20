/**
 * The completion contract (plan step 7).
 *
 * These types are a **structural mirror** of `@earendil-works/pi-tui`'s
 * `AutocompleteProvider`, deliberately: extensions call
 * `ctx.ui.addAutocompleteProvider((current) => …)` and the host forwards those
 * factories (step 16), so a provider written against Pi's own types must drop
 * into our stack unchanged. Every field pi-tui declares is present with the same
 * shape; the extra fields are optional, which keeps that assignability.
 *
 * The engine is free of DOM and Electron imports on purpose: it lives in the
 * renderer, but is type-checked by the node project and unit-tested without a DOM.
 */

/** Where a suggestion came from; shown so a name collision is never silent. */
export type CompletionSource = "app" | "extension" | "prompt" | "skill" | "file" | "document";

export interface CompletionItem {
  /** Text inserted when the item is accepted. */
  value: string;
  /** What the list shows. */
  label: string;
  description?: string;
  /** Secondary line: an argument hint, a directory, a skill path. */
  detail?: string;
  source?: CompletionSource;
  /** Set for directory-like entries so accepting them does not add a space. */
  continueAfter?: boolean;
}

export interface CompletionSuggestions {
  items: CompletionItem[];
  /** The text immediately before the caret that accepting an item replaces. */
  prefix: string;
}

export interface CompletionOptions {
  signal: AbortSignal;
  /** True when the user asked explicitly (Tab) rather than typed a trigger. */
  force?: boolean;
}

export interface CompletionResult {
  lines: string[];
  cursorLine: number;
  cursorCol: number;
}

export interface CompletionProvider {
  id?: string;
  triggerCharacters?: string[];
  getSuggestions(
    lines: string[],
    cursorLine: number,
    cursorCol: number,
    options: CompletionOptions,
  ): Promise<CompletionSuggestions | null>;
  applyCompletion(
    lines: string[],
    cursorLine: number,
    cursorCol: number,
    item: CompletionItem,
    prefix: string,
  ): CompletionResult;
  shouldTriggerFileCompletion?(lines: string[], cursorLine: number, cursorCol: number): boolean;
}

/**
 * Pi's own factory shape: a wrapper receives the provider built so far and
 * returns the provider to use. Extension providers are applied in registration
 * order, exactly as the TUI does.
 */
export type CompletionProviderFactory = (current: CompletionProvider) => CompletionProvider;

/** The default `applyCompletion`: replace `prefix` before the caret. */
export function applyCompletionInPlace(
  lines: string[],
  cursorLine: number,
  cursorCol: number,
  item: CompletionItem,
  prefix: string,
): CompletionResult {
  const next = [...lines];
  const line = next[cursorLine] ?? "";
  const start = Math.max(0, cursorCol - prefix.length);
  const insertion = item.continueAfter ? item.value : `${item.value} `;
  next[cursorLine] = `${line.slice(0, start)}${insertion}${line.slice(cursorCol)}`;
  return { lines: next, cursorLine, cursorCol: start + insertion.length };
}
