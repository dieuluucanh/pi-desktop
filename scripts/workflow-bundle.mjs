/**
 * The pinned Workflow bundle: facts and pure helpers (plan step 26).
 *
 * Desktop ships the Workflow extension inside `resources/extensions/workflow`,
 * staged from a **verified** `@dieulc/workflow` tarball. The same rules are
 * applied by the staging tool, the verification gate and the tests, so a bundle
 * can never be built against one identity and checked against another:
 *
 *  - the tarball must hash to the pinned `sha512` integrity in
 *    `resources/workflow.lock.json`;
 *  - every packed file's `sha256` is pinned, so an extra/omitted module is a
 *    failure even when the tarball hash matches a previously recorded lock;
 *  - the bundle may import only Node builtins, its own packed files, and the
 *    host peers Desktop already installs (the Pi SDK family + `typebox`);
 *  - it must carry no runtime `dependencies` and no install-time lifecycle
 *    scripts, because nothing may execute when the app starts;
 *  - relative (including dynamic relative) imports and non-code assets are
 *    retained verbatim — the artifact is loaded by the bundled Node's
 *    TypeScript type stripping, not re-bundled.
 *
 * Everything here is pure: `node:*` imports only, no network, no subprocess,
 * no filesystem writes. The CLIs are `stage-workflow-bundle.mjs` and
 * `verify-workflow-bundle.mjs`.
 *
 * Invoked as `node scripts/…`; no shebang so the Vitest module runner can
 * import it on a CRLF checkout.
 */

import { createHash } from "node:crypto";
import { builtinModules } from "node:module";
import { posix } from "node:path";
import { gunzipSync } from "node:zlib";

export const WORKFLOW_PACKAGE_NAME = "@dieulc/workflow";
export const WORKFLOW_ENTRY = "index.ts";
export const WORKFLOW_LOCK_FILE = "resources/workflow.lock.json";
/** Packaged copy: `extraResources` maps `resources/extensions` -> `extensions`. */
export const WORKFLOW_STAGE_DIR = "resources/extensions/workflow";
/** Unpacked copy written after the host build cleans `out/` (`asarUnpack` covers it). */
export const WORKFLOW_DEV_STAGE_DIR = "out/extensions/workflow";
export const BUNDLE_METADATA_FILE = "workflow-bundle.json";
export const BUNDLE_LICENSE_FILES = ["LICENSE", "README.md"];
export const REQUIRED_BUNDLE_FILES = ["package.json", WORKFLOW_ENTRY, ...BUNDLE_LICENSE_FILES];
export const HOST_PEER_PREFIX = "@earendil-works/";
export const HOST_PEER_EXTRA = ["typebox"];
export const LIFECYCLE_SCRIPTS = [
  "preinstall",
  "install",
  "postinstall",
  "prepare",
  "prepublish",
  "prepublishOnly",
];
export const BUNDLE_SCHEMA = 1;

const BUILTINS = new Set([...builtinModules, ...builtinModules.map((name) => `node:${name}`)]);
const FROM_RE = /\bfrom\s*["']([^"']+)["']/g;
const SIDE_EFFECT_IMPORT_RE = /\bimport\s*["']([^"']+)["']/g;
const DYNAMIC_IMPORT_RE = /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;
const RELATIVE_SPECIFIER_RE = /^\.{1,2}(?:[/\\]|$)/;
const TEST_FILE_RE = /(?:^|\/)\.?[^/]*\.(?:test|spec)\.[cm]?[jt]sx?$/;
const SEMVER_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const INTEGRITY_RE = /^sha512-[A-Za-z0-9+/]+={0,2}$/;
const SAFE_RELATIVE_PATH_RE = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[^\0]+$/;

// ── integrity ───────────────────────────────────────────────────────────────

export function sha512Integrity(buffer) {
  return `sha512-${createHash("sha512").update(buffer).digest("base64")}`;
}

export function sha256Hex(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

export function isIntegrity(value) {
  return typeof value === "string" && INTEGRITY_RE.test(value);
}

export function integrityMatches(expected, buffer) {
  return isIntegrity(expected) && sha512Integrity(buffer) === expected;
}

// ── tarball ─────────────────────────────────────────────────────────────────

function cString(buffer, offset, length) {
  let end = offset;
  const limit = offset + length;
  while (end < limit && buffer[end] !== 0) end += 1;
  return buffer.toString("utf8", offset, end);
}

function tarNumber(buffer, offset, length) {
  const field = cString(buffer, offset, length).trim();
  if (!field) return 0;
  const value = Number.parseInt(field, 8);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`invalid tar numeric field: ${JSON.stringify(field)}`);
  }
  return value;
}

function verifyTarChecksum(header) {
  const expected = tarNumber(header, 148, 8);
  let actual = 0;
  for (let index = 0; index < 512; index += 1) {
    actual += index >= 148 && index < 156 ? 0x20 : header[index];
  }
  if (actual !== expected) {
    throw new Error("the tarball header checksum does not match its contents");
  }
}

function normalizePackedName(raw) {
  const name = String(raw).replace(/\\/g, "/").replace(/^\.\//, "");
  if (!name.startsWith("package/")) {
    throw new Error(`the tarball contains a path outside package/: ${raw}`);
  }
  const relative = name.slice("package/".length);
  if (!SAFE_RELATIVE_PATH_RE.test(relative)) {
    throw new Error(`the tarball contains an unsafe path: ${raw}`);
  }
  return posix.normalize(relative);
}

function paxPath(content) {
  for (const line of content.toString("utf8").split("\n")) {
    if (line.startsWith("path=")) return line.slice("path=".length).trim();
  }
  return null;
}

/**
 * Reads a gzipped npm tarball into a path -> bytes map, stripped of the leading
 * `package/` directory. Directories and metadata headers are skipped; symlinks
 * and other special entries are refused (an npm package has no need for them,
 * and following one could escape the staging directory).
 */
export function extractTarball(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw new Error("the workflow tarball is empty");
  }
  const tar = buffer[0] === 0x1f && buffer[1] === 0x8b ? gunzipSync(buffer) : buffer;
  /** @type {Map<string, Buffer>} */
  const files = new Map();
  let offset = 0;
  let longName = null;
  let pax = null;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    verifyTarChecksum(header);
    const size = tarNumber(header, 124, 12);
    const type = String.fromCharCode(header[156] || 0x30);
    const dataStart = offset + 512;
    const dataEnd = dataStart + size;
    if (dataEnd > tar.length) throw new Error("the tarball is truncated");

    if (type === "L") {
      longName = cString(tar, dataStart, size).replace(/\0+$/, "");
    } else if (type === "x") {
      pax = paxPath(tar.subarray(dataStart, dataEnd));
    } else if (type === "0" || type === "\0") {
      const headerName =
        longName ??
        pax ??
        posix.join(cString(header, 345, 155), cString(header, 0, 100)).replace(/^\/+/, "");
      const name = normalizePackedName(headerName);
      if (files.has(name)) throw new Error(`the tarball repeats ${name}`);
      files.set(name, Buffer.from(tar.subarray(dataStart, dataEnd)));
      longName = null;
      pax = null;
    } else if (type === "5") {
      longName = null;
      pax = null;
    } else if (type !== "g") {
      throw new Error(`the tarball contains an unsupported entry type ${JSON.stringify(type)}`);
    }
    if (type !== "0" && type !== "\0" && type !== "x" && type !== "L") {
      longName = null;
      pax = null;
    }
    offset = dataStart + Math.ceil(size / 512) * 512;
  }
  if (files.size === 0) throw new Error("the workflow tarball contains no files");
  return files;
}

// ── specifiers ──────────────────────────────────────────────────────────────

export function isHostPeer(specifier) {
  return String(specifier).startsWith(HOST_PEER_PREFIX) || HOST_PEER_EXTRA.includes(specifier);
}

export function isBuiltin(specifier) {
  return String(specifier).startsWith("node:") || BUILTINS.has(String(specifier));
}

/**
 * A real module specifier: relative, `node:`, scoped, or a bare package name.
 * Prompt text embedded in the extension contains `import("…")`-shaped code
 * snippets, so a match that contains whitespace or punctuation is prose, not an
 * import.
 */
export function isModuleSpecifier(specifier) {
  if (typeof specifier !== "string" || specifier.length === 0 || specifier.length > 200)
    return false;
  if (/\s/.test(specifier)) return false;
  if (/[(){}<>`,;'"\\]/.test(specifier)) return false;
  return /^(?:\.{1,2}\/|node:|@[A-Za-z0-9][\w.-]*\/|[A-Za-z0-9][\w.-]*)/.test(specifier);
}

export function collectSpecifiers(source) {
  /** @type {Set<string>} */
  const specifiers = new Set();
  for (const pattern of [FROM_RE, SIDE_EFFECT_IMPORT_RE, DYNAMIC_IMPORT_RE]) {
    pattern.lastIndex = 0;
    let match = pattern.exec(source);
    while (match !== null) {
      if (isModuleSpecifier(match[1])) specifiers.add(match[1]);
      match = pattern.exec(source);
    }
  }
  return [...specifiers];
}

export function isRelativeSpecifier(specifier) {
  return RELATIVE_SPECIFIER_RE.test(String(specifier));
}

/**
 * Resolve one relative specifier against the exact packed file set. Supports the
 * extensionless imports the extension actually uses, `.js` -> `.ts` (Node's
 * ESM TypeScript rule), explicit `.ts`, and a directory `index`.
 */
export function resolvePackedTarget(fromFile, specifier, packed) {
  const base = posix.normalize(
    posix.join(
      posix.dirname(String(fromFile).replace(/\\/g, "/")),
      String(specifier).replace(/\\/g, "/"),
    ),
  );
  const candidates = [base];
  if (!/\.(?:ts|mts|cts|js|mjs|cjs|json)$/.test(base)) candidates.push(`${base}.ts`);
  if (/\.js$/.test(base)) candidates.push(base.replace(/\.js$/, ".ts"));
  candidates.push(`${base}/index.ts`);
  return candidates.find((candidate) => packed.has(candidate)) ?? null;
}

/** Every relative import of every packed module must resolve inside the bundle. */
export function findMissingPackedImports(files, read) {
  const packed = new Set([...files].map((file) => String(file).replace(/\\/g, "/")));
  const missing = [];
  for (const file of packed) {
    if (!/\.(?:ts|mts|cts)$/.test(file)) continue;
    const source = read(file);
    for (const specifier of collectSpecifiers(source)) {
      if (!isRelativeSpecifier(specifier)) continue;
      if (!resolvePackedTarget(file, specifier, packed)) missing.push({ from: file, specifier });
    }
  }
  return missing;
}

/**
 * A packed module may import Node builtins, its own files, and host peers.
 * Anything else would need a `node_modules` that the bundle does not ship.
 */
export function findForeignSpecifiers(files, read) {
  const foreign = [];
  for (const file of [...files].map((name) => String(name).replace(/\\/g, "/"))) {
    if (!/\.(?:ts|mts|cts)$/.test(file)) continue;
    const source = read(file);
    for (const specifier of collectSpecifiers(source)) {
      if (isRelativeSpecifier(specifier) || isBuiltin(specifier) || isHostPeer(specifier)) continue;
      foreign.push({ from: file, specifier });
    }
  }
  return foreign;
}

// ── manifest and file-list rules ────────────────────────────────────────────

function peerNames(manifest) {
  const peers = manifest?.peerDependencies;
  return peers && typeof peers === "object" && !Array.isArray(peers)
    ? Object.keys(peers).sort()
    : [];
}

function dependencyNames(manifest) {
  const deps = manifest?.dependencies;
  return deps && typeof deps === "object" && !Array.isArray(deps) ? Object.keys(deps) : [];
}

function scriptNames(manifest) {
  const scripts = manifest?.scripts;
  return scripts && typeof scripts === "object" && !Array.isArray(scripts)
    ? Object.keys(scripts)
    : [];
}

/** Install-time hooks that must never exist in a bundle unpacked onto disk. */
export function unexpectedLifecycleScripts(manifest) {
  return scriptNames(manifest).filter((name) => LIFECYCLE_SCRIPTS.includes(name));
}

/**
 * The staged manifest is metadata only: no scripts, no dev dependencies, no
 * runtime dependencies. Peers stay, because they document what the host must
 * provide.
 */
export function sanitizeWorkflowManifest(manifest) {
  const next = JSON.parse(JSON.stringify(manifest));
  const removedScripts = scriptNames(manifest);
  delete next.scripts;
  delete next.devDependencies;
  delete next.optionalDependencies;
  if (next.dependencies && Object.keys(next.dependencies).length === 0) delete next.dependencies;
  return { manifest: next, removedScripts };
}

export function validateWorkflowManifest(manifest, lock, { allowScripts = false } = {}) {
  const errors = [];
  const need = (condition, message) => {
    if (!condition) errors.push(message);
  };
  need(manifest?.name === WORKFLOW_PACKAGE_NAME, `name must be ${WORKFLOW_PACKAGE_NAME}`);
  need(SEMVER_RE.test(String(manifest?.version ?? "")), `version must be exact semver`);
  need(manifest?.private !== true, "the bundled package must not be private");
  need(manifest?.type === "module", 'type must be "module"');
  need(manifest?.license === "MIT", 'license must be "MIT"');
  need(
    Array.isArray(manifest?.pi?.extensions) &&
      manifest.pi.extensions.length === 1 &&
      manifest.pi.extensions[0] === `./${WORKFLOW_ENTRY}`,
    `pi.extensions must be ["./${WORKFLOW_ENTRY}"]`,
  );
  const deps = dependencyNames(manifest);
  need(deps.length === 0, `the bundle must have no runtime dependencies (got ${deps.join(", ")})`);
  if (!allowScripts) {
    const lifecycle = unexpectedLifecycleScripts(manifest);
    need(
      lifecycle.length === 0,
      `the bundle must have no lifecycle scripts (got ${lifecycle.join(", ")})`,
    );
  }

  const peers = peerNames(manifest);
  need(peers.length > 0, "peerDependencies must name the host peers");
  for (const peer of peers) need(isHostPeer(peer), `${peer} is not a host peer`);
  if (lock) {
    need(
      JSON.stringify(peers) === JSON.stringify([...(lock.hostPeers ?? [])].sort()),
      `peerDependencies ${JSON.stringify(peers)} do not match the lock ${JSON.stringify(lock.hostPeers)}`,
    );
    need(
      manifest?.version === lock.version,
      `version ${manifest?.version} does not match the lock ${lock.version}`,
    );
    need(
      manifest?.name === lock.package,
      `package ${manifest?.name} does not match the lock ${lock.package}`,
    );
    need(
      manifest?.license === lock.license,
      `license ${manifest?.license} does not match the lock ${lock.license}`,
    );
  }
  return errors;
}

export function validatePackedFiles(files) {
  const errors = [];
  const list = [...files].map((file) => String(file).replace(/\\/g, "/"));
  const has = (name) => list.includes(name);
  for (const required of REQUIRED_BUNDLE_FILES) {
    if (!has(required)) errors.push(`the tarball is missing ${required}`);
  }
  for (const file of list) {
    if (!SAFE_RELATIVE_PATH_RE.test(file)) errors.push(`unsafe packed path: ${file}`);
    if (file.includes("node_modules/"))
      errors.push(`the tarball must not contain node_modules: ${file}`);
    if (TEST_FILE_RE.test(file)) errors.push(`the tarball must not contain test files: ${file}`);
    if (/(?:^|\/)(?:package-lock\.json|npm-shrinkwrap\.json|\.npmrc)$/.test(file)) {
      errors.push(`the tarball must not contain package-manager state: ${file}`);
    }
    if (/(?:^|\/)\.env(?:\.|$)/.test(file))
      errors.push(`the tarball must not contain environment files: ${file}`);
  }
  return errors;
}

// ── the lock ────────────────────────────────────────────────────────────────

export function isSafeLockPath(value) {
  return typeof value === "string" && SAFE_RELATIVE_PATH_RE.test(value.replace(/\\/g, "/"));
}

export function validateWorkflowLock(lock) {
  const errors = [];
  const need = (condition, message) => {
    if (!condition) errors.push(message);
  };
  need(lock?.schema === BUNDLE_SCHEMA, `schema must be ${BUNDLE_SCHEMA}`);
  need(lock?.package === WORKFLOW_PACKAGE_NAME, `package must be ${WORKFLOW_PACKAGE_NAME}`);
  need(SEMVER_RE.test(String(lock?.version ?? "")), "version must be exact semver");
  need(lock?.entry === WORKFLOW_ENTRY, `entry must be ${WORKFLOW_ENTRY}`);
  need(lock?.license === "MIT", 'license must be "MIT"');
  need(
    Array.isArray(lock?.hostPeers) && lock.hostPeers.length > 0,
    "hostPeers must be a non-empty array",
  );
  for (const peer of lock?.hostPeers ?? []) need(isHostPeer(peer), `${peer} is not a host peer`);

  const source = lock?.source;
  need(source && typeof source === "object", "source is missing");
  const kind = source?.kind;
  need(kind === "release" || kind === "tarball", 'source.kind must be "release" or "tarball"');
  need(isIntegrity(source?.integrity), "source.integrity must be a sha512 integrity");
  need(
    typeof source?.tarball === "string" && /^[A-Za-z0-9._-]+\.tgz$/.test(source.tarball),
    "source.tarball must be a .tgz file name",
  );
  if (kind === "release") {
    need(
      typeof source?.url === "string" && /^https:\/\/[^\s]+\.tgz$/.test(source.url),
      "source.url must be an https .tgz URL for a release artifact",
    );
    need(
      typeof source?.tag === "string" && source.tag.length > 0,
      "source.tag must name the pinned release",
    );
  }
  if (kind === "tarball") {
    need(isSafeLockPath(source?.path), "source.path must be a relative path inside the repository");
  }

  const files = lock?.files;
  need(Array.isArray(files) && files.length > 0, "files must be a non-empty array");
  const seen = new Set();
  for (const file of files ?? []) {
    need(isSafeLockPath(file?.path), `unsafe lock file path: ${file?.path}`);
    need(
      /^[0-9a-f]{64}$/.test(String(file?.sha256 ?? "")),
      `files[].sha256 is invalid for ${file?.path}`,
    );
    if (file?.path) {
      if (seen.has(file.path)) errors.push(`the lock repeats ${file.path}`);
      seen.add(file.path);
    }
  }
  for (const required of REQUIRED_BUNDLE_FILES) {
    if (!seen.has(required)) errors.push(`the lock is missing ${required}`);
  }
  return errors;
}

export function normalizeFileHashes(files, read) {
  return [...files]
    .map((file) => String(file).replace(/\\/g, "/"))
    .sort()
    .map((file) => ({ path: file, sha256: sha256Hex(read(file)) }));
}

export function hashesEqual(left, right) {
  const normalize = (files) =>
    [...(files ?? [])]
      .map((file) => ({ path: file?.path, sha256: file?.sha256 }))
      .sort((a, b) => String(a.path).localeCompare(String(b.path)));
  return JSON.stringify(normalize(left)) === JSON.stringify(normalize(right));
}

/** Where the lock expects a local pinned tarball to sit (inside `resources/`). */
export function localTarballPath(source) {
  if (source?.kind !== "tarball" || !isSafeLockPath(source.path)) return null;
  return source.path;
}

// ── verification ────────────────────────────────────────────────────────────

/**
 * Compare a real tarball with the lock. Returns the reasons it cannot be
 * staged; an empty array means the bytes, the file set and the manifest all
 * match the pinned metadata.
 */
export function compareTarballToLock(buffer, lock) {
  const errors = validateWorkflowLock(lock);
  if (errors.length > 0) return errors;
  if (!integrityMatches(lock.source.integrity, buffer)) {
    return [
      `integrity mismatch: the tarball hashes to ${sha512Integrity(buffer)}, the lock pins ${lock.source.integrity}`,
    ];
  }
  let files;
  try {
    files = extractTarball(buffer);
  } catch (error) {
    return [error instanceof Error ? error.message : String(error)];
  }
  errors.push(...validatePackedFiles([...files.keys()]));
  const manifestBytes = files.get("package.json");
  if (!manifestBytes) return [...errors, "the tarball has no package.json"];
  let manifest;
  try {
    manifest = JSON.parse(manifestBytes.toString("utf8"));
  } catch {
    return [...errors, "the tarball package.json is not valid JSON"];
  }
  errors.push(...validateWorkflowManifest(manifest, lock, { allowScripts: true }));
  const hashes = normalizeFileHashes(files.keys(), (file) => files.get(file));
  if (!hashesEqual(hashes, lock.files)) {
    const pinned = new Map((lock.files ?? []).map((file) => [file.path, file.sha256]));
    for (const file of hashes) {
      if (!pinned.has(file.path))
        errors.push(`the tarball contains an unpinned file: ${file.path}`);
      else if (pinned.get(file.path) !== file.sha256) errors.push(`contents changed: ${file.path}`);
    }
    for (const path of pinned.keys()) {
      if (!hashes.some((file) => file.path === path))
        errors.push(`the tarball is missing pinned file: ${path}`);
    }
  }
  return errors;
}

/** Build the lock document for a verified tarball (used by `--update-lock`). */
export function buildWorkflowLock({
  buffer,
  manifest,
  files,
  source,
  generatedBy = "scripts/stage-workflow-bundle.mjs",
}) {
  return {
    $comment:
      "Pinned @dieulc/workflow bundle. Regenerate with `npm run workflow:lock -- --tarball <file.tgz>`. " +
      "`npm run workflow:stage` verifies every byte against this file before staging; `npm run workflow:verify` re-checks the staged copy.",
    schema: BUNDLE_SCHEMA,
    package: WORKFLOW_PACKAGE_NAME,
    version: manifest.version,
    entry: WORKFLOW_ENTRY,
    license: manifest.license,
    hostPeers: peerNames(manifest),
    source: { ...source, integrity: sha512Integrity(buffer) },
    files: normalizeFileHashes(files.keys(), (file) => files.get(file)),
    generatedBy,
  };
}

/**
 * `files` are the staged bytes (the manifest is sanitized), while `sourceFiles`
 * are the tarball's bytes as pinned by the lock. They differ only in
 * `package.json`; keeping both is what lets the lock stay byte-exact without
 * re-packing the release artifact.
 */
export function buildBundleMetadata({
  lock,
  manifest,
  sourceFiles,
  stagedFiles,
  sourceRead,
  stagedRead,
}) {
  const { manifest: sanitized, removedScripts } = sanitizeWorkflowManifest(manifest);
  return {
    schema: BUNDLE_SCHEMA,
    package: lock.package,
    version: lock.version,
    entry: lock.entry,
    license: lock.license,
    integrity: lock.source.integrity,
    source: { ...lock.source },
    hostPeers: [...lock.hostPeers],
    sourceFiles: normalizeFileHashes(sourceFiles, sourceRead),
    files: normalizeFileHashes(stagedFiles, stagedRead),
    removedScripts,
    manifest: sanitized,
  };
}

export function isValidMetadata(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    value.schema === BUNDLE_SCHEMA &&
    typeof value.package === "string" &&
    typeof value.version === "string" &&
    Array.isArray(value.files)
  );
}

export function validateBundleMetadata(metadata, lock) {
  const errors = [];
  const need = (condition, message) => {
    if (!condition) errors.push(message);
  };
  need(metadata?.schema === BUNDLE_SCHEMA, `bundle schema must be ${BUNDLE_SCHEMA}`);
  need(metadata?.package === lock.package, "the bundle package does not match the lock");
  need(
    metadata?.version === lock.version,
    `the bundle version ${metadata?.version} does not match the lock ${lock.version}`,
  );
  need(metadata?.entry === lock.entry, "the bundle entry does not match the lock");
  need(metadata?.license === lock.license, "the bundle license does not match the lock");
  need(
    metadata?.integrity === lock.source?.integrity,
    "the bundle integrity does not match the lock",
  );
  need(
    JSON.stringify(metadata?.source) === JSON.stringify(lock.source),
    "the bundle source metadata does not match the lock",
  );
  need(
    JSON.stringify(metadata?.hostPeers) === JSON.stringify(lock.hostPeers),
    "the bundle host peers do not match the lock",
  );
  need(
    hashesEqual(metadata?.sourceFiles, lock.files),
    "the bundle source file manifest does not match the lock",
  );
  need(
    Array.isArray(metadata?.files) && metadata.files.length > 0,
    "the bundle has no staged file manifest",
  );
  errors.push(...validateWorkflowManifest(metadata?.manifest, lock));
  for (const file of metadata?.files ?? []) {
    need(isSafeLockPath(file?.path), `unsafe bundle file path: ${file?.path}`);
  }
  return errors;
}

/**
 * Content-based staleness: the staged files, their recorded hashes and the lock
 * must all agree. A rebuild that produced a different module, or a lock updated
 * without re-staging, is a failure even if the app would still start.
 */
export function checkStagedFiles({ lock, metadata, exists, read, list }) {
  const errors = validateBundleMetadata(metadata, lock);
  if (errors.length > 0) return errors;
  const staged = list();
  const expected = new Set((metadata.files ?? []).map((file) => file.path));
  expected.add(BUNDLE_METADATA_FILE);
  for (const file of staged) {
    if (!expected.has(file)) errors.push(`unexpected file in the staged bundle: ${file}`);
  }
  for (const file of metadata.files ?? []) {
    if (!exists(file.path)) {
      errors.push(`the staged bundle is missing ${file.path}`);
      continue;
    }
    if (sha256Hex(read(file.path)) !== file.sha256) {
      errors.push(
        `the staged copy of ${file.path} does not match its recorded hash (stale build output)`,
      );
    }
  }
  for (const required of REQUIRED_BUNDLE_FILES) {
    if (!exists(required)) errors.push(`the staged bundle is missing ${required}`);
  }
  return errors;
}

/** Absolute/checkout references must never travel inside the artifact. */
export function findCheckoutReferences(files, read, markers = []) {
  const needles = [
    ...markers.filter((marker) => typeof marker === "string" && marker.trim().length > 0),
    "C:\\Users\\",
    "file:///",
  ];
  const found = [];
  for (const file of files) {
    if (!/\.(?:ts|mts|cts|js|mjs|cjs|json|md|txt)$/.test(String(file))) continue;
    const source = read(file);
    for (const needle of needles) {
      if (source.includes(needle)) found.push({ file, needle });
    }
  }
  return found;
}

export function hostPeerNames(lock) {
  return [...(lock?.hostPeers ?? [])];
}
