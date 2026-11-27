/**
 * Host response decoding for the renderer (session browser fix, 2026-11-05).
 *
 * The host replaces any response at or above 1 MiB with
 * `{ $blob, bytes }`. Until now only tool results understood that shape:
 * `session.list`, `messages.get` and `tree.get` read their missing field and
 * silently fell back to empty. This module resolves the reference once, for
 * every `sessions.request` call, using the chunked `host.blobs.read`.
 *
 * It is deliberately not a React/store module: the wrapper is installed by
 * `bridge()` and can be unit tested with a tiny fake API.
 */

import {
  isBlobReadResult,
  isBlobRef,
  type BlobReadResult,
  type BlobRef,
} from "../../../shared/host-protocol";
import type { PiDesktopBridge } from "../../../shared/ipc";
import type { SessionRequestInput } from "../../../shared/session-ipc";

/** Largest spilled response the renderer will reassemble, in characters. */
export const MAX_RESOLVED_BLOB_CHARS = 32 * 1024 * 1024;

/** Hard stop for a blob reader that keeps returning chunks. */
export const MAX_BLOB_CHUNKS = 256;

export interface ReadBlobOptions {
  maxChars?: number;
  maxChunks?: number;
}

function unreadable(): Error {
  return new Error("The host returned an unreadable spilled result.");
}

/**
 * Reads a spilled blob back in chunks and returns the complete text.
 *
 * The host guarantees code-point-aligned chunks, so concatenation is exact.
 * A legacy host that answers with the whole blob and no `done` field is
 * accepted as a one-chunk read.
 */
export async function readBlobText(
  api: PiDesktopBridge,
  tabId: string,
  ref: BlobRef,
  options: ReadBlobOptions = {},
): Promise<string> {
  const maxChars = options.maxChars ?? MAX_RESOLVED_BLOB_CHARS;
  const maxChunks = options.maxChunks ?? MAX_BLOB_CHUNKS;
  const path = ref.$blob;
  let offset = 0;
  let text = "";

  for (let chunk = 0; chunk < maxChunks; chunk++) {
    const result = (await api.sessions.request({
      tabId,
      method: "host.blobs.read",
      // Omitting the first offset keeps the request identical to the pre-chunk
      // shape (and to what older hosts and tests expect).
      params: offset === 0 ? { path } : { path, offset },
    })) as unknown;
    if (!isBlobReadResult(result)) throw unreadable();
    if (result.path !== path) throw unreadable();
    if (text.length + result.contents.length > maxChars) {
      throw new Error("The spilled result is too large to read back.");
    }
    text += result.contents;

    // `done` is absent on an older host's full read; `false` is the only value
    // that asks for another chunk.
    if (result.done !== false) return text;

    const nextOffset = (result as Partial<BlobReadResult>).nextOffset;
    if (typeof nextOffset !== "number" || !Number.isFinite(nextOffset) || nextOffset <= offset) {
      throw unreadable();
    }
    offset = nextOffset;
  }

  throw new Error("The spilled result did not finish within the chunk limit.");
}

/** Resolves one `BlobRef` into the value the host spilled. */
export async function resolveBlobResult(
  api: PiDesktopBridge,
  tabId: string,
  result: unknown,
  options: ReadBlobOptions = {},
): Promise<unknown> {
  if (!isBlobRef(result)) return result;
  const text = await readBlobText(api, tabId, result, options);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw unreadable();
  }
}

const wrapped = new WeakMap<object, PiDesktopBridge>();

/**
 * Wraps the preload bridge so every host response resolves its `BlobRef`.
 *
 * `host.blobs.read` is passed through untouched (it is the reader), and the
 * raw bridge's `sessions.request` is read dynamically on each call so tests
 * that replace it still work.
 */
export function wrapBridgeWithBlobResolution(api: PiDesktopBridge): PiDesktopBridge {
  const existing = wrapped.get(api);
  if (existing) return existing;

  const wrappedBridge: PiDesktopBridge = {
    ...api,
    sessions: {
      ...api.sessions,
      request: async (input: SessionRequestInput): Promise<unknown> => {
        const result = await api.sessions.request(input);
        if (input.method === "host.blobs.read") return result;
        return resolveBlobResult(api, input.tabId, result);
      },
    },
  };
  wrapped.set(api, wrappedBridge);
  return wrappedBridge;
}
