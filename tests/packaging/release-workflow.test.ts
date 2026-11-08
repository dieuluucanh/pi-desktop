import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Release-workflow contract (plan step 8).
 *
 * The release itself can only be proven by running it, but the properties that
 * make it safe are textual and cheap to pin: a tag (not a branch) starts it,
 * every platform builds on its own OS, nothing is visible to `electron-updater`
 * until all three succeeded, the manifests are uploaded by the job that made
 * them, and a macOS package declares the ad-hoc identity the app's update gate
 * depends on.
 *
 * Read as text, like `tests/packaging/builder-config.test.ts`: the assertions are
 * about the named entries, not about YAML semantics.
 */

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const workflowPath = ".github/workflows/release.yml";
const yaml = readFileSync(join(repoRoot, workflowPath), "utf8").replace(/\r\n/g, "\n");
const nodeLock = JSON.parse(
  readFileSync(join(repoRoot, "resources", "runtime", "node.lock.json"), "utf8"),
) as { node: { version: string } };

const JOB_NAMES = ["prepare", "windows", "linux", "macos", "publish"];

/** One job's YAML block, so a pattern cannot accidentally match a neighbour. */
function job(name: string): string {
  const start = yaml.indexOf(`\n  ${name}:\n`);
  expect(start, `job ${name} exists`).toBeGreaterThan(-1);
  const rest = yaml.slice(start + 1);
  const next = JOB_NAMES.filter((other) => other !== name)
    .map((other) => rest.indexOf(`\n  ${other}:\n`))
    .filter((index) => index > 0)
    .sort((left, right) => left - right)[0];
  return next === undefined ? rest : rest.slice(0, next);
}

describe("release workflow", () => {
  it("starts from a version tag, with a dry-run dispatch", () => {
    expect(yaml).toMatch(/on:\n {2}push:\n {4}tags: \["v\*"\]/);
    expect(yaml).toMatch(/workflow_dispatch:/);
    // A dry run must be the default, and it must be able to build any tag.
    const dispatch = yaml.slice(yaml.indexOf("workflow_dispatch:"));
    expect(dispatch).toMatch(/publish:\n\s+description:[\s\S]*?type: boolean\n\s+default: false/);
    expect(dispatch).toMatch(/tag:\n\s+description:[\s\S]*?type: string/);
    // One release at a time; a second run must not race the first.
    expect(yaml).toMatch(/concurrency:\n {2}group: release-.*\n {2}cancel-in-progress: false/);
  });

  it("builds each platform on its own OS", () => {
    expect(job("windows")).toMatch(/runs-on: windows-latest/);
    expect(job("linux")).toContain("runs-on: ${{ matrix.runner }}");
    expect(job("macos")).toMatch(/runs-on: macos-latest/);
    for (const name of ["windows", "linux", "macos"]) {
      expect(job(name), name).toMatch(/needs: prepare/);
    }
  });

  it("keeps the Windows job in bash so one dialect covers all three", () => {
    // `set -euo pipefail` is a syntax error in the runner's default PowerShell.
    expect(job("windows")).toMatch(/defaults:\n\s+run:\n(?:\s+#.*\n)*\s+shell: bash/);
    for (const name of ["linux", "macos"]) {
      expect(job(name), name).toMatch(/set -euo pipefail/);
    }
  });

  it("pins the bundled Node, retries the install and caches verified downloads", () => {
    // The release workflow must build with the same Node as the bundled
    // runtime. Pinning it also makes the node-gyp headers cache exact.
    expect(nodeLock.node.version).toBe("24.22.2");
    for (const name of ["prepare", "windows", "linux", "macos"]) {
      expect(job(name), name).toContain(`node-version: ${nodeLock.node.version}`);
      // The release workflow holds `contents: write`; do not leave the checkout
      // token in `.git/config` for the build/upload steps.
      expect(job(name), name).toContain("persist-credentials: false");
    }

    for (const name of ["windows", "linux", "macos"]) {
      const block = job(name);
      expect(block, name).toContain("bash scripts/retry.sh 3 30 -- npm ci");
      expect(block, name).toContain(
        "actions/cache/restore@0057852bfaa89a56745cba8c7296529d2fc39830",
      );
      expect(block, name).toContain("actions/cache/save@0057852bfaa89a56745cba8c7296529d2fc39830");
      expect(block, name).toContain("steps.build-cache.outputs.cache-primary-key");
      expect(block, name).toContain("continue-on-error: true");
      // A failed job must not freeze a partial cache under the primary key;
      // the `release-v1-` segment is the manual invalidation salt.
      expect(block, name).toContain("if: >-");
      expect(block, name).toContain("success() && steps.build-cache.outputs.cache-hit");
      expect(block, name).toContain("release-v1-");
      // Only verified upstream archives are cached; node_modules and npm's own
      // cache are deliberately absent.
      expect(block, name).toContain("${{ runner.temp }}/electron-cache");
      expect(block, name).toContain("${{ runner.temp }}/electron-builder-cache");
      // node-gyp headers are not cached (the workflow cannot verify them);
      // `npm ci` is retried instead.
      expect(block, name).not.toContain("node-gyp");
      expect(block, name).toContain("hashFiles('package-lock.json', 'electron-builder.yml')");
      expect(block, name).toContain("ELECTRON_CACHE: ${{ runner.temp }}/electron-cache");
      expect(block, name).toContain(
        "ELECTRON_BUILDER_CACHE: ${{ runner.temp }}/electron-builder-cache",
      );
      expect(block, name).toContain('npm_config_fetch_retries: "5"');
      expect(block, name).toContain('npm_config_fetch_retry_mintimeout: "20000"');
      expect(block, name).toContain('npm_config_fetch_retry_maxtimeout: "120000"');
    }
  });

  it("retries packaging with a bounded, diagnosable attempt", () => {
    for (const name of ["windows", "linux", "macos"]) {
      const block = job(name);
      expect(block, name).toContain("bash scripts/package-retry.sh npx electron-builder");
      expect(block, name).toContain('-c.electronDownload.cache="$ELECTRON_CACHE"');
      expect(block, name).toContain('DEBUG: "@electron/get:*"');
      expect(block, name).toContain("Inspect the failed package attempt");
    }

    const windows = job("windows");
    expect(windows).toContain("npm run build");
    expect(windows).toContain("npm run runtime:fetch -- --platform win32-x64");
    expect(windows).toContain("npm run runtime:verify");
    expect(windows).not.toContain("npm run package:win");
    expect(windows).toContain("--win --x64");

    expect(job("linux")).toContain("--linux --${{ matrix.arch }}");
    expect(job("macos")).toContain("--mac --arm64 --x64");
    expect(job("macos")).toContain("-c.mac.identity=-");

    const timeouts: Record<string, string> = {
      prepare: "10",
      windows: "60",
      linux: "60",
      macos: "90",
      publish: "15",
    };
    for (const [name, minutes] of Object.entries(timeouts)) {
      expect(job(name), name).toContain(`timeout-minutes: ${minutes}`);
    }
  });

  it("retries uploads and the publish flip", () => {
    for (const name of ["windows", "linux", "macos"]) {
      const block = job(name);
      expect(block, name).toContain('bash scripts/retry.sh 3 15 -- gh release upload "$TAG"');
      expect(block, name).toContain("--clobber");
    }
    expect(job("prepare")).toContain("retry_create");
    expect(job("prepare")).toContain('gh release create "$TAG"');
    expect(job("prepare")).toContain('gh release view "$TAG"');

    const publish = job("publish");
    expect(publish).toContain('retry 3 15 gh release edit "$TAG" --draft=false --latest');
    expect(publish).toContain("for attempt in 1 2 3 4 5");
    expect(publish).toContain("waiting for $asset");
    expect(publish).toContain("--max-time 60");
    expect(publish).toContain("--connect-timeout 15");
    // The publish job still has no checkout: the retry is inline.
    expect(publish).not.toMatch(/\n\s+-\s+uses: actions\/checkout/);
  });

  it("refuses a tag that disagrees with package.json", () => {
    const prepare = job("prepare");
    expect(prepare).toContain('version="$(node -p ');
    expect(prepare).toMatch(/\[ "\$tag" != "v\$version" \]/);
    expect(prepare).toContain("does not match package.json");
    // ...and the release notes must exist before anything is created.
    expect(prepare).toMatch(/test -f "docs\/releases\/\$tag\.md"/);
  });

  it("creates the release as a draft, and only uploads when told to publish", () => {
    const prepare = job("prepare");
    expect(prepare).toMatch(/gh release view "\$TAG"/);
    expect(prepare).toContain("--draft");
    expect(prepare).toContain("--verify-tag");
    expect(prepare).toContain("--notes-file");

    for (const name of ["windows", "linux", "macos"]) {
      const block = job(name);
      // Every upload is gated on the prepare job's decision: `inputs.publish`
      // is undefined outside `prepare`.
      expect(block, name).toContain("if: needs.prepare.outputs.publish == 'true'");
      expect(block, name).not.toContain("inputs.publish");
      expect(block, name).toMatch(/gh release upload "\$TAG"/);
      expect(block, name).toContain("--clobber");
    }
  });

  it("uploads every manifest from the job that produced it", () => {
    expect(job("windows")).toContain("release/latest.yml");
    const linux = job("linux");
    expect(linux).toContain("release/latest-linux*.yml");
    // node-pty has no Linux prebuild, so arm64 must build on an arm64 runner.
    expect(linux).toContain("ubuntu-24.04-arm");
    expect(job("macos")).toContain("release/latest-mac.yml");
    // The NSIS blockmap is what makes a differential update possible.
    expect(job("windows")).toContain("release/*.blockmap");
    // Both arches of the mac artefacts.
    expect(job("macos")).toMatch(/release\/\*\.dmg release\/\*\.zip/);
  });

  it("verifies each platform's artefacts with the release-assets guard", () => {
    const jobs = { win: "windows", linux: "linux", mac: "macos" } as const;
    for (const [platform, name] of Object.entries(jobs)) {
      const block = job(name);
      expect(block, platform).toContain("scripts/release-assets.mjs");
      expect(block, platform).toContain(`--platform ${platform}`);
    }
  });

  it("publishes only after all three platforms pass, then proves the feed", () => {
    const publish = job("publish");
    expect(publish).toMatch(/needs: \[prepare, windows, linux, macos\]/);
    expect(publish).toContain("if: needs.prepare.outputs.publish == 'true'");
    expect(publish).toMatch(/gh release edit "\$TAG" --draft=false --latest/);
    // Anonymous verification: no token, the exact URL an installed app uses.
    expect(publish).toContain("curl -fsSL");
    expect(publish).toContain("/releases/download/$TAG");
    expect(publish).toContain("latest-mac.yml");
    expect(publish).toContain("curl -s -o /dev/null -w '%{http_code}'");
  });

  it("records the macOS signing decision the app's update gate depends on", () => {
    const macos = job("macos");
    expect(macos).toContain("PI_MAC_SIGNING: adhoc");
    expect(macos).toContain('CSC_IDENTITY_AUTO_DISCOVERY: "false"');
    expect(macos).toContain("-c.mac.identity=-");
    // Ad-hoc is still a signature: it must verify, and must not read "damaged".
    expect(macos).toContain("codesign --verify --deep --strict");
    expect(macos).toContain("spctl");
    expect(macos).toMatch(/grep -qi "damaged"/);
    // The provenance the app reads back (channel + macSigning + version).
    expect(macos).toMatch(/"channel": "release"/);
    expect(macos).toMatch(/"macSigning": "adhoc"/);
    // A mac build must still prove its bundled runtime and shims work.
    expect(macos).toContain("runtime/bin/pi");
    expect(macos).toContain("runtime/node/darwin-arm64/bin/node");
  });

  it("stamps a release channel and scopes write access to the jobs that need it", () => {
    expect(yaml).toMatch(/env:\n(?:\s+#.*\n)*\s+PI_BUILD_CHANNEL: release/);
    expect(yaml).toMatch(/permissions:\n {2}contents: read/);
    // prepare + three builds + publish (the header comment mentions the string
    // too, so match the YAML values only).
    expect(yaml.match(/^\s+contents: write/gm) ?? []).toHaveLength(5);
    expect(existsSync(join(repoRoot, ".github/workflows/release-linux.yml"))).toBe(false);
  });

  it("gives the publish job a repository to talk to without a checkout", () => {
    // `gh` infers {owner}/{repo} from a git remote. This job deliberately has no
    // checkout (it only flips the release and curls the feed), so without
    // GH_REPO it dies with "fatal: not a git repository" — exactly how the first
    // v0.5.0 run lost its publish step after 3 seconds.
    const publish = job("publish");
    // No checkout *step* — the comment mentioning it does not count.
    expect(publish).not.toMatch(/\n\s+-\s+uses: actions\/checkout/);
    expect(publish).toContain("GH_REPO: ${{ github.repository }}");
  });

  it("builds node-pty for the glibc floor and opens a PTY from the package", () => {
    const linux = job("linux");
    // `ubuntu-latest` is a moving alias; v0.8.0 compiled against a 26.04-era
    // glibc and broke every older distribution. A job that builds native code
    // names its runner.
    expect(linux).toContain("runner: ubuntu-24.04");
    expect(linux).not.toContain("runner: ubuntu-latest");
    // The explicit, pinned build replaces the runner compile. The image is
    // resolved to a digest before it is used, so BUILD-INFO records it.
    expect(linux).toContain("npm run pty:linux -- --arch ${{ matrix.arch }}");
    expect(linux).toContain("npm run pty:linux -- --check-only --arch ${{ matrix.arch }}");
    expect(linux).toContain("PI_PTY_IMAGE");
    expect(linux).toContain("docker image inspect");
    // The deb must carry the pinned prebuild and the host bundle, and must not
    // carry a runner build (node-pty would load build/Release first).
    expect(linux).toContain("node_modules/node-pty");
    expect(linux).toContain('"$pty_dir/build/Release/pty.node"');
    expect(linux).toContain('"$host_out/terminal.mjs"');
    // The smoke runs from the unpacked app, the deb, the AppImage and finally
    // inside the floor container — a binary can exist and still not dlopen.
    expect(linux).toContain("verify-packaged-terminal.mjs --dir release/linux-unpacked");
    expect(linux).toContain("deb_resources");
    expect(linux).toContain("squashfs-root/resources");
    expect(linux).toContain("debian:bullseye");
    expect(linux).toContain("--shell /bin/sh --cwd /");
    // Windows/macOS run the same smoke against their shipped prebuilds.
    expect(job("windows")).toContain("verify-packaged-terminal.mjs --dir");
    expect(job("macos")).toContain("verify-packaged-terminal.mjs");
    expect(job("macos")).toContain("--arch arm64");
    expect(job("macos")).toContain("--arch x64");
  });
});
