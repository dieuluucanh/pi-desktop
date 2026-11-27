/**
 * Generate the public docs from `docs/` — the repository's single source of
 * truth — into the Starlight content collection.
 *
 * The sync is deliberately strict: an unknown link target, a missing H1, a
 * source frontmatter block, a missing image or a route collision fails the
 * build instead of silently shipping a broken page. The generated files and
 * `src/data/site.generated.json` are gitignored; CI always regenerates them.
 */

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, posix, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { toString } from "mdast-util-to-string";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import remarkStringify from "remark-stringify";
import { unified } from "unified";
import { visit } from "unist-util-visit";
import { BASE_PATH, REPO, REPO_URL, SITE_URL, SOURCE_BRANCH } from "../site.config.mjs";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
export const SITE_ROOT = resolve(SCRIPT_DIR, "..");
export const DEFAULT_REPO_ROOT = resolve(SITE_ROOT, "..");
export const CONTENT_ROOT = join(SITE_ROOT, "src", "content", "docs");
export const PUBLIC_ROOT = join(SITE_ROOT, "public");
export const MANIFEST_PATH = join(SITE_ROOT, "src", "data", "site.generated.json");

const GENERATED_DIRS = ["guide", "architecture", "product", "releases", "docs"];
const ALLOWED_ROOT_FILES = new Set([
  "README.md",
  "CONTRIBUTING.md",
  "AGENTS.md",
  "LICENSE",
  "THIRD_PARTY_NOTICES.md",
  "package.json",
]);
const ALLOWED_ROOT_DIRS = ["assets", ".github", "scripts", "src", "resources"];

export class DocsSyncError extends Error {
  constructor(message) {
    super(message);
    this.name = "DocsSyncError";
  }
}

function toPosix(value) {
  return value.split(sep).join("/");
}

function fromPosix(value) {
  return value.split("/").join(sep);
}

function repoRelative(root, absolute) {
  return toPosix(relative(root, absolute));
}

function assertInsideRepo(value) {
  if (!value || value.startsWith("..") || value.includes("/../")) {
    throw new DocsSyncError(`link escapes the repository: ${value}`);
  }
  return value;
}

function splitSuffix(url) {
  const match = /^([^?#]*)([?#].*)?$/.exec(url);
  return { path: match?.[1] ?? url, suffix: match?.[2] ?? "" };
}

export function routeForSource(sourceRel) {
  if (sourceRel === "docs/README.md") return "/docs/";
  if (!sourceRel.startsWith("docs/") || !sourceRel.endsWith(".md")) {
    throw new DocsSyncError(`not a docs Markdown file: ${sourceRel}`);
  }
  const withoutRoot = sourceRel.slice("docs/".length).replace(/\.md$/, "");
  if (!withoutRoot || withoutRoot.includes("/../")) {
    throw new DocsSyncError(`invalid docs path: ${sourceRel}`);
  }
  return `/${withoutRoot}/`;
}

export function targetForSource(sourceRel) {
  const withoutRoot =
    sourceRel === "docs/README.md" ? "docs/index.md" : sourceRel.slice("docs/".length);
  return posix.join("site/src/content/docs", withoutRoot);
}

function isExternal(url) {
  return /^[a-z][a-z0-9+.-]*:/i.test(url) || url.startsWith("//");
}

function isAllowedRootPath(targetRel) {
  if (ALLOWED_ROOT_FILES.has(targetRel)) return true;
  return ALLOWED_ROOT_DIRS.some((dir) => targetRel === dir || targetRel.startsWith(`${dir}/`));
}

function githubUrl(targetRel, suffix, root) {
  const absolute = join(root, fromPosix(targetRel));
  const isDirectory = existsSync(absolute) && statSync(absolute).isDirectory();
  return `${REPO_URL}/${isDirectory ? "tree" : "blob"}/${SOURCE_BRANCH}/${targetRel}${suffix}`;
}

function resolveLink(url, sourceRel, root) {
  if (url.startsWith("#") || isExternal(url)) return url;

  const { path: pathPart, suffix } = splitSuffix(url);
  if (!pathPart) return url;
  if (pathPart.startsWith("/")) return url;

  const fromDir = posix.dirname(sourceRel);
  const targetRel = assertInsideRepo(posix.normalize(posix.join(fromDir, pathPart)));

  if (targetRel === "docs" || targetRel === "docs/") {
    return `/docs/${suffix}`;
  }
  if (targetRel.startsWith("docs/")) {
    if (targetRel.endsWith(".md")) {
      if (!existsSync(join(root, fromPosix(targetRel)))) {
        throw new DocsSyncError(`missing docs target "${targetRel}" for "${url}" in ${sourceRel}`);
      }
      return `${routeForSource(targetRel)}${suffix}`;
    }
    throw new DocsSyncError(
      `unsupported docs directory link "${url}" in ${sourceRel}; link to a Markdown page or a repo file`,
    );
  }

  if (existsSync(join(root, fromPosix(targetRel)))) {
    if (!isAllowedRootPath(targetRel)) {
      throw new DocsSyncError(
        `local link "${url}" in ${sourceRel} points outside docs/ at ${targetRel}; add it to the allowlist or move it`,
      );
    }
    return githubUrl(targetRel, suffix, root);
  }

  throw new DocsSyncError(`missing link target "${targetRel}" for "${url}" in ${sourceRel}`);
}

/** Rewrite one link URL. Exported so the tests can exercise the rules without files. */
export function rewriteLink(url, sourceRel, root = DEFAULT_REPO_ROOT) {
  return resolveLink(url, sourceRel, root);
}

/** Resolve and (when writing) copy one image. Exported for tests. */
export function rewriteImage(url, sourceRel, root = DEFAULT_REPO_ROOT, copy = false) {
  if (isExternal(url) || url.startsWith("data:")) return url;
  const { path: pathPart, suffix } = splitSuffix(url);
  if (!pathPart || pathPart.startsWith("/")) return url;

  const fromDir = posix.dirname(sourceRel);
  const targetRel = assertInsideRepo(posix.normalize(posix.join(fromDir, pathPart)));
  const absolute = join(root, fromPosix(targetRel));
  if (!existsSync(absolute)) {
    throw new DocsSyncError(`missing image "${targetRel}" in ${sourceRel}`);
  }

  const docsRelative = targetRel.startsWith("docs/") ? targetRel.slice("docs/".length) : targetRel;
  if (copy) {
    const destination = join(PUBLIC_ROOT, "docs", fromPosix(docsRelative));
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(absolute, destination);
  }
  return `/docs/${docsRelative}${suffix}`;
}

function plainText(value) {
  return value.replace(/\s+/g, " ").trim();
}

function clampDescription(value) {
  if (value.length <= 160) return value;
  const slice = value.slice(0, 157);
  const lastSpace = slice.lastIndexOf(" ");
  return `${slice.slice(0, lastSpace > 80 ? lastSpace : 157).trim()}...`;
}

/** Extract the title/description and remove the H1 (Starlight renders it from frontmatter). */
export function extractTitleAndDescription(tree, sourceRel) {
  const headingIndex = tree.children.findIndex(
    (node) => node.type === "heading" && node.depth === 1,
  );
  if (headingIndex < 0) {
    throw new DocsSyncError(`missing H1 in ${sourceRel}`);
  }
  const heading = tree.children[headingIndex];
  const title = plainText(toString(heading));
  if (!title) throw new DocsSyncError(`empty H1 in ${sourceRel}`);

  const paragraph = tree.children
    .slice(headingIndex + 1)
    .find((node) => node.type === "paragraph" && plainText(toString(node)).length > 0);
  const rawDescription = paragraph ? plainText(toString(paragraph)) : "";
  const description = clampDescription(rawDescription || `${title} — Pi Desktop documentation.`);

  tree.children.splice(headingIndex, 1);
  return { title, description };
}

function escapeYaml(value) {
  return JSON.stringify(value);
}

export function buildFrontmatter({ title, description, sourceRel }) {
  return [
    "---",
    `title: ${escapeYaml(title)}`,
    `description: ${escapeYaml(description)}`,
    `editUrl: ${escapeYaml(`${REPO_URL}/edit/${SOURCE_BRANCH}/${sourceRel}`)}`,
    "---",
    "",
  ].join("\n");
}

function checkRawHtml(tree, sourceRel) {
  visit(tree, "html", (node) => {
    for (const match of node.value.matchAll(/\b(?:href|src)\s*=\s*["']([^"']+)["']/gi)) {
      const value = match[1] ?? "";
      if (!value || value.startsWith("#") || value.startsWith("/") || isExternal(value)) continue;
      throw new DocsSyncError(
        `raw HTML link "${value}" in ${sourceRel}; use a Markdown link so it can be rewritten`,
      );
    }
  });
}

function rewriteTree(tree, sourceRel, root, copyImages) {
  checkRawHtml(tree, sourceRel);
  visit(tree, "link", (node) => {
    node.url = resolveLink(node.url, sourceRel, root);
  });
  visit(tree, "image", (node) => {
    node.url = rewriteImage(node.url, sourceRel, root, copyImages);
  });
}

function parseMarkdown(body) {
  return unified().use(remarkParse).use(remarkGfm).parse(body);
}

function stringifyMarkdown(tree) {
  return unified()
    .use(remarkGfm)
    .use(remarkStringify, { fences: true, bullet: "-" })
    .stringify(tree);
}

function walkMarkdown(directory) {
  const result = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const absolute = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...walkMarkdown(absolute));
    else if (entry.isFile() && entry.name.endsWith(".md")) result.push(absolute);
  }
  return result;
}

function releaseDate(body) {
  return /\*\*Release date:\*\*\s*(\d{4}-\d{2}-\d{2})/.exec(body)?.[1] ?? null;
}

function semverCompare(left, right) {
  const parse = (value) => value.split(".").map((part) => Number.parseInt(part, 10) || 0);
  const a = parse(left);
  const b = parse(right);
  for (let index = 0; index < 3; index += 1) {
    if ((a[index] ?? 0) !== (b[index] ?? 0)) return (b[index] ?? 0) - (a[index] ?? 0);
  }
  return right.localeCompare(left);
}

function releaseVersion(sourceRel) {
  const match = /^docs\/releases\/v(.+)\.md$/.exec(sourceRel);
  return match?.[1] ?? null;
}

function resetGenerated(root) {
  for (const directory of GENERATED_DIRS) {
    rmSync(join(root, "src", "content", "docs", directory), { recursive: true, force: true });
  }
  rmSync(join(PUBLIC_ROOT, "docs"), { recursive: true, force: true });
}

function writeGeneratedDoc({ targetRel, frontmatter, body }) {
  mkdirSync(dirname(targetRel), { recursive: true });
  writeFileSync(targetRel, `${frontmatter}${body.trimEnd()}\n`, "utf8");
}

/**
 * Build the docs. When `validate` is true nothing is written; every source is
 * still parsed and every link/image is resolved so CI can fail before a build.
 */
export function syncDocs({ root = DEFAULT_REPO_ROOT, validate = false } = {}) {
  const docsRoot = join(root, "docs");
  if (!existsSync(docsRoot)) throw new DocsSyncError(`docs directory not found: ${docsRoot}`);

  const sources = walkMarkdown(docsRoot)
    .map((absolute) => repoRelative(root, absolute))
    .sort((left, right) => left.localeCompare(right));

  if (sources.length === 0) throw new DocsSyncError("no Markdown files found under docs/");

  let packageJson;
  try {
    packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  } catch (error) {
    throw new DocsSyncError(
      `cannot read package.json at ${root}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const generated = [];
  const routes = new Map();

  for (const sourceRel of sources) {
    const absolute = join(root, fromPosix(sourceRel));
    const body = readFileSync(absolute, "utf8");
    if (body.startsWith("---")) {
      throw new DocsSyncError(
        `${sourceRel} starts with frontmatter; docs/ must stay frontmatter-free`,
      );
    }

    const tree = parseMarkdown(body);
    const { title, description } = extractTitleAndDescription(tree, sourceRel);
    rewriteTree(tree, sourceRel, root, !validate);

    const route = routeForSource(sourceRel);
    if (routes.has(route)) {
      throw new DocsSyncError(`route collision ${route}: ${routes.get(route)} and ${sourceRel}`);
    }
    routes.set(route, sourceRel);

    const targetRel = targetForSource(sourceRel);
    const rendered = stringifyMarkdown(tree);
    const version = releaseVersion(sourceRel);
    generated.push({
      source: sourceRel,
      target: targetRel,
      route,
      title,
      description,
      version,
      date: releaseDate(body),
      frontmatter: buildFrontmatter({ title, description, sourceRel }),
      body: rendered,
    });
  }

  if (!validate) {
    resetGenerated(SITE_ROOT);
    for (const doc of generated) {
      writeGeneratedDoc({
        targetRel: join(root, fromPosix(doc.target)),
        frontmatter: doc.frontmatter,
        body: doc.body,
      });
    }
  }

  const releases = generated
    .filter((doc) => doc.version != null)
    .map((doc) => ({
      version: doc.version,
      title: doc.title,
      date: doc.date,
      route: doc.route,
      source: doc.source,
    }))
    .sort((left, right) => semverCompare(left.version, right.version));

  const manifest = {
    version: packageJson.version,
    site: { url: SITE_URL, basePath: BASE_PATH },
    repo: REPO,
    releases,
    docs: generated.map(({ source, target, route, title, description, version }) => ({
      source,
      target,
      route,
      title,
      description,
      version,
    })),
  };

  if (!validate) {
    mkdirSync(dirname(MANIFEST_PATH), { recursive: true });
    writeFileSync(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  }

  return manifest;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const validate = process.argv.includes("--validate");
  try {
    const manifest = syncDocs({ validate });
    console.log(
      `${validate ? "validated" : "wrote"} ${manifest.docs.length} docs, ${manifest.releases.length} releases (v${manifest.version})`,
    );
  } catch (error) {
    console.error(`sync-docs: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
