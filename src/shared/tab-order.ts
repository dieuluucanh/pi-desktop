/**
 * Pinned-tab ordering, shared by the main-process tab table and the renderer's
 * optimistic strip moves.
 *
 * A pinned tab is not a different kind of tab; it is a tab that belongs to the
 * front group and is skipped by batch close. Both sides must agree on the
 * invariant or a drag would visibly jump after the main process answers:
 * **pinned tabs first, preserving their relative order, then unpinned tabs.**
 *
 * Pure and dependency-free so it can be unit tested without a tab service.
 */

export interface PinOrderTab {
  id: string;
  pinned?: boolean;
}

/** Stable partition: pinned tabs first, then unpinned, order preserved. */
export function partitionPinnedTabs<T extends PinOrderTab>(tabs: readonly T[]): T[] {
  const pinned: T[] = [];
  const unpinned: T[] = [];
  for (const tab of tabs) {
    if (tab.pinned === true) pinned.push(tab);
    else unpinned.push(tab);
  }
  return [...pinned, ...unpinned];
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

/**
 * Moves one tab, clamping the target to its own pinned/unpinned group.
 *
 * `toIndex` is a global index, which is what `TabList` computes from the
 * filtered strip. A pinned tab can never be dropped among unpinned tabs and
 * vice versa; the move simply lands at the nearest edge of its own group.
 * A missing id or an unchanged position returns an unchanged copy.
 */
export function moveTabWithinPinGroup<T extends PinOrderTab>(
  tabs: readonly T[],
  tabId: string,
  toIndex: number,
): T[] {
  const list = [...tabs];
  const from = list.findIndex((tab) => tab.id === tabId);
  if (from === -1) return list;

  const moving = list[from];
  if (!moving) return list;
  const pinned = moving.pinned === true;
  const remaining = list.filter((_, index) => index !== from);
  if (remaining.length === 0) return list;

  const target = Number.isFinite(toIndex) ? Math.floor(toIndex) : from;

  let minimum: number;
  let maximum: number;
  if (pinned) {
    const firstPinned = remaining.findIndex((tab) => tab.pinned === true);
    const lastPinned = remaining.findLastIndex((tab) => tab.pinned === true);
    minimum = firstPinned === -1 ? 0 : firstPinned;
    maximum = lastPinned === -1 ? 0 : lastPinned + 1;
  } else {
    const firstUnpinned = remaining.findIndex((tab) => tab.pinned !== true);
    minimum = firstUnpinned === -1 ? remaining.length : firstUnpinned;
    maximum = remaining.length;
  }

  const insertAt = clamp(target, minimum, maximum);
  remaining.splice(insertAt, 0, moving);
  return remaining;
}
