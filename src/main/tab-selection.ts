import type { TabKind } from "../shared/session-ipc";

/**
 * Choosing the tab that becomes active when another one closes.
 *
 * The session service owns the tab table and the selection; this module is the
 * pure policy behind `closeTab` so the rule is unit tested without a service,
 * a host or Electron.
 *
 * A web tab is a view of the session that opened it (Plannotator's review is
 * the common case), so its explicit `sessionTabId` is a stronger fact than
 * activity recency: `lastActiveAt` is also bumped by background RPCs and
 * startup bursts, and the MRU tab is not necessarily the one the user was
 * working in. Everything else falls back to MRU with deterministic tie-breaks,
 * so an all-zero/equal clock can never depend on the strip's insertion order.
 */

/** The fields the close policy needs; a `TabRecord` satisfies it structurally. */
export interface SelectableTab {
  id: string;
  kind: TabKind;
  sessionTabId?: string | null;
  lastActiveAt: number;
  createdAt: number;
}

/** A link target is a session surface, never another web view or a file tab. */
function isLinkTarget(tab: SelectableTab): boolean {
  return tab.kind !== "web" && tab.kind !== "editor";
}

/** MRU order: newest activity, then newest tab, then a stable id tie-break. */
function compareRecency(left: SelectableTab, right: SelectableTab): number {
  if (right.lastActiveAt !== left.lastActiveAt) return right.lastActiveAt - left.lastActiveAt;
  if (right.createdAt !== left.createdAt) return right.createdAt - left.createdAt;
  return left.id.localeCompare(right.id);
}

/**
 * The tab to select after `closed` is removed, or null when nothing remains.
 *
 * 1. A closed **web** tab returns to the session that opened it when that tab
 *    is still open.
 * 2. Otherwise the most recently active remaining tab wins.
 *
 * The input is never mutated: `remaining` is copied before sorting.
 */
export function nextActiveTabAfterClose(
  closed: SelectableTab,
  remaining: Iterable<SelectableTab>,
): SelectableTab | null {
  const candidates = [...remaining];
  if (closed.kind === "web" && closed.sessionTabId) {
    const linked = candidates.find((tab) => tab.id === closed.sessionTabId && isLinkTarget(tab));
    if (linked) return linked;
  }
  candidates.sort(compareRecency);
  return candidates[0] ?? null;
}
