import { RELEASES_URL } from "../../site.config.mjs";

export interface ReleaseAsset {
  name: string;
  /** The browser download URL, never the `api.github.com` asset endpoint. */
  downloadUrl: string;
  size?: number;
}

export type Platform = "windows" | "macos" | "linux";
export type Architecture = "x64" | "arm64";
export interface Target {
  os: Platform;
  arch: Architecture;
}

export interface DetectedTarget extends Target {
  /** Human label used for the primary CTA. */
  label: string;
}

export interface AssetSelection {
  primary: ReleaseAsset | null;
  alternates: ReleaseAsset[];
}

export const REPO_RELEASES_URL = RELEASES_URL;
export const DOWNLOAD_PREFIX = "https://github.com/dieuluucanh/pi-desktop/releases/download/";

const RELEASE_VERSION_PATTERN = /^\d+\.\d+\.\d+(?:[-.][0-9A-Za-z.-]+)?$/;

/** A version that is safe to interpolate into a release asset URL. */
export function isValidReleaseVersion(value: string): boolean {
  return RELEASE_VERSION_PATTERN.test(value);
}

const RELEASE_VERSION_PARTS = /^(\d+)\.(\d+)\.(\d+)(?:[-.]([0-9A-Za-z.-]+))?$/;

interface ParsedReleaseVersion {
  core: readonly [number, number, number];
  prerelease: string | null;
}

function parseReleaseVersion(value: string): ParsedReleaseVersion | null {
  const match = RELEASE_VERSION_PARTS.exec(value);
  if (!match) return null;
  const [, major = "", minor = "", patch = "", prerelease] = match;
  return {
    core: [Number.parseInt(major, 10), Number.parseInt(minor, 10), Number.parseInt(patch, 10)],
    prerelease: prerelease ?? null,
  };
}

/**
 * Orders two release versions (`major.minor.patch`, optional `-prerelease`).
 * Returns <0 when `left` is older, 0 when equal, >0 when newer, and null when
 * either value is not a release version this repository publishes.
 *
 * The numeric core is compared first, so `0.10.0` is newer than `0.9.0`; a
 * release without a prerelease is newer than the same core with one. This is
 * intentionally small: the site only needs to know whether an API answer is
 * behind the version it was built for.
 */
export function compareReleaseVersions(left: string, right: string): number | null {
  const a = parseReleaseVersion(left);
  const b = parseReleaseVersion(right);
  if (!a || !b) return null;
  for (let index = 0; index < 3; index += 1) {
    const difference = (a.core[index] ?? 0) - (b.core[index] ?? 0);
    if (difference !== 0) return difference;
  }
  if (a.prerelease === b.prerelease) return 0;
  if (a.prerelease === null) return 1;
  if (b.prerelease === null) return -1;
  return a.prerelease.localeCompare(b.prerelease);
}

/**
 * True when a published release may be cached. A release older than the page's
 * build version is still applied (it is the newest installer that actually
 * exists), but it must not be cached: the next load has to see the new release
 * once the publishing run finishes.
 */
export function shouldCacheLatestRelease(buildVersion: string, latestVersion: string): boolean {
  // `compareReleaseVersions(build, latest)` is negative when the API release is
  // newer than the build, zero when equal, positive when it is older.
  const comparison = compareReleaseVersions(buildVersion, latestVersion);
  return comparison !== null && comparison <= 0;
}

/** The file name the release workflow publishes for an installer suffix. */
export function assetFileName(version: string, suffix: string): string {
  return `Pi-Desktop-${version}-${suffix}`;
}

/**
 * A direct download URL for an installer in the current release. Every
 * `electron-builder` artefact embeds the version (see scripts/release-assets.mjs),
 * so the site can link straight at the file instead of the Releases page.
 * Returns an empty string for an unusable version; callers fall back to the
 * Releases page.
 */
export function staticAssetUrl(version: string, suffix: string): string {
  if (!isValidReleaseVersion(version) || suffix.length === 0) return "";
  return `${DOWNLOAD_PREFIX}v${version}/${assetFileName(version, suffix)}`;
}

const TARGET_SUFFIXES: Record<Platform, Record<Architecture, string[]>> = {
  windows: {
    x64: ["win-x64-setup.exe", "win-x64-portable.exe"],
    arm64: [],
  },
  macos: {
    arm64: ["mac-arm64.dmg", "mac-x64.dmg"],
    x64: ["mac-x64.dmg", "mac-arm64.dmg"],
  },
  linux: {
    x64: ["linux-x86_64-appimage.AppImage", "linux-amd64-deb.deb"],
    arm64: ["linux-arm64-appimage.AppImage", "linux-arm64-deb.deb"],
  },
};

function uaHas(ua: string, value: string): boolean {
  return ua.toLowerCase().includes(value.toLowerCase());
}

/**
 * Detect the visitor's OS/arch. `userAgentData` is used first because macOS
 * browsers report "Intel" in the UA even on Apple Silicon. Returns null for an
 * unknown platform, in which case the caller keeps the Releases fallback.
 */
export function detectTarget(input: {
  userAgent?: string;
  platform?: string;
  userAgentData?: { architecture?: string; bitness?: string; platform?: string } | null;
}): DetectedTarget | null {
  const ua = input.userAgent ?? "";
  const platform = input.platform ?? "";
  const highEntropy = input.userAgentData ?? null;
  const architecture = highEntropy?.architecture?.toLowerCase();
  const uaPlatform = highEntropy?.platform?.toLowerCase();

  const archFromHighEntropy =
    architecture === "arm"
      ? "arm64"
      : architecture === "x86" && highEntropy?.bitness === "64"
        ? "x64"
        : null;

  if (uaHas(ua, "Windows") || platform.startsWith("Win") || uaPlatform === "windows") {
    const arch = archFromHighEntropy ?? (uaHas(ua, "ARM64") ? "arm64" : "x64");
    return { os: "windows", arch, label: `Windows (${arch})` };
  }
  if (uaHas(ua, "Macintosh") || uaHas(ua, "Mac OS") || platform.startsWith("Mac")) {
    const arch = archFromHighEntropy ?? "arm64";
    return {
      os: "macos",
      arch,
      label: arch === "arm64" ? "macOS (Apple Silicon)" : "macOS (Intel)",
    };
  }
  if (uaHas(ua, "Linux") || uaHas(ua, "X11") || platform.startsWith("Linux")) {
    const arch =
      archFromHighEntropy ?? (uaHas(ua, "aarch64") || uaHas(ua, "arm64") ? "arm64" : "x64");
    return { os: "linux", arch, label: `Linux (${arch})` };
  }
  return null;
}

/** Every installer a platform/arch can use, primary first. */
export function assetSuffixes(target: Target): string[] {
  return TARGET_SUFFIXES[target.os][target.arch] ?? [];
}

export function selectAssets(assets: ReleaseAsset[], target: Target | null): AssetSelection {
  if (!target) return { primary: null, alternates: [] };
  const suffixes = assetSuffixes(target);
  const bySuffix = new Map<string, ReleaseAsset>();
  for (const asset of assets) {
    for (const suffix of suffixes) {
      if (asset.name.endsWith(suffix) && !bySuffix.has(suffix)) bySuffix.set(suffix, asset);
    }
  }
  const primary = bySuffix.get(suffixes[0] ?? "") ?? null;
  return {
    primary,
    alternates: suffixes
      .slice(1)
      .map((suffix) => bySuffix.get(suffix))
      .filter((asset): asset is ReleaseAsset => asset != null),
  };
}

/** A release asset URL must belong to this repository's public release feed. */
export function isAllowedAssetUrl(url: string): boolean {
  return url.startsWith(DOWNLOAD_PREFIX) && !url.slice(DOWNLOAD_PREFIX.length).includes("?");
}

/** The subset of a GitHub release asset this page reads. */
interface GitHubReleaseAsset {
  name?: unknown;
  browser_download_url?: unknown;
  size?: unknown;
}

/**
 * Parse the small part of the GitHub API response the page needs.
 *
 * `browser_download_url` is the only field a browser may navigate to; the
 * sibling `url` field is the api.github.com asset endpoint (it returns JSON for
 * an anonymous request), so it is deliberately ignored.
 */
export function parseLatestRelease(
  value: unknown,
): { version: string; assets: ReleaseAsset[] } | null {
  if (!value || typeof value !== "object") return null;
  const release = value as { tag_name?: unknown; assets?: unknown };
  const version = typeof release.tag_name === "string" ? release.tag_name.replace(/^v/, "") : "";
  if (!version || !Array.isArray(release.assets)) return null;

  const assets: ReleaseAsset[] = [];
  for (const raw of release.assets) {
    if (!raw || typeof raw !== "object") continue;
    const asset = raw as GitHubReleaseAsset;
    if (typeof asset.name !== "string" || typeof asset.browser_download_url !== "string") continue;
    if (!isAllowedAssetUrl(asset.browser_download_url)) continue;
    assets.push({
      name: asset.name,
      downloadUrl: asset.browser_download_url,
      ...(typeof asset.size === "number" ? { size: asset.size } : {}),
    });
  }

  return assets.length > 0 ? { version, assets } : null;
}
