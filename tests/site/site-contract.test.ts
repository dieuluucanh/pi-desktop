import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const read = (relative: string): string =>
  readFileSync(join(repoRoot, relative), "utf8").replace(/\r\n/g, "\n");
const exists = (relative: string): boolean => existsSync(join(repoRoot, relative));

const packageJson = JSON.parse(read("package.json")) as { version: string };
const sitePackage = JSON.parse(read("site/package.json")) as {
  scripts: Record<string, string>;
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
};
const pages = read(".github/workflows/pages.yml");
const checks = read(".github/workflows/checks.yml");

function walkDocs(directory: string): string[] {
  const result: string[] = [];
  for (const entry of readdirSync(join(repoRoot, directory), { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    const relative = `${directory}/${entry.name}`;
    if (entry.isDirectory()) result.push(...walkDocs(relative));
    else if (entry.isFile() && entry.name.endsWith(".md")) result.push(relative);
  }
  return result;
}

describe("public site contract", () => {
  it("pins the project URL and GitHub Pages base path in one config", () => {
    const config = read("site/site.config.mjs");
    expect(config).toContain('https://dieuluucanh.github.io');
    expect(config).toContain('"/pi-desktop"');
    expect(config).toContain("dieuluucanh/pi-desktop");
    expect(config).toContain("SOURCE_BRANCH");
    expect(read("site/astro.config.mjs")).toContain("starlight(");
    expect(read("site/astro.config.mjs")).toContain("sitemap()");
    expect(read("site/astro.config.mjs")).toContain('trailingSlash: "always"');
  });

  it("keeps the site package exact-pinned and free of analytics", () => {
    for (const name of ["astro", "@astrojs/starlight", "@astrojs/sitemap", "sharp"]) {
      expect(sitePackage.dependencies[name], name).toMatch(/^\d+\.\d+\.\d+$/);
    }
    for (const value of Object.values(sitePackage.dependencies)) {
      expect(value).not.toMatch(/^[~^]/);
    }
    for (const script of ["dev", "sync", "check", "build", "test:dist", "format:check"]) {
      expect(sitePackage.scripts[script], script).toBeTruthy();
    }
    const siteSource = [
      "site/src/pages/index.astro",
      "site/src/components/Head.astro",
      "site/src/components/Footer.astro",
      "site/src/pages/download.astro",
    ]
      .map(read)
      .join("\n");
    for (const tracker of ["googletagmanager", "plausible", "goatcounter", "gtag("]) {
      expect(siteSource).not.toContain(tracker);
    }
  });

  it("deploys from main and a manual dispatch, not from a release event", () => {
    expect(pages).toContain("branches: [main]");
    expect(pages).toContain("workflow_dispatch:");
    expect(pages).not.toMatch(/^\s{2}release:/m);
    expect(pages).not.toContain("types: [published]");
    for (const path of ["site/**", "docs/**", "assets/**", "package.json"]) {
      expect(pages).toContain(path);
    }
    expect(pages).toContain("group: pages");
    expect(pages).toContain("contents: read");
    expect(pages).toContain("pages: write");
    expect(pages).toContain("id-token: write");
    expect(pages).toContain("name: github-pages");
    expect(pages).toContain("path: site/dist");
    expect(pages).toContain("enablement: true");
    expect(pages).not.toContain("contents: write");
    expect((pages.match(/@[0-9a-f]{40}\b/g) ?? []).length).toBeGreaterThanOrEqual(5);
  });

  it("runs the site gates on pull requests without installing Electron", () => {
    expect(checks).toContain("site gates");
    expect(checks).toContain("npm ci --prefix site");
    expect(checks).toContain("cache-dependency-path: site/package-lock.json");
    expect(checks).toContain("npm --prefix site run format:check");
    expect(checks).toContain("npm run site:check");
    expect(checks).toContain("npm run site:build");
  });

  it("ignores generated site content and keeps docs as the source", () => {
    const ignore = read(".gitignore");
    for (const path of [
      "site/node_modules/",
      "site/dist/",
      "site/src/content/docs/guide/",
      "site/src/data/site.generated.json",
      "site/src/assets/brand/",
    ]) {
      expect(ignore).toContain(path);
    }
    expect(exists("site/src/content/docs/privacy.md")).toBe(true);
    expect(exists("site/src/content/docs/404.md")).toBe(true);
    expect(exists("site/scripts/sync-docs.mjs")).toBe(true);
    expect(exists("site/scripts/check-links.mjs")).toBe(true);
  });

  it("names every user/architecture/product doc in the navigation", () => {
    const nav = read("site/src/data/nav.mjs");
    const sources = walkDocs("docs").filter((source) => !source.startsWith("docs/releases/"));
    for (const source of sources) expect(nav, source).toContain(source);
  });

  it("links the live site and the current release notes from README", () => {
    const readme = read("README.md");
    expect(readme).toContain("https://dieuluucanh.github.io/pi-desktop/");
    expect(readme).toContain(`docs/releases/v${packageJson.version}.md`);
    expect(readme).not.toContain("docs/releases/v0.4.0.md");
  });

  it("keeps the privacy page factual and the footer independent", () => {
    const privacy = read("site/src/content/docs/privacy.md");
    for (const phrase of ["no analytics", "cookies", "GitHub Pages", "Telemetry is off by default", "shared by default"]) {
      expect(privacy).toContain(phrase);
    }
    expect(read("site/src/components/Footer.astro")).toContain("affiliated");
  });
});
