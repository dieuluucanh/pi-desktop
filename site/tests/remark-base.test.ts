import { unified } from "unified";
import remarkParse from "remark-parse";
import { describe, expect, it } from "vitest";
import { prefixTree, withBasePath } from "../scripts/remark-base.mjs";

function urls(markdown: string, base: string): string[] {
  const tree = unified().use(remarkParse).parse(markdown);
  prefixTree(tree, base);
  const result: string[] = [];
  const walk = (node: { type?: string; url?: string; children?: unknown[] }) => {
    if (node.type === "link" || node.type === "image") result.push(node.url ?? "");
    for (const child of node.children ?? []) walk(child as typeof node);
  };
  walk(tree as unknown as { children: unknown[] });
  return result;
}

describe("remark-base", () => {
  it("prefixes links and images with the GitHub Pages base", () => {
    expect(urls("[guide](/guide/x/) ![shot](/img/a.png)", "/pi-desktop")).toEqual([
      "/pi-desktop/guide/x/",
      "/pi-desktop/img/a.png",
    ]);
  });

  it("leaves external, protocol-relative, anchor and already-prefixed URLs alone", () => {
    expect(
      urls(
        "[e](https://pi.dev) [p](//example.com/x) [a](#updates) [b](/pi-desktop/guide/)",
        "/pi-desktop",
      ),
    ).toEqual(["https://pi.dev", "//example.com/x", "#updates", "/pi-desktop/guide/"]);
  });

  it("is a no-op at the root base and idempotent", () => {
    expect(withBasePath("/guide/x/", "/")).toBe("/guide/x/");
    expect(withBasePath("/guide/x/", "/pi-desktop")).toBe("/pi-desktop/guide/x/");
    expect(withBasePath("/pi-desktop/guide/x/", "/pi-desktop")).toBe("/pi-desktop/guide/x/");
    expect(withBasePath("/", "/pi-desktop")).toBe("/pi-desktop/");
  });
});
