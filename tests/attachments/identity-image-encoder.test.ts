import { deflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { crc32 } from "../../src/attachments/crc32";
import { boundedIdentityImageEncoder } from "../support/identity-image-encoder";

function chunk(name: string, data: Uint8Array): Buffer {
  const type = Buffer.from(name, "ascii");
  const result = Buffer.alloc(12 + data.length);
  result.writeUInt32BE(data.length, 0);
  type.copy(result, 4);
  result.set(data, 8);
  result.writeUInt32BE(crc32(result.subarray(4, 8 + data.length)), 8 + data.length);
  return result;
}

function png(width = 1, height = 1): Uint8Array {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(new Uint8Array([0, 255, 0, 0, 255]))),
    chunk("IEND", new Uint8Array()),
  ]);
}

describe("bounded identity image encoder", () => {
  it("copies an already-small raster without changing bytes or metadata", async () => {
    const source = png();
    const result = await boundedIdentityImageEncoder.prepare(source, "image/png", {
      maxWidth: 10,
      maxHeight: 10,
      maxEncodedBytes: 1024,
    });
    expect(result).toMatchObject({
      mime: "image/png",
      originalWidth: 1,
      originalHeight: 1,
      width: 1,
      height: 1,
      wasResized: false,
    });
    expect(result?.bytes).toEqual(new Uint8Array(source));
    expect(result?.bytes).not.toBe(source);
  });

  it("refuses images that need decoding, resizing, or transcoding", async () => {
    expect(
      await boundedIdentityImageEncoder.prepare(png(11, 1), "image/png", {
        maxWidth: 10,
        maxHeight: 10,
        maxEncodedBytes: 1024,
      }),
    ).toBeNull();
    expect(
      await boundedIdentityImageEncoder.prepare(png(), "image/png", {
        maxWidth: 10,
        maxHeight: 10,
        maxEncodedBytes: 1,
      }),
    ).toBeNull();
    expect(
      await boundedIdentityImageEncoder.prepare(new Uint8Array([0]), "image/bmp", {
        maxWidth: 10,
        maxHeight: 10,
        maxEncodedBytes: 1024,
      }),
    ).toBeNull();
  });
});
