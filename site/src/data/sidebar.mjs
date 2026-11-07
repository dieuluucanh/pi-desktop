import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DOCS_INDEX_SOURCE, NAV_GROUPS } from "./nav.mjs";

const manifestPath = new URL("./site.generated.json", import.meta.url);
let manifest;
try {
  manifest = JSON.parse(readFileSync(fileURLToPath(manifestPath), "utf8"));
} catch (error) {
  const detail = error instanceof Error ? error.message : String(error);
  throw new Error(
    `site/data/site.generated.json is missing or invalid; run \`npm run site:sync\` first (${detail})`,
    { cause: error },
  );
}

const bySource = new Map(manifest.docs.map((doc) => [doc.source, doc]));

function slugForSource(source) {
  const doc = bySource.get(source);
  if (!doc) {
    throw new Error(`navigation names a doc that was not generated: ${source}`);
  }
  // Starlight sidebar slugs are content IDs, not public routes. Keep `index`
  // for the docs landing page and the dots in `releases/v0.7.3`.
  return doc.target.replace(/^site\/src\/content\/docs\//, "").replace(/\.md$/, "");
}

function itemForSource(source) {
  const doc = bySource.get(source);
  if (!doc) throw new Error(`navigation names a doc that was not generated: ${source}`);
  return { label: doc.title, slug: slugForSource(source) };
}

export const sidebar = [
  {
    label: "Documentation",
    items: [
      { label: "Documentation index", slug: slugForSource(DOCS_INDEX_SOURCE) },
      ...NAV_GROUPS.map((group) => ({
        label: group.label,
        items: group.sources.map(itemForSource),
      })),
    ],
  },
  {
    label: "Release notes",
    items: manifest.releases.map((release) => ({
      label: `v${release.version}`,
      slug: `releases/v${release.version}`,
      ...(release.version === manifest.version
        ? { badge: { text: "latest", variant: "tip" } }
        : {}),
    })),
  },
  {
    label: "Legal",
    items: [{ label: "Privacy", link: "/privacy/" }],
  },
];
