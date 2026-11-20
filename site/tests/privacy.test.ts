import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const siteRoot = fileURLToPath(new URL("../", import.meta.url));
const read = (relative: string) => readFileSync(`${siteRoot}${relative}`, "utf8");

describe("privacy and footer", () => {
  it("states the site and app data facts", () => {
    const privacy = read("src/content/docs/privacy.md");
    expect(privacy).toContain("no analytics");
    expect(privacy).toContain("cookies");
    expect(privacy).toContain("GitHub Pages");
    expect(privacy).toContain("Telemetry is off by default");
    expect(privacy).toContain("shared by default");
    expect(privacy).toContain("userData");
  });

  it("links every support surface from the global footer", () => {
    const footer = read("src/components/Footer.astro");
    for (const href of [
      "/#installation",
      "/#faq",
      "/docs/",
      "/privacy/",
      "REPO_URL",
      "RELEASES_URL",
      "CONTRIBUTING.md",
      "LICENSE",
    ]) {
      expect(footer).toContain(href);
    }
    expect(footer).toContain("affiliated");
    expect(footer).not.toContain('withBase("/download/")');
    expect(footer).not.toContain('withBase("/releases/")');
  });
});
