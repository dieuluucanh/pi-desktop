import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  expectedAssets,
  inspectRelease,
  parseManifest,
  platformManifests,
  RELEASE_PLATFORMS,
} from "../../scripts/release-assets.mjs";

/**
 * Release-asset guard (plan step 6).
 *
 * The two failures this exists for are invisible to "the build succeeded": a
 * missing arch/blockmap, and an updater manifest that names a file the release
 * does not contain. Both surfaces are pure functions over a directory, so they
 * are tested without electron-builder, a network or a packaged app.
 */

const roots: string[] = [];
const VERSION = "0.5.0";

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** A release directory pre-populated with `names`, as if electron-builder ran. */
function releaseDir(names: string[]): string {
  const root = mkdtempSync(join(tmpdir(), "pi-release-assets-"));
  roots.push(root);
  for (const name of names) writeFileSync(join(root, name), "x");
  return root;
}

function manifestFor(version: string, names: string[]): string {
  return [
    `version: ${version}`,
    "files:",
    ...names.flatMap((name) => [`  - url: ${name}`, "    sha512: abc==", "    size: 1"]),
    `path: ${names[0] ?? ""}`,
    "sha512: abc==",
    "releaseDate: '2026-11-04T00:00:00.000Z'",
    "",
  ].join("\n");
}

describe("release asset expectations", () => {
  it("names the artefacts electron-builder actually writes", () => {
    // Verified against the 0.1.0–0.4.0 artefacts: `${os}` renders as
    // win/linux/mac and `${arch}` as x64, x86_64, amd64 or arm64 per target.
    expect(expectedAssets("win", VERSION)).toEqual([
      "Pi-Desktop-0.5.0-win-x64-setup.exe",
      "Pi-Desktop-0.5.0-win-x64-setup.exe.blockmap",
      "Pi-Desktop-0.5.0-win-x64-portable.exe",
      "latest.yml",
    ]);
    expect(expectedAssets("linux", VERSION)).toEqual([
      "Pi-Desktop-0.5.0-linux-x86_64-appimage.AppImage",
      "Pi-Desktop-0.5.0-linux-amd64-deb.deb",
      "Pi-Desktop-0.5.0-linux-arm64-appimage.AppImage",
      "Pi-Desktop-0.5.0-linux-arm64-deb.deb",
      "latest-linux.yml",
      "latest-linux-arm64.yml",
    ]);
    expect(expectedAssets("mac", VERSION)).toEqual([
      "Pi-Desktop-0.5.0-mac-arm64.dmg",
      "Pi-Desktop-0.5.0-mac-x64.dmg",
      "Pi-Desktop-0.5.0-mac-arm64.zip",
      "Pi-Desktop-0.5.0-mac-x64.zip",
      "latest-mac.yml",
    ]);
    expect(RELEASE_PLATFORMS).toEqual(["win", "linux", "mac"]);
    // The updater manifests are per platform, and Linux owns two.
    expect(platformManifests("win")).toEqual(["latest.yml"]);
    expect(platformManifests("linux")).toEqual(["latest-linux.yml", "latest-linux-arm64.yml"]);
    expect(platformManifests("mac")).toEqual(["latest-mac.yml"]);
    expect(() => expectedAssets("beos" as never, VERSION)).toThrow(/unsupported platform/);
  });

  it("scopes the Linux guard to the matrix job's architecture", () => {
    // Each Linux job fetches and packages its own arch only, so demanding the
    // other arch's artefacts (and manifest) fails a complete build.
    expect(expectedAssets("linux", VERSION, "x64")).toEqual([
      "Pi-Desktop-0.5.0-linux-x86_64-appimage.AppImage",
      "Pi-Desktop-0.5.0-linux-amd64-deb.deb",
      "latest-linux.yml",
    ]);
    expect(expectedAssets("linux", VERSION, "arm64")).toEqual([
      "Pi-Desktop-0.5.0-linux-arm64-appimage.AppImage",
      "Pi-Desktop-0.5.0-linux-arm64-deb.deb",
      "latest-linux-arm64.yml",
    ]);
    expect(platformManifests("linux", "x64")).toEqual(["latest-linux.yml"]);
    expect(platformManifests("linux", "arm64")).toEqual(["latest-linux-arm64.yml"]);
    expect(() => expectedAssets("linux", VERSION, "x86" as never)).toThrow(/unsupported arch/);
    // Windows and macOS build their arches in one job; scoping them is a caller
    // bug, not a smaller expectation.
    expect(() => expectedAssets("win", VERSION, "x64")).toThrow(/Linux matrix only/);
  });
});

describe("manifest parsing", () => {
  it("reads version, file urls and path, tolerating quotes", () => {
    const parsed = parseManifest(
      [
        "version: '0.5.0'",
        "files:",
        "  - url: Pi-Desktop-0.5.0-win-x64-setup.exe",
        "    sha512: abc==",
        "    size: 196",
        "path: Pi-Desktop-0.5.0-win-x64-setup.exe",
        "releaseDate: '2026-11-04T00:00:00.000Z'",
      ].join("\n"),
    );
    expect(parsed.version).toBe("0.5.0");
    // `path` repeats the first `files` entry in every real manifest; a set is fine.
    expect(parsed.urls).toEqual(["Pi-Desktop-0.5.0-win-x64-setup.exe"]);
  });

  it("does not invent a version or urls from a junk document", () => {
    expect(parseManifest("not: a manifest")).toEqual({ version: null, urls: [] });
  });
});

describe("inspectRelease", () => {
  it("accepts a complete successful release per platform", () => {
    const win = releaseDir(expectedAssets("win", VERSION));
    writeFileSync(
      join(win, "latest.yml"),
      manifestFor(VERSION, ["Pi-Desktop-0.5.0-win-x64-setup.exe"]),
    );
    expect(inspectRelease({ dir: win, platform: "win", version: VERSION })).toMatchObject({
      ok: true,
      missing: [],
      problems: [],
    });

    const linux = releaseDir(expectedAssets("linux", VERSION));
    writeFileSync(
      join(linux, "latest-linux.yml"),
      manifestFor(VERSION, [
        "Pi-Desktop-0.5.0-linux-x86_64-appimage.AppImage",
        "Pi-Desktop-0.5.0-linux-amd64-deb.deb",
      ]),
    );
    writeFileSync(
      join(linux, "latest-linux-arm64.yml"),
      manifestFor(VERSION, [
        "Pi-Desktop-0.5.0-linux-arm64-appimage.AppImage",
        "Pi-Desktop-0.5.0-linux-arm64-deb.deb",
      ]),
    );
    const linuxResult = inspectRelease({ dir: linux, platform: "linux", version: VERSION });
    expect(linuxResult.ok).toBe(true);
    // A real `latest-linux.yml` lists both the AppImage and the deb, but only
    // the AppImage as `path`; the guard must accept that shape rather than
    // require (or reject) the deb in `files`. The portable exe is the mirror
    // image on Windows: it exists in the release and never in `latest.yml`.
    expect(linuxResult.manifests["latest-linux.yml"]?.urls).toEqual([
      "Pi-Desktop-0.5.0-linux-x86_64-appimage.AppImage",
      "Pi-Desktop-0.5.0-linux-amd64-deb.deb",
    ]);

    const mac = releaseDir(expectedAssets("mac", VERSION));
    writeFileSync(
      join(mac, "latest-mac.yml"),
      manifestFor(VERSION, ["Pi-Desktop-0.5.0-mac-arm64.zip", "Pi-Desktop-0.5.0-mac-x64.zip"]),
    );
    expect(inspectRelease({ dir: mac, platform: "mac", version: VERSION }).ok).toBe(true);
  });

  it("accepts one complete Linux matrix job", () => {
    const x64 = releaseDir(expectedAssets("linux", VERSION, "x64"));
    writeFileSync(
      join(x64, "latest-linux.yml"),
      manifestFor(VERSION, ["Pi-Desktop-0.5.0-linux-x86_64-appimage.AppImage"]),
    );
    expect(
      inspectRelease({ dir: x64, platform: "linux", version: VERSION, arch: "x64" }),
    ).toMatchObject({ ok: true, missing: [], problems: [] });

    const arm64 = releaseDir(expectedAssets("linux", VERSION, "arm64"));
    writeFileSync(
      join(arm64, "latest-linux-arm64.yml"),
      manifestFor(VERSION, ["Pi-Desktop-0.5.0-linux-arm64-appimage.AppImage"]),
    );
    expect(
      inspectRelease({ dir: arm64, platform: "linux", version: VERSION, arch: "arm64" }),
    ).toMatchObject({ ok: true, missing: [], problems: [] });
  });

  it("names a missing artefact instead of failing generically", () => {
    const dir = releaseDir(
      expectedAssets("win", VERSION).filter((name) => !name.endsWith(".blockmap")),
    );
    writeFileSync(
      join(dir, "latest.yml"),
      manifestFor(VERSION, ["Pi-Desktop-0.5.0-win-x64-setup.exe"]),
    );

    const result = inspectRelease({ dir, platform: "win", version: VERSION });
    expect(result.ok).toBe(false);
    expect(result.missing).toEqual(["Pi-Desktop-0.5.0-win-x64-setup.exe.blockmap"]);
    expect(result.problems).toEqual([]);
  });

  it("rejects a manifest that names a file the release does not contain", () => {
    const dir = releaseDir(expectedAssets("mac", VERSION));
    writeFileSync(
      join(dir, "latest-mac.yml"),
      manifestFor(VERSION, ["Pi-Desktop-0.5.0-mac-arm64.zip", "Pi-Desktop-0.5.0-mac-x64.zip"]),
    );
    rmSync(join(dir, "Pi-Desktop-0.5.0-mac-x64.zip"));

    const result = inspectRelease({ dir, platform: "mac", version: VERSION });
    expect(result.ok).toBe(false);
    // Both the artefact and the manifest entry are reported.
    expect(result.missing).toContain("Pi-Desktop-0.5.0-mac-x64.zip");
    expect(result.problems.join("\n")).toMatch(/latest-mac\.yml: names .*mac-x64\.zip/);
  });

  it("rejects a manifest left over from the previous version", () => {
    const dir = releaseDir(expectedAssets("linux", VERSION));
    writeFileSync(
      join(dir, "latest-linux.yml"),
      manifestFor("0.4.0", ["Pi-Desktop-0.5.0-linux-x86_64-appimage.AppImage"]),
    );
    writeFileSync(
      join(dir, "latest-linux-arm64.yml"),
      manifestFor(VERSION, ["Pi-Desktop-0.5.0-linux-arm64-appimage.AppImage"]),
    );

    const result = inspectRelease({ dir, platform: "linux", version: VERSION });
    expect(result.ok).toBe(false);
    expect(result.problems).toEqual(["latest-linux.yml: version is 0.4.0, expected 0.5.0"]);
  });

  it("reports an empty directory as entirely missing", () => {
    const dir = releaseDir([]);
    const result = inspectRelease({ dir, platform: "mac", version: VERSION });
    expect(result.ok).toBe(false);
    expect(result.missing).toEqual(expectedAssets("mac", VERSION));
    expect(result.manifests).toEqual({});
  });
});
