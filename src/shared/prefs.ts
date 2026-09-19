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
  };
}

/** Applies a partial, untrusted patch over the current preferences. */
export function mergePrefs(current: UiPrefs, patch: unknown): UiPrefs {
  const source = patch && typeof patch === "object" ? (patch as Record<string, unknown>) : {};
  return sanitizePrefs({ ...current, ...source });
}
