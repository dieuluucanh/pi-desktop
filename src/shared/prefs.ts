/**
 * UI preferences (plan step 1).
 *
 * App state that belongs to the app, not to Pi: window chrome and session-view
 * preferences. They live in `userData/app-state.json` (never in the Pi profile)
 * and travel to the renderer as a closed, validated key set — the renderer can
 * never write an arbitrary key.
 */

import { DEFAULT_PROFILE_MODE, sanitizeProfileMode, type ProfileMode } from "./profile";
import { sanitizeDesktopKeybindings, type DesktopKeybindings } from "./desktop-keymap";
import { sanitizePromptOrigins } from "./prompt-origin";
import { DEFAULT_RAIL_PREFS, mergeRailPrefs, sanitizeRailPrefs, type RailPrefs } from "./rail";
import {
  DEFAULT_CHECKPOINT_CONFIG,
  sanitizeCheckpointConfig,
  type CheckpointConfig,
} from "./checkpoints";

export const PREF_KEYS = [
  "theme",
  "sidebarCollapsed",
  "sidebarWidth",
  "viewMode",
  "drafts",
  "telemetryEnabled",
  "privacyAcknowledged",
  "profileMode",
  "onboardingCompletedAt",
  "desktopKeybindings",
  "showExpandedPrompts",
  "promptOrigins",
  "rail",
  "checkpoints",
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
  /**
   * Which Pi profile the app uses (plan D‑A8, step 26): the shared
   * `~/.pi/agent` (default) or an app-private profile under `userData`. Resolved
   * by main before any host spawns, so a change applies on the next launch.
   */
  profileMode: ProfileMode;
  /**
   * When the first-run onboarding flow finished (or was skipped), or null. Until
   * it is set the onboarding wizard is offered; see `src/shared/onboarding.ts`.
   */
  onboardingCompletedAt: number | null;
  /**
   * Desktop-only action overrides (2026-10-26 session-parity plan step 22).
   * Pi's `app.*` actions stay in `keybindings.json`; this map never holds a
   * second copy of one (D14).
   */
  desktopKeybindings: DesktopKeybindings;
  /**
   * Whether the transcript shows the expanded body of a command prompt — a
   * prompt template, a `/skill:*` command, or a user message injected by an
   * extension command such as `/commit` — by default (2026-10-26
   * composer/command-prompt plan). Off: the row names the command the user sent
   * and hides the generated instruction; Ctrl+O or the row's Show button still
   * reveals it. Plain prompts the user typed are never affected.
   */
  showExpandedPrompts: boolean;
  /**
   * `hash(message text) -> raw command` for command-originated messages, so a
   * collapsed command row survives an app restart or a session reopen. Only the
   * command is stored, never the expanded prompt body; the map is bounded by
   * `MAX_PROMPT_ORIGINS` (see `src/shared/prompt-origin.ts`).
   */
  promptOrigins: Record<string, string>;
  /**
   * The docked panel rail: whether the panel body is expanded, which menu it
   * shows, its width, and the strip's order. Persisted so a relaunch restores
   * the layout the user left, including a reordered strip.
   */
  rail: RailPrefs;
  /**
   * Folder checkpoints (git-checkpoint plan D19): **the** source of the
   * checkpoint settings. Main projects this object to
   * `<profileDir>/checkpoints/config.json` on every change so the host-side Pi
   * extension can read it; nothing else writes that file. Keeping the values
   * here means one validated, app-owned store instead of two writable copies
   * that drift.
   */
  checkpoints: CheckpointConfig;
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
  telemetryEnabled: false,
  privacyAcknowledged: false,
  profileMode: DEFAULT_PROFILE_MODE,
  onboardingCompletedAt: null,
  desktopKeybindings: {},
  showExpandedPrompts: false,
  promptOrigins: {},
  // A fresh object *and* a fresh order array (not the shared default) so a
  // caller mutating one prefs value cannot mutate the module-level default.
  rail: { ...DEFAULT_RAIL_PREFS, order: [...DEFAULT_RAIL_PREFS.order] },
  // A fresh object for the same reason as `rail`: a caller mutating one prefs
  // value must not mutate the module-level default (nor the shared config).
  checkpoints: { ...DEFAULT_CHECKPOINT_CONFIG, exclude: [] },
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

/** Keeps the draft map small and string-valued; unknown tabs are dropped. */
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
    // A missing value is off: an older app-state.json (or a fresh profile) must
    // never opt the user into telemetry by omission.
    telemetryEnabled:
      typeof source.telemetryEnabled === "boolean" ? source.telemetryEnabled : false,
    privacyAcknowledged:
      typeof source.privacyAcknowledged === "boolean" ? source.privacyAcknowledged : false,
    profileMode: sanitizeProfileMode(source.profileMode),
    // A missing/zero value means "not completed yet", never a fabricated date.
    onboardingCompletedAt:
      typeof source.onboardingCompletedAt === "number" &&
      Number.isFinite(source.onboardingCompletedAt) &&
      source.onboardingCompletedAt > 0
        ? Math.floor(source.onboardingCompletedAt)
        : null,
    desktopKeybindings: sanitizeDesktopKeybindings(source.desktopKeybindings),
    // Missing means off: a fresh app-state.json must not reveal command
    // prompts by omission (the plan's default).
    showExpandedPrompts:
      typeof source.showExpandedPrompts === "boolean" ? source.showExpandedPrompts : false,
    promptOrigins: sanitizePromptOrigins(source.promptOrigins),
    // An older `app-state.json` has no `rail`; the sanitizer supplies the
    // defaults, so the migration needs no version bump.
    rail: sanitizeRailPrefs(source.rail),
    // Checkpoints are **on by default** (D14); the caps are what make that
    // defensible, so an older app-state.json without the key gets the defaults
    // rather than an off switch it never asked for. Unknown keys are dropped by
    // the shared sanitizer, which clamps every number.
    checkpoints: sanitizeCheckpointConfig(source.checkpoints),
  };
}

/** Applies a partial, untrusted patch over the current preferences. */
export function mergePrefs(current: UiPrefs, patch: unknown): UiPrefs {
  const source = patch && typeof patch === "object" ? (patch as Record<string, unknown>) : {};
  // `rail` is the one nested preference: a spread would let a `{ open: true }`
  // patch wipe the width and the section state, so it merges one level deeper.
  const rail = "rail" in source ? mergeRailPrefs(current.rail, source.rail) : current.rail;
  // `checkpoints` is flat, but it must not lose keys present in the patch's
  // absence: a `{ checkpoints: { enabled: false } }` patch keeps the retention
  // values the user set earlier. The sanitizer fills the rest.
  const checkpoints =
    "checkpoints" in source
      ? sanitizeCheckpointConfig({ ...current.checkpoints, ...asRecord(source.checkpoints) })
      : current.checkpoints;
  return sanitizePrefs({ ...current, ...source, rail, checkpoints });
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
