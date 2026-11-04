import { describe, expect, it } from "vitest";
import { expectedAssets } from "../../scripts/release-assets.mjs";
import { PLATFORMS } from "../src/data/platforms";
import {
  assetFileName,
  assetSuffixes,
  detectTarget,
  isAllowedAssetUrl,
  isValidReleaseVersion,
  parseLatestRelease,
  selectAssets,
  staticAssetUrl,
  DOWNLOAD_PREFIX,
  type ReleaseAsset,
} from "../src/lib/downloads";

function assetsFor(platform: "win" | "linux" | "mac", version = "0.5.0"): ReleaseAsset[] {
  return expectedAssets(platform, version).map((name: string) => ({
    name,
    downloadUrl: `${DOWNLOAD_PREFIX}v${version}/${name}`,
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

describe("static installer URLs", () => {
  const version = "0.5.0";
  const published = new Set([
    ...expectedAssets("win", version),
    ...expectedAssets("linux", version),
    ...expectedAssets("mac", version),
  ]);
  const suffixes = [
    ...new Set(
      PLATFORMS.flatMap((platform) => [
        platform.primary.suffix,
        ...platform.alternates.map((alternate) => alternate.suffix),
      ]),
    ),
  ];

  it("points every card link at a file the release workflow publishes", () => {
    for (const suffix of suffixes) {
      const name = assetFileName(version, suffix);
      expect(published.has(name), name).toBe(true);
      const url = staticAssetUrl(version, suffix);
      expect(url).toBe(`${DOWNLOAD_PREFIX}v${version}/${name}`);
      expect(isAllowedAssetUrl(url)).toBe(true);
    }
  });

  it("refuses to build a URL from an unusable version", () => {
    for (const invalid of ["", "1.0", "../x", "1.0.0/extra", "v0.5.0", "0.5.0?x"]) {
      expect(isValidReleaseVersion(invalid), invalid).toBe(false);
      expect(staticAssetUrl(invalid, "win-x64-setup.exe"), invalid).toBe("");
    }
    expect(isValidReleaseVersion("1.0.0-beta.2")).toBe(true);
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

/** The real GitHub API shape: `url` is the API endpoint, `browser_download_url` the file. */
function apiAssets(): unknown[] {
  return allAssets.map((asset) => ({
    name: asset.name,
    url: `https://api.github.com/repos/dieuluucanh/pi-desktop/releases/assets/${asset.name}`,
    browser_download_url: asset.downloadUrl,
    size: 123,
  }));
}

describe("latest release parsing", () => {
  it("reads browser_download_url and keeps only allowlisted assets", () => {
    const parsed = parseLatestRelease({
      tag_name: "v0.5.0",
      assets: [
        ...apiAssets(),
        {
          name: "evil.exe",
          url: "https://example.com/evil.exe",
          browser_download_url: "https://example.com/evil.exe",
        },
      ],
    });
    expect(parsed?.version).toBe("0.5.0");
    expect(parsed?.assets.length).toBe(allAssets.length);
    expect(parsed?.assets[0]?.downloadUrl).toBe(allAssets[0]?.downloadUrl);
    expect(parsed?.assets.some((asset) => asset.name === "evil.exe")).toBe(false);
  });

  it("ignores a payload that only carries API asset endpoints", () => {
    expect(
      parseLatestRelease({
        tag_name: "v0.5.0",
        assets: [
          {
            name: "Pi-Desktop-0.5.0-win-x64-setup.exe",
            url: `${DOWNLOAD_PREFIX}v0.5.0/Pi-Desktop-0.5.0-win-x64-setup.exe`,
          },
        ],
      }),
    ).toBeNull();
  });

  it("rejects malformed or empty releases", () => {
    expect(parseLatestRelease(null)).toBeNull();
    expect(parseLatestRelease({ tag_name: "v0.5.0", assets: [] })).toBeNull();
    expect(parseLatestRelease({ tag_name: "v0.5.0" })).toBeNull();
  });
});
