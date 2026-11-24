/**
 * Stage the pinned Workflow bundle into the app (plan step 26).
 *
 *   npm run workflow:stage -- --tarball ../path/dieulc-workflow-0.13.0.tgz
 *   npm run workflow:stage                       # fetch the pinned release URL
 *   npm run workflow:stage -- --offline          # pinned local tarball only
 *   npm run workflow:lock  -- --tarball <file>   # record a new pin
 *
 * Inputs are accepted only in two shapes:
 *
 *  - `--tarball <file>` — a locally supplied W tarball. It must hash to the
 *    `source.integrity` in `resources/workflow.lock.json` and its per-file
 *    hashes must match `files[]`; a rebuilt artifact with one changed module is
 *    refused.
 *  - no `--tarball` — the explicitly pinned release artifact is fetched from
 *    `source.url`. `--offline` (or a missing network) is a hard failure, never
 *    a silent fallback to a developer checkout.
 *
 * The filename is *not* trusted: npm tarball names are not stable enough to
 * identify a build, so identity is the sha512 integrity plus the per-file
 * manifest.
 *
 * Two copies are written, because the app loads one from each layout:
 *
 *   resources/extensions/workflow  packaged `extraResources` (`extensions/…`)
 *   out/extensions/workflow        unpacked host-build sibling (`asarUnpack`)
 *
 * Staging is atomic per target (temp dir -> rename) and is intended to run
 * *after* the host build has cleaned `out/`. Nothing here publishes, tags or
 * bumps a version.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  BUNDLE_METADATA_FILE,
  WORKFLOW_DEV_STAGE_DIR,
  WORKFLOW_LOCK_FILE,
  WORKFLOW_STAGE_DIR,
  buildBundleMetadata,
  buildWorkflowLock,
  checkStagedFiles,
  compareTarballToLock,
  extractTarball,
  findForeignSpecifiers,
  findMissingPackedImports,
  sanitizeWorkflowManifest,
  sha512Integrity,
  validatePackedFiles,
  validateWorkflowLock,
  validateWorkflowManifest,
} from "./workflow-bundle.mjs";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = resolve(SCRIPT_DIR, "..");
const RELEASE_BASE = "https://github.com/dieuluucanh/pi-workflow/releases/download";

const HELP = `Stage the pinned Workflow bundle

  node scripts/stage-workflow-bundle.mjs [flags]

  --root <dir>          repository root (default: this checkout)
  --tarball <file>      locally supplied @dieulc/workflow tarball to verify
  --release             explicit alias for "fetch the pinned release artifact"
  --offline             refuse any network access
  --update-lock         rewrite the lock from --tarball (records a new pin)
  --source-kind <kind>  with --update-lock: "release" (default) or "tarball"
  --source-path <path>  with --source-kind tarball: repo-relative tarball path
  --release-url <url>   with --update-lock: the pinned release asset URL
  --tag <tag>           with --update-lock: the release tag (default v<version>)
  --no-dev              skip the unpacked out/ copy
  --keep-old            leave the previous stage dirs in place on failure
  --json                machine-readable summary
  --help                this text
`;

function fail(message) {
  throw new Error(message);
}

export function parseArgs(argv = []) {
  const options = {
    root: DEFAULT_ROOT,
    tarball: null,
    release: false,
    offline: false,
    updateLock: false,
    sourceKind: "release",
    sourcePath: null,
    releaseUrl: null,
    tag: null,
    dev: true,
    keepOld: false,
    json: false,
    help: false,
  };
  const value = (index, flag) => {
    const next = argv[index];
    if (typeof next !== "string" || next.startsWith("--")) fail(`${flag} needs a value`);
    return next;
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--root") options.root = resolve(value(++index, arg));
    else if (arg === "--tarball") options.tarball = resolve(value(++index, arg));
    else if (arg === "--release") options.release = true;
    else if (arg === "--offline") options.offline = true;
    else if (arg === "--update-lock") options.updateLock = true;
    else if (arg === "--source-kind") {
      const kind = value(++index, arg);
      if (kind !== "release" && kind !== "tarball")
        fail('--source-kind must be "release" or "tarball"');
      options.sourceKind = kind;
    } else if (arg === "--source-path") options.sourcePath = value(++index, arg);
    else if (arg === "--release-url") options.releaseUrl = value(++index, arg);
    else if (arg === "--tag") options.tag = value(++index, arg);
    else if (arg === "--no-dev") options.dev = false;
    else if (arg === "--keep-old") options.keepOld = true;
    else if (arg === "--json") options.json = true;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else fail(`unknown argument: ${arg}`);
  }
  return options;
}

function readJson(file) {
  // A synchronous read keeps argument/lock parsing before the first await.
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    fail(
      `cannot read JSON from ${file}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function listFiles(root) {
  const out = [];
  const walk = (dir, prefix) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(join(dir, entry.name), relative);
      else out.push(relative);
    }
  };
  walk(root, "");
  return out.sort();
}

async function fetchPinned(lock, options) {
  if (options.offline) {
    fail(
      "offline staging needs --tarball: the pinned release artifact would have to be fetched from " +
        `${lock.source.url}`,
    );
  }
  let response;
  try {
    response = await fetch(lock.source.url, { redirect: "follow" });
  } catch (error) {
    fail(
      `cannot fetch the pinned artifact ${lock.source.url}: ` +
        `${error instanceof Error ? error.message : String(error)} (use --tarball for an offline build)`,
    );
  }
  if (!response.ok) fail(`the pinned artifact ${lock.source.url} returned HTTP ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

async function readArtifact(options, lock) {
  if (options.tarball) {
    if (!existsSync(options.tarball)) fail(`the tarball does not exist: ${options.tarball}`);
    return readFile(options.tarball);
  }
  if (!lock) fail("no lock file: pass --tarball with --update-lock to record a pin first");
  if (lock.source.kind === "tarball") {
    const local = join(options.root, lock.source.path);
    if (!existsSync(local)) {
      fail(
        `the lock pins a local tarball at ${lock.source.path}, but ${local} does not exist ` +
          "(pass --tarball with the verified artifact)",
      );
    }
    return readFile(local);
  }
  return fetchPinned(lock, options);
}

function sourceForUpdate(options, tarballPath, manifest) {
  const tarball = basename(tarballPath ?? `dieulc-workflow-${manifest.version}.tgz`);
  if (options.sourceKind === "tarball") {
    const path = options.sourcePath ?? join("resources", "workflow", tarball).replace(/\\/g, "/");
    return { kind: "tarball", tarball, path, integrity: null };
  }
  const tag = options.tag ?? `v${manifest.version}`;
  const url = options.releaseUrl ?? `${RELEASE_BASE}/${tag}/${tarball}`;
  return { kind: "release", tarball, url, tag, integrity: null };
}

function stagedEntries(files, sanitizedManifest) {
  const staged = new Map(files);
  staged.set("package.json", Buffer.from(`${JSON.stringify(sanitizedManifest, null, 2)}\n`));
  return staged;
}

function readMap(map) {
  return (file) => {
    const value = map.get(file);
    if (!value) fail(`internal: the staged map has no ${file}`);
    return value;
  };
}

async function writeTarget(target, entries) {
  const parent = dirname(target);
  await mkdir(parent, { recursive: true });
  const temp = await mkdtemp(join(parent, `.${basename(target)}.tmp-`));
  try {
    for (const [file, buffer] of entries) {
      const destination = join(temp, file);
      await mkdir(dirname(destination), { recursive: true });
      await writeFile(destination, buffer);
    }
    await rm(target, { recursive: true, force: true });
    await rename(temp, target);
  } catch (error) {
    await rm(temp, { recursive: true, force: true });
    throw error;
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(HELP);
    return 0;
  }

  const lockPath = join(options.root, WORKFLOW_LOCK_FILE);
  const lockExisted = existsSync(lockPath);
  let lock = lockExisted ? readJson(lockPath) : null;

  if (!options.updateLock) {
    if (!lock) fail(`no lock at ${lockPath}; record one with --update-lock --tarball <file>`);
    const lockErrors = validateWorkflowLock(lock);
    if (lockErrors.length > 0) {
      fail(`the lock is invalid:\n  - ${lockErrors.join("\n  - ")}`);
    }
  }

  const buffer = await readArtifact(options, lock);

  if (options.updateLock) {
    const files = extractTarball(buffer);
    const packedErrors = validatePackedFiles([...files.keys()]);
    if (packedErrors.length > 0)
      fail(`the tarball is not stageable:\n  - ${packedErrors.join("\n  - ")}`);
    const manifest = JSON.parse(files.get("package.json").toString("utf8"));
    const source = sourceForUpdate(options, options.tarball, manifest);
    const next = buildWorkflowLock({ buffer, manifest, files, source });
    const nextErrors = validateWorkflowLock(next);
    if (nextErrors.length > 0)
      fail(`the generated lock is invalid:\n  - ${nextErrors.join("\n  - ")}`);
    const manifestErrors = validateWorkflowManifest(manifest, next, { allowScripts: true });
    if (manifestErrors.length > 0) {
      fail(`the tarball is not stageable:\n  - ${manifestErrors.join("\n  - ")}`);
    }
    const missing = findMissingPackedImports(files.keys(), readMap(files));
    if (missing.length > 0) {
      fail(
        `the tarball has imports that are not packed:\n  - ` +
          missing.map(({ from, specifier }) => `${from} imports ${specifier}`).join("\n  - "),
      );
    }
    const foreign = findForeignSpecifiers(files.keys(), readMap(files));
    if (foreign.length > 0) {
      fail(
        `the tarball imports packages the host does not provide:\n  - ` +
          foreign.map(({ from, specifier }) => `${from} imports ${specifier}`).join("\n  - "),
      );
    }
    const tempLock = `${lockPath}.${process.pid}.tmp`;
    await writeFile(tempLock, `${JSON.stringify(next, null, 2)}\n`);
    await rm(lockPath, { force: true });
    await rename(tempLock, lockPath);
    lock = next;
  }

  const errors = compareTarballToLock(buffer, lock);
  if (errors.length > 0) {
    fail(`the artifact does not match the pinned metadata:\n  - ${errors.join("\n  - ")}`);
  }

  const files = extractTarball(buffer);
  const manifest = JSON.parse(files.get("package.json").toString("utf8"));
  const { manifest: sanitized } = sanitizeWorkflowManifest(manifest);
  const staged = stagedEntries(files, sanitized);
  const stagedRead = readMap(staged);
  const sourceRead = readMap(files);

  const closure = findMissingPackedImports(staged.keys(), stagedRead);
  if (closure.length > 0) {
    fail(
      `the bundle has imports that are not packed:\n  - ` +
        closure.map(({ from, specifier }) => `${from} imports ${specifier}`).join("\n  - "),
    );
  }
  const foreign = findForeignSpecifiers(staged.keys(), stagedRead);
  if (foreign.length > 0) {
    fail(
      `the bundle imports packages the host does not provide:\n  - ` +
        foreign.map(({ from, specifier }) => `${from} imports ${specifier}`).join("\n  - "),
    );
  }

  const metadata = buildBundleMetadata({
    lock,
    manifest,
    sourceFiles: files.keys(),
    stagedFiles: staged.keys(),
    sourceRead,
    stagedRead,
  });
  metadata.generatedAt = new Date().toISOString();
  metadata.generator = "scripts/stage-workflow-bundle.mjs";
  const metadataText = `${JSON.stringify(metadata, null, 2)}\n`;
  const withMetadata = new Map(staged);
  withMetadata.set(BUNDLE_METADATA_FILE, Buffer.from(metadataText));

  const targets = [WORKFLOW_STAGE_DIR, ...(options.dev ? [WORKFLOW_DEV_STAGE_DIR] : [])];
  for (const relative of targets) {
    const target = join(options.root, relative);
    try {
      await writeTarget(target, withMetadata);
    } catch (error) {
      if (!options.keepOld) await rm(target, { recursive: true, force: true });
      throw error;
    }
    const stageErrors = checkStagedFiles({
      lock,
      metadata,
      exists: (file) => existsSync(join(target, file)),
      read: (file) => readFileSync(join(target, file), "utf8"),
      list: () => listFiles(target),
    });
    if (stageErrors.length > 0) {
      fail(
        `the staged copy at ${relative} failed its own check:\n  - ${stageErrors.join("\n  - ")}`,
      );
    }
  }

  const summary = {
    package: lock.package,
    version: lock.version,
    integrity: sha512Integrity(buffer),
    source: lock.source,
    files: metadata.files.length,
    hostPeers: lock.hostPeers,
    targets,
    removedScripts: metadata.removedScripts,
  };
  if (options.json) {
    process.stdout.write(`${JSON.stringify(summary)}\n`);
  } else {
    process.stdout.write(
      `stage-workflow-bundle: ${lock.package}@${lock.version} (${metadata.files.length} files)\n`,
    );
    process.stdout.write(`  integrity ${summary.integrity}\n`);
    for (const target of targets) process.stdout.write(`  staged ${target}\n`);
  }
  return 0;
}

const isMain =
  process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;

if (isMain) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      process.stderr.write(
        `stage-workflow-bundle: ${error instanceof Error ? error.message : String(error)}\n`,
      );
      process.exitCode = 1;
    });
}

export { main };
