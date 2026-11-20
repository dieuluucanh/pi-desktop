import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

function pngSize(path: string): { width: number; height: number } {
  const bytes = readFileSync(path);
  expect(bytes.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

const siteRoot = fileURLToPath(new URL("../../", import.meta.url));
const dist = join(siteRoot, "dist");
const read = (relative: string) => readFileSync(join(dist, relative), "utf8");
const currentVersion =
  /<meta name="pi-desktop-release" content="([^"]+)"/.exec(read("index.html"))?.[1] ?? "";

describe("built SEO output", () => {
  it("has one canonical, an OG image and theme metadata", () => {
    const html = read("guide/getting-started/index.html");
    expect(html.match(/rel="canonical"/g)).toHaveLength(1);
    expect(html).toContain('property="og:image"');
    expect(html).toContain("https://dieuluucanh.github.io/pi-desktop/og.png");
    expect(html).toContain('name="theme-color" content="#0A3D9C"');
    expect(html).toContain('rel="apple-touch-icon"');
    expect(html).not.toContain("fonts.googleapis.com");
    expect(html).not.toContain("googletagmanager.com");
  });

  it("ships the sitemap, robots and 404 with the project base path", () => {
    expect(existsSync(join(dist, "404.html"))).toBe(true);
    expect(read("robots.txt")).toContain(
      "Sitemap: https://dieuluucanh.github.io/pi-desktop/sitemap-index.xml",
    );
    expect(read("sitemap-index.xml")).toContain("/pi-desktop/");
    const sitemap = read("sitemap-0.xml");
    for (const removed of ["download", "features", "screenshots"]) {
      expect(sitemap).not.toContain(`/pi-desktop/${removed}/</loc>`);
    }
    expect(sitemap).not.toContain("/pi-desktop/releases/</loc>");
    expect(sitemap).toContain(`/pi-desktop/releases/v${currentVersion}/</loc>`);
  });

  it("ships a 1200x630 OG image", () => {
    expect(pngSize(join(dist, "og.png"))).toEqual({ width: 1200, height: 630 });
  });
});
