/**
 * Prompt-origin tracking (2026-10-26 composer/command-prompt plan).
 *
 * The desktop must know which user message came from a command so the
 * transcript can show `[command] /commit` instead of the expanded instruction.
 * The raw command exists only at dispatch time:
 *
 *  - the renderer sends `/template …` / `/skill:*` through `prompt` and attaches
 *    the raw text as `promptOrigin`;
 *  - extension commands (`commands.run`) inject their own user message through
 *    `sendUserMessage`, so the host derives `/<name> <args>` before running the
 *    handler.
 *
 * This tracker pairs each dispatch with the next user message, using three
 * rules in order:
 *
 *  1. an **exact** `sentText` match is that prompt itself — consume it without
 *     tagging (a plain prompt must never become a command row);
 *  2. the **longest** pending `sentText` the message starts with is consumed and
 *     its raw origin returned (this absorbs the SDK's appended image hints and
 *     an unexpanded command echoed verbatim);
 *  3. otherwise the earliest pending entry is consumed and its raw origin
 *     returned (`null` for a plain prompt transformed by an input hook).
 *
 * Entries expire, the queue is bounded, and the core clears it when the agent
 * settles, so a command that injects nothing cannot label a much later message.
 */

export interface PromptOriginTrackerOptions {
  /** Injected clock, so TTL tests do not sleep. */
  now?: () => number;
  /** How long a dispatch may wait for its user message. */
  ttlMs?: number;
  /** Upper bound on pending dispatches. */
  maxEntries?: number;
}

/** One dispatch awaiting its user message. */
export interface PendingPromptOrigin {
  /** The raw command (`/commit -a`, `/template x`), or null for a plain prompt. */
  readonly raw: string | null;
  /** The text the renderer sent; null for an extension-injected message. */
  readonly sentText: string | null;
  readonly at: number;
}

export interface PromptOriginTracker {
  /** Records a renderer `prompt` request (raw may be null for a plain prompt). */
  rememberPrompt(raw: string | null, sentText: string): PendingPromptOrigin;
  /** Records an extension command about to run; its message is injected later. */
  rememberCommand(raw: string): PendingPromptOrigin;
  /** Consumes the dispatch matched by the rules above; returns its raw origin. */
  consumeUserMessage(text: string): string | null;
  /** Removes one entry (used when the prompt was rejected before acceptance). */
  forget(entry: PendingPromptOrigin): void;
  /**
   * Drops entries older than `graceMs`. The core calls this before a new
   * dispatch while the session is idle, so a command that injected nothing
   * cannot label a later, unrelated message; queued follow-ups (streaming) are
   * never pruned by this rule.
   */
  dropStale(graceMs?: number): void;
  /** Drops everything (the agent settled / the session was rebound). */
  settle(): void;
  /** Alias used on rebind/dispose. */
  reset(): void;
  pendingCount(): number;
}

export const DEFAULT_PROMPT_ORIGIN_TTL_MS = 10 * 60_000;
export const DEFAULT_MAX_PENDING_ORIGINS = 32;
/** A new dispatch while idle may discard an unconsumed entry this old. */
export const DEFAULT_STALE_ORIGIN_GRACE_MS = 1_000;

export function createPromptOriginTracker(
  options: PromptOriginTrackerOptions = {},
): PromptOriginTracker {
  const now = options.now ?? Date.now;
  const ttlMs = options.ttlMs ?? DEFAULT_PROMPT_ORIGIN_TTL_MS;
  const maxEntries = Math.max(1, Math.floor(options.maxEntries ?? DEFAULT_MAX_PENDING_ORIGINS));
  let pending: PendingPromptOrigin[] = [];

  const prune = (at: number): void => {
    if (pending.length === 0) return;
    pending = pending.filter((entry) => at - entry.at <= ttlMs);
  };

  const push = (raw: string | null, sentText: string | null): PendingPromptOrigin => {
    const at = now();
    prune(at);
    const entry: PendingPromptOrigin = { raw, sentText, at };
    pending.push(entry);
    if (pending.length > maxEntries) pending.splice(0, pending.length - maxEntries);
    return entry;
  };

  return {
    rememberPrompt(raw, sentText) {
      const command = raw === null ? null : raw.trim();
      return push(command && command.length > 0 ? command : null, sentText);
    },

    rememberCommand(raw) {
      const command = raw.trim();
      return push(command.length > 0 ? command : null, null);
    },

    consumeUserMessage(text) {
      const at = now();
      prune(at);
      if (pending.length === 0) return null;

      // 1. The exact prompt the renderer sent: never a command row.
      const exact = pending.findIndex(
        (entry) => entry.sentText !== null && entry.sentText === text,
      );
      if (exact !== -1) {
        pending.splice(exact, 1);
        return null;
      }

      // 2. The longest sent text this message starts with (image hints, an
      //    unexpanded command). The raw is null for a plain prompt, so only an
      //    actual command produces a tag.
      let prefixIndex = -1;
      let prefixLength = -1;
      pending.forEach((entry, index) => {
        if (entry.sentText === null || entry.sentText.length === 0) return;
        if (!text.startsWith(entry.sentText)) return;
        if (entry.sentText.length > prefixLength) {
          prefixIndex = index;
          prefixLength = entry.sentText.length;
        }
      });
      if (prefixIndex !== -1) {
        const [entry] = pending.splice(prefixIndex, 1);
        return entry?.raw ?? null;
      }

      // 3. The earliest dispatch (a template expansion or an injected message).
      const [entry] = pending.splice(0, 1);
      return entry?.raw ?? null;
    },

    forget(entry) {
      const index = pending.indexOf(entry);
      if (index !== -1) pending.splice(index, 1);
    },

    dropStale(graceMs = DEFAULT_STALE_ORIGIN_GRACE_MS) {
      const cutoff = now() - graceMs;
      pending = pending.filter((entry) => entry.at > cutoff);
    },

    settle() {
      pending = [];
    },

    reset() {
      pending = [];
    },

    pendingCount() {
      return pending.length;
    },
  };
}
