import { describe, expect, it, vi } from "vitest";
import {
  ingestBrowserAttachment,
  type BrowserAttachmentFile,
} from "../../src/renderer/src/attachments/ingest";
import { ATTACHMENT_LIMITS } from "../../src/shared/attachments";
import type { AttachmentsBridge } from "../../src/shared/ipc";

const draft = {
  tabId: "tab-1",
  draftId: "123e4567-e89b-42d3-a456-426614174003",
  token: "123e4567-e89b-42d3-a456-426614174000",
};
const grant = {
  attachmentId: "123e4567-e89b-42d3-a456-426614174001",
  token: "123e4567-e89b-42d3-a456-426614174002",
};

function fixture(size = 3) {
  const data = new Uint8Array(size).fill(97);
  const slices = new Map<Blob, Uint8Array>();
  const file: BrowserAttachmentFile = {
    name: "a.txt",
    type: "text/plain",
    size,
    slice: vi.fn((start, end) => {
      const blob = new Blob();
      slices.set(blob, data.slice(start, end));
      return blob;
    }),
  };
  const readSlice = vi.fn(async (blob: Blob) => {
    const contents = slices.get(blob);
    if (!contents) throw new Error("unknown slice");
    return contents.buffer as ArrayBuffer;
  });
  const bridge = {
    begin: vi.fn(async () => grant),
    append: vi.fn(
      async (_draft: unknown, _token: string, offset: number, chunk: Uint8Array) =>
        offset + chunk.length,
    ),
    commit: vi.fn(async () => ({
      id: grant.attachmentId,
      name: "a.txt",
      mimeType: "text/plain",
      size,
    })),
    cancel: vi.fn(async () => {}),
  } as unknown as AttachmentsBridge;
  return { file, bridge, readSlice };
}

describe("browser attachment ingestion", () => {
  it("reads bounded slices sequentially and reports progress without paths or data URLs", async () => {
    const h = fixture(ATTACHMENT_LIMITS.importChunkBytes + 7);
    const progress: number[] = [];
    const result = await ingestBrowserAttachment(h.bridge, draft, h.file, {
      readSlice: h.readSlice,
      onProgress: (value) => progress.push(value),
    });
    expect(result.id).toBe(grant.attachmentId);
    expect(h.file.slice).toHaveBeenNthCalledWith(1, 0, ATTACHMENT_LIMITS.importChunkBytes);
    expect(h.file.slice).toHaveBeenNthCalledWith(
      2,
      ATTACHMENT_LIMITS.importChunkBytes,
      ATTACHMENT_LIMITS.importChunkBytes + 7,
    );
    expect(h.bridge.append).toHaveBeenCalledTimes(2);
    expect(progress).toEqual([
      ATTACHMENT_LIMITS.importChunkBytes,
      ATTACHMENT_LIMITS.importChunkBytes + 7,
    ]);
    expect(h.bridge.commit).toHaveBeenCalledOnce();
    expect(h.bridge.cancel).not.toHaveBeenCalled();
  });

  it("cancels a grant when reading fails or returns a short chunk", async () => {
    const h = fixture();
    h.readSlice.mockResolvedValue(new ArrayBuffer(1));
    await expect(
      ingestBrowserAttachment(h.bridge, draft, h.file, { readSlice: h.readSlice }),
    ).rejects.toMatchObject({ reason: "failed" });
    expect(h.bridge.cancel).toHaveBeenCalledWith(draft, grant.token);
    expect(h.bridge.commit).not.toHaveBeenCalled();
  });

  it("reports a known unsupported file before reading or uploading bytes", async () => {
    const h = fixture();
    vi.mocked(h.bridge.begin).mockRejectedValue(new Error("attachments: unsupported_format"));
    await expect(
      ingestBrowserAttachment(h.bridge, draft, h.file, { readSlice: h.readSlice }),
    ).rejects.toMatchObject({ reason: "unsupported" });
    expect(h.file.slice).not.toHaveBeenCalled();
    expect(h.bridge.append).not.toHaveBeenCalled();
  });

  it("does not start an already-aborted import", async () => {
    const h = fixture();
    const controller = new AbortController();
    controller.abort();
    await expect(
      ingestBrowserAttachment(h.bridge, draft, h.file, { signal: controller.signal }),
    ).rejects.toMatchObject({ reason: "cancelled" });
    expect(h.bridge.begin).not.toHaveBeenCalled();
  });

  it("requests cancellation if the signal aborts during an in-flight chunk", async () => {
    const h = fixture();
    let started = (): void => {};
    const startedPromise = new Promise<void>((resolve) => {
      started = resolve;
    });
    vi.mocked(h.bridge.append).mockImplementation(async () => {
      started();
      return new Promise<number>(() => {});
    });
    const controller = new AbortController();
    const pending = ingestBrowserAttachment(h.bridge, draft, h.file, {
      signal: controller.signal,
      readSlice: h.readSlice,
    });
    await startedPromise;
    controller.abort();
    await expect(pending).rejects.toMatchObject({ reason: "cancelled" });
    expect(h.bridge.cancel).toHaveBeenCalledWith(draft, grant.token);
    expect(h.bridge.commit).not.toHaveBeenCalled();
  });

  it("cleans up a stage whose begin acknowledgement arrives after cancellation", async () => {
    const h = fixture();
    let finish = (_value: typeof grant): void => {};
    vi.mocked(h.bridge.begin).mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const controller = new AbortController();
    const pending = ingestBrowserAttachment(h.bridge, draft, h.file, { signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ reason: "cancelled" });
    finish(grant);
    await Promise.resolve();
    expect(h.bridge.cancel).toHaveBeenCalledWith(draft, grant.token);
  });

  it("reports an uncertain result rather than retrying or deleting after commit failure", async () => {
    const h = fixture();
    vi.mocked(h.bridge.commit).mockRejectedValue(new Error("connection lost"));
    await expect(
      ingestBrowserAttachment(h.bridge, draft, h.file, { readSlice: h.readSlice }),
    ).rejects.toMatchObject({ reason: "uncertain", attachmentId: grant.attachmentId });
    expect(h.bridge.commit).toHaveBeenCalledOnce();
    expect(h.bridge.cancel).not.toHaveBeenCalled();
  });

  it("enforces one overall deadline and schedules cleanup", async () => {
    vi.useFakeTimers();
    try {
      const h = fixture();
      vi.mocked(h.bridge.append).mockImplementation(async () => new Promise<number>(() => {}));
      const pending = ingestBrowserAttachment(h.bridge, draft, h.file, {
        readSlice: h.readSlice,
        timeoutMs: 20,
      });
      const assertion = expect(pending).rejects.toMatchObject({ reason: "timeout" });
      await vi.advanceTimersByTimeAsync(20);
      await assertion;
      expect(h.bridge.cancel).toHaveBeenCalledWith(draft, grant.token);
    } finally {
      vi.useRealTimers();
    }
  });
});
