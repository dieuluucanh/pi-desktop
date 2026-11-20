import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { hashFile, syncBrand } from "../scripts/sync-brand.mjs";

function pngSize(path: string): { width: number; height: number } {
  const bytes = readFileSync(path);
  expect(bytes.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

const siteRoot = fileURLToPath(new URL("../", import.meta.url));
const repoRoot = fileURLToPath(new URL("../../", import.meta.url));

describe("brand assets", () => {
  it("copies the canonical assets and keeps their hashes", () => {
    const copied = syncBrand();
    expect(copied.map((entry: { name: string }) => entry.name)).toEqual([
      "pi-desktop-logo-full.svg",
      "pi-desktop-icon.svg",
      "icon-32.png",
      "icon-256.png",
      "icon-512.png",
    ]);
    for (const entry of copied) {
      expect(hashFile(join(repoRoot, "assets", entry.name))).toBe(entry.hash);
      expect(existsSync(join(siteRoot, "src", "assets", "brand", entry.name))).toBe(true);
      expect(existsSync(join(siteRoot, "public", "brand", entry.name))).toBe(true);
    }
    expect(existsSync(join(siteRoot, "public", "favicon.svg"))).toBe(true);
  });

  it("ships a 1200x630 social image and a favicon in the build", () => {
    expect(pngSize(join(siteRoot, "public", "og.png"))).toEqual({ width: 1200, height: 630 });
    expect(readFileSync(join(siteRoot, "public", "favicon.svg"), "utf8")).toContain("<svg");
  });
});
