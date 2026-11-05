import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const siteRoot = fileURLToPath(new URL("../../", import.meta.url));
const html = readFileSync(join(siteRoot, "dist", "index.html"), "utf8");

describe("landing page", () => {
  it("has the hero, product claim and status", () => {
    expect(html).toContain("The Pi coding agent,");
    expect(html).toContain("without the terminal.");
    expect(html).toContain("v0.5.0");
    expect(html).toContain("Windows primary");
    expect(html).toContain("macOS/Linux beta");
    expect(html).toContain("unsigned");
  });

  it("has the trust strip and the shared-profile story", () => {
    expect(html).toContain("Same profile as terminal Pi");
    expect(html).toContain("Bundled Node 24");
    expect(html).toContain("Telemetry off by default");
    expect(html).toContain("~/.pi/agent");
    expect(html).toContain("One profile, two front ends");
  });

  it("has introduction, feature, screenshot, installation and FAQ sections", () => {
    for (const id of [
      "introduction",
      "features",
      "profile",
      "screenshots",
      "installation",
      "download",
      "install",
      "updates",
      "faq",
    ]) {
      expect(html).toContain(`id="${id}"`);
    }
    expect(html).toContain("Projects and sessions");
    expect(html).toContain("Git and checkpoints");
    expect(html).toContain("SmartScreen");
    expect(html).toContain("Open Anyway");
    expect(html).toContain("sudo apt install");
    expect(html).toContain("Is Pi Desktop the official Pi app?");
    expect(html).toContain("Frequently asked questions");
    expect(html).toContain("data-download-status");
  });

  it("orders the landing sections like the product menu", () => {
    let cursor = -1;
    for (const marker of [
      'id="introduction"',
      'id="features"',
      'id="profile"',
      'id="screenshots"',
      'id="installation"',
      'id="download"',
      'id="install"',
      'id="updates"',
      'id="faq"',
    ]) {
      const index = html.indexOf(marker, cursor + 1);
      expect(index, marker).toBeGreaterThan(cursor);
      cursor = index;
    }
  });

  it("links the product surfaces and carries no analytics", () => {
    for (const href of [
      "/pi-desktop/#introduction",
      "/pi-desktop/#features",
      "/pi-desktop/#screenshots",
      "/pi-desktop/#installation",
      "/pi-desktop/#faq",
      "/pi-desktop/docs/",
      "/pi-desktop/privacy/",
      "/pi-desktop/releases/v0.5.0/",
      "https://github.com/dieuluucanh/pi-desktop",
    ]) {
      expect(html).toContain(href);
    }
    expect(html).not.toContain('href="/pi-desktop/download/"');
    expect(html).not.toContain('href="/pi-desktop/releases/"');
    expect(html).toContain('data-download-suffix="win-x64-setup.exe"');
    expect(html).toContain("affiliated");
    expect(html).not.toContain('rel="prev"');
    expect(html).not.toContain('rel="next"');
    expect(html).not.toContain("googletagmanager");
    expect(html).not.toContain("goatcounter");
  });
});
