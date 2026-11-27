import { mkdirSync, readdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import sharp from "sharp";

const ROOT = resolve(import.meta.dirname, "..", "..");
const RAW = join(ROOT, "test-results", "site-screenshots");
const OUT = join(ROOT, "site", "src", "assets", "screenshots");

const NAMES = ["welcome", "session", "editor", "settings", "source-control", "grid"];

if (!readdirSync(RAW, { withFileTypes: true }).some((entry) => entry.isFile())) {
  throw new Error(`no raw screenshots in ${RAW}; run npm run site:screenshots first`);
}
mkdirSync(OUT, { recursive: true });

for (const name of NAMES) {
  const from = join(RAW, `${name}.png`);
  const to = join(OUT, `${name}.webp`);
  await sharp(from)
    .resize({ width: 2400, height: 1500, fit: "inside", withoutEnlargement: true })
    .webp({ quality: 82, effort: 5 })
    .toFile(to);
  console.log(`optimized ${name}.webp`);
}

// Keep only the six committed assets; a stale capture should not silently ship.
for (const entry of readdirSync(OUT)) {
  if (entry.endsWith(".webp") && !NAMES.includes(entry.replace(/\.webp$/, ""))) {
    rmSync(join(OUT, entry));
  }
}
