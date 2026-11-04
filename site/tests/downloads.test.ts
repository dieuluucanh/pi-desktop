import { describe, expect, it } from "vitest";
import { expectedAssets } from "../../scripts/release-assets.mjs";
import {
  assetSuffixes,
  detectTarget,
  isAllowedAssetUrl,
  parseLatestRelease,
  selectAssets,
  DOWNLOAD_PREFIX,
  type ReleaseAsset,
} from "../src/lib/downloads";

function assetsFor(platform: "win" | "linux" | "mac", version = "0.5.0"): ReleaseAsset[] {
  return expectedAssets(platform, version).map((name: string) => ({
    name,
    url: `${DOWNLOAD_PREFIX}v${version}/${name}`,
  }));
}

const allAssets = [
  ...assetsFor("win"),
  ...assetsFor("linux"),
  ...assetsFor("mac"),
  ...assetsFor("mac").map((asset) => ({ ...asset, name: asset.name.replace(".dmg", ".zip") })),
];

describe("download target detection", () => {
  it("detects Windows, macOS and Linux with a sane default", () => {
    expect(detectTarget({ userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" })?.os).toBe(
      "windows",
    );
    expect(detectTarget({ userAgent: "Mozilla/5.0 (Windows NT 10.0; ARM64)" })?.arch).toBe("arm64");
    expect(detectTarget({ userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)" })?.arch).toBe(
      "arm64",
    );
    expect(
      detectTarget({
        userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)",
        userAgentData: { architecture: "x86", bitness: "64", platform: "macOS" },
      })?.arch,
    ).toBe("x64");
    expect(detectTarget({ userAgent: "Mozilla/5.0 (X11; Linux x86_64)" })?.arch).toBe("x64");
    expect(detectTarget({ userAgent: "Mozilla/5.0 (X11; Linux aarch64)" })?.arch).toBe("arm64");
    expect(detectTarget({ userAgent: "SomethingElse" })).toBeNull();
  });

  it("lists the expected suffixes for each target", () => {
    expect(assetSuffixes({ os: "windows", arch: "x64" })).toEqual([
      "win-x64-setup.exe",
      "win-x64-portable.exe",
    ]);
    expect(assetSuffixes({ os: "macos", arch: "arm64" })).toEqual(["mac-arm64.dmg", "mac-x64.dmg"]);
    expect(assetSuffixes({ os: "linux", arch: "arm64" })).toEqual([
      "linux-arm64-appimage.AppImage",
      "linux-arm64-deb.deb",
    ]);
  });
});

describe("release asset selection", () => {
  it("maps every current Windows installer to the primary/alternate links", () => {
    const selection = selectAssets(allAssets, { os: "windows", arch: "x64" });
    expect(selection.primary?.name).toBe("Pi-Desktop-0.5.0-win-x64-setup.exe");
    expect(selection.alternates.map((asset) => asset.name)).toEqual([
      "Pi-Desktop-0.5.0-win-x64-portable.exe",
    ]);
  });

  it("maps both macOS architectures and Linux formats", () => {
    const arm = selectAssets(allAssets, { os: "macos", arch: "arm64" });
    expect(arm.primary?.name).toBe("Pi-Desktop-0.5.0-mac-arm64.dmg");
    expect(arm.alternates[0]?.name).toBe("Pi-Desktop-0.5.0-mac-x64.dmg");

    const intel = selectAssets(allAssets, { os: "macos", arch: "x64" });
    expect(intel.primary?.name).toBe("Pi-Desktop-0.5.0-mac-x64.dmg");

    const linux = selectAssets(allAssets, { os: "linux", arch: "x64" });
    expect(linux.primary?.name).toBe("Pi-Desktop-0.5.0-linux-x86_64-appimage.AppImage");
    expect(linux.alternates[0]?.name).toBe("Pi-Desktop-0.5.0-linux-amd64-deb.deb");
  });

  it("never selects manifests, blockmaps or updater zips", () => {
    const selection = selectAssets(allAssets, { os: "macos", arch: "arm64" });
    for (const asset of [selection.primary, ...selection.alternates]) {
      expect(asset?.name).not.toMatch(/\.(?:zip|yml|blockmap)$/);
    }
    expect(selectAssets(allAssets, null)).toEqual({ primary: null, alternates: [] });
  });

  it("accepts only this repository's public download URLs", () => {
    expect(isAllowedAssetUrl(`${DOWNLOAD_PREFIX}v0.5.0/Pi-Desktop-0.5.0-win-x64-setup.exe`)).toBe(
      true,
    );
    expect(isAllowedAssetUrl("https://example.com/Pi-Desktop.exe")).toBe(false);
    expect(isAllowedAssetUrl("javascript:alert(1)")).toBe(false);
    expect(isAllowedAssetUrl(`${DOWNLOAD_PREFIX}v0.5.0/file.exe?token=x`)).toBe(false);
  });
});

describe("latest release parsing", () => {
  it("keeps only allowlisted assets and the version", () => {
    const parsed = parseLatestRelease({
      tag_name: "v0.5.0",
      assets: [...allAssets, { name: "evil.exe", url: "https://example.com/evil.exe" }],
    });
    expect(parsed?.version).toBe("0.5.0");
    expect(parsed?.assets.some((asset) => asset.name === "evil.exe")).toBe(false);
    expect(parsed?.assets.length).toBe(allAssets.length);
  });

  it("rejects malformed or empty releases", () => {
    expect(parseLatestRelease(null)).toBeNull();
    expect(parseLatestRelease({ tag_name: "v0.5.0", assets: [] })).toBeNull();
    expect(parseLatestRelease({ tag_name: "v0.5.0" })).toBeNull();
  });
});
