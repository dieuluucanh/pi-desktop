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

  it("has feature, screenshot, install and FAQ sections", () => {
    for (const id of ["features", "screenshots", "download", "install", "faq"]) {
      expect(html).toContain(`id="${id}"`);
    }
    expect(html).toContain("Projects and sessions");
    expect(html).toContain("Git and checkpoints");
    expect(html).toContain("SmartScreen");
    expect(html).toContain("Open Anyway");
    expect(html).toContain("sudo apt install");
    expect(html).toContain("Is Pi Desktop the official Pi app?");
  });

  it("links the product surfaces and carries no analytics", () => {
    for (const href of [
      "/pi-desktop/download/",
      "/pi-desktop/docs/",
      "/pi-desktop/releases/",
      "/pi-desktop/privacy/",
      "https://github.com/dieuluucanh/pi-desktop",
    ]) {
      expect(html).toContain(href);
    }
    expect(html).toContain('data-download-suffix="win-x64-setup.exe"');
    expect(html).toContain("affiliated");
    expect(html).not.toContain("googletagmanager");
    expect(html).not.toContain("goatcounter");
  });
});
