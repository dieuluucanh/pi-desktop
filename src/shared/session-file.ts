import { normalizeProjectPath } from "./projects";
import { isHostBackedTab, type TabRecord } from "./session-ipc";

/**
 * Session **file** identity (2026-11-06 current-session plan).
 *
 * A Pi session is one JSONL file, and one file may have exactly one live
 * `SessionManager`: the SDK takes no lock and appends from each process's own
 * in-memory leaf, so two hosts on one file branch the transcript. Everything
 * that compares a row, a tab or a resume request therefore uses the rules here
 * instead of `===`.
 *
 * The rule is the project-path rule (`normalizeProjectPath`: trim, drop trailing
 * separators) plus unified separators and case folding for Windows drive/UNC
 * paths only. POSIX paths stay case-sensitive, exactly like `sameSessionProject`
 * for cwds. `normalizeSessionProjectPath` delegates here so the two can never
 * drift.
 */
export function normalizeSessionFile(value: string): string {
  const trimmed = normalizeProjectPath(value);
  if (trimmed.length === 0) return "";
  const unified = trimmed.replace(/\\/g, "/");
  const windows = /^[A-Za-z]:\//.test(unified) || unified.startsWith("//");
  return windows ? unified.toLowerCase() : unified;
}

/** True when both name the same session JSONL. A missing or empty path never matches. */
export function sameSessionFile(
  left: string | null | undefined,
  right: string | null | undefined,
): boolean {
  if (typeof left !== "string" || typeof right !== "string") return false;
  if (left.length === 0 || right.length === 0) return false;
  return normalizeSessionFile(left) === normalizeSessionFile(right);
}

/**
 * The tab that already has this session file open, in table order.
 *
 * Only host-backed records are considered: an editor or web tab has no manager
 * to reuse, and `sessionFile` there is meaningless. A zero-length path never
 * matches (a tab that has not created its session yet).
 */
export function findTabBySessionFile(
  tabs: Iterable<TabRecord>,
  sessionFile: string,
): TabRecord | null {
  if (sessionFile.length === 0) return null;
  const target = normalizeSessionFile(sessionFile);
  for (const tab of tabs) {
    if (tab.sessionFile === null || tab.sessionFile.length === 0) continue;
    if (!isHostBackedTab(tab.kind)) continue;
    if (normalizeSessionFile(tab.sessionFile) === target) return tab;
  }
  return null;
}

/** A table with at most one tab per session file, plus the ids it replaced. */
export interface CollapsedSessionTabs {
  tabs: TabRecord[];
  /** Dropped tab id -> the kept tab id (chains already resolved). */
  replacedTabIds: Map<string, string>;
}

/**
 * Collapse legacy duplicate tabs: an older build minted a new tab on every
 * resume of an already-open session, and those pairs were persisted.
 *
 * The most recently active record wins (`lastActiveAt`, ties keep the first),
 * it keeps the position of the first duplicate, and a `pinned` flag on any of
 * the duplicates survives. Tabs without a session file are never merged.
 */
export function collapseDuplicateSessionTabs(tabs: readonly TabRecord[]): CollapsedSessionTabs {
  const result: TabRecord[] = [];
  const byFile = new Map<string, { index: number; tab: TabRecord }>();
  const replacedTabIds = new Map<string, string>();

  for (const tab of tabs) {
    if (tab.sessionFile === null || tab.sessionFile.length === 0) {
      result.push(tab);
      continue;
    }
    const key = normalizeSessionFile(tab.sessionFile);
    const kept = byFile.get(key);
    if (!kept) {
      byFile.set(key, { index: result.length, tab });
      result.push(tab);
      continue;
    }
    const pinned = kept.tab.pinned === true || tab.pinned === true;
    // Newer wins; on a tie the tab already in the table keeps its slot.
    if (tab.lastActiveAt <= kept.tab.lastActiveAt) {
      replacedTabIds.set(tab.id, kept.tab.id);
      if (pinned && kept.tab.pinned !== true) {
        const merged: TabRecord = { ...kept.tab, pinned: true };
        result[kept.index] = merged;
        kept.tab = merged;
      }
      continue;
    }
    replacedTabIds.set(kept.tab.id, tab.id);
    const winner: TabRecord = pinned ? { ...tab, pinned: true } : tab;
    result[kept.index] = winner;
    kept.tab = winner;
  }

  // A chain (A dropped for B, then B dropped for C) must resolve in one hop so
  // a persisted selection can be repaired without walking the map.
  for (const [dropped, kept] of replacedTabIds) {
    let target = kept;
    const seen = new Set<string>([dropped]);
    while (replacedTabIds.has(target) && !seen.has(target)) {
      seen.add(target);
      target = replacedTabIds.get(target)!;
    }
    replacedTabIds.set(dropped, target);
  }

  return { tabs: result, replacedTabIds };
}
