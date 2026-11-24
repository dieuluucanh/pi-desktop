/**
 * Verify a staged Workflow bundle (plan step 26).
 *
 *   npm run workflow:verify
 *   node scripts/verify-workflow-bundle.mjs --tarball <file.tgz> --offline
 *
 * What it proves about `resources/extensions/workflow` (and the unpacked
 * `out/extensions/workflow` copy when present):
 *
 *  1. the lock and the recorded metadata describe the same bytes;
 *  2. every staged file matches its recorded `sha256` — a stale or partially
 *     overwritten build is a failure, not a warning;
 *  3. every relative import (static or dynamic) resolves to another staged
 *     file, and every bare import is a Node builtin or a declared host peer;
 *  4. the staged manifest carries no runtime dependencies and no install-time
 *     lifecycle scripts;
 *  5. LICENSE/README travel with the artifact, and no developer-checkout path
 *     was baked into it;
 *  6. the artifact loads under the **bundled Node** from an isolated temp copy
 *     with the host peers linked in — offline, with the developer checkout
 *     absent from every search path;
 *  7. optionally, a supplied tarball still matches the pinned integrity.
 *
 * It never writes to the repository, tags, publishes or bumps a version.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  BUNDLE_LICENSE_FILES,
  BUNDLE_METADATA_FILE,
  WORKFLOW_DEV_STAGE_DIR,
  WORKFLOW_ENTRY,
  WORKFLOW_LOCK_FILE,
  WORKFLOW_STAGE_DIR,
  checkStagedFiles,
  compareTarballToLock,
  findCheckoutReferences,
  findForeignSpecifiers,
  findMissingPackedImports,
  isValidMetadata,
  validateBundleMetadata,
  validateWorkflowLock,
  validateWorkflowManifest,
} from "./workflow-bundle.mjs";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = resolve(SCRIPT_DIR, "..");

const HELP = `Verify a staged Workflow bundle

  node scripts/verify-workflow-bundle.mjs [flags]

  --root <dir>     repository root (default: this checkout)
  --tarball <file> additionally verify a supplied tarball against the lock
  --offline        assert that no network is required (always true here)
  --require-dev    require the unpacked out/ copy as well
  --node <file>    Node binary for the load probe (default: bundled, then current)
  --json           machine-readable report
  --help           this text
`;

export function parseArgs(argv = []) {
  const options = {
    root: DEFAULT_ROOT,
    tarball: null,
    offline: false,
    requireDev: false,
    node: null,
    json: false,
    help: false,
  };
  const value = (index, flag) => {
    const next = argv[index];
    if (typeof next !== "string" || next.startsWith("--")) {
      throw new Error(`${flag} needs a value`);
    }
    return next;
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--root") options.root = resolve(value(++index, arg));
    else if (arg === "--tarball") options.tarball = resolve(value(++index, arg));
    else if (arg === "--offline") options.offline = true;
    else if (arg === "--require-dev") options.requireDev = true;
    else if (arg === "--node") options.node = resolve(value(++index, arg));
    else if (arg === "--json") options.json = true;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return options;
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(
      `cannot read JSON from ${file}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
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

/** The bundled Node for this platform, when the runtime has been fetched. */
export function bundledNodePath(root) {
  const platform = `${process.platform}-${process.arch}`;
  const candidates = [
    join(
      root,
      "resources",
      "runtime",
      "node",
      platform,
      "bin",
      process.platform === "win32" ? "node.exe" : "node",
    ),
    join(root, "resources", "runtime", "node", platform, "node.exe"),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

function readMapFromDir(dir) {
  return (file) => readFileSync(join(dir, file), "utf8");
}

/**
 * Copy the staged bundle into a temp directory and load its entry with the
 * given Node. The temp `node_modules` is a junction/symlink to the *host*
 * peers only: no Workflow checkout, no repository-relative fallback.
 */
export async function probeOfflineLoad({ stageDir, files, nodePath, root, timeoutMs = 60_000 }) {
  const tempRoot = await mkdtemp(join(tmpdir(), "pi-workflow-load-"));
  const modulesLink = join(tempRoot, "node_modules");
  try {
    for (const file of files) {
      const destination = join(tempRoot, file);
      await mkdir(dirname(destination), { recursive: true });
      await copyFile(join(stageDir, file), destination);
    }
    const hostModules = join(root, "node_modules");
    if (existsSync(hostModules)) {
      await symlink(hostModules, modulesLink, process.platform === "win32" ? "junction" : "dir");
    }
    const entry = pathToFileURL(join(tempRoot, WORKFLOW_ENTRY)).href;
    const code =
      `const module = await import(${JSON.stringify(entry)});` +
      `if (typeof module.default !== "function") { throw new Error("the Workflow entry has no default factory"); }`;
    const env = { ...process.env };
    delete env.NODE_PATH;
    delete env.NODE_OPTIONS;
    for (const key of Object.keys(env)) {
      if (key.startsWith("PI_")) delete env[key];
    }
    env.NODE_ENV = "production";
    const result = spawnSync(
      nodePath,
      ["--no-warnings", "--experimental-strip-types", "--input-type=module", "-e", code],
      { cwd: tempRoot, encoding: "utf8", timeout: timeoutMs, env },
    );
    if (result.status !== 0) {
      const tail = `${result.stdout ?? ""}\n${result.stderr ?? ""}`
        .trim()
        .split(/\r?\n/)
        .slice(-12)
        .join("\n");
      return [`the packed artifact does not load under ${nodePath}:\n${tail}`];
    }
    return [];
  } finally {
    try {
      // Remove the junction before the tree so Windows never follows it.
      await rm(modulesLink, { force: true });
    } catch {
      // No link was created (a checkout without node_modules).
    }
    await rm(tempRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
}

function resolveHostPeers(root, lock, errors) {
  // Check the install path directly: the Pi SDK family publishes ESM-only
  // `exports`, so a CommonJS `require.resolve` is not a reliable presence test.
  for (const peer of lock.hostPeers ?? []) {
    const manifest = join(root, "node_modules", ...peer.split("/"), "package.json");
    if (!existsSync(manifest)) {
      errors.push(
        `host peer ${peer} is not installed at the app root (${join(root, "node_modules")})`,
      );
    }
  }
}

/**
 * Verify one staged copy. Exported so the packaging tests can run the exact
 * gate against a fixture tree without spawning the CLI.
 */
export async function verifyStagedCopy({
  root,
  lock,
  stageDir,
  label,
  nodePath,
  requireLoad = true,
}) {
  const errors = [];
  if (!existsSync(stageDir)) return [`${label}: the staged bundle does not exist at ${stageDir}`];

  const metadataPath = join(stageDir, BUNDLE_METADATA_FILE);
  if (!existsSync(metadataPath)) return [`${label}: ${BUNDLE_METADATA_FILE} is missing`];
  let metadata;
  try {
    metadata = readJson(metadataPath);
  } catch (error) {
    return [`${label}: ${error instanceof Error ? error.message : String(error)}`];
  }
  if (!isValidMetadata(metadata))
    errors.push(`${label}: ${BUNDLE_METADATA_FILE} is not a bundle document`);

  const files = listFiles(stageDir);
  const read = readMapFromDir(stageDir);
  const exists = (file) => existsSync(join(stageDir, file));
  errors.push(...validateBundleMetadata(metadata, lock).map((error) => `${label}: ${error}`));
  errors.push(
    ...checkStagedFiles({ lock, metadata, exists, read, list: () => files }).map(
      (error) => `${label}: ${error}`,
    ),
  );

  const stagedManifest = exists("package.json") ? readJson(join(stageDir, "package.json")) : null;
  if (stagedManifest) {
    errors.push(
      ...validateWorkflowManifest(stagedManifest, lock).map((error) => `${label}: ${error}`),
    );
    const lifecycle = stagedManifest.scripts ? Object.keys(stagedManifest.scripts) : [];
    if (lifecycle.length > 0) {
      errors.push(`${label}: the staged manifest carries scripts (${lifecycle.join(", ")})`);
    }
  }

  const bundleFiles = files.filter((file) => file !== BUNDLE_METADATA_FILE);
  errors.push(
    ...findMissingPackedImports(bundleFiles, read).map(
      ({ from, specifier }) => `${label}: ${from} imports ${specifier}, which is not in the bundle`,
    ),
  );
  errors.push(
    ...findForeignSpecifiers(bundleFiles, read).map(
      ({ from, specifier }) => `${label}: ${from} imports ${specifier}, which is not a host peer`,
    ),
  );
  for (const license of BUNDLE_LICENSE_FILES) {
    if (!exists(license)) errors.push(`${label}: the bundle is missing ${license}`);
    else if (read(license).trim().length === 0) errors.push(`${label}: ${license} is empty`);
  }
  errors.push(
    ...findCheckoutReferences(bundleFiles, read, [root, process.cwd()]).map(
      ({ file, needle }) => `${label}: ${file} contains a checkout path (${needle})`,
    ),
  );
  for (const file of bundleFiles) {
    if (!/\.(?:ts|mts|cts|js|mjs|cjs|json|md|txt)$/.test(file)) continue;
    if (read(file).includes("\0")) errors.push(`${label}: ${file} contains a NUL byte`);
  }

  if (requireLoad && errors.length === 0) {
    errors.push(...(await probeOfflineLoad({ stageDir, files: bundleFiles, nodePath, root })));
  }
  return errors;
}

export async function verifyBundle(options = {}) {
  const root = options.root ? resolve(options.root) : DEFAULT_ROOT;
  const errors = [];
  const lockPath = join(root, WORKFLOW_LOCK_FILE);
  if (!existsSync(lockPath)) {
    return { errors: [`the lock is missing at ${lockPath}`], lock: null, targets: [] };
  }
  const lock = readJson(lockPath);
  errors.push(...validateWorkflowLock(lock).map((error) => `lock: ${error}`));
  if (errors.length > 0) return { errors, lock, targets: [] };

  resolveHostPeers(root, lock, errors);

  const nodePath = options.node ?? bundledNodePath(root) ?? process.execPath;
  const targets = [WORKFLOW_STAGE_DIR];
  if (options.requireDev || existsSync(join(root, WORKFLOW_DEV_STAGE_DIR))) {
    targets.push(WORKFLOW_DEV_STAGE_DIR);
  }
  for (const relative of targets) {
    errors.push(
      ...(await verifyStagedCopy({
        root,
        lock,
        stageDir: join(root, relative),
        label: relative,
        nodePath,
        requireLoad: options.load !== false,
      })),
    );
  }

  if (options.tarball) {
    if (!existsSync(options.tarball)) {
      errors.push(`the supplied tarball does not exist: ${options.tarball}`);
    } else {
      errors.push(...compareTarballToLock(await readFile(options.tarball), lock));
    }
  }

  if (options.offline) {
    // The verification itself never fetches. Assert that the lock's local
    // source shape is usable offline when it claims to be local.
    if (lock.source.kind === "tarball" && !existsSync(join(root, lock.source.path))) {
      errors.push(`offline verification needs the pinned local tarball at ${lock.source.path}`);
    }
  }

  return { errors, lock, targets, nodePath };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(HELP);
    return 0;
  }
  const result = await verifyBundle(options);
  if (options.json) {
    process.stdout.write(
      `${JSON.stringify({
        ok: result.errors.length === 0,
        version: result.lock?.version ?? null,
        targets: result.targets,
        node: result.nodePath ?? null,
        errors: result.errors,
      })}\n`,
    );
  } else if (result.errors.length === 0) {
    process.stdout.write(
      `verify-workflow-bundle: ${result.lock.package}@${result.lock.version} ok ` +
        `(${result.targets.length} staged copy/copies, node ${result.nodePath})\n`,
    );
  } else {
    process.stderr.write("verify-workflow-bundle: the staged bundle is not ship-ready\n");
    for (const error of result.errors) process.stderr.write(`  - ${error}\n`);
  }
  return result.errors.length === 0 ? 0 : 1;
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
        `verify-workflow-bundle: ${error instanceof Error ? error.message : String(error)}\n`,
      );
      process.exitCode = 1;
    });
}

export { main };
