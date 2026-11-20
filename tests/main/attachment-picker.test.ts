import { describe, expect, it, vi } from "vitest";
import {
  ATTACHMENT_FILE_DIALOG_FILTERS,
  pickAttachments,
  type SelectedAttachment,
} from "../../src/main/attachment-picker";
import {
  UnsupportedAttachmentError,
  type AttachmentService,
} from "../../src/main/attachment-service";
import { ATTACHMENT_LIMITS } from "../../src/shared/attachments";

const draft = {
  tabId: "t1",
  draftId: "123e4567-e89b-42d3-a456-426614174003",
  token: "123e4567-e89b-42d3-a456-426614174000",
};
const id = "123e4567-e89b-42d3-a456-426614174001";
const token = "123e4567-e89b-42d3-a456-426614174002";

function setup(content = new Uint8Array([1, 2, 3])) {
  const source: SelectedAttachment = {
    name: "report.pdf",
    mimeType: "application/octet-stream",
    size: content.length,
    read: vi.fn(async (offset: number, max: number) => content.slice(offset, offset + max)),
    verifyUnchanged: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
  };
  const service = {
    list: vi.fn(async () => []),
    begin: vi.fn(async () => ({ attachmentId: id, token })),
    append: vi.fn(
      async (_sender: number, _draft: unknown, _token: string, offset: number, chunk: Uint8Array) =>
        offset + chunk.length,
    ),
    commit: vi.fn(async () => ({
      id,
      name: source.name,
      mimeType: source.mimeType,
      size: source.size,
    })),
    cancel: vi.fn(async () => {}),
  } as unknown as AttachmentService;
  const select = vi.fn(async (): Promise<readonly string[] | null> => ["C:/private/report.pdf"]);
  const openSelected = vi.fn(async () => source);
  return { source, service, select, openSelected };
}

describe("native attachment picker", () => {
  it("offers direct text/images, future document formats, and an all-files fallback", () => {
    expect(ATTACHMENT_FILE_DIALOG_FILTERS[0]?.name).toBe("Text and raster images");
    expect(ATTACHMENT_FILE_DIALOG_FILTERS[0]?.extensions).toContain("png");
    expect(ATTACHMENT_FILE_DIALOG_FILTERS[0]?.extensions).toContain("csv");
    expect(ATTACHMENT_FILE_DIALOG_FILTERS[1]?.name).toMatch(/conversion not available yet/);
    expect(ATTACHMENT_FILE_DIALOG_FILTERS[1]?.extensions).toEqual(
      expect.arrayContaining(["pdf", "docx", "xlsx", "pptx", "odt", "ods", "odp"]),
    );
    expect(ATTACHMENT_FILE_DIALOG_FILTERS[2]?.extensions).toEqual(["*"]);
  });

  it("imports only OS-selected data in bounded chunks and never returns the source path", async () => {
    const h = setup(new Uint8Array(ATTACHMENT_LIMITS.importChunkBytes + 7));
    const result = await pickAttachments(h, 10, draft);
    expect(result).toEqual([
      {
        ok: true,
        attachment: {
          id,
          name: "report.pdf",
          mimeType: "application/octet-stream",
          size: ATTACHMENT_LIMITS.importChunkBytes + 7,
        },
      },
    ]);
    expect(h.source.read).toHaveBeenCalledTimes(2);
    expect(h.source.read).toHaveBeenNthCalledWith(1, 0, ATTACHMENT_LIMITS.importChunkBytes);
    expect(h.source.read).toHaveBeenNthCalledWith(2, ATTACHMENT_LIMITS.importChunkBytes, 7);
    expect(h.source.verifyUnchanged).toHaveBeenCalledOnce();
    expect(h.source.close).toHaveBeenCalledOnce();
    expect(JSON.stringify(result)).not.toContain("private");
  });

  it("does not open anything when the picker is cancelled or the sender is refused", async () => {
    const h = setup();
    h.select.mockResolvedValue(null);
    expect(await pickAttachments(h, 10, draft)).toBeNull();
    expect(h.openSelected).not.toHaveBeenCalled();
    vi.mocked(h.service.list).mockRejectedValue(new Error("not authorized"));
    await expect(pickAttachments(h, 10, draft)).rejects.toThrow("not authorized");
    expect(h.select).toHaveBeenCalledTimes(1);
  });

  it("cancels a changed or failed source and does not leak OS error messages", async () => {
    const h = setup();
    vi.mocked(h.source.verifyUnchanged).mockRejectedValue(
      new Error("C:/private/report.pdf changed"),
    );
    const result = await pickAttachments(h, 10, draft);
    expect(result).toEqual([{ ok: false, name: "report.pdf", reason: "import_failed" }]);
    expect(h.service.cancel).toHaveBeenCalledWith(10, draft, token);
    expect(h.source.close).toHaveBeenCalledOnce();
    expect(JSON.stringify(result)).not.toContain("private");
  });

  it("reports uncertain finalization without cancelling or reimporting", async () => {
    const h = setup();
    vi.mocked(h.service.commit).mockRejectedValue(new Error("connection lost"));
    const result = await pickAttachments(h, 10, draft);
    expect(result).toEqual([
      { ok: false, name: "report.pdf", reason: "uncertain", attachmentId: id },
    ]);
    expect(h.service.cancel).not.toHaveBeenCalled();
    expect(h.service.begin).toHaveBeenCalledOnce();
    expect(h.source.close).toHaveBeenCalledOnce();
  });

  it("returns a bounded unsupported-format reason without reading the file", async () => {
    const h = setup();
    vi.mocked(h.service.begin).mockRejectedValue(new UnsupportedAttachmentError());
    const result = await pickAttachments(h, 10, draft);
    expect(result).toEqual([{ ok: false, name: "report.pdf", reason: "unsupported_format" }]);
    expect(h.source.read).not.toHaveBeenCalled();
    expect(h.source.close).toHaveBeenCalledOnce();
  });

  it("reports unsafe source names and files past the per-draft limit without opening them", async () => {
    const h = setup();
    h.select.mockResolvedValue(Array.from({ length: 11 }, (_, i) => `secret/${i}`));
    vi.mocked(h.openSelected).mockRejectedValue(new Error("private path"));
    const result = await pickAttachments(h, 10, draft);
    expect(result).toHaveLength(11);
    expect(h.openSelected).toHaveBeenCalledTimes(10);
    expect(result?.at(-1)).toEqual({ ok: false, name: "Selected file", reason: "too_many_files" });
    expect(JSON.stringify(result)).not.toContain("secret");
  });
});
