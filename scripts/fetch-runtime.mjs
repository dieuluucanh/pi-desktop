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
 *   npm run runtime:fetch -- --verify      # re-verify what is on disk (no network)
 *   npm run runtime:lock                   # refresh node.lock.json from SHASUMS256.txt
 *
 * Downloads are always verified against `resources/runtime/node.lock.json`
 * (sha256). Without `--force` an already installed runtime with the pinned
 * version is left untouched, so the command is safe to run repeatedly.
 *
 * A foreign-platform runtime can never be *executed* here — `node.exe` is not a
 * Linux binary and vice versa — so an installed tree is verified without running
 * it (plan R4: the Linux beta installer is produced from a Windows host):
 *
 *   - the archive checksum (sha256, pinned in the lock);
 *   - the npm payload inside the distribution, digest-pinned per platform in
 *     `node.lock.json`, which is what `installedVersion` used to stand for;
 *   - the version stamped into the binary (`node.js/v24.21.0`) cross-checked
 *     against `include/node/node_version.h` where the distribution ships it.
 *
 * Only the host platform's runtime is additionally executed, which is the one
 * case where `--version` proves something the static checks cannot. `--all`
 * therefore works from any host, and is what `package:mac` / `package:linux`
 * rely on.
 *
 * The runtime is deliberately not part of the npm install: it is ~30 MB per
 * platform and only needed to run hosts, not to typecheck or test.
 */

import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
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

/**
 * The npm CLI shipped inside the Node distribution. Unlike `node` itself (a
 * 126 MB binary) the npm payload is byte-identical on every platform of a given
 * release, so its sha256 goes in the lock and pins what actually landed on disk.
 */
const NPM_PAYLOAD = {
  win32: "node_modules/npm/package.json",
  linux: "lib/node_modules/npm/package.json",
  darwin: "lib/node_modules/npm/package.json",
};

/** `node.exe` sits at the root of the Windows ZIP; every other platform uses `bin/`. */
function nodePayloadRelative(platform) {
  return platform === "win32" ? "node.exe" : "bin/node";
}

/** Present in every non-Windows tarball; the Windows ZIP has no `include/`. */
const VERSION_HEADER = "include/node/node_version.h";

/** Every Node binary (`.exe`, ELF, Mach-O) embeds the literal `node.js/v24.21.0`. */
const BINARY_VERSION_MARKER = "node.js/v";

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

function platformOf(target) {
  return target.split("-")[0];
}

/** `"24.21.0"` and `"v24.21.0"` compare equal. */
function sameVersion(left, right) {
  if (typeof left !== "string" || typeof right !== "string") return false;
  return left.trim().replace(/^v/i, "") === right.trim().replace(/^v/i, "");
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

/**
 * sha256 of a text file with CRLF folded to LF. Node's Windows ZIP ships npm's
 * files with CRLF while the tarballs ship LF, so the *content* is identical per
 * release and only the line endings differ — hashing raw bytes would make the
 * same npm release look like two different ones.
 */
async function sha256TextFile(target) {
  const text = await readFile(target, "utf8");
  return createHash("sha256").update(text.replace(/\r\n/g, "\n"), "utf8").digest("hex");
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
  return join(nodeDir, nodePayloadRelative(platformOf(target)));
}

function versionOf(nodePath) {
  const result = spawnSync(nodePath, ["--version"], { encoding: "utf8" });
  if (result.status !== 0 || typeof result.stdout !== "string") return null;
  return result.stdout.trim();
}

/**
 * The version stamped into the binary. Reading it needs no execution, which is
 * what makes a foreign-platform runtime verifiable at all; every Node build
 * embeds `node.js/v<version>`.
 */
async function stampedVersion(binaryPath) {
  try {
    const bytes = await readFile(binaryPath);
    const marker = Buffer.from(BINARY_VERSION_MARKER, "ascii");
    const at = bytes.lastIndexOf(marker);
    if (at < 0) return null;
    const match = /^v?(\d+\.\d+\.\d+)/.exec(
      bytes.subarray(at + marker.length, at + marker.length + 32).toString("ascii"),
    );
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

/** `include/node/node_version.h` — also needs no execution. */
async function headerVersion(nodeDir) {
  try {
    const text = await readFile(join(nodeDir, VERSION_HEADER), "utf8");
    const major = /#define NODE_MAJOR_VERSION (\d+)/.exec(text);
    const minor = /#define NODE_MINOR_VERSION (\d+)/.exec(text);
    const patch = /#define NODE_PATCH_VERSION (\d+)/.exec(text);
    if (!major || !minor || !patch) return null;
    return `${major[1]}.${minor[1]}.${patch[1]}`;
  } catch {
    return null;
  }
}

/**
 * Inspects an installed runtime without running it (except on the host platform,
 * where `--version` is the last word). Returns `null` when nothing is installed
 * and otherwise `{ target, version, problems }` — an empty `problems` means the
 * tree is exactly the pinned release.
 */
async function inspectInstall(target, lock) {
  const nodeDir = join(runtimeRoot, "node", target);
  const binaryPath = nodeBinaryPath(target, nodeDir);
  try {
    await stat(binaryPath);
  } catch {
    return null;
  }

  const problems = [];
  const expected = lock.node.version;
  const platform = platformOf(target);

  const header = await headerVersion(nodeDir);
  const stamped = await stampedVersion(binaryPath);
  const version = header ?? stamped;

  if (version === null) {
    problems.push("no readable version stamp (node_version.h and the binary are both silent)");
  } else if (!sameVersion(version, expected)) {
    problems.push(`version is ${version}, expected ${expected}`);
  }
  if (header && stamped && !sameVersion(header, stamped)) {
    problems.push(`the header says ${header} but the binary says ${stamped}`);
  }

  const expectedNpm = lock.node.npmPayload?.[platform]?.sha256;
  if (expectedNpm) {
    const npmFile = join(nodeDir, NPM_PAYLOAD[platform]);
    const digest = await sha256TextFile(npmFile).catch(() => null);
    if (digest !== expectedNpm) {
      problems.push(`npm payload digest is ${digest ?? "unreadable"}, expected ${expectedNpm}`);
    }
  }

  // Only the host platform's binary is expected to run at all.
  if (target === hostTarget()) {
    const executed = versionOf(binaryPath);
    if (!sameVersion(executed, expected)) {
      problems.push(`\`${binaryPath} --version\` reported ${executed ?? "nothing"}`);
    }
  }

  return { target, version, problems };
}

async function installOne(target, lock, { force, mirror }) {
  const artifacts = lock.node.artifacts ?? {};
  const artifact = artifacts[target];
  if (!artifact)
    fail(`the lock has no artifact for ${target} (supported: ${SUPPORTED.join(", ")})`);

  if (!force) {
    const installed = await inspectInstall(target, lock);
    if (installed && installed.problems.length === 0) {
      log(
        `fetch-runtime: ${target} already installed (${installed.version}) — use --force to re-download`,
      );
      return false;
    }
    if (installed) {
      log(`fetch-runtime: ${target} is installed but failed verification, re-downloading:`);
      for (const problem of installed.problems) log(`fetch-runtime:   - ${problem}`);
    }
  }

  const base = (mirror ?? lock.node.baseUrl ?? "https://nodejs.org/dist").replace(/\/+$/, "");
  const version = lock.node.version.startsWith("v") ? lock.node.version : `v${lock.node.version}`;
  const url = `${base}/${version}/${artifact.archive}`;

  // Staged *inside* the destination filesystem on purpose: the install ends with
  // a `rename()`, and a tmpdir on another mount (`/tmp` is tmpfs in WSL and in
  // many CI images) makes that rename fail with EXDEV.
  const nodeRoot = join(runtimeRoot, "node");
  await mkdir(nodeRoot, { recursive: true });
  const staging = await mkdtemp(join(nodeRoot, `.staging-${target}-`));

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
    const installed = await inspectInstall(target, lock);
    if (!installed || installed.problems.length > 0) {
      fail(
        `${target}: the extracted runtime failed verification\n${(
          installed?.problems ?? ["nothing was installed"]
        )
          .map((problem) => `  - ${problem}`)
          .join("\n")}`,
      );
    }
    log(
      `fetch-runtime: installed ${target} (${installed.version}) at resources/runtime/node/${target}`,
    );
    return true;
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

/** `--verify`: re-checks every installed runtime and reports, without a download. */
async function verifyInstalled(lock, requested) {
  const targets = requested.filter((target) => SUPPORTED.includes(target));
  let failed = 0;
  for (const target of targets) {
    const installed = await inspectInstall(target, lock);
    if (!installed) {
      log(`fetch-runtime: ${target} — not installed`);
      continue;
    }
    if (installed.problems.length === 0) {
      log(`fetch-runtime: ${target} — ok (${installed.version})`);
      continue;
    }
    failed += 1;
    log(`fetch-runtime: ${target} — FAILED (${installed.version ?? "unknown"})`);
    for (const problem of installed.problems) log(`fetch-runtime:   - ${problem}`);
  }
  if (failed > 0) fail(`${failed} runtime(s) failed verification`);
  log("fetch-runtime: all installed runtimes match the lock");
}

/**
 * Records the npm payload digest into the lock. The payload is byte-identical on
 * every platform of a release, so one digest covers them all: it is computed
 * from whichever runtime is installed and written for every supported target.
 * (This is why `runtime:lock` needs a fetched runtime for at least one platform.)
 */
async function updateNpmPayload(lock) {
  const npmPayload = { ...(lock.node.npmPayload ?? {}) };

  let sample = null;
  for (const target of SUPPORTED) {
    const npmFile = join(runtimeRoot, "node", target, NPM_PAYLOAD[platformOf(target)]);
    try {
      sample = { digest: await sha256TextFile(npmFile), from: target };
      break;
    } catch {
      // Not installed on this host; the next candidate is tried.
    }
  }

  if (!sample) {
    const cached = Object.values(npmPayload)[0];
    if (!cached) {
      fail(
        `cannot compute the npm payload digest: no runtime is installed.\n` +
          `  Run \`npm run runtime:fetch\` first (or pass --force), then \`runtime:lock\`.`,
      );
    }
    log(`fetch-runtime: npm payload digest reused from the lock (${cached.sha256.slice(0, 12)}…)`);
    sample = { digest: cached.sha256, from: "lock" };
  } else {
    log(`fetch-runtime: npm payload digest ${sample.digest.slice(0, 12)}… (from ${sample.from})`);
  }

  for (const target of SUPPORTED) {
    const platformName = platformOf(target);
    npmPayload[platformName] = {
      path: NPM_PAYLOAD[platformName],
      sha256: sample.digest,
    };
  }

  await writeFile(
    lockPath,
    `${JSON.stringify({ ...lock, node: { ...lock.node, npmPayload } }, null, 2)}\n`,
    "utf8",
  );
  log(`fetch-runtime: npm payload digests recorded for ${SUPPORTED.length} platform(s)`);
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
      verify: { type: "boolean", default: false },
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
    await updateNpmPayload(lock);
    return;
  }

  if (values.verify) {
    await verifyInstalled(lock, requested);
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
