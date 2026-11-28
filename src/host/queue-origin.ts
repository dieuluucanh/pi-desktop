/**
 * Queue-origin claims (2026-11-26 queue-bar plan).
 *
 * The SDK's pending queues store **text only** — `getSteeringMessages()` and
 * `getFollowUpMessages()` return `string[]`, so a queued turn has no owner.
 * The host therefore records a *claim* around each renderer-initiated queue
 * operation: every text that newly appears in the target queue between the
 * `before` snapshot and the SDK call was admitted on behalf of the renderer's
 * request, so it is the user's. A text with no claim is an extension's.
 *
 * The tracker is a pure, port-free value: it holds no timers, touches no fs
 * and only type-imports the shared wire contract (`QueueOrigins`).
 *
 * Semantics, pinned:
 *
 *  - State is one `Map<text, { count, at }>` per kind. `claim` ignores empty
 *    strings, increments the count for each text and stamps `at` with the
 *    injected clock.
 *  - `classify` **never consumes** a claim. Every observed entry starts as
 *    `"extension"`; for a claimed text with count `n` the **last**
 *    `min(n, observedCount)` occurrences become `"user"` (the SDK appends, so
 *    the user's insert is the newest copy). Repeated frames and `agent_settled`
 *    therefore keep the attribution — there is deliberately no `settle()`.
 *  - `classify` refreshes `at` for every claim it observes: an observation
 *    proves the text is still queued, so a long wait never expires a live
 *    claim. Claims absent from that kind's observed list are pruned, and a
 *    claim whose observed multiplicity falls below its count is clamped down.
 *  - Entries expire `ttlMs` after their last `claim`/observation and the map
 *    holds at most `maxTexts` texts per kind, dropping the oldest `at` first
 *    (insertion order on a tie). The TTL and the cap only bound a claim whose
 *    observation never comes.
 *  - `classify` tolerates non-array input (treated as an empty queue) and never
 *    throws.
 */

import type { QueueEntryOrigin, QueueOrigins } from "../shared/queue-origin";

/** The two SDK queues the tracker distinguishes. */
export type QueueKind = "steering" | "followUp";

export interface QueueOriginTrackerOptions {
  /** Injected clock, so TTL tests do not sleep. */
  now?: () => number;
  /** How long a claim survives without being observed in its queue. */
  ttlMs?: number;
  /** Upper bound on claimed texts per kind. */
  maxTexts?: number;
}

export interface QueueOriginTracker {
  /**
   * Records that `texts` newly appeared in `kind`'s queue because of a
   * renderer request. Empty strings are ignored; each text's count grows.
   */
  claim(kind: QueueKind, texts: readonly string[]): void;
  /**
   * Annotates both observed queues. Never consumes a claim: a claimed text
   * stays `"user"` on every frame that still shows it, and is pruned once its
   * queue no longer contains it. Non-array input reads as an empty queue.
   */
  classify(steering: readonly string[], followUp: readonly string[]): QueueOrigins;
  /** Drops every claim in both kinds (rebind / dispose / after a clear). */
  reset(): void;
  /** Total claimed count across both kinds. */
  pendingCount(): number;
}

export const DEFAULT_QUEUE_ORIGIN_TTL_MS = 10 * 60_000;
export const DEFAULT_MAX_QUEUED_ORIGINS = 8;

/** One claimed text: how many copies the user owns, and when it was last seen. */
interface QueueClaim {
  count: number;
  at: number;
}

/** Runtime-guards an off-wire queue list; anything else reads as empty. */
function asTextList(value: unknown): readonly string[] {
  return Array.isArray(value) ? (value as readonly string[]) : [];
}

export function createQueueOriginTracker(
  options: QueueOriginTrackerOptions = {},
): QueueOriginTracker {
  const now = options.now ?? Date.now;
  const ttlMs = options.ttlMs ?? DEFAULT_QUEUE_ORIGIN_TTL_MS;
  const maxTexts = Math.max(1, Math.floor(options.maxTexts ?? DEFAULT_MAX_QUEUED_ORIGINS));

  const claims: Record<QueueKind, Map<string, QueueClaim>> = {
    steering: new Map<string, QueueClaim>(),
    followUp: new Map<string, QueueClaim>(),
  };

  const maps = (): Map<string, QueueClaim>[] => [claims.steering, claims.followUp];

  const pruneExpired = (at: number): void => {
    for (const map of maps()) {
      for (const [text, claim] of map) {
        if (at - claim.at > ttlMs) map.delete(text);
      }
    }
  };

  const enforceCap = (map: Map<string, QueueClaim>): void => {
    while (map.size > maxTexts) {
      let oldestText: string | null = null;
      let oldestAt = Number.POSITIVE_INFINITY;
      for (const [text, claim] of map) {
        // Strict `<` keeps the earlier insertion on an `at` tie.
        if (claim.at < oldestAt) {
          oldestAt = claim.at;
          oldestText = text;
        }
      }
      if (oldestText === null) return;
      map.delete(oldestText);
    }
  };

  const classifyKind = (
    map: Map<string, QueueClaim>,
    observed: readonly string[],
    at: number,
  ): QueueEntryOrigin[] => {
    const origins: QueueEntryOrigin[] = observed.map(() => "extension");
    const positions = new Map<string, number[]>();
    observed.forEach((text, index) => {
      if (typeof text !== "string") return;
      const indexes = positions.get(text);
      if (indexes === undefined) positions.set(text, [index]);
      else indexes.push(index);
    });

    for (const [text, claim] of map) {
      const matches = positions.get(text);
      if (matches === undefined || matches.length === 0) {
        // Absent from this kind's queue: the turn was delivered or discarded.
        map.delete(text);
        continue;
      }
      const mark = Math.min(claim.count, matches.length);
      for (let offset = matches.length - mark; offset < matches.length; offset += 1) {
        const index = matches[offset];
        if (index !== undefined) origins[index] = "user";
      }
      // A live observation refreshes the clock and clamps to what is queued.
      claim.count = mark;
      claim.at = at;
    }

    return origins;
  };

  return {
    claim(kind, texts) {
      const map = claims[kind];
      if (map === undefined) return;
      const at = now();
      pruneExpired(at);
      for (const text of asTextList(texts)) {
        if (typeof text !== "string" || text.length === 0) continue;
        const existing = map.get(text);
        if (existing === undefined) map.set(text, { count: 1, at });
        else {
          existing.count += 1;
          existing.at = at;
        }
      }
      enforceCap(map);
    },

    classify(steering, followUp) {
      const at = now();
      pruneExpired(at);
      return {
        steering: classifyKind(claims.steering, asTextList(steering), at),
        followUp: classifyKind(claims.followUp, asTextList(followUp), at),
      };
    },

    reset() {
      for (const map of maps()) map.clear();
    },

    pendingCount() {
      let total = 0;
      for (const map of maps()) {
        for (const claim of map.values()) total += claim.count;
      }
      return total;
    },
  };
}
