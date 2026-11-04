import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const siteRoot = fileURLToPath(new URL("../../", import.meta.url));
const dist = join(siteRoot, "dist");

describe("download page", () => {
  it("is generated with server-rendered fallbacks for every platform", () => {
    expect(existsSync(join(dist, "download", "index.html"))).toBe(true);
    const html = readFileSync(join(dist, "download", "index.html"), "utf8");
    expect(html).toContain('id="download"');
    expect(html).toContain('data-download-suffix="win-x64-setup.exe"');
    expect(html).toContain('data-download-suffix="win-x64-portable.exe"');
    expect(html).toContain('data-download-suffix="mac-arm64.dmg"');
    expect(html).toContain('data-download-suffix="mac-x64.dmg"');
    expect(html).toContain('data-download-suffix="linux-x86_64-appimage.AppImage"');
    expect(html).toContain('data-download-suffix="linux-amd64-deb.deb"');
    expect(html).toContain("data-download-status");
    expect(html).toContain("https://github.com/dieuluucanh/pi-desktop/releases");
  });

  it("carries the install and update warnings", () => {
    const html = readFileSync(join(dist, "download", "index.html"), "utf8");
    expect(html).toContain("SmartScreen");
    expect(html).toContain("Open Anyway");
    expect(html).toContain("appimage-extract-and-run");
    expect(html).toContain("Restart &amp; install");
    expect(html).toContain("macOS");
    expect(html).toContain("beta");
    expect(html).not.toContain("GITHUB_TOKEN");
    expect(html).not.toContain("ghp_");
  });
});
