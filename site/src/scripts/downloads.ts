import {
  detectTarget,
  parseLatestRelease,
  selectAssets,
  isAllowedAssetUrl,
} from "../lib/downloads";

const API_URL = "https://api.github.com/repos/dieuluucanh/pi-desktop/releases/latest";
const CACHE_KEY = "pi-desktop:latest-release:v1";
const CACHE_TTL_MS = 10 * 60 * 1000;

interface CachedRelease {
  fetchedAt: number;
  value: unknown;
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

function applyRelease(raw: unknown): void {
  const release = parseLatestRelease(raw);
  if (!release) return;

  const target = detectTarget({
    userAgent: navigator.userAgent,
    platform: navigator.platform,
    userAgentData:
      "userAgentData" in navigator
        ? ((
            navigator as Navigator & {
              userAgentData?: { architecture?: string; bitness?: string; platform?: string };
            }
          ).userAgentData ?? null)
        : null,
  });
  const selection = selectAssets(release.assets, target);

  for (const versionElement of document.querySelectorAll<HTMLElement>("[data-download-version]")) {
    versionElement.textContent = `v${release.version}`;
  }

  for (const element of document.querySelectorAll<HTMLAnchorElement>("[data-download-suffix]")) {
    const suffix = element.dataset.downloadSuffix ?? "";
    const asset = release.assets.find((candidate) => candidate.name.endsWith(suffix));
    if (asset && isAllowedAssetUrl(asset.url)) {
      element.href = asset.url;
      element.dataset.downloadResolved = "true";
    }
  }

  for (const element of document.querySelectorAll<HTMLAnchorElement>(
    "[data-download-primary]:not([data-download-suffix])",
  )) {
    if (!selection.primary || !isAllowedAssetUrl(selection.primary.url)) continue;
    element.href = selection.primary.url;
    if (target) element.textContent = `Download for ${target.label}`;
    element.dataset.downloadResolved = "true";
  }

  if (selection.primary && target) {
    setStatus(`Latest release v${release.version} · ${target.label}`);
  } else if (selection.primary) {
    setStatus(`Latest release v${release.version}`);
  }
}

async function loadLatest(): Promise<void> {
  const cached = readCache();
  if (cached) {
    applyRelease(cached);
    return;
  }
  try {
    const response = await fetch(API_URL, {
      headers: { Accept: "application/vnd.github+json" },
      credentials: "omit",
    });
    if (!response.ok) return;
    const value: unknown = await response.json();
    writeCache(value);
    applyRelease(value);
  } catch {
    // Leave the static Releases fallback in place.
  }
}

if (typeof window !== "undefined") {
  if (document.readyState === "complete") void loadLatest();
  else window.addEventListener("load", () => void loadLatest(), { once: true });
}
