/**
 * Generate the 1200×630 social preview image. Kept as a script and committed
 * output so the site build never needs a font or image service.
 */

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const SITE_ROOT = resolve(SCRIPT_DIR, "..");
const REPO_ROOT = resolve(SITE_ROOT, "..");
const logo = readFileSync(join(REPO_ROOT, "assets", "pi-desktop-icon.svg")).toString("base64");

const svg = `
<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
  <rect width="1200" height="630" fill="#FDFBF3"/>
  <rect x="0" y="0" width="18" height="630" fill="#0A3D9C"/>
  <image href="data:image/svg+xml;base64,${logo}" x="72" y="70" width="120" height="120"/>
  <text x="72" y="300" font-family="Georgia, 'Times New Roman', serif" font-size="92" font-weight="700" fill="#0A3D9C">Pi Desktop</text>
  <text x="76" y="372" font-family="Georgia, 'Times New Roman', serif" font-size="34" fill="#14213D">The Pi coding agent, without the terminal.</text>
  <text x="76" y="490" font-family="Arial, Helvetica, sans-serif" font-size="24" fill="#5C6478">Projects · Sessions · Editor · Providers · Extensions · Checkpoints</text>
  <rect x="76" y="548" width="250" height="4" fill="#D9A00A"/>
  <text x="76" y="592" font-family="Arial, Helvetica, sans-serif" font-size="22" fill="#5C6478">dieuluucanh.github.io/pi-desktop</text>
</svg>`;

await sharp(Buffer.from(svg))
  .png()
  .toFile(join(SITE_ROOT, "public", "og.png"));
console.log("gen-og: wrote public/og.png (1200x630)");
