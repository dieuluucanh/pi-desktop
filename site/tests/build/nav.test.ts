import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const siteRoot = fileURLToPath(new URL("../../", import.meta.url));
const dist = join(siteRoot, "dist");
const read = (relative: string): string => readFileSync(join(dist, relative), "utf8");

const HREFS = [
  "/pi-desktop/#introduction",
  "/pi-desktop/#features",
  "/pi-desktop/#screenshots",
  "/pi-desktop/#installation",
  "/pi-desktop/#faq",
  "/pi-desktop/docs/",
  "https://github.com/dieuluucanh/pi-desktop",
];
const LABELS = ["Introduction", "Features", "Screenshots", "Installation", "FAQ", "Docs", "GitHub"];
const PAGES = ["index.html", "guide/getting-started/index.html", "releases/v0.5.0/index.html"];

function navSlice(html: string): string {
  const start = html.indexOf('class="pi-site-nav__inner"');
  expect(start, "the product nav is missing").toBeGreaterThanOrEqual(0);
  const end = html.indexOf("</nav>", start);
  expect(end).toBeGreaterThan(start);
  return html.slice(start, end);
}

describe("product navigation", () => {
  it("renders one menu per page in the requested order", () => {
    for (const page of PAGES) {
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
    for (const id of ["introduction", "features", "screenshots", "installation", "faq"]) {
      expect(slice).toContain(`data-spy="${id}"`);
    }
  });

  it("marks Docs as the current page on docs and release-note pages", () => {
    for (const page of ["guide/getting-started/index.html", "releases/v0.5.0/index.html"]) {
      expect(navSlice(read(page)), page).toMatch(
        /href="\/pi-desktop\/docs\/"[^>]*aria-current="page"/,
      );
    }
    expect(navSlice(read("index.html"))).not.toContain('aria-current="page"');
  });

  it("maps every in-page menu entry to a landing section", () => {
    const html = read("index.html");
    const slice = navSlice(html);
    for (const id of ["introduction", "features", "screenshots", "installation", "faq"]) {
      expect(slice).toContain(`href="/pi-desktop/#${id}"`);
      expect(slice).toContain(`data-spy="${id}"`);
      expect(html).toContain(`id="${id}"`);
    }
    expect(slice).not.toContain(">Download<");
    expect(slice).not.toContain(">Releases<");
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
  it("is documentation-only and ends with Privacy", () => {
    const slice = sidebarSlice(read("guide/getting-started/index.html"));
    const order = [
      "Documentation",
      "Getting started",
      "User guide",
      "Architecture",
      "Project",
      "Release notes",
      "Legal",
      "Privacy",
    ];
    let cursor = -1;
    for (const label of order) {
      const index = slice.indexOf(`>${label}<`, cursor + 1);
      expect(index, `${label} is out of order`).toBeGreaterThan(cursor);
      cursor = index;
    }
  });

  it("no longer links the removed product pages", () => {
    const slice = sidebarSlice(read("guide/getting-started/index.html"));
    for (const href of [
      'href="/pi-desktop/download/"',
      'href="/pi-desktop/releases/"',
      'href="/pi-desktop/features/"',
      'href="/pi-desktop/screenshots/"',
    ]) {
      expect(slice).not.toContain(href);
    }
  });
});

describe("external GitHub links", () => {
  it("open in a new tab from the product page (installers keep the tab)", () => {
    for (const page of ["index.html"]) {
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
