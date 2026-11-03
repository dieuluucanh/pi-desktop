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
 * of truth). Keep only the active tab plus a few recent ones hydrated; an
 * evicted tab re-fetches `messages.get` when activated.
 */
export const MAX_RETAINED_TRANSCRIPTS = 4;

/** Lazy tool-result cache: entry and byte guards, oldest insertion first. */
export const MAX_RETAINED_BLOBS = 24;
export const MAX_BLOB_BYTES = 32 * 1024 * 1024;
