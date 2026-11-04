import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const siteRoot = fileURLToPath(new URL("../../", import.meta.url));
const dist = join(siteRoot, "dist");
const read = (relative: string): string => readFileSync(join(dist, relative), "utf8");

function headerSlice(html: string): string {
  const start = html.indexOf("<header");
  expect(start, "the site header is missing").toBeGreaterThanOrEqual(0);
  const end = html.indexOf("</header>", start);
  expect(end).toBeGreaterThan(start);
  return html.slice(start, end);
}

describe("theme picker", () => {
  it("renders three icon buttons with accessible names instead of a select", () => {
    const header = headerSlice(read("index.html"));
    expect(header).toContain('role="group"');
    expect(header).toContain('aria-label="Color theme"');
    expect(header).toContain("data-theme-group");
    expect((header.match(/data-theme-choice="/g) ?? []).length).toBe(3);
    expect((header.match(/aria-pressed="false"/g) ?? []).length).toBe(3);

    for (const label of ["Light theme", "Dark theme", "System theme"]) {
      expect(header).toContain(`aria-label="${label}"`);
    }

    // The default Starlight control's text options must be gone.
    expect(header).not.toContain("<select");
    expect(header).not.toContain(">Light<");
    expect(header).not.toContain(">Dark<");
    expect(header).not.toContain(">Auto<");
  });

  it("also appears in the mobile menu on docs pages", () => {
    const html = read("guide/getting-started/index.html");
    expect((html.match(/data-theme-choice="/g) ?? []).length).toBe(6);
  });
});
