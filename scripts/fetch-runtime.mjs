#!/usr/bin/env node
/**
 * Fetch the pinned Node runtime into `resources/runtime/node/<platform>-<arch>/`
 * and (re)generate the PATH shims in `resources/runtime/bin/`.
 *
 *   npm run runtime:fetch                  # this machine's platform
 *   npm run runtime:fetch -- --platform linux-x64
 *   npm run runtime:fetch -- --all         # every supported platform
 *   npm run runtime:fetch -- --force       # re-download and re-extract
 *   npm run runtime:fetch -- --mirror https://mirror.example/nodejs
 *   npm run runtime:lock                   # refresh node.lock.json from SHASUMS256.txt
 *
 * Downloads are always verified against `resources/runtime/node.lock.json`
 * (sha256). Without `--force` an already installed runtime with the pinned
 * version is left untouched, so the command is safe to run repeatedly.
 *
 * The runtime is deliberately not part of the npm install: it is ~30 MB per
 * platform and only needed to run hosts, not to typecheck or test.
 */

import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { parseArgs } from "node:util";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const lockPath = join(repoRoot, "resources", "runtime", "node.lock.json");
const runtimeRoot = join(repoRoot, "resources", "runtime");
const binDir = join(runtimeRoot, "bin");
const genShimsScript = join(repoRoot, "scripts", "gen-shims.mjs");

const SUPPORTED = [
  "win32-x64",
  "win32-arm64",
  "darwin-arm64",
  "darwin-x64",
  "linux-x64",
  "linux-arm64",
];

function hostTarget() {
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  return `${process.platform}-${arch}`;
}

function fail(message) {
  process.stderr.write(`fetch-runtime: ${message}\n`);
  process.exit(1);
}

function log(message) {
  process.stderr.write(`${message}\n`);
}

async function readLock() {
  try {
    return JSON.parse(await readFile(lockPath, "utf8"));
  } catch (error) {
    fail(`cannot read ${lockPath}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Regenerates the lock from the release's SHASUMS256.txt (authoritative). */
async function updateLock({ mirror, platform }) {
  const lock = await readLock();
  const node = lock.node ?? {};
  const version = node.version;
  if (typeof version !== "string" || version.length === 0)
    fail("node.lock.json has no node.version");

  const base = (mirror ?? node.baseUrl ?? "https://nodejs.org/dist").replace(/\/+$/, "");
  const v = version.startsWith("v") ? version : `v${version}`;

  log(`fetch-runtime: refreshing lock from ${base}/${v}/SHASUMS256.txt`);
  const response = await fetch(`${base}/${v}/SHASUMS256.txt`);
  if (!response.ok) fail(`SHASUMS256.txt returned HTTP ${response.status}`);

  const wanted = platform === "all" ? SUPPORTED : [platform];
  const artifacts = { ...(node.artifacts ?? {}) };
  let changed = 0;

  for (const line of (await response.text()).split("\n")) {
    const match = line.trim().match(/^([0-9a-f]{64})\s+\*?(.+)$/);
    if (!match) continue;
    const [, sha256, archive] = match;
    const target = SUPPORTED.find((entry) => {
      const [os, arch] = entry.split("-");
      return archive === `node-${v}-${os}-${arch}.${archiveFormat(os)}`;
    });
    if (!target || !wanted.includes(target)) continue;
    const previous = artifacts[target];
    if (!previous || previous.sha256 !== sha256) changed += 1;
    artifacts[target] = {
      ...previous,
      archive,
      sha256,
      format: archiveFormat(target.split("-")[0]),
      rootDir: archiveRoot(archive),
    };
  }

  for (const target of wanted) {
    if (!artifacts[target]) fail(`no artifact found for ${target} in ${v}/SHASUMS256.txt`);
  }

  const next = { ...lock, node: { ...node, baseUrl: node.baseUrl ?? base, artifacts } };
  await writeFile(lockPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  log(
    `fetch-runtime: lock updated (${changed} checksum(s) changed, ${Object.keys(artifacts).length} tracked)`,
  );
}

function archiveFormat(os) {
  if (os === "win32") return "zip";
  if (os === "darwin") return "tar.gz";
  return "tar.xz";
}

function archiveRoot(archive) {
  return archive.replace(/\.(zip|tar\.gz|tar\.xz)$/, "");
}

async function sha256File(target) {
  const hash = createHash("sha256");
  await pipeline(createReadStream(target), hash);
  return hash.digest("hex");
}

async function download(url, destination) {
  const response = await fetch(url);
  if (!response.ok || !response.body) {
    fail(`download failed: HTTP ${response.status} for ${url}`);
  }
  const total = Number(response.headers.get("content-length") ?? 0);
  let received = 0;
  let lastReport = 0;
  const body = response.body;
  const progressStream = new Transform({
    transform(chunk, _encoding, callback) {
      received += chunk.length;
      const percent = total > 0 ? Math.floor((received / total) * 100) : 0;
      if (percent >= lastReport + 10 || (total > 0 && received === total)) {
        lastReport = percent;
        log(
          `fetch-runtime:   ${percent}%  ${(received / 1e6).toFixed(1)} MB${total ? ` / ${(total / 1e6).toFixed(1)} MB` : ""}`,
        );
      }
      callback(null, chunk);
    },
  });
  await pipeline(body, progressStream, createWriteStream(destination));
  return received;
}

function extract(archive, destination) {
  // `tar` reads zip (bsdtar ships with Windows and macOS), tar.gz and tar.xz.
  // On Windows we call System32\tar.exe explicitly: a Git-Bash GNU tar on PATH
  // would read "C:\..." as a remote host and fail with "Cannot connect to C".
  const tar = tarBinary();
  const result = spawnSync(tar, ["-xf", archive, "-C", destination], { stdio: "inherit" });
  if (!result.error && result.status === 0) return;

  if (archive.endsWith(".zip")) {
    log("fetch-runtime: tar could not read the archive; falling back to PowerShell Expand-Archive");
    const escapedArchive = archive.replace(/'/g, "''");
    const escapedDestination = destination.replace(/'/g, "''");
    const powershell = spawnSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `Expand-Archive -LiteralPath '${escapedArchive}' -DestinationPath '${escapedDestination}' -Force`,
      ],
      { stdio: "inherit" },
    );
    if (!powershell.error && powershell.status === 0) return;
    fail(
      `could not extract ${archive} (tar exit ${result.status}, powershell exit ${powershell.status})`,
    );
  }

  if (result.error) fail(`tar failed: ${result.error.message}`);
  fail(`tar exited with code ${result.status}`);
}

function tarBinary() {
  if (process.platform === "win32") {
    const systemRoot = process.env.SystemRoot;
    if (systemRoot) {
      const windowsTar = join(systemRoot, "System32", "tar.exe");
      if (existsSync(windowsTar)) return windowsTar;
    }
  }
  return "tar";
}

function nodeBinaryPath(target, nodeDir) {
  return target.startsWith("win32") ? join(nodeDir, "node.exe") : join(nodeDir, "bin", "node");
}

function versionOf(nodePath) {
  const result = spawnSync(nodePath, ["--version"], { encoding: "utf8" });
  if (result.status !== 0 || typeof result.stdout !== "string") return null;
  return result.stdout.trim();
}

async function installedVersion(target, lock) {
  const nodeDir = join(runtimeRoot, "node", target);
  const binary = nodeBinaryPath(target, nodeDir);
  try {
    await stat(binary);
  } catch {
    return null;
  }
  const version = versionOf(binary);
  const expected = lock.node.version.startsWith("v") ? lock.node.version : `v${lock.node.version}`;
  return version === expected ? version : null;
}

async function installOne(target, lock, { force, mirror }) {
  const artifacts = lock.node.artifacts ?? {};
  const artifact = artifacts[target];
  if (!artifact)
    fail(`the lock has no artifact for ${target} (supported: ${SUPPORTED.join(", ")})`);

  if (!force) {
    const existing = await installedVersion(target, lock);
    if (existing) {
      log(`fetch-runtime: ${target} already installed (${existing}) — use --force to re-download`);
      return false;
    }
  }

  const base = (mirror ?? lock.node.baseUrl ?? "https://nodejs.org/dist").replace(/\/+$/, "");
  const version = lock.node.version.startsWith("v") ? lock.node.version : `v${lock.node.version}`;
  const url = `${base}/${version}/${artifact.archive}`;
  const staging = await mkdtemp(join(tmpdir(), `pi-desktop-node-${target}-`));

  try {
    const archive = join(staging, artifact.archive);
    log(`fetch-runtime: downloading ${artifact.archive} (${target})`);
    await download(url, archive);

    const digest = await sha256File(archive);
    if (digest !== artifact.sha256) {
      fail(
        `checksum mismatch for ${artifact.archive}\n  expected ${artifact.sha256}\n  actual   ${digest}`,
      );
    }
    log(`fetch-runtime: sha256 ok (${digest.slice(0, 12)}…)`);

    log("fetch-runtime: extracting");
    extract(archive, staging);

    const extracted = join(staging, artifact.rootDir);
    try {
      await stat(extracted);
    } catch {
      const entries = await readdir(staging);
      fail(`expected ${artifact.rootDir} inside the archive, found: ${entries.join(", ")}`);
    }

    const nodeDir = join(runtimeRoot, "node", target);
    const previous = `${nodeDir}.previous`;
    await mkdir(dirname(nodeDir), { recursive: true });
    await rm(previous, { recursive: true, force: true });
    try {
      await rename(nodeDir, previous);
    } catch {
      // Nothing installed yet.
    }
    await rename(extracted, nodeDir);
    await rm(previous, { recursive: true, force: true });

    const version_ = versionOf(nodeBinaryPath(target, nodeDir));
    if (!version_) fail(`${target}: the extracted runtime did not run`);
    log(`fetch-runtime: installed ${target} (${version_}) at resources/runtime/node/${target}`);
    return true;
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

async function generateShims(target) {
  const result = spawnSync(
    process.execPath,
    [genShimsScript, "--platform", target, "--out", binDir, "--runtime-dir", runtimeRoot],
    { stdio: "inherit" },
  );
  if (result.status !== 0) fail("gen-shims failed");
}

async function main() {
  const { values } = parseArgs({
    options: {
      platform: { type: "string", default: hostTarget() },
      all: { type: "boolean", default: false },
      force: { type: "boolean", default: false },
      mirror: { type: "string" },
      "update-lock": { type: "boolean", default: false },
      "skip-shims": { type: "boolean", default: false },
    },
    allowPositionals: false,
  });

  const requested = values.all ? SUPPORTED : [values.platform];
  for (const target of requested) {
    if (!SUPPORTED.includes(target)) {
      fail(`unsupported platform "${target}" (supported: ${SUPPORTED.join(", ")})`);
    }
  }

  const lock = await readLock();
  if (typeof lock?.node?.version !== "string") fail("node.lock.json is missing node.version");

  if (values["update-lock"]) {
    await updateLock({ mirror: values.mirror, platform: values.all ? "all" : values.platform });
    return;
  }

  let installed = 0;
  for (const target of requested) {
    const didInstall = await installOne(target, lock, {
      force: values.force,
      mirror: values.mirror,
    });
    if (didInstall) installed += 1;
  }

  if (values["skip-shims"]) return;
  if (values.all) {
    log(
      "fetch-runtime: skipping shim generation for --all (shims are per platform; pass --platform)",
    );
    return;
  }
  await generateShims(requested[0]);
  log(`fetch-runtime: ${installed} runtime(s) installed; shims ready in resources/runtime/bin`);
}

await main();
