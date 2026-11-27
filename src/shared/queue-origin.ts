/**
 * Queued-message ownership (2026-11-26 queue-bar plan).
 *
 * A pending message has no owner on the wire. The SDK's queue stores **text
 * only** (`getSteeringMessages()` / `getFollowUpMessages()` return `string[]`),
 * so a turn the user queued and a turn an extension injected for itself are
 * indistinguishable in a `queue_update` frame. The host therefore annotates the
 * frame with a parallel `queueOrigins` array, one entry per queued text:
 *
 * ```ts
 * { steering: string[], followUp: string[], queueOrigins?: QueueOrigins }
 * ```
 *
 * The annotation is **fail-open**: a legacy host sends none, and an entry is
 * `"extension"` only when it is the exact literal `"extension"`. Everything
 * else — a missing array, a short or long array, a number, `null`, a
 * differently-cased string — reads as `"user"`. The renderer then keeps
 * today's behaviour (every queued row is the user's) for any payload it does
 * not understand, so a mis-annotated or absent annotation can never hide a
 * user's own message or strip its restore/clear affordances.
 */

/** Who queued one pending message. */
export type QueueEntryOrigin = "user" | "extension";

/** Per-queue origins, parallel to the SDK's `steering`/`followUp` text arrays. */
export interface QueueOrigins {
  steering: QueueEntryOrigin[];
  followUp: QueueEntryOrigin[];
}

/** Every origin, in display order (user first: it is the common case). */
export const QUEUE_ENTRY_ORIGINS: readonly QueueEntryOrigin[] = ["user", "extension"];

function clampCount(count: number): number {
  if (!Number.isFinite(count) || count < 0) return 0;
  return Math.max(0, Math.trunc(count));
}

/**
 * Reads one queue's origins, positionally, for `count` queued texts.
 *
 * Entry `i` is `"extension"` only when `value[i]` is the strict literal
 * `"extension"`; every other position is `"user"`. The input is `unknown`
 * because it comes off the IPC wire: it never throws and non-array input
 * (`undefined`, `null`, a string, an object) yields an all-`"user"` list. The
 * result length always equals the clamped `count` (fractional counts truncate;
 * `NaN`, infinities and negatives read as `0`), so the caller can zip it with
 * the texts the SDK sent without a length check.
 */
export function readQueueOriginList(value: unknown, count: number): QueueEntryOrigin[] {
  const size = clampCount(count);
  const source = Array.isArray(value) ? (value as readonly unknown[]) : null;
  const origins: QueueEntryOrigin[] = [];
  for (let index = 0; index < size; index += 1) {
    origins.push(source?.[index] === "extension" ? "extension" : "user");
  }
  return origins;
}
