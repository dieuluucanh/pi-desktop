import { describe, expect, it } from "vitest";
import { validateLegacyImages } from "../../src/host/legacy-image-compat";

const pixelPng =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

describe("legacy renderer image compatibility adapter", () => {
  it("preserves a bounded, sniffed static image in Pi's public ImageContent shape", async () => {
    await expect(
      validateLegacyImages(
        [{ type: "image", mimeType: "image/png", data: pixelPng }],
        "Look at this",
      ),
    ).resolves.toEqual([{ type: "image", mimeType: "image/png", data: pixelPng }]);
  });

  it("rejects noncanonical base64, MIME/signature mismatches, and extra fields", async () => {
    await expect(
      validateLegacyImages([{ type: "image", mimeType: "image/png", data: "abc" }], "look"),
    ).rejects.toThrow(/invalid or exceeds/);
    await expect(
      validateLegacyImages([{ type: "image", mimeType: "image/jpeg", data: pixelPng }], "look"),
    ).rejects.toThrow(/invalid or exceeds/);
    await expect(
      validateLegacyImages(
        [{ type: "image", mimeType: "image/png", data: pixelPng, path: "C:/secret.png" }],
        "look",
      ),
    ).rejects.toThrow(/invalid or exceeds/);
  });

  it("enforces the image-count cap before decoding payloads", async () => {
    const tooMany = Array.from({ length: 11 }, () => ({
      type: "image",
      mimeType: "image/png",
      data: pixelPng,
    }));
    await expect(validateLegacyImages(tooMany, "look")).rejects.toThrow(/invalid or exceeds/);
  });
});
