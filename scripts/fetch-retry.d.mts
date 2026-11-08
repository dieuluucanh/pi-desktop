/**
 * Types for `scripts/fetch-retry.mjs`.
 *
 * `tsconfig.node.json` typechecks `tests/**` but not `scripts/**`, so the
 * runtime-download test needs this declaration (same convention as
 * `release-assets.d.mts`).
 */

export type FetchRetryInfo = {
  attempt: number;
  attempts: number;
  url: string | URL;
  status?: number;
  error?: unknown;
  delayMs: number;
};

export interface FetchRetryOptions extends RequestInit {
  /** Total attempts, including the first one. */
  attempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  jitterMs?: number;
  /** Abort a single attempt after this many milliseconds. */
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  onRetry?: (info: FetchRetryInfo) => void;
}

export const RETRYABLE_STATUS: ReadonlySet<number>;

export class FetchRetryError extends Error {
  url?: string;
  status: number | null;
  attempts: number;
  constructor(
    message: string,
    details?: { url?: string; status?: number | null; attempts?: number; cause?: unknown },
  );
}

export function fetchWithRetry(url: string | URL, options?: FetchRetryOptions): Promise<Response>;
