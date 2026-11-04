/**
 * Bounded renderer caches for unlimited tabs.
 *
 * A tab is a resumable record, but the renderer also keeps display caches for it.
 * These numbers are the only bound on those caches; they live in a tiny module
 * so the store, the tests that pin the bound, and the diagnostics wording read
 * the same values.
 */

/**
 * Transcripts are display caches, not the session (the host JSONL is the source
 * of truth). Keep only the visible panes (or the solo tab) plus a few recent
 * ones hydrated; an evicted tab re-fetches `messages.get` when activated.
 */
export const MAX_RETAINED_TRANSCRIPTS = 4;

/**
 * How many transcripts to keep for a given number of visible surfaces.
 *
 * The grid (2026-11-03 plan) can show four tabs at once, and evicting one of
 * them would re-fetch its transcript on the next tab-table publish — a visible
 * pane must never be the eviction victim, so the bound widens with the layout.
 */
export function maxRetainedTranscripts(visibleCount: number): number {
  const visible = Number.isFinite(visibleCount) ? Math.max(0, Math.floor(visibleCount)) : 0;
  return Math.max(MAX_RETAINED_TRANSCRIPTS, visible + 1);
}

/** Lazy tool-result cache: entry and byte guards, oldest insertion first. */
export const MAX_RETAINED_BLOBS = 24;
export const MAX_BLOB_BYTES = 32 * 1024 * 1024;
