import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const siteRoot = fileURLToPath(new URL("../../", import.meta.url));
const dist = join(siteRoot, "dist");
const read = (relative: string): string => readFileSync(join(dist, relative), "utf8");

const HREFS = [
  "/pi-desktop/#features",
  "/pi-desktop/#screenshots",
  "/pi-desktop/download/",
  "/pi-desktop/releases/",
  "/pi-desktop/docs/",
  "https://github.com/dieuluucanh/pi-desktop",
];
const LABELS = ["Features", "Screenshots", "Download", "Releases", "Docs", "GitHub"];

function navSlice(html: string): string {
  const start = html.indexOf('class="pi-site-nav__inner"');
  expect(start, "the product nav is missing").toBeGreaterThanOrEqual(0);
  const end = html.indexOf("</nav>", start);
  expect(end).toBeGreaterThan(start);
  return html.slice(start, end);
}

describe("product navigation", () => {
  it("renders one menu per page in the requested order", () => {
    for (const page of ["index.html", "download/index.html", "guide/getting-started/index.html"]) {
      const html = read(page);
      expect((html.match(/class="pi-site-nav__inner"/g) ?? []).length, page).toBe(1);
      const slice = navSlice(html);
      const hrefs = [...slice.matchAll(/<a\b[^>]*\bhref="([^"]*)"/g)].map((match) => match[1]);
      expect(hrefs, page).toEqual(HREFS);
      for (const label of LABELS) expect(slice, `${page}: ${label}`).toContain(`>${label}`);
    }
  });

  it("opens GitHub in a new tab without leaking the opener", () => {
    const slice = navSlice(read("index.html"));
    const github =
      /<a\b[^>]*href="https:\/\/github\.com\/dieuluucanh\/pi-desktop"[^>]*>/.exec(slice)?.[0] ?? "";
    expect(github).toContain('target="_blank"');
    expect(github).toContain('rel="noopener noreferrer"');
    expect(slice).toContain("opens in a new tab");
    expect(slice).toContain('data-spy="features"');
    expect(slice).toContain('data-spy="screenshots"');
  });

  it("marks the section the visitor is in without JavaScript", () => {
    expect(navSlice(read("download/index.html"))).toMatch(
      /href="\/pi-desktop\/download\/"[^>]*aria-current="page"/,
    );
    expect(navSlice(read("releases/index.html"))).toMatch(
      /href="\/pi-desktop\/releases\/"[^>]*aria-current="page"/,
    );
    expect(navSlice(read("guide/getting-started/index.html"))).toMatch(
      /href="\/pi-desktop\/docs\/"[^>]*aria-current="page"/,
    );
    expect(navSlice(read("index.html"))).not.toContain('aria-current="page"');
  });
});

function sidebarSlice(html: string): string {
  const start = html.indexOf('id="starlight__sidebar"');
  expect(start, "the docs sidebar is missing").toBeGreaterThanOrEqual(0);
  const end = html.indexOf("</nav>", start);
  expect(end).toBeGreaterThan(start);
  return html.slice(start, end);
}

describe("docs sidebar", () => {
  it("follows the product menu order and ends with Privacy", () => {
    const slice = sidebarSlice(read("guide/getting-started/index.html"));
    const order = [
      "Home",
      "Features",
      "Screenshots",
      "Download",
      "Releases",
      "Documentation",
      "Release notes",
      "Privacy",
    ];
    let cursor = -1;
    for (const label of order) {
      const index = slice.indexOf(`>${label}<`, cursor + 1);
      expect(index, `${label} is out of order`).toBeGreaterThan(cursor);
      cursor = index;
    }
  });

  it("links the landing anchors through static redirect pages", () => {
    const slice = sidebarSlice(read("guide/getting-started/index.html"));
    expect(slice).toContain('href="/pi-desktop/features/"');
    expect(slice).toContain('href="/pi-desktop/screenshots/"');
    expect(slice).not.toContain("#features/");

    for (const [page, target] of [
      ["features", "/pi-desktop/#features"],
      ["screenshots", "/pi-desktop/#screenshots"],
    ] as const) {
      const html = read(`${page}/index.html`);
      expect(html, page).toContain(`url=${target}`);
      expect(html, page).toContain('name="robots" content="noindex"');
    }
  });
});

describe("external GitHub links", () => {
  it("open in a new tab from every product page (installers keep the tab)", () => {
    for (const page of ["index.html", "download/index.html", "releases/index.html"]) {
      const html = read(page);
      const anchors = [...html.matchAll(/<a\b[^>]*href="https:\/\/github\.com\/[^"]*"[^>]*>/g)]
        .map((match) => match[0])
        .filter((anchor) => !anchor.includes("/releases/download/"));
      expect(anchors.length, page).toBeGreaterThan(0);
      for (const anchor of anchors) {
        expect(anchor, `${page}: ${anchor}`).toContain('target="_blank"');
        expect(anchor, `${page}: ${anchor}`).toContain("noopener");
      }
    }
  });
});
