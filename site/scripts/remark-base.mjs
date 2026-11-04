/**
 * Prefix root-relative Markdown links and images with the Astro base path.
 *
 * Starlight handles sidebar links, but links written inside Markdown are left
 * alone (intentionally, per Astro's `base` semantics). A GitHub Pages project
 * site lives under `/pi-desktop`, so every `/guide/...` link must become
 * `/pi-desktop/guide/...` in the built HTML. The built-HTML link checker in
 * `scripts/check-links.mjs` verifies the result.
 */

import { visit } from "unist-util-visit";
import { BASE_PATH } from "../site.config.mjs";

function normalizedBase(value) {
  if (!value || value === "/") return "/";
  const withLeading = value.startsWith("/") ? value : `/${value}`;
  return withLeading.endsWith("/") ? withLeading.slice(0, -1) : withLeading;
}

/** Prefix one URL if it is a root-relative local URL. */
export function withBasePath(url, base = BASE_PATH) {
  if (typeof url !== "string" || !url.startsWith("/") || url.startsWith("//")) return url;
  const prefix = normalizedBase(base);
  if (prefix === "/") return url;
  if (url === prefix || url.startsWith(`${prefix}/`)) return url;
  return `${prefix}${url}`;
}

/** Mutate every link/image node in an mdast tree. Exported for tests. */
export function prefixTree(tree, base = BASE_PATH) {
  visit(tree, ["link", "image"], (node) => {
    node.url = withBasePath(node.url, base);
  });
  return tree;
}

export function remarkBase(options = {}) {
  const base = options.base ?? BASE_PATH;
  return (tree) => prefixTree(tree, base);
}

export default remarkBase;
