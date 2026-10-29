/**
 * The right rail's preference model (git-checkpoint plan step 10).
 *
 * The rail is one resizable column with independently collapsible sections:
 * **Git** (branch, sync, stashes), **Changes** (the two file lists and the
 * commit box), **Checkpoints** (the folder-snapshot timeline) and **Documents**
 * (the Office panes that used to be the whole rail).
 *
 * This module is shared rather than renderer-only because `prefs` persists the
 * section state: the closed key set in `src/shared/prefs.ts`, the main-process
 * sanitizer and the renderer all have to agree on the ids.
 */

/** The rail's sections, in render order. */
export type RailSectionId = "git" | "changes" | "history" | "checkpoints" | "documents";

export const RAIL_SECTION_IDS: readonly RailSectionId[] = [
  "git",
  "changes",
  "history",
  "checkpoints",
  "documents",
] as const;

/** True when a value is a known section id. */
export function isRailSectionId(value: unknown): value is RailSectionId {
  return typeof value === "string" && (RAIL_SECTION_IDS as readonly string[]).includes(value);
}

/** A section's human label, used by the header and the section itself. */
export const RAIL_SECTION_LABELS: Record<RailSectionId, string> = {
  git: "Git",
  changes: "Changes",
  history: "History",
  checkpoints: "Checkpoints",
  documents: "Documents",
};

/** Which sections are expanded. A collapsed section still shows its header. */
export type RailSectionState = Record<RailSectionId, boolean>;

export interface RailPrefs {
  /** Whether the rail is visible at all. */
  open: boolean;
  /** Rail width in CSS pixels, clamped to the supported range. */
  width: number;
  /** Per-section expanded state. */
  sections: RailSectionState;
}

export const MIN_RAIL_WIDTH = 260;
export const MAX_RAIL_WIDTH = 560;
export const DEFAULT_RAIL_WIDTH = 320;

/**
 * Defaults: the rail is **closed** (a session should not open with a column the
 * user did not ask for), but every section is expanded, so opening it shows
 * everything at once. `changes` is expanded because it holds the commit box.
 */
export const DEFAULT_RAIL_PREFS: RailPrefs = {
  open: false,
  width: DEFAULT_RAIL_WIDTH,
  sections: {
    git: true,
    changes: true,
    history: true,
    checkpoints: true,
    documents: true,
  },
};

/** Clamps a width into the supported range; a non-number becomes the default. */
export function clampRailWidth(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_RAIL_WIDTH;
  return Math.min(MAX_RAIL_WIDTH, Math.max(MIN_RAIL_WIDTH, Math.round(value)));
}

/** Coerces an untrusted rail preference document into the valid shape. */
export function sanitizeRailPrefs(value: unknown): RailPrefs {
  const source =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  const rawSections =
    source.sections && typeof source.sections === "object" && !Array.isArray(source.sections)
      ? (source.sections as Record<string, unknown>)
      : {};
  const sections = { ...DEFAULT_RAIL_PREFS.sections };
  for (const id of RAIL_SECTION_IDS) {
    // A missing section keeps its default; an explicit boolean wins. Unknown
    // keys in the document are dropped, so a future rail cannot smuggle state
    // through an older build's sanitizer.
    const raw = rawSections[id];
    if (typeof raw === "boolean") sections[id] = raw;
  }
  return {
    open: typeof source.open === "boolean" ? source.open : DEFAULT_RAIL_PREFS.open,
    width: clampRailWidth(source.width),
    sections,
  };
}

/** Merges a partial rail patch over the current value (nested, unlike a spread). */
export function mergeRailPrefs(current: RailPrefs, patch: unknown): RailPrefs {
  const source =
    patch && typeof patch === "object" && !Array.isArray(patch)
      ? (patch as Record<string, unknown>)
      : {};
  const sections =
    source.sections && typeof source.sections === "object" && !Array.isArray(source.sections)
      ? { ...current.sections, ...(source.sections as Record<string, unknown>) }
      : current.sections;
  return sanitizeRailPrefs({ ...current, ...source, sections });
}

/** True when at least one section is expanded (an open-but-empty rail is odd). */
export function anyRailSectionExpanded(prefs: RailPrefs): boolean {
  return RAIL_SECTION_IDS.some((id) => prefs.sections[id]);
}
