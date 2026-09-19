import { describe, expect, it } from "vitest";
import {
  dataUrlPayload,
  downscaleDataUrl,
  fileToAttachment,
  imageMimeFromName,
  isImageFile,
  MAX_ATTACHMENT_BYTES,
} from "../../src/renderer/src/session/image-attachment";

/**
 * Image attachments (plan step 6). The jsdom runtime cannot decode images, which
 * is exactly the case the fallback must handle: an attachment is never lost just
 * because resizing was unavailable.
 */

describe("mime detection", () => {
  it("maps the extensions vision APIs accept", () => {
    expect(imageMimeFromName("shot.png")).toBe("image/png");
    expect(imageMimeFromName("photo.JPEG")).toBe("image/jpeg");
    expect(imageMimeFromName("diagram.webp")).toBe("image/webp");
    expect(imageMimeFromName("notes.md")).toBeNull();
    expect(imageMimeFromName("noextension")).toBeNull();
  });

  it("accepts a file by type or by name", () => {
    expect(isImageFile({ name: "a.bin", type: "image/gif" })).toBe(true);
    expect(isImageFile({ name: "a.png", type: "" })).toBe(true);
    expect(isImageFile({ name: "a.txt", type: "text/plain" })).toBe(false);
  });

  it("strips the data-URL prefix", () => {
    expect(dataUrlPayload("data:image/png;base64,AAAA")).toBe("AAAA");
    expect(dataUrlPayload("no-comma")).toBe("");
  });
});

describe("resizing fallback", () => {
  it("returns the original data when the runtime cannot decode images", async () => {
    const result = await downscaleDataUrl("data:image/png;base64,AAAA", "image/png");
    expect(result).toEqual({ dataUrl: "data:image/png;base64,AAAA", mimeType: "image/png" });
  });
});

describe("fileToAttachment", () => {
  it("converts an image file into base64 data", async () => {
    const file = new File([new Uint8Array([1, 2, 3, 4])], "shot.png", { type: "image/png" });
    const attachment = await fileToAttachment(file);
    expect(attachment).not.toBeNull();
    expect(attachment?.mimeType).toBe("image/png");
    expect(attachment?.name).toBe("shot.png");
    expect((attachment?.data.length ?? 0) > 0).toBe(true);
  });

  it("refuses a non-image file", async () => {
    const file = new File(["hello"], "notes.txt", { type: "text/plain" });
    expect(await fileToAttachment(file)).toBeNull();
  });

  it("refuses an oversized image before reading it", async () => {
    const huge = {
      name: "huge.png",
      type: "image/png",
      size: MAX_ATTACHMENT_BYTES + 1,
    } as unknown as File;
    expect(await fileToAttachment(huge)).toBeNull();
  });
});
