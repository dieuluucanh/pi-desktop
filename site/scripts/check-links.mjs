/**
 * Built-HTML link checker.
 *
 * GitHub Pages project sites live under a base path, and neither Astro nor
 * Starlight prefixes links written in Markdown. This script resolves every
 * internal href/src against the generated dist/ tree, verifies the base prefix,
 * checks anchors, and fails with the full list of problems. External URLs are
 * intentionally not fetched (the site must build offline).
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { BASE_PATH } from "../site.config.mjs";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_DIST = resolve(SCRIPT_DIR, "..", "dist");

function toPosix(value) {
  return value.split(sep).join("/");
}

function normalizeBase(value) {
  if (!value || value === "/") return "/";
  const withLeading = value.startsWith("/") ? value : `/${value}`;
  return withLeading.endsWith("/") ? withLeading.slice(0, -1) : withLeading;
}

function walkHtml(directory) {
  const result = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolute = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...walkHtml(absolute));
    else if (entry.isFile() && entry.name.endsWith(".html")) result.push(absolute);
  }
  return result;
}

function attributes(html, name) {
  return [...html.matchAll(new RegExp(`\\b${name}\\s*=\\s*(["'])(.*?)\\1`, "gi"))].map(
    (match) => match[2] ?? "",
  );
}

function decode(value) {
  return value
    .replaceAll("&amp;", "&")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">");
}

function pageUrl(distDir, file) {
  const relativePath = toPosix(relative(distDir, file));
  if (relativePath === "index.html") return "/";
  if (relativePath.endsWith("/index.html"))
    return `/${relativePath.slice(0, -"index.html".length)}`;
  if (relativePath.endsWith(".html")) return `/${relativePath}`;
  return `/${relativePath}`;
}

function fileForPath(distDir, pathname) {
  const relativePath = pathname.replace(/^\/+/, "");
  const candidates = pathname.endsWith("/")
    ? [join(distDir, relativePath, "index.html")]
    : [
        join(distDir, relativePath),
        join(distDir, relativePath, "index.html"),
        join(distDir, `${relativePath}.html`),
      ];
  return (
    candidates.find((candidate) => existsSync(candidate) && statSync(candidate).isFile()) ?? null
  );
}

function hasAnchor(file, fragment) {
  if (!fragment) return true;
  const html = readFileSync(file, "utf8");
  const escaped = fragment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\b(?:id|name)=(["'])${escaped}\\1`).test(html);
}

export function checkLinks({ distDir = DEFAULT_DIST, basePath = BASE_PATH } = {}) {
  const base = normalizeBase(basePath);
  if (!existsSync(distDir)) return [`dist directory not found: ${distDir}`];

  const problems = [];
  for (const file of walkHtml(distDir)) {
    const html = readFileSync(file, "utf8");
    const page = pageUrl(distDir, file);
    for (const raw of [...attributes(html, "href"), ...attributes(html, "src")]) {
      const value = decode(raw).trim();
      if (!value || value.startsWith("#") || value.startsWith("//")) continue;
      if (/^(?:[a-z][a-z0-9+.-]*:)/i.test(value)) continue;

      let url;
      try {
        url = new URL(value, `https://site.invalid${page}`);
      } catch {
        problems.push(`${toPosix(relative(distDir, file))}: invalid URL ${value}`);
        continue;
      }
      if (url.origin !== "https://site.invalid") continue;

      const pathname = decodeURIComponent(url.pathname);
      if (!pathname.startsWith("/")) {
        problems.push(
          `${toPosix(relative(distDir, file))}: relative URL did not resolve: ${value}`,
        );
        continue;
      }
      if (base !== "/" && pathname !== base && !pathname.startsWith(`${base}/`)) {
        problems.push(
          `${toPosix(relative(distDir, file))}: ${value} is missing the base prefix ${base}`,
        );
        continue;
      }

      const withoutBase = base === "/" ? pathname : pathname.slice(base.length) || "/";
      const target = fileForPath(distDir, withoutBase);
      if (!target) {
        problems.push(`${toPosix(relative(distDir, file))}: ${value} -> missing file`);
        continue;
      }
      if (url.hash && !hasAnchor(target, decodeURIComponent(url.hash.slice(1)))) {
        problems.push(`${toPosix(relative(distDir, file))}: ${value} -> missing anchor`);
      }
    }
  }
  return problems;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const distArg = process.argv[2] ?? DEFAULT_DIST;
  const problems = checkLinks({ distDir: resolve(distArg) });
  if (problems.length > 0) {
    console.error(`check-links: ${problems.length} problem(s)`);
    for (const problem of problems) console.error(`  ${problem}`);
    process.exitCode = 1;
  } else {
    console.log("check-links: all internal links and anchors resolve");
  }
}
