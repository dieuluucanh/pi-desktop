/**
 * File-explorer preferences (view state only).
 *
 * The expanded-folder set is *not* persisted: it can grow without bound and a
 * stale tree after a restart is harmless. Only the three view choices live here.
 */

export type ExplorerSort = "name" | "type" | "modified";

export interface ExplorerPrefs {
  /** Show dotfiles. They are greyed out when shown (default true). */
  showHidden: boolean;
  /** Show git-ignored entries. They are dimmed when shown (default true). */
  showIgnored: boolean;
  /** Directory listing order; directories always come first. */
  sort: ExplorerSort;
}

export const EXPLORER_SORTS: readonly ExplorerSort[] = ["name", "type", "modified"];

export const DEFAULT_EXPLORER_PREFS: ExplorerPrefs = {
  showHidden: true,
  showIgnored: true,
  sort: "name",
};

export function isExplorerSort(value: unknown): value is ExplorerSort {
  return typeof value === "string" && (EXPLORER_SORTS as readonly string[]).includes(value);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** Coerces an untrusted explorer block into a usable one. */
export function sanitizeExplorerPrefs(value: unknown): ExplorerPrefs {
  const source = asRecord(value);
  return {
    // Missing means "show and dim": the requirement is to see hidden files,
    // not to hide them by default.
    showHidden: source.showHidden !== false,
    showIgnored: source.showIgnored !== false,
    sort: isExplorerSort(source.sort) ? source.sort : DEFAULT_EXPLORER_PREFS.sort,
  };
}

/** Applies a partial patch over the current explorer block. */
export function mergeExplorerPrefs(current: ExplorerPrefs, patch: unknown): ExplorerPrefs {
  return sanitizeExplorerPrefs({ ...current, ...asRecord(patch) });
}
