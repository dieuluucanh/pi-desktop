/**
 * The control host's session catalog (session browser fix, 2026-11-05).
 *
 * `SessionManager.listAll()` reads and parses every session JSONL in the
 * profile. That is expensive on a large profile (hundreds of megabytes), and
 * its result includes the full `allMessagesText` of each session — far too much
 * to put on the JSONL transport. This module is the one place that:
 *
 * 1. loads the SDK listing, sanitizes it and caches it briefly (so typing in
 *    the browser's search box does not re-read the whole profile per keystroke);
 * 2. filters/sorts in the host over the **full** rows (so search still covers
 *    message text that never reaches the renderer); and
 * 3. projects a bounded page (see `projectSessionListPage`) that stays under the
 *    protocol's blob-spill threshold.
 *
 * Pure Node, no Electron and no SDK import: `loadAll` is injected, which keeps
 * the module unit-testable with a fake listing.
 */

import {
  projectSessionListPage,
  sanitizeSessionList,
  type SessionListEntry,
  type SessionListPage,
  type SessionListQuery,
  type SessionSummary,
} from "../shared/session-browser";

/** How long a loaded listing is reused before the next request re-reads it. */
export const DEFAULT_SESSION_CATALOG_TTL_MS = 10_000;

/**
 * Retaining the full text of a very large profile in the pinned control host is
 * not free. Above this many message-text characters the catalog still answers
 * the current request but does not keep the listing for the TTL.
 */
export const DEFAULT_MAX_CACHED_TEXT_CHARS = 64 * 1024 * 1024;

export interface SessionCatalogOptions {
  /** The SDK's profile-wide listing (`SessionManager.listAll`). */
  loadAll(): Promise<unknown[]>;
  /** Injectable clock, so TTL behaviour is deterministic in tests. */
  now?: () => number;
  ttlMs?: number;
  maxCachedTextChars?: number;
}

export interface SessionCatalog {
  /** The full sanitized listing (also used by delete/rename validation). */
  all(): Promise<SessionSummary[]>;
  /** A filtered, sorted, bounded page for `session.list`. */
  page(query?: SessionListQuery): Promise<SessionListPage<SessionListEntry>>;
  /** Drops the cached listing (the control host's shutdown path). */
  dispose(): void;
}

interface CacheEntry {
  at: number;
  sessions: SessionSummary[];
}

function textChars(sessions: readonly SessionSummary[]): number {
  let total = 0;
  for (const session of sessions) {
    total += session.firstMessage.length + session.allMessagesText.length;
    if (total > Number.MAX_SAFE_INTEGER) return total;
  }
  return total;
}

export function createSessionCatalog(options: SessionCatalogOptions): SessionCatalog {
  const now = options.now ?? Date.now;
  const ttlMs = options.ttlMs ?? DEFAULT_SESSION_CATALOG_TTL_MS;
  const maxCachedTextChars = options.maxCachedTextChars ?? DEFAULT_MAX_CACHED_TEXT_CHARS;

  let cache: CacheEntry | null = null;
  let inFlight: Promise<SessionSummary[]> | null = null;

  const isFresh = (): boolean => cache !== null && now() - cache.at < ttlMs;

  const load = async (force: boolean): Promise<SessionSummary[]> => {
    if (!force && isFresh()) return (cache as CacheEntry).sessions;
    // A forced refresh still waits for an in-flight read instead of racing it;
    // the fresh read below is what the caller asked for.
    if (inFlight) {
      const current = await inFlight;
      if (!force) return current;
    }

    const run = (async (): Promise<SessionSummary[]> => {
      const raw = await options.loadAll();
      // The host keeps the full text: that is what makes search cover every
      // message even though the projected page carries none of it.
      const sessions = sanitizeSessionList(raw, {
        maxTextChars: Number.MAX_SAFE_INTEGER,
      });
      cache = textChars(sessions) <= maxCachedTextChars ? { at: now(), sessions } : null;
      return sessions;
    })();

    inFlight = run;
    try {
      return await run;
    } finally {
      if (inFlight === run) inFlight = null;
    }
  };

  return {
    async all() {
      return load(false);
    },

    async page(query: SessionListQuery = {}) {
      const sessions = await load(query.refresh === true);
      return projectSessionListPage(sessions, query);
    },

    dispose() {
      cache = null;
      inFlight = null;
    },
  };
}
