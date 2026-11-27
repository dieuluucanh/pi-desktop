import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const siteRoot = fileURLToPath(new URL("../", import.meta.url));
const names = ["welcome", "session", "editor", "settings", "source-control", "grid"];

function webpSize(path: string): { width: number; height: number } {
  const bytes = readFileSync(path);
  expect(bytes.toString("ascii", 0, 4)).toBe("RIFF");
  expect(bytes.toString("ascii", 8, 12)).toBe("WEBP");
  const chunk = bytes.toString("ascii", 12, 16);
  if (chunk === "VP8X") {
    return { width: 1 + bytes.readUIntLE(24, 3), height: 1 + bytes.readUIntLE(27, 3) };
  }
  if (chunk === "VP8 ") {
    return {
      width: bytes.readUInt16LE(26) & 0x3fff,
      height: bytes.readUInt16LE(28) & 0x3fff,
    };
  }
  throw new Error(`unsupported WebP chunk ${chunk}`);
}

describe("screenshot assets", () => {
  it("ships six 2x WebP captures", () => {
    for (const name of names) {
      const path = `${siteRoot}src/assets/screenshots/${name}.webp`;
      expect(existsSync(path), name).toBe(true);
      const size = webpSize(path);
      expect(size.width, name).toBeGreaterThanOrEqual(1600);
      expect(size.height, name).toBeGreaterThanOrEqual(900);
    }
  });

  it("uses every capture in the landing gallery", () => {
    const gallery = readFileSync(
      `${siteRoot}src/components/landing/ScreenshotGallery.astro`,
      "utf8",
    );
    for (const name of names) expect(gallery).toContain(`screenshots/${name}.webp`);
  });
});
