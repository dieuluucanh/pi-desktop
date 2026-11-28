import {
  ATTACHMENT_LIMITS,
  type AttachmentDraftGrant,
  type AttachmentImportGrant,
  type AttachmentSnapshot,
} from "../../../shared/attachments";
import type { AttachmentsBridge } from "../../../shared/ipc";

/** A browser-selected/pasted file; no filesystem path is read or exposed. */
export interface BrowserAttachmentFile {
  readonly name: string;
  readonly type: string;
  readonly size: number;
  slice(start: number, end: number): Blob;
}

export class AttachmentIngestError extends Error {
  readonly reason: "cancelled" | "timeout" | "failed" | "unsupported" | "uncertain";
  readonly attachmentId: string | null;

  constructor(reason: AttachmentIngestError["reason"], attachmentId: string | null = null) {
    super(`attachment import ${reason}`);
    this.name = "AttachmentIngestError";
    this.reason = reason;
    this.attachmentId = attachmentId;
  }
}

export interface AttachmentIngestOptions {
  signal?: AbortSignal;
  /** One overall deadline, not a fresh timeout for every chunk. */
  timeoutMs?: number;
  onProgress?: (bytes: number, total: number) => void;
  /** Injectable so tests need not depend on jsdom's Blob implementation. */
  readSlice?: (blob: Blob) => Promise<ArrayBuffer>;
}

/**
 * Chunk a browser File into the authorized main-process store with backpressure.
 * If finalization loses its acknowledgement, report uncertainty and the ID;
 * never start a duplicate import or claim that it did not commit.
 */
export async function ingestBrowserAttachment(
  bridge: AttachmentsBridge,
  draft: AttachmentDraftGrant,
  file: BrowserAttachmentFile,
  options: AttachmentIngestOptions = {},
): Promise<AttachmentSnapshot> {
  const timeoutMs = options.timeoutMs ?? 10 * 60_000;
  if (
    !Number.isSafeInteger(file.size) ||
    file.size < 0 ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs <= 0 ||
    timeoutMs > 10 * 60_000
  ) {
    throw new AttachmentIngestError("failed");
  }
  const deadline = Date.now() + timeoutMs;
  const signal = options.signal;
  if (signal?.aborted) throw new AttachmentIngestError("cancelled");
  const readSlice = options.readSlice ?? ((blob: Blob) => blob.arrayBuffer());
  let grant: AttachmentImportGrant | null = null;
  let committing = false;

  const wait = <T>(promise: Promise<T>): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const remaining = deadline - Date.now();
      if (signal?.aborted) {
        void promise.catch(() => undefined);
        reject(new AttachmentIngestError("cancelled"));
        return;
      }
      if (remaining <= 0) {
        void promise.catch(() => undefined);
        reject(new AttachmentIngestError("timeout"));
        return;
      }
      let settled = false;
      const finish = (callback: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        callback();
      };
      const onAbort = (): void => finish(() => reject(new AttachmentIngestError("cancelled")));
      const timer = setTimeout(
        () => finish(() => reject(new AttachmentIngestError("timeout"))),
        remaining,
      );
      signal?.addEventListener("abort", onAbort, { once: true });
      promise.then(
        (value) => finish(() => resolve(value)),
        (reason: unknown) => finish(() => reject(reason)),
      );
    });
  const cancel = (token: string): void => {
    try {
      void bridge.cancel(draft, token).catch(() => undefined);
    } catch {
      // Cleanup is best-effort; the storage reservation remains recoverable.
    }
  };

  try {
    const beginning = bridge.begin({
      draft,
      name: file.name,
      mimeType: file.type || "application/octet-stream",
      size: file.size,
    });
    try {
      grant = await wait(beginning);
    } catch (cause) {
      // The main process may create a stage after a timed-out begin call.
      void beginning.then(
        (late) => cancel(late.token),
        () => undefined,
      );
      throw cause;
    }
    let offset = 0;
    while (offset < file.size) {
      const end = Math.min(file.size, offset + ATTACHMENT_LIMITS.importChunkBytes);
      const chunk = new Uint8Array(await wait(readSlice(file.slice(offset, end))));
      if (chunk.byteLength !== end - offset) throw new AttachmentIngestError("failed");
      const next = await wait(bridge.append(draft, grant.token, offset, chunk));
      if (next !== end) throw new AttachmentIngestError("failed");
      offset = next;
      options.onProgress?.(offset, file.size);
    }
    if (signal?.aborted) throw new AttachmentIngestError("cancelled");
    if (Date.now() >= deadline) throw new AttachmentIngestError("timeout");
    committing = true;
    return await wait(bridge.commit(draft, grant.token));
  } catch (cause) {
    if (committing) throw new AttachmentIngestError("uncertain", grant?.attachmentId ?? null);
    if (grant) cancel(grant.token);
    if (cause instanceof AttachmentIngestError) throw cause;
    if (cause instanceof Error && cause.message.includes("attachments: unsupported_format")) {
      throw new AttachmentIngestError("unsupported");
    }
    throw new AttachmentIngestError("failed", grant?.attachmentId ?? null);
  }
}
