/**
 * A small retrying `fetch` for release-time downloads.
 *
 * The release pipeline learned this the hard way: a single GitHub 504 aborted
 * every platform because the downloader had no retry, and a bare `fetch` in
 * `scripts/fetch-runtime.mjs` had the same exposure against nodejs.org. This
 * helper retries only idempotent requests, only on transient statuses/network
 * errors, and never hides a permanent 4xx or a caller abort.
 *
 * Kept dependency-free and separate from the Electron app so the release
 * scripts and their tests can import it directly.
 */

/** Statuses that are worth retrying for a GET/HEAD. */
export const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

/** Thrown after the last retry; carries enough context for a useful log line. */
export class FetchRetryError extends Error {
  constructor(message, details = {}) {
    super(message, details.cause === undefined ? undefined : { cause: details.cause });
    this.name = "FetchRetryError";
    this.url = details.url;
    this.status = details.status ?? null;
    this.attempts = details.attempts ?? 1;
  }
}

/**
 * Exponential backoff with bounded jitter.
 * @param {number} attempt 1-based attempt number
 * @param {number} baseDelayMs
 * @param {number} maxDelayMs
 * @param {number} jitterMs
 * @returns {number}
 */
function backoffMs(attempt, baseDelayMs, maxDelayMs, jitterMs) {
  const base = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
  const jitter = jitterMs > 0 ? Math.floor(Math.random() * jitterMs) : 0;
  return Math.min(maxDelayMs, base + jitter);
}

/**
 * Parse `Retry-After` (seconds or HTTP date).
 * @param {Response} response
 * @returns {number | null}
 */
function retryAfterMs(response) {
  const value = response.headers.get("retry-after");
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.floor(seconds * 1000);
  const date = Date.parse(value);
  if (!Number.isNaN(date)) return Math.max(0, date - Date.now());
  return null;
}

/** @param {number} ms */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** @param {AbortSignal} signal */
function abortReason(signal) {
  if (signal.reason instanceof Error) return signal.reason;
  return new DOMException("The operation was aborted.", "AbortError");
}

/**
 * Retry an idempotent request until it succeeds, a non-retryable response is
 * returned, or the attempt budget is exhausted.
 *
 * @param {string | URL} url
 * @param {RequestInit & {
 *   attempts?: number,
 *   baseDelayMs?: number,
 *   maxDelayMs?: number,
 *   jitterMs?: number,
 *   timeoutMs?: number,
 *   fetchImpl?: typeof fetch,
 *   onRetry?: (info: {
 *     attempt: number,
 *     attempts: number,
 *     url: string | URL,
 *     status?: number,
 *     error?: unknown,
 *     delayMs: number,
 *   }) => void,
 *   signal?: AbortSignal,
 * }} [options]
 * @returns {Promise<Response>}
 */
export async function fetchWithRetry(url, options = {}) {
  const {
    attempts = 4,
    baseDelayMs = 2000,
    maxDelayMs = 30000,
    jitterMs = 250,
    timeoutMs = 120000,
    fetchImpl = globalThis.fetch,
    onRetry,
    signal,
    ...init
  } = options;

  if (typeof fetchImpl !== "function") {
    throw new TypeError("fetchWithRetry requires a fetch implementation");
  }
  if (!Number.isInteger(attempts) || attempts < 1) {
    throw new RangeError("fetchWithRetry: attempts must be a positive integer");
  }
  for (const [name, value] of [
    ["baseDelayMs", baseDelayMs],
    ["maxDelayMs", maxDelayMs],
    ["jitterMs", jitterMs],
    ["timeoutMs", timeoutMs],
  ]) {
    if (!Number.isFinite(value) || value < 0) {
      throw new RangeError(`fetchWithRetry: ${name} must be a non-negative number`);
    }
  }

  const method = String(init.method ?? "GET").toUpperCase();
  const retryableMethod = method === "GET" || method === "HEAD";
  const label = String(url);
  let lastError = null;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const controller = new AbortController();
    // Bounds the request/headers, not the body: the caller streams a large
    // archive, and the job timeout is the backstop for a genuinely stalled body.
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const onAbort = () => controller.abort(signal?.reason);
    if (signal) {
      if (signal.aborted) {
        clearTimeout(timer);
        throw abortReason(signal);
      }
      signal.addEventListener("abort", onAbort, { once: true });
    }

    let attemptError;
    let retryAfter = null;
    try {
      const response = await fetchImpl(url, { ...init, method, signal: controller.signal });
      if (!retryableMethod || !RETRYABLE_STATUS.has(response.status)) {
        return response;
      }
      retryAfter = retryAfterMs(response);
      await response.body?.cancel().catch(() => undefined);
      attemptError = new FetchRetryError(`HTTP ${response.status} for ${label}`, {
        url: label,
        status: response.status,
        attempts: attempt,
      });
    } catch (error) {
      attemptError = error;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }

    if (signal?.aborted) throw abortReason(signal);

    if (controller.signal.aborted && !(attemptError instanceof FetchRetryError)) {
      attemptError = new FetchRetryError(`request timed out after ${timeoutMs} ms for ${label}`, {
        url: label,
        attempts: attempt,
        cause: attemptError,
      });
    }
    lastError = attemptError;

    if (!retryableMethod || attempt >= attempts) break;

    const delayMs =
      retryAfter === null
        ? backoffMs(attempt, baseDelayMs, maxDelayMs, jitterMs)
        : Math.min(maxDelayMs, retryAfter);
    try {
      onRetry?.({
        attempt,
        attempts,
        url,
        ...(attemptError instanceof FetchRetryError && attemptError.status !== null
          ? { status: attemptError.status }
          : { error: attemptError }),
        delayMs,
      });
    } catch {
      // A logger must never break the download.
    }
    await sleep(delayMs);
  }

  if (lastError instanceof FetchRetryError) {
    lastError.attempts = attempts;
    throw lastError;
  }
  const detail =
    lastError instanceof Error ? lastError.message : String(lastError ?? "unknown error");
  throw new FetchRetryError(`request failed for ${label}: ${detail}`, {
    url: label,
    attempts,
    cause: lastError,
  });
}
