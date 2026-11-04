import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const siteRoot = fileURLToPath(new URL("../../", import.meta.url));
const dist = join(siteRoot, "dist");

const SUFFIXES = [
  "win-x64-setup.exe",
  "win-x64-portable.exe",
  "mac-arm64.dmg",
  "mac-x64.dmg",
  "linux-x86_64-appimage.AppImage",
  "linux-amd64-deb.deb",
  "linux-arm64-appimage.AppImage",
  "linux-arm64-deb.deb",
];

function read(relative: string): string {
  return readFileSync(join(dist, relative), "utf8");
}

function releaseVersion(html: string): string {
  return /<meta name="pi-desktop-release" content="([^"]+)"/.exec(html)?.[1] ?? "";
}

describe("download page", () => {
  it("is generated with a direct release-asset link for every installer", () => {
    expect(existsSync(join(dist, "download", "index.html"))).toBe(true);
    const html = read("download/index.html");
    const version = releaseVersion(html);
    expect(version).toMatch(/^\d+\.\d+\.\d+$/);

    expect(html).toContain('id="download"');
    for (const suffix of SUFFIXES) {
      expect(html).toContain(`data-download-suffix="${suffix}"`);
      expect(html).toContain(
        `https://github.com/dieuluucanh/pi-desktop/releases/download/v${version}/Pi-Desktop-${version}-${suffix}`,
      );
    }
    expect(html).toContain("data-download-status");
    expect(html).toContain("https://github.com/dieuluucanh/pi-desktop/releases");
    expect(html).not.toContain('href="https://api.github.com');
  });

  it("gives the landing CTAs the primary installer without JavaScript", () => {
    const html = read("index.html");
    const version = releaseVersion(html);
    expect(version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(html).toContain(
      `href="https://github.com/dieuluucanh/pi-desktop/releases/download/v${version}/Pi-Desktop-${version}-win-x64-setup.exe"`,
    );
    expect(html).toContain("data-download-primary");
    expect(html).not.toContain('href="https://api.github.com');
  });

  it("marks the detected platform on both card grids", () => {
    for (const page of ["index.html", "download/index.html"]) {
      const html = read(page);
      expect(html).toContain('class="pi-download-grid pi-platform-grid"');
      expect(html).toContain('class="pi-grid pi-grid--three pi-platform-grid"');
      expect((html.match(/data-platform="/g) ?? []).length).toBe(6);
      expect((html.match(/class="pi-badge pi-badge--gold pi-platform-flag"/g) ?? []).length).toBe(
        6,
      );
      expect(html).toContain("dataset.detectedOs");
    }
  });

  it("carries the install and update warnings", () => {
    const html = read("download/index.html");
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
