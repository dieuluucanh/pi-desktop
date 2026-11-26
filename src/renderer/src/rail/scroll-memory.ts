/**
 * The rail's in-memory scroll memory (2026-11-25 rail scroll plan step 5).
 *
 * A module-level `Map` keyed by `block:folder`, bounded to the last
 * `SCROLL_MEMORY_LIMIT` entries. It exists because the rail's bodies are
 * remounted on ordinary navigation — switching menu bodies, visiting Settings,
 * changing the rail's folder — and the DOM offset does not come back with them.
 *
 * Three rules this file exists to hold:
 *
 *  - **Nothing is persisted.** The position is a session convenience, not a
 *    preference, so it never reaches `prefs` or disk.
 *  - **Reads are touches.** A key a block is actively restoring outlives keys
 *    nobody has looked at, so eviction is least-recently-*used*, not oldest.
 *  - **Deletion is explicit.** `forgetScroll` exists for a caller that really
 *    means it; unmounting is not one of those cases.
 */

/** How many block/folder offsets are kept before the LRU evicts one. */
export const SCROLL_MEMORY_LIMIT = 50;

const entries = new Map<string, number>();

/**
 * Write a key and move it to the newest slot, evicting the least-recently-used
 * entries when the map grows past the limit.
 */
function touch(key: string, top: number): void {
  // `Map` preserves insertion order, so delete + set is the LRU promotion.
  entries.delete(key);
  entries.set(key, top);
  while (entries.size > SCROLL_MEMORY_LIMIT) {
    const oldest = entries.keys().next();
    if (oldest.done) break;
    entries.delete(oldest.value);
  }
}

/** Remember `top` for `key`; non-finite values are ignored rather than stored. */
export function rememberScroll(key: string, top: number): void {
  if (!Number.isFinite(top)) return;
  touch(key, Math.max(0, top));
}

/** The saved offset for `key`, or `undefined` when nothing was saved. */
export function recallScroll(key: string): number | undefined {
  const top = entries.get(key);
  if (top === undefined) return undefined;
  // A read is use: keep the entry that is being restored alive.
  touch(key, top);
  return top;
}

/** Drop one saved offset. Unmounting never calls this by design. */
export function forgetScroll(key: string): void {
  entries.delete(key);
}

/** Clear everything between tests. */
export function resetScrollMemory(): void {
  entries.clear();
}
