import {
  assetSuffixes,
  compareReleaseVersions,
  detectTarget,
  isAllowedAssetUrl,
  parseLatestRelease,
  selectAssets,
  shouldCacheLatestRelease,
  staticAssetUrl,
  type DetectedTarget,
  type ReleaseAsset,
} from "../lib/downloads";

const API_URL = "https://api.github.com/repos/dieuluucanh/pi-desktop/releases/latest";
// v2 discards every v1 value written before the version gate existed. A v1
// visitor would otherwise keep a behind-build answer for the full TTL.
const CACHE_KEY = "pi-desktop:latest-release:v2";
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

function readCache(buildVersion: string): unknown | null {
  try {
    const raw = sessionStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const cached = JSON.parse(raw) as CachedRelease;
    if (Date.now() - cached.fetchedAt > CACHE_TTL_MS) return null;
    // A behind-build answer is never cached by this script, but defend against
    // one written by an older page in the same tab: it must be re-fetched, not
    // reused, or the next load would keep the old release after publish.
    const release = parseLatestRelease(cached.value);
    if (release && !shouldCacheLatestRelease(buildVersion, release.version)) return null;
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
 * Every URL is allowlisted before it reaches an `href`. `status` is computed by
 * the caller so the normal and publishing states cannot drift.
 */
function applyAssets(
  release: { version: string; assets: ReleaseAsset[] },
  target: DetectedTarget | null,
  status: string,
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

  setStatus(status);
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
      // GitHub's API is cacheable for a minute; a stale HTTP response would
      // delay the switch to the newly published release just like the session
      // cache used to. The behind-build answer is not written to sessionStorage,
      // so the next load always revalidates.
      cache: "no-store",
    });
    if (!response.ok) return null;
    return (await response.json()) as unknown;
  } catch {
    return null;
  }
}

async function enhance(version: string, initial: DetectedTarget | null): Promise<void> {
  const target = (await refineTarget(initial)) ?? initial;
  if (target) applyTarget(target, version);

  // A cached behind-build answer is rejected by readCache, so this fetches
  // again while the release is still publishing. Once latest >= build, the
  // answer is cached for the normal ten minutes.
  const raw = readCache(version) ?? (await fetchLatest());
  const release = parseLatestRelease(raw);
  if (!release) return;

  const comparison = compareReleaseVersions(version, release.version);
  if (comparison === null) return;

  const platform = target ? ` · ${target.label}` : "";
  if (comparison < 0) {
    // The build version is ahead of the newest published release: the release
    // is still publishing. Keep the newest installer that actually exists and
    // say so; do not cache it, so the next load sees the new release.
    applyAssets(
      release,
      target,
      `Latest published v${release.version} · v${version} is publishing${platform}`,
    );
    return;
  }

  if (shouldCacheLatestRelease(version, release.version)) writeCache(raw);
  applyAssets(release, target, `Latest release v${release.version}${platform}`);
}

if (typeof window !== "undefined") {
  const version = siteVersion();
  const initial = detectFrom(userAgentData());
  applyTarget(initial, version);
  void enhance(version, initial);
}
