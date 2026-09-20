/**
 * UI preferences (plan step 1).
 *
 * App state that belongs to the app, not to Pi: window chrome and session-view
 * preferences. They live in `userData/app-state.json` (never in the Pi profile)
 * and travel to the renderer as a closed, validated key set — the renderer can
 * never write an arbitrary key.
 */

export const PREF_KEYS = [
  "theme",
  "sidebarCollapsed",
  "sidebarWidth",
  "viewMode",
  "drafts",
  "favoriteModels",
  "telemetryEnabled",
  "privacyAcknowledged",
] as const;

export type PrefKey = (typeof PREF_KEYS)[number];

export type ThemeSetting = "dark" | "light" | "system";
export type ViewMode = "normal" | "verbose" | "summary";

export interface UiPrefs {
  theme: ThemeSetting;
  sidebarCollapsed: boolean;
  /** Sidebar width in CSS pixels, clamped to the supported range. */
  sidebarWidth: number;
  viewMode: ViewMode;
  /**
   * Per-tab composer drafts (plan step 6), so an unfinished prompt survives a
   * tab switch or an app restart. Bounded below: a draft is not a document.
   */
  drafts: Record<string, string>;
  /**
   * Favourite models as `provider/id` keys (plan step 8), so the picker can keep
   * the handful of models a project actually uses at the top without inventing a
   * second settings file — these are app preferences, not Pi state.
   */
  favoriteModels: string[];
  /**
   * Pi's install telemetry (plan step 23). **Off by default**: every host is
   * spawned with `PI_TELEMETRY=0` unless this is true, so the app never sends an
   * install/attribution ping the user did not opt into. It is an app preference
   * on purpose — turning it on must not rewrite Pi's shared `settings.json`.
   */
  telemetryEnabled: boolean;
  /**
   * Whether the first-run privacy screen has been answered (plan step 23). Until
   * it is, the app shows the opt-in prompt; telemetry stays off regardless.
   */
  privacyAcknowledged: boolean;
}

/** How many favourites are kept; the picker is a shortlist, not a catalogue. */
export const MAX_FAVORITE_MODELS = 12;

/** The preference key for a model, matching the catalog's stable key. */
export function favoriteModelKey(provider: string, id: string): string {
  return `${provider}/${id}`;
}

/** Adds or removes a favourite, preserving order and the cap. */
export function toggleFavoriteModel(favorites: readonly string[], key: string): string[] {
  if (favorites.includes(key)) return favorites.filter((entry) => entry !== key);
  return [...favorites, key].slice(-MAX_FAVORITE_MODELS);
}

/** Longest draft kept per tab, and how many tabs may hold one. */
export const MAX_DRAFT_LENGTH = 20_000;
export const MAX_DRAFT_TABS = 50;

export const MIN_SIDEBAR_WIDTH = 200;
export const MAX_SIDEBAR_WIDTH = 520;
export const DEFAULT_SIDEBAR_WIDTH = 268;

export const DEFAULT_PREFS: UiPrefs = {
  theme: "dark",
  sidebarCollapsed: false,
  sidebarWidth: DEFAULT_SIDEBAR_WIDTH,
  viewMode: "normal",
  drafts: {},
  favoriteModels: [],
  telemetryEnabled: false,
  privacyAcknowledged: false,
};

const THEMES: readonly ThemeSetting[] = ["dark", "light", "system"];
const VIEW_MODES: readonly ViewMode[] = ["normal", "verbose", "summary"];

function clampWidth(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_SIDEBAR_WIDTH;
  return Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, Math.round(value)));
}

/** Keeps the draft map small and string-valued; unknown tabs are dropped. */
export function sanitizeDrafts(input: unknown): Record<string, string> {
  if (!input || typeof input !== "object") return {};
  const drafts: Record<string, string> = {};
  for (const [tabId, text] of Object.entries(input as Record<string, unknown>)) {
    if (typeof text !== "string" || text.length === 0) continue;
    drafts[tabId] = text.slice(0, MAX_DRAFT_LENGTH);
    if (Object.keys(drafts).length >= MAX_DRAFT_TABS) break;
  }
  return drafts;
}

/** Keeps the favourite list to unique, non-empty keys of a bounded length. */
export function sanitizeFavorites(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  const favorites: string[] = [];
  for (const entry of input) {
    if (typeof entry !== "string" || entry.length === 0 || entry.length > 200) continue;
    if (favorites.includes(entry)) continue;
    favorites.push(entry);
    if (favorites.length >= MAX_FAVORITE_MODELS) break;
  }
  return favorites;
}

/** Coerces an untrusted value into a valid `UiPrefs`, ignoring unknown keys. */
export function sanitizePrefs(input: unknown): UiPrefs {
  const source = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
  const theme = source.theme;
  const viewMode = source.viewMode;
  return {
    theme: THEMES.includes(theme as ThemeSetting) ? (theme as ThemeSetting) : DEFAULT_PREFS.theme,
    sidebarCollapsed:
      typeof source.sidebarCollapsed === "boolean"
        ? source.sidebarCollapsed
        : DEFAULT_PREFS.sidebarCollapsed,
    sidebarWidth:
      typeof source.sidebarWidth === "number"
        ? clampWidth(source.sidebarWidth)
        : DEFAULT_PREFS.sidebarWidth,
    viewMode: VIEW_MODES.includes(viewMode as ViewMode)
      ? (viewMode as ViewMode)
      : DEFAULT_PREFS.viewMode,
    drafts: sanitizeDrafts(source.drafts),
    favoriteModels: sanitizeFavorites(source.favoriteModels),
    // A missing value is off: an older app-state.json (or a fresh profile) must
    // never opt the user into telemetry by omission.
    telemetryEnabled:
      typeof source.telemetryEnabled === "boolean" ? source.telemetryEnabled : false,
    privacyAcknowledged:
      typeof source.privacyAcknowledged === "boolean" ? source.privacyAcknowledged : false,
  };
}

/** Applies a partial, untrusted patch over the current preferences. */
export function mergePrefs(current: UiPrefs, patch: unknown): UiPrefs {
  const source = patch && typeof patch === "object" ? (patch as Record<string, unknown>) : {};
  return sanitizePrefs({ ...current, ...source });
}
