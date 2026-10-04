import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Brand-asset guard (plan step 28).
 *
 * The icon files are opaque binaries: nothing else in the suite would notice if
 * one were truncated, renamed, or resized in place, and the failure would only
 * surface as a blurry installer on a machine nobody tests on. These assertions
 * are the cheap stand-in — the file set, the dimensions the filenames claim, and
 * the `.ico` container's own header.
 *
 * `icon-512.png` is load-bearing: electron-builder derives the macOS `.icns` and
 * the Linux icon set from it, and 512 is the minimum it will convert. Hence the
 * explicit floor assertion rather than "a 512 file exists".
 */

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const assetsDir = join(repoRoot, "assets");

/** The rasters, by the size their filename claims. `icon-80.png` is the Office
 * add-in's hosted size and is deliberately not a Windows icon size. */
const PNG_SIZES = [16, 32, 80, 128, 256, 512];

/** The sizes embedded in `assets/icon.ico` (Windows icon sizes; 512 > the 256 ceiling). */
const ICO_SIZES = [16, 32, 128, 256];

function readAsset(name: string): Buffer {
  return readFileSync(join(assetsDir, name));
}

/** PNG dimensions live in the IHDR chunk: 8 signature bytes, 4 length, 4 type. */
function pngDimensions(bytes: Buffer): { width: number; height: number } {
  expect(bytes.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

/** ICO entries: 6-byte header, then 16 bytes each; dimensions are single bytes. */
function icoWidths(bytes: Buffer): number[] {
  const count = bytes.readUInt16LE(4);
  return Array.from({ length: count }, (_, index) => bytes.readUInt8(6 + index * 16) || 256);
}

describe("brand assets (plan step 28)", () => {
  it("ships every raster and both desktop SVG marks", () => {
    for (const size of PNG_SIZES)
      expect(() => readAsset(`icon-${size}.png`), String(size)).not.toThrow();
    expect(() => readAsset("icon.ico")).not.toThrow();
    expect(() => readAsset("pi-desktop-icon.svg")).not.toThrow();
    expect(() => readAsset("pi-desktop-logo-full.svg")).not.toThrow();
  });

  it("has each PNG at exactly the dimensions its filename claims", () => {
    for (const size of PNG_SIZES) {
      const { width, height } = pngDimensions(readAsset(`icon-${size}.png`));
      expect({ file: `icon-${size}.png`, width, height }).toEqual({
        file: `icon-${size}.png`,
        width: size,
        height: size,
      });
    }
  });

  it("keeps a 512px PNG, the floor electron-builder converts from", () => {
    const { width } = pngDimensions(readAsset("icon-512.png"));
    expect(width).toBeGreaterThanOrEqual(512);
  });

  it("ships a well-formed icon.ico covering the Windows sizes", () => {
    const ico = readAsset("icon.ico");
    // Reserved 0, type 1 (icon), then the entry count.
    expect(ico.readUInt16LE(0)).toBe(0);
    expect(ico.readUInt16LE(2)).toBe(1);
    expect(icoWidths(ico)).toEqual(ICO_SIZES);
  });

  it("keeps the desktop lockup reading PI DESKTOP and the Office original untouched", () => {
    // The desktop app must never ship the add-in's wordmark; the originals stay
    // as the add-in's identity (see assets/README.md for the derivation rule).
    expect(readAsset("pi-desktop-logo-full.svg").toString("utf8")).toContain("PI DESKTOP");
    expect(readAsset("pi-desktop-logo-full.svg").toString("utf8")).not.toContain("FOR OFFICE");
    expect(readAsset("pi-for-office-logo-full.svg").toString("utf8")).toContain("FOR OFFICE");
  });
});
