/**
 * One writer for the sidebar width (2026-10-31 UI plan).
 *
 * The drag preview lives in `Sidebar`; this helper clamps the released value and
 * writes it through the existing preferences patch. Keeping it out of the
 * already-large store module also keeps the renderer's language service from
 * re-parsing a 6k-line file for one setter.
 */

import { clampSidebarWidth } from "../../../shared/prefs";
import { useAppStore } from "./app-store";

export function setSidebarWidth(width: number): void {
  const store = useAppStore.getState();
  const clamped = clampSidebarWidth(width);
  if (clamped === store.prefs.sidebarWidth) return;
  store.setPrefs({ sidebarWidth: clamped });
}
