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
    expect(job("linux")).toMatch(/runs-on: ubuntu-latest/);
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
    expect(linux).toContain("release/latest-linux.yml");
    expect(linux).toContain("release/latest-linux-arm64.yml");
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
});
