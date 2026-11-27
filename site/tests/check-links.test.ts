import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkLinks } from "../scripts/check-links.mjs";

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "pi-desktop-links-"));
  mkdirSync(join(root, "guide"), { recursive: true });
  mkdirSync(join(root, "broken"), { recursive: true });
  mkdirSync(join(root, "orphan"), { recursive: true });
  mkdirSync(join(root, "anchor"), { recursive: true });
  writeFileSync(
    join(root, "index.html"),
    '<a href="/pi-desktop/guide/">guide</a><a href="https://example.com">external</a><h2 id="top">top</h2><a href="#top">self</a>',
  );
  writeFileSync(
    join(root, "guide", "index.html"),
    '<h2 id="x">x</h2><a href="/pi-desktop/">home</a><a href="#x">anchor</a><img src="/pi-desktop/logo.svg">',
  );
  writeFileSync(join(root, "logo.svg"), "<svg />");
  writeFileSync(join(root, "broken", "index.html"), '<a href="/pi-desktop/nope/">missing</a>');
  writeFileSync(join(root, "orphan", "index.html"), '<a href="/guide/">missing base</a>');
  writeFileSync(
    join(root, "anchor", "index.html"),
    '<a href="/pi-desktop/guide/#nope">bad anchor</a>',
  );
  return root;
}

describe("check-links", () => {
  it("accepts internal links, anchors and external URLs", () => {
    const root = fixture();
    try {
      const problems = checkLinks({ distDir: root, basePath: "/pi-desktop" });
      expect(problems.filter((problem) => problem.startsWith("index.html:"))).toEqual([]);
      expect(problems.filter((problem) => problem.startsWith("guide/index.html:"))).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reports missing files, missing base prefixes and missing anchors", () => {
    const root = fixture();
    try {
      const problems = checkLinks({ distDir: root, basePath: "/pi-desktop" });
      expect(problems).toEqual(
        expect.arrayContaining([
          expect.stringContaining("broken/index.html: /pi-desktop/nope/ -> missing file"),
          expect.stringContaining("orphan/index.html: /guide/ is missing the base prefix"),
          expect.stringContaining("anchor/index.html: /pi-desktop/guide/#nope -> missing anchor"),
        ]),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not fetch external URLs", () => {
    const root = fixture();
    try {
      const problems = checkLinks({ distDir: root, basePath: "/pi-desktop" });
      expect(problems.some((problem) => problem.includes("example.com"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
