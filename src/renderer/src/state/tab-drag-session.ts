import { useSyncExternalStore } from "react";

/**
 * The renderer-only tab-drag session.
 *
 * This lives outside the Zustand app store on purpose: it is transient UI state
 * (a drag never survives a reload and is not persisted), and keeping it in a tiny
 * module avoids adding another field to the large `AppStateShape` just so a drag
 * source and the workspace can agree on one boolean.
 *
 * `WorkspaceView` subscribes through `useTabDragActive`; `TabList`,
 * `ProjectsSection` and the window-level `dragend`/`drop` fallback call
 * `beginTabDrag`/`endTabDrag`. There is at most one HTML5 drag at a time.
 */

let active = false;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

/** Starts the reveal. Idempotent. */
export function beginTabDrag(): void {
  if (active) return;
  active = true;
  emit();
}

/** Ends the reveal. Idempotent. */
export function endTabDrag(): void {
  if (!active) return;
  active = false;
  emit();
}

/** Current value, for non-React readers (the visible-set push). */
export function isTabDragActive(): boolean {
  return active;
}

/** `useSyncExternalStore` contract. */
export function subscribeTabDrag(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Reactive flag for the workspace surface. */
export function useTabDragActive(): boolean {
  return useSyncExternalStore(subscribeTabDrag, isTabDragActive, isTabDragActive);
}
