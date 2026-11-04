import { RELEASES_URL } from "../../site.config.mjs";

export interface ReleaseAsset {
  name: string;
  url: string;
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

export interface LatestRelease {
  tag_name?: string;
  assets?: ReleaseAsset[];
}

/** Parse the small part of the GitHub API response the page needs. */
export function parseLatestRelease(
  value: unknown,
): { version: string; assets: ReleaseAsset[] } | null {
  if (!value || typeof value !== "object") return null;
  const release = value as LatestRelease;
  const version = typeof release.tag_name === "string" ? release.tag_name.replace(/^v/, "") : "";
  if (!version || !Array.isArray(release.assets)) return null;
  const assets = release.assets
    .filter(
      (asset): asset is ReleaseAsset =>
        Boolean(asset) &&
        typeof asset.name === "string" &&
        typeof asset.url === "string" &&
        isAllowedAssetUrl(asset.url),
    )
    .map((asset) => ({ name: asset.name, url: asset.url, size: asset.size }));
  return assets.length > 0 ? { version, assets } : null;
}
