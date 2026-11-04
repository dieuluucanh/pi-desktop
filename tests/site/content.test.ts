import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const read = (relative: string): string =>
  readFileSync(`${repoRoot}${relative}`, "utf8").replace(/\r\n/g, "\n");

describe("public site content", () => {
  it("ships an accurate hero and status", () => {
    const hero = read("site/src/components/landing/Hero.astro");
    expect(hero).toContain("The Pi coding agent");
    expect(hero).toContain("without the terminal");
    expect(hero).toContain("Windows primary");
    expect(hero).toContain("macOS/Linux beta");
    expect(hero).toContain("unsigned");
    expect(hero.replace(/\s+/g, " ")).toContain("no Node, npm or Pi install required");
  });

  it("states the shared profile and the safety facts", () => {
    const profile = read("site/src/components/landing/ProfileSection.astro");
    expect(profile).toContain("~/.pi/agent");
    expect(profile).toContain("same profile as terminal Pi");
    expect(profile).toContain("never rewrites");
    const features = read("site/src/components/landing/FeatureGrid.astro");
    for (const phrase of ["Projects and sessions", "Files and editor", "Providers and models", "Git and checkpoints", "Pi for Office, optionally"]) {
      expect(features).toContain(phrase);
    }
  });

  it("uses the current installer names and the macOS/Windows warnings", () => {
    const platforms = read("site/src/data/platforms.ts");
    for (const suffix of [
      "win-x64-setup.exe",
      "win-x64-portable.exe",
      "mac-arm64.dmg",
      "mac-x64.dmg",
      "linux-x86_64-appimage.AppImage",
      "linux-amd64-deb.deb",
      "linux-arm64-appimage.AppImage",
      "linux-arm64-deb.deb",
    ]) {
      expect(platforms).toContain(suffix);
    }
    const install = read("site/src/components/landing/InstallSection.astro");
    expect(install).toContain("SmartScreen");
    expect(install).toContain("Open Anyway");
    expect(install).toContain("Updates are manual");
    expect(install).toContain("apt install");
  });

  it("has a complete FAQ and a clear closing action", () => {
    const faq = read("site/src/components/landing/FaqSection.astro");
    for (const question of [
      "Is Pi Desktop the official Pi app?",
      "Do I need terminal Pi installed?",
      "Does it share my terminal Pi setup?",
      "Does the app send telemetry?",
      "Why does Windows or macOS warn when I install it?",
      "Can extensions do anything they want?",
      "Where do I report a bug?",
    ]) {
      expect(faq).toContain(question);
    }
    const closing = read("site/src/components/landing/ClosingCta.astro");
    expect(closing).toContain("Download Pi Desktop");
    expect(closing).toContain("/docs/");
    expect(closing).toContain("github.com/dieuluucanh/pi-desktop");
  });
});
