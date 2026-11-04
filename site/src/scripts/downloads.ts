import {
  assetSuffixes,
  detectTarget,
  isAllowedAssetUrl,
  parseLatestRelease,
  selectAssets,
  staticAssetUrl,
  type DetectedTarget,
  type ReleaseAsset,
} from "../lib/downloads";

const API_URL = "https://api.github.com/repos/dieuluucanh/pi-desktop/releases/latest";
const CACHE_KEY = "pi-desktop:latest-release:v1";
const CACHE_TTL_MS = 10 * 60 * 1000;
const RELEASE_META = 'meta[name="pi-desktop-release"]';

interface CachedRelease {
  fetchedAt: number;
  value: unknown;
}

/** The pieces of `NavigatorUAData` this page can use, with the extra call optional. */
interface UserAgentData {
  architecture?: string;
  bitness?: string;
  platform?: string;
  getHighEntropyValues?: (hints: string[]) => Promise<{
    architecture?: string;
    bitness?: string;
  }>;
}

function readCache(): unknown | null {
  try {
    const raw = sessionStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const cached = JSON.parse(raw) as CachedRelease;
    if (Date.now() - cached.fetchedAt > CACHE_TTL_MS) return null;
    return cached.value;
  } catch {
    return null;
  }
}

function writeCache(value: unknown): void {
  try {
    sessionStorage.setItem(CACHE_KEY, JSON.stringify({ fetchedAt: Date.now(), value }));
  } catch {
    // Private mode or a full quota: the page still works without the cache.
  }
}

function setStatus(message: string): void {
  for (const element of document.querySelectorAll<HTMLElement>("[data-download-status]")) {
    element.textContent = message;
  }
}

/** The release the site was built from; the anchors already point at it. */
function siteVersion(): string {
  return document.querySelector<HTMLMetaElement>(RELEASE_META)?.content.trim() ?? "";
}

function userAgentData(): UserAgentData | null {
  if (!("userAgentData" in navigator)) return null;
  return (navigator as Navigator & { userAgentData?: UserAgentData }).userAgentData ?? null;
}

function detectFrom(data: UserAgentData | null): DetectedTarget | null {
  return detectTarget({
    userAgent: navigator.userAgent,
    platform: navigator.platform,
    userAgentData: data,
  });
}

/**
 * Phase 1: point the hero/closing CTA at the visitor's platform using the
 * build-time version. No network, so it is correct even when the API is
 * unavailable or the page is loaded at a rate limit.
 */
function applyTarget(target: DetectedTarget | null, version: string): void {
  if (!target) return;
  document.documentElement.dataset.detectedOs = target.os;

  const suffix = assetSuffixes(target)[0] ?? null;
  const href = suffix ? staticAssetUrl(version, suffix) : "";
  for (const element of document.querySelectorAll<HTMLAnchorElement>(
    "[data-download-primary]:not([data-download-suffix])",
  )) {
    if (href && isAllowedAssetUrl(href)) element.href = href;
    element.textContent = `Download for ${target.label}`;
  }

  setStatus(version ? `v${version} · ${target.label}` : target.label);
}

/**
 * Phase 2: replace the build-time links with the newest *published* release.
 * Every URL is allowlisted before it reaches an `href`.
 */
function applyAssets(
  release: { version: string; assets: ReleaseAsset[] },
  target: DetectedTarget | null,
): void {
  for (const element of document.querySelectorAll<HTMLAnchorElement>("[data-download-suffix]")) {
    const suffix = element.dataset.downloadSuffix ?? "";
    const asset = release.assets.find((candidate) => candidate.name.endsWith(suffix));
    if (asset && isAllowedAssetUrl(asset.downloadUrl)) {
      element.href = asset.downloadUrl;
      element.dataset.downloadResolved = "true";
    }
  }

  const selection = selectAssets(release.assets, target);
  for (const element of document.querySelectorAll<HTMLAnchorElement>(
    "[data-download-primary]:not([data-download-suffix])",
  )) {
    if (!selection.primary || !isAllowedAssetUrl(selection.primary.downloadUrl)) continue;
    element.href = selection.primary.downloadUrl;
    if (target) element.textContent = `Download for ${target.label}`;
    element.dataset.downloadResolved = "true";
  }

  setStatus(`Latest release v${release.version}${target ? ` · ${target.label}` : ""}`);
}

/**
 * Chromium only fills `architecture`/`bitness` after this call; without it every
 * Mac looks like Apple Silicon. Failure keeps the user-agent guess.
 */
async function refineTarget(initial: DetectedTarget | null): Promise<DetectedTarget | null> {
  const data = userAgentData();
  if (!data?.getHighEntropyValues) return initial;
  try {
    const values = await data.getHighEntropyValues(["architecture", "bitness"]);
    return detectFrom({ ...values, platform: data.platform }) ?? initial;
  } catch {
    return initial;
  }
}

async function fetchLatest(): Promise<unknown | null> {
  try {
    const response = await fetch(API_URL, {
      headers: { Accept: "application/vnd.github+json" },
      credentials: "omit",
    });
    if (!response.ok) return null;
    const value: unknown = await response.json();
    writeCache(value);
    return value;
  } catch {
    return null;
  }
}

async function enhance(version: string, initial: DetectedTarget | null): Promise<void> {
  const target = (await refineTarget(initial)) ?? initial;
  if (target) applyTarget(target, version);

  const raw = readCache() ?? (await fetchLatest());
  const release = parseLatestRelease(raw);
  if (release) applyAssets(release, target);
}

if (typeof window !== "undefined") {
  const version = siteVersion();
  const initial = detectFrom(userAgentData());
  applyTarget(initial, version);
  void enhance(version, initial);
}
