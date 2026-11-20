// Shared site identity. This is the only place the public URL, GitHub Pages
// base path and repository coordinates live. A custom domain later means
// changing SITE_URL/BASE_PATH (or setting the environment overrides) and adding
// a CNAME; it does not mean rewriting links.

export const SITE_URL = process.env.SITE_URL ?? "https://dieuluucanh.github.io";
export const BASE_PATH = normalizeBase(process.env.SITE_BASE_PATH ?? "/pi-desktop");
export const REPO = "dieuluucanh/pi-desktop";
export const REPO_URL = `https://github.com/${REPO}`;
export const RELEASES_URL = `${REPO_URL}/releases`;
export const SOURCE_BRANCH = "main";

function normalizeBase(value) {
  if (!value || value === "/") return "/";
  const withLeading = value.startsWith("/") ? value : `/${value}`;
  return withLeading.endsWith("/") ? withLeading.slice(0, -1) : withLeading;
}

/** Root-relative URL with the configured GitHub Pages base path. */
export function withBase(path = "/") {
  const suffix = path.startsWith("/") ? path : `/${path}`;
  if (BASE_PATH === "/") return suffix;
  return `${BASE_PATH}${suffix === "/" ? "/" : suffix}`;
}

/** Absolute URL for canonical/Open Graph/sitemap-adjacent metadata. */
export function absoluteUrl(path = "/") {
  return new URL(withBase(path), SITE_URL).toString();
}
