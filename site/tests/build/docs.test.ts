import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const siteRoot = fileURLToPath(new URL("../../", import.meta.url));
const dist = join(siteRoot, "dist");

describe("docs site UX", () => {
  it("ships Pagefind search and the docs index entry points", () => {
    expect(existsSync(join(dist, "pagefind", "pagefind.js"))).toBe(true);
    const index = readFileSync(join(dist, "docs", "index.html"), "utf8");
    expect(index).toContain("https://dieuluucanh.github.io/pi-desktop/");
    expect(index).toContain("Getting started");
    expect(index).toContain("FAQ");
    expect(index).toContain("Troubleshooting");
  });

  it("links every generated page back to its docs source", () => {
    const page = readFileSync(join(dist, "guide", "getting-started", "index.html"), "utf8");
    expect(page).toContain(
      "https://github.com/dieuluucanh/pi-desktop/edit/main/docs/guide/getting-started.md",
    );
    expect(page).toContain("Edit page");
  });

  it("puts the product nav on docs pages with the base prefix", () => {
    const page = readFileSync(join(dist, "guide", "getting-started", "index.html"), "utf8");
    expect(page).toContain('href="/pi-desktop/docs/"');
    expect(page).toContain('href="/pi-desktop/download/"');
    expect(page).toContain('href="/pi-desktop/releases/"');
  });
});
