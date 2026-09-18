/**
 * Keeps the vendored Office add-in manifest in sync with pi-for-office.
 *
 * The app ships a copy of `manifest.prod.xml` so sideloading works offline.
 * Run this after the upstream manifest changes (it verifies the add-in id and
 * records a hash so drift is detectable).
 *
 *   node scripts/sync-office-manifest.mjs                     # copy from a local checkout
 *   node scripts/sync-office-manifest.mjs --fetch             # download the canonical copy
 *   node scripts/sync-office-manifest.mjs --check             # verify only (CI)
 *   node scripts/sync-office-manifest.mjs --source <path|url>
 */

import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TARGET = path.join(REPO_ROOT, "resources", "office", "manifest.prod.xml");
const LOCK = path.join(REPO_ROOT, "resources", "office", "manifest.lock.json");
const FETCH_URL =
  "https://raw.githubusercontent.com/dieuluucanh/pi-for-office/main/packages/add-in/manifest.prod.xml";
const DEFAULT_LOCAL_SOURCES = [
  path.resolve(REPO_ROOT, "..", "pi-for-office", "packages", "add-in", "manifest.prod.xml"),
  path.resolve(REPO_ROOT, "..", "..", "pi-for-office", "packages", "add-in", "manifest.prod.xml"),
];
const EXPECTED_ADDIN_ID = "bc61caf2-821a-47fd-9d6a-9d96c8f852fe";

function args() {
  const out = { fetch: false, check: false, source: null };
  const argv = process.argv.slice(2);
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--fetch") out.fetch = true;
    else if (arg === "--check") out.check = true;
    else if (arg === "--source") out.source = argv[++index] ?? null;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return out;
}

function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

function assertPiForOffice(text, origin) {
  const id = /<Id>\s*([^<\s]+)\s*<\/Id>/i.exec(text)?.[1]?.replace(/[{}]/g, "").toLowerCase();
  if (id !== EXPECTED_ADDIN_ID) {
    throw new Error(`Refusing to vendor ${origin}: unexpected add-in id ${id ?? "(none)"}`);
  }
  const hasTaskPane = text.includes("pi-for-office/src/taskpane.html");
  if (!hasTaskPane) {
    throw new Error(`Refusing to vendor ${origin}: task pane URL does not look like pi-for-office`);
  }
}

async function readSource(options) {
  const explicit = options.source;
  if (explicit && /^https?:\/\//i.test(explicit)) {
    const response = await fetch(explicit);
    if (!response.ok) throw new Error(`GET ${explicit} failed: ${response.status}`);
    return { text: await response.text(), origin: explicit };
  }
  if (explicit) {
    return { text: await readFile(explicit, "utf8"), origin: explicit };
  }
  if (options.fetch) {
    const response = await fetch(FETCH_URL);
    if (!response.ok) throw new Error(`GET ${FETCH_URL} failed: ${response.status}`);
    return { text: await response.text(), origin: FETCH_URL };
  }
  const local = DEFAULT_LOCAL_SOURCES.find((candidate) => existsSync(candidate));
  if (!local) {
    throw new Error(
      `No local pi-for-office checkout found. Pass --source <path|url> or --fetch.\nChecked:\n- ${DEFAULT_LOCAL_SOURCES.join("\n- ")}`,
    );
  }
  return { text: await readFile(local, "utf8"), origin: local };
}

const options = args();

async function main() {
  if (options.check) {
    const [text, lockText] = await Promise.all([readFile(TARGET, "utf8"), readFile(LOCK, "utf8")]);
    const lock = JSON.parse(lockText);
    const actual = sha256(text);
    assertPiForOffice(text, TARGET);
    if (actual !== lock.sha256) {
      throw new Error(`Vendored manifest hash drifted: lock=${lock.sha256} actual=${actual}`);
    }
    console.log(`manifest OK (${actual}, ${lock.bytes} bytes)`);
    return;
  }

  const { text, origin } = await readSource(options);
  assertPiForOffice(text, origin);
  await mkdir(path.dirname(TARGET), { recursive: true });
  if (existsSync(TARGET) && !options.source && !options.fetch) {
    await copyFile(TARGET, `${TARGET}.prev`);
  }
  await writeFile(TARGET, text, "utf8");
  const lock = {
    source: FETCH_URL,
    resolvedFrom: origin,
    sha256: sha256(text),
    bytes: Buffer.byteLength(text),
    syncedAt: new Date().toISOString(),
  };
  await writeFile(LOCK, `${JSON.stringify(lock, null, 2)}\n`, "utf8");
  console.log(`synced ${origin}\n  -> ${TARGET}\n  sha256 ${lock.sha256} (${lock.bytes} bytes)`);
}

await main();
