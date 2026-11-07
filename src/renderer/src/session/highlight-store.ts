/**
 * Token cache for Markdown code blocks (2026-11-07 transcript-highlight-stability).
 *
 * Why this exists: `CodeBlock` used to keep Shiki's tokens in component state.
 * That is enough while a block stays mounted, but the transcript is virtualized
 * and every re-render of `Markdown` (before its renderers were hoisted) remounted
 * the whole subtree. A remount started from `null`, painted the plain source and
 * then coloured it when the async highlight resolved — the reported flash.
 *
 * The cache is keyed by `language + "\0" + code`, so a remount of the same fence
 * paints colour on its first frame. It is bounded by both entry count and total
 * source size: a 10k-item session can contain thousands of fences and the
 * renderer must not accumulate them forever.
 *
 * This module is deliberately pure: no React, no DOM, no Electron. The loader is
 * injected so it is unit-testable with a fake highlighter, and so `Markdown.tsx`
 * stays the only place that knows about the `shiki` import.
 */

export interface HighlightToken {
  content: string;
  color?: string;
}

/** Shiki's `codeToTokens` line/token shape, as readonly data. */
export type HighlightLines = readonly (readonly HighlightToken[])[];

/** The two members of a Shiki highlighter this app uses. */
export interface HighlighterLike {
  loadLanguage(language: string): Promise<void>;
  codeToTokens(
    code: string,
    options: { lang: string; theme: string },
  ): { tokens: HighlightToken[][] };
}

/** The one Shiki theme the transcript uses (kept out of components). */
export const HIGHLIGHT_THEME = "github-dark";

export interface HighlightStoreOptions {
  /** Entries kept before the oldest is evicted. Default 200. */
  maxEntries?: number;
  /** Total source characters kept before the oldest entries are evicted. Default 1M. */
  maxChars?: number;
  /**
   * Largest block tokenized synchronously during render. A bigger block falls
   * back to the async path so a keystroke is never blocked by a huge fence.
   * Default 20k characters.
   */
  maxSyncChars?: number;
  /** Shiki theme name. Default `HIGHLIGHT_THEME`. */
  theme?: string;
}

export interface HighlightStore {
  /** A cached result, or `null`. Never tokenizes and never reorders entries. */
  cached(key: string): HighlightLines | null;
  /**
   * Tokenize during render when the highlighter and the language are already
   * loaded. This is what removes the plain frame for a warm remount; it returns
   * `null` (rather than starting work) otherwise.
   */
  sync(key: string, code: string, language: string): HighlightLines | null;
  /**
   * Cache hit, or the shared in-flight request for this key, or a fresh load.
   * Resolves `null` for a highlighter/grammar failure; a later call retries.
   */
  load(key: string, code: string, language: string): Promise<HighlightLines | null>;
  /** Drops cached tokens and language readiness (tests; a future theme switch). */
  reset(): void;
}

interface CacheEntry {
  lines: HighlightLines;
  chars: number;
}

const DEFAULT_MAX_ENTRIES = 200;
const DEFAULT_MAX_CHARS = 1_000_000;
const DEFAULT_MAX_SYNC_CHARS = 20_000;

function positiveInt(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(1, Math.floor(value));
}

function charBudget(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(0, Math.floor(value));
}

export function createHighlightStore(
  loadHighlighter: () => Promise<HighlighterLike | null>,
  options: HighlightStoreOptions = {},
): HighlightStore {
  const maxEntries = positiveInt(options.maxEntries, DEFAULT_MAX_ENTRIES);
  const maxChars = charBudget(options.maxChars, DEFAULT_MAX_CHARS);
  const maxSyncChars = charBudget(options.maxSyncChars, DEFAULT_MAX_SYNC_CHARS);
  const theme = options.theme ?? HIGHLIGHT_THEME;

  const entries = new Map<string, CacheEntry>();
  let totalChars = 0;

  const readyLanguages = new Set<string>();
  const languageLoads = new Map<string, Promise<boolean>>();
  const pending = new Map<string, Promise<HighlightLines | null>>();

  let highlighter: HighlighterLike | null = null;
  let highlighterSettled = false;
  let highlighterStart: Promise<HighlighterLike | null> | null = null;

  function ensureHighlighter(): Promise<HighlighterLike | null> {
    highlighterStart ??= loadHighlighter().then(
      (loaded) => {
        highlighter = loaded;
        highlighterSettled = true;
        return loaded;
      },
      (): null => {
        // A failed import stays failed for the life of the process: `Markdown`'s
        // loader already memoizes its own rejection, so retrying here would only
        // repeat the same failure on every code block.
        highlighter = null;
        highlighterSettled = true;
        return null;
      },
    );
    return highlighterStart;
  }

  function ensureLanguage(target: HighlighterLike, language: string): Promise<boolean> {
    if (readyLanguages.has(language)) return Promise.resolve(true);
    const inFlight = languageLoads.get(language);
    if (inFlight) return inFlight;
    const run = target.loadLanguage(language).then(
      () => {
        readyLanguages.add(language);
        languageLoads.delete(language);
        return true;
      },
      () => {
        // Forget the attempt so a later block (or a retry after a grammar fix)
        // can try again instead of being stuck on a rejected promise.
        languageLoads.delete(language);
        return false;
      },
    );
    languageLoads.set(language, run);
    return run;
  }

  function remove(key: string): void {
    const entry = entries.get(key);
    if (!entry) return;
    entries.delete(key);
    totalChars -= entry.chars;
    if (totalChars < 0) totalChars = 0;
  }

  function remember(key: string, chars: number, lines: HighlightLines): void {
    if (entries.has(key)) return;
    // An oversized block must not evict the whole cache just to hold itself.
    if (chars > maxChars) return;
    entries.set(key, { lines, chars });
    totalChars += chars;
    while (entries.size > maxEntries || totalChars > maxChars) {
      const oldest = entries.keys().next().value;
      if (oldest === undefined) break;
      remove(oldest);
    }
  }

  function tokenize(key: string, code: string, language: string): HighlightLines | null {
    if (!highlighter || !readyLanguages.has(language)) return null;
    try {
      const { tokens } = highlighter.codeToTokens(code, { lang: language, theme });
      remember(key, code.length, tokens);
      return tokens;
    } catch {
      // An unknown grammar or a Shiki failure: the caller paints plain text.
      return null;
    }
  }

  return {
    cached(key) {
      return entries.get(key)?.lines ?? null;
    },

    sync(key, code, language) {
      // Never trigger work from render: the effect owns loading, this only
      // answers "can I paint colour right now?".
      if (!highlighterSettled || !highlighter) return null;
      if (!readyLanguages.has(language)) return null;
      if (code.length > maxSyncChars) return null;
      return entries.get(key)?.lines ?? tokenize(key, code, language);
    },

    load(key, code, language) {
      const hit = entries.get(key);
      if (hit) return Promise.resolve(hit.lines);
      const inFlight = pending.get(key);
      if (inFlight) return inFlight;

      const run = (async (): Promise<HighlightLines | null> => {
        try {
          const target = await ensureHighlighter();
          if (!target) return null;
          const loaded = await ensureLanguage(target, language);
          if (!loaded) return null;
          // Another request may have cached the key while this one awaited.
          const cachedNow = entries.get(key);
          if (cachedNow) return cachedNow.lines;
          return tokenize(key, code, language);
        } catch {
          return null;
        }
      })();
      const settled = run.finally(() => {
        // Only this request's entry exists: `pending` dedupes by key.
        pending.delete(key);
      });
      pending.set(key, settled);
      return settled;
    },

    reset() {
      entries.clear();
      totalChars = 0;
      readyLanguages.clear();
      languageLoads.clear();
      pending.clear();
    },
  };
}
